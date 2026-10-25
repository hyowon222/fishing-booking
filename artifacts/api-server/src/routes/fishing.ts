import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  AddFishingSourceVesselsBody,
  AddFishingSourceVesselsParams,
  ClearFishingSourceVesselsParams,
  CreateFishingSourceBody,
  DeleteFishingSourceParams,
  DetectFishingSourceBody,
  DetectFishingSourceResponse,
  GetFishingFilterOptionsResponse,
  SearchFishingSchedulesQueryParams,
  SearchFishingSchedulesResponse,
  UpdateFishingSourceBody,
  UpdateFishingSourceParams,
} from "@workspace/api-zod";
import { db, fishingSourcesTable } from "@workspace/db";
import { fishingSourceVesselsTable } from "@workspace/db";
import {
  AllSourcesFailedError,
  CACHE_TTL_MS,
  clearSourceCache,
  detectSource,
  discoverSourcesByPort,
  getFetchDiagnostics,
  getFilterOptions,
  getSchedules,
  getSourceLabel,
  listConfiguredSources,
  resetSourceHealth,
  toSourceConfig,
} from "../lib/fishing-source";
import { readIntEnv } from "../lib/fetch-scheduler";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// "자리 찾기" 검색은 느린 예약처 한 곳 때문에 전체가 오래 멈추지 않도록, 이 시간(ms)이 지나면
// 그때까지 응답한 예약처의 결과를 먼저 보여준다. 못 끝낸 곳은 경고 문구로 알리고 백그라운드에서
// 계속 받아 캐시에 채우며, 화면(App.tsx)이 잠시 뒤 자동으로 한 번 더 조회해서 채워 넣는다.
// 0으로 두면 끝까지 기다리는 예전 방식. Render 환경변수 FISHING_SEARCH_SOFT_DEADLINE_MS로 조절.
const SEARCH_SOFT_DEADLINE_MS = readIntEnv("FISHING_SEARCH_SOFT_DEADLINE_MS", 6_000, 0);
const FILTER_OPTIONS_REFRESH_FAILURE_BACKOFF_MS = 60_000;
let filterOptionsRefreshPromise: Promise<void> | null = null;
let filterOptionsRefreshNextAt = 0;
let filterOptionsRefreshGeneration = 0;

function resetFilterOptionsRefresh(): void {
  filterOptionsRefreshGeneration += 1;
  filterOptionsRefreshNextAt = 0;
}

function clearFishingSourceCache(): void {
  clearSourceCache();
  resetFilterOptionsRefresh();
}

function refreshFilterOptionsInBackground(startDate: string, endDate: string): void {
  if (filterOptionsRefreshPromise || Date.now() < filterOptionsRefreshNextAt) return;

  const generation = filterOptionsRefreshGeneration;
  filterOptionsRefreshNextAt = Date.now() + CACHE_TTL_MS;
  let refreshPromise: Promise<void>;
  refreshPromise = getSchedules(startDate, endDate, {
    priority: "low",
    withTide: false,
  })
    .then((search) => {
      if (generation === filterOptionsRefreshGeneration) {
        getFilterOptions(search.items, search.sources);
      }
    })
    .catch((error: unknown) => {
      if (generation === filterOptionsRefreshGeneration) {
        filterOptionsRefreshNextAt = Date.now() + FILTER_OPTIONS_REFRESH_FAILURE_BACKOFF_MS;
      }
      logger.warn({ err: error }, "Background fishing filter refresh failed");
    })
    .finally(() => {
      if (filterOptionsRefreshPromise === refreshPromise) {
        filterOptionsRefreshPromise = null;
      }
    });
  filterOptionsRefreshPromise = refreshPromise;
}

function queryValues(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return [String(value)].filter(Boolean);
}

function dateValue(value: unknown): Date {
  return new Date(`${String(value)}T00:00:00.000Z`);
}

