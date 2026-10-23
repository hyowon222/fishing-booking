// booking.ts — 선상낚시 자동 예약 엔진 (브라우저 없이 HTTP 요청만 사용)
// 대상: reservation_boat_v5.2_seat1 방식 예약 사이트 (예: mscufishing.com)
//
// ★ 지금은 "테스트 모드(dry-run)" 전용입니다. 최종 제출(popup.step1.action.php 로 POST)은 코드에 아예 없습니다.
//   좌석·인원·폼 값을 실제 사이트 응답으로 모두 만들고, "이 내용으로 제출할 것"이라는 payload 만 결과로 돌려줍니다.
//
// 닷홈 중계기(relay2.php)를 쓰려면 환경변수:
//   BOOKING_RELAY_URL   예) http://hyowon222.dothome.co.kr/relay2.php
//   BOOKING_RELAY_TOKEN relay2.php 의 RELAY_TOKEN 과 같은 값
// 둘 다 없으면 서버에서 직접 요청합니다. (개발·시험용)

import crypto from "node:crypto";

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
};

export type JobStatus = "waiting" | "polling" | "done" | "failed" | "stopped";

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
  dryRun: true;
};

export type Job = {
  id: string;
  createdAt: number;
  status: JobStatus;
  summary: string;
  log: string[];
  result?: BookingResult;
  error?: string;
  stopRequested: boolean;
};

