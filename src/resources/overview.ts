import type { Client } from "../clients.js";
import type { ResourceUsageIdentity, ResourceUsageResult, ResourceUsageRow, ResourceUsageStats } from "../resource-contracts.js";
import type { ResourceLocalRow, ResourceOverviewCandidate, ResourceOverviewQuery, ResourceOverviewResult, ResourceOverviewRow } from "../resource-service-contracts.js";
import { emptyResourceUsageStats, resourceOverviewIdentity } from "./usage.js";
import { resourceGapRelevant } from "./coverage.js";
import { skillDescription } from "./descriptions.js";
import { resourceUsageThresholdMatches } from "./classification.js";
import type { ResourceInventoryEntry, ResourceInventorySnapshot } from "../resource-inventory-contracts.js";

interface OverviewBucket {
  identity: ResourceUsageIdentity;
  history?: ResourceUsageRow;
  local: ResourceLocalRow[];
}

const candidates: ResourceOverviewCandidate[] = ["all", "used", "unused", "low", "old", "review", "favorite"];

function locationScopes(entry: ResourceInventoryEntry, query: ResourceOverviewQuery) {
  return [{ scope: entry.scope, project: entry.project }].filter(scope =>
    (!query.scope || scope.scope === query.scope) && (!query.locationProject || scope.project === query.locationProject));
}

export function resourceLocations(rows: readonly ResourceLocalRow[], query: ResourceOverviewQuery): ResourceLocalRow[] {
  return rows.flatMap(row => {
    const entries = row.entries.filter(entry => locationScopes(entry, query).length);
    return entries.length ? [{ ...row, entries }] : [];
  });
}

function unavailableLocalClients(inventory: ResourceInventorySnapshot | undefined, query: ResourceOverviewQuery): ReadonlySet<Client> {
  const sources = new Map(inventory?.sources.filter(source => source.kind === (query.kind ?? "skill")
    && (!query.scope || source.scope === query.scope) && (!query.locationProject || source.project === query.locationProject)).map(source => [source.id, source]));
  return new Set([...sources.values()].filter(source => ["invalid", "unreadable", "unsupported"].includes(source.readState)).map(source => source.client)
    .concat(inventory?.gaps.flatMap(gap => sources.has(gap.sourceId) && !["missing", "project_missing"].includes(gap.reason) ? [gap.client] : []) ?? []));
}

export function resourceLocalSummary(rows: readonly ResourceLocalRow[], query: ResourceOverviewQuery,
  inventory?: ResourceInventorySnapshot, clients: readonly Client[] = [], unavailable = unavailableLocalClients(inventory, query)): NonNullable<ResourceOverviewRow["localSummary"]> {
  const entries = rows.flatMap(row => row.entries);
  const present = entries.filter(entry => entry.readState === "present");
  const uncertain = entries.some(entry => entry.readState === "unreadable") || !inventory
    || (clients.length ? clients.some(client => unavailable.has(client)) : unavailable.size > 0);
  return { presence: present.length ? "present" : uncertain ? "unknown" : "missing",
    locations: new Set(entries.map(entry => JSON.stringify([entry.entryPath, entry.locator.keyPath ?? []]))).size,
    scopes: [...new Set(entries.flatMap(entry => locationScopes(entry, query).map(scope => scope.scope)))].sort() };
}

function localIdentity(row: ResourceLocalRow): ResourceUsageIdentity {
  const entry = row.entries[0]!;
  return resourceOverviewIdentity({ id: row.body.id, kind: row.body.kind, name: row.body.name,
    path: row.body.targetPath, client: entry.client, project: entry.project });
}

export function resourceOverviewIncomplete(history: ResourceUsageResult | null, clients: readonly Client[], stats: ResourceUsageStats | null): boolean {
  if (!history) return true;
  const coverage = history.coverage;
  if (stats?.missingTimeEvents) return true;
  if (coverage.unscopedGaps || coverage.uncertainClients?.some(client => clients.includes(client))) return true;
  // 旧版本缺少归属字段时，仅对资源采集相关的原始诊断保守标记部分记录。
  return (coverage.uncertainClients === undefined || coverage.unscopedGaps === undefined)
    && coverage.gaps.some(resourceGapRelevant);
}

