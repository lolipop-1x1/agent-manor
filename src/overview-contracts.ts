import type { CoverageSummary, Gap, Repository } from "./contracts.js";
import type { MessageDescriptor } from "./i18n/types.js";
import type { ResourceUsageEvent } from "./resource-contracts.js";
import type { SessionMessage, SessionSummary, SessionUsage } from "./session-contracts.js";
import type { RequestCost, UsageReport, UsageStatistics, UsageTotals } from "./usage-contracts.js";

export interface WeeklyReviewDistribution {
  average: number | null;
  median: number | null;
  p90: number | null;
  maximum: number | null;
  samples: number;
  missing: number;
  inferredSamples?: number;
}
export interface WeeklyReviewRank {
  key: string;
  name: string;
  nameDescriptor?: MessageDescriptor;
  count: number;
  share: number | null;
  sessions: number;
  requests: number;
  tokens: number | null;
  tokenSamples: number;
  tokenMissing: number;
  estimatedCost: number | null;
  costCoverage: RequestCost["coverage"];
}
export interface WeeklyReviewRecord {
  id: string;
  sessionId: string;
  title: string;
  titleOrigin?: SessionSummary["titleOrigin"];
  client: string;
  project?: string;
  relationship?: SessionSummary["relationship"];
  turnId?: string;
  messageId?: string;
  requestId?: string;
  occurredAt?: string;
  startedAt?: string;
  endedAt?: string;
  roundCount?: number;
  steps?: number;
  toolCalls?: number;
  tokens?: number | null;
  durationMs?: number | null;
  inputTokens?: number;
  cachedInputTokens?: number;
  freshInputTokens?: number;
  cacheShare?: number | null;
  hypotheticalPremium?: number | null;
  cost?: RequestCost;
  model?: string;
  reasoningEffort?: string;
  promptCharacters?: number;
  compressions?: number;
  tool?: string;
  server?: string;
  failures?: number;
  subsequentCalls?: number;
  completion?: "explicit" | "inferred" | "unconfirmed";
  eligible?: boolean;
  finalEvidence?: SessionMessage["finalEvidence"];
}
export interface WeeklyReview {
  version: string;
  priceVersion: string;
  timezone: string;
  query: OverviewQuery;
  range: OverviewRange;
  sessions: { active: number; started: number; compressionSessions: number; compressions: number; compressionObservableSessions: number;
    compressionRate: number | null; roundsPerSession: WeeklyReviewDistribution; uncompressedPeakInput: WeeklyReviewDistribution };
  rounds: { started: number; completed: number; inferredIncluded?: number; inferred: number; unconfirmed: number; missingEndTime: number;
    steps: WeeklyReviewDistribution; toolCalls: WeeklyReviewDistribution; tokens: WeeklyReviewDistribution; durationMs: WeeklyReviewDistribution;
    topFiveTokenShare: number | null; longest: WeeklyReviewRecord[]; highestTokens: WeeklyReviewRecord[] };
  cache: { requests: number; zero: number; partial: number; full: number; unknown: number; inputTokens: number | null;
    cachedInputTokens: number | null; readShare: number | null; readShareSamples: number; readShareMissing: number; freshInputTokens: number | null; freshSamples: number;
    hypotheticalPremium: number | null; premiumSamples: number; premiumMissing: number; largestFreshInputs: WeeklyReviewRecord[] };
  preferences: { agents: WeeklyReviewRank[]; models: WeeklyReviewRank[]; reasoning: WeeklyReviewRank[];
    promptCharacters: WeeklyReviewDistribution; promptInputs: number; promptMixedInputs: number | null;
    hours: { hour: number; messages: number }[]; weekdays: { weekday: number; messages: number }[];
    weekdayHours: { weekday: number; hour: number; messages: number }[]; busiestHour: number | null; userMessages: number };
  extensions: { projects: WeeklyReviewRank[]; compressionLeaders: WeeklyReviewRecord[];
    children: { sessions: number; requests: number; tokens: number | null; estimatedCost: number | null;
      requestShare: number | null; tokenShare: number | null; costShare: number | null; costCoverage: RequestCost["coverage"];
      tokenSamples: number; tokenMissing: number; userTokenSamples: number; userTokenMissing: number };
    tools: { calls: number; failures: number; failedRounds: number; subsequentCalls: number; unknownResults: number } };
  coverage: { gaps: Gap[]; gapCount: number; missingTimeEvents: number; missingTimeRequests: number;
    unassignedRequests: number; excludedChildUserInputs: number; triggerIdentity: "unclassified";
    automaticSessions: number | null; unknownTriggerSessions: number; unsupportedCompressionSessions: number; unknownForkSessions: number };
}
export type WeeklyReviewDetailKind = "sessions" | "sessionRounds" | "rounds" | "cache" | "compressions" | "projects" | "delegation" | "tools"
  | "agents" | "models" | "reasoning" | "prompts" | "activity" | "uncompressed";
