import type { SessionProfile } from "../../../src/session-contracts";

type UsageMetric = "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "reasoningOutputTokens" | "peakInputTokens" | "peakContextTokens";

/** 相同请求范围合并呈现，标签保留各指标的统计归属。 */
export function usageCoverage(usage: SessionProfile["usage"], metrics: readonly (readonly [UsageMetric, string])[]) {
  const groups = new Map<number, string[]>();
  for (const [key, label] of metrics) {
    const field = key === "peakInputTokens" ? "inputTokens" : key;
    const count = field === "inputTokens" ? usage.inputRecordedRequests : field === "cachedInputTokens" ? usage.cacheRecordedRequests
      : field === "peakContextTokens" ? undefined : usage.recordedRequests?.[field];
    if (count === undefined || count >= usage.requests) continue;
    groups.set(count, [...(groups.get(count) ?? []), label]);
  }
  return [...groups].map(([count, labels]) => ({ count, total: usage.requests, labels }));
}
