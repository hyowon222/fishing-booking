import type { QueryKey, UseMutationOptions, UseMutationResult, UseQueryOptions, UseQueryResult } from '@tanstack/react-query';
import type { ErrorResponse, FishingFilterOptions, FishingScheduleSearchResponse, FishingSource, FishingSourceInput, FishingSourceVesselsInput, HealthStatus, SearchFishingSchedulesParams } from './api.schemas';
import { customFetch } from '../custom-fetch';
import type { ErrorType, BodyType } from '../custom-fetch';
type AwaitedInput<T> = PromiseLike<T> | T;
type Awaited<O> = O extends AwaitedInput<infer T> ? T : never;
type SecondParameter<T extends (...args: never) => unknown> = Parameters<T>[1];
export declare const getHealthCheckUrl: () => string;
/**
 * Returns server health status
 * @summary Health check
 */
export declare const healthCheck: (options?: Parameters<typeof customFetch>[1]) => Promise<HealthStatus>;
export declare const getHealthCheckQueryKey: () => readonly ["/api/healthz"];
export declare const getHealthCheckQueryOptions: <TData = Awaited<ReturnType<typeof healthCheck>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData> & {
    queryKey: QueryKey;
};
export type HealthCheckQueryResult = NonNullable<Awaited<ReturnType<typeof healthCheck>>>;
export type HealthCheckQueryError = ErrorType<unknown>;
/**
 * @summary Health check
 */
export declare function useHealthCheck<TData = Awaited<ReturnType<typeof healthCheck>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getSearchFishingSchedulesUrl: (params: SearchFishingSchedulesParams) => string;
/**
 * Searches the configured public reservation source for sailings matching the requested filters.
 * @summary Search available boat fishing schedules
 */
