export * from "./generated/api";

// generated/types는 generated/api.ts의 zod 값(export const)과 이름이 겹치는
// 항목이 있으면 "export *"끼리 충돌(ambiguous export)이 난다. DetectFishingSourceBody/
// DetectFishingSourceResponse는 api.ts 쪽 zod 값으로 이미 완전히 커버되므로
// (런타임 검증 + 필요하면 z.infer로 타입도 뽑을 수 있음), types 쪽 중복 재수출만
// 제외하고 나머지는 그대로 내보낸다. generated/types/index.ts가 바뀌면
// (코드생성 다시 돌렸는데 새 충돌이 또 생기면) 여기 목록도 같이 손봐줘야 한다.
export type { ErrorResponse } from "./generated/types/errorResponse";
export type { FishingFilterOptions } from "./generated/types/fishingFilterOptions";
export type { FishingFilterOptionsShipsByPort } from "./generated/types/fishingFilterOptionsShipsByPort";
export type { FishingFilterOptionsShipsByRegion } from "./generated/types/fishingFilterOptionsShipsByRegion";
export type { FishingSchedule } from "./generated/types/fishingSchedule";
export type { FishingScheduleSearchResponse } from "./generated/types/fishingScheduleSearchResponse";
export type { FishingSource } from "./generated/types/fishingSource";
export type { FishingSourceInput } from "./generated/types/fishingSourceInput";
export type { FishingSourceVessel } from "./generated/types/fishingSourceVessel";
export type { FishingSourceVesselInput } from "./generated/types/fishingSourceVesselInput";
export type { FishingSourceVesselsInput } from "./generated/types/fishingSourceVesselsInput";
export type { HealthStatus } from "./generated/types/healthStatus";
export type { SearchFishingSchedulesParams } from "./generated/types/searchFishingSchedulesParams";
