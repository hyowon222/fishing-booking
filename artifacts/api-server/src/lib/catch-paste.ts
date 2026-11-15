// lib/catch-paste.ts — 카페·블로그 등에서 복사해 붙여넣은 글에서 조황 기록을 뽑아낸다
//   글과 글 사이는 빈 줄이나 날짜로 시작하는 줄로 나눈다.
//   날짜(2026.11.3 / 11월 3일 / 11/3), 항구, 어종, 마릿수(50수·50마리·30~40수)를 찾고 나머지는 메모로 둔다.

import { TIDE_PORTS } from "./tide-table";
import type { NewReport } from "./catch-reports";

const SPECIES = ["쭈꾸미", "주꾸미", "쭈갑", "갑오징어", "문어", "한치", "오징어", "갈치", "우럭", "광어", "노래미", "도다리", "대구", "민어", "참돔", "삼치", "농어", "쭈", "갑"];
const PORT_ALIASES: Array<[string, string]> = [
  ["삼길포", "삼길포"],
  ["대천", "대천항"],
  ["신진도", "신진도"],
  ["오천", "오천항"],
  ["마검포", "마검포"],
];

const DATE_FULL = /(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/;
const DATE_KR = /(\d{1,2})\s*월\s*(\d{1,2})\s*일?/;
const DATE_SHORT = /(?:^|[^\d])(\d{1,2})\s*[./]\s*(\d{1,2})(?![\d])/;
const LINE_STARTS_WITH_DATE = /^\s*(?:\[?\(?)(?:20\d{2}\s*[.\-/년]\s*)?\d{1,2}\s*[./월\-]\s*\d{1,2}/;

export type ParsedPost = NewReport & { raw: string };

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function splitPosts(text: string): string[] {
  const blocks: string[] = [];
  for (const chunk of text.replace(/\r/g, "").split(/\n\s*\n+/)) {
    let cur: string[] = [];
    for (const line of chunk.split("\n")) {
      if (cur.length && LINE_STARTS_WITH_DATE.test(line)) {
        blocks.push(cur.join("\n"));
        cur = [];
      }
      cur.push(line);
    }
    if (cur.length) blocks.push(cur.join("\n"));
  }
  return blocks.map((b) => b.trim()).filter((b) => b.length > 0);
}

export function parsePost(block: string, defaultPort: string, now = new Date()): ParsedPost | null {
  let y = now.getFullYear();
  let m = 0;
  let d = 0;
  let hit = DATE_FULL.exec(block);
  if (hit) {
    y = Number(hit[1]);
    m = Number(hit[2]);
    d = Number(hit[3]);
  } else if ((hit = DATE_KR.exec(block))) {
    m = Number(hit[1]);
    d = Number(hit[2]);
  } else if ((hit = DATE_SHORT.exec(block))) {
    m = Number(hit[1]);
    d = Number(hit[2]);
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // 올해 날짜가 오늘보다 훨씬 미래면 작년 글로 본다 (연도 없는 12월 글을 1월에 붙여넣은 경우)
  const date = `${y}-${pad(m)}-${pad(d)}`;
  if (!DATE_FULL.test(block) && new Date(`${date}T00:00:00`).getTime() > now.getTime() + 30 * 86400000) {
    y -= 1;
  }
  const port = PORT_ALIASES.find(([k]) => block.includes(k))?.[1] ?? defaultPort;
  if (!TIDE_PORTS.includes(port)) return null;
  const found = SPECIES.filter((s) => s.length > 1 && block.includes(s));
  const species = found.filter((s) => !found.some((o) => o !== s && o.includes(s))).slice(0, 3).join(", ");
  const nums: number[] = [];
  for (const mm of block.matchAll(/(\d{1,4})(?:\s*[~\-]\s*(\d{1,4}))?\s*(?:마리|수|미)(?![가-힣])/g)) {
    nums.push(Number(mm[2] ?? mm[1]));
  }
  const count = nums.length ? Math.max(...nums) : null;
  const note = block.replace(/\s+/g, " ").trim().slice(0, 300);
  return { date: `${y}-${pad(m)}-${pad(d)}`, port, vessel: "", species, count, note, markedGood: false, raw: block.slice(0, 200) };
}

export function parsePasted(text: string, defaultPort: string): { posts: ParsedPost[]; skipped: number } {
  const blocks = splitPosts(text).slice(0, 200);
  const posts: ParsedPost[] = [];
  let skipped = 0;
  for (const b of blocks) {
    const p = parsePost(b, defaultPort);
    if (p) posts.push(p);
    else skipped++;
  }
  return { posts, skipped };
}