export interface WeeklyReviewDetailQuery {
  kind: WeeklyReviewDetailKind;
  key?: string;
  filter?: "zero" | "partial" | "full" | "unknown" | "ended" | "explicit" | "inferred" | "unconfirmed";
  sort?: "recent" | "duration" | "tokens" | "steps" | "fresh" | "rounds";
  page?: number;
  pageSize?: number;
}
/** 复盘派生事实只保留输入长度及短定位片段，不复制工具参数或完整正文。 */
export type WeeklyReviewEvent = OverviewEvent & Pick<SessionMessage, "final" | "finalEvidence" | "finalAt" | "interrupted"> & { recordLine: number;
  promptCharacters?: number; promptPreview?: string; hasReply?: boolean };
export interface WeeklyReviewDetailPage {
  version: string;
  priceVersion: string;
  timezone: string;
  query: OverviewQuery;
  range: OverviewRange;
  detail: WeeklyReviewDetailQuery;
  rows: WeeklyReviewRecord[];
  ranks?: WeeklyReviewRank[];
  total: number;
  page: number;
  pageSize: number;
  review: Omit<WeeklyReview, "rounds" | "cache" | "preferences" | "extensions">;
}

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
  costCoverage?: RequestCost["coverage"];
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
export interface OverviewProcess {
  tools: OverviewToolRow[];
  categories: OverviewCountRow[];
  results: OverviewResultCounts;
  failures: number;
  /** 聚合内部使用；HTTP 报告返回空数组，完整过程通过分页证据查询。 */
  failureSequences: OverviewFailureSequence[];
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
  activity?: { read: number; edit: number; failure: number };
  hotspots: OverviewRepositoryHotspot[];
  gapCount: number;
}
export type OverviewEvidenceKind = "activity" | "sessions" | "requests" | "resources" | "tools"
  | "failures" | "combinations" | "observations" | "sequence" | "delegation";
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

export const overviewPanels = ["core", "usage", "resources", "process", "repositories", "insights"] as const;
export type OverviewPanel = typeof overviewPanels[number] | "distribution" | "delegation" | "facets";
export type OverviewDistributionDimension = "client" | "project" | "model";
export type OverviewDelegationSummary = Pick<OverviewDelegation, "eligibleMainSessions" | "withChildActivity"
  | "unknownMainSessions" | "forkSessions" | "unknownRelationshipSessions">;
/** 各区域及调查共享固定的完整索引、价格、本地日期和筛选。 */
export interface OverviewSnapshot extends Pick<OverviewReport, "version" | "priceVersion" | "timezone" | "query" | "range"> {}
/** 页面分区只包含当前区域的数据；完整兼容报告仍使用 OverviewReport。 */
export type OverviewPanelData = Partial<Omit<OverviewReport, "usage" | "distributions">> & {
  usage?: UsageStatistics;
  distribution?: OverviewCountRow[];
  delegationSummary?: OverviewDelegationSummary;
};
export type OverviewViewReport = OverviewSnapshot & OverviewPanelData;
export interface OverviewPanelResult {
  snapshot: OverviewSnapshot;
  panel: OverviewPanel;
  data: OverviewPanelData;
  dimension?: OverviewDistributionDimension;
  /** 首页截取行数不影响完整调查数量。 */
  counts?: Partial<Record<"skills" | "mcp" | "clients" | "projects" | "models" | "tools" | "observations" | "sessionCombinations" | "turnCombinations", number>>;
}
export type OverviewDetailView = "resources" | "resource" | "ranking" | "months" | "transitions" | "observations" | "combinations";
export interface OverviewDetailQuery {
  view: OverviewDetailView;
  kind?: "skill" | "mcp";
  resourceId?: string;
  dimension?: "client" | "project" | "model" | "tool";
  unit?: "session" | "turn";
  transition?: "all" | "switch" | "delegation";
  sort?: "uses" | "sessions" | "count" | "tokens" | "cost";
  page?: number;
  pageSize?: number;
}
export type OverviewDetailRow = OverviewResourceRow | OverviewCountRow | OverviewResourceObservation | OverviewResourceCombination
  | OverviewProjectMonth | OverviewModelTransition;
export interface OverviewDetailPage {
  snapshot: OverviewSnapshot;
  query: OverviewDetailQuery;
  rows: OverviewDetailRow[];
  total: number;
  page: number;
  pageSize: number;
  object?: OverviewResourceRow;
  counts?: Partial<Record<"clients" | "projects" | "tools", number>>;
}
