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
  CACHE_TTL_MS,
  clearSourceCache,
  detectSource,
  getFetchDiagnostics,
  getFilterOptions,
  getSchedules,
  getSourceLabel,
  listConfiguredSources,
  resetSourceHealth,
  toSourceConfig,
} from "../lib/fishing-source";
import { readIntEnv, withTimeout } from "../lib/fetch-scheduler";

const router: IRouter = Router();

// "자리 찾기" 검색은 느린 예약처 한 곳 때문에 전체가 오래 멈추지 않도록, 이 시간(ms)이 지나면
// 그때까지 응답한 예약처의 결과를 먼저 보여준다. 못 끝낸 곳은 경고 문구로 알리고 백그라운드에서
// 계속 받아 캐시에 채우며, 화면(App.tsx)이 잠시 뒤 자동으로 한 번 더 조회해서 채워 넣는다.
// 0으로 두면 끝까지 기다리는 예전 방식. Render 환경변수 FISHING_SEARCH_SOFT_DEADLINE_MS로 조절.
const SEARCH_SOFT_DEADLINE_MS = readIntEnv("FISHING_SEARCH_SOFT_DEADLINE_MS", 6_000, 0);
// 필터 목록(/fishing/options)은 화면이 뜨는 걸 오래 붙잡지 않도록 짧게만 기다린다.
const OPTIONS_SOFT_DEADLINE_MS = 4_000;
const OPTIONS_HARD_TIMEOUT_MS = 9_000;

// 필터 옵션(지역/항구/선박/물때) 계산이 타임아웃에 걸렸을 때, 텅 빈 값 대신
// 직전에 온전히 성공했던 결과를 대신 보여주기 위한 메모리 캐시.
let lastGoodOptions: ReturnType<typeof getFilterOptions> | null = null;

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
      // 지역/항구를 골랐다면 그쪽 예약처만 조회한다. 고르지 않은("전체") 검색은 모든 예약처를 조회한다.
      filter: regionOrPortSelected ? { region, port: parsed.data.port } : undefined,
      // 사용자가 직접 누른 검색은 필터 목록용 백그라운드 조회보다 항상 먼저 처리한다.
      priority: "high",
      softDeadlineMs: SEARCH_SOFT_DEADLINE_MS > 0 ? SEARCH_SOFT_DEADLINE_MS : undefined,
    });
    // 검색이 실제로 성공할 때마다, 그 결과에 담긴 선박/물때 정보를 필터 목록에도
    // 반영해둔다. 이렇게 하면 /fishing/options 쪽이 어쩌다 타임아웃에 걸려도,
    // 사용자가 직접 조회에 성공한 결과만으로도 선박 필터가 계속 채워진다.
    const warmedOptions = getFilterOptions(search.items, search.sources);
    // 지역/항구를 골라 일부 예약처만 조회한 결과는 전체 지역·항구 목록을 대표하지 못하므로,
    // 그런 검색으로는 '직전에 성공한 전체 필터 목록'을 덮어쓰지 않는다 (선박 누적 기억은
    // 바로 위 호출에서 이미 반영된다).
    if (!regionOrPortSelected && search.items.length > 0) {
      lastGoodOptions = warmedOptions;
    }
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
    if (search.failedSources.length) {
      warnings.push(`일부 예약처를 불러오지 못했습니다: ${search.failedSources.join(", ")}`);
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
    });
    res.json(response);
  } catch (error) {
    req.log.error({ err: error }, "Fishing source lookup failed");
    res.status(502).json({ error: "예약 원본을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." });
  }
});

router.post("/fishing/cache/refresh", (_req, res) => {
  clearSourceCache();
  resetSourceHealth();
  lastGoodOptions = null;
  res.json({ ok: true });
});

router.get("/fishing/options", async (_req, res) => {
  try {
    // 필터 목록(지역/항구/선박/물때)을 채우는 용도라서 이번 달과 다음 달만 훑는다. 예전에는
    // 90일(약 4개월 × 예약처 전체, 60건 안팎)을 페이지를 열 때마다 훑어서, 사용자가 누른
    // 검색이 그 뒤에서 한참 기다리는 문제가 있었다.
    const today = new Date();
    const startDate = today.toISOString().slice(0, 10);
    const endDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 0))
      .toISOString()
      .slice(0, 10);
    const configuredSources = (await listConfiguredSources()).filter((source) => source.enabled);
    let options;
    try {
      // 느린/막힌 예약처 때문에 화면이 오래 멈춰있지 않도록 짧게만 기다린다. 시간 안에 못
      // 끝난 예약처는 백그라운드에서 계속 진행되어 캐시를 채우므로 다음 요청부터는 더 빠르다.
      // 이 조회는 "low" 우선순위라서, 같은 시간에 사용자가 검색을 누르면 검색이 먼저 처리된다.
      const search = await withTimeout(
        getSchedules(startDate, endDate, {
          priority: "low",
          withTide: false,
          softDeadlineMs: OPTIONS_SOFT_DEADLINE_MS,
        }),
        OPTIONS_HARD_TIMEOUT_MS,
        "filter-options-timeout",
      );
      options = getFilterOptions(search.items, search.sources);
      if (search.items.length > 0) {
        lastGoodOptions = options;
      }
    } catch {
      // 타임아웃에 걸리면, 텅 빈 값 대신 직전에 성공했던 온전한 필터 목록을
      // 먼저 보여준다 (없으면 예약처 설정에 저장된 지역/항구/업로드 선박만으로 대체).
      options = lastGoodOptions ?? getFilterOptions([], configuredSources.map(toSourceConfig));
    }
    const parsedOptions = GetFishingFilterOptionsResponse.parse(options);
    res.json(parsedOptions);
  } catch (error) {
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
    clearSourceCache();
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
    clearSourceCache();
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
  clearSourceCache();
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
  clearSourceCache();
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
  clearSourceCache();
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
  res.json(DetectFishingSourceResponse.parse(result));
});

export default router;