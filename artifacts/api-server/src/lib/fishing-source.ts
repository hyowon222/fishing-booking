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
 * 예약처가 20곳 이상이고 각각 여러 달을 조회하다 보니, 한 번에 수십~백 개의
 * 요청이 동시에 나갈 수 있다(사용자 검색과 백그라운드 캐시 워머가 겹치는
 * 경우 더 심함). 서버가 그걸 한꺼번에 처리하려다 스스로 느려지면, 실제로는
 * 살아있는 예약처들도 타임아웃으로 "실패"처리되고 그게 다시 반복 실패 건너뛰기
 * 로 이어져 한꺼번에 많은 예약처가 실패로 뜨는 악순환이 생긴다. 이를 막기 위해
 * 서버 전체에서 동시에 진행 중인 예약처 조회 요청 수를 제한한다.
 */
const MAX_CONCURRENT_FETCHES = 6;
let activeFetches = 0;
const fetchQueue: Array<() => void> = [];

async function withFetchLimit<T>(task: () => Promise<T>): Promise<T> {
  if (activeFetches >= MAX_CONCURRENT_FETCHES) {
    await new Promise<void>((resolve) => fetchQueue.push(resolve));
  }
  activeFetches += 1;
  try {
    return await task();
  } finally {
    activeFetches -= 1;
    const next = fetchQueue.shift();
    if (next) next();
  }
}

/**
 * 반복적으로 실패하는 예약처(robots.txt 차단, 서버 다운 등)를 매 검색마다
 * 15초 타임아웃까지 기다리지 않도록, 최근 실패 이력을 추적해서 쿨다운 기간
 * 동안은 요청 자체를 건너뛴다.
 */
const FAILURE_THRESHOLD = 3;
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
  // 물때 어휘는 날짜에 따른 보편적인 값이라 예약처 설정과 무관하게 계속 유지한다.
  // 반면 선박-항구/지역 매핑은 예약처의 항구·지역 설정이 바뀌면 낡은 값이 될 수
  // 있으므로, 예약처가 추가/수정/삭제되거나 수동으로 새로고침할 때 같이 비운다.
  knownShips.clear();
  knownShipsByPort.clear();
  knownShipsByRegion.clear();
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// "OO호좌대", "몇번좌대"처럼 이름에 "좌대"가 들어간 항목은 배가 아니라
// 고정된 좌대낚시 자리라 이 앱(선상 예약)과는 성격이 달라 결과에서 제외한다.
function isExcludedVessel(vessel: string): boolean {
  return vessel.includes("좌대");
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
    if (!vessel || isExcludedVessel(vessel) || remainingSeats === null || remainingSeats <= 0) return;

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

  const response = await withFetchLimit(() =>
    fetch(url, {
      headers: browserHeaders(config.baseUrl),
      signal: AbortSignal.timeout(15_000),
    }),
  );
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

// ---------------------------------------------------------------------------
// SUNSANG24 플랫폼 (예: metafishingclub.sunsang24.com, daebak.sunsang24.com)
//
// 더피싱과 달리 캘린더 달 페이지(/ship/schedule_fleet/{yyyymm})가 서버에서
// 완전히 렌더링된 정적 HTML로 내려온다. 세션 쿠키나 AJAX 재요청이 필요 없고,
// 날짜별 <table class="shipsinfo_daywarp"> 블록 안에 선박별 "남은자리" 텍스트가
// 그대로 박혀 있다. 예약이 마감된 날은 "남은자리" 대신
// <span class="shipping_status" data-status_code="END">예약마감</span> 이 온다.
// ---------------------------------------------------------------------------

const WEEKDAY_KO = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];

function isSunsang24(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith("sunsang24.com");
  } catch {
    return false;
  }
}