export const SPECIES_WORDS = ["쭈꾸미", "주꾸미", "갑오징어", "쭈갑"];
const MODULE = "/_core/module/reservation_boat_v5.2_seat1";
const KNOWN_SEEDS = ["2955", "4443", "2954", "5866", "5579", "3570", "2961", "2956", "2950", "6407", "5578", "4920", "5679", "5891", "3571"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 전송 (중계기 암호화 + 쿠키 + 리다이렉트)
type RawResponse = { status: number; location: string; contentType: string; setCookies: string[]; body: Buffer };

async function relayCall(
  url: string,
  method: "GET" | "POST",
  opts: { body?: string; headers?: Record<string, string>; referer?: string; cookie?: string },
): Promise<RawResponse> {
  const relayUrl = process.env.BOOKING_RELAY_URL;
  const token = process.env.BOOKING_RELAY_TOKEN;
  if (relayUrl && token) {
    const key = crypto.createHash("sha256").update(token).digest();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    const plain = JSON.stringify({
      ts: Math.floor(Date.now() / 1000),
      url,
      method,
      headers: opts.headers ?? {},
      body: opts.body ?? "",
      referer: opts.referer ?? "",
      cookie: opts.cookie ?? "",
    });
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    const res = await fetch(relayUrl, {
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
    const p = JSON.parse(Buffer.concat([d.update(Buffer.from(j.ct, "base64")), d.final()]).toString("utf8"));
    return {
      status: p.status,
      location: p.location ?? "",
      contentType: p.contentType ?? "",
      setCookies: p.setCookies ?? [],
      body: Buffer.from(p.bodyBase64 ?? "", "base64"),
    };
  }
  // 직접 요청 (중계기 미설정)
  const headers: Record<string, string> = { "user-agent": UA, "accept-language": "ko-KR,ko;q=0.9", ...(opts.headers ?? {}) };
  if (opts.referer) headers.referer = opts.referer;
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await fetch(url, { method, headers, body: method === "POST" ? opts.body ?? "" : undefined, redirect: "manual", signal: AbortSignal.timeout(20_000) });
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

export class Session {
  private jar = new Map<string, string>();
  base: string;
  constructor(base: string) {
    this.base = base;
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

  async request(method: "GET" | "POST", path: string, opts: { body?: string; ajax?: boolean; referer?: string } = {}): Promise<{ status: number; text: string; url: string }> {
    let url = path.startsWith("http") ? path : this.base + path;
    let m = method;
    let body = opts.body;
    for (let hop = 0; hop < 5; hop++) {
      const headers: Record<string, string> = {};
      if (m === "POST") headers["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      if (opts.ajax) headers["x-requested-with"] = "XMLHttpRequest";
      const r = await relayCall(url, m, { body, headers, referer: opts.referer ?? this.base + "/", cookie: this.cookieHeader() });
      this.store(r.setCookies);
      if ([301, 302, 303, 307, 308].includes(r.status) && r.location) {
        url = new URL(r.location, url).toString();
        if (r.status !== 307 && r.status !== 308) {
          m = "GET";
          body = undefined;
        }
        continue;
      }
      return { status: r.status, text: decodeBody(r), url };
    }
    throw new Error("이동(리다이렉트)이 너무 많습니다");
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

type FormField = { name: string; type: string; value: string; checked: boolean; options?: { value: string; selected: boolean }[] };

export function parseForm(html: string): { action: string; fields: FormField[] } | null {
  const fm = /<form\b[^>]*\bid\s*=\s*["']insert_form["'][^>]*>([\s\S]*?)<\/form>/i.exec(html);
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
  for (const w of wishes) {
    const hit = open.find((o) => (w.uid ? o.value === w.uid : norm(o.label).includes(norm(w.name))));
    if (hit) return { choice: hit, wish: w };
  }
  return null;
}

export async function prepareBooking(sess: Session, cfg: BookingConfig, found: { choice: Choice; wish: ShipWish }, log: (m: string) => void): Promise<BookingResult> {
  const { choice, wish } = found;
  const uid = choice.value;
  // 낚시 종류 (쭈꾸미·갑오징어만)
  let page = await sess.request("GET", `${MODULE}/popup.step1.php?date=${cfg.date}&PA_N_UID=${uid}&PH_N_UID=0`);
  const types = parseRadios(page.text, "PS_N_UID");
  log(`낚시 종류: ${types.map((t) => t.label).join(" | ") || "없음"}`);
  const type = types.find((t) => SPECIES_WORDS.some((w) => t.label.includes(w)));
  if (!type) throw new Error(`${choice.label}: 쭈꾸미/갑오징어 낚시종류가 없어 중단합니다`);
  page = await sess.request("GET", `${MODULE}/popup.step1.php?date=${cfg.date}&PA_N_UID=${uid}&PH_N_UID=0&PS_N_UID=${type.value}`);
  const html = page.text;

  // 인원 → 상태 확인 (사이트가 인원 선택 시 하는 요청과 같음)
  const naun = /naun=(\d+)/.exec(html)?.[1] ?? "1";
  const ajax = await sess.request("POST", `${MODULE}/action/popup.step1.ajax.php`, {
    ajax: true,
    body: `date=${cfg.date}&PA_N_UID=${uid}&PH_N_UID=0&PS_N_UID=${type.value}&BI_IN=${cfg.people}&BI_SO_IN=N&pay_method=&naun=${naun}`,
  });
  const parts = ajax.text.split("|^|");
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
    seats = chooseSeats(free, cfg.people, [...(wish.preferredSeats ?? []), ...(cfg.preferredSeats ?? [])], order);
    if (seats.length < cfg.people) throw new Error(`빈 좌석 부족: 필요 ${cfg.people}, 가능 ${seats.length}`);
    seatNote = `빈 좌석 ${free.size}개 중 선미 우선으로 선택`;
  }

  // 제출 폼
  const form = parseForm(html);
  if (!form) throw new Error("예약 폼(#insert_form)을 찾지 못했습니다");
  // seat[] 칸(hidden, id = 's'+날짜+배번호+좌석번호)마다 선택된 번호만 값으로 채움 — 브라우저 전송과 같은 형태
  const seatValues = seatValuesFor(html, cfg.date, uid, new Set(seats));
  const { payload, unresolved } = buildPayload(form, { people: cfg.people, name: cfg.name, phone: cfg.phone, seatValues, tempStat: status, agreeAll: true, shipUid: uid, typeUid: type.value });

  return {
    ship: { uid, name: choice.label },
    species: type.label,
    people: cfg.people,
    seats,
    seatNote,
    status,
    price,
    actionUrl: new URL(form.action, sess.base).toString(),
    payload,
    unresolved,
    dryRun: true,
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

// ------------------------------------------------------------------ 작업(Job) 관리
const jobs = new Map<string, Job>();
const MAX_JOBS = 20;

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

export function validateConfig(raw: any): BookingConfig {
  const base = String(raw?.baseUrl ?? "http://www.mscufishing.com").replace(/\/$/, "");
  if (!/^https?:\/\/(www\.)?mscufishing\.com$/i.test(base) && base !== process.env.BOOKING_TEST_BASE) throw new Error("지원하지 않는 예약처입니다");
  const date = String(raw?.date ?? "").replace(/\D/g, "");
  if (!/^\d{8}$/.test(date)) throw new Error("날짜는 YYYYMMDD 형식이어야 합니다");
  const ships: ShipWish[] = (Array.isArray(raw?.ships) ? raw.ships : [])
    .map((s: any) => ({ name: String(s?.name ?? "").trim(), uid: s?.uid ? String(s.uid) : undefined, preferredSeats: Array.isArray(s?.preferredSeats) ? s.preferredSeats.map(Number).filter(Number.isFinite) : undefined }))
    .filter((s: ShipWish) => s.name || s.uid);
  if (!ships.length) throw new Error("배를 한 척 이상 입력하세요");
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
  return {
    baseUrl: base,
    date,
    ships,
    people,
    seatMode: raw?.seatMode === "none" ? "none" : "auto",
    preferredSeats: Array.isArray(raw?.preferredSeats) ? raw.preferredSeats.map(Number).filter(Number.isFinite) : [],
    sternSide: raw?.sternSide === "left" ? "left" : "right",
    name,
    phone: String(raw.phone),
    openAt,
    warmupSeconds: Math.min(60, Math.max(0, Number(raw?.warmupSeconds ?? 5))),
    pollMs: Math.max(800, Number(raw?.pollMs ?? 1000)), // 선사 서버 부담을 줄이기 위해 0.8초 미만으로는 조회하지 않음
    maxPollMinutes: Math.min(60, Math.max(1, Number(raw?.maxPollMinutes ?? 10))),
    seedUids: Array.isArray(raw?.seedUids) && raw.seedUids.length ? raw.seedUids.map(String) : undefined,
  };
}

export function startJob(cfg: BookingConfig): Job {
  if ([...jobs.values()].filter((j) => ["waiting", "polling"].includes(j.status)).length >= 3) throw new Error("동시에 진행 중인 작업은 3개까지입니다");
  if (jobs.size >= MAX_JOBS) {
    const oldest = [...jobs.values()].filter((j) => !["waiting", "polling"].includes(j.status)).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) jobs.delete(oldest.id);
  }
  const id = crypto.randomBytes(6).toString("hex");
  const job: Job = {
    id,
    createdAt: Date.now(),
    status: "waiting",
    summary: `${cfg.date} ${cfg.ships.map((s) => s.name || s.uid).join(" > ")} · ${cfg.people}명`,
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
  try {
    log("테스트 모드: 최종 제출은 하지 않습니다.");
    if (cfg.openAt) {
      const target = new Date(cfg.openAt).getTime() - (cfg.warmupSeconds ?? 5) * 1000;
      log(`오픈(${new Date(cfg.openAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}) 전까지 대기합니다.`);
      while (Date.now() < target) {
        if (job.stopRequested) throw new StopError();
        await sleep(Math.min(1000, Math.max(50, target - Date.now())));
      }
    }
    job.status = "polling";
    const deadline = Date.now() + (cfg.maxPollMinutes ?? 10) * 60_000;
    const seeds = [...new Set([...(cfg.ships.map((s) => s.uid).filter(Boolean) as string[]), ...(cfg.seedUids ?? KNOWN_SEEDS)])];
    let workingSeed: string | null = null;
    let attempt = 0;
    while (Date.now() < deadline) {
      if (job.stopRequested) throw new StopError();
      attempt++;
      let open: Choice[] = [];
      try {
        const r = workingSeed ? await sess.request("GET", `${MODULE}/popup.step1.php?date=${cfg.date}&PA_N_UID=${workingSeed}`) : null;
        if (r && /id\s*=\s*["']insert_form["']/.test(r.text)) open = parseRadios(r.text, "PA_N_UID");
        else {
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
        job.result = await prepareBooking(sess, cfg, hit, log);
        job.status = "done";
        log(`입력 준비 완료 — ${job.result.ship.name}, ${job.result.species}, ${job.result.people}명, 좌석: ${job.result.seats.join(",") || "미선택"}`);
        log("테스트 모드이므로 제출하지 않았습니다.");
        return;
      }
      if (attempt % 10 === 1 && open.length) log(`원하는 배가 아직 안 열렸습니다 (열린 배: ${open.map((o) => o.label).join(", ")})`);
      await sleep(cfg.pollMs! + Math.random() * 300);
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
