import crypto from "node:crypto";
import { logger } from "./logger";
import { RelayError, normalizeHost } from "./relay";

/**
 * 집 PC 중계 (선택 기능)
 *
 * 일부 예약처(더피싱 등)는 클라우드·호스팅 서버의 접속을 막아서, Render·서울 중계·닷홈이 모두 "연결 시간 초과"가 난다.
 * 그럴 때 집에 있는 PC(한국 가정용 인터넷)가 대신 사이트를 열어 주는 방식이다.
 *
 * 집 PC에서 home-agent/agent.mjs 를 실행해 두면, 그 프로그램이 이 서버에 먼저 접속해서 "할 일이 있나요?"를 계속 묻는다
 * (긴 대기 방식, 20초). 서버는 사이트 요청이 생기면 대기 중인 그 질문에 요청을 실어 돌려보내고, PC가 사이트에서 받은
 * 결과를 다시 서버로 올려 준다. PC가 서버로 먼저 접속하기 때문에 공유기 설정이나 터널이 필요 없다.
 *
 * 환경변수 HOME_AGENT_TOKEN (16자 이상)이 있을 때만 켜지고, PC가 최근 45초 안에 접속해 있을 때만 쓰인다.
 * PC가 꺼져 있거나 접속이 끊기면 예전 방식(닷홈 중계기·직접 연결)으로 자동으로 돌아간다.
 */

const ONLINE_WINDOW_MS = 45_000;
const POLL_HOLD_MS = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const LEARN_TTL_MS = 6 * 60 * 60 * 1000;

export type HomeRequest = Record<string, unknown>;

