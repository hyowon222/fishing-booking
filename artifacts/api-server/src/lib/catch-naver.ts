// lib/catch-naver.ts — 네이버 검색 API(블로그·카페)에서 공개된 조황 글을 찾아 조황 기록에 넣는다
//   필요한 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET (developers.naver.com 의 "검색" API)
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
const FISH_QUERY = ["쭈꾸미 조황", "갑오징어 조황", "쭈갑 조황"];
const IS_REPORT = /조황|조과|출조|마릿수|조행|쭈꾸미|주꾸미|갑오징어|쭈갑/;

export type NaverItem = { title: string; description: string; link: string; postdate?: string };
export type NaverResult = { queries: number; items: number; added: number; skipped: number; failed: number; error?: string };

export function naverConfigured(): boolean {
  return !!process.env.NAVER_CLIENT_ID && !!process.env.NAVER_CLIENT_SECRET;
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

async function search(kind: "blog" | "cafe", query: string, fetcher: typeof fetch): Promise<NaverItem[]> {
  const url = `https://openapi.naver.com/v1/search/${kind === "blog" ? "blog" : "cafearticle"}.json?query=${encodeURIComponent(query)}&display=100&sort=date`;
  const r = await fetcher(url, {
    headers: { "X-Naver-Client-Id": process.env.NAVER_CLIENT_ID ?? "", "X-Naver-Client-Secret": process.env.NAVER_CLIENT_SECRET ?? "" },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(r.status === 401 || r.status === 403 ? "네이버 API 키가 올바르지 않거나 검색 API 권한이 없어요" : `네이버 검색 오류 (${r.status}) ${body.slice(0, 80)}`);
  }
  const j = (await r.json()) as { items?: NaverItem[] };
  return j.items ?? [];
}

export async function collectNaver(since: string, by: string, fetcher: typeof fetch = fetch): Promise<NaverResult> {
  const out: NaverResult = { queries: 0, items: 0, added: 0, skipped: 0, failed: 0 };
  if (!naverConfigured()) {
    out.error = "NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 없어요";
    return out;
  }
  const seen = new Set<string>();
  for (const port of TIDE_PORTS) {
    for (const f of FISH_QUERY) {
      for (const kind of ["blog", "cafe"] as const) {
        out.queries++;
        let items: NaverItem[] = [];
        try {
          items = await search(kind, `${PORT_WORDS[port]![0]} ${f}`, fetcher);
        } catch (e: any) {
          out.error = e?.message ?? String(e);
          if (/키가|권한/.test(out.error!)) return out;
          out.failed++;
          continue;
        }
        for (const it of items) {
          out.items++;
          const key = `naver:${it.link}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const rep = itemToReport(it, port, kind, since);
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
      }
    }
  }
  return out;
}
