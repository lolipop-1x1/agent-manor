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
  window?: "response" | "generation";
  basis?: "recorded";
  /** 不同计时区间分别汇总，顶层不生成混合平均。 */
  byWindow?: Partial<Record<"response" | "generation", RequestSpeedSummary>>;
}

export const speedOutputTokens = (usage: SessionUsage): number | undefined => usage.timing?.outputTokens ?? usage.outputTokens;

/** 不对缺失值补零；所有视图使用同一门槛与未舍入的原始量。 */
export function requestSpeed(usage: SessionUsage): RequestSpeed {
  const timing = usage.timing;
  const output = speedOutputTokens(usage);
  if (timing?.completion === "partial") return { reason: "partial_response" };
  if (!timing || timing.completion === "unknown") return { reason: timing ? "end_unconfirmed" : "timing_missing" };
  if (!Number.isSafeInteger(output) || output! < 0) return { reason: "output_missing" };
  if (output! < 200) return { reason: "output_below_threshold" };
  if ([timing.start?.occurredAt, timing.end?.occurredAt].some(value => value !== undefined && !Number.isFinite(Date.parse(value)))) {
    return { reason: "invalid_timing" };
  }
  if (timing.durationMs === undefined) return { reason: "timing_missing" };
  if (!Number.isFinite(timing.durationMs) || timing.durationMs <= 0) return { reason: "invalid_timing" };
  if (timing.start?.occurredAt && timing.end?.occurredAt
    && Math.abs(Date.parse(timing.end.occurredAt) - Date.parse(timing.start.occurredAt) - timing.durationMs) > 1) return { reason: "invalid_timing" };
  if (timing.durationMs < 1000) return { reason: "duration_below_threshold" };
  return { tokensPerSecond: output! * 1000 / timing.durationMs };
}

/** 汇总同一合格请求集合；请求可能关联多个消息，但只计算一次。 */
export function summarizeRequestSpeed(usages: readonly (SessionUsage & { sessionId?: string })[]): RequestSpeedSummary {
  const requests = new Map(usages.map(usage => [JSON.stringify([usage.sessionId ?? null, usage.id]), usage]));
  const windows = new Set([...requests.values()].map(usage => usage.timing?.window ?? "response"));
  if (windows.size > 1) {
    const byWindow = Object.fromEntries([...windows].map(window => [window,
      summarizeRequestSpeed([...requests.values()].filter(usage => (usage.timing?.window ?? "response") === window))]));
    return { requests: requests.size, eligibleRequests: Object.values(byWindow).reduce((sum, value) => sum + value.eligibleRequests, 0),
      outputTokens: null, durationMs: null, tokensPerSecond: null, byWindow };
  }
  let eligibleRequests = 0;
  let outputTokens = 0;
  let durationMs = 0;
  let recorded = true;
  for (const usage of requests.values()) {
    if (requestSpeed(usage).tokensPerSecond === undefined) continue;
    eligibleRequests += 1;
    outputTokens += speedOutputTokens(usage)!;
    durationMs += usage.timing!.durationMs!;
    recorded &&= usage.timing!.basis === "recorded";
  }
  return { requests: requests.size, eligibleRequests, outputTokens: eligibleRequests ? outputTokens : null,
    durationMs: eligibleRequests ? durationMs : null, tokensPerSecond: eligibleRequests ? outputTokens * 1000 / durationMs : null,
    ...(windows.has("generation") ? { window: "generation" as const } : {}),
    ...(eligibleRequests && recorded ? { basis: "recorded" as const } : {}) };
}
