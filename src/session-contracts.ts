import type { Client } from "./clients.js";
import type { Gap } from "./contracts.js";

export type MessageKind = "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "system" | "context" | "compression";
export interface SessionMessage {
  id: string;
  sessionId: string;
  ordinal: number;
  recordLine: number;
  turnId: string;
  kind: MessageKind;
  text: string;
  occurredAt?: string;
  model?: string;
  callId?: string;
  tool?: string;
  status?: "success" | "failure" | "unknown";
  final?: "explicit" | "inferred";
  durationMs?: number;
  /** 仅存在明确原消息身份时标记复制内容。 */
  copied?: boolean;
  /** 会话内树的叶分支成员；共同祖先可属于多个分支。 */
  branchIds?: string[];
  currentBranch?: boolean;
  resource?: { kind: "mcp" | "skill_call" | "skill_read"; name: string; server?: string };
  filePaths?: string[];
  /** 注入上下文或本地 Hook 的来源；正文仍保留原记录。 */
  contextSource?: "agents_md" | "environment" | "client" | "hook";
  contextEvidence?: "client_metadata" | "wrapper";
}
/** 总览只返回定位和显示所需元信息，不加载正文。 */
export type SessionTimelineEvent = Pick<SessionMessage, "id" | "sessionId" | "ordinal" | "turnId" | "kind" | "occurredAt" | "model" | "callId" | "tool" | "status" | "durationMs" | "contextSource"> & { usage?: boolean };
export interface SessionTimelineResult { version: string; events: SessionTimelineEvent[] }
export interface SessionUsage {
  id: string;
  messageId?: string;
  turnId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningOutputTokens?: number;
  contextTokens?: number;
  occurredAt?: string;
}
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
  relationship?: "child" | "fork";
  branches?: { id: string; label: string; current: boolean }[];
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
}
export interface SessionIndexStatus {
  version?: string;
  previousVersion?: string;
  createdAt?: string;
  stale: boolean;
  sessionCount: number;
  sourceCount: number;
  gaps: Gap[];
  projects: string[];
  job?: SessionJob;
}
export interface SessionJob {
  id: string;
  status: "queued" | "running" | "complete" | "failed";
  phase: string;
  progress: number;
  createdAt: string;
  finishedAt?: string;
  error?: string;
  version?: string;
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
}
export interface SessionSearchHit {
  session: SessionSummary;
  messageId?: string;
  turnId?: string;
  kind: MessageKind | "title";
  snippet: string;
}
export interface SessionSearchResult {
  version: string;
  hits: SessionSearchHit[];
  total: number;
  page: number;
  pageSize: number;
}
export interface SessionProfile {
  version: string;
  scope: "self" | "tree";
  sessionIds: string[];
  missingChildren: number;
  messageCount: number;
  turnCount: number;
  models: { model: string; count: number }[];
  usage: { requests: number; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null;
    cacheWriteTokens: number | null; reasoningOutputTokens: number | null; cacheReadRatio: number | null;
    peakInputTokens: number | null; peakContextTokens: number | null; inputRecordedRequests: number; cacheRecordedRequests: number };
  estimate: { method: string; total: number; byKind: { kind: MessageKind; tokens: number }[] };
  tools: { name: string; calls: number; success: number; failure: number; unknown: number; durationMs: number | null }[];
  resources: { kind: "mcp" | "skill_call" | "skill_read"; name: string; server?: string; count: number }[];
  compressions: number;
  children: SessionSummary[];
  steps: (SessionUsage & { sessionId: string })[];
  gaps: Gap[];
}
