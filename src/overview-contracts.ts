import type { CoverageSummary, Gap, Repository } from "./contracts.js";
import type { MessageDescriptor } from "./i18n/types.js";
import type { ResourceUsageEvent } from "./resource-contracts.js";
import type { SessionMessage, SessionSummary, SessionUsage } from "./session-contracts.js";
import type { RequestCost, UsageReport, UsageTotals } from "./usage-contracts.js";

export type OverviewWindow = "365" | "7" | "30" | "90" | "year" | "all" | "custom";
export interface OverviewQuery {
  window?: OverviewWindow;
  from?: string;
  to?: string;
  timezone?: string;
  version?: string;
  priceVersion?: string;
  /** 报告快照的本地日期；下钻沿用，刷新时重新获取。 */
  anchorDay?: string;
  clients?: string[];
  projects?: string[];
  /** 模型条件仅作用于用量区域及用量洞察。 */
  models?: string[];
}
export interface OverviewPeriod { from: string; to: string }
export interface OverviewRange extends OverviewPeriod {
  all: boolean;
  today: string;
  includesToday: boolean;
  comparison: { current: OverviewPeriod; previous: OverviewPeriod } | null;
  recent: { current: OverviewPeriod; previous: OverviewPeriod } | null;
}
/** 跨会话统计投影不包含消息正文或工具参数。 */
export type OverviewEvent = Pick<SessionMessage, "id" | "sessionId" | "ordinal" | "turnId" | "kind"
  | "occurredAt" | "model" | "callId" | "tool" | "status" | "durationMs" | "copied"
  | "contextSource" | "contextEvidence" | "resource"> & {
  resultMessageId?: string;
  pairing?: "unique" | "missing" | "ambiguous";
};
export interface OverviewRequest {
  sessionId: string;
  /** 原来源中的稳定顺序；无法确定时不生成相邻关系。 */
  ordinal?: number;
  usage: SessionUsage;
}
export interface OverviewSource {
  version: string;
  sessions: SessionSummary[];
  events: OverviewEvent[];
  requests: OverviewRequest[];
  resources: ResourceUsageEvent[];
  gaps: Gap[];
}
export interface OverviewResultCounts {
  calls: number;
  success: number;
  failure: number;
  unknown: number;
  known: number;
  failureRate: number | null;
  coverage: number | null;
}
export interface OverviewCountRow {
  key: string;
  name: string;
  nameDescriptor?: MessageDescriptor;
  count: number;
  sessions: number;
  requests?: number;
  tokens?: number | null;
  estimatedCost?: number | null;
  results?: OverviewResultCounts;
}
export interface OverviewActivityDay {
  day: string;
  sessions: number;
  events: number;
  requests: number;
  tokens: number | null;
  toolCalls: number;
}
export interface OverviewActivity {
  days: OverviewActivityDay[];
  weekdays: { weekday: number; events: number; sessions: number }[];
  hours: { hour: number; events: number; sessions: number }[];
  weekdayHours: { weekday: number; hour: number; events: number; sessions: number }[];
  missingTimeEvents: number;
  missingTimeSessions: number;
  datedSessions: number;
  crossDaySessions: number;
}
export interface OverviewResourceRow {
  id: string;
  kind: "skill" | "mcp";
  name: string;
  nameDescriptor?: MessageDescriptor;
  uses: number;
  sessions: number;
  explicitCalls: number;
  successfulReads: number;
  activeWeeks: number;
  firstDay: string | null;
  lastDay: string | null;
  averagePerSession: number | null;
  clients: OverviewCountRow[];
  projects: OverviewCountRow[];
  tools: OverviewCountRow[];
  days: { day: string; uses: number; sessions: number }[];
  results: OverviewResultCounts;
}
export interface OverviewResourceObservation {
  resourceId: string;
  name: string;
  nameDescriptor?: MessageDescriptor;
  kind: "skill" | "mcp";
  firstDay: string;
  window: OverviewPeriod;
  state: "mature" | "observing" | "outside_range" | "insufficient_coverage";
  reused: boolean | null;
  subsequentDays: number;
  firstEventId: string;
}
export interface OverviewResourceCombination {
  id: string;
  resources: [string, string];
  names: [string, string];
  unit: "session" | "turn";
  count: number;
  sessions: number;
}
export interface OverviewResources {
  skills: OverviewResourceRow[];
  mcp: OverviewResourceRow[];
  observations: OverviewResourceObservation[];
  combinations: { sessions: OverviewResourceCombination[]; turns: OverviewResourceCombination[] };
  missingTimeEvents: number;
  missingTurnEvents: number;
}
export type OverviewToolCategory = "read" | "search" | "edit" | "command" | "delegate" | "external" | "other";
export interface OverviewToolRow extends OverviewCountRow {
  category: OverviewToolCategory;
  server?: string;
  results: OverviewResultCounts;
  activeDays: number;
  clients: OverviewCountRow[];
  projects: OverviewCountRow[];
  days: { day: string; calls: number; failures: number }[];
}
export interface OverviewFailureSequence {
  sessionId: string;
  turnId: string;
  tool: string;
  server?: string;
  failures: string[];
  /** 多次失败的共同后续调用按身份只存一份。 */
  calls: { messageId: string; resultMessageId?: string; ordinal: number; status: "success" | "failure" | "unknown" }[];
  truncated: boolean;
}
export interface OverviewTimingGroup {
  id: string;
  client: string;
  model: string | null;
  window: "response" | "generation";
  basis: "recorded" | "estimated";
  method: string;
  samples: number;
  duration: { medianMs: number | null; p90Ms: number | null; maxMs: number | null; averageMs: number | null;
    histogram?: { fromMs: number; toMs: number; count: number }[] };
  speed: { samples: number; median: number | null; p90: number | null; average: number | null };
  longest: { sessionId: string; requestId: string; messageId?: string; durationMs: number }[];
}
export interface OverviewProcess {
  tools: OverviewToolRow[];
  categories: OverviewCountRow[];
  results: OverviewResultCounts;
  failures: number;
  /** 聚合内部使用；HTTP 报告返回空数组，完整过程通过分页证据查询。 */
  failureSequences: OverviewFailureSequence[];
  compressions: number;
  compressionSessions: number;
  timing: OverviewTimingGroup[];
  missingTimingRequests: number;
}
export interface OverviewDelegation {
  eligibleMainSessions: number;
  withChildActivity: number;
  unknownMainSessions: number;
  forkSessions: number;
  unknownRelationshipSessions: number;
  childRequests: number;
  assignedRequests: number;
  childTokens: number | null;
  assignedTokens: number | null;
}
export interface OverviewSummary {
  sessions: number;
  mainSessions: number;
  childSessions: number;
  forkSessions: number;
  requests: number;
  tokens: number | null;
  estimatedCost: number | null;
  tokenCoverage: "complete" | "partial" | "missing";
  costCoverage: "complete" | "partial" | "missing";
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  projectCount: number;
  modelCount: number;
  resourceCount: number;
  peak: { sessionId: string; requestId: string; messageId?: string; occurredAt?: string; tokens: number } | null;
}
export interface OverviewRepositoryHotspot {
  path: string;
  read: number;
  edit: number;
  failure: number;
  comparison?: { read: number; edit: number; failure: number };
  previous?: { read: number; edit: number; failure: number };
}
export interface OverviewRepository {
  repository: Repository;
  state: "ready" | "unready" | "unavailable";
  version?: string;
  baselineHash?: string;
  createdAt?: string;
  summary?: CoverageSummary;
  readCoveredFiles?: number;
  editCoveredFiles?: number;
  comparisonSummary?: CoverageSummary;
  previousSummary?: CoverageSummary;
  activity?: { read: number; edit: number; failure: number };
  comparisonActivity?: { read: number; edit: number; failure: number };
  previousActivity?: { read: number; edit: number; failure: number };
  hotspots: OverviewRepositoryHotspot[];
  gapCount: number;
}
export type OverviewEvidenceKind = "activity" | "sessions" | "requests" | "resources" | "tools"
  | "failures" | "compressions" | "timing" | "combinations" | "observations" | "sequence" | "delegation";
