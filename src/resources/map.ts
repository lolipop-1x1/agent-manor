import type { ResourceUsageResult } from "../resource-contracts.js";
import type { ResourceMapNode, ResourceMapQuery, ResourceMapResult, ResourceOverviewResult } from "../resource-service-contracts.js";
import { ServiceError } from "../service/input.js";

/** 面积指标仅选择既有统计；未记录和观测不足不补成零。 */
export function buildResourceMap(overview: ResourceOverviewResult, history: ResourceUsageResult | null,
  query: ResourceMapQuery): ResourceMapResult {
  const kind = query.kind ?? "skill", metric = query.metric ?? "calls";
  if (overview.resources.length !== overview.total) throw new ServiceError("INVALID_INPUT", "地图查询需要完整资源结果", { key: "diagnostics.resources.map.completeRequired" });
  if (!["calls", "sessions", "reads", "uses"].includes(metric) || kind === "mcp" && metric === "reads") {
    throw new ServiceError("INVALID_INPUT", "所选资源不支持该面积指标", { key: "diagnostics.service.resourceInput.m003" });
  }
  if (query.maxValue !== undefined && (!Number.isSafeInteger(query.maxValue) || query.maxValue < 0)) {
    throw new ServiceError("INVALID_INPUT", "maxValue 必须是非负安全整数", { key: "diagnostics.service.resourceInput.m004" });
  }
  const positive: ResourceMapNode[] = [], zero: ResourceMapNode[] = [], review: ResourceMapNode[] = [];
  const recorded = new Map(history?.resources.map(row => [row.identity.id, row.stats]) ?? []);
  let totalValue = 0;
  for (const row of overview.resources) {
    const metrics = row.stats ? { calls: kind === "mcp" ? row.stats.mcpCalls : row.stats.explicitCalls,
      reads: row.stats.successfulReads, sessions: row.stats.sessions } : null;
    const value = metric === "uses" ? row.stats?.events ?? null : metrics?.[metric] ?? null;
    if (value !== null && query.maxValue !== undefined && value > query.maxValue) continue;
    const timestamp = row.stats?.lastUsedAt;
    const node: ResourceMapNode = { id: row.identity.id, name: row.identity.name, ...(row.identity.nameDescriptor ? { nameDescriptor: row.identity.nameDescriptor } : {}), value, share: null, metrics,
      lastUsedAt: timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : null,
      missingTimeEvents: row.missingTimeEvents ?? recorded.get(row.identity.id)?.missingTimeEvents ?? 0,
      clients: row.clients, favorite: row.favorite,
      protected: row.protected, observation: row.observation, localBodyIds: row.localBodyIds, hasHistory: row.hasHistory,
      partial: row.partial, usageUnassociated: row.usageUnassociated };
    if (value === null) zero.push(node);
    else if (value === 0) { node.share = 0; zero.push(node); }
    else { positive.push(node); totalValue += value; }
  }
  for (const node of positive) node.share = node.value! / totalValue;
  // 地图不受列表排序或页码影响，身份决定稳定的查询顺序。
  for (const nodes of [positive, zero, review]) nodes.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { kind, metric, maxValue: query.maxValue, version: history?.version ?? null, observedAt: overview.observedAt,
    complete: true, partial: overview.partial || Boolean(history?.coverage.partial), positive, zero, review, total: positive.length + zero.length + review.length,
    totalValue, counts: overview.counts, coverage: overview.coverage, thresholds: overview.thresholds };
}
