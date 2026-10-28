// booking.ts — 선상낚시 자동 예약 엔진 (브라우저 없이 HTTP 요청만 사용)
// 대상: reservation_boat_v5.2_seat1 방식 예약 사이트 (예: mscufishing.com)
//
// ★ 기본은 "테스트 모드(dry-run)"입니다. 좌석·인원·폼 값을 실제 사이트 응답으로 모두 만들고,
//   "이 내용으로 제출할 것"이라는 payload 만 결과로 돌려줍니다.
//   cfg.submit 이 true 일 때만(화면에서 "실제 제출"을 골랐을 때) 최종 제출을 합니다.
//   제출 요청은 작업당 딱 한 번만 보내고, 응답을 못 받아도 자동으로 다시 보내지 않습니다 (중복 예약 방지).
//
// 닷홈 중계기(relay2.php)를 쓰려면 환경변수:
//   BOOKING_RELAY_URL   예) http://hyowon222.dothome.co.kr/relay2.php
//   BOOKING_RELAY_TOKEN relay2.php 의 RELAY_TOKEN 과 같은 값
// 둘 다 없으면 서버에서 직접 요청합니다. (개발·시험용)

import crypto from "node:crypto";
import { homeAgentOnline, homeCall, homePrefers } from "./home-agent";
import { normalizeHost } from "./relay";

// ------------------------------------------------------------------ 타입
export type ShipWish = { name: string; uid?: string; preferredSeats?: number[] };

export type BookingConfig = {
  baseUrl: string; // 예: http://www.mscufishing.com
  date: string; // YYYYMMDD
  ships: ShipWish[]; // 우선순위 순서
  people: number;
  seatMode: "auto" | "none"; // auto: 지정 좌석 → 선미 우선 / none: 좌석 선택 안 함
  preferredSeats?: number[];
  sternSide?: "right" | "left";
  name: string;
  phone: string; // 010-1234-5678 또는 숫자만
  openAt?: string; // ISO 시각 (예: 2026-11-01T10:00:00+09:00). 없으면 바로 시작
  warmupSeconds?: number;
  pollMs?: number;
  maxPollMinutes?: number;
  seedUids?: string[]; // 배 목록을 열기 위한 "아무 배 번호"
  kind?: "thefishing" | "sunsang24"; // 예약처 종류
  groupId?: string; // 여러 날짜를 한 번에 시작했을 때 같은 값
  stopOthersOnSuccess?: boolean; // 하나 준비되면 같은 묶음의 나머지 작업을 중지
  submit?: boolean; // true: 자리를 잡으면 실제로 제출 / 아니면 테스트 모드(제출 안 함)
};

export type JobStatus = "waiting" | "polling" | "submitting" | "done" | "failed" | "stopped";

// 실제 제출 결과. unknown 은 "보냈는데 접수 여부를 알 수 없음" (사이트에서 직접 확인 필요)
export type SubmitOutcome = {
  state: "success" | "failed" | "unknown";
  message: string;
  reservationNo?: string;
  httpStatus?: number;
  at: number;
};

export type BookingResult = {
  ship: { uid: string; name: string };
  species: string;
  people: number;
  seats: number[];
  seatNote: string;
  status: string; // 사이트가 알려준 인원 상태 ("확인" 등)
  price: string;
  actionUrl: string;
  payload: string; // 제출 시 보낼 폼 본문 (이름·전화번호 포함)
  unresolved: string[]; // 값이 정해지지 않은 라디오 그룹 등
  dryRun: boolean; // 제출하지 않았으면 true
  referer?: string; // 제출 때 Referer 로 보낼, 폼이 있던 화면 주소
  deposit?: string; // 입금 안내 (선상24: 예약 화면 기준 예상)
  submit?: SubmitOutcome; // 실제 제출을 했다면 그 결과
};

export type Job = {
  id: string;
  createdAt: number;
  status: JobStatus;
  summary: string;
  groupId?: string;
  log: string[];
  result?: BookingResult;
  error?: string;
  stopRequested: boolean;
};

export const SPECIES_WORDS = ["쭈꾸미", "주꾸미", "갑오징어", "쭈갑"];
const MODULE = "/_core/module/reservation_boat_v5.2_seat1";
const KNOWN_SEEDS = ["2955", "4443", "2954", "5866", "5579", "3570", "2961", "2956", "2950", "6407", "5578", "4920", "5679", "5891", "3571"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// fetch 실패의 진짜 원인(DNS·연결 거부·시간 초과 등)을 문구에 포함
async function fetchWhy(label: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e: any) {
    const c = e?.cause;
    const why = [c?.code, c?.message ?? e?.message].filter(Boolean).join(" ");
    throw new Error(`${label} 연결 실패 (${new URL(url).host}): ${why}`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 조회 간격. 오픈(openAt, 없으면 조회를 시작한 때) 직후 30초는 설정한 간격(기본 0.7초)으로 빠르게,
// 그 뒤 3분까지는 2초, 그 이후는 5초로 늘린다. 오픈 순간이 지나도 열리지 않는 배를 계속 0.7초마다 두드려
// 예약처에 부담을 주거나 막히는 일을 줄이기 위해서다 (이미 지나간 시각으로 시작해도 시작한 때부터 30초는 빠르게).
export function pollDelayFor(baseMs: number, sinceMs: number, nowMs: number): number {
  const elapsed = nowMs - sinceMs;
  if (elapsed < 30_000) return baseMs;
  if (elapsed < 180_000) return Math.max(baseMs, 2000);
  return Math.max(baseMs, 5000);
}

function makePoller(cfg: BookingConfig, log: (m: string) => void): () => number {
  const since = Math.max(cfg.openAt ? new Date(cfg.openAt).getTime() : 0, Date.now());
  let phase = 0;
  return () => {
    const delay = pollDelayFor(cfg.pollMs!, since, Date.now());
    const now = delay <= cfg.pollMs! ? 0 : delay <= 2000 ? 1 : 2;
    if (now > phase) {
      phase = now;
      log(`아직 열리지 않아 조회 간격을 ${delay / 1000}초로 늘립니다 (예약처 부담을 줄이기 위해).`);
    }
    return delay;
  };
}

// ------------------------------------------------------------------ 전송 (중계기 암호화 + 쿠키 + 리다이렉트)
type RawResponse = { status: number; location: string; contentType: string; setCookies: string[]; body: Buffer; upMs?: number; dnsMs?: number; srvMs?: number };

const relayEnabled = () => Boolean(process.env.BOOKING_RELAY_URL && process.env.BOOKING_RELAY_TOKEN);

// 집 PC 중계: 연결되어 있으면 (HOME_AGENT_HOSTS 를 정했다면 그 사이트만) 닷홈 중계기 대신 집 PC로 요청을 보낸다.
// 닷홈·서버 직접 연결이 막힌 사이트(더피싱 등)를 한국 가정용 인터넷으로 여는 용도다. 끊겨 있으면 예전 방식으로 돌아간다.
const viaHome = (url: string): boolean => {
  if (!homeAgentOnline()) return false;
  const only = (process.env.HOME_AGENT_HOSTS ?? "").split(",").map((v) => normalizeHost(v)).filter(Boolean);
  if (!only.length) return true;
  try {
    const host = normalizeHost(new URL(url).hostname);
    return only.some((h) => host === h) || homePrefers(host);
  } catch {
    return false;
  }
};

async function homeExchange(payload: Record<string, unknown>, timeoutMs: number): Promise<any> {
  const out = await homeCall(payload, timeoutMs);
  if (out?.error) throw new Error(`중계기 오류(${out.error}): ${out.message ?? ""}`);
  return out;
}

// 중계기와 암호화 통신 (AES-256-GCM). payload 에는 단일 요청 또는 batch 가 들어갑니다.
async function relayExchange(payload: Record<string, unknown>): Promise<any> {
  const relayUrl = process.env.BOOKING_RELAY_URL as string;
  const token = process.env.BOOKING_RELAY_TOKEN as string;
  const key = crypto.createHash("sha256").update(token).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plain = JSON.stringify({ ts: Math.floor(Date.now() / 1000), ...payload });
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  const res = await fetchWhy("중계기", relayUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const errCode = res.headers.get("x-relay-error");
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`중계기 응답을 읽지 못했습니다 (HTTP ${res.status}). 주소·업로드를 확인하세요.`);
  }
  if (errCode) throw new Error(`중계기 오류(${errCode}): ${j?.error ?? ""}`);
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(j.iv, "base64"));
  d.setAuthTag(Buffer.from(j.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(j.ct, "base64")), d.final()]).toString("utf8"));
}

const toRaw = (p: any): RawResponse => ({
  status: p.status,
  location: p.location ?? "",
  contentType: p.contentType ?? "",
  setCookies: p.setCookies ?? [],
  body: Buffer.from(p.bodyBase64 ?? "", "base64"),
  upMs: typeof p.ms === "number" ? p.ms : undefined,
  dnsMs: typeof p.dns === "number" ? p.dns : undefined,
  srvMs: typeof p.srv === "number" ? p.srv : undefined,
});