function rowOf(bucket: OverviewBucket, history: ResourceUsageResult | null, query: ResourceOverviewQuery,
  favorites: ReadonlySet<string>, now: number, linked: readonly ResourceLocalRow[]): ResourceOverviewRow {
  const { identity, local } = bucket;
  const clients = [...new Set([...(bucket.history?.clients ?? []), ...local.flatMap(row => row.entries.map(entry => entry.client))])].sort();
  const favorite = Boolean(bucket.history?.favorite) || favorites.has(identity.id)
    || local.some(row => row.historyIds.some(id => favorites.has(id)));
  const favoriteIds = [...new Set([identity.id, ...(bucket.history?.favoriteIds ?? []), ...local.flatMap(row => row.historyIds)])];
  const localFavoriteIds = [...new Set(local.flatMap(row => row.favoriteIds ?? [row.body.id, ...row.entries.map(entry => entry.id)]))];
  const localFavorite = local.some(row => row.favorite || favorites.has(row.body.id)
    || row.entries.some(entry => favorites.has(entry.id)));
  const protectedByConfiguration = local.some(row => row.protectedByConfiguration ?? (row.protected && !row.favorite || row.entries.some(entry => entry.protected)));
  const protectedResource = favorite || localFavorite || protectedByConfiguration;
  let stats = bucket.history?.stats ?? null;
  const incomplete = resourceOverviewIncomplete(history, clients, stats);
  const missingTimeEvents = stats?.missingTimeEvents ?? 0;
  const usageUnassociated = local.some(row => row.usageUnassociated)
    || Boolean(local.length && bucket.history && bucket.history.association.state !== "linked");
  const unavailable = history?.coverage.unscopedUnavailableGaps
    || history?.coverage.unavailableClients?.some(client => clients.includes(client));
  let observation: ResourceOverviewRow["observation"];
  if (stats && stats.events > 0) observation = "used";
  else if (!history || unavailable || !local.length || missingTimeEvents || local.some(row => row.observation === "unknown")) observation = "unknown";
  else observation = "unused";
  if (observation === "unknown") stats = null;
  else if (!bucket.history && observation === "unused") stats = emptyResourceUsageStats();
  const rowCandidates: ResourceOverviewRow["candidates"] = [];
  if (observation === "used") rowCandidates.push("used");
  if (favorite || localFavorite) rowCandidates.push("favorite");
  if (observation === "unused") rowCandidates.push("unused");
  const thresholdMatches = resourceUsageThresholdMatches(stats, query, now);
  if (observation === "used" && thresholdMatches.low) rowCandidates.push("low");
  if (observation === "used" && thresholdMatches.old) rowCandidates.push("old");
  // 已有路径关联只补本地展示元数据，不改变历史身份或累加投入。
  const metadataLocal = [...new Map([...local, ...linked].map(row => [row.body.id, row])).values()];
  const description = skillDescription(metadataLocal.flatMap(row => row.entries));
  return { identity, ...(description ? { description } : {}), stats, clients, favorite, favoriteIds, localFavoriteIds, protectedByConfiguration, protected: protectedResource, observation, candidates: rowCandidates,
    partial: incomplete || local.some(row => row.partial), usageUnassociated, missingTimeEvents,
    localBodyIds: metadataLocal.map(row => row.body.id).sort(), hasHistory: Boolean(bucket.history) };
}

function matches(bucket: OverviewBucket, q: string): boolean {
  return [bucket.identity.name, bucket.history?.identity.path, ...(bucket.history?.paths ?? []),
    ...bucket.local.flatMap(row => [row.body.targetPath, ...row.entries.flatMap(entry => [entry.entryPath, entry.targetPath, entry.linkTarget])])]
    .some(value => value?.toLocaleLowerCase().includes(q));
}

