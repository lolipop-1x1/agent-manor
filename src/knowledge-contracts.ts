import type { MessageDescriptor } from "./i18n/types.js";
import type { SemanticConnection, SemanticScope } from "./semantic-contracts.js";
import type { SessionMessage, SessionSummary } from "./session-contracts.js";

export const knowledgeTypes = ["fact", "preference", "constraint", "decision", "procedure", "lesson", "event", "open_question"] as const;
export type KnowledgeType = typeof knowledgeTypes[number];
export type KnowledgeLanguage = "zh-CN" | "en";
export type KnowledgeReview = "pending" | "reviewed" | "rejected";
export type KnowledgeAvailability = "active" | "deprecated" | "expired" | "superseded" | "resolved";
export interface KnowledgeScope { kind: "project" | "global"; project?: string }
export interface KnowledgeLimitation { message: string; messageDescriptor?: MessageDescriptor }
export interface KnowledgeSource {
  kind: "manual" | "agent" | "extraction";
  taskId?: string;
  client?: string;
  sessionId?: string;
  sessionTitle?: string;
  sourceVersion?: string;
  currentVersion?: string;
  branch?: string;
  messageId?: string;
  turnId?: string;
  turnPosition?: number;
  ordinal?: number;
  callId?: string;
  hash?: string;
  excerpt?: string;
  limitation?: string;
  limitationDetails?: KnowledgeLimitation[];
  status?: "available" | "changed" | "missing";
}
export interface KnowledgeDraft {
  title: string;
  body: string;
  summary?: string;
  type?: KnowledgeType;
  tags?: string[];
  scope: KnowledgeScope;
  subject?: "personal" | "project" | "general";
  language?: KnowledgeLanguage;
  applicability?: string;
  validUntil?: string;
  occurredAt?: string;
  resolved?: boolean;
  sources?: KnowledgeSource[];
  author?: string;
  changeReason?: string;
}
export interface KnowledgeRevision extends KnowledgeDraft {
  id: string;
  knowledgeId: string;
  version: number;
  baseRevisionId?: string;
  review: KnowledgeReview;
  createdAt: string;
}
export interface KnowledgeEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
  availability: KnowledgeAvailability;
  availabilityReason?: string;
  publishedRevisionId?: string;
  latestRevisionId: string;
  revision: KnowledgeRevision;
  pendingRevision?: KnowledgeRevision;
  score?: number;
  snippet?: string;
  snippetField?: "title" | "summary" | "body" | "applicability" | "tags" | "source";
}
export interface KnowledgeAudit { id: string; knowledgeId: string; revisionId?: string; action: string; reason?: string; createdAt: string }
export interface KnowledgeDetail extends KnowledgeEntry { revisions: KnowledgeRevision[]; audit: KnowledgeAudit[] }
export interface KnowledgeQuery {
  q?: string;
  view?: "all" | "personal" | "project" | "general";
  project?: string;
  client?: string;
  type?: KnowledgeType;
  tag?: string;
  review?: KnowledgeReview | "all";
  availability?: KnowledgeAvailability | "all";
  from?: string;
  to?: string;
  taskId?: string;
  page?: number;
  pageSize?: number;
}
export interface KnowledgeList { items: KnowledgeEntry[]; total: number; page: number; pageSize: number }
export interface KnowledgeFacets { projects: string[]; clients: string[]; tags: string[] }
export interface KnowledgeRevisionInput extends KnowledgeDraft { baseRevisionId: string }
export interface KnowledgeReviewInput { revisionId: string; action: "approve" | "reject"; baseRevisionId?: string; reason?: string }
export interface KnowledgeGeneration {
  url: string; model: string; contextTokens: number; outputTokens: number;
  reasoningEffort?: "none" | "low" | "medium" | "high";
  timeoutMs: number; retries: number; requestsPerMinute: number;
  inputPricePerMillion?: number; cachedInputPricePerMillion?: number; outputPricePerMillion?: number; dailyBudget?: number;
  taskInputTokenBudget?: number; taskBudget?: number;
}
export interface KnowledgeExtractionScope extends Omit<SemanticScope, "branch"> {
  sessionIds?: string[];
  turnStart?: number;
  turnEnd?: number;
  branch?: string;
  force?: boolean;
}
export interface KnowledgeConfig {
  generation: KnowledgeGeneration;
  outputLanguage: KnowledgeLanguage;
  extractionPrompt: string;
  mergePrompt: string;
  automatic: { enabled: boolean; intervalMinutes: number; quietMinutes: number; scope: KnowledgeExtractionScope };
  embedding: { mode: "off" | "reuse" | "independent"; connection: SemanticConnection; timeoutMs: number; retries: number; requestsPerMinute: number; pricePerMillion?: number; dailyBudget?: number };
}
export interface KnowledgeSettings { config: KnowledgeConfig; hasGenerationKey: boolean; hasEmbeddingKey: boolean; fingerprint: string }
export interface KnowledgeSettingsInput { config: KnowledgeConfig; generationKey?: string | null; embeddingKey?: string | null }
export interface KnowledgeInputMessage extends SessionMessage { turnPosition: number; hash: string; target: boolean; omittedMedia?: number }
export interface KnowledgeConversation { session: SessionSummary; version: string; branch: string; messages: KnowledgeInputMessage[]; limitations: string[]; limitationDetails?: KnowledgeLimitation[] }
export interface KnowledgeTarget { sessionId: string; title: string; client: string; project?: string; updatedAt?: string; version: string; branch: string; messageIds: string[]; hashes: string[]; turnCount: number; inputTokens: number; contextTokens: number; plannedChunks?: number; limitations: string[]; limitationDetails?: KnowledgeLimitation[] }
export interface KnowledgeSourceReader {
  plan(scope: KnowledgeExtractionScope): Promise<KnowledgeTarget[]>;
  read(target: KnowledgeTarget): Promise<KnowledgeConversation>;
  verify(source: KnowledgeSource): Promise<KnowledgeSource>;
}
export interface KnowledgePreview {
  id: string; createdAt: string; fingerprint: string; scope: KnowledgeExtractionScope;
  targets: KnowledgeTarget[]; sessionCount: number; turnCount: number;
  estimatedTokens: number; contextTokens: number; skippedMessages: number; pendingMessages: number;
  estimatedCost: number | null; estimatedExtractionCost?: number | null; limitations: string[];
  plannedChunks?: number; estimatedOutputTokens?: number; sourceBytes?: number; textBytes?: number; omittedMedia?: number;
  limitationDetails?: KnowledgeLimitation[];
}
export type KnowledgeJobStatus = "queued" | "running" | "paused" | "complete" | "partial" | "failed" | "budget_stopped";
export interface KnowledgeJob {
  id: string; previewId: string; status: KnowledgeJobStatus;
  title?: string; model?: KnowledgeGeneration; usage?: KnowledgeUsage; events?: KnowledgeTaskEvent[]; droppedEvents?: number;
  phase: "planning" | "extracting" | "merging" | "saving" | "complete";
  createdAt: string; updatedAt: string; finishedAt?: string;
  totalSessions: number; completedSessions: number; totalChunks: number; completedChunks: number;
  createdEntries: number; updatedEntries: number; duplicates: number; noValue: number; needsContext: number;
  failedSessions: { sessionId: string; title: string; error: string; errorDescriptor?: MessageDescriptor }[];
  results: { knowledgeId: string; revisionId: string }[];
  error?: string; errorDescriptor?: MessageDescriptor;
  outputLanguage: KnowledgeLanguage; fingerprint: string;
}
export type KnowledgeUsagePurpose = "extract" | "merge" | "reread" | "try" | "test";
export interface KnowledgeUsageCounters {
  requests: number; inputTokens: number; outputTokens: number; estimatedCost: number | null;
  estimatedInputTokens: number; estimatedOutputTokens: number; actualInputTokens: number; actualOutputTokens: number; actualRequests: number;
  cachedInputTokens?: number; uncachedInputTokens?: number; cacheDetailedRequests?: number;
}
export interface KnowledgeUsage {
  requests: number; inputTokens: number; outputTokens: number; estimatedCost: number | null; date: string;
  estimatedInputTokens?: number; estimatedOutputTokens?: number; actualInputTokens?: number; actualOutputTokens?: number; actualRequests?: number;
  cachedInputTokens?: number; uncachedInputTokens?: number; cacheDetailedRequests?: number;
  byPurpose?: Record<KnowledgeUsagePurpose, KnowledgeUsageCounters>;
}
export interface KnowledgeRequestMeasurement {
  inputTokens: number; outputTokens: number; inputTokenUpperBound?: number; actualInputTokens?: number; actualOutputTokens?: number;
  cachedInputTokens?: number; uncachedInputTokens?: number; estimatedCost: number | null;
}
export type KnowledgeRequestEvent = {
  requestId: string; at: string; purpose: KnowledgeUsagePurpose; attempt: number;
} & (
  { kind: "before" | "reserved"; measurement: KnowledgeRequestMeasurement }
  | { kind: "settled"; measurement: KnowledgeRequestMeasurement; reservation: KnowledgeRequestMeasurement }
  | { kind: "failed"; error: string; errorDescriptor?: MessageDescriptor }
);
export type KnowledgeRequestObserver = (event: KnowledgeRequestEvent) => void | Promise<void>;
export interface KnowledgeTaskEvent {
  id: string; at: string; kind: "queued" | "started" | "phase" | "progress" | "request" | "error" | "paused" | "resumed" | "retried" | "completed";
  phase?: KnowledgeJob["phase"]; sessionId?: string; completedChunks?: number; totalChunks?: number;
  requestId?: string; purpose?: KnowledgeUsagePurpose; attempt?: number; requestState?: "reserved" | "settled" | "failed";
  measurement?: KnowledgeRequestMeasurement; error?: string; errorDescriptor?: MessageDescriptor;
}
export interface KnowledgeTaskStatus { jobs: KnowledgeJob[]; usage: KnowledgeUsage; automatic: { enabled: boolean; lastCheckAt?: string; nextCheckAt?: string; error?: string; errorDescriptor?: MessageDescriptor } }
export type KnowledgeJobSummary = Omit<KnowledgeJob, "events" | "results" | "failedSessions" | "model"> & {
  eventCount: number; resultCount: number; failedSessionCount: number;
};
export interface KnowledgeTaskSummaryPage extends Omit<KnowledgeTaskStatus, "jobs"> {
  jobs: KnowledgeJobSummary[]; total: number; page: number; pageSize: number; hasMore: boolean;
}
export interface KnowledgeTryResult { candidates: KnowledgeDraft[]; disposition: "knowledge" | "no_value" | "needs_context"; limitations: string[]; limitationDetails?: KnowledgeLimitation[]; usage: KnowledgeUsage }
export interface KnowledgeIndexStatus { status: "off" | "needs_build" | "running" | "paused" | "ready" | "failed"; total: number; completed: number; fingerprint?: string; error?: string; errorDescriptor?: MessageDescriptor }
export interface KnowledgeIndexPreview { id: string; total: number; reviewed: number; pending: number; estimatedTokens: number; estimatedCost: number | null; fingerprint: string }