// drizzle-orm이 실제 pg 에러를 DrizzleQueryError로 감싸면서, Postgres 에러 코드(예:
// 유니크 제약 위반 "23505")가 error.code가 아니라 error.cause.code에 들어가게 됐다.
// .cause 체인을 따라가며 code를 찾아, 감싸졌든 아니든 항상 정확히 잡아낸다.
function getPgErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  if ("cause" in error) {
    return getPgErrorCode((error as { cause?: unknown }).cause);
  }
  return undefined;
}

// 검색이 통째로 실패했을 때 화면(App.tsx)의 오류 카드에 한 줄로 보여 줄 원인. 예약처가 전부 실패한
// 경우에는 어느 예약처가 왜 실패했는지를, 그 밖의 서버 오류는 종류(오류 코드)만 알려 준다 (내부 주소나
// 상세 문구는 화면에 내보내지 않는다). 전체 내용은 서버 로그에 남는다.
function describeSearchFailure(error: unknown): string {
  if (error instanceof AllSourcesFailedError) return error.detail;
  const code = getPgErrorCode(error);
  return code ? `서버 내부 오류 (${code})` : "서버 내부 오류";
}

// 못 불러온 예약처를 화면에서 "직접 열기" 링크로 보여 주기 위한 목록. 링크로 열 수 있는 http(s) 주소만 내보내고,
// 그 밖의 값(스킴 없음 등)은 url을 null로 둔다 (이름과 이유는 그대로 보여 준다).
function toUnavailableSources(failures: Array<{ name: string; reason: string; url: string }>) {
  return failures.map(({ name, reason, url }) => {
    let openable: string | null = null;
    try {
      const protocol = new URL(url).protocol;
      if (protocol === "http:" || protocol === "https:") openable = url;
    } catch {
      // 주소 형식이 이상하면 링크 없이 이름·이유만 보여 준다.
    }
    return { name, url: openable, reason };
  });
}

