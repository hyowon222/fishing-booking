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
- `artifacts/api-server/src/lib/fishing-source.ts` — public reservation source fetch, parsing, and five-minute cache
- `artifacts/api-server/src/routes/fishing.ts` — schedule and filter-options endpoints
- `lib/api-spec/openapi.yaml` — source of truth for the generated API client and Zod response schemas

## Architecture decisions

- The lookup reads the configured public source directly instead of copying schedules into the database, so seat counts stay close to the operator's page.
- Source URL, region, port, and operator name can be changed through `FISHING_SOURCE_URL`, `FISHING_SOURCE_REGION`, `FISHING_SOURCE_PORT`, and `FISHING_SOURCE_NAME`.
- Search responses are cached in memory for five minutes to reduce load on the public reservation source while keeping the UI responsive.

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
