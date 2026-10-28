/**
 * 서해 물때표 조회 (바다타임 "날짜별 물때" 월 페이지 기준).
 *
 * 원칙
 *  - 항구·월 단위로 1건만 조회한다. (사용자가 그 화면을 열 때만)
 *  - 조회는 줄을 세워 한 번에 하나씩, 사이에 간격을 두고 보낸다.
 *  - 재시도·중계 우회는 하지 않는다. 실패하면 잠시 쉬고 "불러오지 못했습니다"로 알린다.
 *  - 물때는 천문 데이터라 성공한 월은 하루 동안 캐시한다.
 *  - 값이 없으면 지어내지 않는다. 비어 있는 달은 status="unpublished", 칸 단위 값이 없으면 null.
 */
import { logger } from "./logger";
import { parseTideMonthHtml, type TideDay } from "./tide-parser";

// 우리 항구 이름 → 바다타임 지역 ID (fishing-source.ts의 BADATIME_LOCATION_IDS와 같은 값).
// 서해 항구만 둔다. 임의의 ID를 받아 대신 조회하지 않도록 이 목록에 있는 항구만 허용한다.
export const TIDE_PORT_IDS: Readonly<Record<string, number>> = {
  삼길포: 144,
  대천항: 126,
  신진도: 132,
  오천항: 355,
  마검포: 1400,
};
export const TIDE_PORTS: string[] = Object.keys(TIDE_PORT_IDS);

export type TideMonthStatus = "ok" | "unpublished" | "error";

export type TideMonth = {
  port: string;
  year: number;
  month: number;
  /** ok: 데이터 있음 / unpublished: 사이트에 그 달 자료가 아직 없음 / error: 불러오지 못함 */
  status: TideMonthStatus;
  /** 화면에 그대로 보여 줄 안내 문구 (status가 ok면 null) */
  message: string | null;
  source: string;
  fetchedAt: string;
  days: TideDay[];
  ports: string[];
};

const SOURCE_LABEL = "바다타임(국립해양조사원 자료 기반)";
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_OK_MS = 24 * 60 * 60 * 1000;
// 아직 안 올라온 달은 나중에 올라올 수 있으니 짧게만 기억한다.
const CACHE_UNPUBLISHED_MS = 60 * 60 * 1000;
// 실패하면 같은 곳을 바로 다시 두드리지 않는다.
const CACHE_ERROR_MS = 10 * 60 * 1000;
const GAP_BETWEEN_REQUESTS_MS = 500;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const cache = new Map<string, { expiresAt: number; value: TideMonth }>();
const inflight = new Map<string, Promise<TideMonth>>();

// 전체를 한 줄로 세운다: 동시에 둘 이상 보내지 않고, 끝난 뒤 잠깐 쉰다.
let queueTail: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  queueTail = run.then(
    () => new Promise((resolve) => setTimeout(resolve, GAP_BETWEEN_REQUESTS_MS)),
    () => new Promise((resolve) => setTimeout(resolve, GAP_BETWEEN_REQUESTS_MS)),
  );
  return run;
}

function describeError(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `응답 시간 초과 ${FETCH_TIMEOUT_MS / 1000}초`;
  }
  return error instanceof Error ? error.message : "알 수 없는 오류";
}

function build(
  port: string,
  year: number,
  month: number,
  status: TideMonthStatus,
  message: string | null,
  days: TideDay[],
): TideMonth {
  return {
    port,
    year,
    month,
    status,
    message,
    source: SOURCE_LABEL,
    fetchedAt: new Date().toISOString(),
    days,
    ports: TIDE_PORTS,
  };
}

async function loadMonth(port: string, year: number, month: number): Promise<TideMonth> {
  const url = `https://www.badatime.com/${TIDE_PORT_IDS[port]}/daily/${year}-${String(month).padStart(2, "0")}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "ko-KR,ko;q=0.9",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 404) {
    // 사이트에 그 달 페이지 자체가 없는 경우 = 아직 제공되지 않는 달
    await response.body?.cancel().catch(() => undefined);
    return build(port, year, month, "unpublished", "이 달의 물때 정보가 아직 제공되지 않았습니다.", []);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`바다타임 응답 오류 (HTTP ${response.status})`);
  }
  const html = await response.text();
  // 페이지에 이웃한 달 날짜가 섞여 있어도 요청한 달만 남긴다.
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  const days = parseTideMonthHtml(html).filter((day) => day.date.startsWith(prefix));
  if (days.length === 0) {
    return build(port, year, month, "unpublished", "이 달의 물때 정보가 아직 제공되지 않았습니다.", []);
  }
  return build(port, year, month, "ok", null, days);
}

export async function getTideMonth(port: string, year: number, month: number): Promise<TideMonth> {
  if (!(port in TIDE_PORT_IDS)) throw new RangeError(`지원하지 않는 항구: ${port}`);

  const key = `${port}|${year}-${month}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const running = inflight.get(key);
  if (running) return running;

  const promise = enqueue(() => loadMonth(port, year, month))
    .then((value) => {
      const ttl = value.status === "ok" ? CACHE_OK_MS : CACHE_UNPUBLISHED_MS;
      cache.set(key, { expiresAt: Date.now() + ttl, value });
      return value;
    })
    .catch((error: unknown) => {
      logger.warn({ err: error }, `[tide-table] ${key} 조회 실패`);
      const value = build(port, year, month, "error", `물때 정보를 불러오지 못했습니다 (${describeError(error)}).`, []);
      cache.set(key, { expiresAt: Date.now() + CACHE_ERROR_MS, value });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}
