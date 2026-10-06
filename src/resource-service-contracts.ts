import type { ResourceInventoryBody, ResourceInventoryEntry, ResourceInventorySnapshot, ResourceManualSource } from "./resource-inventory-contracts.js";
import type { ResourceUsageDistribution, ResourceUsageQuery, ResourceUsageStats, ResourceUsageTrend } from "./resource-contracts.js";

export type ResourceCandidate = "all" | "unused" | "low" | "old" | "broken" | "duplicate" | "favorite" | "review";
export interface ResourceLocalQuery extends ResourceUsageQuery {
  candidate?: ResourceCandidate;
  lowSessions?: number;
  inactiveDays?: number;
}
export interface ResourceLocalRow {
  body: ResourceInventoryBody;
  entries: ResourceInventoryEntry[];
  favorite: boolean;
  firstSeenAt: string;
  usage: ResourceUsageStats | null;
  historyIds: string[];
  observation: "recorded" | "unknown" | "insufficient";
  candidates: Exclude<ResourceCandidate, "all">[];
  protected: boolean;
}
export interface ResourceLocalResult {
  rows: ResourceLocalRow[];
  total: number;
  page: number;
  pageSize: number;
  observedAt: string;
  partial: boolean;
  thresholds: { lowSessions: number; inactiveDays: number };
}
export interface ResourceLocalDetail {
  row: ResourceLocalRow;
  inventory: Pick<ResourceInventorySnapshot, "observedAt" | "sources" | "gaps">;
  timeZone: string;
  trend: ResourceUsageTrend[];
  clients: ResourceUsageDistribution[];
  projects: ResourceUsageDistribution[];
}
export interface ResourceStatus {
  observedAt: string | null;
  sources: ResourceInventorySnapshot["sources"];
  gaps: ResourceInventorySnapshot["gaps"];
  projects: string[];
  favoriteIds: string[];
  manualSources: ResourceManualSource[];
}