type Pending = {
  id: string;
  payload: HomeRequest;
  delivered: boolean;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const queue: Pending[] = []; // 아직 PC에 넘기지 않은 요청
const inflight = new Map<string, Pending>(); // 요청 번호 → 대기 중인 호출
let waiter: { wake: () => void; cancel: () => void } | null = null; // 지금 PC가 걸어 둔 긴 대기
let lastSeen = 0;
let lastError = "";
let served = 0;

export const homeAgentToken = (): string => (process.env.HOME_AGENT_TOKEN ?? "").trim();
export const homeAgentEnabled = (): boolean => homeAgentToken().length >= 16;
export const homeAgentOnline = (): boolean => homeAgentEnabled() && Date.now() - lastSeen < ONLINE_WINDOW_MS;

export function homeAgentStatus() {
  return {
    enabled: homeAgentEnabled(),
    online: homeAgentOnline(),
    lastSeenSecondsAgo: lastSeen ? Math.round((Date.now() - lastSeen) / 1000) : null,
    served,
    lastError: lastError || null,
  };
}

export function tokenMatches(given: unknown): boolean {
  const want = homeAgentToken();
  if (!want || typeof given !== "string") return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

export function touchAgent(): void {
  lastSeen = Date.now();
}

/** PC가 걸어 둔 긴 대기. 넘길 요청이 있으면 바로, 없으면 최대 20초 기다렸다가 돌려준다. */
export function takeJobs(isClosed: () => boolean): Promise<Array<{ id: string; payload: HomeRequest }>> {
  touchAgent();
  const grab = () => {
    const jobs = queue.splice(0, 8);
    for (const job of jobs) job.delivered = true;
    return jobs.map((job) => ({ id: job.id, payload: job.payload }));
  };
  // 이전에 걸려 있던 대기는 (PC가 다시 접속한 것이므로) 빈손으로 끝낸다. 요청을 가져가게 두면 끊어진 연결에서 사라진다.
  if (waiter) waiter.cancel();
  if (queue.length) return Promise.resolve(grab());
  return new Promise((resolve) => {
    let done = false;
    const finish = (jobs: Array<{ id: string; payload: HomeRequest }>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(watch);
      if (waiter === me) waiter = null;
      touchAgent();
      resolve(jobs);
    };
    const me = { wake: () => finish(isClosed() ? [] : grab()), cancel: () => finish([]) };
    waiter = me;
    const timer = setTimeout(() => finish([]), POLL_HOLD_MS);
    const watch = setInterval(() => {
      if (isClosed()) finish([]);
    }, 1000);
  });
}

/** PC로 보내지 못한 요청(전달 직전에 연결이 끊김)을 다시 줄 맨 앞에 되돌린다. */
export function requeueJobs(jobs: Array<{ id: string }>): void {
  for (const { id } of [...jobs].reverse()) {
    const call = inflight.get(id);
    if (!call) continue;
    call.delivered = false;
    queue.unshift(call);
  }
}

export function deliverResult(id: string, result: unknown): boolean {
  touchAgent();
  const call = inflight.get(id);
  if (!call) return false;
  inflight.delete(id);
  clearTimeout(call.timer);
  served += 1;
  call.resolve(result);
  return true;
}

/**
 * 집 PC에 요청을 맡기고 결과를 기다린다. payload 는 닷홈 중계기와 같은 형식(단일 요청 또는 batch)이다.
 * PC가 요청을 받기도 전에 끊기면 "요청이 나가지 않았다"는 오류를(예약 제출은 실패로 처리), 받은 뒤에 응답이 없으면
 * 시간 초과 오류를 던진다 (받은 뒤라면 사이트가 요청을 처리했는지 알 수 없다).
 */
export function homeCall(payload: HomeRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
  if (!homeAgentOnline()) {
    return Promise.reject(new Error("중계기 오류(config): 집 PC 중계가 연결되어 있지 않아 요청을 보내지 못했습니다"));
  }
  const id = crypto.randomBytes(8).toString("hex");
  return new Promise((resolve, reject) => {
    const call: Pending = {
      id,
      payload,
      delivered: false,
      resolve,
      reject,
      timer: setTimeout(() => {
        inflight.delete(id);
        const at = queue.indexOf(call);
        if (at >= 0) queue.splice(at, 1);
        lastError = call.delivered ? "집 PC가 요청을 받았지만 결과를 보내오지 않음" : "집 PC가 요청을 받아 가지 않음";
        reject(
          call.delivered
            ? new Error("집 PC 중계 응답 시간 초과 (요청은 PC에 전달되었습니다)")
            : new Error("중계기 오류(config): 집 PC가 요청을 받아 가기 전에 연결이 끊겨 요청을 보내지 못했습니다"),
        );
      }, timeoutMs),
    };
    inflight.set(id, call);
    queue.push(call);
    if (waiter) waiter.wake();
  });
}

// ---------------------------------------------------------------- 조회(자리 찾기)용
const learned = new Map<string, number>();

/** 직접 연결이 안 되어 집 PC로만 성공한 사이트는 6시간 동안 곧바로 PC로 조회한다. */
export function homePrefers(hostname: string): boolean {
  if (!homeAgentOnline()) return false;
  const host = normalizeHost(hostname);
  const until = learned.get(host);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    learned.delete(host);
    return false;
  }
  return true;
}

export function homeLearn(hostname: string, why: string): void {
  const host = normalizeHost(hostname);
  const known = (learned.get(host) ?? 0) > Date.now();
  learned.set(host, Date.now() + LEARN_TTL_MS);
  if (!known) logger.info({ host, why }, `[집 PC 중계] ${host}: 직접 연결이 안 되어(${why}) 집 PC로 불러왔습니다. 앞으로 6시간 동안은 PC로 먼저 조회합니다.`);
}

export function homeForget(hostname: string): void {
  learned.delete(normalizeHost(hostname));
}

/** 페이지 한 장을 집 PC로 받아 온다. 사이트가 돌려준 상태 코드는 그대로 넘기고, 중계 쪽 문제는 RelayError 로 던진다. */
export async function homeFetch(target: URL, referer: string, timeoutMs = 20_000): Promise<Response> {
  let out: any;
  try {
    out = await homeCall({ url: target.toString(), method: "GET", headers: {}, body: "", referer, cookie: "", follow: true, timeoutMs }, timeoutMs + 10_000);
  } catch (error) {
    throw new RelayError(`집 PC 중계 연결 실패 ${error instanceof Error ? error.message.replace(/[()]/g, "").slice(0, 80) : ""}`.trim());
  }
  if (out?.error) {
    const why = String(out.message ?? "응답 없음").replace(/[()]/g, "").slice(0, 60);
    throw new RelayError(`집 PC 중계로도 못 열림: ${why}`, out.error === "upstream");
  }
  const headers = new Headers();
  if (out.contentType) headers.set("content-type", String(out.contentType));
  const status = Number(out.status) || 502;
  // 본문이 없어야 하는 상태 코드는 body 를 넣으면 Response 생성이 실패한다
  const noBody = status === 204 || status === 205 || status === 304 || (status >= 100 && status < 200);
  return new Response(noBody ? null : Buffer.from(String(out.bodyBase64 ?? ""), "base64"), { status: noBody ? status : Math.min(Math.max(status, 200), 599), headers });
}
