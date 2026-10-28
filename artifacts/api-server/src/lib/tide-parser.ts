/**
 * 바다타임 "날짜별 물때" 월 페이지(https://www.badatime.com/{지역ID}/daily/{YYYY-MM})의 HTML을
 * 날짜별 물때 정보로 바꾸는 순수 함수. (외부 의존성 없음 — 네트워크/DB와 분리해 단독 테스트 가능)
 *
 * 페이지 구조(PC용 한 줄 = <tr class="day-row">):
 *   td#week      "1(수)<br><span>8.1</span>"            → 날짜 칸 (8.1 = 음력 8월 1일)
 *   td.tide      <div class="tide-text"><b>7 물</b>     → 몇물 (조금/무시 등 문구일 수도 있음)
 *   td.pc-flow   progress-bar data-value="98" + "98%"   → 조류 세기(물흐름). "최대"/"최소"일 수도 있음
 *   td.weather   <img alt="맑음"> 최대 2개(오전/오후)    → 날씨. 아직 예보가 없으면 비어 있음
 *   td.manjo     "04:43 (861) ▲+849" 한 줄에 1~2건       → 만조(시각, 조위 cm, 직전 간조 대비 변화량)
 *   td.ganjo     "11:04 ( 58) ▼-803" 한 줄에 1~2건       → 간조
 *   td.pc-only   <a href="/144/graph/2027-9-1">          → 정확한 날짜(년-월-일)
 * 값이 비어 있거나 형식이 다르면 해당 필드는 null로 두고, 화면에서 "데이터 없음"으로 보여 준다.
 */

export type TideEvent = {
  /** "HH:MM" */
  time: string;
  /** 조위(cm). 간조는 음수일 수 있음 */
  height: number | null;
  /** 직전 간조(만조 줄) 또는 직전 만조(간조 줄) 대비 변화량(cm) */
  delta: number | null;
};

export type TideDay = {
  /** YYYY-MM-DD */
  date: string;
  /** 일~토 (날짜에서 직접 계산) */
  weekday: string;
  /** "8.1" = 음력 8월 1일. 없으면 null */
  lunar: string | null;
  /** "7물", "조금" 등. 없으면 null */
  mulddae: string | null;
  /** 조류 세기 0~100. 없으면 null */
  flowPercent: number | null;
  /** 화면에 그대로 보여 줄 문구("98%", "최대", "최소") */
  flowLabel: string | null;
  /** 오전/오후 날씨. 예보가 없으면 null */
  weather: { am: string; pm: string } | null;
  highs: TideEvent[];
  lows: TideEvent[];
  /** 그날 가장 높은 만조 − 가장 낮은 간조 (cm). 둘 다 있을 때만 */
  range: number | null;
};

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const pad2 = (n: number) => String(n).padStart(2, "0");

function cell(row: string, cls: string): string | null {
  const m = row.match(new RegExp(`<td[^>]*class="${cls}"[^>]*>([\\s\\S]*?)</td>`));
  return m ? m[1] : null;
}

function parseEvents(block: string | null): TideEvent[] {
  if (!block) return [];
  const events: TideEvent[] = [];
  const re =
    /<b>\s*(\d{1,2}):(\d{2})\s*\(\s*(?:&nbsp;|\s)*(-?\d+)\s*\)\s*<\/b>\s*(?:<span[^>]*>\s*<font[^>]*>\s*[▲▼]\s*([+-]?\d+)\s*<\/font>\s*<\/span>)?/g;
  for (const m of block.matchAll(re)) {
    const height = Number(m[3]);
    const delta = m[4] === undefined ? null : Number(m[4]);
    events.push({
      time: `${pad2(Number(m[1]))}:${m[2]}`,
      height: Number.isFinite(height) ? height : null,
      delta: delta !== null && Number.isFinite(delta) ? delta : null,
    });
  }
  return events;
}

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

export function parseTideMonthHtml(html: string): TideDay[] {
  const days: TideDay[] = [];
  for (const rowMatch of html.matchAll(/<tr[^>]*class="day-row"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const row = rowMatch[1];

    const link = row.match(/\/\d+\/graph\/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!link) continue; // 날짜를 확정할 수 없는 줄은 건너뛴다
    const [y, m, d] = [Number(link[1]), Number(link[2]), Number(link[3])];
    const date = `${y}-${pad2(m)}-${pad2(d)}`;
    const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];

    const lunarMatch = (cell(row, "day-cell") ?? row).match(/<span[^>]*>\s*(\d{1,2}\.\d{1,2})\s*<\/span>/);
    const lunar = lunarMatch ? lunarMatch[1] : null;

    const mulddaeMatch = row.match(/<div class="tide-text">\s*<b>([\s\S]*?)<\/b>/);
    const mulddaeRaw = mulddaeMatch ? textOf(mulddaeMatch[1]).replace(/\s+/g, "") : "";
    const mulddae = mulddaeRaw || null;

    const flowCell = cell(row, "pc-flow");
    let flowPercent: number | null = null;
    let flowLabel: string | null = null;
    if (flowCell) {
      const value = flowCell.match(/data-value="(\d{1,3})"/);
      if (value) flowPercent = Math.min(100, Number(value[1]));
      const label = flowCell.match(/<span[^>]*class="progress-label"[^>]*>\s*<b>([\s\S]*?)<\/b>/);
      flowLabel = label ? textOf(label[1]) || null : null;
      if (flowLabel === null && flowPercent !== null) flowLabel = `${flowPercent}%`;
    }

    const weatherCell = cell(row, "weather");
    let weather: TideDay["weather"] = null;
    if (weatherCell) {
      const alts = [...weatherCell.matchAll(/alt="([^"]*)"/g)].map((a) => a[1].trim()).filter(Boolean);
      if (alts.length >= 1) weather = { am: alts[0], pm: alts[1] ?? alts[0] };
    }

    const highs = parseEvents(cell(row, "manjo"));
    const lows = parseEvents(cell(row, "ganjo"));
    const highHeights = highs.map((e) => e.height).filter((h): h is number => h !== null);
    const lowHeights = lows.map((e) => e.height).filter((h): h is number => h !== null);
    const range =
      highHeights.length && lowHeights.length ? Math.max(...highHeights) - Math.min(...lowHeights) : null;

    days.push({ date, weekday, lunar, mulddae, flowPercent, flowLabel, weather, highs, lows, range });
  }
  return days;
}
