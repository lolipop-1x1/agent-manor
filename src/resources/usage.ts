import { createHash } from "node:crypto";
import { posix } from "node:path";
import { StoreError } from "../index/store.js";
import { resourceGapRelevant } from "./coverage.js";
import type { SessionStore } from "../sessions/store.js";
import type { ResourceInventoryEntry } from "../resource-inventory-contracts.js";
import type {
  ResourceAssociationEntry, ResourceHistoryAssociation, ResourceHistoryIdentity, ResourceUsageCoverage,
  ResourceUsageDetail, ResourceUsageDistribution, ResourceUsageEvent, ResourceUsageEvidenceQuery,
  ResourceUsageEvidenceResult, ResourceUsageQuery, ResourceUsageResult, ResourceUsageRow, ResourceUsageStats,
  ResourceUsageIdentity, ResourceEventStream,
} from "../resource-contracts.js";

interface Accumulator { stats: ResourceUsageStats; sessions: Set<string>; durationMs: number }
const empty = (): Accumulator => ({ sessions: new Set(), durationMs: 0, stats: { events: 0, sessions: 0,
  explicitCalls: 0, successfulReads: 0, mcpCalls: 0, lastUsedAt: null, missingTimeEvents: 0,
  results: { success: 0, failure: 0, unknown: 0, recorded: 0, successRate: null },
  duration: { samples: 0, totalMs: null, averageMs: null } } });

function normalizedPath(path: string): string {
  return posix.normalize(path.replace(/\\/g, "/")).replace(/\/SKILL\.md$/, "");
}

/** 身份包含记录的客户端、项目范围和路径；相同名称不会折叠成同一安装实例。 */
export function resourceHistoryIdentity(event: ResourceUsageEvent): ResourceHistoryIdentity {
  const kind = event.kind === "mcp" ? "mcp" : "skill";
  const name = kind === "mcp" ? event.server ?? "未记录服务器" : event.name;
  const path = event.path ? normalizedPath(event.path) : undefined;
  const parts = [kind, name, event.server ?? null, path ?? null, event.client, event.project ?? null];
  return { id: `resource:${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`,
    kind, name, ...(kind === "skill" && event.nameDescriptor ? { nameDescriptor: event.nameDescriptor } : {}),
    server: event.server, path, client: event.client, project: event.project };
}

export function resourceUsageIdentity(identity: ResourceHistoryIdentity): ResourceUsageIdentity {
  // 缺失名称的占位文案不能证明是同一个 Skill，继续保留来源范围。
  if (identity.kind !== "skill" || identity.name === "未记录名称" || !identity.name.trim()) return { ...identity, grouping: "source" };
  return { id: `resource:${createHash("sha256").update(JSON.stringify(["skill", identity.name])).digest("hex").slice(0, 32)}`,
    kind: "skill", name: identity.name, ...(identity.nameDescriptor ? { nameDescriptor: identity.nameDescriptor } : {}), grouping: "skill" };
}

/** MCP 名称总览使用独立标识，既有历史来源标识与本地注册身份保持不变。 */
export function resourceOverviewIdentity(identity: ResourceHistoryIdentity, sourceId?: string): ResourceUsageIdentity {
  if (identity.kind !== "mcp") return resourceUsageIdentity(identity);
  if (!identity.name.trim() || identity.name === "未记录服务器" || identity.name === "未记录名称") return { ...identity,
    id: sourceId ? `resource:mcp-source:${createHash("sha256").update(JSON.stringify([identity.id, sourceId])).digest("hex").slice(0, 32)}` : identity.id,
    grouping: "source" };
  return { id: `resource:mcp:${createHash("sha256").update(JSON.stringify(["mcp", identity.name])).digest("hex").slice(0, 32)}`,
    kind: "mcp", name: identity.name, server: identity.name, grouping: "mcp" };
}

