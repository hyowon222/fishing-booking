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
// 예약처별로 이미 조회한 '연-월'은 캐시해서, 겹치는 기간을 다시 조회할 때
// 네트워크 스크래핑 없이 재사용한다. 키 형태: `${sourceId}:${year}-${month}`
const monthCache = new Map<string, { expiresAt: number; items: FishingSchedule[] }>();

/**
 * 반복적으로 실패하는 예약처(robots.txt 차단, 서버 다운 등)를 매 검색마다
 * 15초 타임아웃까지 기다리지 않도록, 최근 실패 이력을 추적해서 쿨다운 기간
 * 동안은 요청 자체를 건너뛴다.
 */
const FAILURE_THRESHOLD = 2;
const COOLDOWN_MS = 10 * 60 * 1000; // 10분
type SourceHealth = { consecutiveFailures: number; skipUntil: number; lastError?: string };
const sourceHealth = new Map<number, SourceHealth>();

function isSkipped(sourceId: number): SourceHealth | undefined {
  const health = sourceHealth.get(sourceId);
  if (health && health.skipUntil > Date.now()) return health;
  return undefined;
}

function recordSuccess(sourceId: number): void {
  sourceHealth.delete(sourceId);
}

function recordFailure(sourceId: number, error: unknown): void {
  const prev = sourceHealth.get(sourceId);
  const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
  const skipUntil = consecutiveFailures >= FAILURE_THRESHOLD ? Date.now() + COOLDOWN_MS : 0;
  sourceHealth.set(sourceId, {
    consecutiveFailures,
    skipUntil,
    lastError: error instanceof Error ? error.message : String(error),
  });
}

export function getSourceHealthSnapshot(): Array<{ id: number; consecutiveFailures: number; skippedUntil: string | null; lastError?: string }> {
  return [...sourceHealth.entries()].map(([id, health]) => ({
    id,
    consecutiveFailures: health.consecutiveFailures,
    skippedUntil: health.skipUntil > Date.now() ? new Date(health.skipUntil).toISOString() : null,
    lastError: health.lastError,
  }));
}

export function resetSourceHealth(): void {
  sourceHealth.clear();
}

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
  monthCache.clear();
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
  if (idMatch?.[1]) {
    const digits = idMatch[1];
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  // "9월 3일"처럼 월/일이 0으로 채워지지 않은 경우도 있으므로, 각 자리를
  // 직접 2자리로 맞춰서 파싱한다 (이전에는 join()한 문자열 길이가 8이 아니면
  // 통째로 버려서 그런 날짜의 데이터가 조용히 누락됐다).
  const textMatch = text.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (!textMatch) return null;
  const [, year, month, day] = textMatch;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
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

function browserHeaders(referer: string): HeadersInit {
  return {
    "User-Agent": BROWSER_USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    Referer: referer,
  };
}

async function fetchMonth(year: number, month: number, config: SourceConfig): Promise<FishingSchedule[]> {
  const monthValue = String(month).padStart(2, "0");
  const url = new URL("/index.php", config.baseUrl);
  url.searchParams.set("mid", "bk");
  url.searchParams.set("year", String(year));
  url.searchParams.set("month", monthValue);
  url.searchParams.set("day", "01");

  const response = await fetch(url, {
    headers: browserHeaders(config.baseUrl),
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
  const results = await Promise.all(
    months.map(async ({ year, month }) => {
      const cacheKey = `${config.id}:${year}-${month}`;
      const cached = monthCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.items;
      }
      const monthItems = await fetchMonth(year, month, config);
      monthCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, items: monthItems });
      return monthItems;
    }),
  );
  return results.flat();
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

  if (sources.length === 0) {
    return { items: [], sources, failedSources: [] };
  }

  const months = monthCursor(startDate, endDate);
  const sourceResults = await Promise.allSettled(
    sources.map(async (source) => {
      const skipped = isSkipped(source.id);
      if (skipped) {
        throw new Error(`최근 반복 실패로 건너뜀 (${skipped.consecutiveFailures}회 연속 실패, 이전 오류: ${skipped.lastError ?? "알 수 없음"})`);
      }
      try {
        const result = await fetchSourceMonths(months, source);
        recordSuccess(source.id);
        return result;
      } catch (error) {
        recordFailure(source.id, error);
        throw error;
      }
    }),
  );
  // fetchSourceMonths는 해당 월 전체 데이터를 돌려주므로, 실제 요청한
  // 날짜 범위(startDate~endDate)에 맞게 여기서 다시 걸러낸다.
  const items = sourceResults
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .filter((item) => item.departureDate >= startDate && item.departureDate <= endDate);
  const failedSources = sourceResults.flatMap((result, index) =>
    result.status === "rejected" ? [sources[index]?.name || "예약처"] : [],
  );
  if (items.length === 0 && failedSources.length === sources.length) {
    throw new Error("모든 예약처를 불러오지 못했습니다.");
  }
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