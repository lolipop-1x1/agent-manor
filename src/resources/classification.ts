import type { ResourceUsageStats } from "../resource-contracts.js";

export function resourceUsageThresholdMatches(stats: Pick<ResourceUsageStats, "sessions" | "lastUsedAt"> | null | undefined,
  query: { lowSessions?: number; inactiveDays?: number }, now: number): { low: boolean; old: boolean } {
  const lastUsedAt = stats?.lastUsedAt ? Date.parse(stats.lastUsedAt) : NaN;
  return {
    low: Boolean(stats && stats.sessions > 0 && stats.sessions <= (query.lowSessions ?? 2)),
    old: Number.isFinite(lastUsedAt) && now - lastUsedAt >= (query.inactiveDays ?? 90) * 86400_000,
  };
}
