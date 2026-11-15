// lib/catch-collect.ts — 선상24 예약처의 "조황" 게시판 글을 읽어 조황 기록(catch_reports)에 넣는다
//   게시판: /ship/board (목록), /ship/board_detail/{번호} (글). 제목 예: "11. 12일 삼길포 뉴항구1호 조황"
//   글 본문에서 마릿수·어종을 찾을 수 있으면 넣고, 본문 문장은 메모로 저장해서 "대박/만선" 같은 표현으로 좋은 날을 가려낸다.

import { pool } from "@workspace/db";
import { Session } from "./booking";
import { TIDE_PORTS } from "./tide-table";
import { addReport } from "./catch-reports";

const strip = (t: string) =>
  t
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const SPECIES = ["쭈꾸미", "주꾸미", "갑오징어", "문어", "한치", "오징어", "갈치", "우럭", "광어", "노래미", "도다리", "대구", "민어", "참돔", "삼치", "농어"];

export type CollectResult = { host: string; pagesRead: number; postsFound: number; added: number; skipped: number; failed: number; note?: string };

let lastRun = 0;

export function parseTitle(title: string): { month: number; day: number; port: string; vessel: string } | null {
  const m = /(\d{1,2})\s*\.\s*(\d{1,2})\s*일\s*(.*?)\s*조황/.exec(title);
  if (!m) return null;
  const rest = m[3]!.trim();
  // 제목에 항구가 없으면(예: "10. 25일 레전드호 조황") 빈 값으로 두고, 글 화면의 사이트 이름에서 찾는다
  const port = TIDE_PORTS.find((p) => rest.includes(p)) ?? "";
  return { month: Number(m[1]), day: Number(m[2]), port, vessel: (port ? rest.replace(port, "") : rest).trim().slice(0, 40) };
}

export function parseBody(text: string): { regDate: string | null; note: string; count: number | null; species: string } {
  const reg = /등록일\s*:\s*(\d{4})-(\d{2})-(\d{2})/.exec(text);
  let body = "";
  if (reg) {
    const after = text.slice(reg.index + reg[0].length);
    const end = after.search(/이전글|다음글|목록/);
    body = (end >= 0 ? after.slice(0, end) : after).trim();
  }
  const nums = [...body.matchAll(/(\d{1,4})\s*(?:마리|수|미)(?![가-힣])/g)].map((m) => Number(m[1]));
  const count = nums.length ? Math.max(...nums) : null;
  const species = SPECIES.filter((s) => body.includes(s)).slice(0, 3).join(", ");
  return { regDate: reg ? `${reg[1]}-${reg[2]}-${reg[3]}` : null, note: body.slice(0, 300), count, species };
}

export async function collectSunsang(base: string, since: string, by: string): Promise<CollectResult> {
  const host = new URL(base).hostname;
  const out: CollectResult = { host, pagesRead: 0, postsFound: 0, added: 0, skipped: 0, failed: 0 };
  const seen = new Map<string, string>(); // 글 번호 -> 제목
  const session = new Session(base);
  const paths = ["/ship/board", ...Array.from({ length: 5 }, (_, i) => `/ship/board?page=${i + 2}`)];
  for (const p of paths) {
    let text = "";
    try {
      text = (await session.request("GET", p)).text;
    } catch {
      break;
    }
    out.pagesRead++;
    const before = seen.size;
    for (const m of text.matchAll(/<a\b[^>]*href=["'][^"']*board_detail\/(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const t = strip(m[2]!);
      if (t && !seen.has(m[1]!)) seen.set(m[1]!, t);
    }
    if (seen.size === before) break; // 새 글이 없으면 (끝이거나 페이지 주소가 달라서) 멈춘다
  }
  out.postsFound = seen.size;
  const today = new Date();
  for (const [id, title] of seen) {
    const t = parseTitle(title);
    if (!t) {
      out.skipped++;
      continue;
    }
    const source = `site:${host}:${id}`;
    try {
      const exists = await pool.query("SELECT 1 FROM catch_reports WHERE source = $1 LIMIT 1", [source]).catch(() => ({ rows: [] as unknown[] }));
      if (exists.rows.length) {
        out.skipped++;
        continue;
      }
      const page = await session.request("GET", `/ship/board_detail/${id}`);
      const plain = strip(page.text);
      const b = parseBody(plain);
      const port = t.port || TIDE_PORTS.find((p) => plain.includes(p)) || "";
      if (!port) {
        out.skipped++;
        continue;
      }
      let year = b.regDate ? Number(b.regDate.slice(0, 4)) : today.getFullYear();
      if (b.regDate && t.month > Number(b.regDate.slice(5, 7)) + 6) year -= 1;
      const date = `${year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
      if (date < since) {
        out.skipped++;
        continue;
      }
      await addReport({ date, port, vessel: t.vessel, species: b.species, count: b.count, note: b.note, markedGood: false }, by, source);
      out.added++;
    } catch {
      out.failed++;
    }
  }
  return out;
}

// 쉼 없이 눌러도 사이트에 부담이 가지 않도록 1분에 한 번만 돌린다
export function collectCooldown(): number {
  return Math.max(0, 60_000 - (Date.now() - lastRun));
}
export function markCollectRun(): void {
  lastRun = Date.now();
}
