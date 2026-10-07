import type { ResourceUsageDetail, ResourceUsageEvidenceQuery, ResourceUsageEvidenceResult, ResourceUsageQuery, ResourceUsageResult } from "../src/resource-contracts";
import type { ResourceLocalDetail, ResourceLocalQuery, ResourceLocalResult, ResourceOverviewDetail, ResourceOverviewQuery, ResourceOverviewResult, ResourceStatus } from "../src/resource-service-contracts";
import type { ResourceManualSource } from "../src/resource-inventory-contracts";
import type { ResourceArchiveState, ResourceManagementArchive, ResourceManagementInput, ResourceManagementOperation, ResourceManagementOperations, ResourceManagementPreview } from "../src/resource-management-contracts";
import type { JsonValue } from "../src/contracts";
import { request } from "./api";

export type ResourceUsageFilters = ResourceUsageQuery & { favorite?: boolean };
export type FavoriteResult<T> = T & { favoriteIds?: string[] };
export interface ResourceArchiveResult { archives: ResourceManagementArchive[]; total: number; page: number; pageSize: number }
export interface ResourceManagementQuery { kind?: "skill" | "mcp"; client?: string; project?: string; q?: string; page?: number; pageSize?: number }

export function resourceQuery(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "" && value !== false) params.set(key, String(value));
  }
  return params.size ? `?${params}` : "";
}

export const resourceApi = {
  status: (signal?: AbortSignal) => request<ResourceStatus>("/resources/status", { signal }),
  refresh: () => request<ResourceStatus>("/resources/refresh", { method: "POST", body: {} }),
  overview: (query: ResourceOverviewQuery, signal?: AbortSignal) => request<FavoriteResult<ResourceOverviewResult>>(`/resources/overview${resourceQuery(query)}`, { signal }),
  overviewDetail: (id: string, query: ResourceOverviewQuery, signal?: AbortSignal) => request<FavoriteResult<ResourceOverviewDetail>>(`/resources/overview/${encodeURIComponent(id)}${resourceQuery(query)}`, { signal }),
  usage: (query: ResourceUsageFilters, signal?: AbortSignal) => request<FavoriteResult<ResourceUsageResult>>(`/resources/usage${resourceQuery(query)}`, { signal }),
  usageDetail: (id: string, query: ResourceUsageQuery, signal?: AbortSignal) => request<FavoriteResult<ResourceUsageDetail>>(`/resources/usage/${encodeURIComponent(id)}${resourceQuery(query)}`, { signal }),
  evidence: (id: string, query: ResourceUsageEvidenceQuery, signal?: AbortSignal) => request<ResourceUsageEvidenceResult>(`/resources/usage/${encodeURIComponent(id)}/evidence${resourceQuery(query)}`, { signal }),
  local: (query: ResourceLocalQuery, signal?: AbortSignal) => request<ResourceLocalResult>(`/resources/local${resourceQuery(query)}`, { signal }),
  localDetail: (id: string, query: ResourceLocalQuery, signal?: AbortSignal) => request<ResourceLocalDetail>(`/resources/local/${encodeURIComponent(id)}${resourceQuery(query)}`, { signal }),
  favorite: (id: string, value: boolean) => request<{ favoriteIds: string[] }>("/resources/favorites", { method: "POST", body: { id, value } }),
  addSource: (source: ResourceManualSource) => request<ResourceStatus>("/resources/sources", { method: "POST", body: source as unknown as JsonValue }),
  removeSource: (id: string) => request<ResourceStatus>(`/resources/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
  archives: (state: ResourceArchiveState, query: ResourceManagementQuery, signal?: AbortSignal) => request<ResourceArchiveResult>(`/resources/archives${resourceQuery({ ...query, state })}`, { signal }),
  operations: (query: ResourceManagementQuery, signal?: AbortSignal) => request<ResourceManagementOperations>(`/resources/operations${resourceQuery(query)}`, { signal }),
  preview: (input: ResourceManagementInput) => request<ResourceManagementPreview>("/resources/preview", { method: "POST", body: input as unknown as JsonValue }),
  apply: (previewId: string) => request<ResourceManagementOperation>("/resources/apply", { method: "POST", body: { previewId, confirmed: true } }),
};