async function relayCall(
  url: string,
  method: "GET" | "POST",
  opts: { body?: string; headers?: Record<string, string>; referer?: string; cookie?: string },
): Promise<RawResponse> {
  if (viaHome(url)) {
    return toRaw(await homeExchange({ url, method, headers: opts.headers ?? {}, body: opts.body ?? "", referer: opts.referer ?? "", cookie: opts.cookie ?? "" }, 45_000));
  }
  if (relayEnabled()) {
    const p = await relayExchange({ url, method, headers: opts.headers ?? {}, body: opts.body ?? "", referer: opts.referer ?? "", cookie: opts.cookie ?? "" });
    return toRaw(p);
  }
  // 직접 요청 (중계기 미설정)
  const headers: Record<string, string> = { "user-agent": UA, "accept-language": "ko-KR,ko;q=0.9", ...(opts.headers ?? {}) };
  if (opts.referer) headers.referer = opts.referer;
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await fetchWhy("예약처 직접", url, { method, headers, body: method === "POST" ? opts.body ?? "" : undefined, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  return {
    status: res.status,
    location: res.headers.get("location") ?? "",
    contentType: res.headers.get("content-type") ?? "",
    setCookies: (res.headers as any).getSetCookie?.() ?? [],
    body: Buffer.from(await res.arrayBuffer()),
  };
}

function decodeBody(r: RawResponse): string {
  const ct = /charset=([\w-]+)/i.exec(r.contentType)?.[1];
  const head = r.body.subarray(0, 2000).toString("latin1");
  const meta = /charset=["']?([\w-]+)/i.exec(head)?.[1];
  const label = (ct ?? meta ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(label === "ks_c_5601-1987" ? "euc-kr" : label).decode(r.body);
  } catch {
    return r.body.toString("utf8");
  }
}

// 사이트가 알려 준 정식 주소(http→https, www 유무)를 기억해 두면 다음 작업부터는 이동 없이 바로 간다
const canonicalOrigin = new Map<string, string>();

export class Session {
  private jar = new Map<string, string>();
  base: string;
  onSlow?: (m: string) => void; // 느린 요청(1초 이상)만 기록해서 어디서 시간이 걸리는지 보여준다
  constructor(base: string) {
    this.base = canonicalOrigin.get(base) ?? base;
  }

  private cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  private store(setCookies: string[]) {
    for (const sc of setCookies) {
      const [pair] = sc.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async request(method: "GET" | "POST", path: string, opts: { body?: string; ajax?: boolean; referer?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; text: string; url: string }> {
    let url = path.startsWith("http") ? path : this.base + path;
    let m = method;
    let body = opts.body;
    for (let hop = 0; hop < 5; hop++) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (m === "POST") headers["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      if (opts.ajax) headers["x-requested-with"] = "XMLHttpRequest";
      const t1 = Date.now();
      const r = await relayCall(url, m, { body, headers, referer: opts.referer ?? this.base + "/", cookie: this.cookieHeader() });
      this.noteSlow(m, url, r, Date.now() - t1);
      this.store(r.setCookies);
      if ([301, 302, 303, 307, 308].includes(r.status) && r.location) {
        const next = new URL(r.location, url);
        const cur = new URL(url);
        // 주소만 http→https·www 로 바뀌는 이동(경로 그대로)이면 POST 와 본문을 그대로 유지한다. 그 밖의 이동은 브라우저처럼 GET 으로.
        const sameTarget = next.pathname === cur.pathname && next.search === cur.search;
        url = next.toString();
        if (r.status !== 307 && r.status !== 308 && !(m === "POST" && sameTarget)) {
          m = "GET";
          body = undefined;
        }
        continue;
      }
      this.adoptOrigin(url);
      return { status: r.status, text: decodeBody(r), url };
    }
    throw new Error("이동(리다이렉트)이 너무 많습니다");
  }

  private noteSlow(m: string, url: string, r: RawResponse, ms: number) {
    if (ms < 1000 || !this.onSlow) return;
    let p = url;
    try {
      const u = new URL(url);
      p = u.pathname.split("/").slice(-1)[0] || u.pathname;
    } catch {
      /* 무시 */
    }
    this.onSlow(`느린 요청: ${m} ${p} → 전체 ${ms}ms${r.upMs !== undefined ? ` (예약처 응답 ${r.upMs}ms${r.dnsMs ? `, 주소확인 ${r.dnsMs}ms` : ""}${r.srvMs !== undefined ? `, 닷홈 처리 ${r.srvMs}ms → 서버↔닷홈 구간 ${ms - r.srvMs}ms` : ""})` : ""} [${r.status}]`);
  }

  // 사이트가 http→https, 또는 www 붙은 주소로 보내면 이후 요청은 처음부터 그 주소로 보내 이동 왕복을 없앤다
  private adoptOrigin(finalUrl: string) {
    try {
      const f = new URL(finalUrl);
      const b = new URL(this.base);
      const root = (h: string) => h.replace(/^www\./, "");
      if (f.origin !== b.origin && root(f.hostname) === root(b.hostname)) {
        canonicalOrigin.set(b.origin, f.origin);
        this.base = f.origin;
      }
    } catch {
      /* 무시 */
    }
  }

  // 여러 요청을 한 번의 중계 왕복으로 처리 (이동·오류가 섞이면 호출한 쪽에서 일반 방식으로 다시 시도)
  async batch(items: { method: "GET" | "POST"; path: string; body?: string; ajax?: boolean }[]): Promise<{ status: number; text: string }[]> {
    const reqs = items.map((it) => {
      const headers: Record<string, string> = {};
      if (it.method === "POST") headers["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      if (it.ajax) headers["x-requested-with"] = "XMLHttpRequest";
      return { url: it.path.startsWith("http") ? it.path : this.base + it.path, method: it.method, headers, body: it.body ?? "", referer: this.base + "/" };
    });
    let raws: RawResponse[];
    const tb = Date.now();
    if (reqs[0] && viaHome(reqs[0].url)) {
      const out = await homeExchange({ batch: reqs, cookie: this.cookieHeader() }, 60_000);
      raws = (out.results as any[]).map((p) => {
        if (p.error) throw new Error(`중계기 오류(${p.error}): ${p.message ?? ""}`);
        return toRaw(p);
      });
    } else if (relayEnabled()) {
      const out = await relayExchange({ batch: reqs, cookie: this.cookieHeader() });
      raws = (out.results as any[]).map((p) => {
        if (p.error) throw new Error(`중계기 오류(${p.error}): ${p.message ?? ""}`);
        return toRaw(p);
      });
    } else {
      raws = await Promise.all(reqs.map((r) => relayCall(r.url, r.method, { body: r.body, headers: r.headers, referer: r.referer, cookie: this.cookieHeader() })));
    }
    if (this.onSlow && Date.now() - tb >= 1000) this.onSlow(`느린 묶음 요청: ${items.length}건 → 전체 ${Date.now() - tb}ms (예약처 응답 ${raws.map((r) => r.upMs ?? "?").join("/")}ms, 닷홈 처리 ${raws.map((r) => r.srvMs ?? "?").join("/")}ms)`);
    const isMove = (r: RawResponse) => [301, 302, 303, 307, 308].includes(r.status);
    for (const r of raws) this.store(r.setCookies);
    // 이동 응답은 따라가서 완성하고, 그 사이트의 올바른 주소(https·www)를 기억해 다음부터는 바로 간다
    return Promise.all(
      raws.map(async (r, i) => {
        if (!isMove(r)) return { status: r.status, text: decodeBody(r) };
        const it = items[i];
        // 이동 응답이 알려 준 주소에서 이어서 진행 (처음부터 다시 보내면 같은 이동을 한 번 더 겪는다)
        const from = new URL(reqs[i].url);
        const to = r.location ? new URL(r.location, from) : from;
        const sameTarget = to.pathname === from.pathname && to.search === from.search;
        const keep = it.method === "GET" || r.status === 307 || r.status === 308 || sameTarget;
        this.adoptOrigin(to.toString());
        const res = await this.request(keep ? it.method : "GET", to.toString(), { body: keep ? it.body : undefined, ajax: it.ajax });
        return { status: res.status, text: res.text };
      }),
    );
  }
}

// ------------------------------------------------------------------ HTML 해석
const stripTags = (s: string) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&middot;|&#183;/g, "·")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
};

export type Choice = { value: string; label: string };

export function parseRadios(html: string, name: string): Choice[] {
  const out: Choice[] = [];
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (attr(tag, "type")?.toLowerCase() !== "radio" || attr(tag, "name") !== name) continue;
    const id = attr(tag, "id");
    let label = "";
    if (id) {
      const lm = new RegExp(`<label[^>]*\\sfor\\s*=\\s*["']?${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?[^>]*>([\\s\\S]*?)</label>`, "i").exec(html);
      if (lm) label = stripTags(lm[1]);
    }
    out.push({ value: attr(tag, "value") ?? "", label });
  }
  return out;
}

export type SeatCell = { seat: number; section: "back" | "side" | "head"; side: "r" | "l" | ""; index: number; count: number; available: boolean };

export function parseSeats(html: string): SeatCell[] {
  const marks = [...html.matchAll(/<div class="(res_ship_seat_(?:head|side|back)[^"]*)">/g)];
  const cells: SeatCell[] = [];
  marks.forEach((m, i) => {
    const cls = m[1];
    const section = cls.includes("res_ship_seat_back") ? "back" : cls.includes("res_ship_seat_side") ? "side" : "head";
    const side = /_r(\s|$)/.test(cls) ? "r" : /_l(\s|$)/.test(cls) ? "l" : "";
    const start = m.index! + m[0].length;
    let end = i + 1 < marks.length ? marks[i + 1].index! : html.length;
    const notice = html.indexOf("res_ship_seat_notice", start);
    if (notice > 0 && notice < end) end = notice;
    const chunk = html.slice(start, end);
    const found: { seat: number; available: boolean }[] = [];
    for (const sm of chunk.matchAll(/<span([^>]*)>\s*(\d+)\s*<\/span>/g)) {
      const cl = (attr(sm[1], "class") ?? "").split(/\s+/);
      if (!cl.some((c) => c.startsWith("res_num_view"))) continue;
      found.push({ seat: Number(sm[2]), available: cl.includes("res_num_view") });
    }
    found.forEach((f, idx) => cells.push({ ...f, section, side, index: idx, count: found.length }));
  });
  return cells;
}

// 선미에 가까운 순서. 선미 구역 → 현(좌/우)의 뒤쪽부터 → 선수 순. 같은 거리면 sternSide 쪽 먼저.
export function sternOrder(cells: SeatCell[], sternSide: "right" | "left" = "right"): number[] {
  const first = sternSide === "right" ? "r" : "l";
  const key = (c: SeatCell): [number, number, number] => {
    const tie = c.side === first ? 0 : 1;
    if (c.section === "back") return [0, c.index, tie];
    if (c.section === "side") return [1, c.count - 1 - c.index, tie];
    return [2, c.index, tie];
  };
  return [...cells]
    .sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
    })
    .map((c) => c.seat);
}

export function chooseSeats(available: Set<number>, n: number, preferred: number[], order: number[]): number[] {
  const chosen: number[] = [];
  const take = (s: number) => {
    if (available.has(s) && !chosen.includes(s) && chosen.length < n) chosen.push(s);
  };
  preferred.forEach(take);
  order.forEach(take);
  [...available].sort((a, b) => a - b).forEach(take);
  return chosen;
}

// ---- 붙어 앉기: 인원수만큼 나란히(같은 줄에서 번호가 이어지는) 또는 마주 보는(선미 끝에서 같은 거리의) 자리를 먼저 찾는다.
// 선미에 더 가까운 쪽 우선, 같은 거리면 나란히 앉는 쪽 → 선미 같은 줄이면 sternSide 쪽 순서.
export type SeatPos = { seat: number; line: string; idx: number; dist: number; tag: "r" | "l" | "" };
const FACING: [string, string][] = [["side:r", "side:l"], ["B", "A"]];

export function layoutFromCells(cells: SeatCell[]): SeatPos[] {
  return cells.map((c) => ({
    seat: c.seat,
    line: `${c.section}:${c.side}`,
    idx: c.index,
    dist: c.section === "back" ? c.index * 0.01 : c.section === "side" ? 1 + (c.count - 1 - c.index) : 1000 + c.index,
    tag: c.side,
  }));
}

// 선상24 좌석: 1..N/2 가 한 줄(A), N/2+1..N 이 반대 줄(B). 선미 끝은 N/2 와 N/2+1.
export function layoutSunsang(seats: number[], total: number): SeatPos[] {
  const half = Math.ceil(total / 2);
  return seats.map((s) => (s <= half ? { seat: s, line: "A", idx: s, dist: half - s, tag: "l" as const } : { seat: s, line: "B", idx: s, dist: s - half - 1, tag: "r" as const }));
}

export function chooseGrouped(layout: SeatPos[], free: Set<number>, n: number, sternSide: "right" | "left"): number[] | null {
  if (n < 2) return null;
  const av = layout.filter((p) => free.has(p.seat));
  const want = sternSide === "right" ? "r" : "l";
  type Cand = { seats: number[]; maxDist: number; kind: number; tie: number; sum: number };
  const cands: Cand[] = [];
  const byLine = new Map<string, SeatPos[]>();
  for (const p of av) {
    const l = byLine.get(p.line) ?? [];
    l.push(p);
    byLine.set(p.line, l);
  }
  for (const list of byLine.values()) {
    list.sort((a, b) => a.idx - b.idx);
    for (let i = 0; i + n <= list.length; i++) {
      const w = list.slice(i, i + n);
      if (w[n - 1].idx - w[0].idx !== n - 1) continue;
      cands.push({ seats: w.map((x) => x.seat), maxDist: Math.max(...w.map((x) => x.dist)), kind: 0, tie: w[0].tag === want ? 0 : 1, sum: w.reduce((a, x) => a + x.dist, 0) });
    }
  }
  if (n % 2 === 0) {
    const k = n / 2;
    for (const [xa, ya] of FACING) {
      const xs = byLine.get(xa) ?? [];
      const ys = byLine.get(ya) ?? [];
      const pairs: { x: SeatPos; y: SeatPos }[] = [];
      for (const x of xs) {
        const y = ys.find((q) => Math.abs(q.dist - x.dist) < 1e-9);
        if (y) pairs.push({ x, y });
      }
      pairs.sort((a, b) => a.x.dist - b.x.dist);
      for (let i = 0; i + k <= pairs.length; i++) {
        const w = pairs.slice(i, i + k);
        let ok = true;
        for (let j = 1; j < k; j++) if (Math.abs(w[j].x.idx - w[j - 1].x.idx) !== 1 || Math.abs(w[j].y.idx - w[j - 1].y.idx) !== 1) ok = false;
        if (!ok) continue;
        const all = w.flatMap((q) => [q.x, q.y]);
        cands.push({ seats: all.map((q) => q.seat), maxDist: Math.max(...all.map((q) => q.dist)), kind: 1, tie: 0, sum: all.reduce((a, q) => a + q.dist, 0) });
      }
    }
  }
  cands.sort((a, b) => a.maxDist - b.maxDist || a.kind - b.kind || a.tie - b.tie || a.sum - b.sum);
  return cands[0]?.seats ?? null;
}

// 지정 좌석이 없으면 붙어 앉는 자리를 먼저, 없으면 예전처럼 선미에 가까운 순서로 한 자리씩.
export function pickSeats(layout: SeatPos[], free: Set<number>, n: number, preferred: number[], order: number[], sternSide: "right" | "left"): { seats: number[]; grouped: boolean } {
  const hasPref = preferred.some((s) => free.has(s));
  if (!hasPref) {
    const g = chooseGrouped(layout, free, n, sternSide);
    if (g) return { seats: g, grouped: true };
  }
  return { seats: chooseSeats(free, n, preferred, order), grouped: false };
}

type FormField = { name: string; type: string; value: string; checked: boolean; options?: { value: string; selected: boolean }[] };

export function parseForm(html: string, formId = "insert_form"): { action: string; fields: FormField[] } | null {
  const fm = new RegExp(`<form\\b[^>]*\\bid\\s*=\\s*["']${formId}["'][^>]*>([\\s\\S]*?)</form>`, "i").exec(html);
  if (!fm) return null;
  const action = attr(fm[0], "action") ?? `${MODULE}/action/popup.step1.action.php`;
  const body = fm[1];
  const fields: FormField[] = [];
  const re = /<input\b[^>]*>|<select\b[^>]*>[\s\S]*?<\/select>|<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi;
  for (const m of body.matchAll(re)) {
    const tag = m[0];
    const lower = tag.slice(0, 9).toLowerCase();
    const name = attr(tag, "name");
    if (!name) continue;
    if (lower.startsWith("<select")) {
      const opts = [...tag.matchAll(/<option\b([^>]*)>/gi)].map((o) => ({ value: attr(o[1], "value") ?? "", selected: /\sselected\b/i.test(o[1]) }));
      fields.push({ name, type: "select", value: "", checked: false, options: opts });
    } else if (lower.startsWith("<textarea")) {
      fields.push({ name, type: "textarea", value: stripTags(tag), checked: false });
    } else {
      const type = (attr(tag, "type") ?? "text").toLowerCase();
      if (["button", "submit", "image", "reset", "file"].includes(type)) continue;
      fields.push({ name, type, value: attr(tag, "value") ?? "", checked: /\schecked\b/i.test(tag) });
    }
  }
  return { action, fields };
}

const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");

// 사이트의 "전체 동의"(agree_check('Y')) 대상 이름들
const AGREE_NAME = /^(agree|BI_3JA|BI_AD|all_agree)/;

export function buildPayload(
  form: { fields: FormField[] },
  v: { people: number; name: string; phone: string; seatValues: string[]; tempStat: string; agreeAll: boolean; shipUid: string; typeUid: string },
): { payload: string; unresolved: string[] } {
  const digits = v.phone.replace(/\D/g, "");
  const m = /^(\d{3})(\d{3,4})(\d{4})$/.exec(digits);
  if (!m) throw new Error("휴대폰 번호 형식이 올바르지 않습니다");
  const set: Record<string, string> = {
    BI_IN: String(v.people),
    BI_NAME: v.name,
    BI_TEL1: m[1],
    BI_TEL2: m[2],
    BI_TEL3: m[3],
    temp_bi_stat: v.tempStat,
    PA_N_UID: v.shipUid,
    PS_N_UID: v.typeUid,
  };
  const once = new Set<string>(); // 배·낚시종류는 라디오/hidden 어느 쪽이든 한 번만 보냄
  const pairs: [string, string][] = [];
  const unresolved: string[] = [];
  const radioDone = new Set<string>();
  let seatIdx = 0;
  const groups = new Map<string, string[]>();
  for (const f of form.fields) if (f.type === "radio") groups.set(f.name, [...(groups.get(f.name) ?? []), f.value]);
  const radioNames = new Set(form.fields.filter((f) => f.type === "radio").map((f) => f.name));
  for (const f of form.fields) {
    if (f.name === "PA_N_UID" || f.name === "PS_N_UID") {
      if (!once.has(f.name)) pairs.push([f.name, set[f.name]]);
      once.add(f.name);
      continue;
    }
    if (f.name === "seat[]") {
      // 브라우저는 선택 안 된 좌석 칸도 빈 값으로 함께 보냅니다 (직접 확인한 serialize 결과와 동일하게)
      pairs.push([f.name, v.seatValues[seatIdx++] ?? ""]);
      continue;
    }
    if (f.type === "select") {
      const val = f.name in set ? set[f.name] : (f.options?.find((o) => o.selected) ?? f.options?.[0])?.value ?? "";
      pairs.push([f.name, val]);
    } else if (f.type === "checkbox") {
      if (v.agreeAll && AGREE_NAME.test(f.name)) pairs.push([f.name, f.value || "Y"]);
      else if (f.checked) pairs.push([f.name, f.value || "on"]);
    } else if (f.type === "radio") {
      if (v.agreeAll && AGREE_NAME.test(f.name)) {
        // "전체 동의"(agree_check('Y')): 동의 항목은 값이 Y 인 쪽을 선택 (없으면 첫 번째)
        if (!radioDone.has(f.name)) {
          const vals = groups.get(f.name) ?? [];
          pairs.push([f.name, vals.find((x) => x.toUpperCase() === "Y") ?? vals[0] ?? "Y"]);
          radioDone.add(f.name);
        }
      } else if (f.checked) {
        pairs.push([f.name, f.value]);
        radioDone.add(f.name);
      }
    } else {
      pairs.push([f.name, f.name in set ? set[f.name] : f.value]);
    }
  }
  for (const n of radioNames) if (!radioDone.has(n) && n !== "PA_N_UID" && n !== "PS_N_UID") unresolved.push(`${n} (선택된 값 없음)`);
  return { payload: pairs.map(([k, val]) => `${enc(k)}=${enc(val)}`).join("&"), unresolved };
}

// ------------------------------------------------------------------ 예약 시도 (한 번)
export async function discoverOpenShips(sess: Session, date: string, seeds: string[]): Promise<{ seed: string; ships: Choice[]; html: string } | null> {
  for (const uid of seeds) {
    const r = await sess.request("GET", `${MODULE}/popup.step1.php?date=${date}&PA_N_UID=${uid}`);
    if (!/id\s*=\s*["']insert_form["']/.test(r.text)) continue;
    return { seed: uid, ships: parseRadios(r.text, "PA_N_UID"), html: r.text };
  }
  return null;
}

const norm = (s: string) => s.replace(/\s+/g, "");

export function pickShip(open: Choice[], wishes: ShipWish[]): { choice: Choice; wish: ShipWish } | null {
  if (!wishes.length) return open.length ? { choice: open[0], wish: { name: "" } } : null;
  for (const w of wishes) {
    const hit = open.find((o) => (w.uid ? o.value === w.uid : norm(o.label).includes(norm(w.name))));
    if (hit) return { choice: hit, wish: w };
  }
  return null;
}

export type Warm = { type: Choice; naun: string };

// 조회 때 같이 받아 둘 배: 우선순위가 가장 높은 배 중 미리 준비(prewarm)가 된 것
function fastTarget(cfg: BookingConfig, warm: Map<string, Warm>): { uid: string; warm: Warm } | null {
  if (cfg.ships.length) {
    for (const w of cfg.ships) {
      const uid = guessUid(w);
      const wm = uid ? warm.get(uid) : undefined;
      if (uid && wm) return { uid, warm: wm };
    }
    return null;
  }
  const first = warm.entries().next().value as [string, Warm] | undefined;
  return first ? { uid: first[0], warm: first[1] } : null;
}

const SHIP_UIDS: [string, string][] = [
  ["승주", "2955"], ["헌터", "4443"], ["골드피싱", "2954"], ["으리", "4920"], ["블루오션", "5679"], ["바다호", "5891"], ["영스타", "3571"],
  ["뚜기", "2961"], ["유리", "5578"], ["나대세", "2956"], ["아산", "5866"], ["박찬호", "2950"], ["히트", "6407"], ["헤르메스", "5579"], ["만석", "3570"],
];
// 배 이름만 알 때 알려진 배 번호를 추정 (틀려도 배 목록에서 이름으로 다시 찾으므로 안전)
export function guessUid(w: ShipWish): string | undefined {
  if (w.uid) return w.uid;
  const n = norm(w.name);
  return SHIP_UIDS.find(([k]) => n.includes(k))?.[1];
}

// 예약 목록 페이지에서 배 번호들을 모읍니다 (사이트마다 배 번호가 달라서 미리 알 수 없을 때)
export async function discoverSeeds(sess: Session, date: string): Promise<string[]> {
  try {
    const r = await sess.request("GET", `/index.php?mid=bk&year=${date.slice(0, 4)}&month=${Number(date.slice(4, 6))}&day=${Number(date.slice(6))}`);
    return [...new Set([...r.text.matchAll(/PA_N_UID=(\d+)/g)].map((m) => m[1]))];
  } catch {
    return [];
  }
}

const step1Url = (date: string, uid: string, psUid?: string) =>
  `${MODULE}/popup.step1.php?date=${date}&PA_N_UID=${uid}&PH_N_UID=0${psUid ? `&PS_N_UID=${psUid}` : ""}`;
const ajaxBody = (cfg: BookingConfig, uid: string, psUid: string, naun: string) =>
  `date=${cfg.date}&PA_N_UID=${uid}&PH_N_UID=0&PS_N_UID=${psUid}&BI_IN=${cfg.people}&BI_SO_IN=N&pay_method=&naun=${naun}`;

// 오픈 전에 미리: 각 배의 낚시 종류 번호와 naun 값을 알아 둡니다 (오픈 순간에는 요청 한 번으로 끝내기 위함)
export async function prewarm(sess: Session, cfg: BookingConfig, log: (m: string) => void, extra: string[] = []): Promise<Map<string, Warm>> {
  const out = new Map<string, Warm>();
  const wished = cfg.ships.map(guessUid).filter(Boolean) as string[];
  const uids = [...new Set(cfg.ships.length ? wished : extra)].slice(0, 4);
  if (!uids.length) return out;
  try {
    const pages = await sess.batch(uids.map((uid) => ({ method: "GET" as const, path: step1Url(cfg.date, uid) })));
    pages.forEach((p, i) => {
      const type = parseRadios(p.text, "PS_N_UID").find((t) => SPECIES_WORDS.some((w) => t.label.includes(w)));
      if (type) out.set(uids[i], { type, naun: /naun=(\d+)/.exec(p.text)?.[1] ?? "1" });
    });
    if (out.size) log(`미리 준비 완료 (${out.size}척): 낚시 종류 번호를 확인해 두었습니다.`);
  } catch (e: any) {
    log(`미리 준비 건너뜀: ${e.message}`);
  }
  return out;
}

export type Prefetched = { uid: string; html: string; ajaxText: string };

export async function prepareBooking(sess: Session, cfg: BookingConfig, found: { choice: Choice; wish: ShipWish }, log: (m: string) => void, warm?: Warm, pre?: Prefetched): Promise<BookingResult> {
  const { choice, wish } = found;
  const uid = choice.value;
  let type: Choice | undefined;
  let html = "";
  let ajaxText = "";
  const preOk = Boolean(warm && pre && pre.uid === uid && (pre.ajaxText.split("|^|")[2] ?? "").trim() === "확인" && /id\s*=\s*["']insert_form["']/.test(pre.html));
  if (warm && pre && pre.uid === uid && !preOk) log("미리 받은 화면이 완전하지 않아 다시 받습니다.");
  if (warm && pre && preOk) {
    // 가장 빠른 길: 배를 찾은 그 조회에서 좌석 화면과 인원 확인을 이미 받아 왔음 (추가 요청 없음)
    type = warm.type;
    html = pre.html;
    ajaxText = pre.ajaxText;
    log("좌석 화면을 조회와 함께 받아 두어 추가 요청 없이 진행합니다.");
  } else if (warm) {
    // 빠른 길: 좌석 화면과 인원 확인을 중계 한 번으로
    try {
      type = warm.type;
      const [page, ajax] = await sess.batch([
        { method: "GET", path: step1Url(cfg.date, uid, type.value) },
        { method: "POST", path: `${MODULE}/action/popup.step1.ajax.php`, ajax: true, body: ajaxBody(cfg, uid, type.value, warm.naun) },
      ]);
      html = page.text;
      ajaxText = ajax.text;
    } catch (e: any) {
      log(`빠른 방식 실패, 일반 방식으로 전환: ${e.message}`);
      type = undefined;
    }
  }
  if (!type) {
    // 일반 길: 낚시 종류 (쭈꾸미·갑오징어만)
    let page = await sess.request("GET", step1Url(cfg.date, uid));
    const types = parseRadios(page.text, "PS_N_UID");
    log(`낚시 종류: ${types.map((t) => t.label).join(" | ") || "없음"}`);
    type = types.find((t) => SPECIES_WORDS.some((w) => t.label.includes(w)));
    if (!type) throw new Error(`${choice.label}: 쭈꾸미/갑오징어 낚시종류가 없어 중단합니다`);
    page = await sess.request("GET", step1Url(cfg.date, uid, type.value));
    html = page.text;
    const naun = /naun=(\d+)/.exec(html)?.[1] ?? "1";
    ajaxText = (await sess.request("POST", `${MODULE}/action/popup.step1.ajax.php`, { ajax: true, body: ajaxBody(cfg, uid, type.value, naun) })).text;
  }
  // 인원 → 상태 확인 (사이트가 인원 선택 시 하는 요청과 같음)
  const parts = ajaxText.split("|^|");
  const price = (parts[1] ?? parts[0] ?? "").trim();
  const status = (parts[2] ?? "").trim();
  if (status !== "확인") throw new Error(`인원 ${cfg.people}명 상태: "${status || "응답 없음"}" (남은 자리 부족·대기자) — 중단합니다`);

  // 좌석
  const cells = parseSeats(html);
  let seats: number[] = [];
  let seatNote = "";
  if (cfg.seatMode === "none" || cells.length === 0) {
    seatNote = cells.length === 0 ? "좌석 선택이 없는 배" : "좌석 선택 안 함";
  } else {
    const free = new Set(cells.filter((c) => c.available).map((c) => c.seat));
    const order = sternOrder(cells, cfg.sternSide ?? "right");
    const pk = pickSeats(layoutFromCells(cells), free, cfg.people, [...(wish.preferredSeats ?? []), ...(cfg.preferredSeats ?? [])], order, cfg.sternSide ?? "right");
    seats = pk.seats;
    if (seats.length < cfg.people) throw new Error(`빈 좌석 부족: 필요 ${cfg.people}, 가능 ${seats.length}`);
    seatNote = `빈 좌석 ${free.size}개 중 선미 우선으로 선택${pk.grouped ? " (붙어 앉는 자리)" : ""}`;
  }

  // 제출 폼
  const form = parseForm(html);
  if (!form) throw new Error("예약 폼(#insert_form)을 찾지 못했습니다");
  // seat[] 칸(hidden, id = 's'+날짜+배번호+좌석번호)마다 선택된 번호만 값으로 채움 — 브라우저 전송과 같은 형태
  const seatValues = seatValuesFor(html, cfg.date, uid, new Set(seats));
  const { payload, unresolved } = buildPayload(form, { people: cfg.people, name: cfg.name, phone: cfg.phone, seatValues, tempStat: status, agreeAll: true, shipUid: uid, typeUid: type!.value });

  return {
    ship: { uid, name: choice.label },
    species: type!.label,
    people: cfg.people,
    seats,
    seatNote,
    status,
    price,
    actionUrl: new URL(form.action, sess.base).toString(),
    payload,
    unresolved,
    dryRun: true,
    referer: new URL(step1Url(cfg.date, uid, type!.value), sess.base).toString(),
  };
}

function seatValuesFor(html: string, date: string, uid: string, chosen: Set<number>): string[] {
  const prefix = `s${date}${uid}`;
  const out: string[] = [];
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    if (attr(m[0], "name") !== "seat[]") continue;
    const id = attr(m[0], "id") ?? "";
    const no = id.startsWith(prefix) ? Number(id.slice(prefix.length)) : NaN;
    out.push(chosen.has(no) ? String(no) : "");
  }
  return out;
}

// ------------------------------------------------------------------ 최종 제출 (cfg.submit 이 true 일 때만 실행됨)
const decodeHtml = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, "&");

// 응답 화면 안의 안내창(alert) 문구들과, 태그를 뺀 본문
export function pageNotes(text: string): { alerts: string[]; plain: string } {
  const alerts = [...text.matchAll(/alert\(\s*(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1\s*\)/g)]
    .map((m) => decodeHtml(m[2]).replace(/\\n/g, " ").replace(/\\(["'`/\\])/g, "$1").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const plain = decodeHtml(text.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return { alerts, plain };
}

// 완료 화면에서 예약번호·입금 안내처럼 보이는 부분만 골라 낸다 (없으면 앞부분)
function keyInfo(plain: string): string {
  const hits = [...plain.matchAll(/(예약\s*번호|입금\s*(?:계좌|금액|기한|은행)|계좌\s*번호|예금주)[\s:：]*\S.{0,40}/g)].map((m) => m[0].trim());
  return hits.length ? hits.slice(0, 4).join(" / ") : plain.slice(0, 150);
}

const FAIL_WORDS = /(실패|오류|에러|불가|마감|초과|부족|이미|중복|잘못|제한|입력해|선택해|동의|확인해|없습니다|않습니다|못했|안됩니다|안 됩니다|거부)/;
const OK_WORDS = /(완료|접수|예약되|예약 되|등록되|신청되)/;

// 더피싱 계열: 제출이 받아들여지면 사이트가 다음 단계(popup.step2.php)로 보낸다. 안내창 문구가 있으면 그것으로도 판단한다.
export function judgeThefishing(finalUrl: string, text: string): { state: SubmitOutcome["state"]; message: string; next?: string } {
  const { alerts, plain } = pageNotes(text);
  const said = alerts.join(" / ");
  const jump = /(?:location(?:\.href|\.replace)?|href)\s*(?:=|\()\s*["']([^"']*popup\.step2\.php[^"']*)["']/i.exec(text)?.[1] ?? /url=([^"'>\s]*popup\.step2\.php[^"'>\s]*)/i.exec(text)?.[1];
  if (/popup\.step2\.php/i.test(finalUrl)) return { state: "success", message: said };
  if (jump) return { state: "success", message: said, next: jump };
  if (alerts.length) {
    const bad = FAIL_WORDS.test(said);
    const good = OK_WORDS.test(said);
    return { state: bad && !good ? "failed" : good && !bad ? "success" : "unknown", message: said };
  }
  return { state: "unknown", message: plain ? `사이트 응답: ${plain.slice(0, 120)}` : "사이트 응답이 비어 있습니다" };
}

async function submitThefishing(sess: Session, result: BookingResult, log: (m: string) => void): Promise<SubmitOutcome> {
  const r = await sess.request("POST", result.actionUrl, { body: result.payload, referer: result.referer, headers: { origin: new URL(sess.base).origin } });
  const v = judgeThefishing(r.url, r.text);
  log(`제출 응답: HTTP ${r.status} · ${new URL(r.url).pathname.split("/").slice(-1)[0] || "/"}${v.message ? ` · ${v.message.slice(0, 160)}` : ""}`);
  let message = v.message;
  if (v.state === "success") {
    // 완료 화면(입금 안내 등)을 읽어 두면 화면에서 바로 볼 수 있다. 읽기만 하는 요청이라 실패해도 상관없다.
    try {
      const page = /popup\.step2\.php/i.test(r.url) ? r.text : v.next ? (await sess.request("GET", new URL(v.next, r.url).toString(), { referer: r.url })).text : "";
      const info = keyInfo(pageNotes(page).plain);
      if (info) message = [message, info].filter(Boolean).join(" · ");
    } catch {
      /* 무시 */
    }
  } else if (v.state === "unknown" && result.seats.length && result.referer) {
    // 응답을 해석하지 못했을 때: 내가 고른 좌석이 지금 어떻게 보이는지로 접수 여부를 가늠한다
    try {
      const again = await sess.request("GET", result.referer);
      const mine = parseSeats(again.text).filter((c) => result.seats.includes(c.seat));
      if (mine.length === result.seats.length) {
        const taken = mine.filter((c) => !c.available).length;
        if (taken === mine.length) message += " (선택한 좌석이 이제 선택 불가로 바뀌었어요 — 접수됐을 가능성이 높습니다)";
        else if (taken === 0) message += " (선택한 좌석이 아직 비어 있어요 — 접수되지 않았을 가능성이 있습니다)";
      }
    } catch {
      /* 무시 */
    }
  }
  return { state: v.state, message: message || "사이트가 별도 안내 문구를 주지 않았습니다", httpStatus: r.status, at: Date.now() };
}

// 선상24: 예약 화면의 스크립트와 같은 방식 — POST /mypage/reservation_end (JSON 응답, 성공이면 reservation_no 가 들어 있음)
async function submitSunsang24(sess: Session, result: BookingResult, log: (m: string) => void): Promise<SubmitOutcome> {
  const r = await sess.request("POST", result.actionUrl, {
    body: result.payload,
    ajax: true,
    referer: result.referer,
    headers: { origin: new URL(sess.base).origin, accept: "application/json, text/javascript, */*; q=0.01" },
  });
  let j: any = null;
  try {
    j = JSON.parse(r.text.replace(/^\uFEFF/, "").trim());
  } catch {
    /* JSON 이 아님 */
  }
  log(`제출 응답: HTTP ${r.status} · ${j ? JSON.stringify(j).slice(0, 200) : r.text.replace(/\s+/g, " ").slice(0, 120)}`);
  if (j && typeof j === "object" && j.reservation_no !== undefined && j.reservation_no !== null && String(j.reservation_no) !== "") {
    return { state: "success", message: j.message ? String(j.message) : "예약이 접수되었습니다", reservationNo: String(j.reservation_no), httpStatus: r.status, at: Date.now() };
  }
  if (j && typeof j === "object" && j.message) {
    return { state: "failed", message: `${j.message}${j.code ? ` (코드 ${j.code})` : ""}`, httpStatus: r.status, at: Date.now() };
  }
  return { state: "unknown", message: `사이트 응답을 해석하지 못했습니다: ${pageNotes(r.text).plain.slice(0, 120) || "내용 없음"}`, httpStatus: r.status, at: Date.now() };
}

// 같은 묶음(날짜 여러 개 + "하나 되면 나머지 중지")에서는 한 번에 하나만 제출한다 — 두 날짜가 동시에 접수되는 일을 막는다
const groupSubmit = new Map<string, "busy" | "done">();

async function submitFinal(job: Job, cfg: BookingConfig, sess: Session, log: (m: string) => void): Promise<void> {
  const result = job.result!;
  const gid = cfg.stopOthersOnSuccess ? cfg.groupId : undefined;
  if (gid) {
    while (groupSubmit.get(gid) === "busy") {
      if (job.stopRequested) throw new StopError();
      await sleep(100);
    }
    if (groupSubmit.get(gid) === "done") {
      job.status = "stopped";
      log("같은 묶음의 다른 날짜가 이미 예약되어, 이 날짜는 제출하지 않았습니다.");
      return;
    }
  }
  if (job.stopRequested) throw new StopError(); // 제출 직전까지는 중지할 수 있다
  if (gid) groupSubmit.set(gid, "busy");
  let keep = false;
  try {
    job.status = "submitting";
    log("실제 제출: 예약 요청을 보냅니다. (한 번만 보내며 자동으로 다시 보내지 않습니다)");
    const t0 = Date.now();
    let out: SubmitOutcome;
    try {
      out = cfg.kind === "sunsang24" ? await submitSunsang24(sess, result, log) : await submitThefishing(sess, result, log);
    } catch (e: any) {
      const msg: string = e?.message ?? String(e);
      // 설정 문제로 요청이 아예 나가지 못한 경우만 "실패", 그 밖의 오류는 사이트가 받았는지 알 수 없으므로 "확인 필요"
      out = /중계기 오류\((auth|config)\)/.test(msg)
        ? { state: "failed", message: `요청을 보내지 못했습니다: ${msg}`, at: Date.now() }
        : { state: "unknown", message: `응답을 받지 못했습니다 (${msg}). 접수됐는지 예약처에서 직접 확인하세요.`, at: Date.now() };
    }
    result.dryRun = false;
    result.submit = out;
    log(`제출 소요 ${Date.now() - t0}ms`);
    if (out.state === "failed") {
      job.status = "failed";
      job.error = `제출이 받아들여지지 않았습니다: ${out.message}`;
      log(job.error);
      return;
    }
    keep = true;
    job.status = "done";
    log(out.state === "success" ? `예약이 접수되었습니다.${out.reservationNo ? ` 예약번호 ${out.reservationNo}` : ""}` : "제출은 했지만 접수 여부를 확인하지 못했습니다. 예약처 사이트에서 직접 확인하세요.");
    if (gid) for (const o of jobs.values()) if (o.groupId === cfg.groupId && o.id !== job.id) stopJob(o.id);
  } finally {
    if (gid) {
      if (keep) groupSubmit.set(gid, "done");
      else groupSubmit.delete(gid);
    }
  }
}

// ------------------------------------------------------------------ 작업(Job) 관리
const jobs = new Map<string, Job>();
const MAX_JOBS = 40;
const MAX_ACTIVE = 12;

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(publicJob);
}
export function getJob(id: string): Job | undefined {
  const j = jobs.get(id);
  return j ? publicJob(j) : undefined;
}
// 목록에는 전화번호가 담긴 payload 를 그대로 노출하지 않도록 마스킹본을 만든다 (결과 상세에서만 전체 제공)
function publicJob(j: Job): Job {
  return { ...j, log: [...j.log] };
}

export function stopJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || ["done", "failed", "stopped"].includes(j.status)) return false;
  j.stopRequested = true;
  return true;
}

// 지원하는 예약처: 미스쿠 낚시, 더피싱 계열(*.thefishing.kr) — 같은 예약 모듈(reservation_boat_v5.2_seat1)을 쓰는 사이트
export const kindOf = (base: string): "thefishing" | "sunsang24" => (/sunsang24\.com/.test(base) || process.env.BOOKING_TEST_KIND === "sunsang24" ? "sunsang24" : "thefishing");

export function normalizeBase(input: unknown): string {
  const raw = String(input ?? "http://www.mscufishing.com").trim();
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw new Error("예약처 주소가 올바르지 않습니다");
  }
  const base = `${u.protocol}//${u.host}`;
  const host = u.hostname.toLowerCase();
  // 어떤 사이트든 공개 주소면 허용 (내부망·IP 주소·localhost 는 차단). 방식은 kindOf 가 주소로 판단.
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host === "localhost" || !host.includes(".") || /\.(local|internal|localdomain)$/.test(host);
  const ok = !isIp || base === process.env.BOOKING_TEST_BASE;
  if (!ok) throw new Error("예약처 주소가 올바르지 않습니다 (도메인 주소만 가능)");
  return base;
}

function parseDates(raw: any): string[] {
  const list: unknown[] = Array.isArray(raw?.dates) ? raw.dates : raw?.date ? [raw.date] : [];
  const out = [...new Set(list.map((d) => String(d).replace(/\D/g, "")))];
  if (!out.length) throw new Error("날짜를 한 개 이상 선택하세요");
  if (out.length > 10) throw new Error("날짜는 한 번에 10개까지입니다");
  for (const d of out) if (!/^\d{8}$/.test(d)) throw new Error("날짜는 YYYYMMDD 형식이어야 합니다");
  return out.sort();
}

// 날짜가 여러 개면 날짜마다 설정을 하나씩 만든다 (각각 독립적으로, 동시에 진행)
export function validateConfigs(raw: any): BookingConfig[] {
  const base = normalizeBase(raw?.baseUrl);
  const dates = parseDates(raw);
  const ships: ShipWish[] = (Array.isArray(raw?.ships) ? raw.ships : [])
    .map((s: any) => ({ name: String(s?.name ?? "").trim(), uid: s?.uid ? String(s.uid) : undefined, preferredSeats: Array.isArray(s?.preferredSeats) ? s.preferredSeats.map(Number).filter(Number.isFinite) : undefined }))
    .filter((s: ShipWish) => s.name || s.uid);
  // 배를 비워두면 "열린 배 아무거나" (배가 한 척뿐인 사이트용)
  const people = Number(raw?.people);
  if (!Number.isInteger(people) || people < 1 || people > 20) throw new Error("인원은 1~20명");
  const name = String(raw?.name ?? "").trim();
  if (!name) throw new Error("예약자명을 입력하세요");
  if (!/^\d{3}\d{3,4}\d{4}$/.test(String(raw?.phone ?? "").replace(/\D/g, ""))) throw new Error("휴대폰 번호가 올바르지 않습니다");
  let openAt: string | undefined;
  if (raw?.openAt) {
    const t = new Date(raw.openAt).getTime();
    if (!Number.isFinite(t)) throw new Error("오픈 시각 형식이 올바르지 않습니다");
    openAt = new Date(t).toISOString();
  }
  const groupId = dates.length > 1 ? crypto.randomBytes(4).toString("hex") : undefined;
  // 일자별 예약자 (없으면 공통 name/phone 사용)
  const bookerOf = (date: string) => {
    const b = raw?.bookers?.[date];
    const n = String(b?.name ?? "").trim() || name;
    const ph = String(b?.phone ?? "").trim() || String(raw.phone);
    if (!/^\d{3}\d{3,4}\d{4}$/.test(ph.replace(/\D/g, ""))) throw new Error(`${date} 예약자 휴대폰 번호가 올바르지 않습니다`);
    return { name: n, phone: ph };
  };
  return dates.map((date) => ({
    baseUrl: base,
    date,
    ships,
    people,
    seatMode: raw?.seatMode === "none" ? "none" : "auto",
    preferredSeats: Array.isArray(raw?.preferredSeats) ? raw.preferredSeats.map(Number).filter(Number.isFinite) : [],
    sternSide: raw?.sternSide === "left" ? "left" : "right",
    ...bookerOf(date),
    openAt,
    warmupSeconds: Math.min(60, Math.max(0, Number(raw?.warmupSeconds ?? 5))),
    pollMs: Math.max(500, Number(raw?.pollMs ?? 700)), // 선사 서버 부담을 줄이기 위해 0.5초 미만으로는 조회하지 않음
    maxPollMinutes: Math.min(60, Math.max(1, Number(raw?.maxPollMinutes ?? 10))),
    seedUids: Array.isArray(raw?.seedUids) && raw.seedUids.length ? raw.seedUids.map(String) : undefined,
    kind: kindOf(base),
    groupId,
    stopOthersOnSuccess: Boolean(raw?.stopOthersOnSuccess) && dates.length > 1,
    submit: raw?.submit === true,
  }));
}

// 이전 호출 방식(날짜 1개) 호환
export function validateConfig(raw: any): BookingConfig {
  return validateConfigs(raw)[0];
}

// 실제 제출 작업의 중복 방지: 같은 사이트·날짜·예약자로 이미 진행 중인 실제 제출 작업이 있으면 하나 더 시작하지 않는다 (같은 예약이 두 번 접수되는 것을 막음)
const liveSubmits = new Map<string, string>();
const submitKey = (c: BookingConfig) => `${c.baseUrl}|${c.date}|${c.name}|${c.phone.replace(/\D/g, "")}`;

export function startJobs(cfgs: BookingConfig[]): Job[] {
  const active = [...jobs.values()].filter((j) => ["waiting", "polling", "submitting"].includes(j.status)).length;
  if (active + cfgs.length > MAX_ACTIVE) throw new Error(`동시에 진행할 수 있는 작업은 ${MAX_ACTIVE}개까지입니다 (현재 ${active}개 진행 중)`);
  for (const c of cfgs) {
    if (!c.submit) continue;
    const id = liveSubmits.get(submitKey(c));
    const j = id ? jobs.get(id) : undefined;
    if (j && ["waiting", "polling", "submitting"].includes(j.status)) {
      throw new Error(`${c.date.slice(4, 6)}/${c.date.slice(6)} 같은 예약자로 진행 중인 실제 제출 작업이 이미 있어요. 먼저 중지하거나 끝난 뒤에 다시 시작하세요.`);
    }
  }
  return cfgs.map((c) => {
    const job = startJob(c);
    if (c.submit) liveSubmits.set(submitKey(c), job.id);
    return job;
  });
}

export function startJob(cfg: BookingConfig): Job {
  if (jobs.size >= MAX_JOBS) {
    const oldest = [...jobs.values()].filter((j) => !["waiting", "polling", "submitting"].includes(j.status)).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) jobs.delete(oldest.id);
  }
  const id = crypto.randomBytes(6).toString("hex");
  const job: Job = {
    id,
    createdAt: Date.now(),
    status: "waiting",
    summary: `${cfg.submit ? "[실제 제출] " : ""}${cfg.date.slice(4, 6)}/${cfg.date.slice(6)} ${new URL(cfg.baseUrl).hostname.replace(/^www\./, "")} · ${cfg.ships.length ? cfg.ships.map((s) => s.name || s.uid).join(" > ") : "열린 배 아무거나"} · ${cfg.people}명`,
    groupId: cfg.groupId,
    log: [],
    stopRequested: false,
  };
  jobs.set(id, job);
  void runJob(job, cfg);
  return publicJob(job);
}

async function runJob(job: Job, cfg: BookingConfig) {
  const log = (m: string) => {
    job.log.push(`${new Date().toLocaleTimeString("ko-KR", { hour12: false, timeZone: "Asia/Seoul" })} ${m}`);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
  };
  const sess = new Session(cfg.baseUrl);
  sess.onSlow = log;
  try {
    log(cfg.submit ? "실제 제출 모드: 자리를 잡으면 바로 제출합니다." : "테스트 모드: 최종 제출은 하지 않습니다.");
    if (cfg.openAt) {
      const target = new Date(cfg.openAt).getTime() - (cfg.warmupSeconds ?? 5) * 1000;
      log(`오픈(${new Date(cfg.openAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}) 전까지 대기합니다.`);
      while (Date.now() < target) {
        if (job.stopRequested) throw new StopError();
        await sleep(Math.min(1000, Math.max(50, target - Date.now())));
      }
    }
    job.status = "polling";
    if (cfg.kind === "sunsang24") {
      await runSunsang(job, cfg, sess, log);
      return;
    }
    const deadline = Date.now() + (cfg.maxPollMinutes ?? 10) * 60_000;
    const nextDelay = makePoller(cfg, log);
    const listSeeds = await discoverSeeds(sess, cfg.date);
    if (listSeeds.length) log(`예약 목록에서 배 번호 ${listSeeds.length}개 확인`);
    const seeds = [...new Set([...(cfg.ships.map(guessUid).filter(Boolean) as string[]), ...listSeeds, ...(cfg.seedUids ?? KNOWN_SEEDS)])];
    let warm = new Map<string, Warm>();
    try {
      warm = await prewarm(sess, cfg, log, listSeeds);
    } catch {
      /* 미리 준비는 실패해도 일반 방식으로 진행 */
    }
    // 미리 준비된 배가 있으면 그 배 번호로 바로 조회 시작 (이미 열려 있으면 첫 조회에서 끝낼 수 있음)
    let workingSeed: string | null = fastTarget(cfg, warm)?.uid ?? null;
    let attempt = 0;
    while (Date.now() < deadline) {
      if (job.stopRequested) throw new StopError();
      attempt++;
      const t0 = Date.now();
      let open: Choice[] = [];
      let pre: Prefetched | undefined;
      try {
        let r: { text: string } | null = null;
        const fast = workingSeed ? fastTarget(cfg, warm) : null;
        const seedUrl = `${MODULE}/popup.step1.php?date=${cfg.date}&PA_N_UID=${workingSeed}`;
        if (workingSeed && fast) {
          // 배 목록 확인 + 그 배의 좌석 화면 + 인원 확인을 중계 한 번으로 (열린 순간 바로 쓰려고)
          const [a, b, c] = await sess.batch([
            { method: "GET", path: seedUrl },
            { method: "GET", path: step1Url(cfg.date, fast.uid, fast.warm.type.value) },
            { method: "POST", path: `${MODULE}/action/popup.step1.ajax.php`, ajax: true, body: ajaxBody(cfg, fast.uid, fast.warm.type.value, fast.warm.naun) },
          ]);
          r = a;
          pre = { uid: fast.uid, html: b.text, ajaxText: c.text };
        } else if (workingSeed) {
          r = await sess.request("GET", seedUrl);
        }
        if (r && /id\s*=\s*["']insert_form["']/.test(r.text)) open = parseRadios(r.text, "PA_N_UID");
        else {
          pre = undefined; // 닫혀 있을 때 받은 화면은 쓰지 않는다
          const d = await discoverOpenShips(sess, cfg.date, workingSeed ? [workingSeed, ...seeds] : seeds);
          workingSeed = d?.seed ?? null;
          open = d?.ships ?? [];
          if (!d && attempt % 10 === 1) log("예약 화면이 아직 열리지 않았습니다. 계속 확인합니다.");
        }
      } catch (e: any) {
        log(`조회 오류: ${e.message}`);
        if (/중계기 오류\((auth|config)\)/.test(e.message)) throw e; // 설정 문제는 바로 중단
      }
      const hit = pickShip(open, cfg.ships);
      if (hit) {
        log(`예약 가능한 배 발견: ${hit.choice.label} (${hit.choice.value})`);
        job.result = await prepareBooking(sess, cfg, hit, log, warm.get(hit.choice.value), pre);
        log(`소요: 배 발견 후 ${Date.now() - t0}ms`);
        if (cfg.submit) {
          log(`입력 준비 완료 — ${job.result.ship.name}, ${job.result.species}, ${job.result.people}명, 좌석: ${job.result.seats.join(",") || "미선택"}`);
          await submitFinal(job, cfg, sess, log);
          log(`소요: 배 발견부터 제출 응답까지 ${Date.now() - t0}ms`);
          return;
        }
        job.status = "done";
        log(`입력 준비 완료 — ${job.result.ship.name}, ${job.result.species}, ${job.result.people}명, 좌석: ${job.result.seats.join(",") || "미선택"}`);
        log("테스트 모드이므로 제출하지 않았습니다.");
        if (cfg.stopOthersOnSuccess && cfg.groupId) {
          for (const o of jobs.values()) if (o.groupId === cfg.groupId && o.id !== job.id) stopJob(o.id);
        }
        return;
      }
      if (attempt % 10 === 1 && open.length) log(`원하는 배가 아직 안 열렸습니다 (열린 배: ${open.map((o) => o.label).join(", ")})`);
      // 요청에 걸린 시간을 빼서 일정한 간격으로 조회 (불필요한 대기 제거)
      await sleep(Math.max(0, nextDelay() - (Date.now() - t0)) + Math.random() * 100);
    }
    throw new Error("제한 시간 안에 예약 가능한 배를 찾지 못했습니다");
  } catch (e: any) {
    if (e instanceof StopError) {
      job.status = "stopped";
      log("사용자가 중지했습니다.");
    } else {
      job.status = "failed";
      job.error = e?.message ?? String(e);
      log(`중단: ${job.error}`);
    }
  }
}

class StopError extends Error {}

// ====================================================================== 선상24 (sunsang24.com) 어댑터
// 흐름: 날짜별 일정 목록(/ship/schedule_fleet/YYYYMMDD/0/simple_day)에서 배 이름·일정 번호·"바로예약" 여부를 읽고,
//       열리면 /mypage/reservation_ready/<일정번호> 폼을 읽어 제출 내용(POST /mypage/reservation_end)을 만든다. (제출은 하지 않음)

export type SunShip = { shipNo: string; name: string; scheduleNo: string; bookable: boolean; fish: string };

export function parseSunsangDay(html: string): SunShip[] {
  const marks = [...html.matchAll(/<table[^>]*class="[^"]*ship_unit_ship_no_(\d+)[^"]*"[^>]*>/g)];
  return marks.map((m, i) => {
    const chunk = html.slice(m.index! + m[0].length, i + 1 < marks.length ? marks[i + 1].index! : html.length);
    const name = stripTags(/<div class="title">([\s\S]*?)<\/div>/.exec(chunk)?.[1] ?? "");
    const scheduleNo = /<ul[^>]*reservation_detail[^>]*data-schedule_no="(\d+)"/.exec(chunk)?.[1] ?? /data-schedule_no="(\d+)"/.exec(chunk)?.[1] ?? "";
    const btn = stripTags(/<div class="btn_wrap"[^>]*>([\s\S]*?)<\/div>/.exec(chunk)?.[1] ?? "");
    const fish = stripTags(/<div id="fish">([\s\S]*?)<\/div>/.exec(chunk)?.[1] ?? "");
    return { shipNo: m[1], name, scheduleNo, bookable: btn.includes("바로예약"), fish };
  });
}

// 페이지 안의 `var data = {...};` 를 JSON 으로 읽는다 (문자열 안의 중괄호는 무시)
export function parseJsVar(html: string, varName = "data"): any {
  const start = html.indexOf(`var ${varName} = `);
  if (start < 0) return null;
  const open = html.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(open, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function buildSunsangPayload(form: { fields: FormField[] }, v: { people: number; name: string; phone: string; scheduleNo: string; seats?: number[] }): string {
  const m = /^(\d{3})(\d{3,4})(\d{4})$/.exec(v.phone.replace(/\D/g, ""));
  if (!m) throw new Error("휴대폰 번호 형식이 올바르지 않습니다");
  const set: Record<string, string> = { ship_schedule_no: v.scheduleNo, person_count: String(v.people), name: v.name, deposit_name: "", phone1: m[1], phone2: m[2], phone3: m[3], memo: "", price_option: "" };
  const pairs: [string, string][] = [];
  for (const f of form.fields) {
    if (f.type === "checkbox") {
      // 전체동의 + 필수 약관 3개를 모두 체크한 상태 (사이트에서 "전체동의"를 누른 것과 같음)
      if (f.name === "all_check" || f.name === "agree_rule[]") pairs.push([f.name, f.value || "on"]);
      else if (f.name === "select_seat_nos[]") {
        if (v.seats?.includes(Number(f.value))) pairs.push([f.name, f.value]);
      } else if (f.checked) pairs.push([f.name, f.value || "on"]);
    } else if (f.type === "radio") {
      if (f.checked) pairs.push([f.name, f.value]);
    } else if (f.type === "select") {
      pairs.push([f.name, (f.options?.find((o) => o.selected) ?? f.options?.[0])?.value ?? ""]);
    } else {
      pairs.push([f.name, f.name in set ? set[f.name] : f.value]);
    }
  }
  return pairs.map(([k, val]) => `${enc(k)}=${enc(val)}`).join("&");
}

// 선상24 좌석: 1..N/2 가 한 줄, N/2+1..N 이 반대 줄 (선미 쪽이 N/2 와 N/2+1 쪽). 선미에 가까운 순으로 정렬.
// 같은 거리면 sternSide=right 일 때 뒷 번호 줄(N/2+1..N)을 먼저.
export function sunsangSternOrder(seats: number[], total: number, sternSide: "right" | "left"): number[] {
  const half = Math.ceil(total / 2);
  const key = (s: number) => {
    const first = s <= half;
    const dist = first ? half - s : s - half - 1;
    const sideRank = (sternSide === "right") === !first ? 0 : 1;
    return [dist, sideRank, s];
  };
  return [...seats].sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}

export async function prepareSunsang(sess: Session, cfg: BookingConfig, ship: SunShip, log: (m: string) => void): Promise<BookingResult> {
  const page = await sess.request("GET", `/mypage/reservation_ready/${ship.scheduleNo}`, { referer: `${sess.base}/ship/schedule_fleet` });
  const data = parseJsVar(page.text, "data");
  if (!data || !data.schedule) throw new Error(`${ship.name}: 예약 화면 정보를 읽지 못했습니다${data?.message ? ` (${data.message})` : ""}`);
  if (typeof data.code !== "undefined") throw new Error(`${ship.name}: ${data.message ?? "예약 화면을 열 수 없습니다"}`);
  const sc = data.schedule;
  const fish: string[] = (sc.fish_type ?? []).map((f: any) => String(f.name));
  log(`어종: ${fish.join(", ") || ship.fish || "정보 없음"} / 남은 자리 ${sc.remain_embarkation_num}명`);
  if (!SPECIES_WORDS.some((w) => fish.join(",").includes(w)) && !/주꾸미|쭈꾸미|갑오징어|쭈갑/.test(ship.fish)) {
    throw new SkipShip(`${ship.name}: 쭈꾸미/갑오징어 어종이 아니라 건너뜁니다 (${fish.join(", ") || ship.fish})`);
  }
  if (sc.is_reservation_login) throw new Error(`${ship.name}: 로그인이 필요한 예약이라 지원하지 않습니다`);
  if (sc.is_reservation_phone_auth) throw new Error(`${ship.name}: 휴대전화 인증이 필요한 예약이라 지원하지 않습니다`);
  const remain = Number(sc.remain_embarkation_num);
  if (!(remain >= cfg.people)) throw new Error(`${ship.name}: 남은 자리 ${remain}명 — 필요 ${cfg.people}명 (대기 예약은 지원하지 않습니다)`);
  const max = Number(sc.person_per_reservation);
  if (max > 0 && cfg.people > max) throw new Error(`${ship.name}: 1회 최대 예약 인원은 ${max}명입니다`);

  const form = parseForm(page.text, "form-reservation");
  if (!form) throw new Error("예약 폼(#form-reservation)을 찾지 못했습니다");
  let seats: number[] = [];
  let seatNote = "좌석 선택 없는 배";
  const seatFields = form.fields.filter((f) => f.name === "select_seat_nos[]");
  if (seatFields.length) {
    // 선택 가능한 좌석 = 폼의 체크박스 ∩ 서버가 알려준 possible_seat_nos
    const possible: number[] | null = Array.isArray(sc.arrange_seating?.possible_seat_nos) ? sc.arrange_seating.possible_seat_nos.map(Number) : null;
    const free = new Set(seatFields.map((f) => Number(f.value)).filter((n) => Number.isFinite(n) && (!possible || possible.includes(n))));
    if (free.size < cfg.people) throw new SkipShip(`${ship.name}: 선택 가능한 좌석 ${free.size}개 — 필요 ${cfg.people}명`);
    const total = Number(sc.seating_num) || Math.max(...free);
    const order = sunsangSternOrder([...free], total, cfg.sternSide ?? "right");
    const prefer = cfg.seatMode === "none" ? [] : [...(cfg.ships.find((w) => norm(ship.name).includes(norm(w.name)))?.preferredSeats ?? []), ...(cfg.preferredSeats ?? [])];
    const pk = pickSeats(layoutSunsang([...free], total), free, cfg.people, prefer, order, cfg.sternSide ?? "right");
    seats = pk.seats;
    seatNote = (cfg.seatMode === "none" ? "좌석 선택이 필수인 배라 선미 쪽 자동 선택" : prefer.some((x) => seats.includes(x)) ? "지정 좌석 우선" : "선미 우선 자동 선택") + (pk.grouped ? " (붙어 앉는 자리)" : "") + " (선상24 좌석: 번호 구조로 추정)";
    log(`좌석 선택: ${seats.join(", ")}번`);
  }
  const payload = buildSunsangPayload(form, { people: cfg.people, name: cfg.name, phone: cfg.phone, scheduleNo: ship.scheduleNo, seats });
  const total = Number(sc.price) * cfg.people;
  const pay = data.payment;
  const depositTotal = Math.round((Number(sc.price) * cfg.people * (Number(pay?.deposit_rate) || 100)) / 100);
  const deposit = pay?.bank_account ? `${pay.bank_name ?? ""} ${pay.bank_account}${pay.bank_owner ? ` (예금주 ${pay.bank_owner})` : ""}${depositTotal > 0 ? ` · ${depositTotal.toLocaleString("ko-KR")}원` : ""}`.trim() : undefined;
  return {
    ship: { uid: ship.scheduleNo, name: `${ship.name} (${sc.sdate})` },
    species: fish.join("·"),
    people: cfg.people,
    seats,
    seatNote,
    status: `남은 자리 ${remain}명`,
    price: total > 0 ? `${total.toLocaleString("ko-KR")}원` : "",
    actionUrl: new URL("/mypage/reservation_end", sess.base).toString(),
    payload,
    unresolved: [],
    dryRun: true,
    referer: `${sess.base}/mypage/reservation_ready/${ship.scheduleNo}`,
    deposit,
  };
}

class SkipShip extends Error {}

async function runSunsang(job: Job, cfg: BookingConfig, sess: Session, log: (m: string) => void) {
  const deadline = Date.now() + (cfg.maxPollMinutes ?? 10) * 60_000;
  const nextDelay = makePoller(cfg, log);
  const skipped = new Set<string>();
  let attempt = 0;
  while (Date.now() < deadline) {
    if (job.stopRequested) throw new StopError();
    attempt++;
    const t0 = Date.now();
    let ships: SunShip[] = [];
    try {
      const r = await sess.request("GET", `/ship/schedule_fleet/${cfg.date}/0/simple_day`, { ajax: true, referer: `${sess.base}/ship/schedule_fleet` });
      ships = parseSunsangDay(r.text).filter((x) => x.scheduleNo && !skipped.has(x.scheduleNo));
    } catch (e: any) {
      log(`조회 오류: ${e.message}`);
      if (/중계기 오류\((auth|config)\)/.test(e.message)) throw e;
    }
    const open = ships.filter((x) => x.bookable);
    const hit = cfg.ships.length
      ? cfg.ships.map((w) => open.find((x) => norm(x.name).includes(norm(w.name)))).find(Boolean)
      : open[0];
    if (hit) {
      log(`예약 가능한 배 발견: ${hit.name} (일정 ${hit.scheduleNo})`);
      try {
        job.result = await prepareSunsang(sess, cfg, hit, log);
      } catch (e: any) {
        if (e instanceof SkipShip) {
          skipped.add(hit.scheduleNo);
          log(e.message);
          continue;
        }
        throw e;
      }
      log(`소요: 배 발견 후 ${Date.now() - t0}ms`);
      if (cfg.submit) {
        log(`입력 준비 완료 — ${job.result.ship.name}, ${job.result.people}명`);
        await submitFinal(job, cfg, sess, log);
        log(`소요: 배 발견부터 제출 응답까지 ${Date.now() - t0}ms`);
        return;
      }
      job.status = "done";
      log(`입력 준비 완료 — ${job.result.ship.name}, ${job.result.people}명`);
      log("테스트 모드이므로 제출하지 않았습니다.");
      if (cfg.stopOthersOnSuccess && cfg.groupId) {
        for (const o of jobs.values()) if (o.groupId === cfg.groupId && o.id !== job.id) stopJob(o.id);
      }
      return;
    }
    if (attempt % 10 === 1) log(ships.length ? `원하는 배가 아직 안 열렸습니다 (목록: ${ships.map((x) => `${x.name}${x.bookable ? "✔" : ""}`).join(", ")})` : "이 날짜의 일정이 아직 없습니다. 계속 확인합니다.");
    await sleep(Math.max(0, nextDelay() - (Date.now() - t0)) + Math.random() * 100);
  }
  throw new Error("제한 시간 안에 예약 가능한 배를 찾지 못했습니다");
}
