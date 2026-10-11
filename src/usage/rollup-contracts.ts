import type { SessionSummary, SessionUsage } from "../session-contracts.js";
import type { RequestCost, UsageTotals } from "../usage-contracts.js";

export type CompactUsage = Pick<SessionUsage, "id" | "model" | "provider" | "occurredAt" | "inputTokens" | "outputTokens"
  | "cachedInputTokens" | "cacheWriteTokens" | "reasoningOutputTokens" | "contextTokens" | "messageId" | "turnId">;
export interface UsageRollupPreview { usage: CompactUsage; cost: Omit<RequestCost, "price">; time?: number }
export interface UsageRollupCell {
  sessionId: string; model?: string; day?: string; hour?: string;
  coverage: "complete" | "partial" | "missing"; costCoverage: "complete" | "partial" | "missing";
  totals: UsageTotals; pairedInput: number; pairedCache: number; latestTime?: number; previews: UsageRollupPreview[];
}
/** 可独立按修订持久化；会话标题、项目与父子关系在查询时使用当前发布版本。 */
export interface UsageRollup {
  version: string; timezone: string; sessions: SessionSummary[]; cells: UsageRollupCell[];
  sessionIdsWithUsage: string[]; models: string[];
}
