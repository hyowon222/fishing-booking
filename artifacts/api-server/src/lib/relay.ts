import { logger } from "./logger";

/**
 * 서울 중계 (선택 기능)
 *
 * 일부 예약처 사이트는 해외·클라우드 서버(Render는 미국)의 접속을 막아 두어서, 한국에서는 열리는데
 * 이 서버에서는 "연결 시간 초과"가 난다. 한국(서울)에서 실행되는 작은 중계 함수(저장소의 seoul-relay/ 폴더,
 * Vercel에 올린다)가 대신 사이트를 열어 주면 해결되는 경우가 많다.
 *
 * 아래 환경변수가 둘 다 있을 때만 켜지고, 없으면 예전과 똑같이 동작한다.
 *   FISHING_RELAY_URL    중계 함수 주소 (예: https://내프로젝트.vercel.app/api/relay)
 *   FISHING_RELAY_TOKEN  중계 함수에 넣어 둔 RELAY_TOKEN과 같은 값
 *   FISHING_RELAY_HOSTS  (선택) 처음부터 중계로만 조회할 사이트 주소들 (쉼표로 구분, 예: fishingi.net)
 *
 * 켜져 있어도 평소에는 직접 연결을 먼저 시도한다. 직접 연결 자체가 안 될 때(시간 초과·거부·끊김)와
 * 403일 때만 중계로 한 번 더 시도하고, 중계로 성공한 사이트는 6시간 동안 곧바로 중계로 조회한다.
 */

export const RELAY_TIMEOUT_MS = 20_000;
export const RELAY_LEARN_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 중계 서버 쪽 문제를 뜻한다 (주소·토큰이 틀림, 중계 서버 오류, 중계에서도 사이트를 못 엶).
 * 문구는 그대로 화면에 보여 줄 수 있는 짧은 한국어다. 괄호는 쓰지 않는다("예약처이름(이유)" 형태로 붙여 보여 주기 때문).
 */
export class RelayError extends Error {
  /** 중계에서도 사이트에 닿지 못한 경우 true: 사이트가 한국 IP까지 막고 있을 가능성을 뜻한다. */
  readonly upstream: boolean;

  constructor(message: string, upstream = false) {
    super(message);
    this.name = "RelayError";
    this.upstream = upstream;
  }
}

