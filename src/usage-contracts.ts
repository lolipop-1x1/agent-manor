import type { SessionSummary, SessionUsage } from "./session-contracts.js";
import type { MessageDescriptor } from "./i18n/types.js";

export type UsageMetric = "tokens" | "cost" | "requests";
export type UsageGroup = "project" | "model" | "client";
export type UsageInterval = "hour" | "day" | "week" | "month";
export interface UsageQuery {
  version?: string; priceVersion?: string; timezone?: string; from?: string; to?: string;
  clients?: string[]; excludeClients?: string[]; projects?: string[]; excludeProjects?: string[];
  models?: string[]; excludeModels?: string[];
  relationship?: "all" | "main" | "child";
  sessionType?: "all" | "interactive" | "automation" | "fork";
  coverage?: "all" | "complete" | "partial" | "missing";
  pricing?: "all" | "complete" | "partial" | "missing";
  minTokens?: number; maxTokens?: number; minCost?: number; maxCost?: number;
  metric?: UsageMetric; groupBy?: UsageGroup; interval?: UsageInterval;
  page?: number; pageSize?: number; sort?: "tokens" | "cost" | "requests" | "recent"; direction?: "asc" | "desc";
}
export interface UsageSource {
  version: string; sessions: SessionSummary[]; requests: { sessionId: string; usage: SessionUsage }[];
}
export interface ModelPriceRates {
  input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; inputAudio?: number; outputAudio?: number;
}
export interface ModelPrice extends ModelPriceRates {
  provider: string; model: string; name?: string; fetchedAt?: string;
  tiers?: (Partial<ModelPriceRates> & { context: number })[];
  source: "network" | "cache" | "bundled" | "manual";
}
export interface PriceSnapshot {
  version: string; fetchedAt?: string; sourceUrl: string; currency: "USD"; prices: ModelPrice[];
}
export interface ModelPriceOverride extends ModelPriceRates { model: string; provider?: string }
export interface ModelPriceMapping { model: string; targetModel: string; targetProvider: string }
export interface PricingConfiguration { overrides: ModelPriceOverride[]; mappings: ModelPriceMapping[] }
export interface PricingStatus {
  version: string; fetchedAt?: string; lastAttemptAt?: string; source: "network" | "cache" | "bundled";
  refreshing: boolean; error?: string; errorDescriptor?: MessageDescriptor; currency: "USD"; sourceUrl: string;
  configuration: PricingConfiguration; prices: ModelPrice[];
}
export interface RequestCost {
  amount: number | null; coverage: "complete" | "partial" | "missing";
  reason?: "model_missing" | "price_missing" | "tokens_missing" | "tier_unknown" | "semantics_unknown";
  price?: ModelPrice; freshInputTokens?: number;
}
export interface UsageTotals {
  requests: number; sessions: number; tokens: number | null; inputTokens: number | null; outputTokens: number | null;
  freshInputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null;
  reasoningTokens: number | null; estimatedCost: number | null; cacheReadRatio: number | null;
  completeTokenRequests: number; partialTokenRequests: number; missingTokenRequests: number;
  pricedRequests: number; partiallyPricedRequests: number; unpricedRequests: number; missingTimeRequests: number;
}
export interface UsageSeries {
  key: string; label: string; totals: UsageTotals;
}
export interface UsageTimeBucket { key: string; totals: UsageTotals; groups: UsageSeries[] }
export interface UsageSessionRow {
  session: SessionSummary; totals: UsageTotals; lastOccurredAt?: string;
  undated?: UsageTotals; requestsTotal: number; requestsLimited: boolean;
  requests: { usage: SessionUsage; cost: RequestCost }[];
}
export interface UsageRequestPage {
  version: string; priceVersion: string; sessionId: string;
  requests: { usage: SessionUsage; cost: RequestCost }[]; total: number; page: number; pageSize: number;
}
export interface UsageReport {
  version: string; priceVersion: string; timezone: string; query: UsageQuery;
  totals: UsageTotals; undated: UsageTotals; buckets: UsageTimeBucket[]; days: UsageTimeBucket[];
  groups: UsageSeries[]; sessions: UsageSessionRow[]; totalSessions: number; page: number; pageSize: number;
  missingUsageSessions: number;
  facets: { clients: string[]; projects: string[]; models: string[] };
  pricing: Omit<PricingStatus, "configuration" | "prices">;
}
