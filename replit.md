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
- Run API codegen after changing `lib/api-spec/openapi.yaml`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
