import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  AddFishingSourceVesselsBody,
  AddFishingSourceVesselsParams,
  ClearFishingSourceVesselsParams,
  CreateFishingSourceBody,
  DeleteFishingSourceParams,
  GetFishingFilterOptionsResponse,
  SearchFishingSchedulesQueryParams,
  SearchFishingSchedulesResponse,
  UpdateFishingSourceBody,
  UpdateFishingSourceParams,
} from "@workspace/api-zod";
import { db, fishingSourcesTable } from "@workspace/db";
import { fishingSourceVesselsTable } from "@workspace/db";
import {
  clearSourceCache,
  getFilterOptions,
  getSchedules,
  getSourceLabel,
  listConfiguredSources,
  resetSourceHealth,
} from "../lib/fishing-source";

const router: IRouter = Router();

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
    const search = await getSchedules(startDate, endDate, { region, port: parsed.data.port });
    // "자리 찾기"로 실제 확인된 선박/물때 정보도 선박 누적 기억(getFilterOptions의
    // 내부 상태)에 반영한다. 예전에는 /fishing/options에서만 이게 채워져서,
    // 사용자가 직접 검색해 찾아낸 선박이 필터 목록에는 반영되지 않는 문제가 있었다.
    getFilterOptions(search.items, search.sources);
    const items = search.items.filter((item) => {
      const departureMatches = item.departureDate >= startDate && item.departureDate <= endDate;
      const regionMatches = region.length === 0 || region.includes(item.region);
      const portMatches = !parsed.data.port || parsed.data.port === item.port;
      const shipMatches = ship.length === 0 || ship.includes(item.vessel);
      const tideMatches = !parsed.data.tide || parsed.data.tide === item.tide;
      return departureMatches && regionMatches && portMatches && shipMatches && tideMatches;
    });
    const response = SearchFishingSchedulesResponse.parse({
      items,
      total: items.length,
      searchedAt: new Date(),
      source: getSourceLabel(search.sources),
      cachedUntil: new Date(Date.now() + 5 * 60 * 1000),
      warning: search.failedSources.length
        ? `일부 예약처를 불러오지 못했습니다: ${search.failedSources.join(", ")}`
        : null,
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
    const today = new Date();
    const end = new Date(today);
    end.setUTCDate(end.getUTCDate() + 90);
    const startDate = today.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);
    const configuredSources = (await listConfiguredSources()).filter((source) => source.enabled);
    let options;
    try {
      // 느린/막힌 예약처 때문에 화면이 오래 멈춰있지 않도록 최대 12초만 기다린다.
      // 시간 안에 못 끝나도 getSchedules 자체는 백그라운드에서 계속 진행되어
      // 캐시를 채우므로, 다음 요청(검색/재조회)부터는 더 빨라진다.
      const search = await Promise.race([
        getSchedules(startDate, endDate),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("filter-options-timeout")), 12_000)),
      ]);
      options = getFilterOptions(search.items, search.sources);
      if (search.items.length > 0) {
        lastGoodOptions = options;
      }
    } catch {
      // 타임아웃에 걸리면, 텅 빈 값 대신 직전에 성공했던 온전한 필터 목록을
      // 먼저 보여준다 (없으면 예약처 설정에 저장된 지역/항구/업로드 선박만으로 대체).
      options = lastGoodOptions ?? getFilterOptions([], configuredSources);
    }
    const parsedOptions = GetFishingFilterOptionsResponse.parse(options);
    res.json(parsedOptions);
  } catch (error) {
    res.status(502).json({ error: "필터 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." });
  }
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
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
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
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
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

export default router;