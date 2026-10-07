import type { ResourceInventoryBody, ResourceInventoryEntry, ResourceInventorySnapshot, ResourceManualSource } from "./resource-inventory-contracts.js";
import type { ResourceKind, ResourceUsageDetail, ResourceUsageDistribution, ResourceUsageIdentity, ResourceUsageQuery, ResourceUsageResult, ResourceUsageStats, ResourceUsageTrend } from "./resource-contracts.js";
import type { MessageDescriptor } from "./i18n/types.js";
import type { Client } from "./clients.js";

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

export type ResourceOverviewCandidate = "all" | "used" | "unused" | "low" | "old" | "review" | "favorite";
export interface ResourceOverviewQuery extends Omit<ResourceLocalQuery, "candidate"> {
  candidate?: ResourceOverviewCandidate;
}
export interface ResourceOverviewRow {
  identity: ResourceUsageIdentity;
  stats: ResourceUsageStats | null;
  clients: Client[];
  favorite: boolean;
  protected: boolean;
  observation: "used" | "unused" | "unknown" | "insufficient";
  candidates: Exclude<ResourceOverviewCandidate, "all">[];
  localBodyIds: string[];
  hasHistory: boolean;
}
export interface ResourceOverviewResult {
  resources: ResourceOverviewRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<ResourceOverviewCandidate, number>;
  stats: ResourceUsageStats | null;
  coverage: ResourceUsageResult["coverage"] | null;
  observedAt: string;
  partial: boolean;
  thresholds: { lowSessions: number; inactiveDays: number };
}
export interface ResourceOverviewDetail {
  resource: ResourceOverviewRow;
  history: ResourceUsageDetail | null;
  local: ResourceLocalRow[];
}

export type ResourceMapMetric = "calls" | "sessions" | "reads";
export interface ResourceMapQuery extends Omit<ResourceOverviewQuery, "page" | "pageSize" | "sort" | "order"> {
  metric?: ResourceMapMetric;
  maxValue?: number;
}
/** 地图只保存名称、统计和本体身份；不包含 MCP 注册值或历史正文。 */
export interface ResourceMapNode {
  id: string;
  name: string;
  nameDescriptor?: MessageDescriptor;
  value: number | null;
  share: number | null;
  metrics: { calls: number; reads: number; sessions: number } | null;
  lastUsedAt: string | null;
  missingTimeEvents: number;
  clients: Client[];
  favorite: boolean;
  protected: boolean;
  observation: ResourceOverviewRow["observation"];
  localBodyIds: string[];
  hasHistory: boolean;
  partial: boolean;
}
export interface ResourceMapResult {
  kind: ResourceKind;
  metric: ResourceMapMetric;
  maxValue?: number;
  version: string | null;
  observedAt: string;
  /** 完整查询与采集覆盖是不同状态；partial 表示历史或盘点缺口。 */
  complete: true;
  partial: boolean;
  positive: ResourceMapNode[];
  zero: ResourceMapNode[];
  review: ResourceMapNode[];
  total: number;
  totalValue: number;
  counts: ResourceOverviewResult["counts"];
  coverage: ResourceOverviewResult["coverage"];
  thresholds: ResourceOverviewResult["thresholds"];
}