function compare(left: ResourceOverviewRow, right: ResourceOverviewRow, query: ResourceOverviewQuery): number {
  const sort = query.sort ?? (query.kind === "mcp" ? "calls" : "sessions");
  const direction = (query.order ?? (sort === "name" ? "asc" : "desc")) === "asc" ? 1 : -1;
  if (sort === "name") return direction * left.identity.name.localeCompare(right.identity.name) || left.identity.id.localeCompare(right.identity.id);
  const metric = (row: ResourceOverviewRow): number | null => {
    if (!row.stats) return null;
    if (sort === "recent") {
      const time = row.stats.lastUsedAt ? Date.parse(row.stats.lastUsedAt) : NaN;
      return Number.isFinite(time) ? time : null;
    }
    if (sort === "uses") return row.stats.events;
    if (sort === "calls") return row.stats.explicitCalls + row.stats.mcpCalls;
    if (sort === "reads") return row.stats.successfulReads;
    return row.stats.sessions;
  };
  const a = metric(left), b = metric(right);
  const difference = a === null ? b === null ? 0 : 1 : b === null ? -1 : direction * (a - b);
  return difference || left.identity.name.localeCompare(right.identity.name) || left.identity.id.localeCompare(right.identity.id);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

/** 历史已按名称、Agent 和日期聚合；本地仅补充真实本体与观测状态，不累加使用统计。 */
export function buildResourceOverview(history: ResourceUsageResult | null, localRows: readonly ResourceLocalRow[],
  query: ResourceOverviewQuery, options: { observedAt: string; partial: boolean; favorites?: ReadonlySet<string>; now?: number; unpaginated?: boolean; inventory?: ResourceInventorySnapshot }): ResourceOverviewResult {
  const kind = query.kind ?? "skill";
  const buckets = new Map<string, OverviewBucket>();
  for (const row of history?.resources ?? []) {
    if (row.identity.kind !== kind) continue;
    buckets.set(row.identity.id, { identity: row.identity, history: row, local: [] });
  }
  for (const row of localRows) {
    if (row.body.kind !== kind) continue;
    const identity = localIdentity(row);
    let bucket = buckets.get(identity.id);
    if (!bucket) { bucket = { identity, local: [] }; buckets.set(identity.id, bucket); }
    bucket.local.push(row);
  }
  const q = query.q?.trim().toLocaleLowerCase();
  const favorites = options.favorites ?? new Set<string>();
  const now = options.now ?? Date.now();
  const counts: ResourceOverviewResult["counts"] = { all: 0, used: 0, unused: 0, low: 0, old: 0, review: 0, favorite: 0 };
  const rows: ResourceOverviewRow[] = [];
  const byHistoryId = new Map<string, ResourceLocalRow[]>();
  const byBodyId = new Map(localRows.map(row => [row.body.id, row]));
  const unavailable = unavailableLocalClients(options.inventory, query);
  for (const row of localRows) for (const id of row.historyIds) {
    const linked = byHistoryId.get(id) ?? []; linked.push(row); byHistoryId.set(id, linked);
  }
  for (const bucket of buckets.values()) {
    if (q && !matches(bucket, q)) continue;
    const row = rowOf(bucket, history, query, favorites, now, (bucket.history?.favoriteIds ?? []).flatMap(id => byHistoryId.get(id) ?? []));
    const locations = resourceLocations(row.localBodyIds.flatMap(id => byBodyId.get(id) ? [byBodyId.get(id)!] : []), query);
    row.localSummary = resourceLocalSummary(locations, query, options.inventory, bucket.history?.clients ?? [], unavailable);
    if ((query.scope || query.locationProject) && !locations.length || query.presence && row.localSummary.presence !== query.presence) continue;
    row.localBodyIds = locations.map(local => local.body.id).sort();
    for (const candidate of candidates) if (candidate === "all" || row.candidates.includes(candidate)) counts[candidate] += 1;
    if (query.candidate && query.candidate !== "all" && query.candidate !== "review" && !row.candidates.includes(query.candidate)
      || query.favorite && !row.candidates.includes("favorite")) continue;
    rows.push(row);
  }
  rows.sort((left, right) => compare(left, right, query));
  const pageSize = options.unpaginated ? Math.max(1, rows.length) : Math.min(200, positiveInteger(query.pageSize, 20));
  const page = options.unpaginated ? 1 : Math.min(positiveInteger(query.page, 1), Math.max(1, Math.ceil(rows.length / pageSize)));
  return { resources: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, counts,
    stats: history?.stats ?? null, coverage: history?.coverage ?? null, observedAt: options.observedAt, partial: options.partial,
    thresholds: { lowSessions: query.lowSessions ?? 2, inactiveDays: query.inactiveDays ?? 90 } };
}

export const buildSkillOverview = buildResourceOverview;