export interface OverviewEvidenceQuery {
  kind: OverviewEvidenceKind;
  scope?: "global" | "usage";
  period?: "selected" | "current" | "previous" | "recent" | "recent_previous";
  from?: string;
  to?: string;
  day?: string;
  /** 仅调查缺少可靠发生时间的事实，不把它们放入日期桶。 */
  undated?: boolean;
  client?: string;
  project?: string;
  model?: string;
  sessionId?: string;
  requestId?: string;
  turnId?: string;
  ordinalFrom?: number;
  ordinalTo?: number;
  modelFrom?: string;
  modelTo?: string;
  transition?: "switch" | "delegation";
  relationship?: "main" | "child" | "fork";
  resourceId?: string;
  resourceKind?: "skill" | "mcp";
  resourceId2?: string;
  resourceEvidenceKind?: "skill_call" | "skill_read" | "mcp";
  tool?: string;
  toolId?: string;
  toolKey?: string;
  server?: string;
  category?: OverviewToolCategory;
  status?: "success" | "failure" | "unknown";
  timingGroup?: string;
  unit?: "session" | "turn";
  observationState?: OverviewResourceObservation["state"];
  rule?: string;
  sort?: "recent" | "tokens" | "duration" | "ordinal";
  page?: number;
  pageSize?: number;
}
export interface OverviewEvidenceRow {
  id: string;
  kind: OverviewEvidenceKind;
  sessionId: string;
  title: string;
  titleOrigin?: SessionSummary["titleOrigin"];
  client: string;
  project?: string;
  relationship?: "child" | "fork";
  occurredAt?: string;
  day?: string;
  messageId?: string;
  resultMessageId?: string;
  requestId?: string;
  turnId?: string;
  ordinal?: number;
  tool?: string;
  resourceId?: string;
  resourceName?: string;
  resourceNameDescriptor?: MessageDescriptor;
  resourceKind?: "skill" | "mcp";
  resourceEvidenceKind?: "skill_call" | "skill_read" | "mcp";
  status?: "success" | "failure" | "unknown";
  tokens?: number | null;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  model?: string;
  durationMs?: number;
  usage?: SessionUsage;
  cost?: RequestCost;
  dates?: string[];
  relatedMessageIds?: string[];
  values?: Record<string, string | number | boolean | null>;
}
export interface OverviewEvidencePage {
  version: string;
  priceVersion: string;
  timezone: string;
  query: OverviewEvidenceQuery;
  range: OverviewRange;
  rows: OverviewEvidenceRow[];
  total: number;
  page: number;
  pageSize: number;
}
export interface OverviewInsight {
  id: string;
  rule: string;
  type: "feature" | "change" | "investigation";
  descriptor: MessageDescriptor;
  object?: string;
  metric?: string;
  current: number | null;
  previous?: number | null;
  sample: number;
  missing: number;
  period: OverviewPeriod;
  previousPeriod?: OverviewPeriod;
  values?: Record<string, string | number | boolean | null>;
  evidence: OverviewEvidenceQuery;
}
export interface OverviewProjectMonth {
  month: string;
  project: string | null;
  sessions: number;
  requests: number;
  tokens: number | null;
  completeTokenRequests: number;
  partialTokenRequests: number;
  missingTokenRequests: number;
}
export interface OverviewModelTransition {
  kind: "switch" | "delegation";
  fromModel: string;
  toModel: string;
  count: number;
  sessions: number;
  evidence: OverviewEvidenceQuery;
}
export interface OverviewReport {
  version: string;
  priceVersion: string;
  timezone: string;
  query: OverviewQuery;
  range: OverviewRange;
  summary: OverviewSummary;
  /** 六指标使用全局 totals，usage 额外应用局部模型条件。 */
  totals: UsageTotals;
  usage: UsageReport;
  activity: OverviewActivity;
  distributions: { clients: OverviewCountRow[]; projects: OverviewCountRow[]; models: OverviewCountRow[] };
  projectMonths: OverviewProjectMonth[];
  modelTransitions: OverviewModelTransition[];
  resources: OverviewResources;
  process: OverviewProcess;
  delegation: OverviewDelegation;
  repositories: OverviewRepository[];
  insights: OverviewInsight[];
  featuredInsights: OverviewInsight[];
  facets: { clients: string[]; projects: string[]; models: string[] };
  coverage: { gaps: Gap[]; gapCount: number; missingTimeEvents: number; missingTimeRequests: number; missingTimeResources: number };
}
