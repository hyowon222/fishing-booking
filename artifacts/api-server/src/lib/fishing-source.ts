import * as cheerio from "cheerio";
import { asc } from "drizzle-orm";
import {
  db,
  fishingSourcesTable,
  fishingSourceVesselsTable,
  type FishingSource as FishingSourceRecord,
  type FishingSourceVessel as FishingSourceVesselRecord,
} from "@workspace/db";

export type FishingSchedule = {
  id: string;
  departureDate: string;
  weekday: string;
  region: string;
  port: string;
  tide: string;
  genre: string;
  operator: string;
  vessel: string;
  remainingSeats: number | null;
  operatorUrl: string | null;
  bookingUrl: string | null;
  source: string;
};

export type FishingFilterOptions = {
  regions: string[];
  ports: string[];
  ships: string[];
  tides: string[];
  shipsByPort: Record<string, string[]>;
  shipsByRegion: Record<string, string[]>;
};

type SourceConfig = {
  id: number;
  name: string;
  baseUrl: string;
  region: string;
  port: string;
  vessels: string[];
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const sourceCache = new Map<string, { expiresAt: number; items: FishingSchedule[] }>();

export type FishingSourceWithVessels = FishingSourceRecord & { vessels: FishingSourceVesselRecord[] };

function toSourceConfig(source: FishingSourceWithVessels): SourceConfig {
  return {
    id: source.id,
    name: source.name,
    baseUrl: source.sourceUrl.replace(/\/$/, ""),
    region: source.region,
    port: source.port,
    vessels: source.vessels.map((vessel) => vessel.name),
  };
}

export async function listConfiguredSources(): Promise<FishingSourceWithVessels[]> {
  const [sources, vessels] = await Promise.all([
    db.select().from(fishingSourcesTable).orderBy(asc(fishingSourcesTable.port)),
    db.select().from(fishingSourceVesselsTable),
  ]);
  const vesselsBySource = new Map<number, FishingSourceVesselRecord[]>();
  for (const vessel of vessels) {
    const names = vesselsBySource.get(vessel.sourceId) ?? [];
    names.push(vessel);
    vesselsBySource.set(vessel.sourceId, names);
  }
  return sources.map((source) => ({
    ...source,
    vessels: vesselsBySource.get(source.id) ?? [],
  }));
}

export function clearSourceCache(): void {
  sourceCache.clear();
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseSeatCount(value: string): number | null {
  const match = value.match(/남은자리\s*(\d+)\s*명/);
  return match ? Number(match[1]) : null;
}

function parseDateFromDayBlock(id: string, text: string): string | null {
  const idMatch = id.match(/new-div-(\d{8})/);
  const dateValue = idMatch?.[1] ?? text.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/)?.slice(1).join("");
  if (!dateValue || dateValue.length !== 8) return null;
  return `${dateValue.slice(0, 4)}-${dateValue.slice(4, 6)}-${dateValue.slice(6, 8)}`;
}

function extractBookingUrl(onclick: string, baseUrl: string): string | null {
  const match = onclick.match(/f_popup\('([^']+)'/);
  if (!match?.[1]) return null;
  return new URL(match[1], baseUrl).href;
}

function parseDayBlock(
  block: cheerio.Cheerio<any>,
  config: SourceConfig,
): FishingSchedule[] {
  const header = block.find("tr.jeil-panel").first();
  const headerText = cleanText(header.text());
  const departureDate = parseDateFromDayBlock(block.attr("id") || "", headerText);
  if (!departureDate) return [];

  const weekday = headerText.match(/(월요일|화요일|수요일|목요일|금요일|토요일|일요일)/)?.[1] || "";
  const tide = headerText.match(/(\d+물|조금|무시)/)?.[1] || "미정";
  const operator = cleanText(config.name).replace(/^예약하기\s*-\s*/, "");

  const items: FishingSchedule[] = [];
  block.find("tr").each((_index, row) => {
    const row$ = cheerio.load(row);
    const cells = row$("tr").first().children("td");
    if (cells.length < 3) return;

    const vessel = cleanText(cells.eq(0).find("span").first().text() || cells.eq(0).text());
    const seatAlt = cells.eq(2).find("img").first().attr("alt") || "";
    const remainingSeats = parseSeatCount(seatAlt);
    if (!vessel || remainingSeats === null || remainingSeats <= 0) return;

    const genre = cleanText(
      cells.eq(1).find('img[alt="낚시종류"]').closest("tr").find("td").last().text() ||
        cells.eq(1).text(),
    );
    const bookingUrl = extractBookingUrl(cells.eq(0).find("a").first().attr("onclick") || "", config.baseUrl);
    const id = `${departureDate}-${vessel}-${bookingUrl || "schedule"}`
      .replace(/[^0-9A-Za-z가-힣-]+/g, "-")
      .toLowerCase();

    items.push({
      id,
      departureDate,
      weekday,
      region: config.region,
      port: config.port,
      tide,
      genre: genre || "선상 낚시",
      operator,
      vessel,
      remainingSeats,
      operatorUrl: config.baseUrl,
      bookingUrl,
      source: `${config.baseUrl}/index.php?mid=bk&year=${departureDate.slice(0, 4)}&month=${departureDate.slice(5, 7)}`,
    });
  });

  return items;
}

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function browserHeaders(referer: string, cookie?: string): HeadersInit {
  const headers: Record<string, string> = {
    "User-Agent": BROWSER_USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    Referer: referer,
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function extractCookie(response: Response): string | undefined {
  // Node/undici exposes multiple Set-Cookie headers via getSetCookie(); fall back to a single header.
  const anyHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
  const raw = anyHeaders.getSetCookie?.() ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : []);
  if (raw.length === 0) return undefined;
  return raw.map((entry) => entry.split(";")[0]).join("; ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 일부 예약처(더피싱 플랫폼)는 세션/쿠키 없이 year/month 파라미터를 바꿔가며
 * 여러 번 요청하는 패턴을 스크래핑으로 간주해, 실제 예약 데이터 대신 매 요청마다
 * 점점 먼 미래로 밀려나는 빈 캘린더를 반환하는 것으로 보인다. 이를 피하기 위해
 * (1) 캘린더 기본 페이지에서 먼저 세션 쿠키를 확보하고, (2) 그 쿠키와 Referer를
 * 재사용하며, (3) 병렬이 아니라 순차적으로, 약간의 지연을 두고 요청한다.
 */
async function establishSession(config: SourceConfig): Promise<{ cookie?: string; referer: string }> {
  const baseUrl = new URL("/index.php", config.baseUrl);
  baseUrl.searchParams.set("mid", "bk");
  const response = await fetch(baseUrl, {
    headers: browserHeaders(config.baseUrl),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`예약 원본이 ${response.status} 상태를 반환했습니다.`);
  }
  await response.text();
  return { cookie: extractCookie(response), referer: baseUrl.href };
}

async function fetchMonth(
  year: number,
  month: number,
  config: SourceConfig,
  session: { cookie?: string; referer: string },
): Promise<FishingSchedule[]> {
  const monthValue = String(month).padStart(2, "0");
  const url = new URL("/index.php", config.baseUrl);
  url.searchParams.set("mid", "bk");
  url.searchParams.set("year", String(year));
  url.searchParams.set("month", monthValue);
  url.searchParams.set("day", "01");

  const response = await fetch(url, {
    headers: browserHeaders(session.referer, session.cookie),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`예약 원본이 ${response.status} 상태를 반환했습니다.`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const sourceItems: FishingSchedule[] = [];
  $(".new-divs").each((_index, element) => {
    sourceItems.push(...parseDayBlock($(element), config));
  });
  return sourceItems;
}

async function fetchSourceMonths(
  months: Array<{ year: number; month: number }>,
  config: SourceConfig,
): Promise<FishingSchedule[]> {
  const session = await establishSession(config);
  const items: FishingSchedule[] = [];
  for (const { year, month } of months) {
    items.push(...(await fetchMonth(year, month, config, session)));
    // 짧은 지연으로 병렬 버스트 요청처럼 보이지 않게 함
    await sleep(300);
  }
  return items;
}

function monthCursor(startDate: string, endDate: string): Array<{ year: number; month: number }> {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  const months: Array<{ year: number; month: number }> = [];
  while (cursor <= last) {
    months.push({ year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1 });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

export type FishingScheduleSearch = {
  items: FishingSchedule[];
  sources: SourceConfig[];
  failedSources: string[];
};

export async function getSchedules(startDate: string, endDate: string): Promise<FishingScheduleSearch> {
  const sourceRecords = await listConfiguredSources();
  const sources = sourceRecords.filter((source) => source.enabled).map(toSourceConfig);
  const cacheKey = `${sources.map((source) => source.id).join(",")}:${startDate}:${endDate}`;
  const cached = sourceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { items: cached.items, sources, failedSources: [] };
  }

  if (sources.length === 0) {
    return { items: [], sources, failedSources: [] };
  }

  const months = monthCursor(startDate, endDate);
  const sourceResults = await Promise.allSettled(
    sources.map((source) => fetchSourceMonths(months, source)),
  );
  const items = sourceResults.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const failedSources = sourceResults.flatMap((result, index) =>
    result.status === "rejected" ? [sources[index]?.name || "예약처"] : [],
  );
  if (items.length === 0 && failedSources.length === sources.length) {
    throw new Error("모든 예약처를 불러오지 못했습니다.");
  }
  sourceCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, items });
  return { items, sources, failedSources };
}

export function getFilterOptions(
  items: FishingSchedule[],
  sources: Array<Pick<SourceConfig, "region" | "port" | "vessels">> = [],
): FishingFilterOptions {
  const values = (selector: (item: FishingSchedule) => string) =>
    [...new Set(items.map(selector).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
  const sourceValues = (selector: (source: SourceConfig) => string) =>
    sources.map(selector).filter(Boolean);
  const shipsByPort = new Map<string, Set<string>>();
  const shipsByRegion = new Map<string, Set<string>>();
  const addToMap = (map: Map<string, Set<string>>, key: string, vessel: string) => {
    if (!key || !vessel) return;
    const values = map.get(key) ?? new Set<string>();
    values.add(vessel);
    map.set(key, values);
  };
  for (const item of items) {
    addToMap(shipsByPort, item.port, item.vessel);
    addToMap(shipsByRegion, item.region, item.vessel);
  }
  for (const source of sources) {
    for (const vessel of source.vessels) {
      addToMap(shipsByPort, source.port, vessel);
      addToMap(shipsByRegion, source.region, vessel);
    }
  }
  const serializeMap = (map: Map<string, Set<string>>) =>
    Object.fromEntries([...map.entries()].map(([key, values]) => [key, [...values].sort((a, b) => a.localeCompare(b, "ko"))]));
  return {
    regions: [...new Set([...items.map((item) => item.region), ...sourceValues((source) => source.region)].filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko")),
    ports: [...new Set([...items.map((item) => item.port), ...sourceValues((source) => source.port)].filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko")),
    ships: [...new Set([...items.map((item) => item.vessel), ...sources.flatMap((source) => source.vessels)].filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko")),
    tides: values((item) => item.tide),
    shipsByPort: serializeMap(shipsByPort),
    shipsByRegion: serializeMap(shipsByRegion),
  };
}

export function getSourceLabel(sources: SourceConfig[]): string {
  return sources.length === 1 ? sources[0].baseUrl : `${sources.length}개 예약처`;
}