/** 只依据已记录路径与客户端范围关联当前入口；不补造历史安装身份。 */
export function associateResourceHistory(identity: ResourceHistoryIdentity, entries: readonly ResourceAssociationEntry[] = []): ResourceHistoryAssociation {
  if (!identity.path) return { state: "unassociated", entryIds: [], reason: "missing_path" };
  const candidates = entries.filter(entry => entry.kind === identity.kind && entry.client === identity.client
    && (entry.scope !== "project" || entry.project !== undefined && entry.project === identity.project)
    && (identity.kind === "mcp" ? (entry.server ?? entry.name) === identity.server : entry.name === identity.name
      || ["codeflicker", "codeflicker-desktop"].includes(entry.client) && entry.nativeNames?.includes(identity.name)));
  const exact = candidates.filter(entry => normalizedPath(entry.entryPath) === identity.path);
  const matches = exact.length ? exact : candidates.filter(entry => entry.targetPath && normalizedPath(entry.targetPath) === identity.path);
  const entryIds = [...new Set(matches.map(entry => entry.id))].sort();
  return { state: entryIds.length === 1 ? "linked" : entryIds.length ? "ambiguous" : "unassociated", entryIds,
    reason: entryIds.length === 1 ? "recorded_path" : entryIds.length ? "multiple_entries" : "not_discovered" };
}

function bounds(query: ResourceUsageQuery): { from?: number; to?: number; dated: boolean } {
  const from = query.from === undefined ? undefined : Date.parse(query.from);
  const to = query.to === undefined ? undefined : Date.parse(query.to);
  if (from !== undefined && !Number.isFinite(from) || to !== undefined && !Number.isFinite(to)
    || from !== undefined && to !== undefined && from > to) throw new StoreError("INVALID_INPUT", "资源日期范围无效", { key: "diagnostics.resources.usage.invalidDates" });
  return { from, to, dated: from !== undefined || to !== undefined };
}

function timestamp(event: ResourceUsageEvent): number | undefined {
  const time = event.occurredAt ? Date.parse(event.occurredAt) : NaN;
  return Number.isFinite(time) ? time : undefined;
}

function selected(event: ResourceUsageEvent, query: ResourceUsageQuery, range: ReturnType<typeof bounds>): boolean {
  if (event.kind === "skill_read" && event.status !== "success") return false;
  if (query.kind && query.kind !== (event.kind === "mcp" ? "mcp" : "skill")) return false;
  const q = query.q?.trim().toLocaleLowerCase();
  if (q && ![event.kind === "mcp" ? event.server : event.name, event.path].some(value => value?.toLocaleLowerCase().includes(q))) return false;
  const time = timestamp(event);
  return time === undefined || (range.from === undefined || time >= range.from) && (range.to === undefined || time <= range.to);
}

function add(target: Accumulator, event: ResourceUsageEvent, range: ReturnType<typeof bounds>): void {
  const time = timestamp(event);
  if (time === undefined) {
    target.stats.missingTimeEvents += 1;
    if (range.dated) return;
  }
  target.stats.events += 1;
  target.sessions.add(event.sessionId);
  if (event.kind === "skill_read") target.stats.successfulReads += 1;
  else {
    if (event.kind === "skill_call") target.stats.explicitCalls += 1;
    else target.stats.mcpCalls += 1;
    target.stats.results[event.status] += 1;
  }
  if (time !== undefined && (!target.stats.lastUsedAt || time > Date.parse(target.stats.lastUsedAt))) target.stats.lastUsedAt = new Date(time).toISOString();
  if (event.durationMs !== undefined) {
    target.durationMs += event.durationMs;
    target.stats.duration.samples += 1;
  }
}

function finish(target: Accumulator): ResourceUsageStats {
  const stats = target.stats;
  stats.sessions = target.sessions.size;
  stats.results.recorded = stats.results.success + stats.results.failure;
  stats.results.successRate = stats.results.recorded ? stats.results.success / stats.results.recorded : null;
  if (stats.duration.samples) {
    stats.duration.totalMs = target.durationMs;
    stats.duration.averageMs = target.durationMs / stats.duration.samples;
  }
  return stats;
}

/** 已确认无使用证据时返回零计数，不把未知结果率或耗时补成零。 */
export function emptyResourceUsageStats(): ResourceUsageStats {
  return finish(empty());
}

function paging(query: ResourceUsageQuery): { page: number; pageSize: number } {
  return { page: Math.max(1, Math.floor(query.page ?? 1)), pageSize: Math.min(200, Math.max(1, Math.floor(query.pageSize ?? 50))) };
}

