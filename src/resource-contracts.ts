import type { MessageDescriptor } from "./i18n/types.js";
import type { Client } from "./clients.js";
import type { Gap } from "./contracts.js";

export type ResourceKind = "skill" | "mcp";
export type ResourceEvidenceKind = "skill_call" | "skill_read" | "mcp";
export type ResourceUsageSort = "sessions" | "calls" | "reads" | "uses" | "recent" | "name";

export interface ResourceUsageQuery {
  kind?: ResourceKind;
  client?: Client;
  project?: string;
  /** 时间边界使用事件发生时间；缺失时间另计，不推入日期窗口。 */
  from?: string;
  to?: string;
  q?: string;
  sort?: ResourceUsageSort;
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
  version?: string;
  favorite?: boolean;
}

/** 历史入口身份不冒充当前安装实例，也不按名称合并不同范围。 */
export interface ResourceHistoryIdentity {
  id: string;
  kind: ResourceKind;
  name: string;
  nameDescriptor?: MessageDescriptor;
  server?: string;
  path?: string;
  client: Client;
  project?: string;
}

/** 名称总览与实际历史来源分开，来源身份保留用于精确证据和管理关联。 */
export interface ResourceUsageIdentity extends Omit<ResourceHistoryIdentity, "client"> {
  client?: Client;
  grouping: "skill" | "mcp" | "source";
}

/** 仅保留查询与定位所需元信息，不包含参数、结果正文或请求 Token。 */
export interface ResourceUsageEvent {
  id: string;
  sessionId: string;
  messageId: string;
  turnId: string;
  ordinal: number;
  client: Client;
  project?: string;
  kind: ResourceEvidenceKind;
  name: string;
  nameDescriptor?: MessageDescriptor;
  server?: string;
  path?: string;
  tool?: string;
  occurredAt?: string;
  status: "success" | "failure" | "unknown";
  durationMs?: number;
  resultMessageId?: string;
  pairing: "unique" | "missing" | "ambiguous";
  source: { path: string; sourceId: string; revision: string; fingerprint: string; recordLine: number };
}

export interface ResourceUsageStats {
  events: number;
  sessions: number;
  explicitCalls: number;
  successfulReads: number;
  mcpCalls: number;
  lastUsedAt: string | null;
  /** 有日期筛选时不纳入 events，但仍保留不能归入窗口的记录数量。 */
  missingTimeEvents: number;
  /** 结果统计仅针对显式 Skill 请求与 MCP 调用。 */
  results: { success: number; failure: number; unknown: number; recorded: number; successRate: number | null };
  duration: { samples: number; totalMs: number | null; averageMs: number | null };
}

export interface ResourceUsageCoverage {
  sessionCount: number;
  clients: Client[];
  missingTimeEvents: number;
  unassociatedEvents: number;
  partial: boolean;
  gaps: Gap[];
  uncertainClients?: Client[];
  unscopedGaps?: boolean;
  unavailableClients?: Client[];
  unscopedUnavailableGaps?: boolean;
}

export interface ResourceUsageRow {
  identity: ResourceUsageIdentity;
  stats: ResourceUsageStats;
  association: ResourceHistoryAssociation;
  clients: Client[];
  favorite: boolean;
  paths?: string[];
}

export interface ResourceUsageResult {
  version: string;
  resources: ResourceUsageRow[];
  total: number;
  page: number;
  pageSize: number;
  stats: ResourceUsageStats;
  timeZone: string;
  trend: ResourceUsageTrend[];
  clients: ResourceUsageDistribution[];
  projects: ResourceUsageDistribution[];
  coverage: ResourceUsageCoverage;
}

export interface ResourceUsageDistribution {
  value: string | null;
  stats: ResourceUsageStats;
}
export interface ResourceUsageTrend { date: string; stats: ResourceUsageStats }
export interface ResourceUsageTool { name: string; stats: ResourceUsageStats }
export interface ResourceUsageDetail {
  version: string;
  resource: ResourceUsageRow;
  timeZone: string;
  trend: ResourceUsageTrend[];
  clients: ResourceUsageDistribution[];
  projects: ResourceUsageDistribution[];
  tools: ResourceUsageTool[];
  coverage: ResourceUsageCoverage;
  origins: ResourceHistoryIdentity[];
}
export interface ResourceUsageEvidenceQuery extends ResourceUsageQuery {
  evidenceKind?: ResourceEvidenceKind;
  tool?: string;
}
export interface ResourceUsageEvidenceResult {
  version: string;
  identity: ResourceUsageIdentity;
  events: ResourceUsageEvent[];
  total: number;
  page: number;
  pageSize: number;
  missingTimeEvents: number;
}

/** 盘点快照可提供这些最小字段；没有路径证据时不会凭名称绑定。 */
export interface ResourceAssociationEntry {
  id: string;
  kind: ResourceKind;
  name: string;
  client: Client;
  project?: string;
  scope: "user" | "project";
  entryPath: string;
  targetPath?: string;
  server?: string;
  /** 已核验的同一路径原生名称；不能用作缺失路径时的关联依据。 */
  nativeNames?: string[];
}
export interface ResourceHistoryAssociation {
  state: "linked" | "partial" | "ambiguous" | "unassociated";
  entryIds: string[];
  reason: "recorded_path" | "partial_link" | "multiple_entries" | "missing_path" | "not_discovered";
}

export interface ResourceEventStream {
  version: string;
  events: Iterable<ResourceUsageEvent>;
  sessionCount: number;
  clients: Client[];
  gaps: Gap[];
  /** 与资源采集相关的缺口范围；原始诊断始终完整保留在 gaps。 */
  uncertainClients?: Client[];
  unscopedGaps?: boolean;
  unavailableClients?: Client[];
  unscopedUnavailableGaps?: boolean;
}
