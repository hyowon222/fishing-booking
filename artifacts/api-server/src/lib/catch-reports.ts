// lib/catch-reports.ts — 조황(조과) 기록과 "조황이 좋았던 날" 모아 보기
//   기록은 DB 의 catch_reports 표에 저장한다 (직접 입력 / 이후 사이트에서 가져온 것).
//   좋았던 날 = ① 그 항구·그날의 마릿수 합이 기간 안에서 상위 20% 이거나
//               ② 메모·어종에 "대박/만선/호황…" 같은 좋다는 표현이 있거나
//               ③ 기록할 때 "조황 좋음"을 직접 표시한 날
//   각 좋았던 날에 물때·조류 세기·날씨(바다타임 자료)를 붙여 준다.

import { pool } from "@workspace/db";
import { lunarLabel, lunarOf, sameLunarLastYear } from "./lunar";
import { TIDE_PORTS, getTideMonth } from "./tide-table";

let ready: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  ready ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS catch_reports (
         id serial PRIMARY KEY,
         fish_date date NOT NULL,
         port text NOT NULL,
         vessel text NOT NULL DEFAULT '',
         species text NOT NULL DEFAULT '',
         fish_count integer,
         note text NOT NULL DEFAULT '',
         marked_good boolean NOT NULL DEFAULT false,
         source text NOT NULL DEFAULT 'manual',
         created_by text NOT NULL DEFAULT '',
         created_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    .then(() => undefined)
    .catch((err) => {
      ready = null;
      throw err;
    });
  return ready;
}

export type CatchReport = {
  id: number;
  date: string;
  port: string;
  vessel: string;
  species: string;
  count: number | null;
  note: string;
  markedGood: boolean;
  source: string;
};

const iso = (v: unknown): string => {
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  return String(v).slice(0, 10);
};

function rowToReport(r: any): CatchReport {
  return {
    id: r.id,
    date: iso(r.fish_date),
    port: r.port,
    vessel: r.vessel,
    species: r.species,
    count: r.fish_count,
    note: r.note,
    markedGood: r.marked_good,
    source: r.source,
  };
}

export async function listReports(from: string, to: string): Promise<CatchReport[]> {
  await ensureTable();
  const r = await pool.query("SELECT * FROM catch_reports WHERE fish_date BETWEEN $1 AND $2 ORDER BY fish_date DESC, id DESC", [from, to]);
  return r.rows.map(rowToReport);
}

export type NewReport = { date: string; port: string; vessel?: string; species?: string; count?: number | null; note?: string; markedGood?: boolean };