function coverage(stream: ReturnType<SessionStore["resourceEvents"]>, stats: ResourceUsageStats, unassociatedEvents: number): ResourceUsageCoverage {
  return { sessionCount: stream.sessionCount, clients: stream.clients, missingTimeEvents: stats.missingTimeEvents,
    unassociatedEvents, partial: stats.missingTimeEvents > 0 || stream.gaps.some(resourceGapRelevant), gaps: stream.gaps,
    uncertainClients: stream.uncertainClients, unscopedGaps: stream.unscopedGaps,
    unavailableClients: stream.unavailableClients, unscopedUnavailableGaps: stream.unscopedUnavailableGaps };
}

function observed(stats: ResourceUsageStats, range: ReturnType<typeof bounds>): number {
  return stats.events + (range.dated ? stats.missingTimeEvents : 0);
}

/** 本地本体按实际关联事件聚合，跨入口的会话数取并集，不能相加。 */
export function localResourceUsage(store: SessionStore, query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[]) {
  bounds(query);
  const stream = store.resourceEvents(query);
  const collector = localUsageCollector(query, entries, stream);
  for (const event of stream.events) collector.add(event);
  return collector.result();
}

function localUsageCollector(query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[], stream: ResourceEventStream) {
  const range = bounds(query);
  const byEntry = new Map(entries.map(entry => [entry.id, entry]));
  const associations = new Map<string, ResourceHistoryAssociation>();
  const bodies = new Map<string, { accumulator: Accumulator; historyIds: Set<string>; favoriteIds: Set<string>; trend: Map<string, Accumulator>;
    clients: Map<string, Accumulator>; projects: Map<string, Accumulator> }>();
  const uncertain = new Set<string>();
  return { add(event: ResourceUsageEvent) {
    if (!selected(event, { ...query, q: undefined }, range)) return;
    const identity = resourceHistoryIdentity(event);
    let association = associations.get(identity.id);
    if (!association) { association = associateResourceHistory(identity, entries); associations.set(identity.id, association); }
    const bodyIds = new Set(association.entryIds.flatMap(id => byEntry.get(id)?.bodyId ?? []));
    if (bodyIds.size !== 1) {
      uncertain.add(JSON.stringify([identity.kind, identity.client, identity.name]));
      return;
    }
    const entry = byEntry.get(association.entryIds[0]!);
    if (!entry) return;
    let body = bodies.get(entry.bodyId);
    if (!body) {
      body = { accumulator: empty(), historyIds: new Set(), favoriteIds: new Set(), trend: new Map(), clients: new Map(), projects: new Map() };
      bodies.set(entry.bodyId, body);
    }
    body.historyIds.add(identity.id);
    body.favoriteIds.add(identity.id);
    body.favoriteIds.add(resourceUsageIdentity(identity).id);
    body.favoriteIds.add(resourceOverviewIdentity(identity, event.source.sourceId).id);
    add(body.accumulator, event, range);
    add(group(body.clients, event.client), event, range);
    add(group(body.projects, event.project ?? ""), event, range);
    const day = eventDay(event);
    if (day) add(group(body.trend, day), event, range);
  }, result() { return { version: stream.version, clients: stream.clients, partial: stream.gaps.some(resourceGapRelevant), uncertain,
    uncertainClients: stream.uncertainClients ?? [], unscopedGaps: stream.unscopedGaps ?? stream.gaps.some(resourceGapRelevant),
    unavailableClients: stream.unavailableClients ?? [], unscopedUnavailableGaps: stream.unscopedUnavailableGaps
      ?? stream.gaps.some(gap => gap.kind === "source_unavailable" && resourceGapRelevant(gap)),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    bodies: new Map([...bodies].map(([id, body]) => [id, { stats: finish(body.accumulator), historyIds: [...body.historyIds], favoriteIds: [...body.favoriteIds],
      trend: trends(body.trend), clients: distributions(body.clients), projects: distributions(body.projects) }])) }; } };
}

interface UsageBucket {
  identity: ResourceUsageIdentity;
  accumulator: Accumulator;
  origins: Map<string, { identity: ResourceHistoryIdentity; accumulator: Accumulator }>;
  trend: Map<string, Accumulator>;
  clients: Map<string, Accumulator>;
  projects: Map<string, Accumulator>;
}

