import { createHash } from "node:crypto";
import { posix } from "node:path";
import { StoreError } from "../index/store.js";
import type { SessionStore } from "../sessions/store.js";
import type { ResourceInventoryEntry } from "../resource-inventory-contracts.js";
import type {
  ResourceAssociationEntry, ResourceHistoryAssociation, ResourceHistoryIdentity, ResourceUsageCoverage,
  ResourceUsageDetail, ResourceUsageDistribution, ResourceUsageEvent, ResourceUsageEvidenceQuery,
  ResourceUsageEvidenceResult, ResourceUsageQuery, ResourceUsageResult, ResourceUsageRow, ResourceUsageStats,
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
    kind, name, server: event.server, path, client: event.client, project: event.project };
}

/** 只依据已记录路径与客户端范围关联当前入口；不补造历史安装身份。 */
export function associateResourceHistory(identity: ResourceHistoryIdentity, entries: readonly ResourceAssociationEntry[] = []): ResourceHistoryAssociation {
  if (!identity.path) return { state: "unassociated", entryIds: [], reason: "missing_path" };
  const candidates = entries.filter(entry => entry.kind === identity.kind && entry.client === identity.client
    && (entry.scope !== "project" || entry.project !== undefined && entry.project === identity.project)
    && (identity.kind === "mcp" ? (entry.server ?? entry.name) === identity.server : entry.name === identity.name));
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
    || from !== undefined && to !== undefined && from > to) throw new StoreError("INVALID_INPUT", "资源日期范围无效");
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
    unassociatedEvents, partial: stats.missingTimeEvents > 0 || stream.gaps.length > 0, gaps: stream.gaps };
}

function observed(stats: ResourceUsageStats, range: ReturnType<typeof bounds>): number {
  return stats.events + (range.dated ? stats.missingTimeEvents : 0);
}

/** 本地本体按实际关联事件聚合，跨入口的会话数取并集，不能相加。 */
export function localResourceUsage(store: SessionStore, query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[]) {
  const range = bounds(query);
  const stream = store.resourceEvents(query);
  const byEntry = new Map(entries.map(entry => [entry.id, entry]));
  const associations = new Map<string, ResourceHistoryAssociation>();
  const bodies = new Map<string, { accumulator: Accumulator; historyIds: Set<string>; trend: Map<string, Accumulator>;
    clients: Map<string, Accumulator>; projects: Map<string, Accumulator> }>();
  const uncertain = new Set<string>();
  for (const event of stream.events) {
    if (!selected(event, { ...query, q: undefined }, range)) continue;
    const identity = resourceHistoryIdentity(event);
    let association = associations.get(identity.id);
    if (!association) { association = associateResourceHistory(identity, entries); associations.set(identity.id, association); }
    const bodyIds = new Set(association.entryIds.flatMap(id => byEntry.get(id)?.bodyId ?? []));
    if (bodyIds.size !== 1) {
      uncertain.add(JSON.stringify([identity.kind, identity.client, identity.name]));
      continue;
    }
    const entry = byEntry.get(association.entryIds[0]!);
    if (!entry) continue;
    let body = bodies.get(entry.bodyId);
    if (!body) {
      body = { accumulator: empty(), historyIds: new Set(), trend: new Map(), clients: new Map(), projects: new Map() };
      bodies.set(entry.bodyId, body);
    }
    body.historyIds.add(identity.id);
    add(body.accumulator, event, range);
    add(group(body.clients, event.client), event, range);
    add(group(body.projects, event.project ?? ""), event, range);
    const day = eventDay(event);
    if (day) add(group(body.trend, day), event, range);
  }
  return { version: stream.version, clients: stream.clients, partial: stream.gaps.length > 0, uncertain,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    bodies: new Map([...bodies].map(([id, body]) => [id, { stats: finish(body.accumulator), historyIds: [...body.historyIds],
      trend: trends(body.trend), clients: distributions(body.clients), projects: distributions(body.projects) }])) };
}

