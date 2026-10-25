import { performance } from "node:perf_hooks";
import * as cheerio from "cheerio";
import { asc } from "drizzle-orm";
import {
  db,
  fishingSourcesTable,
  fishingSourceVesselsTable,
  type FishingSource as FishingSourceRecord,
  type FishingSourceVessel as FishingSourceVesselRecord,
} from "@workspace/db";
import {
  createPriorityLimiter,
  readIntEnv,
  settleWithSoftDeadline,
  waitAtMost,
  type FetchPriority,
} from "./fetch-scheduler";
import { logger } from "./logger";
import { getRelay, isConnectFailure } from "./relay";

export type FishingSchedule = {
  id: string;
  departureDate: string;
  weekday: string;
  region: string;
  port: string;
  tide: string;
  // 바다타임(badatime.com) 기준 조류 세기(%). 매핑되지 않은 항구이거나 조회
  // 실패 시 null — 이 부가 정보 하나 때문에 검색 전체가 실패하지는 않는다.
  tideStrengthPercent: number | null;
  genre: string;
  operator: string;
  vessel: string;
  remainingSeats: number | null;
  operatorUrl: string | null;
  bookingUrl: string | null;
  source: string;
};

export type FishingFilterOptions = {
  regions: string[];
  ports: string[];
  ships: string[];
  tides: string[];
  shipsByPort: Record<string, string[]>;
  shipsByRegion: Record<string, string[]>;
};

type SourceConfig = {
  id: number;
  name: string;
  baseUrl: string;
  region: string;
  port: string;
  vessels: string[];
};

// 출항 일정은 자주 바뀌는 데이터가 아니라서, 5분보다 넉넉하게 잡아도 체감
// 정확도는 거의 떨어지지 않으면서 반복 검색(날짜만 살짝 바꿔 다시 찾기 등)의
// 캐시 적중률은 크게 올라간다.
export const CACHE_TTL_MS = 20 * 60 * 1000;
// 예약처별로 이미 조회한 '연-월'은 캐시해서, 겹치는 기간을 다시 조회할 때
// 네트워크 스크래핑 없이 재사용한다. 키 형태: `${sourceId}:${year}-${month}`
const monthCache = new Map<string, { expiresAt: number; items: FishingSchedule[] }>();
// 한 달을 여러 쪽에 나눠 받는 예약처에서, 첫 쪽은 받았지만 이어지는 쪽이 실패해 앞쪽 날짜만 캐시에 들어간
// 달의 기록. 일부만 받은 결과는 20분씩 붙잡지 않고 금방(PARTIAL_CACHE_TTL_MS) 다시 시도하며,
// 검색 결과에는 "일부 날짜만 불러온 예약처"로 알려 준다. missingFrom = 못 받은 첫 날짜.
const PARTIAL_CACHE_TTL_MS = 3 * 60 * 1000;
const partialMonthNotes = new Map<string, { missingFrom: string; message: string }>();

// 지금 이 순간 네트워크로 가져오는 중인 '예약처-월' 요청. 같은 키를 또 요청하는 쪽
// (예: 필터 목록 조회가 먼저 시작해 둔 요청을 사용자의 검색이 이어서 필요로 할 때)은
// 새 요청을 만들지 않고 이미 진행 중인 것에 합류한다. 예전에는 합류 없이 같은 페이지를
// 두 번 받아서, 느린 서버/작은 인스턴스에서 대기 줄만 길어졌다.
type InflightMonth = { promise: Promise<FishingSchedule[]>; priority: FetchPriority };
const inflightMonths = new Map<string, InflightMonth>();
// clearSourceCache() 때 올린다. 캐시를 비우기 전에 시작된 요청이 (예약처 설정이 바뀌기
// 전 기준의) 낡은 결과를 새 캐시에 써넣지 못하게 막는 용도.
let cacheEpoch = 0;

/**
 * 서버 전체에서 동시에 진행하는 예약처 조회 수를 제한한다. 수십~백 개를 한꺼번에 보내면
 * 무료 인스턴스(CPU 약 0.1)가 스스로 느려져서 멀쩡한 예약처까지 타임아웃으로 "실패"
 * 처리되고, 그게 반복 실패 건너뛰기로 이어져 한꺼번에 많은 예약처가 실패로 뜨는
 * 악순환이 생기기 때문이다.
 *
 * 다만 줄 세우는 방식을 바꿨다. 사용자가 직접 누른 검색은 "high", 페이지를 열 때 필터
 * 목록을 채우려고 돌리는 조회는 "low"로 구분해서 high를 항상 먼저 처리하고, low가 전체
 * 칸을 다 차지하지 못하게 일부(FETCH_RESERVED_FOR_SEARCH개)는 검색용으로 비워 둔다.
 * 예전에는 하나의 줄(FIFO, 한도 6)만 써서 필터 목록용 조회 수십 건 뒤에 검색이 대기했다.
 *
 * 환경변수로 조절할 수 있다: FISHING_FETCH_CONCURRENCY(전체 한도, 기본 10),
 * FISHING_FETCH_RESERVED(검색 전용으로 비워 두는 칸, 기본 4).
 */
const FETCH_CONCURRENCY = readIntEnv("FISHING_FETCH_CONCURRENCY", 10);
const FETCH_RESERVED_FOR_SEARCH = readIntEnv("FISHING_FETCH_RESERVED", 4, 0);
const FETCH_TIMEOUT_MS = 15_000;
const fetchLimiter = createPriorityLimiter({
  maxConcurrent: FETCH_CONCURRENCY,
  reservedForHigh: FETCH_RESERVED_FOR_SEARCH,
});

// 이 시간 이상 걸린 개별 조회는 검색 요약과 별도로 바로 로그에 남긴다.
const SLOW_FETCH_LOG_MS = 4_000;

// 한 번의 '예약처-월' 조회가 어디서 시간을 썼는지(대기/응답/본문 수신/파싱, ms) 기록해서
// 로그로 원인을 확인할 수 있게 한다. 한 달을 여러 쪽에 나눠 받는 예약처는 쪽마다 더해서 기록한다.
// blocks/items/pages는 "페이지는 받았는데 왜 0건인지"를 가르는 용도다:
//   blocks = 달력에서 찾은 날짜 칸 수 (0이면 달력 자체를 못 찾음: 차단/다른 화면/구조 변경 의심)
//   items  = 그중 남은 자리가 있어 결과로 읽은 건수 (blocks가 있는데 0이면 정말 빈 달이거나 읽는 방식이 다름)
//   pages  = 이 달을 채우려고 성공적으로 받은 쪽 수
//   partialError/missingFrom = 첫 쪽은 받았는데 이어지는 쪽이 실패해서 앞쪽 날짜만 받은 경우의 이유와, 못 받은 첫 날짜
type FetchTrace = {
  queueMs?: number;
  headersMs?: number;
  bodyMs?: number;
  parseMs?: number;
  bytes?: number;
  blocks?: number;
  items?: number;
  pages?: number;
  partialError?: string;
  missingFrom?: string;
  // 이 조회에서 서울 중계를 거친 요청이 한 번이라도 있었으면 "relay" (relay.ts)
  via?: "relay";
};
type FetchContext = { priority: FetchPriority; tag?: string; trace?: FetchTrace };
const USER_FETCH_CONTEXT: FetchContext = { priority: "high" };

type MonthTiming = FetchTrace & {
  name: string;
  year: number;
  month: number;
  totalMs: number;
  ok: boolean;
  error?: string;
  finishedAt: number;
};
const monthTimings = new Map<string, MonthTiming>();

/**
 * 반복적으로 실패하는 예약처(robots.txt 차단, 서버 다운 등)를 매 검색마다
 * 15초 타임아웃까지 기다리지 않도록, 최근 실패 이력을 추적해서 쿨다운 기간
 * 동안은 요청 자체를 건너뛴다.
 */
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 10 * 60 * 1000; // 10분
type SourceHealth = {
  consecutiveFailures: number;
  skipUntil: number;
  lastError?: string;
  // 마지막으로 센 오류 객체. 같은 조회 한 건의 실패를 여러 검색이 함께 받아도 한 번만 세려는 용도.
  lastErrorRef?: unknown;
};
const sourceHealth = new Map<number, SourceHealth>();

function isSkipped(sourceId: number): SourceHealth | undefined {
  const health = sourceHealth.get(sourceId);
  if (health && health.skipUntil > Date.now()) return health;
  return undefined;
}

function recordSuccess(sourceId: number): void {
  sourceHealth.delete(sourceId);
}

function recordFailure(sourceId: number, error: unknown): void {
  const prev = sourceHealth.get(sourceId);
  // 같은 조회 한 건이 실패한 것을 (진행 중인 요청에 합류한) 여러 검색이 함께 받는 경우가
  // 있다. 실제 실패는 한 번이므로 중복해서 세지 않는다.
  if (prev && prev.lastErrorRef !== undefined && prev.lastErrorRef === error) return;
  const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
  const skipUntil = consecutiveFailures >= FAILURE_THRESHOLD ? Date.now() + COOLDOWN_MS : 0;
  sourceHealth.set(sourceId, {
    consecutiveFailures,
    skipUntil,
    lastError: error instanceof Error ? error.message : String(error),
    lastErrorRef: error,
  });
}

export function getSourceHealthSnapshot(): Array<{ id: number; consecutiveFailures: number; skippedUntil: string | null; lastError?: string }> {
  return [...sourceHealth.entries()].map(([id, health]) => ({
    id,
    consecutiveFailures: health.consecutiveFailures,
    skippedUntil: health.skipUntil > Date.now() ? new Date(health.skipUntil).toISOString() : null,
    lastError: health.lastError,
  }));
}

export function resetSourceHealth(): void {
  sourceHealth.clear();
}

export type FishingSourceWithVessels = FishingSourceRecord & { vessels: FishingSourceVesselRecord[] };

export function toSourceConfig(source: FishingSourceWithVessels): SourceConfig {
  const base = toSourceConfigRaw(source);
  const label = normalizePortLabel(base.port || source.port || "");
  return label ? { ...base, port: label, region: label } : base;
}

// "오천", "오천항" 처럼 끝의 "항" 유무만 다른 이름을 하나의 항구("오천항")로 통일한다.
function normalizePortLabel(raw: string): string {
  const base = raw.replace(/\s+/g, " ").trim().replace(/항$/, "");
  return base ? base + "항" : "";
}

function toSourceConfigRaw(source: FishingSourceWithVessels): SourceConfig {
  return {
    id: source.id,
    name: source.name,
    baseUrl: source.sourceUrl.replace(/\/$/, ""),
    region: source.region,
    port: source.port,
    vessels: source.vessels.map((vessel) => vessel.name),
  };
}

export async function listConfiguredSources(): Promise<FishingSourceWithVessels[]> {
  const [sources, vessels] = await Promise.all([
    db.select().from(fishingSourcesTable).orderBy(asc(fishingSourcesTable.port)),
    db.select().from(fishingSourceVesselsTable),
  ]);
  const vesselsBySource = new Map<number, FishingSourceVesselRecord[]>();
  for (const vessel of vessels) {
    const names = vesselsBySource.get(vessel.sourceId) ?? [];
    names.push(vessel);
    vesselsBySource.set(vessel.sourceId, names);
  }
  return sources.map((source) => ({
    ...source,
    vessels: vesselsBySource.get(source.id) ?? [],
  }));
}