router.get("/fishing/schedules", async (req, res) => {
  const parsed = SearchFishingSchedulesQueryParams.safeParse({
    startDate: dateValue(req.query.startDate),
    endDate: dateValue(req.query.endDate),
    region: queryValues(req.query.region),
    port: req.query.port ? String(req.query.port) : undefined,
    ship: queryValues(req.query.ship),
    tide: req.query.tide ? String(req.query.tide) : undefined,
  });

  if (!parsed.success) {
    res.status(400).json({ error: "시작일과 종료일을 올바른 날짜로 입력해 주세요." });
    return;
  }

  const startDate = parsed.data.startDate.toISOString().slice(0, 10);
  const endDate = parsed.data.endDate.toISOString().slice(0, 10);
  const rangeDays = Math.round(
    (parsed.data.endDate.getTime() - parsed.data.startDate.getTime()) / 86_400_000,
  );
  if (parsed.data.endDate < parsed.data.startDate || rangeDays > 90) {
    res.status(400).json({ error: "검색 범위는 최대 90일이며 종료일은 시작일 이후여야 합니다." });
    return;
  }

  try {
    const region = parsed.data.region || [];
    const ship = parsed.data.ship || [];
    const regionOrPortSelected = region.length > 0 || Boolean(parsed.data.port);
    const search = await getSchedules(startDate, endDate, {
      // 지역/항구/선박을 골랐다면 그쪽 예약처만 조회한다. 고르지 않은("전체") 검색은 모든 예약처를 조회한다.
      filter: regionOrPortSelected || ship.length > 0 ? { region, port: parsed.data.port, ship } : undefined,
      // 사용자가 직접 누른 검색은 필터 목록용 백그라운드 조회보다 항상 먼저 처리한다.
      priority: "high",
      softDeadlineMs: SEARCH_SOFT_DEADLINE_MS > 0 ? SEARCH_SOFT_DEADLINE_MS : undefined,
    });
    // 검색 결과에서 발견한 선박/물때도 메모리에 반영해, 다음 필터 옵션 응답에 포함한다.
    getFilterOptions(search.items, search.sources);
    const items = search.items.filter((item) => {
      const departureMatches = item.departureDate >= startDate && item.departureDate <= endDate;
      const regionMatches = region.length === 0 || region.includes(item.region);
      const portMatches = !parsed.data.port || parsed.data.port === item.port;
      const shipMatches = ship.length === 0 || ship.includes(item.vessel);
      const tideMatches = !parsed.data.tide || parsed.data.tide === item.tide;
      return departureMatches && regionMatches && portMatches && shipMatches && tideMatches;
    });
    // 출항일이 빠른 순서대로, 같은 날짜 안에서는 선박명 가나다순으로 정렬한다.
    items.sort((a, b) => a.departureDate.localeCompare(b.departureDate) || a.vessel.localeCompare(b.vessel, "ko"));
    const warnings: string[] = [];
    if (search.failures.length) {
      // 예약처 이름 뒤에 실패 이유를 붙인다. 예: "대야도 피싱아일랜드(HTTP 403)", "…(응답 시간 초과 15초)"
      warnings.push(
        `일부 예약처를 불러오지 못했습니다: ${search.failures.map((failure) => `${failure.name}(${failure.reason})`).join(", ")}`,
      );
    }
    if (search.partialSources.length) {
      warnings.push(
        `일부 날짜는 불러오지 못한 예약처가 있어요. 잠시 뒤 '자리 찾기'를 다시 누르면 채워질 수 있어요: ${search.partialSources.map((partial) => `${partial.name}(${partial.message})`).join(", ")}`,
      );
    }
    if (search.pendingSources.length) {
      // 주의: App.tsx가 이 문구의 "응답이 늦은 예약처"로 이 상황을 알아보고 자동 재조회한다.
      // 앞부분 문구를 바꿀 때는 App.tsx의 PENDING_SOURCES_NOTICE도 함께 바꿔야 한다.
      warnings.push(
        `응답이 늦은 예약처는 우선 빼고 먼저 보여드려요. 자동으로 다시 불러오고, 계속 안 나오면 '자리 찾기'를 다시 눌러 주세요: ${search.pendingSources.join(", ")}`,
      );
    }
    const response = SearchFishingSchedulesResponse.parse({
      items,
      total: items.length,
      searchedAt: new Date(),
      source: getSourceLabel(search.sources),
      cachedUntil: new Date(Date.now() + CACHE_TTL_MS),
      warning: warnings.length ? warnings.join(" / ") : null,
      unavailableSources: toUnavailableSources(search.failures),
    });
    res.json(response);
  } catch (error) {
    req.log.error({ err: error }, "Fishing source lookup failed");
    res.status(502).json({
      error: "예약 원본을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
      detail: describeSearchFailure(error),
      // 예약처가 전부 실패한 경우에만: 직접 열어 볼 수 있는 링크 목록
      ...(error instanceof AllSourcesFailedError ? { unavailable: toUnavailableSources(error.failures) } : {}),
    });
  }
});

router.post("/fishing/cache/refresh", (_req, res) => {
  clearFishingSourceCache();
  resetSourceHealth();
  res.json({ ok: true });
});

router.get("/fishing/options", async (req, res) => {
  try {
    // DB에 등록된 값을 먼저 반환하고, 공개 예약처에서 새로 발견되는 값은
    // 별도 작업으로 갱신한다. 같은 프로세스에서 동시에 여러 번 긁지 않도록 합친다.
    const today = new Date();
    const startDate = today.toISOString().slice(0, 10);
    const endDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 0))
      .toISOString()
      .slice(0, 10);
    const configuredSources = (await listConfiguredSources()).filter((source) => source.enabled);
    if (configuredSources.length > 0) {
      refreshFilterOptionsInBackground(startDate, endDate);
    }
    const options = getFilterOptions([], configuredSources.map(toSourceConfig));
    const parsedOptions = GetFishingFilterOptionsResponse.parse({
      ...options,
      refreshing: Boolean(filterOptionsRefreshPromise),
    });
    res.json(parsedOptions);
  } catch (error) {
    req.log.error({ err: error }, "Fishing filter options failed to load");
    res.status(502).json({ error: "필터 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." });
  }
});

