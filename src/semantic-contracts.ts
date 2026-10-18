import type { MessageDescriptor } from "./i18n/types.js";
import type { SessionGroupedSearchResult, SessionSearchScope } from "./session-contracts.js";

export interface SemanticConnection {
  url: string;
  model: string;
  dimensions?: number;
  documentPrefix: string;
  queryPrefix: string;
}
export interface SemanticScope extends SessionSearchScope {
  timeRange: "unset" | "all" | "recent";
  recentDays: number;
}
export interface SemanticStrategy {
  concurrency: number;
  batchSize: number;
  batchTokens: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
  timeoutMs: number;
  retries: number;
  chunkChars: number;
  overlapChars: number;
  quietMinutes: number;
  maxDelayMinutes: number;
  pricePerMillion?: number;
  dailyBudget?: number;
  cleanOutsideWindow: boolean;
}
export interface SemanticConfig { enabled: boolean; connection: SemanticConnection; scope: SemanticScope; strategy: SemanticStrategy }
export interface SemanticSettings { config: SemanticConfig; hasKey: boolean; fingerprint: string }
export interface SemanticSettingsInput { config: SemanticConfig; apiKey?: string | null }
export interface SemanticUsage {
  requests: number;
  estimatedTokens: number;
  actualTokens: number;
  actualRequests: number;
  estimatedCost: number | null;
  byPurpose: Record<"build" | "query" | "test", { requests: number; tokens: number; cost: number | null }>;
}
export interface SemanticPreview {
  id: string;
  sourceVersion: string;
  fingerprint: string;
  sessionCount: number;
  positionCount: number;
  uniqueInputs: number;
  reusedInputs: number;
  pendingInputs: number;
  estimatedTokens: number;
  estimatedCost: number | null;
  vectorBytes: number | null;
  createdAt: string;
}
export interface SemanticJob {
  id: string;
  previewId: string;
  status: "running" | "paused" | "complete" | "failed" | "budget_stopped";
  phase: "scanning" | "encoding" | "publishing" | "complete";
  totalInputs: number;
  completedInputs: number;
  reusedInputs: number;
  failedInputs: number;
  createdAt: string;
  finishedAt?: string;
  error?: string;
  errorCode?: string;
  errorDescriptor?: MessageDescriptor;
}
export interface SemanticStatus {
  enabled: boolean;
  ready: boolean;
  fingerprint: string;
  sourceVersion?: string;
  indexedSessions: number;
  indexedPositions: number;
  uniqueVectors: number;
  databaseBytes: number;
  job?: SemanticJob;
  usage: SemanticUsage;
}
export interface SemanticSearchQuery { q: string; scope: SemanticScope; sort?: "relevance" | "updated"; page?: number; pageSize?: number; sessionId?: string; cacheOnly?: boolean; response?: "summary" }
export interface SemanticSearchResult extends SessionGroupedSearchResult { mode: "semantic"; limited: boolean; coveredSessions: number }
export interface SemanticInput { key: string; text: string; estimatedTokens: number }
export interface SemanticVector { key: string; values: number[] }
export interface SemanticEngineStats { ready: boolean; sourceVersion?: string; indexedSessions: number; indexedPositions: number; uniqueVectors: number; databaseBytes: number }
export interface EmbeddingResult { vectors: number[][]; dimensions: number; tokens?: number }
export type SemanticPurpose = "build" | "query" | "test";