function parseSunsangDayBlock(
  $: cheerio.CheerioAPI,
  dayTable: cheerio.Cheerio<any>,
  config: SourceConfig,
): FishingSchedule[] {
  const idMatch = (dayTable.attr("id") || "").match(/^d(\d{4}-\d{2}-\d{2})$/);
  const departureDate = idMatch?.[1];
  if (!departureDate) return [];

  const weekday = WEEKDAY_KO[new Date(`${departureDate}T00:00:00Z`).getUTCDay()];
  const tide = cleanText(dayTable.find(".date_info2").first().text()) || "미정";

  const items: FishingSchedule[] = [];
  dayTable.find(".ship_unit").each((_index, element) => {
    const unit = $(element);
    const vessel = cleanText(unit.find(".ship_info .title").first().text());
    if (!vessel || isExcludedVessel(vessel)) return;

    const remainCell = unit.find(".ship_info2 .remain").first();
    const isClosed = remainCell.find(".shipping_status").attr("data-status_code") === "END";
    let remainingSeats: number | null = null;
    if (isClosed) {
      remainingSeats = 0;
    } else {
      const numberText = cleanText(remainCell.find(".number").first().text());
      const match = numberText.match(/(\d+)/);
      remainingSeats = match ? Number(match[1]) : null;
    }
    if (remainingSeats === null || remainingSeats <= 0) return;

    const genre = cleanText(unit.find("#fish").first().text()) || "선상 낚시";
    const scheduleNo = unit.find("[data-schedule_no]").first().attr("data-schedule_no") || "";
    const monthPath = departureDate.slice(0, 4) + departureDate.slice(5, 7);
    const bookingUrl = `${config.baseUrl}/ship/schedule_fleet/${monthPath}`;
    const id = `${departureDate}-${vessel}-${scheduleNo || "schedule"}`
      .replace(/[^0-9A-Za-z가-힣-]+/g, "-")
      .toLowerCase();

    items.push({
      id,
      departureDate,
      weekday,
      region: config.region,
      port: config.port,
      tide,
      genre,
      operator: cleanText(config.name),
      vessel,
      remainingSeats,
      operatorUrl: config.baseUrl,
      bookingUrl,
      source: bookingUrl,
    });
  });

  return items;
}