// 검색이 느릴 때 원인을 눈으로 확인하기 위한 읽기 전용 현황. 브라우저에서
// /api/fishing/diagnostics 를 열면 예약처별로 "줄 서서 기다린 시간 / 사이트 응답 / 본문 / 파싱"이 나온다.
router.get("/fishing/diagnostics", async (_req, res) => {
  const diagnostics = getFetchDiagnostics();
  let names = new Map<number, string>();
  try {
    names = new Map((await listConfiguredSources()).map((source) => [source.id, source.name] as const));
  } catch {
    // 이름만 못 붙일 뿐, 나머지 현황은 그대로 보여준다.
  }
  res.json({
    now: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    ...diagnostics,
    sourceHealth: diagnostics.sourceHealth.map((health) => ({ ...health, name: names.get(health.id) ?? null })),
  });
});

router.get("/fishing/sources", async (_req, res) => {
  try {
    res.json(await listConfiguredSources());
  } catch (error) {
    res.status(500).json({ error: "예약처 목록을 불러오지 못했습니다." });
  }
});

router.post("/fishing/sources", async (req, res) => {
  const parsed = CreateFishingSourceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "이름, 지역, 항구, 예약처 URL을 모두 올바르게 입력해 주세요." });
    return;
  }

  try {
    const [created] = await db
      .insert(fishingSourcesTable)
      .values({ ...parsed.data, enabled: parsed.data.enabled ?? true })
      .returning();
    const source = (await listConfiguredSources()).find((item) => item.id === created.id);
    clearFishingSourceCache();
    res.status(201).json(source);
  } catch (error: unknown) {
    if (getPgErrorCode(error) === "23505") {
      res.status(409).json({ error: "이미 등록된 예약처 URL입니다." });
      return;
    }
    req.log.error({ err: error }, "Fishing source creation failed");
    res.status(500).json({ error: "예약처를 추가하지 못했습니다." });
  }
});

router.patch("/fishing/sources/:id", async (req, res) => {
  const params = UpdateFishingSourceParams.safeParse({ id: Number(req.params.id) });
  const parsed = UpdateFishingSourceBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "이름, 지역, 항구, 예약처 URL을 모두 올바르게 입력해 주세요." });
    return;
  }

  try {
    const [updated] = await db
      .update(fishingSourcesTable)
      .set({ ...parsed.data, enabled: parsed.data.enabled ?? true, updatedAt: new Date() })
      .where(eq(fishingSourcesTable.id, params.data.id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "예약처를 찾을 수 없습니다." });
      return;
    }
    const source = (await listConfiguredSources()).find((item) => item.id === updated.id);
    clearFishingSourceCache();
    res.json(source);
  } catch (error: unknown) {
    if (getPgErrorCode(error) === "23505") {
      res.status(409).json({ error: "이미 등록된 예약처 URL입니다." });
      return;
    }
    req.log.error({ err: error }, "Fishing source update failed");
    res.status(500).json({ error: "예약처를 수정하지 못했습니다." });
  }
});

router.delete("/fishing/sources/:id", async (req, res) => {
  const params = DeleteFishingSourceParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: "예약처 ID가 올바르지 않습니다." });
    return;
  }

  const [source] = await db
    .delete(fishingSourcesTable)
    .where(eq(fishingSourcesTable.id, params.data.id))
    .returning({ id: fishingSourcesTable.id });
  if (!source) {
    res.status(404).json({ error: "예약처를 찾을 수 없습니다." });
    return;
  }
  clearFishingSourceCache();
  res.status(204).send();
});