function bucket(identity: ResourceUsageIdentity): UsageBucket {
  return { identity, accumulator: empty(), origins: new Map(), trend: new Map(), clients: new Map(), projects: new Map() };
}

function addUsage(target: UsageBucket, event: ResourceUsageEvent, identity: ResourceHistoryIdentity, range: ReturnType<typeof bounds>): void {
  let origin = target.origins.get(identity.id);
  if (!origin) { origin = { identity, accumulator: empty() }; target.origins.set(identity.id, origin); }
  // 同一稳定身份混有原始名称或旧记录时保留原名，不能将真实同名误译。
  if (JSON.stringify(target.identity.nameDescriptor) !== JSON.stringify(identity.nameDescriptor)) delete target.identity.nameDescriptor;
  if (JSON.stringify(origin.identity.nameDescriptor) !== JSON.stringify(identity.nameDescriptor)) delete origin.identity.nameDescriptor;
  add(origin.accumulator, event, range);
  add(target.accumulator, event, range);
  add(group(target.clients, event.client), event, range);
  add(group(target.projects, event.project ?? ""), event, range);
  const day = eventDay(event);
  if (day) add(group(target.trend, day), event, range);
}

function merge(target: Accumulator, source: Accumulator): void {
  for (const id of source.sessions) target.sessions.add(id);
  for (const key of ["events", "explicitCalls", "successfulReads", "mcpCalls", "missingTimeEvents"] as const) target.stats[key] += source.stats[key];
  for (const key of ["success", "failure", "unknown"] as const) target.stats.results[key] += source.stats.results[key];
  target.stats.duration.samples += source.stats.duration.samples;
  target.durationMs += source.durationMs;
  if (source.stats.lastUsedAt && (!target.stats.lastUsedAt || source.stats.lastUsedAt > target.stats.lastUsedAt)) target.stats.lastUsedAt = source.stats.lastUsedAt;
}

function mergeGroups(target: Map<string, Accumulator>, source: Map<string, Accumulator>): void {
  for (const [key, value] of source) merge(group(target, key), value);
}

function usageRow(target: UsageBucket, entries: readonly ResourceAssociationEntry[], favorites: ReadonlySet<string>): ResourceUsageRow {
  const origins = [...target.origins.values()].map(origin => ({ identity: origin.identity, association: associateResourceHistory(origin.identity, entries) }));
  const entryIds = [...new Set(origins.flatMap(origin => origin.association.entryIds))].sort();
  const linked = origins.filter(origin => origin.association.state === "linked").length;
  const ambiguous = origins.some(origin => origin.association.state === "ambiguous");
  const allLinked = origins.length > 0 && linked === origins.length;
  const association: ResourceHistoryAssociation = {
    state: ambiguous ? "ambiguous" : allLinked ? "linked" : linked ? "partial" : "unassociated",
    entryIds,
    reason: ambiguous ? "multiple_entries" : allLinked ? "recorded_path" : linked ? "partial_link"
      : origins.some(origin => origin.association.reason === "missing_path") ? "missing_path" : "not_discovered",
  };
  const favorite = favorites.has(target.identity.id) || origins.some(origin => favorites.has(origin.identity.id));
  return { identity: target.identity, stats: finish(target.accumulator), association,
    clients: [...target.clients.keys()].sort() as ResourceUsageRow["clients"], favorite,
    paths: [...new Set(origins.flatMap(origin => origin.identity.path ?? []))].sort() };
}

function unassociated(target: UsageBucket, entries: readonly ResourceAssociationEntry[], range: ReturnType<typeof bounds>): number {
  let count = 0;
  for (const origin of target.origins.values()) if (associateResourceHistory(origin.identity, entries).state !== "linked") count += observed(finish(origin.accumulator), range);
  return count;
}

/** Skill 保留名称排行；MCP 仅在总览按名称聚合，既有来源排行保持兼容。 */
export function aggregateResourceUsage(store: SessionStore, query: ResourceUsageQuery = {}, entries: readonly ResourceAssociationEntry[] = [],
  favorites: ReadonlySet<string> = new Set(), overview = false): ResourceUsageResult {
  bounds(query);
  return aggregateUsage(store.resourceEvents(query), query, entries, favorites, overview);
}

