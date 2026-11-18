// lib/lunar.ts — 양력 날짜의 음력(월·일, 윤달 여부). 서버 안에 들어 있는 달력 자료(Intl)로 계산하므로 인터넷이 필요 없다.
//   중국식 음력 계산을 쓰기 때문에 아주 드물게 한국 음력과 하루 차이가 날 수 있다(초하루가 자정 무렵인 해).

export type Lunar = { month: number; day: number; leap: boolean };

let fmt: Intl.DateTimeFormat | null = null;
const cache = new Map<string, Lunar | null>();

export function lunarOf(date: string): Lunar | null {
  if (cache.has(date)) return cache.get(date)!;
  let out: Lunar | null = null;
  try {
    fmt ??= new Intl.DateTimeFormat("ko-KR-u-ca-chinese", { month: "numeric", day: "numeric", timeZone: "Asia/Seoul" });
    const parts = fmt.formatToParts(new Date(`${date}T12:00:00+09:00`)).filter((p) => p.type === "month" || p.type === "day");
    const m = parts.find((p) => p.type === "month")?.value ?? "";
    const d = parts.find((p) => p.type === "day")?.value ?? "";
    const month = Number(m.replace(/\D/g, ""));
    const day = Number(d.replace(/\D/g, ""));
    if (month >= 1 && month <= 12 && day >= 1 && day <= 30) out = { month, day, leap: /윤|bis/i.test(m) };
  } catch {
    out = null;
  }
  cache.set(date, out);
  return out;
}

export const lunarLabel = (l: Lunar) => `음력 ${l.leap ? "윤" : ""}${l.month}월 ${l.day}일`;

// 작년의 같은 음력 날짜가 양력으로 며칠이었는지 ("10/8" 형태). 못 찾으면 null
export function sameLunarLastYear(date: string): string | null {
  const l = lunarOf(date);
  if (!l) return null;
  const y = Number(date.slice(0, 4)) - 1;
  const base = Date.UTC(y, Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  for (let i = 0; i <= 45; i++) {
    for (const sign of [1, -1]) {
      const t = new Date(base + sign * i * 86400000);
      const s = t.toISOString().slice(0, 10);
      const c = lunarOf(s);
      if (c && c.month === l.month && c.day === l.day && c.leap === l.leap) return `${t.getUTCMonth() + 1}/${t.getUTCDate()}`;
    }
  }
  return null;
}
