import type { OverviewEvent, OverviewSource } from "../src/overview-contracts.js";
import type { ResourceUsageEvent } from "../src/resource-contracts.js";
import type { SessionSummary, SessionUsage } from "../src/session-contracts.js";
import type { PricingView } from "../src/usage/pricing.js";

export function session(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, client: "codex", clientSessionId: id, title: `合成会话 ${id}`, titleOrigin: "recorded",
    messageCount: 1, turnCount: 1, models: [], gaps: [], ...extra };
}
export function event(sessionId: string, id: string, day = "2026-01-01", extra: Partial<OverviewEvent> = {}): OverviewEvent {
  return { id, sessionId, ordinal: 1, turnId: "turn-1", kind: "user", occurredAt: `${day}T12:00:00Z`, ...extra };
}
export function request(sessionId: string, id: string, day = "2026-01-01", extra: Partial<SessionUsage> = {}) {
  return { sessionId, ordinal: 1, usage: { id, model: "model-a", occurredAt: `${day}T12:00:00Z`, inputTokens: 100, outputTokens: 50, ...extra } };
}
export function resource(sessionId: string, id: string, name = "skill-a", day = "2026-01-01", extra: Partial<ResourceUsageEvent> = {}): ResourceUsageEvent {
  return { id, sessionId, messageId: id, ordinal: 2, turnId: "turn-1", client: "codex", kind: "skill_call", name,
    occurredAt: `${day}T12:00:00Z`, status: "success", pairing: "unique",
    source: { path: "/workspace/history/synthetic.jsonl", sourceId: `source-${sessionId}`, revision: "revision-a", fingerprint: "synthetic", recordLine: 1 }, ...extra };
}
export function source(extra: Partial<OverviewSource> = {}): OverviewSource {
  return { version: "version-a", sessions: [], events: [], requests: [], resources: [], gaps: [], ...extra };
}
export const pricing: PricingView = {
  status: { version: "price-a", currency: "USD", source: "bundled", sourceUrl: "https://example.invalid/prices",
    refreshing: false, configuration: { overrides: [], mappings: [] }, prices: [] },
  estimate: usage => usage.inputTokens === undefined && usage.outputTokens === undefined ? { amount: null, coverage: "missing" }
    : { amount: ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)) / 1000000,
      coverage: usage.inputTokens === undefined || usage.outputTokens === undefined ? "partial" : "complete",
      ...(usage.inputTokens !== undefined && usage.cachedInputTokens !== undefined && usage.cacheWriteTokens === undefined
        ? { freshInputTokens: usage.inputTokens - usage.cachedInputTokens } : {}) },
};
export const now = new Date("2026-02-15T12:00:00Z");
