// lib/catch-naver.ts — 네이버 검색 API(블로그·카페)에서 공개된 조황 글을 찾아 조황 기록에 넣는다
//   필요한 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET (네이버 클라우드 플랫폼 NAVER API HUB 의 검색 API 인증 정보)
//   블로그는 작성일(postdate)이 오고, 카페 글은 날짜가 안 와서 제목·요약에 날짜가 적힌 글만 쓴다.

import { pool } from "@workspace/db";
import { TIDE_PORTS } from "./tide-table";
import { addReport } from "./catch-reports";
import { parsePost } from "./catch-paste";

const strip = (t: string) =>
  t
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const PORT_WORDS: Record<string, string[]> = {
  삼길포: ["삼길포"],
  대천항: ["대천항", "대천"],
  신진도: ["신진도"],
  오천항: ["오천항", "오천"],
  마검포: ["마검포"],
};
// 기본 검색어 + 시즌 월별 검색어(예: "쭈갑 10월 조황")를 합쳐서 더 옛날 글까지 찾는다
const BASE_QUERY = ["쭈꾸미 조황", "갑오징어 조황", "쭈갑 조황", "쭈꾸미 낚시", "갑오징어 낚시", "쭈갑 출조", "쭈꾸미 마릿수"];
const PAGE_SIZE = 100;
const MAX_PAGES = 3; // 네이버 검색은 start 로 다음 100건씩 넘길 수 있다 (최대 300건)

export function fishQueries(since: string, now = new Date()): string[] {
  const out = [...BASE_QUERY];
  const sy = Number(since.slice(0, 4));
  const sm = Number(since.slice(5, 7));
  const ey = now.getFullYear();
  const em = now.getMonth() + 1;
  for (let y = sy, m = sm; y < ey || (y === ey && m <= em); m++) {
    if (m > 12) {
      y++;
      m = 0;
      continue;
    }
    out.push(`쭈갑 ${m}월 조황`, `쭈꾸미 ${m}월 조황`, `갑오징어 ${m}월 조황`);
  }
  return out;
}
const IS_REPORT = /조황|조과|출조|마릿수|조행|쭈꾸미|주꾸미|갑오징어|쭈갑/;

export type NaverItem = { title: string; description: string; link: string; postdate?: string };
export type NaverResult = { queries: number; items: number; added: number; skipped: number; failed: number; error?: string };

// 환경변수 앞뒤의 공백·따옴표는 지우고 쓴다 (붙여넣다 들어간 경우가 많다)
function naverEnv(): { id: string; secret: string } {
  const clean = (v: string | undefined) => (v ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
  return { id: clean(process.env.NAVER_CLIENT_ID), secret: clean(process.env.NAVER_CLIENT_SECRET) };
}

export function naverConfigured(): boolean {
  const e = naverEnv();
  return !!e.id && !!e.secret;
}

// 검색 결과 한 건을 조황 기록으로 바꾼다 (쓸 수 없으면 null)
export function itemToReport(it: NaverItem, port: string, kind: "blog" | "cafe", since: string, now = new Date()) {
  const text = `${strip(it.title)} ${strip(it.description)}`;
  if (!IS_REPORT.test(text)) return null;
  if (!PORT_WORDS[port]!.some((w) => text.includes(w))) return null;
  let block = text;
  const hasDate = /\d{1,2}\s*[./월]\s*\d{1,2}/.test(text);
  if (!hasDate && kind === "blog" && it.postdate && /^\d{8}$/.test(it.postdate)) {
    const d = it.postdate;
    block = `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)} ${text}`;
  }
  const p = parsePost(block, port, now);
  if (!p || p.date < since) return null;
  const tag = kind === "blog" ? "블로그" : "카페";
  return { ...p, note: `[${tag}] ${p.note}`.slice(0, 300), port };
}

// 기본은 NAVER API HUB(네이버 클라우드 플랫폼), NAVER_API_MODE=legacy 이면 예전 개발자센터 주소를 쓴다
async function search(kind: "blog" | "cafe", query: string, fetcher: typeof fetch, start = 1): Promise<NaverItem[]> {
  const e = naverEnv();
  const legacy = (process.env.NAVER_API_MODE ?? "").trim().toLowerCase() === "legacy";
  const q = `query=${encodeURIComponent(query)}&display=${PAGE_SIZE}&start=${start}&sort=date`;
  const url = legacy
    ? `https://openapi.naver.com/v1/search/${kind === "blog" ? "blog" : "cafearticle"}.json?${q}`
    : `https://naverapihub.apigw.ntruss.com/search/v1/${kind === "blog" ? "blog" : "cafearticle"}?${q}`;
  const headers: Record<string, string> = legacy
    ? { "X-Naver-Client-Id": e.id, "X-Naver-Client-Secret": e.secret }
    : { "X-NCP-APIGW-API-KEY-ID": e.id, "X-NCP-APIGW-API-KEY": e.secret };
  let r = await fetcher(url, { headers });
  if (r.status === 429) {
    // 너무 빨리 불렀을 때는 잠깐 쉬었다가 한 번 더
    await new Promise((res) => setTimeout(res, 1500));
    r = await fetcher(url, { headers });
  }
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    let code = "";
    let msg = "";
    try {
      const j = JSON.parse(body) as { errorCode?: string; errorMessage?: string; error?: { errorCode?: string; message?: string } };
      code = j.errorCode ?? j.error?.errorCode ?? "";
      msg = j.errorMessage ?? j.error?.message ?? "";
    } catch {
      msg = body.slice(0, 120);
    }
    const detail = `HTTP ${r.status} · 응답: ${code} ${msg}`.trim();
    if (r.status === 401 || r.status === 403) {
      throw new Error(`네이버가 키를 거절했어요 (${detail}) · ${legacy ? "개발자센터" : "API HUB"} 방식 · 서버에 들어간 ID ${e.id.length}자, Secret ${e.secret.length}자 · API HUB에서 블로그·카페글 검색 API를 신청하고 애플리케이션에 선택했는지 확인해 주세요`);
    }
    throw new Error(`네이버 검색 오류 (${detail})`);
  }
  const j = (await r.json()) as { items?: NaverItem[] };
  return j.items ?? [];
}

