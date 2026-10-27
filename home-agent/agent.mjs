// 바다자리 집 PC 중계 프로그램
// 집 PC(한국 가정용 인터넷)에서 실행해 두면, 서버가 막혀서 못 여는 예약처(더피싱 등)를 대신 열어 줍니다.
// 서버로 먼저 접속하는 방식이라 공유기 설정이 필요 없습니다. Node.js 18 이상이 필요합니다.
//
// 설정 (환경변수, start.bat 에 적어 둡니다)
//   SITE_URL          바다자리 주소 (예: https://fishing-booking.onrender.com)
//   HOME_AGENT_TOKEN  Render 환경변수 HOME_AGENT_TOKEN 과 같은 값
//   SITE_USER / SITE_PASSWORD   사이트 접속 아이디·비밀번호 (SITE_AUTH_USER / SITE_AUTH_PASSWORD 와 같은 값)

import dns from "node:dns/promises";
import net from "node:net";

const SITE = (process.env.SITE_URL ?? "").replace(/\/+$/, "");
const TOKEN = (process.env.HOME_AGENT_TOKEN ?? "").trim();
const USER = process.env.SITE_USER ?? "";
const PASS = process.env.SITE_PASSWORD ?? "";

if (!SITE || !TOKEN) {
  console.error("SITE_URL 과 HOME_AGENT_TOKEN 을 설정해 주세요 (start.bat 를 확인하세요).");
  process.exit(1);
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const ALLOWED = new Set(["accept", "content-type", "x-requested-with", "origin"]);
const ts = () => new Date().toLocaleTimeString("ko-KR", { hour12: false });
const log = (...a) => console.log(`[${ts()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const authHeaders = () => {
  const h = { "x-agent-token": TOKEN };
  if (USER || PASS) h.authorization = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
  return h;
};

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:");
}

// 집 안의 기기(공유기 등)를 열지 못하게 막는다
async function assertPublic(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("http/https 주소만 허용됩니다");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) throw new Error("내부 주소는 열 수 없습니다");
  if (process.env.HOME_AGENT_ALLOW_PRIVATE === "1") return; // 시험용
  if (net.isIP(host)) throw new Error("IP 주소는 열 수 없습니다");
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("내부 주소로 연결되는 사이트는 열 수 없습니다");
}

function parseCookieString(s) {
  const jar = new Map();
  for (const part of String(s ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return jar;
}
function mergeSetCookies(jar, setCookies) {
  for (const c of setCookies) {
    const first = c.split(";")[0];
    const i = first.indexOf("=");
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    if (value === "" || /max-age=0/i.test(c) || /expires=thu, 01[- ]jan[- ]1970/i.test(c)) jar.delete(name);
    else jar.set(name, value);
  }
}
const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

async function once(req, jar) {
  const u = new URL(String(req.url));
  await assertPublic(u);
  const method = String(req.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const headers = { "user-agent": UA, "accept-language": "ko-KR,ko;q=0.9" };
  for (const [k, v] of Object.entries(req.headers ?? {})) if (ALLOWED.has(k.toLowerCase())) headers[k.toLowerCase()] = String(v);
  if (req.referer) headers.referer = String(req.referer);
  const ck = cookieHeader(jar);
  if (ck) headers.cookie = ck;
  const timeout = Math.min(Math.max(Number(req.timeoutMs) || 20000, 3000), 25000);
  const t0 = Date.now();
  const res = await fetch(u, { method, headers, body: method === "POST" ? String(req.body ?? "") : undefined, redirect: "manual", signal: AbortSignal.timeout(timeout) });
  const body = Buffer.from(await res.arrayBuffer());
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  mergeSetCookies(jar, setCookies);
  return {
    status: res.status,
    location: res.headers.get("location") ?? "",
    contentType: res.headers.get("content-type") ?? "",
    setCookies,
    bodyBase64: body.toString("base64"),
    ms: Date.now() - t0,
  };
}

async function runOne(req, jar) {
  try {
    let cur = { ...req };
    for (let hop = 0; ; hop++) {
      const out = await once(cur, jar);
      // 조회용(follow)은 이동 응답을 따라간다. 예약용은 이동 응답을 그대로 돌려준다.
      if (req.follow && [301, 302, 303, 307, 308].includes(out.status) && out.location && hop < 5) {
        cur = { ...cur, url: new URL(out.location, cur.url).toString(), method: "GET", body: "", referer: cur.url };
        continue;
      }
      return out;
    }
  } catch (e) {
    const name = e?.name ?? "";
    const msg = name === "TimeoutError" || name === "AbortError" ? "시간 초과" : String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e);
    return { error: "upstream", message: msg.slice(0, 120) };
  }
}

async function handle(payload) {
  const jar = parseCookieString(payload.cookie);
  if (Array.isArray(payload.batch)) {
    const results = [];
    for (const item of payload.batch.slice(0, 4)) results.push(await runOne(item, jar));
    return { results };
  }
  return runOne(payload, jar);
}

async function postResult(id, result) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${SITE}/api/home-agent/result`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ id, result }),
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) return;
      log("결과 전송 실패: HTTP", r.status);
    } catch (e) {
      log("결과 전송 오류:", e?.message ?? e);
    }
    await sleep(1000);
  }
}

async function work(job) {
  const p = job.payload ?? {};
  const target = Array.isArray(p.batch) ? p.batch[0]?.url : p.url;
  let host = "";
  try {
    host = new URL(String(target)).hostname;
  } catch {}
  const t0 = Date.now();
  const result = await handle(p);
  const failed = result?.error || (result?.results ?? []).some((r) => r?.error);
  log(failed ? "실패" : "완료", host, `${Date.now() - t0}ms`, failed ? JSON.stringify(result?.error ? result.message : result.results.find((r) => r.error)?.message) : "");
  await postResult(job.id, result);
}

async function main() {
  log(`집 PC 중계 시작 → ${SITE}`);
  let fails = 0;
  let wasOk = false;
  for (;;) {
    try {
      const r = await fetch(`${SITE}/api/home-agent/poll`, { headers: authHeaders(), signal: AbortSignal.timeout(40000) });
      if (r.status === 401) {
        log("접속 거부(401): 토큰 또는 사이트 아이디/비밀번호가 맞지 않습니다. start.bat 를 확인하세요.");
        await sleep(15000);
        continue;
      }
      if (r.status === 404) {
        log("서버에서 집 PC 중계가 꺼져 있습니다 (Render 에 HOME_AGENT_TOKEN 을 넣었는지 확인).");
        await sleep(15000);
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { jobs = [] } = await r.json();
      if (!wasOk) log("서버에 연결되었습니다. 요청을 기다립니다.");
      wasOk = true;
      fails = 0;
      for (const job of jobs) work(job).catch((e) => log("작업 오류:", e?.message ?? e));
    } catch (e) {
      wasOk = false;
      fails++;
      if (fails === 1 || fails % 10 === 0) log("서버 접속 실패, 다시 시도합니다:", e?.message ?? e);
      await sleep(Math.min(3000 * fails, 15000));
    }
  }
}

main();
