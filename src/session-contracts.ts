import type { MessageDescriptor } from "./i18n/types.js";
import type { Client } from "./clients.js";
import type { Gap } from "./contracts.js";
import type { RequestSpeedSummary } from "./session-speed.js";

export type MessageKind = "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "system" | "context" | "compression";
export interface SessionMessage {
  id: string;
  sessionId: string;
  ordinal: number;
  recordLine: number;
  turnId: string;
  kind: MessageKind;
  text: string;
  /** 有界查询的正文预览；完整正文仍按消息身份读取。 */
  textLength?: number;
  textTruncated?: boolean;
  /** 仅产品生成的正文附带描述，原始会话正文保持原样。 */
  textDescriptor?: MessageDescriptor;
  occurredAt?: string;
  model?: string;
  /** 来源明确记录的思考程度，保留原始配置取值。 */
  reasoningEffort?: string;
  callId?: string;
  tool?: string;
  status?: "success" | "failure" | "unknown";
  final?: "explicit" | "inferred";
  durationMs?: number;
  /** 仅用于对话展示兜底，不代表来源确认了结束。 */
  unconfirmed?: boolean;
  /** 仅存在明确原消息身份时标记复制内容。 */
  copied?: boolean;
  /** 会话内树的叶分支成员；共同祖先可属于多个分支。 */
  branchIds?: string[];
  currentBranch?: boolean;
  resource?: { kind: "mcp" | "skill_call" | "skill_read"; name: string; nameDescriptor?: MessageDescriptor; server?: string; path?: string };
  filePaths?: string[];
  /** 注入上下文或本地 Hook 的来源；正文仍保留原记录。 */
  contextSource?: "agents_md" | "environment" | "client" | "hook";
  contextEvidence?: "client_metadata" | "wrapper";
}
/** 总览只返回定位和显示所需元信息，不加载正文。 */
export type SessionTimelineEvent = Pick<SessionMessage, "id" | "sessionId" | "ordinal" | "turnId" | "kind" | "occurredAt" | "model" | "callId" | "tool" | "status" | "durationMs" | "contextSource" | "copied"> & { usage?: boolean; turnPosition?: number; turnOffset?: number; turnCount?: number };
export interface SessionTimelineProjection { totalTurns: number; timeStart?: number; timeEnd?: number; missingTime: number; firstOrdinal?: number; lastOrdinal?: number }
export interface SessionTimelineQuery { version?: string; maxEvents?: number; messageId?: string }
export interface SessionTimelineResult {
  version: string;
  projection?: SessionTimelineProjection;
  events: (SessionTimelineEvent & { count?: number; rangeStartOrdinal?: number; rangeEndOrdinal?: number })[];
  total?: number;
  aggregated?: boolean;
}
export interface SessionRequestBoundary {
  occurredAt?: string;
  recordLine: number;
  messageId?: string;
  /** 镜像行号属于旁路原生日志，不能导航成主历史中的同号记录。 */
  source?: "mirror";
}
export interface SessionRequestTiming {
  basis: "estimated" | "recorded";
  /** 未声明的旧记录沿用含首字等待的响应区间。 */
  window?: "response" | "generation";
  method: "codex_event_boundary" | "claude_message_boundary" | "codeflicker_message_boundary"
    | "codeflicker_desktop_mirror" | "dsh_stream_window" | "pi_message_boundary" | "zcode_request_span"
    | "opencode_message_span" | "codebuddy_single_request_turn" | "workbuddy_message_boundary" | "qoder_message_boundary";
  completion: "explicit" | "inferred" | "partial" | "unknown";
  completionEvidence?: "stop_reason" | "tool_result" | "tool_response_snapshot" | "final_response_snapshot" | "persisted_stream_result" | "request_interrupted"
    | "request_completed" | "stream_finish" | "turn_metrics";
  start?: SessionRequestBoundary;
  end?: SessionRequestBoundary;
  firstToken?: SessionRequestBoundary;
  durationMs?: number;
  /** 来源单独保存输出分项时，不把独立推理用量重复加入速度分子。 */
  outputTokens?: number;
}
export interface SessionUsage {
  id: string;
  messageId?: string;
  turnId?: string;
  model?: string;
  /** 请求生效时的明确思考设置，不根据推理 Token 推断。 */
  reasoningEffort?: string;
  /** 来源明确记录的计价服务商，不根据客户端名称推断。 */
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningOutputTokens?: number;
  contextTokens?: number;
  occurredAt?: string;
  /** 模型消息组关联与原始用量记录的 messageId 定位分别保留。 */
  requestMessageIds?: string[];
  timing?: SessionRequestTiming;
}
export type SessionProfileStep = SessionUsage & { sessionId: string; branchIds?: string[]; currentBranch?: boolean };
export interface SessionSummary {
  id: string;
  client: Client;
  clientSessionId: string;
  title: string;
  titleOrigin: "recorded" | "first_user" | "task" | "agent" | "fallback";
  taskName?: string;
  agentName?: string;
  project?: string;
  projectOrigin?: "cwd" | "client_metadata" | "tool_path";
  /** 去重保留实际入口记录；恢复会话可能包含多个入口，不能据此判断父子关系。 */
  executionEntries?: { entrypoint: string; version?: string; recordLine: number }[];
  executionMode?: "quiet";
  parentSessionId?: string;
  parentTitle?: string;
  parentTitleDescriptor?: MessageDescriptor;
  relationship?: "child" | "fork";
  branches?: { id: string; label: string; labelDescriptor?: MessageDescriptor; current: boolean }[];
  /** 工具返回或元数据明确记录的子会话身份，不根据正文猜测。 */
  childSessionIds?: string[];
  startedAt?: string;
  updatedAt?: string;
  messageCount: number;
  turnCount: number;
  models: string[];
  gaps: Gap[];
}
export interface SessionSourceMeta extends SessionSummary {
  path: string;
  sourceId: string;
}
export interface SessionSink {
  message(message: SessionMessage): void;
  usage(usage: SessionUsage): void;
}
export interface SessionQuery {
  executionMode?: "regular" | "quiet" | "all";
  /** 仅控制列表；搜索与直接访问始终保留子会话。 */
  includeSubagents?: boolean;
  client?: Client;
  project?: string;
  from?: string;
  to?: string;
  q?: string;
  kinds?: MessageKind[];
  page?: number;
  pageSize?: number;
  version?: string;
}
export interface SessionMessageQuery extends SessionQuery {
  /** 省略时简易读当前分支、过程读全部；all 显式读取全部分支。 */
  branch?: string;
  mode?: "brief" | "full" | "trace";
  pageUnit?: "message" | "turn";
  turnPosition?: number;
  messageId?: string;
  toolName?: string;
  resourceKind?: "mcp" | "skill_call" | "skill_read";
  resourceName?: string;
  resourceServer?: string;
  /** 仅限制所选轮次正文；轮次目录与计数保持完整。 */
  messageLimit?: number;
  messageOffset?: number;
  maxTextChars?: number;
}
export type SessionCheckMode = "quick" | "full";
export interface SessionRefreshOptions { client?: Client; mode?: SessionCheckMode }
export interface SessionRefreshCounts {
  discovered: number;
  quickReused: number;
  verifiedReused: number;
  parsed: number;
  missing: number;
  fallbacks: { reason: string; count: number }[];
}
export interface SessionClientCheck { client: Client; checkedAt: string; mode: SessionCheckMode }
export interface SessionIndexStatus {
  version?: string;
  previousVersion?: string;
  createdAt?: string;
  stale: boolean;
  sessionCount: number;
  sourceCount: number;
  gaps: Gap[];
  projects: string[];
  clientChecks?: SessionClientCheck[];
  job?: SessionJob;
}
export interface SessionIndexSummary extends Omit<SessionIndexStatus, "gaps"> { gapCount: number }
export interface SessionJob {
  id: string;
  status: "queued" | "running" | "complete" | "failed";
  phase: string;
  phaseDescriptor?: MessageDescriptor;
  progress: number;
  createdAt: string;
  finishedAt?: string;
  error?: string;
  errorDescriptor?: MessageDescriptor;
  version?: string;
  client?: Client;
  mode?: SessionCheckMode;
  counts?: SessionRefreshCounts;
}
export interface SessionListResult {
  version: string;
  sessions: SessionSummary[];
  total: number;
  page: number;
  pageSize: number;
}
export interface SessionMessageResult {
  version: string;
  session: SessionSummary;
  messages: SessionMessage[];
  total: number;
  page: number;
  pageSize: number;
  pageUnit?: "message" | "turn";
  totalTurns?: number;
  turns?: { id: string; position: number; messageCount: number }[];
  focusMessageId?: string;
  messageOffset?: number;
  messageLimit?: number;
  hasMoreMessages?: boolean;
  /** 有界正文的配对以完整阅读范围确认，伙伴预览只补齐本页相关节点。 */
  toolPairs?: { callMessageId: string; resultMessageId: string }[];
  relatedMessages?: SessionMessage[];
  /** 当前轮次范围的完整请求集合，不因正文分页而截断。 */
  usages?: SessionProfileStep[];
}
export interface SessionSearchHit {
  session: SessionSummary;
  messageId?: string;
  turnId?: string;
  kind: MessageKind | "title";
  /** 全部分支下是否可在简易对话精确定位；标题不提供此字段。 */
  briefVisible?: boolean;
  snippet: string;
}
export interface SessionSearchResult {
  version: string;
  hits: SessionSearchHit[];
  total: number;
  page: number;
  pageSize: number;
}
export interface SessionSearchGroup { session: SessionSummary; matchCount: number; hits: SessionSearchHit[] }
export interface SessionGroupedSearchResult {
  version: string; groups: SessionSearchGroup[]; total: number; hitCount: number; page: number; pageSize: number;
}
export interface SessionTurnDirectory {
  version: string; turns: { id: string; position: number; question: string }[]; total: number; page: number; pageSize: number;
}
export interface SessionProfileQuery extends SessionQuery {
  includeChildren?: boolean;
  summary?: boolean;
  stepOffset?: number;
  stepLimit?: number;
}
export interface SessionRoundMetrics {
  userTurns: number;
  completedTurns: number;
  stepTurns: number;
  timedTurns: number;
  promptInputs: number;
  averageSteps: number | null;
  averageDurationMs: number | null;
  averagePromptCharacters: number | null;
}
export interface SessionProfile {
  version: string;
  scope: "self" | "tree";
  sessionIds: string[];
  missingChildren: number;
  messageCount: number;
  turnCount: number;
  /** 始终统计当前会话自身，不将子会话消耗分摊到用户轮次。 */
  roundMetrics?: SessionRoundMetrics;
  models: { model: string; count: number }[];
  usage: { requests: number; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null;
    cacheWriteTokens: number | null; reasoningOutputTokens: number | null; cacheReadRatio: number | null;
    peakInputTokens: number | null; peakContextTokens: number | null; inputRecordedRequests: number; cacheRecordedRequests: number;
    recordedRequests?: Partial<Record<"inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "reasoningOutputTokens", number>> };
  peakInputRequest?: Pick<SessionUsage, "id" | "messageId" | "turnId"> & { sessionId: string };
  estimate: { method: string; methodDescriptor?: MessageDescriptor; total: number; byKind: { kind: MessageKind; tokens: number }[] };
  tools: { name: string; calls: number; success: number; failure: number; unknown: number; durationMs: number | null }[];
  resources: (NonNullable<SessionMessage["resource"]> & { count: number })[];
  compressions: number;
  children: SessionSummary[];
  outputSpeed?: RequestSpeedSummary;
  steps: SessionProfileStep[];
  stepsTotal?: number;
  stepsOffset?: number;
  gaps: Gap[];
}
