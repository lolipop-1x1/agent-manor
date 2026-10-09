import type { SessionUsage } from "./session-contracts.js";

export type RequestSpeedReason = "output_missing" | "output_below_threshold" | "timing_missing" | "invalid_timing"
  | "duration_below_threshold" | "partial_response" | "end_unconfirmed";
export type RequestSpeed = { tokensPerSecond: number; reason?: never } | { tokensPerSecond?: never; reason: RequestSpeedReason };
export interface RequestSpeedSummary {
  requests: number;
  eligibleRequests: number;
  outputTokens: number | null;
  durationMs: number | null;
  tokensPerSecond: number | null;
}

/** 不对缺失值补零；所有视图使用同一门槛与未舍入的原始量。 */
export function requestSpeed(usage: SessionUsage): RequestSpeed {
  const timing = usage.timing;
  if (timing?.completion === "partial") return { reason: "partial_response" };
  if (!timing || timing.completion === "unknown") return { reason: timing ? "end_unconfirmed" : "timing_missing" };
  if (!Number.isSafeInteger(usage.outputTokens) || usage.outputTokens! < 0) return { reason: "output_missing" };
  if (usage.outputTokens! < 200) return { reason: "output_below_threshold" };
  if (timing.durationMs === undefined) return { reason: "timing_missing" };
  if (!Number.isFinite(timing.durationMs) || timing.durationMs <= 0) return { reason: "invalid_timing" };
  if (timing.durationMs < 1000) return { reason: "duration_below_threshold" };
  return { tokensPerSecond: usage.outputTokens! * 1000 / timing.durationMs };
}

/** 汇总同一合格请求集合；请求可能关联多个消息，但只计算一次。 */
export function summarizeRequestSpeed(usages: readonly SessionUsage[]): RequestSpeedSummary {
  const requests = new Map(usages.map(usage => [usage.id, usage]));
  let eligibleRequests = 0;
  let outputTokens = 0;
  let durationMs = 0;
  for (const usage of requests.values()) {
    if (requestSpeed(usage).tokensPerSecond === undefined) continue;
    eligibleRequests += 1;
    outputTokens += usage.outputTokens!;
    durationMs += usage.timing!.durationMs!;
  }
  return { requests: requests.size, eligibleRequests, outputTokens: eligibleRequests ? outputTokens : null,
    durationMs: eligibleRequests ? durationMs : null, tokensPerSecond: eligibleRequests ? outputTokens * 1000 / durationMs : null };
}