export async function collectNaver(since: string, by: string, fetcher: typeof fetch = fetch, onProgress?: (r: NaverResult, total: number) => void): Promise<NaverResult> {
  const out: NaverResult = { queries: 0, items: 0, added: 0, skipped: 0, failed: 0 };
  if (!naverConfigured()) {
    out.error = "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 없어요";
    return out;
  }
  const seen = new Set<string>();
  const tasks: Array<{ port: string; f: string; kind: "blog" | "cafe" }> = [];
  for (const port of TIDE_PORTS) for (const f of fishQueries(since)) for (const kind of ["blog", "cafe"] as const) tasks.push({ port, f, kind });
  let stop = false;
  const runOne = async (t: { port: string; f: string; kind: "blog" | "cafe" }) => {
    if (stop) return;
    let items: NaverItem[] = [];
    try {
      // 100건이 꽉 차 있고 아직 시작일보다 최근 글이면 다음 100건도 가져온다
      for (let page = 0; page < MAX_PAGES; page++) {
        const got = await search(t.kind, `${PORT_WORDS[t.port]![0]} ${t.f}`, fetcher, page * PAGE_SIZE + 1);
        items.push(...got);
        if (got.length < PAGE_SIZE) break;
        const dated = got.map((g) => g.postdate).filter((d): d is string => !!d && /^\d{8}$/.test(d));
        const oldest = dated.sort()[0];
        if (oldest && `${oldest.slice(0, 4)}-${oldest.slice(4, 6)}-${oldest.slice(6, 8)}` < since) break;
      }
    } catch (e: any) {
      out.error = e?.message ?? String(e);
      if (/거절/.test(out.error!)) stop = true;
      out.failed++;
      out.queries++;
      onProgress?.(out, tasks.length);
      return;
    }
    for (const it of items) {
      out.items++;
      const key = `naver:${it.link}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rep = itemToReport(it, t.port, t.kind, since);
      if (!rep) {
        out.skipped++;
        continue;
      }
      try {
        const ex = await pool.query("SELECT 1 FROM catch_reports WHERE source = $1 LIMIT 1", [key]).catch(() => ({ rows: [] as unknown[] }));
        if (ex.rows.length) {
          out.skipped++;
          continue;
        }
        await addReport({ date: rep.date, port: rep.port, vessel: "", species: rep.species, count: rep.count, note: rep.note, markedGood: false }, by, key);
        out.added++;
      } catch {
        out.failed++;
      }
    }
    out.queries++;
    onProgress?.(out, tasks.length);
  };
  // 검색을 4개씩 동시에 돌려서 시간을 줄인다
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < tasks.length && !stop) await runOne(tasks[next++]!);
    }),
  );
  return out;
}

// 오래 걸릴 수 있어서 서버가 뒤에서 돌리고, 화면은 진행 상황만 물어본다
export type NaverJob = { running: boolean; total: number; startedAt: number | null; finishedAt: number | null; result: NaverResult | null };
const job: NaverJob = { running: false, total: 0, startedAt: null, finishedAt: null, result: null };

export function naverJobStatus(): NaverJob {
  return job;
}

export function startNaverJob(since: string, by: string): boolean {
  if (job.running) return false;
  job.running = true;
  job.total = TIDE_PORTS.length * fishQueries(since).length * 2;
  job.startedAt = Date.now();
  job.finishedAt = null;
  job.result = { queries: 0, items: 0, added: 0, skipped: 0, failed: 0 };
  void collectNaver(since, by, fetch, (r) => {
    job.result = { ...r };
  })
    .then((r) => {
      job.result = r;
    })
    .catch((e) => {
      job.result = { ...(job.result ?? { queries: 0, items: 0, added: 0, skipped: 0, failed: 0 }), error: e?.message ?? String(e) };
    })
    .finally(() => {
      job.running = false;
      job.finishedAt = Date.now();
    });
  return true;
}