export function validateReport(b: any): { ok: true; value: NewReport } | { ok: false; error: string } {
  if (!b || typeof b !== "object") return { ok: false, error: "내용이 비었어요" };
  if (typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return { ok: false, error: "날짜를 입력하세요" };
  if (typeof b.port !== "string" || !TIDE_PORTS.includes(b.port)) return { ok: false, error: `항구는 ${TIDE_PORTS.join(", ")} 중에서 골라 주세요` };
  const count = b.count === null || b.count === undefined || b.count === "" ? null : Number(b.count);
  if (count !== null && (!Number.isInteger(count) || count < 0 || count > 100000)) return { ok: false, error: "마릿수는 0 이상의 숫자로 입력하세요" };
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  return {
    ok: true,
    value: { date: b.date, port: b.port, vessel: text(b.vessel, 40), species: text(b.species, 40), count, note: text(b.note, 300), markedGood: b.markedGood === true },
  };
}

export async function addReport(v: NewReport, by: string, source = "manual"): Promise<void> {
  await ensureTable();
  await pool.query(
    "INSERT INTO catch_reports (fish_date, port, vessel, species, fish_count, note, marked_good, source, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [v.date, v.port, v.vessel ?? "", v.species ?? "", v.count ?? null, v.note ?? "", v.markedGood === true, source, by],
  );
}

export async function setMarkedGood(id: number, good: boolean): Promise<void> {
  await ensureTable();
  await pool.query("UPDATE catch_reports SET marked_good = $2 WHERE id = $1", [id, good]);
}

export async function deleteReport(id: number): Promise<void> {
  await ensureTable();
  await pool.query("DELETE FROM catch_reports WHERE id = $1", [id]);
}

// 조황이 좋았다는 표현. 모자란 말이 있으면 여기에 | 로 이어서 추가하면 된다.
const GOOD_WORDS = /대박|호황|만선|만쿨(?:러)?|만클|가득|와우|와[!~]|폭조|넘치|풍년|대량|폭발|입질\s*(?:좋|폭발)|잘\s*나|많이\s*잡|터졌|터짐|쿨러\s*꽉/;

export type GoodDay = {
  date: string;
  weekday: string;
  port: string;
  totalCount: number | null;
  reasons: string[];
  vessels: string[];
  species: string[];
  reports: CatchReport[];
  mulddae: string | null;
  flowPercent: number | null;
  flowLabel: string | null;
  weather: { am: string; pm: string } | null;
  tideRange: number | null;
  tideNote: string | null;
  lunar: string | null;
  lunarLastYear: string | null;
};

export type Insights = {
  from: string;
  to: string;
  totalReports: number;
  days: GoodDay[];
  byMulddae: Array<{ label: string; days: number }>;
  byFlow: Array<{ label: string; days: number }>;
  byPort: Array<{ label: string; days: number }>;
  byRange: Array<{ label: string; days: number }>;
  byLunarMonth: Array<{ label: string; days: number }>;
  byLunarPart: Array<{ label: string; days: number }>;
  topPercent: number;
};

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export async function buildInsights(from: string, to: string, port: string | null, topPercent = 20): Promise<Insights> {
  const all = (await listReports(from, to)).filter((r) => !port || r.port === port);
  const groups = new Map<string, CatchReport[]>();
  for (const r of all) {
    const k = `${r.date}|${r.port}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const totals = [...groups.entries()].map(([k, rs]) => ({ k, rs, total: rs.some((x) => x.count !== null) ? rs.reduce((a, x) => a + (x.count ?? 0), 0) : null }));
  // 마릿수 기록이 있는 그날들 중 상위 N% 의 기준값 (같은 값은 같이 포함)
  const counted = totals.filter((t) => t.total !== null && t.total > 0).map((t) => t.total!).sort((a, b) => b - a);
  const keep = counted.length ? Math.max(1, Math.ceil((counted.length * topPercent) / 100)) : 0;
  const threshold = keep ? counted[keep - 1]! : Infinity;

  const good: GoodDay[] = [];
  for (const t of totals) {
    const reasons: string[] = [];
    if (t.total !== null && t.total > 0 && t.total >= threshold) reasons.push(`마릿수 상위 ${topPercent}% (${t.total}마리)`);
    if (t.rs.some((x) => GOOD_WORDS.test(`${x.note} ${x.species}`))) reasons.push("조황 글에 좋다는 표현");
    if (t.rs.some((x) => x.markedGood)) reasons.push("직접 ‘조황 좋음’ 표시");
    if (!reasons.length) continue;
    const [date, p] = t.k.split("|") as [string, string];
    good.push({
      date,
      weekday: WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!,
      port: p,
      totalCount: t.total,
      reasons,
      vessels: [...new Set(t.rs.map((x) => x.vessel).filter(Boolean))],
      species: [...new Set(t.rs.map((x) => x.species).filter(Boolean))],
      reports: t.rs,
      mulddae: null,
      flowPercent: null,
      flowLabel: null,
      weather: null,
      tideRange: null,
      tideNote: null,
      lunar: null,
      lunarLastYear: null,
    });
  }
  good.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // 물때·조류·날씨는 (항구, 연-월) 별로 한 번만 불러온다
  const needed = [...new Set(good.map((g) => `${g.port}|${g.date.slice(0, 7)}`))];
  const tideByKey = new Map<string, Awaited<ReturnType<typeof getTideMonth>>>();
  for (const key of needed) {
    const [p, ym] = key.split("|") as [string, string];
    tideByKey.set(key, await getTideMonth(p, Number(ym.slice(0, 4)), Number(ym.slice(5, 7))));
  }
  for (const g of good) {
    const lu = lunarOf(g.date);
    if (lu) {
      g.lunar = lunarLabel(lu);
      g.lunarLastYear = sameLunarLastYear(g.date);
    }
    const month = tideByKey.get(`${g.port}|${g.date.slice(0, 7)}`);
    const day = month?.days.find((d) => d.date === g.date);
    if (day) {
      g.mulddae = day.mulddae;
      g.flowPercent = day.flowPercent;
      g.flowLabel = day.flowLabel;
      g.weather = day.weather;
      g.tideRange = day.range;
    } else {
      g.tideNote = month?.message ?? "그날 물때 자료를 찾지 못했어요";
    }
  }

  const tally = (pick: (g: GoodDay) => string | null, order?: (a: string, b: string) => number) => {
    const m = new Map<string, number>();
    for (const g of good) {
      const k = pick(g);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].map(([label, days]) => ({ label, days })).sort((a, b) => (order ? order(a.label, b.label) : b.days - a.days));
  };
  const num = (t: string) => Number(/\d+/.exec(t)?.[0] ?? 0);
  const rangeBucket = (g: GoodDay) => (g.tideRange === null ? null : `${Math.floor(g.tideRange / 100) * 100}~${Math.floor(g.tideRange / 100) * 100 + 99}cm`);
  const lunarMonth = (g: GoodDay) => {
    const l = lunarOf(g.date);
    return l ? `음력 ${l.leap ? "윤" : ""}${l.month}월` : null;
  };
  const lunarPart = (g: GoodDay) => {
    const l = lunarOf(g.date);
    return l ? (l.day <= 10 ? "초순 (1~10일)" : l.day <= 20 ? "중순 (11~20일)" : "하순 (21~30일)") : null;
  };
  const flowBucket = (g: GoodDay) => (g.flowPercent === null ? null : g.flowPercent >= 80 ? "강함 (80% 이상)" : g.flowPercent >= 50 ? "보통 (50~79%)" : "약함 (50% 미만)");
  return {
    from,
    to,
    totalReports: all.length,
    days: good,
    byMulddae: tally((g) => g.mulddae),
    byFlow: tally(flowBucket),
    byPort: tally((g) => g.port),
    byRange: tally(rangeBucket, (a, b) => num(a) - num(b)),
    byLunarMonth: tally(lunarMonth, (a, b) => num(a) - num(b) || a.localeCompare(b)),
    byLunarPart: tally(lunarPart, (a, b) => num(a) - num(b)),
    topPercent,
  };
}