/** 总览统计与本地关联共用一次事件流，不保存原始事件副本。 */
export function overviewResourceUsage(store: SessionStore, query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[], favorites: ReadonlySet<string>) {
  bounds(query);
  const stream = store.resourceEvents(query);
  const local = localUsageCollector(query, entries, stream);
  const history = aggregateUsage(stream, query, entries, favorites, true, event => local.add(event));
  return { history, local: local.result() };
}

function aggregateUsage(stream: ResourceEventStream, query: ResourceUsageQuery, entries: readonly ResourceAssociationEntry[],
  favorites: ReadonlySet<string>, overview: boolean, onEvent?: (event: ResourceUsageEvent) => void): ResourceUsageResult {
  const range = bounds(query);
  const resources = new Map<string, UsageBucket>();
  const total = empty();
  const trend = new Map<string, Accumulator>();
  const clients = new Map<string, Accumulator>();
  const projects = new Map<string, Accumulator>();
  for (const event of stream.events) {
    onEvent?.(event);
    if (!selected(event, query, range)) continue;
    const origin = resourceHistoryIdentity(event);
    const identity = overview ? resourceOverviewIdentity(origin, event.source.sourceId) : resourceUsageIdentity(origin);
    let resource = resources.get(identity.id);
    if (!resource) { resource = bucket(identity); resources.set(identity.id, resource); }
    addUsage(resource, event, origin, range);
  }
  let unassociatedEvents = 0;
  const rows: ResourceUsageRow[] = [];
  for (const resource of resources.values()) {
    const row = usageRow(resource, entries, favorites);
    const associatedFavorite = row.association.entryIds.some(id => favorites.has(id) || entries.some(entry => entry.id === id
      && "bodyId" in entry && favorites.has(String(entry.bodyId))));
    if (query.favorite && !row.favorite && !associatedFavorite) continue;
    rows.push(row);
    merge(total, resource.accumulator);
    mergeGroups(clients, resource.clients); mergeGroups(projects, resource.projects); mergeGroups(trend, resource.trend);
    unassociatedEvents += unassociated(resource, entries, range);
  }
  const sort = query.sort ?? (query.kind === "mcp" ? "calls" : "sessions");
  rows.sort((left, right) => {
    let difference = 0;
    if (sort === "sessions") difference = right.stats.sessions - left.stats.sessions;
    if (sort === "uses") difference = right.stats.events - left.stats.events;
    if (sort === "calls") difference = right.stats.explicitCalls + right.stats.mcpCalls - left.stats.explicitCalls - left.stats.mcpCalls;
    if (sort === "reads") difference = right.stats.successfulReads - left.stats.successfulReads;
    if (sort === "recent") {
      if (!left.stats.lastUsedAt || !right.stats.lastUsedAt) return (left.stats.lastUsedAt ? -1 : right.stats.lastUsedAt ? 1 : 0)
        || left.identity.name.localeCompare(right.identity.name) || left.identity.id.localeCompare(right.identity.id);
      difference = Date.parse(right.stats.lastUsedAt) - Date.parse(left.stats.lastUsedAt);
    }
    return (query.order === "asc" ? -difference : difference)
      || (sort === "name" && query.order === "desc" ? -1 : 1) * left.identity.name.localeCompare(right.identity.name)
      || left.identity.id.localeCompare(right.identity.id);
  });
  const stats = finish(total);
  return { version: stream.version, resources: rows, total: rows.length,
    page: 1, pageSize: Math.max(1, rows.length), stats, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, trend: trends(trend),
    clients: distributions(clients), projects: distributions(projects), coverage: coverage(stream, stats, unassociatedEvents) };
}

/** 聚合始终使用全部事件，分页只限制返回的列表行。 */
export function listResourceUsage(store: SessionStore, query: ResourceUsageQuery = {}, entries: readonly ResourceAssociationEntry[] = [], favorites: ReadonlySet<string> = new Set()): ResourceUsageResult {
  const result = aggregateResourceUsage(store, query, entries, favorites);
  const { page, pageSize } = paging(query);
  return { ...result, resources: result.resources.slice((page - 1) * pageSize, page * pageSize), page, pageSize };
}

