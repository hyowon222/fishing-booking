"use strict";

/**
 * 서울 중계 함수 (Vercel)
 *
 * 바다자리 서버(Render, 미국)가 직접 열지 못하는 예약처 사이트를, 서울 지역에서 실행되는 이 함수가
 * 대신 열어 그대로 돌려준다. 자세한 설치 순서는 같은 폴더의 README.md를 보세요.
 *
 *   GET /api/relay?url=<열 주소>[&referer=<참조 주소>]      헤더 x-relay-token: <RELAY_TOKEN>
 *   GET /api/relay?token=<RELAY_TOKEN>&ping=1                지역(region) 확인용
 *
 * - RELAY_TOKEN 환경변수와 같은 토큰을 보낸 요청만 처리한다 (모르는 사람이 중계로 쓰지 못하게).
 * - 응답에는 항상 x-relay: 1 이 붙는다. 사이트가 돌려준 상태 코드·본문은 그대로 넘기고,
 *   이 함수 자체의 오류는 x-relay-error (auth | config | badurl | upstream) 헤더와 JSON {"error": "..."} 로 알린다.
 */

const crypto = require("node:crypto");

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const UPSTREAM_TIMEOUT_MS = 12_000;
// Vercel 함수 응답 한도(약 4.5MB)보다 작게 잡는다. 예약 페이지는 보통 수백 KB다.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// 내부망/로컬 주소를 대신 열어 주지 않는다. (URL 파서가 숫자 주소 표기를 먼저 표준형으로 바꿔 주므로
// "2130706433" 같은 변형도 여기서는 127.0.0.1로 보인다.) IPv6 주소 직접 입력은 아예 받지 않는다.
function isPrivateHost(hostname) {
  const host = String(hostname).toLowerCase();
  if (host.includes(":")) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (octets) {
    const a = Number(octets[1]);
    const b = Number(octets[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

// 길이가 달라도 같은 시간에 비교하도록, 먼저 해시한 뒤 비교한다.
function sameSecret(given, expected) {
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

const ERROR_LABELS = {
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

function describeUpstreamError(error) {
  if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `응답 시간 초과 ${UPSTREAM_TIMEOUT_MS / 1000}초`;
  }
  const cause = error && error.cause;
  const code =
    (cause && cause.code) ||
    (cause && Array.isArray(cause.errors) && cause.errors[0] && cause.errors[0].code) ||
    (error && error.code) ||
    "";
  return code ? `${ERROR_LABELS[code] || "연결 실패"} ${code}` : "연결 실패";
}

function createHandler(options = {}) {
  const allowPrivate = Boolean(options.allowPrivate);
  const getToken = options.getToken || (() => process.env.RELAY_TOKEN);
  const fetchImpl = options.fetch || fetch;

  return async function handler(req, res) {
    const region = process.env.VERCEL_REGION || "";
    const base = () => {
      res.setHeader("x-relay", "1");
      res.setHeader("cache-control", "no-store");
      if (region) res.setHeader("x-relay-region", region);
    };
    const fail = (status, code, message) => {
      base();
      res.statusCode = status;
      res.setHeader("x-relay-error", code);
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: message }));
    };

    const expected = getToken();
    if (!expected) return fail(500, "config", "RELAY_TOKEN이 설정되지 않았어요");

    const requestUrl = new URL(req.url || "/", "http://relay.local");
    const given = req.headers["x-relay-token"] || requestUrl.searchParams.get("token") || "";
    if (!sameSecret(given, expected)) return fail(401, "auth", "토큰이 맞지 않아요");

    if (requestUrl.searchParams.get("ping")) {
      base();
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ ok: true, region: region || "알 수 없음" }));
    }

    if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "badurl", "GET 요청만 받아요");

    let target;
    try {
      target = new URL(requestUrl.searchParams.get("url") || "");
    } catch {
      return fail(400, "badurl", "url 값이 올바른 주소가 아니에요");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return fail(400, "badurl", "http 또는 https 주소만 열 수 있어요");
    }
    if (!allowPrivate && isPrivateHost(target.hostname)) return fail(400, "badurl", "내부 주소는 열 수 없어요");

    let referer = `${target.origin}/`;
    try {
      const given = new URL(requestUrl.searchParams.get("referer") || "");
      if (given.protocol === "http:" || given.protocol === "https:") referer = given.toString();
    } catch {
      // 참조 주소가 없거나 이상하면 사이트 첫 화면 주소를 쓴다.
    }

    let upstream;
    try {
      upstream = await fetchImpl(target, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
          Referer: referer,
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      return fail(502, "upstream", describeUpstreamError(error));
    }

    let body;
    try {
      body = Buffer.from(await upstream.arrayBuffer());
    } catch (error) {
      return fail(502, "upstream", `응답을 끝까지 받지 못함 ${describeUpstreamError(error)}`);
    }
    if (body.length > MAX_BODY_BYTES) return fail(502, "upstream", "응답이 너무 커요");

    base();
    res.statusCode = upstream.status;
    res.setHeader("content-type", upstream.headers.get("content-type") || "text/html; charset=utf-8");
    // 브라우저 주소창으로 시험해 볼 때 사이트의 스크립트가 이 주소 안에서 실행되지 않게 막는다.
    res.setHeader("content-security-policy", "sandbox");
    res.setHeader("x-content-type-options", "nosniff");
    return res.end(req.method === "HEAD" ? undefined : body);
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.isPrivateHost = isPrivateHost;