export declare const searchFishingSchedules: (params: SearchFishingSchedulesParams, options?: Parameters<typeof customFetch>[1]) => Promise<FishingScheduleSearchResponse>;
export declare const getSearchFishingSchedulesQueryKey: (params?: SearchFishingSchedulesParams) => readonly ["/api/fishing/schedules", ...SearchFishingSchedulesParams[]];
export declare const getSearchFishingSchedulesQueryOptions: <TData = Awaited<ReturnType<typeof searchFishingSchedules>>, TError = ErrorType<ErrorResponse>>(params: SearchFishingSchedulesParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof searchFishingSchedules>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof searchFishingSchedules>>, TError, TData> & {
    queryKey: QueryKey;
};
export type SearchFishingSchedulesQueryResult = NonNullable<Awaited<ReturnType<typeof searchFishingSchedules>>>;
export type SearchFishingSchedulesQueryError = ErrorType<ErrorResponse>;
/**
 * @summary Search available boat fishing schedules
 */
export declare function useSearchFishingSchedules<TData = Awaited<ReturnType<typeof searchFishingSchedules>>, TError = ErrorType<ErrorResponse>>(params: SearchFishingSchedulesParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof searchFishingSchedules>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetFishingFilterOptionsUrl: () => string;
/**
 * Returns filter values discovered from the configured public reservation source.
 * @summary Get available fishing filters
 */
export declare const getFishingFilterOptions: (options?: Parameters<typeof customFetch>[1]) => Promise<FishingFilterOptions>;
export declare const getGetFishingFilterOptionsQueryKey: () => readonly ["/api/fishing/options"];
export declare const getGetFishingFilterOptionsQueryOptions: <TData = Awaited<ReturnType<typeof getFishingFilterOptions>>, TError = ErrorType<ErrorResponse>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getFishingFilterOptions>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getFishingFilterOptions>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetFishingFilterOptionsQueryResult = NonNullable<Awaited<ReturnType<typeof getFishingFilterOptions>>>;
export type GetFishingFilterOptionsQueryError = ErrorType<ErrorResponse>;
/**
 * @summary Get available fishing filters
 */
export declare function useGetFishingFilterOptions<TData = Awaited<ReturnType<typeof getFishingFilterOptions>>, TError = ErrorType<ErrorResponse>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getFishingFilterOptions>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getListFishingSourcesUrl: () => string;
/**
 * @summary List configured fishing reservation sources
 */
export declare const listFishingSources: (options?: Parameters<typeof customFetch>[1]) => Promise<FishingSource[]>;
export declare const getListFishingSourcesQueryKey: () => readonly ["/api/fishing/sources"];
export declare const getListFishingSourcesQueryOptions: <TData = Awaited<ReturnType<typeof listFishingSources>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listFishingSources>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listFishingSources>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListFishingSourcesQueryResult = NonNullable<Awaited<ReturnType<typeof listFishingSources>>>;
export type ListFishingSourcesQueryError = ErrorType<unknown>;
/**
 * @summary List configured fishing reservation sources
 */
export declare function useListFishingSources<TData = Awaited<ReturnType<typeof listFishingSources>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listFishingSources>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getCreateFishingSourceUrl: () => string;
/**
 * @summary Add a fishing reservation source
 */
export declare const createFishingSource: (fishingSourceInput: FishingSourceInput, options?: Parameters<typeof customFetch>[1]) => Promise<FishingSource>;
export declare const getCreateFishingSourceMutationKey: () => readonly ["createFishingSource"];
export declare const getCreateFishingSourceMutationOptions: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createFishingSource>>, TError, CreateFishingSourceMutationVariables, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createFishingSource>>, TError, CreateFishingSourceMutationVariables, TContext>;
export type CreateFishingSourceMutationResult = NonNullable<Awaited<ReturnType<typeof createFishingSource>>>;
export type CreateFishingSourceMutationBody = BodyType<FishingSourceInput>;
export type CreateFishingSourceMutationError = ErrorType<ErrorResponse>;
export type CreateFishingSourceMutationVariables = {
    data: BodyType<FishingSourceInput>;
};
/**
* @summary Add a fishing reservation source
*/
export declare const useCreateFishingSource: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createFishingSource>>, TError, CreateFishingSourceMutationVariables, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createFishingSource>>, TError, CreateFishingSourceMutationVariables, TContext>;
export declare const getUpdateFishingSourceUrl: (id: number) => string;
/**
 * @summary Update a fishing reservation source
 */
export declare const updateFishingSource: (id: number, fishingSourceInput: FishingSourceInput, options?: Parameters<typeof customFetch>[1]) => Promise<FishingSource>;
export declare const getUpdateFishingSourceMutationKey: () => readonly ["updateFishingSource"];
export declare const getUpdateFishingSourceMutationOptions: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateFishingSource>>, TError, UpdateFishingSourceMutationVariables, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateFishingSource>>, TError, UpdateFishingSourceMutationVariables, TContext>;
export type UpdateFishingSourceMutationResult = NonNullable<Awaited<ReturnType<typeof updateFishingSource>>>;
export type UpdateFishingSourceMutationBody = BodyType<FishingSourceInput>;
export type UpdateFishingSourceMutationError = ErrorType<ErrorResponse>;
export type UpdateFishingSourceMutationVariables = {
    id: number;
    data: BodyType<FishingSourceInput>;
};
/**
* @summary Update a fishing reservation source
*/
export declare const useUpdateFishingSource: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateFishingSource>>, TError, UpdateFishingSourceMutationVariables, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateFishingSource>>, TError, UpdateFishingSourceMutationVariables, TContext>;
export declare const getDeleteFishingSourceUrl: (id: number) => string;
/**
 * @summary Delete a fishing reservation source
 */
export declare const deleteFishingSource: (id: number, options?: Parameters<typeof customFetch>[1]) => Promise<void>;
export declare const getDeleteFishingSourceMutationKey: () => readonly ["deleteFishingSource"];
export declare const getDeleteFishingSourceMutationOptions: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteFishingSource>>, TError, DeleteFishingSourceMutationVariables, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof deleteFishingSource>>, TError, DeleteFishingSourceMutationVariables, TContext>;
export type DeleteFishingSourceMutationResult = NonNullable<Awaited<ReturnType<typeof deleteFishingSource>>>;
export type DeleteFishingSourceMutationError = ErrorType<ErrorResponse>;
export type DeleteFishingSourceMutationVariables = {
    id: number;
};
/**
* @summary Delete a fishing reservation source
*/
export declare const useDeleteFishingSource: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteFishingSource>>, TError, DeleteFishingSourceMutationVariables, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof deleteFishingSource>>, TError, DeleteFishingSourceMutationVariables, TContext>;
export declare const getAddFishingSourceVesselsUrl: (id: number) => string;
/**
 * @summary Add vessels to a fishing reservation source
 */
export declare const addFishingSourceVessels: (id: number, fishingSourceVesselsInput: FishingSourceVesselsInput, options?: Parameters<typeof customFetch>[1]) => Promise<FishingSource>;
export declare const getAddFishingSourceVesselsMutationKey: () => readonly ["addFishingSourceVessels"];
export declare const getAddFishingSourceVesselsMutationOptions: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof addFishingSourceVessels>>, TError, AddFishingSourceVesselsMutationVariables, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof addFishingSourceVessels>>, TError, AddFishingSourceVesselsMutationVariables, TContext>;
export type AddFishingSourceVesselsMutationResult = NonNullable<Awaited<ReturnType<typeof addFishingSourceVessels>>>;
export type AddFishingSourceVesselsMutationBody = BodyType<FishingSourceVesselsInput>;
export type AddFishingSourceVesselsMutationError = ErrorType<ErrorResponse>;
export type AddFishingSourceVesselsMutationVariables = {
    id: number;
    data: BodyType<FishingSourceVesselsInput>;
};
/**
* @summary Add vessels to a fishing reservation source
*/
export declare const useAddFishingSourceVessels: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof addFishingSourceVessels>>, TError, AddFishingSourceVesselsMutationVariables, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof addFishingSourceVessels>>, TError, AddFishingSourceVesselsMutationVariables, TContext>;
export declare const getClearFishingSourceVesselsUrl: (id: number) => string;
/**
 * @summary Clear manually registered vessels for a source
 */
export declare const clearFishingSourceVessels: (id: number, options?: Parameters<typeof customFetch>[1]) => Promise<void>;
export declare const getClearFishingSourceVesselsMutationKey: () => readonly ["clearFishingSourceVessels"];
export declare const getClearFishingSourceVesselsMutationOptions: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof clearFishingSourceVessels>>, TError, ClearFishingSourceVesselsMutationVariables, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof clearFishingSourceVessels>>, TError, ClearFishingSourceVesselsMutationVariables, TContext>;
export type ClearFishingSourceVesselsMutationResult = NonNullable<Awaited<ReturnType<typeof clearFishingSourceVessels>>>;
export type ClearFishingSourceVesselsMutationError = ErrorType<ErrorResponse>;
export type ClearFishingSourceVesselsMutationVariables = {
    id: number;
};
/**
* @summary Clear manually registered vessels for a source
*/
export declare const useClearFishingSourceVessels: <TError = ErrorType<ErrorResponse>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof clearFishingSourceVessels>>, TError, ClearFishingSourceVesselsMutationVariables, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof clearFishingSourceVessels>>, TError, ClearFishingSourceVesselsMutationVariables, TContext>;
export {};
//# sourceMappingURL=api.d.ts.map