function findIdentity(store: SessionStore, id: string, query: ResourceUsageQuery): ResourceUsageIdentity {
  for (const event of store.resourceEvents(query).events) {
    if (event.kind === "skill_read" && event.status !== "success") continue;
    const identity = resourceHistoryIdentity(event);
    const usage = resourceUsageIdentity(identity);
    if (usage.id === id) return usage;
    if (identity.id === id) return { ...identity, grouping: "source" };
    const overview = resourceOverviewIdentity(identity, event.source.sourceId);
    if (overview.id === id) return overview;
  }
  throw new StoreError("SOURCE_NOT_FOUND", "资源不存在于当前索引范围", { key: "diagnostics.resources.usage.notFound" });
}

function matches(event: ResourceUsageEvent, identity: ResourceUsageIdentity): boolean {
  const origin = resourceHistoryIdentity(event);
  return (identity.id.startsWith("resource:mcp-source:") ? resourceOverviewIdentity(origin, event.source.sourceId).id
    : identity.grouping === "skill" ? resourceUsageIdentity(origin).id
    : identity.grouping === "mcp" ? resourceOverviewIdentity(origin).id : origin.id) === identity.id;
}

function group(map: Map<string, Accumulator>, key: string): Accumulator {
  let value = map.get(key);
  if (!value) { value = empty(); map.set(key, value); }
  return value;
}

function distributions(map: Map<string, Accumulator>): ResourceUsageDistribution[] {
  return [...map].map(([value, accumulator]) => ({ value: value || null, stats: finish(accumulator) }))
    .sort((left, right) => right.stats.events - left.stats.events || (left.value ?? "").localeCompare(right.value ?? ""));
}

function eventDay(event: ResourceUsageEvent): string | undefined {
  const time = timestamp(event);
  if (time === undefined) return undefined;
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function trends(map: Map<string, Accumulator>): ResourceUsageDetail["trend"] {
  return [...map].sort(([left], [right]) => left.localeCompare(right)).map(([date, accumulator]) => ({ date, stats: finish(accumulator) }));
}

/** 日期趋势沿用本机时区；无有效事件时间的记录只进入缺失数量。 */
export function resourceUsageDetail(store: SessionStore, id: string, query: ResourceUsageQuery = {}, entries: readonly ResourceAssociationEntry[] = [], favorites: ReadonlySet<string> = new Set()): ResourceUsageDetail {
  const range = bounds(query);
  const identity = findIdentity(store, id, query);
  const stream = store.resourceEvents(query, identity);
  const resource = bucket(identity);
  const tools = new Map<string, Accumulator>();
  for (const event of stream.events) {
    if (!matches(event, identity) || !selected(event, query, range)) continue;
    addUsage(resource, event, resourceHistoryIdentity(event), range);
    add(group(tools, event.kind === "mcp" ? event.name : event.tool ?? "未记录工具"), event, range);
  }
  const row = usageRow(resource, entries, favorites);
  return { version: stream.version, resource: row, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    trend: trends(resource.trend), clients: distributions(resource.clients), projects: distributions(resource.projects),
    tools: [...tools].map(([name, accumulator]) => ({ name, stats: finish(accumulator) }))
      .sort((left, right) => right.stats.events - left.stats.events || left.name.localeCompare(right.name)),
    coverage: coverage(stream, row.stats, unassociated(resource, entries, range)), origins: [...resource.origins.values()].map(origin => origin.identity) };
}

/** 证据分页只缓存当前页；总数与排行共享筛选和事件口径。 */
export function resourceUsageEvidence(store: SessionStore, id: string, query: ResourceUsageEvidenceQuery = {}): ResourceUsageEvidenceResult {
  const range = bounds(query);
  const identity = findIdentity(store, id, query);
  const stream = store.resourceEvents(query, identity);
  const { page, pageSize } = paging(query);
  const events: ResourceUsageEvent[] = [];
  const offset = (page - 1) * pageSize;
  let total = 0;
  let missingTimeEvents = 0;
  for (const event of stream.events) {
    if (!matches(event, identity) || !selected(event, query, range)
      || query.evidenceKind && event.kind !== query.evidenceKind || query.tool && event.name !== query.tool && event.tool !== query.tool) continue;
    if (timestamp(event) === undefined) { missingTimeEvents += 1; if (range.dated) continue; }
    if (total >= offset && events.length < pageSize) events.push(event);
    total += 1;
  }
  return { version: stream.version, identity, events, total, page, pageSize, missingTimeEvents };
}