router.post("/fishing/sources/:id/vessels", async (req, res) => {
  const params = AddFishingSourceVesselsParams.safeParse({ id: Number(req.params.id) });
  const parsed = AddFishingSourceVesselsBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "등록할 선박 목록을 확인해 주세요." });
    return;
  }

  const source = (await listConfiguredSources()).find((item) => item.id === params.data.id);
  if (!source) {
    res.status(404).json({ error: "예약처를 찾을 수 없습니다." });
    return;
  }

  const vessels = [...new Map(
    parsed.data.vessels
      .map((vessel) => ({
        name: vessel.name.trim(),
        departurePort: vessel.departurePort.trim() || source.port,
        address: vessel.address.trim(),
      }))
      .filter((vessel) => vessel.name)
      .map((vessel) => [vessel.name, vessel] as const),
  ).values()];
  if (vessels.length === 0) {
    res.status(400).json({ error: "등록할 선박이 없습니다." });
    return;
  }
  await db
    .insert(fishingSourceVesselsTable)
    .values(vessels.map((vessel) => ({ sourceId: source.id, ...vessel })))
    .onConflictDoNothing();
  clearFishingSourceCache();
  const updated = (await listConfiguredSources()).find((item) => item.id === source.id);
  res.json(updated);
});

router.delete("/fishing/sources/:id/vessels", async (req, res) => {
  const params = ClearFishingSourceVesselsParams.safeParse({ id: Number(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: "예약처 ID가 올바르지 않습니다." });
    return;
  }
  const source = (await listConfiguredSources()).find((item) => item.id === params.data.id);
  if (!source) {
    res.status(404).json({ error: "예약처를 찾을 수 없습니다." });
    return;
  }
  await db.delete(fishingSourceVesselsTable).where(eq(fishingSourceVesselsTable.sourceId, source.id));
  clearFishingSourceCache();
  res.status(204).send();
});

router.post("/fishing/sources/detect", async (req, res) => {
  const parsed = DetectFishingSourceBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.url.trim()) {
    res.status(400).json({ error: "URL을 입력해주세요." });
    return;
  }
  const result = await detectSource(parsed.data.url);
  if (!result) {
    res.status(400).json({ error: "올바른 예약처 URL이 아닙니다. http:// 또는 https://로 시작하는 주소를 입력해주세요." });
    return;
  }
  const registered = await listConfiguredSources();
  const haystack = `${result.suggestedName ?? ""} ${result.workingUrl ?? parsed.data.url}`;
  const matched = registered.filter((item) => {
    const base = item.port.replace(/항$/, "");
    return base.length > 0 && haystack.includes(base);
  });
  const ports = [...new Set(matched.map((item) => item.port))];
  const suggestedPort = ports.length === 1 ? ports[0] : null;
  const regions = [...new Set(matched.filter((item) => item.port === suggestedPort).map((item) => item.region))];
  const suggestedRegion = suggestedPort && regions.length === 1 ? regions[0] : null;
  res.json(DetectFishingSourceResponse.parse({ ...result, suggestedPort, suggestedRegion }));
});


router.post("/fishing/sources/discover", async (req, res) => {
  const portKeyword = typeof req.body?.portKeyword === "string" ? req.body.portKeyword.trim() : "";
  const region = typeof req.body?.region === "string" ? req.body.region.trim() : undefined;
  if (!portKeyword) {
    res.status(400).json({ error: "검색할 항구 이름(예: 삼길포, 오천, 영목)을 입력해 주세요." });
    return;
  }
  try {
    const rawSources: unknown[] = Array.isArray(req.body?.sources) ? req.body.sources : ["thefishing", "sunsang24"];
    const scanSources = { thefishing: rawSources.includes("thefishing"), sunsang24: rawSources.includes("sunsang24") };
    if (!scanSources.thefishing && !scanSources.sunsang24) {
      res.status(400).json({ error: "조회할 사이트를 하나 이상 선택해 주세요." });
      return;
    }
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const result = await discoverSourcesByPort(portKeyword, region, scanSources, controller.signal);
    clearFishingSourceCache();
    res.json(result);
  } catch (error: unknown) {
    req.log.error({ err: error, portKeyword }, "Port source discovery failed");
    res.status(502).json({
      error: error instanceof Error ? error.message : "항구별 선사 스캔 중 오류가 발생했습니다.",
    });
  }
});

export default router;