export function clearSourceCache(): void {
  monthCache.clear();
  partialMonthNotes.clear();
  // 진행 중이던 요청은 끝까지 가도록 두되(기다리던 쪽이 있을 수 있음), 새 캐시에는
  // 결과를 쓰지 못하게 하고 이후 요청이 그 낡은 요청에 합류하지도 않게 한다.
  inflightMonths.clear();
  monthTimings.clear();
  cacheEpoch += 1;
  // 물때 어휘는 날짜에 따른 보편적인 값이라 예약처 설정과 무관하게 계속 유지한다.
  // 반면 선박-항구/지역 매핑은 예약처의 항구·지역 설정이 바뀌면 낡은 값이 될 수
  // 있으므로, 예약처가 추가/수정/삭제되거나 수동으로 새로고침할 때 같이 비운다.
  knownShips.clear();
  knownShipsByPort.clear();
  knownShipsByRegion.clear();
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// "OO호좌대", "몇번좌대"처럼 이름에 "좌대"가 들어간 항목은 배가 아니라
// 고정된 좌대낚시 자리라 이 앱(선상 예약)과는 성격이 달라 결과에서 제외한다.
function isExcludedVessel(vessel: string): boolean {
  return vessel.includes("좌대");
}

function parseSeatCount(value: string): number | null {
  const match = value.match(/남은자리\s*(\d+)\s*명/);
  return match ? Number(match[1]) : null;
}

// 더 새로운 예약 화면(예: reservation_boat_v5.2_seat1)은 남은 자리를 이미지(alt="남은자리 N명") 대신
// 글자("14명")로 보여 준다. "예약완료", "기상악화", "배정비일"처럼 숫자가 아닌 표기는 자리가 없는
// 것으로 본다. "예약완료 (대기 3명)"처럼 다른 숫자가 섞인 문구를 자리로 오인하지 않도록,
// 칸 전체가 "N명"(또는 "남은자리 N명")일 때만 인정한다.
function parseSeatCountText(value: string): number | null {
  const match = cleanText(value).match(/^(?:남은\s*자리\s*)?(\d+)\s*명$/);
  return match ? Number(match[1]) : null;
}

// 글자형 화면의 가운데 칸(예약 현황)은 "라벨 | 내용"이 한 줄씩 쌓인 작은 표다. "낚시종류" 줄이 있으면
// 그 값을, 없으면 공지 문구에서 "OO 출조합니다"의 OO만 장르로 쓴다. 이 칸에는 예약자 이름과 전화번호가
// 섞여 있으므로 칸 전체를 장르로 노출하지 않고, 둘 다 없으면 기본값("선상 낚시")을 쓴다.
function genreFromStatusCell(cell: cheerio.Cheerio<any>, $: cheerio.CheerioAPI): string {
  const labeled = (label: string): string => {
    let value = "";
    cell.find("tr").each((_index, tr) => {
      const tds = $(tr).children("td");
      if (tds.length >= 2 && cleanText(tds.eq(0).text()) === label) {
        value = cleanText(tds.eq(1).text());
        return false;
      }
      return undefined;
    });
    return value;
  };
  const kind = labeled("낚시종류");
  if (kind) return kind;
  const notice = labeled("공지");
  const head = notice.includes("출조") ? cleanText(notice.split("출조")[0]).replace(/[\s.,·~!]+$/g, "") : "";
  return head && head.length <= 20 ? head : "선상 낚시";
}

function parseDateFromDayBlock(id: string, text: string): string | null {
  const idMatch = id.match(/new-div-(\d{8})/);
  if (idMatch?.[1]) {
    const digits = idMatch[1];
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  // "9월 3일"처럼 월/일이 0으로 채워지지 않은 경우도 있으므로, 각 자리를
  // 직접 2자리로 맞춰서 파싱한다 (이전에는 join()한 문자열 길이가 8이 아니면
  // 통째로 버려서 그런 날짜의 데이터가 조용히 누락됐다).
  const textMatch = text.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (!textMatch) return null;
  const [, year, month, day] = textMatch;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function extractBookingUrl(onclick: string, baseUrl: string): string | null {
  const match = onclick.match(/f_popup\('([^']+)'/);
  if (!match?.[1]) return null;
  try {
    return new URL(match[1], baseUrl).href;
  } catch {
    // 주소 모양이 이상한 줄 하나 때문에 그 달 전체 조회가 실패하지 않게 한다.
    return null;
  }
}

// 등록한 주소가 "http://fishingi.net/index.php"처럼 경로까지 들어 있어도 "출처" 링크가
// ".../index.php/index.php?..."로 깨지지 않게, 주소의 서버 부분(origin)에 붙인다.
function monthPageHref(baseUrl: string, departureDate: string): string {
  const url = new URL("/index.php", baseUrl);
  url.searchParams.set("mid", "bk");
  url.searchParams.set("year", departureDate.slice(0, 4));
  url.searchParams.set("month", departureDate.slice(5, 7));
  return url.href;
}

function parseDayBlock(
  block: cheerio.Cheerio<any>,
  config: SourceConfig,
): FishingSchedule[] {
  const header = block.find("tr.jeil-panel").first();
  const headerText = cleanText(header.text());
  const departureDate = parseDateFromDayBlock(block.attr("id") || "", headerText);
  if (!departureDate) return [];

  const weekday = headerText.match(/(월요일|화요일|수요일|목요일|금요일|토요일|일요일)/)?.[1] || "";
  const tide = headerText.match(/(\d+물|조금|무시)/)?.[1] || "미정";
  const operator = cleanText(config.name).replace(/^예약하기\s*-\s*/, "");

  const items: FishingSchedule[] = [];
  block.find("tr").each((_index, row) => {
    const row$ = cheerio.load(row);
    const cells = row$("tr").first().children("td");
    if (cells.length < 3) return;

    const vessel = cleanText(cells.eq(0).find("span").first().text() || cells.eq(0).text());
    const seatAlt = cells.eq(2).find("img").first().attr("alt") || "";
    let remainingSeats = parseSeatCount(seatAlt);
    // 이미지로 남은 자리를 알려 주는 예전 화면은 위에서 읽히고, 이 분기는 타지 않는다.
    // 이미지가 없는 글자형 화면("14명")만 칸의 글자로 읽는다.
    const textLayout = remainingSeats === null;
    if (textLayout) remainingSeats = parseSeatCountText(cells.eq(2).text());
    if (!vessel || isExcludedVessel(vessel) || remainingSeats === null || remainingSeats <= 0) return;

    const genre = textLayout
      ? genreFromStatusCell(cells.eq(1), row$)
      : cleanText(
          cells.eq(1).find('img[alt="낚시종류"]').closest("tr").find("td").last().text() ||
            cells.eq(1).text(),
        );
    const bookingUrl = extractBookingUrl(cells.eq(0).find("a").first().attr("onclick") || "", config.baseUrl);
    const id = `${departureDate}-${vessel}-${bookingUrl || "schedule"}`
      .replace(/[^0-9A-Za-z가-힣-]+/g, "-")
      .toLowerCase();

    items.push({
      id,
      departureDate,
      weekday,
      region: config.region,
      port: config.port,
      tide,
      tideStrengthPercent: null,
      genre: genre || "선상 낚시",
      operator,
      vessel,
      remainingSeats,
      operatorUrl: config.baseUrl,
      bookingUrl,
      source: monthPageHref(config.baseUrl, departureDate),
    });
  });

  return items;
}

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function browserHeaders(referer: string): Record<string, string> {
  return {
    "User-Agent": BROWSER_USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    Referer: referer,
  };
}

// Node의 fetch는 연결이 안 되면 그냥 "fetch failed"라고만 말하고, 진짜 이유(주소를 못 찾음, 연결 거부,
// 인증서 문제 등)는 error.cause 안에 들어 있다. 로그·진단 화면·검색 오류 화면에서 원인을 바로 알 수 있도록
// 그 이유를 꺼내 짧은 한글로 풀어 쓴다. (괄호는 쓰지 않는다: "예약처이름(이유)" 형태로 붙여 보여 주기 때문)
function describeFetchFailure(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `응답 시간 초과 ${FETCH_TIMEOUT_MS / 1000}초`;
  }
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  let code = "";
  for (const candidate of [cause, error]) {
    if (candidate && typeof candidate === "object" && "code" in candidate) {
      const value = String((candidate as { code: unknown }).code ?? "");
      if (value) {
        code = value;
        break;
      }
    }
  }
  const meaning: Record<string, string> = {
    ENOTFOUND: "주소를 찾지 못함",
    EAI_AGAIN: "주소를 찾지 못함",
    ECONNREFUSED: "연결 거부됨",
    ECONNRESET: "연결이 끊김",
    ETIMEDOUT: "연결 시간 초과",
    UND_ERR_CONNECT_TIMEOUT: "연결 시간 초과",
    UND_ERR_SOCKET: "연결이 끊김",
    EHOSTUNREACH: "서버에 닿지 못함",
    ENETUNREACH: "서버에 닿지 못함",
  };
  const label = meaning[code] ?? (/CERT|TLS|SSL/i.test(code) ? "보안 연결 인증서 문제" : "연결 실패");
  const raw = cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
  return code ? `${label} ${code}` : `${label} ${raw.replace(/[()]/g, "").slice(0, 60)}`.trim();
}

type SourceReply = { response: Response; via: "direct" | "relay" };
// 서울 중계를 거쳐 받은 응답의 오류 문구 끝에 붙이는 표시 (summarizeFailureReason이 알아본다).
const RELAY_VIA_NOTE = " 서울 중계 경유";

/**
 * 예약처 사이트에 요청 한 번을 보낸다. 평소에는 직접 연결한다. 서울 중계(relay.ts)가 켜져 있을 때만
 *  ① 중계로 먼저 보내기로 한 사이트(직접 지정했거나 최근 중계로만 성공한 곳)는 곧바로 중계로,
 *  ② 직접 연결이 안 될 때(연결 시간 초과·거부·끊김)와 403일 때는 중계로 한 번 더 시도한다.
 * 중계가 꺼져 있으면 예전과 똑같이 동작한다. 사이트가 돌려준 상태 코드는 그대로 넘기고, 연결 실패는
 * 사람이 읽을 수 있는 한국어 Error로 바꿔 던진다.
 */
async function requestSource(url: URL, referer: string, timeoutMs: number): Promise<SourceReply> {
  const relay = getRelay();
  if (relay?.prefers(url.hostname)) {
    try {
      return { response: await relay.fetch(url, referer), via: "relay" };
    } catch (error) {
      // 자동으로 "중계로 먼저"가 된 사이트는, 중계가 안 되면 다음 번에 직접 연결부터 다시 해 본다.
      if (!relay.isForced(url.hostname)) relay.forget(url.hostname);
      throw error;
    }
  }

  let direct: Response | undefined;
  let directError: unknown;
  try {
    direct = await fetch(url, { headers: browserHeaders(referer), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    directError = error;
  }

  const blocked = direct ? direct.status === 403 : isConnectFailure(directError);
  if (!relay || !blocked) {
    if (direct) return { response: direct, via: "direct" };
    throw new Error(`예약 원본에 연결하지 못했습니다: ${describeFetchFailure(directError)}`);
  }

  // 직접 연결이 막혔다 → 서울 중계로 한 번 더.
  const why = direct ? "HTTP 403" : describeFetchFailure(directError);
  await direct?.body?.cancel().catch(() => undefined);
  let response: Response;
  try {
    response = await relay.fetch(url, referer);
  } catch (error) {
    logger.warn(
      { host: url.hostname, direct: why, relay: error instanceof Error ? error.message : String(error) },
      `[서울 중계] ${url.hostname}: 직접 연결 실패(${why}) 뒤 중계도 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
  if (response.ok) relay.learn(url.hostname, why);
  return { response, via: "relay" };
}

// 예약처 페이지 하나를 받아온다. 동시 조회 한도(fetchLimiter)에는 "응답 헤더가 올 때까지"만
// 해당하고(예전과 동일), 15초 타임아웃은 줄 서서 기다린 시간이 아니라 실제로 요청을
// 시작한 시점부터 잰다. 구간별 소요 시간은 ctx.trace에 남겨 로그로 확인할 수 있게 한다.
async function fetchHtml(url: URL, referer: string, ctx: FetchContext): Promise<string> {
  const queuedAt = performance.now();
  const { response, via } = await fetchLimiter.run(
    async () => {
      const startedAt = performance.now();
      // 한 달을 여러 쪽에 나눠 받는 예약처는 쪽마다 호출되므로, 덮어쓰지 않고 더한다.
      if (ctx.trace) ctx.trace.queueMs = (ctx.trace.queueMs ?? 0) + Math.round(startedAt - queuedAt);
      try {
        return await requestSource(url, referer, FETCH_TIMEOUT_MS);
      } finally {
        if (ctx.trace) ctx.trace.headersMs = (ctx.trace.headersMs ?? 0) + Math.round(performance.now() - startedAt);
      }
    },
    ctx.priority,
    ctx.tag,
  );
  if (via === "relay" && ctx.trace) ctx.trace.via = "relay";
  if (!response.ok) {
    // 본문을 읽지 않고 그냥 버리면 연결이 풀리지 않은 채 남을 수 있어서 명시적으로 닫는다.
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`예약 원본이 ${response.status} 상태를 반환했습니다.${via === "relay" ? RELAY_VIA_NOTE : ""}`);
  }
  const bodyStartedAt = performance.now();
  let html: string;
  try {
    html = await response.text();
  } catch (error) {
    throw new Error(`예약 원본 응답을 끝까지 받지 못했습니다: ${describeFetchFailure(error)}`);
  }
  if (ctx.trace) {
    ctx.trace.bodyMs = (ctx.trace.bodyMs ?? 0) + Math.round(performance.now() - bodyStartedAt);
    ctx.trace.bytes = (ctx.trace.bytes ?? 0) + html.length;
  }
  return html;
}

type MonthPage = {
  items: FishingSchedule[];
  // 이 페이지에서 찾은 날짜 칸(.new-divs) 수
  blocks: number;
  // 이 페이지가 담고 있는 가장 늦은 날짜 (YYYY-MM-DD). 날짜 칸이 없으면 null.
  lastDate: string | null;
  // "한 번에 며칠치만 보여 주고 나머지는 스크롤하면 더 불러오는" 화면인지 (#list_day 숨김 입력이 있으면 그렇다)
  rolling: boolean;
};

function parseMonthPage(html: string, config: SourceConfig): MonthPage {
  const $ = cheerio.load(html);
  const items: FishingSchedule[] = [];
  let lastDate: string | null = null;
  const dayBlocks = $(".new-divs");
  dayBlocks.each((_index, element) => {
    const block = $(element);
    items.push(...parseDayBlock(block, config));
    const idDate = (block.attr("id") || "").match(/new-div-(\d{4})(\d{2})(\d{2})/);
    if (idDate) {
      const date = `${idDate[1]}-${idDate[2]}-${idDate[3]}`;
      if (lastDate === null || date > lastDate) lastDate = date;
    }
  });
  return { items, blocks: dayBlocks.length, lastDate, rolling: $("#list_day").length > 0 };
}

function addDaysIso(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

// 한 달을 채우려고 이어서 받는 최대 쪽 수. 8일씩 보여 주는 화면이면 4쪽이면 충분하고, 더 적게
// 보여 주는 화면이어도 끝없이 요청하지 않도록 상한을 둔다.
const MONTH_PAGE_LIMIT = 8;

async function fetchMonth(
  year: number,
  month: number,
  config: SourceConfig,
  ctx: FetchContext = USER_FETCH_CONTEXT,
): Promise<FishingSchedule[]> {
  const monthValue = String(month).padStart(2, "0");
  const url = new URL("/index.php", config.baseUrl);
  url.searchParams.set("mid", "bk");
  url.searchParams.set("year", String(year));
  url.searchParams.set("month", monthValue);
  url.searchParams.set("day", "01");

  const readPage = async (pageUrl: URL): Promise<MonthPage> => {
    const html = await fetchHtml(pageUrl, config.baseUrl, ctx);
    const parseStartedAt = performance.now();
    const page = parseMonthPage(html, config);
    if (ctx.trace) ctx.trace.parseMs = (ctx.trace.parseMs ?? 0) + Math.round(performance.now() - parseStartedAt);
    return page;
  };

  const first = await readPage(url);
  let items = first.items;
  let blocks = first.blocks;
  let pages = 1;

  if (first.rolling) {
    // 이 화면(예: 대야도 피싱아일랜드)은 한 번에 8일치만 보여 주고 나머지는 스크롤하면 더 불러온다.
    // 그래서 첫 페이지만 읽으면 그 달 앞쪽 며칠만 나오고 이후 날짜는 통째로 빠진다. 사이트의 날짜 이동과
    // 같은 요청(mid=bk&year&month&day&mode=list)으로 마지막으로 받은 날짜 다음 날부터 이 달 끝까지 이어 받는다.
    // 지난 날짜는 어차피 쓰지 않으므로, 이번 달이면 오늘부터 받는다 (서버 시계는 UTC라 한국 날짜보다
    // 같거나 하루 늦어서, 한국 기준 오늘이 빠지는 일은 없다).
    const monthPrefix = `${year}-${monthValue}-`;
    const monthStart = `${monthPrefix}01`;
    const monthEnd = `${monthPrefix}${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
    const today = new Date().toISOString().slice(0, 10);
    const wantFrom = today > monthStart && today <= monthEnd ? today : monthStart;

    const byId = new Map<string, FishingSchedule>(first.items.map((item) => [item.id, item]));
    let cursor = first.lastDate;
    while (pages < MONTH_PAGE_LIMIT) {
      let next = cursor ? addDaysIso(cursor, 1) : wantFrom;
      if (next < wantFrom) next = wantFrom;
      if (next > monthEnd) break;

      const pageUrl = new URL("/index.php", config.baseUrl);
      pageUrl.searchParams.set("mid", "bk");
      pageUrl.searchParams.set("year", String(year));
      pageUrl.searchParams.set("month", monthValue);
      pageUrl.searchParams.set("day", next.slice(8, 10));
      pageUrl.searchParams.set("mode", "list");
      pageUrl.searchParams.set("PA_N_UID", "0");
      let page: MonthPage;
      try {
        page = await readPage(pageUrl);
      } catch (error) {
        // 첫 쪽은 받았는데 이어지는 쪽이 실패했다. 이 달 전체를 실패로 처리하면 이미 받은 앞쪽 날짜까지
        // 버리게 되므로, 받은 날짜까지만 돌려주고 "어느 날짜부터 못 받았는지"를 남긴다. 검색 결과에는
        // 그 사실이 경고로 표시되고, 일부만 받은 결과는 캐시에 짧게(PARTIAL_CACHE_TTL_MS)만 둔다.
        if (ctx.trace) {
          ctx.trace.partialError = error instanceof Error ? error.message : String(error);
          ctx.trace.missingFrom = next;
        }
        break;
      }
      pages += 1;
      blocks += page.blocks;
      for (const item of page.items) byId.set(item.id, item);
      // 더 이어질 날짜가 없거나(빈 페이지) 날짜가 앞으로 나아가지 않으면 멈춘다.
      if (!page.lastDate || (cursor !== null && page.lastDate <= cursor)) break;
      cursor = page.lastDate;
    }
    // 다음 달 앞부분까지 딸려 온 날짜는 그 달 조회가 따로 가져오므로, 이 달 것만 남긴다 (중복 방지).
    items = [...byId.values()].filter((item) => item.departureDate.startsWith(monthPrefix));
  }

  if (ctx.trace) {
    ctx.trace.blocks = blocks;
    ctx.trace.items = items.length;
    ctx.trace.pages = pages;
  }
  return items;
}

// ---------------------------------------------------------------------------
// SUNSANG24 플랫폼 (예: metafishingclub.sunsang24.com, daebak.sunsang24.com)
//
// 더피싱과 달리 캘린더 달 페이지(/ship/schedule_fleet/{yyyymm})가 서버에서
// 완전히 렌더링된 정적 HTML로 내려온다. 세션 쿠키나 AJAX 재요청이 필요 없고,
// 날짜별 <table class="shipsinfo_daywarp"> 블록 안에 선박별 "남은자리" 텍스트가
// 그대로 박혀 있다. 예약이 마감된 날은 "남은자리" 대신
// <span class="shipping_status" data-status_code="END">예약마감</span> 이 온다.
// ---------------------------------------------------------------------------

const WEEKDAY_KO = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];

function isSunsang24(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith("sunsang24.com");
  } catch {
    return false;
  }
}

function parseSunsangDayBlock(
  $: cheerio.CheerioAPI,
  dayTable: cheerio.Cheerio<any>,
  config: SourceConfig,
): FishingSchedule[] {
  const idMatch = (dayTable.attr("id") || "").match(/^d(\d{4}-\d{2}-\d{2})$/);
  const departureDate = idMatch?.[1];
  if (!departureDate) return [];

  const weekday = WEEKDAY_KO[new Date(`${departureDate}T00:00:00Z`).getUTCDay()];
  const tide = cleanText(dayTable.find(".date_info2").first().text()) || "미정";

  const items: FishingSchedule[] = [];
  dayTable.find(".ship_unit").each((_index, element) => {
    const unit = $(element);
    const vessel = cleanText(unit.find(".ship_info .title").first().text());
    if (!vessel || isExcludedVessel(vessel)) return;

    const remainCell = unit.find(".ship_info2 .remain").first();
    const isClosed = remainCell.find(".shipping_status").attr("data-status_code") === "END";
    let remainingSeats: number | null = null;
    if (isClosed) {
      remainingSeats = 0;
    } else {
      const numberText = cleanText(remainCell.find(".number").first().text());
      const match = numberText.match(/(\d+)/);
      remainingSeats = match ? Number(match[1]) : null;
    }
    if (remainingSeats === null || remainingSeats <= 0) return;

    const genre = cleanText(unit.find("#fish").first().text()) || "선상 낚시";
    const scheduleNo = unit.find("[data-schedule_no]").first().attr("data-schedule_no") || "";
    const monthPath = departureDate.slice(0, 4) + departureDate.slice(5, 7);
    const bookingUrl = `${config.baseUrl}/ship/schedule_fleet/${monthPath}`;
    const id = `${departureDate}-${vessel}-${scheduleNo || "schedule"}`
      .replace(/[^0-9A-Za-z가-힣-]+/g, "-")
      .toLowerCase();

    items.push({
      id,
      departureDate,
      weekday,
      region: config.region,
      port: config.port,
      tide,
      tideStrengthPercent: null,
      genre,
      operator: cleanText(config.name),
      vessel,
      remainingSeats,
      operatorUrl: config.baseUrl,
      bookingUrl,
      source: bookingUrl,
    });
  });

  return items;
}

function extractSunsangShipNo(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    const paramNo = parsed.searchParams.get("ship_no");
    if (paramNo && /^\d+$/.test(paramNo)) return paramNo;
    const pathMatch = parsed.pathname.match(/\/(?:schedule_fleet_list|simple_info|group)\/(\d+)/);
    return pathMatch ? pathMatch[1] : null;
  } catch {
    return null;
  }
}

async function fetchSunsangMonth(
  year: number,
  month: number,
  config: SourceConfig,
  ctx: FetchContext = USER_FETCH_CONTEXT,
): Promise<FishingSchedule[]> {
  const monthValue = `${year}${String(month).padStart(2, "0")}`;
  const shipNo = extractSunsangShipNo(config.baseUrl);

  // 선상24 공식 JSON API 방식 (ship_no 기반)
  if (shipNo) {
    const apiUrl = new URL(`https://api.sunsang24.com/ship/schedule_fleet_list/${shipNo}/${monthValue}?simple=&possible=&eyyyymm=`);
    const rawJson = await fetchHtml(apiUrl, "https://www.sunsang24.com/", ctx);
    const parseStartedAt = performance.now();
    let list: any[] = [];
    try {
      const parsed = JSON.parse(rawJson);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = [];
    }

    const items: FishingSchedule[] = [];
    const seenDates = new Set<string>();

    for (const row of list) {
      const departureDate = typeof row?.sdate === "string" ? row.sdate : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(departureDate)) continue;
      seenDates.add(departureDate);

      const vessel = cleanText(row?.ship?.name || config.name);
      if (!vessel || isExcludedVessel(vessel)) continue;

      const isClosed = row?.status_code === "END" || row?.is_reservation_possible === 0;
      const remain = isClosed ? 0 : Number(row?.remain_embarkation_num ?? 0);
      if (!Number.isFinite(remain) || remain <= 0) continue;

      const weekday = WEEKDAY_KO[new Date(`${departureDate}T00:00:00Z`).getUTCDay()];
      const tide = cleanText(row?.tide_water || "") || "미정";
      const genre = cleanText(row?.fish_type || "") || "선상 낚시";
      const scheduleNo = String(row?.schedule_no || "schedule");
      const bookingUrl = `https://www.sunsang24.com/ship/schedule?sdate=${departureDate}&ship_no=${row?.ship?.no || shipNo}`;
      const id = `${departureDate}-${vessel}-${scheduleNo}`
        .replace(/[^0-9A-Za-z가-힣-]+/g, "-")
        .toLowerCase();

      items.push({
        id,
        departureDate,
        weekday,
        region: config.region,
        port: config.port,
        tide,
        tideStrengthPercent: null,
        genre,
        operator: cleanText(config.name),
        vessel,
        remainingSeats: remain,
        operatorUrl: config.baseUrl,
        bookingUrl,
        source: bookingUrl,
      });
    }

    if (ctx.trace) {
      ctx.trace.parseMs = Math.round(performance.now() - parseStartedAt);
      ctx.trace.blocks = seenDates.size;
      ctx.trace.items = items.length;
    }
    return items;
  }

  // 기존 *.sunsang24.com 서브도메인 HTML 파싱 방식
  const url = new URL(`/ship/schedule_fleet/${monthValue}`, config.baseUrl);
  const html = await fetchHtml(url, config.baseUrl, ctx);
  const parseStartedAt = performance.now();
  const $ = cheerio.load(html);
  const sourceItems: FishingSchedule[] = [];
  $(".shipsinfo_daywarp").each((_index, element) => {
    sourceItems.push(...parseSunsangDayBlock($, $(element), config));
  });
  if (ctx.trace) ctx.trace.parseMs = Math.round(performance.now() - parseStartedAt);
  return sourceItems;
}

async function fetchMonthForConfig(
  year: number,
  month: number,
  config: SourceConfig,
  ctx: FetchContext = USER_FETCH_CONTEXT,
): Promise<FishingSchedule[]> {
  return isSunsang24(config.baseUrl)
    ? fetchSunsangMonth(year, month, config, ctx)
    : fetchMonth(year, month, config, ctx);
}

export type DetectedSource = {
  platform: "thefishing" | "sunsang24" | "unknown";
  suggestedName: string | null;
  vessels: string[];
  workingUrl: string | null;
};

async function fetchPageTitle(baseUrl: string): Promise<string | null> {
  try {
    const { response } = await requestSource(new URL(baseUrl), baseUrl, 10_000);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const $ = cheerio.load(await response.text());
    return cleanText($("title").first().text()) || null;
  } catch {
    return null;
  }
}

// 이 앱은 로그인이 없어서 누구나 /detect를 호출할 수 있으므로, 서버가 내부망/로컬
// 주소를 대신 열어보는 일은 막아둔다 (http/https만 허용, 사설·루프백 주소 거부).
// 스킴 없이 "gaiaho.com"처럼 붙여넣은 경우는 http://를 붙여서 처리한다.
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "::1" || host === "[::1]") return true;
  const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (octets) {
    const a = Number(octets[1]);
    const b = Number(octets[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

function normalizeProbeUrl(rawUrl: string): string | null {
  let value = rawUrl.trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `http://${value}`;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (isPrivateHost(parsed.hostname)) return null;
  } catch {
    return null;
  }
  return value.replace(/\/+$/, "");
}

/**
 * 등록 전에 URL 하나만으로 "이 사이트가 우리가 아는 플랫폼(더피싱/SUNSANG24) 중
 * 어느 쪽이고, 실제로 선박이 몇 척 잡히는지"를 미리 확인한다. 더미 SourceConfig로
 * 이번 달 조회를 실제로 한 번 돌려보고, 비어있으면 다음 달도 한 번 더 시도한다
 * (이번 달 일정이 이미 다 지났거나 아직 안 열렸을 수 있어서). 호스트명이
 * sunsang24.com이면 그쪽을 먼저, 아니면 더피싱을 먼저 시도한다.
 */
export async function detectSource(rawUrl: string): Promise<DetectedSource | null> {
  const baseUrl = normalizeProbeUrl(rawUrl);
  if (!baseUrl) return null;
  const now = new Date();
  const platforms: DetectedSource["platform"][] = isSunsang24(baseUrl)
    ? ["sunsang24", "thefishing"]
    : ["thefishing", "sunsang24"];

  for (const platform of platforms) {
    const probeConfig: SourceConfig = { id: 0, name: baseUrl, baseUrl, region: "", port: "", vessels: [] };
    const fetcher = platform === "sunsang24" ? fetchSunsangMonth : fetchMonth;
    try {
      let items = await fetcher(now.getUTCFullYear(), now.getUTCMonth() + 1, probeConfig);
      if (items.length === 0) {
        const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
        items = await fetcher(next.getUTCFullYear(), next.getUTCMonth() + 1, probeConfig);
      }
      const vessels = [...new Set(items.map((item) => item.vessel).filter(Boolean))];
      if (vessels.length > 0) {
        return { platform, suggestedName: await fetchPageTitle(baseUrl), vessels, workingUrl: baseUrl };
      }
    } catch {
      // 이 플랫폼 패턴으로는 안 맞는 것으로 보고 다음 후보를 시도한다.
    }
  }
  return { platform: "unknown", suggestedName: await fetchPageTitle(baseUrl), vessels: [], workingUrl: null };
}

function monthKey(sourceId: number, year: number, month: number): string {
  return `${sourceId}:${year}-${month}`;
}

function peekMonthCache(key: string): FishingSchedule[] | undefined {
  const cached = monthCache.get(key);
  return cached && cached.expiresAt > Date.now() ? cached.items : undefined;
}

function describeTiming(timing: MonthTiming): string {
  const parts = [
    timing.queueMs !== undefined ? `대기 ${timing.queueMs}` : null,
    timing.headersMs !== undefined ? `응답 ${timing.headersMs}` : null,
    timing.bodyMs !== undefined ? `본문 ${timing.bodyMs}` : null,
    timing.parseMs !== undefined ? `파싱 ${timing.parseMs}` : null,
    timing.bytes !== undefined ? `${Math.round(timing.bytes / 1024)}KB` : null,
    timing.via === "relay" ? "서울 중계" : null,
    timing.blocks !== undefined
      ? `달력 ${timing.blocks}일 · ${timing.items ?? 0}건${timing.pages && timing.pages > 1 ? ` · ${timing.pages}쪽` : ""}`
      : null,
  ].filter(Boolean);
  const failure = timing.ok ? "" : ` 실패: ${timing.error ?? "알 수 없음"}`;
  const partial = timing.partialError ? ` 일부만 받음(${timing.missingFrom ?? "?"}부터 못 받음): ${timing.partialError}` : "";
  const label = `${timing.name} ${timing.year}-${String(timing.month).padStart(2, "0")}`;
  return `${label} ${timing.totalMs}ms (${parts.join(" · ")})${failure}${partial}`;
}

function recordTiming(
  key: string,
  config: SourceConfig,
  year: number,
  month: number,
  startedAt: number,
  trace: FetchTrace,
  outcome: { ok: true } | { ok: false; error: unknown },
): void {
  const timing: MonthTiming = {
    ...trace,
    name: config.name,
    year,
    month,
    totalMs: Math.round(performance.now() - startedAt),
    ok: outcome.ok,
    error: outcome.ok ? undefined : outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
    finishedAt: Date.now(),
  };
  monthTimings.set(key, timing);
  if (!timing.ok) {
    logger.warn({ timing }, `[예약처 조회 실패] ${describeTiming(timing)}`);
  } else if (timing.partialError) {
    logger.warn({ timing }, `[예약처 조회 일부만] ${describeTiming(timing)}`);
  } else if (timing.totalMs >= SLOW_FETCH_LOG_MS) {
    logger.info({ timing }, `[예약처 조회 느림] ${describeTiming(timing)}`);
  }
}

/**
 * 예약처 한 곳의 한 달치 일정을 돌려준다. 캐시에 있으면 그대로, 이미 누군가 같은 걸 가져오는
 * 중이면 그 요청에 합류, 둘 다 아니면 새로 가져온다. 합류한 쪽이 사용자 검색("high")이고
 * 원래 요청이 백그라운드("low")였다면, 아직 줄 서 있는 경우 앞줄로 올려준다.
 */
function getMonthItems(
  config: SourceConfig,
  year: number,
  month: number,
  priority: FetchPriority,
): Promise<FishingSchedule[]> {
  const key = monthKey(config.id, year, month);
  const cached = peekMonthCache(key);
  if (cached) return Promise.resolve(cached);

  const running = inflightMonths.get(key);
  if (running) {
    if (priority === "high" && running.priority === "low") {
      running.priority = "high";
      fetchLimiter.promote(key);
    }
    return running.promise;
  }

  const epoch = cacheEpoch;
  const trace: FetchTrace = {};
  const startedAt = performance.now();
  const entry: InflightMonth = {
    priority,
    promise: fetchMonthForConfig(year, month, config, { priority, tag: key, trace })
      .then(
        (items) => {
          if (epoch === cacheEpoch) {
            // 이어지는 쪽이 실패해 앞쪽 날짜만 받은 달은 짧게만 캐시하고, 못 받은 날짜를 기록해 둔다.
            const partial = trace.partialError && trace.missingFrom;
            monthCache.set(key, { expiresAt: Date.now() + (partial ? PARTIAL_CACHE_TTL_MS : CACHE_TTL_MS), items });
            if (partial) partialMonthNotes.set(key, { missingFrom: trace.missingFrom!, message: trace.partialError! });
            else partialMonthNotes.delete(key);
          }
          recordTiming(key, config, year, month, startedAt, trace, { ok: true });
          return items;
        },
        (error: unknown) => {
          recordTiming(key, config, year, month, startedAt, trace, { ok: false, error });
          throw error;
        },
      )
      .finally(() => {
        if (inflightMonths.get(key) === entry) inflightMonths.delete(key);
      }),
  };
  inflightMonths.set(key, entry);
  return entry.promise;
}

function monthCursor(startDate: string, endDate: string): Array<{ year: number; month: number }> {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  const months: Array<{ year: number; month: number }> = [];
  while (cursor <= last) {
    months.push({ year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1 });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

// 이번 검색에서 끝내 불러오지 못한 예약처. url은 사용자가 직접 열어 볼 수 있게 화면에 링크로 보여 주는 용도다.
export type FailedSource = { name: string; reason: string; url: string };

export type FishingScheduleSearch = {
  items: FishingSchedule[];
  sources: SourceConfig[];
  failedSources: string[];
  // failedSources와 같은 순서의 실패 이유. "예약처 이름(이유)"로 경고에 붙여 보여 주려는 용도.
  failures: Array<FailedSource>;
  // 마감 시간(softDeadlineMs) 안에 응답하지 못해 이번 결과에서 빠진 예약처. 실패가 아니라 아직
  // 진행 중인 것이라, 백그라운드에서 계속 받아 캐시에 채우므로 잠시 뒤 다시 검색하면 나온다.
  pendingSources: string[];
  // 한 달을 여러 쪽에 나눠 받는 예약처 중, 이어지는 쪽이 실패해 찾는 기간의 일부 날짜를 못 받은 곳.
  // 받은 날짜의 결과는 그대로 들어 있고, 못 받은 날짜는 잠시 뒤 다시 시도한다.
  partialSources: Array<{ name: string; message: string }>;
};

/**
 * 한 줄로 보여 줄 실패 이유. 내부 오류 문구에서 군더더기를 덜어 낸다 (예: "예약 원본이 403 상태를
 * 반환했습니다." → "HTTP 403", "예약 원본에 연결하지 못했습니다: 주소를 찾지 못함 ENOTFOUND" →
 * "주소를 찾지 못함 ENOTFOUND"). 전체 문구는 /api/fishing/diagnostics 와 서버 로그에 그대로 남는다.
 */
export function summarizeFailureReason(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason ?? "");
  // 건너뛰는 중이라는 문구 안에 "이전 오류"가 들어 있으므로, HTTP 상태를 찾기 전에 먼저 가려낸다.
  if (message.startsWith("최근 반복 실패로 건너뜀")) {
    const previous = message.match(/이전 오류: (.*)\)$/s);
    return previous ? `반복 실패로 잠시 건너뜀 - 이전 오류 ${summarizeFailureReason(previous[1])}` : "반복 실패로 잠시 건너뜀";
  }
  const http = message.match(/(\d{3}) 상태를 반환/);
  if (http) return `HTTP ${http[1]}${message.includes(RELAY_VIA_NOTE) ? RELAY_VIA_NOTE : ""}`;
  const connection = message.match(/^예약 원본(?:에 연결하지 못했습니다| 응답을 끝까지 받지 못했습니다): (.+)$/);
  const text = (connection ? connection[1] : message).replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text || "알 수 없는 오류";
}

/**
 * 조회 대상 예약처가 전부 실패해 결과를 하나도 못 만들었을 때 던진다. 어느 예약처가 왜 실패했는지를
 * 담고 있어서, 검색 오류 화면과 서버 로그에서 원인을 바로 볼 수 있다.
 */
export class AllSourcesFailedError extends Error {
  readonly failures: Array<FailedSource>;

  constructor(failures: Array<FailedSource>) {
    super("모든 예약처를 불러오지 못했습니다.");
    this.name = "AllSourcesFailedError";
    this.failures = failures;
  }

  /** 화면에 보여 줄 한두 줄 요약. 예약처가 많으면 앞의 몇 곳만 보여 준다. */
  get detail(): string {
    const shown = this.failures.slice(0, 4).map((failure) => `${failure.name}: ${failure.reason}`);
    const rest = this.failures.length - shown.length;
    return rest > 0 ? `${shown.join(" / ")} / 외 ${rest}곳` : shown.join(" / ");
  }
}

// 우리 항구 이름 → 바다타임(badatime.com) 지역 ID. 바다타임 사이트에서 해당
// 항구를 검색해 URL의 숫자 ID를 직접 확인해 채워 넣었다. 여기 없는 항구는
// tideStrengthPercent가 그냥 null로 남는다 (검색 자체는 계속 정상 동작).
const BADATIME_LOCATION_IDS: Record<string, number> = {
  대천항: 126,
  삼길포: 144,
  신진도: 132,
  오천항: 355,
  마검포: 1400,
};

// 바다타임의 "날짜별물때" 표에서 한 줄당 한 번씩 나오는 "물흐름 **80%**
// [상세보기 >](.../그래프/YYYY-M-D)" 패턴. 상세보기 링크에 정확한 날짜가
// 박혀있어서, 표 구조를 따로 안 풀어도 (percent, 날짜)를 바로 뽑아낼 수 있다.
// 주기상 극값인 날은 숫자 대신 "최소"/"최대"로 표기된다.
const BADATIME_ROW_RE =
  /물흐름\s+\*\*(\d{1,3}%|최소|최대)\*\*\s+\[상세보기[^\]]*\]\(https:\/\/www\.badatime\.com\/\d+\/graph\/(\d{4})-(\d{1,2})-(\d{1,2})\)/g;

function parseBadatimePercent(value: string): number {
  if (value === "최소") return 0;
  if (value === "최대") return 100;
  return Number(value.replace("%", ""));
}

// 날짜별 조류 세기는 천문 데이터라 자주 바뀌지 않으므로, 예약 일정 캐시보다
// 훨씬 길게(하루) 잡아도 정확도 손해가 없다.
const TIDE_STRENGTH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// 바다타임이 느리거나 막혔을 때(또는 HTML 구조가 바뀌어 파싱 결과가 비었을 때), 같은 조회를
// 검색할 때마다 되풀이하며 기다리지 않도록 실패 후 잠시 동안은 다시 시도하지 않는다.
const TIDE_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const TIDE_FETCH_TIMEOUT_MS = 8_000;
// 예약처 조회가 끝난 뒤 조류 세기를 더 기다려 줄 최대 시간. 조류 세기는 예약처 조회와
// 동시에 미리 받아 두므로 보통은 기다릴 일이 없다.
const TIDE_WAIT_AFTER_SCRAPE_MS = 2_000;
const tideStrengthMonthCache = new Map<string, { expiresAt: number; days: Map<string, number> }>();
const tideFailureUntil = new Map<string, number>();
const tideInflight = new Map<string, Promise<Map<string, number> | null>>();
// 같은 사이트(바다타임)에 요청이 한꺼번에 몰리지 않게 예약처 조회와는 따로 제한한다.
const tideLimiter = createPriorityLimiter({ maxConcurrent: 4 });

async function loadTideStrengthMonth(locationId: number, year: number, month: number): Promise<Map<string, number>> {
  const url = `https://www.badatime.com/${locationId}/daily/${year}-${String(month).padStart(2, "0")}`;
  const response = await fetch(url, { headers: browserHeaders(url), signal: AbortSignal.timeout(TIDE_FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`바다타임 조류 세기 조회 실패 (${response.status})`);
  }
  const html = await response.text();
  const $ = cheerio.load(html);

  // 날짜당 모바일용 "mo-row-only" 줄이 하나씩 있고, 그 안에 progress-bar의
  // data-value(물흐름 %)와 /{id}/graph/YYYY-M-D 링크(정확한 날짜)가 같이 있다.
  const days = new Map<string, number>();
  $("tr.mo-row-only").each((_, row) => {
    const value = $(row).find(".progress-bar").first().attr("data-value");
    const href = $(row).find('a[href*="/graph/"]').first().attr("href") ?? "";
    const dateMatch = href.match(/\/graph\/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (value === undefined || !dateMatch) return;
    const percent = Number(value);
    if (!Number.isFinite(percent)) return;
    const [, y, m, d] = dateMatch;
    days.set(`${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`, percent);
  });
  if (days.size === 0) {
    throw new Error(`바다타임 파싱 결과 0건 (HTML 구조가 바뀌었을 수 있음): ${url}`);
  }
  return days;
}

// 한 (바다타임 지역, 연-월)의 날짜별 조류 세기. 캐시, 이미 진행 중인 요청에 합류, 실패 후
// 쿨다운을 처리하고, 어떤 이유로든 못 가져오면 null을 돌려준다. 이 부가 정보 때문에 검색이
// 실패하거나 오래 멈추는 일이 없도록 절대 throw하지 않는다.
function fetchTideStrengthMonth(locationId: number, year: number, month: number): Promise<Map<string, number> | null> {
  const key = `${locationId}:${year}-${month}`;
  const cached = tideStrengthMonthCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.days);
  if ((tideFailureUntil.get(key) ?? 0) > Date.now()) return Promise.resolve(null);
  const running = tideInflight.get(key);
  if (running) return running;

  const promise = tideLimiter
    .run(() => loadTideStrengthMonth(locationId, year, month))
    .then(
      (days): Map<string, number> | null => {
        tideStrengthMonthCache.set(key, { expiresAt: Date.now() + TIDE_STRENGTH_CACHE_TTL_MS, days });
        tideFailureUntil.delete(key);
        return days;
      },
      (err: unknown): Map<string, number> | null => {
        tideFailureUntil.set(key, Date.now() + TIDE_FAILURE_COOLDOWN_MS);
        logger.warn({ err }, `[tide] 바다타임 ${key} 조회 실패 — 5분간 다시 시도하지 않음`);
        return null;
      },
    )
    .finally(() => {
      tideInflight.delete(key);
    });
  tideInflight.set(key, promise);
  return promise;
}

function tideLocationIdFor(port: string): number | undefined {
  return (
    BADATIME_LOCATION_IDS[port] ??
    BADATIME_LOCATION_IDS[port.replace(/항$/, "")] ??
    BADATIME_LOCATION_IDS[`${port}항`]
  );
}

// 항구 → (날짜 → 조류 세기 %)
type TideByPort = Map<string, Map<string, number>>;

// 조류 세기는 (항구, 연-월)만 알면 가져올 수 있어서, 예약처 조회가 끝나길 기다리지 않고 검색을
// 시작하자마자 동시에 받아 둔다. byPort는 받는 대로 채워지고, done은 전부 끝나면 풀린다
// (done은 절대 reject되지 않는다). 매핑이 없는 항구는 조회하지 않아 tideStrengthPercent가 null로 남는다.
function prefetchTideStrength(
  sources: SourceConfig[],
  months: Array<{ year: number; month: number }>,
): { byPort: TideByPort; done: Promise<void> } {
  const byPort: TideByPort = new Map();
  const jobs: Array<Promise<void>> = [];
  for (const port of new Set(sources.map((source) => source.port))) {
    const locationId = tideLocationIdFor(port);
    if (!locationId) continue;
    const merged = new Map<string, number>();
    byPort.set(port, merged);
    for (const { year, month } of months) {
      jobs.push(
        fetchTideStrengthMonth(locationId, year, month).then((days) => {
          if (days) for (const [date, percent] of days) merged.set(date, percent);
        }),
      );
    }
  }
  return { byPort, done: Promise.all(jobs).then(() => undefined) };
}

function applyTideStrength(items: FishingSchedule[], byPort: TideByPort): void {
  for (const item of items) {
    item.tideStrengthPercent = byPort.get(item.port)?.get(item.departureDate) ?? null;
  }
}

export type GetSchedulesOptions = {
  /** 지역/항구를 골라서 검색한 경우, 관련 없는 예약처는 처음부터 조회하지 않는다. */
  filter?: { region?: string[]; port?: string; ship?: string[] };
  /** "high"(기본): 사용자가 직접 누른 검색. "low": 필터 목록 채우기 같은 백그라운드 조회. */
  priority?: FetchPriority;
  /**
   * 이 시간(ms)이 지나면 그때까지 응답한 예약처만으로 먼저 결과를 낸다. 못 끝낸 예약처는
   * pendingSources로 알려 주고 백그라운드에서 계속 받아 캐시에 채운다. 생략하면 전부 기다린다.
   */
  softDeadlineMs?: number;
  /** 바다타임 조류 세기를 붙일지 (필터 목록 용도에서는 필요 없음). 기본 true. */
  withTide?: boolean;
  /** 로그에 찍을 이름. */
  label?: string;
};

function logSearchSummary(args: {
  label: string;
  priority: FetchPriority;
  startedAt: number;
  startedAtWall: number;
  sources: SourceConfig[];
  requestedKeys: string[];
  cachedMonths: number;
  failedSources: string[];
  pendingSources: string[];
  tideWaitMs: number | null;
  // 조회하는 동안 서버 스레드가 일하느라 바빴던 비율(0~1). 1에 가까우면 서버 CPU가 병목,
  // 0에 가까우면 예약처 사이트 응답을 기다리는 시간이 대부분이라는 뜻.
  loopBusy: number;
  resultCount: number;
}): void {
  const totalMs = Math.round(performance.now() - args.startedAt);
  const fetchedMonths = args.requestedKeys.length - args.cachedMonths;
  // 필터 목록용 백그라운드 조회가 전부 캐시로 끝난 경우까지 매번 로그를 남기지는 않는다.
  if (args.priority === "low" && fetchedMonths === 0 && !args.failedSources.length && !args.pendingSources.length) {
    return;
  }
  const slowest = args.requestedKeys
    .map((key) => monthTimings.get(key))
    .filter((timing): timing is MonthTiming => timing !== undefined && timing.finishedAt >= args.startedAtWall)
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 5)
    .map(describeTiming);
  const okCount = args.sources.length - args.failedSources.length - args.pendingSources.length;
  const parts = [
    `[${args.label}] ${totalMs}ms`,
    `예약처 ${args.sources.length}곳 (성공 ${okCount} · 실패 ${args.failedSources.length} · 지연 ${args.pendingSources.length})`,
    `월 캐시 ${args.cachedMonths}/${args.requestedKeys.length}`,
    `조류 대기 ${args.tideWaitMs === null ? "-" : `${args.tideWaitMs}ms`}`,
    `서버 바쁨 ${Math.round(args.loopBusy * 100)}%`,
    `결과 ${args.resultCount}건`,
  ];
  if (args.failedSources.length) parts.push(`실패: ${args.failedSources.join(", ")}`);
  if (args.pendingSources.length) parts.push(`지연: ${args.pendingSources.join(", ")}`);
  parts.push(`느린 순: ${slowest.length ? slowest.join(" ; ") : "없음(전부 캐시)"}`);
  logger.info(
    {
      timing: {
        label: args.label,
        totalMs,
        sources: args.sources.length,
        failed: args.failedSources.length,
        pending: args.pendingSources.length,
        cachedMonths: args.cachedMonths,
        requestedMonths: args.requestedKeys.length,
        tideWaitMs: args.tideWaitMs,
        loopBusy: Math.round(args.loopBusy * 100) / 100,
        queue: fetchLimiter.stats(),
      },
    },
    parts.join(" | "),
  );
}

/**
 * 속도 문제를 실제 수치로 확인하기 위한 읽기 전용 현황 (GET /api/fishing/diagnostics).
 * 최근 조회한 예약처-월마다 "줄 서서 기다린 시간 / 사이트 응답 시간 / 본문 받는 시간 / 파싱 시간"을
 * 보여주기 때문에, 느린 원인이 예약처 사이트인지 서버 CPU인지 바로 구분된다.
 */
export function getFetchDiagnostics() {
  const now = Date.now();
  return {
    settings: {
      fetchConcurrency: FETCH_CONCURRENCY,
      reservedForSearch: FETCH_RESERVED_FOR_SEARCH,
      fetchTimeoutMs: FETCH_TIMEOUT_MS,
      cacheTtlMinutes: CACHE_TTL_MS / 60_000,
    },
    queue: fetchLimiter.stats(),
    // 서울 중계(relay.ts) 현황. 꺼져 있으면 configured:false. 켜져 있으면 처음부터 중계로 보내는 사이트와,
    // 직접 연결이 안 되어 중계로 성공한 뒤 일정 시간 중계로 먼저 조회하기로 기억해 둔 사이트가 나온다.
    relay: getRelay()?.snapshot() ?? { configured: false as const },
    cachedMonths: [...monthCache.values()].filter((entry) => entry.expiresAt > now).length,
    inflightMonths: inflightMonths.size,
    // 서버를 켠 뒤 지금까지 이벤트 루프가 일한 비율. 검색 한 번 동안의 값은 로그의 "서버 바쁨"을 본다.
    eventLoopBusySinceBoot: Math.round(performance.eventLoopUtilization().utilization * 1000) / 1000,
    recentFetches: [...monthTimings.values()]
      .sort((a, b) => b.totalMs - a.totalMs)
      .map((timing) => ({
        source: timing.name,
        month: `${timing.year}-${String(timing.month).padStart(2, "0")}`,
        ok: timing.ok,
        totalMs: timing.totalMs,
        queueMs: timing.queueMs ?? null,
        headersMs: timing.headersMs ?? null,
        bodyMs: timing.bodyMs ?? null,
        parseMs: timing.parseMs ?? null,
        kb: timing.bytes === undefined ? null : Math.round(timing.bytes / 1024),
        // 응답은 받았는데 결과가 0건일 때 이유를 가른다: calendarDays가 0이면 달력을 못 찾은 것(차단/다른 화면),
        // calendarDays가 있는데 items가 0이면 남은 자리가 있는 날이 없거나 읽는 방식이 다른 것.
        calendarDays: timing.blocks ?? null,
        items: timing.items ?? null,
        pages: timing.pages ?? null,
        // "relay"면 이 조회에서 서울 중계를 거친 요청이 있었다는 뜻.
        via: timing.via ?? "direct",
        error: timing.error ?? null,
        // 첫 쪽은 받았는데 이어지는 쪽이 실패해 앞쪽 날짜만 받은 경우의 이유와, 못 받은 첫 날짜 (이때 ok는 true).
        partialError: timing.partialError ?? null,
        missingFrom: timing.missingFrom ?? null,
        secondsAgo: Math.round((now - timing.finishedAt) / 1000),
      })),
    sourceHealth: getSourceHealthSnapshot(),
  };
}

export async function getSchedules(
  startDate: string,
  endDate: string,
  options: GetSchedulesOptions = {},
): Promise<FishingScheduleSearch> {
  const { filter, priority = "high", softDeadlineMs, withTide = true } = options;
  const label = options.label ?? (priority === "high" ? "검색" : "필터목록");
  const startedAt = performance.now();
  const startedAtWall = Date.now();
  // 이 조회 동안 이벤트 루프(서버의 일하는 스레드)가 얼마나 바빴는지 재기 위한 기준점.
  const loopStart = performance.eventLoopUtilization();

  const sourceRecords = await listConfiguredSources();
  let sources = sourceRecords.filter((source) => source.enabled).map(toSourceConfig);
  // 지역/항구를 선택해서 검색한 경우, 처음부터 관련 없는 예약처는 조회 대상에서
  // 뺀다. 관련 없는 지역까지 매번 스크래핑하면 느리고, "일부 예약처를 불러오지
  // 못했습니다" 경고에도 선택한 지역과 무관한 예약처 이름까지 나열되기 때문이다.
  if (filter?.region?.length) {
    sources = sources.filter((source) => filter.region!.includes(source.region));
  }
  if (filter?.port) {
    sources = sources.filter((source) => source.port === filter.port);
  }
  // 선박을 골랐다면 그 배가 속한 예약처만 조회한다 (배가 등록되어 있지 않은 예약처는 알 수 없으니 남겨 둔다).
  if (filter?.ship?.length) {
    const norm = (value: string) => value.replace(/\s+/g, "").toLowerCase();
    const wanted = filter.ship.map(norm).filter(Boolean);
    const matches = (vessel: string) => {
      const v = norm(vessel);
      return wanted.some((w) => v === w || v.includes(w) || w.includes(v));
    };
    const narrowed = sources.filter((source) => !source.vessels?.length || source.vessels.some(matches));
    // 어느 예약처에도 해당 배가 없다고 나오면(이름이 달라서 못 찾는 경우) 안전하게 원래 목록으로 조회한다.
    if (narrowed.some((source) => source.vessels?.some(matches))) sources = narrowed;
  }

  if (sources.length === 0) {
    return { items: [], sources, failedSources: [], failures: [], pendingSources: [], partialSources: [] };
  }

  const months = monthCursor(startDate, endDate);
  // 조류 세기는 (항구, 연-월)만 알면 받을 수 있어서 예약처 조회와 동시에 미리 받아 둔다.
  // 필터 목록용 조회(withTide=false)는 결과에 붙이지도 기다리지도 않지만, 받아 두면 곧이어
  // 누르는 첫 검색이 바다타임을 기다리지 않아도 된다.
  const tide = prefetchTideStrength(sources, months);

  // (예약처 × 월) 요청을 "월 순서대로" 만든다: 모든 예약처의 첫 달을 먼저, 그다음 달을 요청한다.
  // 그래야 줄이 길어도 가까운 달 데이터부터 채워진다. 같은 키가 이미 캐시에 있거나 진행 중이면
  // getMonthItems가 새 요청 없이 그걸 재사용한다.
  const skipped = sources.map((source) => isSkipped(source.id));
  const monthRequests: Array<Array<Promise<FishingSchedule[]>>> = sources.map(() => []);
  const requestedKeys: string[] = [];
  let cachedMonths = 0;
  for (const { year, month } of months) {
    sources.forEach((source, index) => {
      if (skipped[index]) return;
      const key = monthKey(source.id, year, month);
      requestedKeys.push(key);
      if (peekMonthCache(key)) cachedMonths += 1;
      monthRequests[index].push(getMonthItems(source, year, month, priority));
    });
  }
  const sourcePromises = sources.map((source, index): Promise<FishingSchedule[]> => {
    const skippedHealth = skipped[index];
    if (skippedHealth) {
      return Promise.reject(
        new Error(`최근 반복 실패로 건너뜀 (${skippedHealth.consecutiveFailures}회 연속 실패, 이전 오류: ${skippedHealth.lastError ?? "알 수 없음"})`),
      );
    }
    return Promise.all(monthRequests[index]).then(
      (parts) => {
        recordSuccess(source.id);
        return parts.flat();
      },
      (error: unknown) => {
        recordFailure(source.id, error);
        throw error;
      },
    );
  });

  // 느린 예약처 한 곳이 전체 응답을 붙잡지 않도록, 마감 시간이 지나면 응답한 곳까지만으로
  // 먼저 결과를 낸다. 못 끝낸 곳은 (실패 처리하지 않고) 백그라운드에서 계속 받아 캐시에 채운다.
  const settled = await settleWithSoftDeadline(sourcePromises, softDeadlineMs);
  const collected: FishingSchedule[] = [];
  const failedSources: string[] = [];
  const failures: Array<FailedSource> = [];
  const pendingSources: string[] = [];
  const partialSources: Array<{ name: string; message: string }> = [];
  // 이 검색 기간에 걸리는 달 중, 이어지는 쪽을 못 받아 일부 날짜가 빠진 달이 있으면 그 이유를 돌려준다.
  // (캐시가 아직 살아 있는 동안만 유효하다. 못 받은 날짜가 검색 기간 밖이면 알릴 필요가 없다.)
  const partialNoteFor = (sourceId: number): string | null => {
    for (const { year, month } of months) {
      const key = monthKey(sourceId, year, month);
      const note = partialMonthNotes.get(key);
      if (note && note.missingFrom <= endDate && peekMonthCache(key)) {
        const day = `${Number(note.missingFrom.slice(5, 7))}월 ${Number(note.missingFrom.slice(8, 10))}일`;
        return `${day}부터는 못 받음: ${summarizeFailureReason(note.message)}`;
      }
    }
    return null;
  };
  settled.forEach((result, index) => {
    const name = sources[index]?.name || "예약처";
    if (!result) {
      pendingSources.push(name);
    } else if (result.status === "rejected") {
      failedSources.push(name);
      failures.push({ name, reason: summarizeFailureReason(result.reason), url: sources[index]?.baseUrl ?? "" });
    } else {
      for (const item of result.value) collected.push(item);
      const note = partialNoteFor(sources[index].id);
      if (note) partialSources.push({ name, message: note });
    }
  });
  // 월 단위로 가져온 데이터라, 실제 요청한 날짜 범위(startDate~endDate)에 맞게 여기서 다시 거른다.
  const items = collected.filter((item) => item.departureDate >= startDate && item.departureDate <= endDate);
  if (items.length === 0 && failedSources.length === sources.length) {
    // 이 경우는 아래 검색 요약 로그까지 가지 못하므로, 어느 예약처가 왜 실패했는지 여기서 남긴다.
    logger.warn(
      { failures },
      `[${label} 실패] 조회 대상 예약처 ${sources.length}곳이 모두 실패: ${failures.map((failure) => `${failure.name}(${failure.reason})`).join(", ")}`,
    );
    throw new AllSourcesFailedError(failures);
  }

  let tideWaitMs: number | null = null;
  if (withTide) {
    // 조류 세기는 부가 정보라, 늦거나 실패해도 받은 데이터까지만 붙이고 검색 결과는 그대로 돌려준다.
    const tideStartedAt = performance.now();
    await waitAtMost(tide.done, TIDE_WAIT_AFTER_SCRAPE_MS);
    tideWaitMs = Math.round(performance.now() - tideStartedAt);
    try {
      applyTideStrength(items, tide.byPort);
    } catch {
      // 무시
    }
  }

  logSearchSummary({
    label,
    priority,
    startedAt,
    startedAtWall,
    sources,
    requestedKeys,
    cachedMonths,
    failedSources,
    pendingSources,
    tideWaitMs,
    loopBusy: performance.eventLoopUtilization(loopStart).utilization,
    resultCount: items.length,
  });
  return { items, sources, failedSources, failures, pendingSources, partialSources };
}

// 실제로 한 번이라도 스크래핑에서 관측된 물때 표기(예: "7물", "조금", "무시")를
// 서버가 계속 기억해둔다. 물때는 그 날짜에 고유하게 정해지는 값이라 매번 다시
// 긁어올 필요가 없는데, 사이트마다 표기(1~13물 vs 1~15물, 조금/무시 위치 등)가
// 조금씩 달라서 임의로 목록을 하드코딩하기보다는 실제 관측치를 누적하는 편이
// 더 정확하다. 이렇게 하면 이후 조회가 느리거나 실패해도 필터 목록은 비지 않는다.
const knownTides = new Set<string>();
// 서버가 막 재시작돼서 아직 아무것도 관측 못 했을 때를 위한 초기값(그동안
// 실제로 확인된 표기 기준). 실제 스크래핑 결과가 들어오면 자동으로 더
// 정확한 값으로 채워지고 넓어진다 — 이건 그냥 첫 요청부터 비어보이지
// 않게 하기 위한 임시 출발점일 뿐이다.
["1물", "2물", "3물", "4물", "5물", "6물", "7물", "8물", "9물", "10물", "11물", "12물", "13물", "조금", "무시"].forEach(
  (tide) => knownTides.add(tide),
);

// 선박명도 물때와 같은 이유로 누적 기억한다: 한 번이라도 실시간 조회나 업로드로
// 확인된 선박은, 이후 해당 예약처 조회가 느리거나 실패해도 필터에서 계속 선택
// 가능하게 한다. 항구별/지역별 매핑도 동일하게 누적한다(예약처 설정이 바뀌면
// clearSourceCache()에서 비워진다).
const knownShips = new Set<string>();
const knownShipsByPort = new Map<string, Set<string>>();
const knownShipsByRegion = new Map<string, Set<string>>();

function addToKnownMap(map: Map<string, Set<string>>, key: string, vessel: string): void {
  if (!key || !vessel) return;
  const values = map.get(key) ?? new Set<string>();
  values.add(vessel);
  map.set(key, values);
}

export function getFilterOptions(
  items: FishingSchedule[],
  sources: Array<Pick<SourceConfig, "region" | "port" | "vessels">> = [],
): FishingFilterOptions {
  for (const item of items) {
    if (item.tide) knownTides.add(item.tide);
    if (item.vessel && !isExcludedVessel(item.vessel)) knownShips.add(item.vessel);
    if (!isExcludedVessel(item.vessel)) {
      addToKnownMap(knownShipsByPort, item.port, item.vessel);
      addToKnownMap(knownShipsByRegion, item.region, item.vessel);
    }
  }
  for (const source of sources) {
    for (const vessel of source.vessels) {
      if (isExcludedVessel(vessel)) continue;
      knownShips.add(vessel);
      addToKnownMap(knownShipsByPort, source.port, vessel);
      addToKnownMap(knownShipsByRegion, source.region, vessel);
    }
  }
  const sourceValues = (selector: (source: SourceConfig) => string) =>
    sources.map(selector).filter(Boolean);
  const serializeMap = (map: Map<string, Set<string>>) =>
    Object.fromEntries([...map.entries()].map(([key, values]) => [key, [...values].sort((a, b) => a.localeCompare(b, "ko"))]));
  return {
    regions: [...new Set([...items.map((item) => item.region), ...sourceValues((source) => source.region)].filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko")),
    ports: [...new Set([...items.map((item) => item.port), ...sourceValues((source) => source.port)].filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko")),
    ships: [...knownShips].sort((a, b) => a.localeCompare(b, "ko")),
    tides: [...knownTides].sort((a, b) => a.localeCompare(b, "ko")),
    shipsByPort: serializeMap(knownShipsByPort),
    shipsByRegion: serializeMap(knownShipsByRegion),
  };
}

export function getSourceLabel(sources: SourceConfig[]): string {
  return sources.length === 1 ? sources[0].baseUrl : `${sources.length}개 예약처`;
}

export type DiscoveredPortSource = {
  id: number;
  name: string;
  region: string;
  port: string;
  sourceUrl: string;
  vessels: string[];
};

export type DiscoverByPortResult = {
  portKeyword: string;
  scannedUids: number;
  candidateSites: number;
  added: DiscoveredPortSource[];
  skippedExisting: string[];
  failed: Array<{ name: string; url: string; reason: string }>;
};

const REGION_SHORT_MAP: Record<string, string> = {
  "충청남도": "충남",
  "충청북도": "충북",
  "전라남도": "전남",
  "전라북도": "전북",
  "전북특별자치도": "전북",
  "경상남도": "경남",
  "경상북도": "경북",
  "강원특별자치도": "강원",
  "강원도": "강원",
  "제주특별자치도": "제주",
  "제주도": "제주",
  "경기도": "경기",
  "인천광역시": "인천",
  "부산광역시": "부산",
  "울산광역시": "울산",
};

function normalizeRegionLabel(raw: string): string {
  const cleaned = cleanText(raw);
  return REGION_SHORT_MAP[cleaned] || cleaned.replace(/(특별자치도|특별시|광역시|도)$/, "") || "충남";
}

function sourceDedupKey(rawUrl: string): string {
  const shipNo = extractSunsangShipNo(rawUrl);
  if (shipNo) return "sunsang24:" + shipNo;
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

export async function discoverSourcesByPort(
  rawKeyword: string,
  regionOverride?: string,
  scanSources: { thefishing: boolean; sunsang24: boolean } = { thefishing: true, sunsang24: true },
  signal?: AbortSignal,
): Promise<DiscoverByPortResult> {
  const portKeyword = cleanText(rawKeyword).replace(/항$/, "");
  if (!portKeyword) {
    throw new Error("항구 키워드를 입력해 주세요.");
  }

  const existingSources = await listConfiguredSources();
  const existingKeys = new Set<string>();
  const existingNamesByPort = new Set<string>();
  for (const src of existingSources) {
    existingKeys.add(sourceDedupKey(src.sourceUrl));
    if (src.port.replace(/항$/, "") === portKeyword) {
      existingNamesByPort.add(cleanText(src.name).replace(/\s+/g, ""));
      for (const v of src.vessels) {
        existingNamesByPort.add(cleanText(v.name).replace(/\s+/g, ""));
      }
    }
  }

  const siteCandidates = new Map<
    string,
    {
      baseUrl: string;
      name: string;
      region: string;
      port: string;
      preVessels?: string[];
      skipDetect?: boolean;
    }
  >();
  const skippedExisting: string[] = [];
  const failed: Array<{ name: string; url: string; reason: string }> = [];
  let totalScannedCount = 0;

  // PART 1: 더피싱 전수 스캔
  const uidCandidates = new Map<string, { uid: string; operatorName: string; region: string; port: string }>();
  let currentPage = 1;
  const maxPages = scanSources.thefishing ? 15 : 0;

  while (currentPage <= maxPages && !signal?.aborted) {
    const searchUrl = new URL("https://thefishing.kr/search/result.php");
    searchUrl.searchParams.set("cat", "reservation");
    searchUrl.searchParams.set("msearch_text", portKeyword);
    searchUrl.searchParams.set("page", String(currentPage));

    let searchHtml = "";
    try {
      searchHtml = await fetchHtml(searchUrl, "https://thefishing.kr/", USER_FETCH_CONTEXT);
    } catch {
      break;
    }

    const $ = cheerio.load(searchHtml);
    const foundUidsOnPage = new Set<string>();

    $("a.search_list_card_item_link, a[href*=\"reservation/list.php?uid=\"]").each((_idx, el) => {
      const anchor = $(el);
      const href = anchor.attr("href") || "";
      const uidMatch = href.match(/uid=(\d+)/);
      if (!uidMatch) return;
      const uid = uidMatch[1];
      foundUidsOnPage.add(uid);

      if (uidCandidates.has(uid)) return;

      const rawHtml = anchor.html() || "";
      const lines = rawHtml
        .split(/<br\s*\/?>/i)
        .map((part) => cleanText(cheerio.load(part).text()))
        .filter(Boolean);

      let operatorName = cleanText(anchor.find(".card_item_content_stname").text()) || lines[0] || "";
      let region = regionOverride?.trim() || "";
      let port = portKeyword;

      const breadcrumbLine = lines.find((line) => line.includes(">"));
      if (breadcrumbLine) {
        const parts = breadcrumbLine.split(">").map((p) => cleanText(p)).filter(Boolean);
        if (!region && parts.length >= 2) {
          region = normalizeRegionLabel(parts[1]);
        }
        if (parts.length >= 4) {
          port = parts[parts.length - 1].replace(/항$/, "") || portKeyword;
        }
      }

      if (!operatorName || operatorName.includes(">")) {
        operatorName = port + " 예약처 " + uid;
      }

      uidCandidates.set(uid, {
        uid,
        operatorName,
        region: region || "충남",
        port,
      });
    });

    if (foundUidsOnPage.size === 0) break;
    currentPage++;
  }

  totalScannedCount += uidCandidates.size;

  for (const item of uidCandidates.values()) {
    if (signal?.aborted) break;
    try {
      const detailUrl = new URL("https://thefishing.kr/reservation/list.php?uid=" + item.uid);
      const detailHtml = await fetchHtml(detailUrl, "https://thefishing.kr/", USER_FETCH_CONTEXT);
      const $d = cheerio.load(detailHtml);

      const siteHref = $d("a.site").attr("href") || "";
      const normUrl = normalizeProbeUrl(siteHref);
      if (!normUrl) continue;

      const parsedSite = new URL(normUrl);
      if (parsedSite.hostname.endsWith("thefishing.kr")) continue;
      const hostKey = parsedSite.hostname.replace(/^www\./i, "").toLowerCase();
      const originUrl = parsedSite.protocol + "//" + parsedSite.hostname;

      const titleText = cleanText($d("title").first().text());
      const bracketMatch = titleText.match(/\[([^\]]+)\]/);
      const cleanOperatorName = bracketMatch ? cleanText(bracketMatch[1]) : item.operatorName;

      if (existingKeys.has(hostKey)) {
        if (!skippedExisting.includes(cleanOperatorName)) {
          skippedExisting.push(cleanOperatorName);
        }
        continue;
      }

      if (!siteCandidates.has(hostKey)) {
        siteCandidates.set(hostKey, {
          baseUrl: originUrl,
          name: cleanOperatorName,
          region: item.region,
          port: item.port,
        });
      }
    } catch (err) {
      failed.push({
        name: item.operatorName,
        url: "https://thefishing.kr/reservation/list.php?uid=" + item.uid,
        reason: err instanceof Error ? err.message : "더피싱 상세 조회 실패",
      });
    }
  }

  // PART 2: 선상24 공식 API 스캔
  const sunsangShips = new Map<number, { no: number; name: string; region: string; port: string }>();
  for (const kw of scanSources.sunsang24 ? [portKeyword + "항", portKeyword] : []) {
    let sPage = 1;
    while (sPage <= 10 && !signal?.aborted) {
      try {
        const listUrl = new URL("https://api.sunsang24.com/ship/list");
        listUrl.searchParams.set("page", String(sPage));
        listUrl.searchParams.set("type", "general");
        listUrl.searchParams.set("keyword", kw);

        const raw = await fetchHtml(listUrl, "https://www.sunsang24.com/", USER_FETCH_CONTEXT);
        const data = JSON.parse(raw);
        const rows = Array.isArray(data?.list) ? data.list : [];
        if (rows.length === 0) break;

        for (const row of rows) {
          const shipNo = Number(row?.ship?.no);
          const shipName = cleanText(row?.ship?.name || "");
          const rowPort = cleanText(row?.port_name || "").replace(/항$/, "");
          if (!shipNo || !shipName) continue;
          if (rowPort && !rowPort.includes(portKeyword) && !portKeyword.includes(rowPort)) continue;

          if (!sunsangShips.has(shipNo)) {
            const areaMain = cleanText(row?.ship?.area_main || "");
            sunsangShips.set(shipNo, {
              no: shipNo,
              name: shipName,
              region: regionOverride?.trim() || (areaMain ? normalizeRegionLabel(areaMain) : "충남"),
              port: rowPort || portKeyword,
            });
          }
        }

        if (data?.is_data_end || rows.length < 15) break;
        sPage++;
      } catch {
        break;
      }
    }
    if (sunsangShips.size > 0) break;
  }

  totalScannedCount += sunsangShips.size;
  const processedGroupNos = new Set<number>();

  for (const ship of sunsangShips.values()) {
    if (signal?.aborted) break;
    if (processedGroupNos.has(ship.no)) continue;

    let groupVessels: string[] = [ship.name];
    let primaryNo = ship.no;

    try {
      const grpUrl = new URL("https://api.sunsang24.com/ship/group/" + ship.no + "/M");
      const grpRaw = await fetchHtml(grpUrl, "https://www.sunsang24.com/", USER_FETCH_CONTEXT);
      const grpList = JSON.parse(grpRaw);
      if (Array.isArray(grpList) && grpList.length > 0) {
        const nos: number[] = [];
        const names: string[] = [];
        for (const g of grpList) {
          const gNo = Number(g?.no);
          const gName = cleanText(g?.name || "");
          if (gNo) {
            nos.push(gNo);
            processedGroupNos.add(gNo);
          }
          if (gName && !isExcludedVessel(gName) && !names.includes(gName)) {
            names.push(gName);
          }
        }
        if (nos.length > 0) primaryNo = nos[0];
        if (names.length > 0) groupVessels = names;
      }
    } catch {}
    processedGroupNos.add(ship.no);

    const dedupKey = "sunsang24:" + primaryNo;
    const displayOperatorName = ship.port + "항 " + groupVessels[0] + " (선상24)";

    const alreadyInPort = groupVessels.some((v) => existingNamesByPort.has(cleanText(v).replace(/\s+/g, "")));
    if (existingKeys.has(dedupKey) || alreadyInPort) {
      if (!skippedExisting.includes(displayOperatorName)) {
        skippedExisting.push(displayOperatorName);
      }
      continue;
    }

    if (!siteCandidates.has(dedupKey)) {
      siteCandidates.set(dedupKey, {
        baseUrl: "https://www.sunsang24.com/ship/schedule?ship_no=" + primaryNo,
        name: displayOperatorName,
        region: ship.region,
        port: ship.port,
        preVessels: groupVessels,
        skipDetect: true,
      });
    }
  }

  // PART 3: DB 등록
  const added: DiscoveredPortSource[] = [];

  for (const [dedupKey, candidate] of siteCandidates.entries()) {
    if (signal?.aborted) break;
    try {
      let finalName = cleanText(candidate.name);
      let finalUrl = candidate.baseUrl;
      let vessels = candidate.preVessels ?? [];

      if (!candidate.skipDetect) {
        const detected = await detectSource(candidate.baseUrl);
        finalName = cleanText(candidate.name || detected?.suggestedName || candidate.baseUrl);
        finalUrl = detected?.workingUrl || candidate.baseUrl;
        vessels = detected?.vessels ?? [];
      }

      const [created] = await db
        .insert(fishingSourcesTable)
        .values({
          name: finalName,
          region: candidate.region,
          port: candidate.port,
          sourceUrl: finalUrl,
          enabled: true,
        })
        .onConflictDoNothing()
        .returning();

      if (!created) {
        if (!skippedExisting.includes(finalName)) skippedExisting.push(finalName);
        continue;
      }

      if (vessels.length > 0) {
        await db
          .insert(fishingSourceVesselsTable)
          .values(
            vessels.map((vName) => ({
              sourceId: created.id,
              name: vName,
              departurePort: candidate.port,
              address: "",
            })),
          )
          .onConflictDoNothing();
      }

      existingKeys.add(dedupKey);
      for (const v of vessels) {
        existingNamesByPort.add(cleanText(v).replace(/\s+/g, ""));
      }

      added.push({
        id: created.id,
        name: created.name,
        region: created.region,
        port: created.port,
        sourceUrl: created.sourceUrl,
        vessels,
      });
    } catch (err) {
      failed.push({
        name: candidate.name,
        url: candidate.baseUrl,
        reason: err instanceof Error ? err.message : "등록 실패",
      });
    }
  }

  if (added.length > 0) {
    clearSourceCache();
    resetSourceHealth();
  }

  return {
    portKeyword,
    scannedUids: totalScannedCount,
    candidateSites: siteCandidates.size,
    added,
    skippedExisting,
    failed,
  };
}