/** 排行聚合遍历轻量调用元信息，没有明细条数上限，分页只作用于返回的排行。 */
export function listResourceUsage(store: SessionStore, query: ResourceUsageQuery = {}, entries: readonly ResourceAssociationEntry[] = [], favorites: ReadonlySet<string> = new Set()): ResourceUsageResult {
  const range = bounds(query);
  const stream = store.resourceEvents(query);
  const resources = new Map<string, { identity: ResourceHistoryIdentity; accumulator: Accumulator }>();
  const total = empty();
  const trend = new Map<string, Accumulator>();
  const clients = new Map<string, Accumulator>();
  const projects = new Map<string, Accumulator>();
  for (const event of stream.events) {
    if (!selected(event, query, range)) continue;
    const identity = resourceHistoryIdentity(event);
    if (query.favorite && !favorites.has(identity.id)) {
      const association = associateResourceHistory(identity, entries);
      if (!association.entryIds.some(id => favorites.has(id) || entries.some(entry => entry.id === id
        && "bodyId" in entry && favorites.has(String(entry.bodyId))))) continue;
    }
    let resource = resources.get(identity.id);
    if (!resource) { resource = { identity, accumulator: empty() }; resources.set(identity.id, resource); }
    add(resource.accumulator, event, range); add(total, event, range);
    add(group(clients, event.client), event, range); add(group(projects, event.project ?? ""), event, range);
    const day = eventDay(event);
    if (day) add(group(trend, day), event, range);
  }
  let unassociatedEvents = 0;
  const rows: ResourceUsageRow[] = [...resources.values()].map(resource => {
    const stats = finish(resource.accumulator);
    const association = associateResourceHistory(resource.identity, entries);
    if (association.state !== "linked") unassociatedEvents += observed(stats, range);
    return { identity: resource.identity, stats, association };
  });
  const sort = query.sort ?? (query.kind === "mcp" ? "calls" : "sessions");
  rows.sort((left, right) => {
    let difference = 0;
    if (sort === "sessions") difference = right.stats.sessions - left.stats.sessions;
    if (sort === "calls") difference = right.stats.explicitCalls + right.stats.mcpCalls - left.stats.explicitCalls - left.stats.mcpCalls;
    if (sort === "reads") difference = right.stats.successfulReads - left.stats.successfulReads;
    if (sort === "recent") difference = (right.stats.lastUsedAt ? Date.parse(right.stats.lastUsedAt) : -Infinity)
      - (left.stats.lastUsedAt ? Date.parse(left.stats.lastUsedAt) : -Infinity);
    return difference || left.identity.name.localeCompare(right.identity.name) || left.identity.id.localeCompare(right.identity.id);
  });
  const { page, pageSize } = paging(query);
  const stats = finish(total);
  return { version: stream.version, resources: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length,
    page, pageSize, stats, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, trend: trends(trend),
    clients: distributions(clients), projects: distributions(projects), coverage: coverage(stream, stats, unassociatedEvents) };
}

function findIdentity(store: SessionStore, id: string, query: ResourceUsageQuery): ResourceHistoryIdentity {
  for (const event of store.resourceEvents(query).events) {
    if (event.kind === "skill_read" && event.status !== "success") continue;
    const identity = resourceHistoryIdentity(event);
    if (identity.id === id) return identity;
  }
  throw new StoreError("SOURCE_NOT_FOUND", "资源不存在于当前索引范围");
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
export function resourceUsageDetail(store: SessionStore, id: string, query: ResourceUsageQuery = {}, entries: readonly ResourceAssociationEntry[] = []): ResourceUsageDetail {
  const range = bounds(query);
  const identity = findIdentity(store, id, query);
  const stream = store.resourceEvents(query, identity);
  const total = empty();
  const trend = new Map<string, Accumulator>();
  const clients = new Map<string, Accumulator>();
  const projects = new Map<string, Accumulator>();
  const tools = new Map<string, Accumulator>();
  for (const event of stream.events) {
    if (resourceHistoryIdentity(event).id !== id || !selected(event, query, range)) continue;
    add(total, event, range); add(group(clients, event.client), event, range);
    add(group(projects, event.project ?? ""), event, range);
    add(group(tools, event.kind === "mcp" ? event.name : event.tool ?? "未记录工具"), event, range);
    const day = eventDay(event);
    if (day) add(group(trend, day), event, range);
  }
  const stats = finish(total);
  const association = associateResourceHistory(identity, entries);
  return { version: stream.version, resource: { identity, stats, association }, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    trend: trends(trend),
    clients: distributions(clients), projects: distributions(projects),
    tools: [...tools].map(([name, accumulator]) => ({ name, stats: finish(accumulator) }))
      .sort((left, right) => right.stats.events - left.stats.events || left.name.localeCompare(right.name)),
    coverage: coverage(stream, stats, association.state === "linked" ? 0 : observed(stats, range)) };
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
    if (resourceHistoryIdentity(event).id !== id || !selected(event, query, range)
      || query.evidenceKind && event.kind !== query.evidenceKind || query.tool && event.name !== query.tool && event.tool !== query.tool) continue;
    if (timestamp(event) === undefined) { missingTimeEvents += 1; if (range.dated) continue; }
    if (total >= offset && events.length < pageSize) events.push(event);
    total += 1;
  }
  return { version: stream.version, identity, events, total, page, pageSize, missingTimeEvents };
}