/** "http://www.FishingI.net:80/index.php" → "fishingi.net". 비교용으로만 쓴다. */
export function normalizeHost(value: string): string {
  const withoutScheme = value.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const host = (withoutScheme.split(/[/?#]/)[0] ?? "").replace(/:\d+$/, "");
  return host.replace(/^www\./, "");
}

export type RelaySettings = {
  endpoint: URL;
  token: string;
  forcedHosts: string[];
};

export function readRelaySettings(env: Record<string, string | undefined> = process.env): RelaySettings | null {
  const rawUrl = env.FISHING_RELAY_URL?.replace(/[^\x21-\x7E]/g, "").match(/https?:\/\/[^\s"'<>\)\]]+/)?.[0];
  const token = env.FISHING_RELAY_TOKEN?.trim();
  if (!rawUrl && !token) return null;
  if (!rawUrl || !token) {
    logger.warn("[서울 중계] FISHING_RELAY_URL과 FISHING_RELAY_TOKEN을 둘 다 넣어야 켜집니다. 지금은 꺼져 있습니다.");
    return null;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(rawUrl);
  } catch {
    logger.warn("[서울 중계] FISHING_RELAY_URL 주소 형식이 올바르지 않습니다. 지금은 꺼져 있습니다.");
    return null;
  }
  // 토큰이 평문으로 오가지 않도록 https만 받는다 (내 컴퓨터에서 시험할 때의 localhost만 예외).
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    logger.warn("[서울 중계] FISHING_RELAY_URL은 https:// 로 시작해야 합니다. 지금은 꺼져 있습니다.");
    return null;
  }
  const forcedHosts = (env.FISHING_RELAY_HOSTS ?? "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .split(/[\s,]+/)
    .map(normalizeHost)
    .filter(Boolean);
  return { endpoint, token, forcedHosts };
}

const CONNECT_FAILURE_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNREFUSED",
  "ECONNRESET",
  "UND_ERR_SOCKET",
]);

function collectErrorCodes(error: unknown, out: string[], depth = 0): void {
  if (!error || typeof error !== "object" || depth > 4) return;
  const candidate = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof candidate.code === "string") out.push(candidate.code);
  collectErrorCodes(candidate.cause, out, depth + 1);
  // 주소가 여러 개일 때 Node는 AggregateError(.errors)로 주소별 실패를 묶어서 던진다.
  if (Array.isArray(candidate.errors)) {
    for (const inner of candidate.errors) collectErrorCodes(inner, out, depth + 1);
  }
}

/**
 * 사이트에 "연결 자체가 안 된" 실패인지 가린다 (시간 초과·거부·끊김·닿지 못함).
 * 주소를 못 찾은 경우(DNS)나 응답이 늦은 경우는 중계로 해결될 문제가 아닐 가능성이 커서 뺀다.
 */
export function isConnectFailure(error: unknown): boolean {
  const codes: string[] = [];
  collectErrorCodes(error, codes);
  return codes.some((code) => CONNECT_FAILURE_CODES.has(code));
}

function describeTransportFailure(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "응답 시간 초과";
  const codes: string[] = [];
  collectErrorCodes(error, codes);
  return codes[0] ?? "연결 실패";
}

export class Relay {
  private readonly learned = new Map<string, number>();
  private readonly forced: Set<string>;

  constructor(
    readonly settings: RelaySettings,
    private readonly now: () => number = Date.now,
  ) {
    this.forced = new Set(settings.forcedHosts);
  }

  /** FISHING_RELAY_HOSTS에 직접 적어 둔 사이트인가. */
  isForced(hostname: string): boolean {
    return this.forced.has(normalizeHost(hostname));
  }

  /** 직접 연결을 건너뛰고 처음부터 중계로 보낼 사이트인가 (직접 지정했거나, 최근 중계로만 성공한 사이트). */
  prefers(hostname: string): boolean {
    const host = normalizeHost(hostname);
    if (this.forced.has(host)) return true;
    const until = this.learned.get(host);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.learned.delete(host);
      return false;
    }
    return true;
  }

  /** 직접 연결은 안 됐는데 중계로는 성공한 사이트를 기억한다. */
  learn(hostname: string, why: string): void {
    const host = normalizeHost(hostname);
    if (this.forced.has(host)) return;
    const wasKnown = (this.learned.get(host) ?? 0) > this.now();
    this.learned.set(host, this.now() + RELAY_LEARN_TTL_MS);
    if (!wasKnown) {
      logger.info(
        { host, why },
        `[서울 중계] ${host}: 직접 연결이 안 되어(${why}) 서울 중계로 불러왔습니다. 앞으로 6시간 동안은 중계로 먼저 조회합니다.`,
      );
    }
  }

  forget(hostname: string): void {
    this.learned.delete(normalizeHost(hostname));
  }

  /** /api/fishing/diagnostics 에 보여 줄 현황. 주소와 토큰은 넣지 않는다. */
  snapshot() {
    const now = this.now();
    return {
      configured: true as const,
      forcedHosts: [...this.forced],
      learnedHosts: [...this.learned]
        .filter(([, until]) => until > now)
        .map(([host, until]) => ({ host, minutesLeft: Math.ceil((until - now) / 60_000) })),
    };
  }

  /**
   * 중계 함수를 통해 사이트 페이지를 받아 온다. 사이트가 돌려준 응답은 상태 코드까지 그대로 돌려주고
   * (403이든 404든 직접 받았을 때와 같은 방식으로 처리된다), 중계 자체의 문제는 RelayError로 던진다.
   */
  async fetch(target: URL, referer: string, timeoutMs: number = RELAY_TIMEOUT_MS): Promise<Response> {
    const endpoint = new URL(this.settings.endpoint);
    endpoint.searchParams.set("url", target.toString());
    endpoint.searchParams.set("referer", referer);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        headers: { "x-relay-token": this.settings.token },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RelayError(`중계 서버에 연결하지 못함 ${describeTransportFailure(error)}`);
    }

    // 우리 중계 함수의 응답에는 항상 x-relay: 1 이 붙는다. 없으면 주소가 틀렸거나 Vercel이 대신 답한 것이다.
    if (response.headers.get("x-relay") !== "1") {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) {
        throw new RelayError(`중계 서버가 접근을 막음 HTTP ${response.status}`);
      }
      if (response.status === 404) throw new RelayError("중계 서버 주소가 맞지 않음 HTTP 404");
      throw new RelayError(`중계 서버 응답이 이상함 HTTP ${response.status}`);
    }

    const relayError = response.headers.get("x-relay-error");
    if (relayError) {
      let reason = "";
      try {
        const parsed = JSON.parse(await response.text()) as { error?: unknown };
        if (typeof parsed.error === "string") reason = parsed.error.replace(/[()]/g, "").slice(0, 60);
      } catch {
        // 사유 없이 코드만으로 알린다.
      }
      if (relayError === "auth") throw new RelayError("중계 서버 토큰이 맞지 않음");
      if (relayError === "config") throw new RelayError("중계 서버에 RELAY_TOKEN이 설정되지 않음");
      if (relayError === "badurl") throw new RelayError(`중계 서버가 주소를 거부함 ${reason}`.trim());
      if (relayError === "upstream") throw new RelayError(`서울 중계로도 못 열림: ${reason || "응답 없음"}`, true);
      throw new RelayError(`중계 서버 오류 ${relayError}`);
    }
    return response;
  }
}

let cachedRelay: Relay | null | undefined;

/** 환경변수로 켜진 중계가 있으면 돌려주고, 없으면 null. 처음 한 번만 읽는다. */
export function getRelay(): Relay | null {
  if (cachedRelay === undefined) {
    const settings = readRelaySettings();
    cachedRelay = settings ? new Relay(settings) : null;
    if (cachedRelay) {
      logger.info(
        { forcedHosts: settings?.forcedHosts ?? [] },
        "[서울 중계] 켜졌습니다. 직접 연결이 안 되는 예약처만 서울 중계로 다시 시도합니다.",
      );
    }
  }
  return cachedRelay;
}

/** 테스트용: 환경변수를 바꾼 뒤 다시 읽게 한다. */
export function resetRelayForTests(): void {
  cachedRelay = undefined;
}
