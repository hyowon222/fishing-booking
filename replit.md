# 바다자리 · Boat Fishing Reservation Lookup

실시간 공개 예약처를 조회해 출항일, 지역, 항구, 선박, 물때별 잔여 좌석을 비교하는 한국어 선상 낚시 예약 조회 앱입니다.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/boat-fishing-lookup` — responsive React/Vite lookup interface
- `artifacts/api-server/src/lib/fishing-source.ts` — public reservation source fetch and parsing (더피싱-style and SUNSANG24), 20-minute per-source month cache with in-flight de-duplication, failure cooldown, and badatime tide strength
- `artifacts/api-server/src/lib/fetch-scheduler.ts` — priority-aware fetch limiter (`high` = a user's search, `low` = background filter-options warm-up) and soft-deadline helpers
- `artifacts/api-server/src/routes/fishing.ts` — schedule, filter-options, source CRUD/detect, and `/fishing/diagnostics` endpoints
- `artifacts/boat-fishing-lookup/src/hooks/use-auto-retry-pending.ts` — re-queries automatically (max 2×) while the server reports slow sources
- `lib/api-spec/openapi.yaml` — source of truth for the generated API client and Zod response schemas

## Architecture decisions

- The lookup reads the configured public source directly instead of copying schedules into the database, so seat counts stay close to the operator's page.
- Source URL, region, port, and operator name can be changed through `FISHING_SOURCE_URL`, `FISHING_SOURCE_REGION`, `FISHING_SOURCE_PORT`, and `FISHING_SOURCE_NAME`.
- Each source's month page is cached in memory for 20 minutes (`CACHE_TTL_MS`); concurrent requests for the same source-month share a single fetch.

## Search performance

- A search (`high` priority) never queues behind the page-load filter-options scan (`low` priority): `low` work can only start while total in-flight fetches are below `FISHING_FETCH_CONCURRENCY − FISHING_FETCH_RESERVED`, and a queued `low` fetch that a search also needs is promoted.
- `/fishing/schedules` answers after `FISHING_SEARCH_SOFT_DEADLINE_MS` with whatever sources have responded. Slower sources keep loading in the background and are listed in `warning` ("응답이 늦은 예약처는 …"); the web UI recognises that exact phrase and re-queries automatically (max 2×). Keep the server message and `PENDING_SOURCES_NOTICE` in `use-auto-retry-pending.ts` in sync.
- `/fishing/options` only scans the current and next month, at `low` priority, and never waits for tide data (it just warms the badatime cache).
- Tide strength is prefetched in parallel with the scrape; a search waits at most 2 s for it after scraping, and badatime failures are not retried for 5 minutes.
- Tunable env vars (Render): `FISHING_FETCH_CONCURRENCY` (default 10), `FISHING_FETCH_RESERVED` (default 4), `FISHING_SEARCH_SOFT_DEADLINE_MS` (default 6000; `0` = wait for every source).
- Diagnostics: `GET /api/fishing/diagnostics` shows per source-month queue / response / body / parse times; each search also logs one `[검색] …` line. "서버 바쁨" near 100% means CPU-bound, near 0% means waiting on the reservation sites.

## Product

- Searches up to 90 days of open schedules.
- Filters by date range, region, port, ship, and tide.
- Shows responsive desktop rows and mobile schedule cards with direct operator and booking links.
- Surfaces source, last-checked, cache, loading, empty, retry, and validation states.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- The current source parser expects the reservation page's `.new-divs` day blocks and `r_mytable` schedule rows; if the operator changes its markup, update the source adapter before changing the UI.
- 더피싱 계열 예약 화면은 두 가지 모양이 있다. (1) 남은 자리를 이미지 `alt="남은자리 N명"`로 보여 주는 예전 화면, (2) 글자 `14명`으로 보여 주는 새 화면(예: fishingi.net 대야도 피싱아일랜드, `reservation_boat_v5.2_seat1`). 이미지가 없으면 칸 전체가 `N명`일 때만 자리로 읽는다(`예약완료`/`기상악화`/`배정비일`은 자리 없음). 새 화면은 가운데 칸에 예약자 이름·전화번호가 섞여 있으므로 장르는 `낚시종류` 줄이나 공지의 "OO 출조합니다"에서만 뽑는다.
- 새 화면은 한 번에 8일치만 보여 주고 나머지는 스크롤하면 더 불러온다(`#list_day` 숨김 입력이 있으면 그런 화면). `fetchMonth`는 마지막으로 받은 날짜 다음 날부터 `mode=list&day=…`로 이 달 끝까지(최대 8쪽) 이어 받는다. 예전 화면은 첫 쪽에 한 달이 다 있어서 추가 요청이 없다.
- 예약처 결과가 0건일 때는 `/api/fishing/diagnostics`의 `recentFetches`에서 `calendarDays`(달력에서 찾은 날짜 칸 수)와 `items`(읽은 건수)를 본다: `calendarDays`가 0이면 달력을 못 받은 것(차단/다른 화면), 있는데 `items`가 0이면 열린 자리가 없거나 읽는 방식이 다른 것.
- 이어 받는 쪽(2번째 쪽부터)이 실패해도 그 달 전체를 실패로 처리하지 않는다. 받은 날짜까지만 돌려주고, 검색 결과에 "일부 날짜는 불러오지 못한 예약처가 있어요…"를 띄우며, 그 달은 3분만 캐시한 뒤 다시 시도한다(`partialMonthNotes`). 첫 쪽부터 실패하면 예전처럼 그 예약처는 실패다. `/api/fishing/diagnostics`의 `partialError`/`missingFrom`으로 어느 날짜부터 왜 못 받았는지 볼 수 있다.
- 검색이 통째로 실패(조회 대상 예약처가 전부 실패)하면 서버가 502와 함께 `detail`에 "예약처: 이유"를 담아 보내고(`AllSourcesFailedError`), 화면(`App.tsx`)의 오류 카드가 "원인: …" 한 줄로 보여 준다. 접속 실패 이유는 `describeFetchFailure`가 한글로 풀어 쓴다(시간 초과 15초 / 주소를 찾지 못함 / 연결 거부됨 / HTTP 403 …). 3번 연속 실패한 예약처는 10분간 건너뛰며, 그동안은 "반복 실패로 잠시 건너뜀 - 이전 오류 …"로 나온다.
- Run API codegen after changing `lib/api-spec/openapi.yaml`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
