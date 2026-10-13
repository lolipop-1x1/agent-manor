import type { SessionUsage } from "../session-contracts.js";
import { requestSpeed, speedOutputTokens } from "../session-speed.js";
import type { UsageSpeedGroup, UsageSpeedReport, UsageSpeedSummary } from "../usage-contracts.js";

/** 小时汇总保存可相加的原值，不保存舍入后的速度。 */
export type UsageSpeedProfile = Omit<UsageSpeedGroup, "tokensPerSecond">;
interface SpeedSlice { bucket: string; requests: number; eligibleRequests: number; profiles: UsageSpeedProfile[] }

type SpeedTotals = Omit<UsageSpeedSummary, "tokensPerSecond">;
const empty = (): SpeedTotals => ({ requests: 0, eligibleRequests: 0, outputTokens: null, durationMs: null });
const summary = (value: SpeedTotals): UsageSpeedSummary => ({ ...value,
  tokensPerSecond: value.eligibleRequests ? value.outputTokens! * 1000 / value.durationMs! : null });

function merge(target: SpeedTotals, value: SpeedTotals): void {
  target.requests += value.requests;
  target.eligibleRequests += value.eligibleRequests;
  if (value.eligibleRequests) {
    target.outputTokens = (target.outputTokens ?? 0) + value.outputTokens!;
    target.durationMs = (target.durationMs ?? 0) + value.durationMs!;
  }
}

/** 模型缺失或分组依据缺失时只保留总体覆盖，不能归入其他模型曲线。 */
export function speedProfile(client: string, usage: SessionUsage): Pick<SpeedSlice, "eligibleRequests" | "profiles"> {
  const eligibleRequests = requestSpeed(usage).tokensPerSecond === undefined ? 0 : 1;
  const timing = usage.timing, model = usage.model;
  if (!model?.trim() || !timing?.method || !["estimated", "recorded"].includes(timing.basis)
    || timing.window !== undefined && timing.window !== "response" && timing.window !== "generation") return { eligibleRequests, profiles: [] };
  const window = timing.window ?? "response", { basis, method } = timing;
  return { eligibleRequests, profiles: [{ key: JSON.stringify([client, model, window, basis, method]), client, model, window, basis, method,
    requests: 1, eligibleRequests, outputTokens: eligibleRequests ? speedOutputTokens(usage)! : null,
    durationMs: eligibleRequests ? timing.durationMs! : null }] };
}

export function mergeSpeedProfiles(target: UsageSpeedProfile[], profiles: UsageSpeedProfile[]): void {
  for (const profile of profiles) {
    const current = target.find(value => value.key === profile.key);
    if (current) merge(current, profile);
    else target.push({ ...profile });
  }
}

/** 普通报告不调用此聚合；日期桶沿用同一报告已补齐的边界，空桶保留未知。 */
export function buildUsageSpeedReport(slices: SpeedSlice[], bucketKeys: string[], missingTimeRequests: number,
  requestedGroup?: string): UsageSpeedReport {
  const profiles = new Map<string, UsageSpeedProfile>();
  let requests = 0, eligibleRequests = 0;
  for (const slice of slices) {
    requests += slice.requests; eligibleRequests += slice.eligibleRequests;
    for (const profile of slice.profiles) {
      const current = profiles.get(profile.key);
      if (current) merge(current, profile);
      else profiles.set(profile.key, { ...profile });
    }
  }
  const groups = [...profiles.values()].map(profile => ({ ...profile, ...summary(profile) }))
    .sort((left, right) => right.eligibleRequests - left.eligibleRequests || left.key.localeCompare(right.key));
  const selectedGroup = requestedGroup && profiles.has(requestedGroup) ? requestedGroup : groups[0]?.key ?? null;
  const buckets = new Map(bucketKeys.map(key => [key, empty()]));
  for (const slice of slices) {
    const profile = slice.profiles.find(value => value.key === selectedGroup);
    if (profile) merge(buckets.get(slice.bucket)!, profile);
  }
  return { groups, selectedGroup, requests, eligibleRequests, missingTimeRequests,
    buckets: [...buckets].map(([key, value]) => ({ key, ...summary(value) })) };
}