async function fetchSunsangMonth(year: number, month: number, config: SourceConfig): Promise<FishingSchedule[]> {
  const monthValue = `${year}${String(month).padStart(2, "0")}`;
  const url = new URL(`/ship/schedule_fleet/${monthValue}`, config.baseUrl);

  const response = await withFetchLimit(() =>
    fetch(url, {
      headers: browserHeaders(config.baseUrl),
      signal: AbortSignal.timeout(15_000),
    }),
  );
  if (!response.ok) {
    throw new Error(`예약 원본이 ${response.status} 상태를 반환했습니다.`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const sourceItems: FishingSchedule[] = [];
  $(".shipsinfo_daywarp").each((_index, element) => {
    sourceItems.push(...parseSunsangDayBlock($, $(element), config));
  });
  return sourceItems;
}

async function fetchMonthForConfig(year: number, month: number, config: SourceConfig): Promise<FishingSchedule[]> {
  return isSunsang24(config.baseUrl) ? fetchSunsangMonth(year, month, config) : fetchMonth(year, month, config);
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
      const monthItems = await fetchMonthForConfig(year, month, config);
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

export async function getSchedules(
  startDate: string,
  endDate: string,
  filter?: { region?: string[]; port?: string },
): Promise<FishingScheduleSearch> {
  const sourceRecords = await listConfiguredSources();
  let sources = sourceRecords.filter((source) => source.enabled).map(toSourceConfig);
  // 지역/항구를 선택해서 검색한 경우, 처음부터 관련 없는 예약처는 조회 대상에서
  // 뺀다. 예전에는 항상 등록된 예약처 전체를 다 조회한 뒤 결과만 걸러냈어서,
  // 관련 없는 지역까지 매번 스크래핑하느라 느렸고, "일부 예약처를 불러오지
  // 못했습니다" 경고에도 선택한 지역과 무관한 예약처 이름까지 나열됐다.
  if (filter?.region?.length) {
    sources = sources.filter((source) => filter.region!.includes(source.region));
  }
  if (filter?.port) {
    sources = sources.filter((source) => source.port === filter.port);
  }

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

// 실제로 한 번이라도 스크래핑에서 관측된 물때 표기(예: "7물", "조금", "무시")를
// 서버가 계속 기억해둔다. 물때는 그 날짜에 고유하게 정해지는 값이라 매번 다시
// 긁어올 필요가 없는데, 사이트마다 표기(1~13물 vs 1~15물, 조금/무시 위치 등)가
// 조금씩 달라서 임의로 목록을 하드코딩하기보다는 실제 관측치를 누적하는 편이
// 더 정확하다. 이렇게 하면 이후 조회가 느리거나 실패해도 필터 목록은 비지 않는다.
const knownTides = new Set<string>();
// 서버가 막 재시작돼서 아직 아무것도 관측 못 했을 때를 위한 초기값(그동안
// 실제로 확인된 표기 기준). 실제 스크래핑 결과가 들어오면 자동으로 더
// 정확한 값으로 채워지고 넓어진다 — 이건 그냥 첫 요청부터 비어보이지
// 않게 하기 위한 임시 출발점일 뿐이다.
["1물", "2물", "3물", "4물", "5물", "6물", "7물", "8물", "9물", "10물", "11물", "12물", "13물", "조금", "무시"].forEach(
  (tide) => knownTides.add(tide),
);

// 선박명도 물때와 같은 이유로 누적 기억한다: 한 번이라도 실시간 조회나 업로드로
// 확인된 선박은, 이후 해당 예약처 조회가 느리거나 실패해도 필터에서 계속 선택
// 가능하게 한다. 항구별/지역별 매핑도 동일하게 누적한다(예약처 설정이 바뀌면
// clearSourceCache()에서 비워진다).
const knownShips = new Set<string>();
const knownShipsByPort = new Map<string, Set<string>>();
const knownShipsByRegion = new Map<string, Set<string>>();

function addToKnownMap(map: Map<string, Set<string>>, key: string, vessel: string): void {
  if (!key || !vessel) return;
  const values = map.get(key) ?? new Set<string>();
  values.add(vessel);
  map.set(key, values);
}

export function getFilterOptions(
  items: FishingSchedule[],
  sources: Array<Pick<SourceConfig, "region" | "port" | "vessels">> = [],
): FishingFilterOptions {
  for (const item of items) {
    if (item.tide) knownTides.add(item.tide);
    if (item.vessel && !isExcludedVessel(item.vessel)) knownShips.add(item.vessel);
    if (!isExcludedVessel(item.vessel)) {
      addToKnownMap(knownShipsByPort, item.port, item.vessel);
      addToKnownMap(knownShipsByRegion, item.region, item.vessel);
    }
  }
  for (const source of sources) {
    for (const vessel of source.vessels) {
      if (isExcludedVessel(vessel)) continue;
      knownShips.add(vessel);
      addToKnownMap(knownShipsByPort, source.port, vessel);
      addToKnownMap(knownShipsByRegion, source.region, vessel);
    }
  }
  const sourceValues = (selector: (source: SourceConfig) => string) =>
    sources.map(selector).filter(Boolean);
  const serializeMap = (map: Map<string, Set<string>>) =>
    Object.fromEntries([...map.entries()].map(([key, values]) => [key, [...values].sort((a, b) => a.localeCompare(b, "ko"))]));
  return {
    regions: [...new Set([...items.map((item) => item.region), ...sourceValues((source) => source.region)].filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko")),
    ports: [...new Set([...items.map((item) => item.port), ...sourceValues((source) => source.port)].filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko")),
    ships: [...knownShips].sort((a, b) => a.localeCompare(b, "ko")),
    tides: [...knownTides].sort((a, b) => a.localeCompare(b, "ko")),
    shipsByPort: serializeMap(knownShipsByPort),
    shipsByRegion: serializeMap(knownShipsByRegion),
  };
}

export function getSourceLabel(sources: SourceConfig[]): string {
  return sources.length === 1 ? sources[0].baseUrl : `${sources.length}개 예약처`;
}