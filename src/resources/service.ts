import type { SessionStore } from "../sessions/store.js";
import type { ResourceInventoryOptions, ResourceInventorySnapshot, ResourceManualSource } from "../resource-inventory-contracts.js";
import type { ResourceLocalDetail, ResourceLocalQuery, ResourceLocalResult, ResourceLocalRow, ResourceStatus, ResourceStatusSummary, ResourceClientOptions, ResourceOverviewResult, ResourceOverviewQuery, ResourceOverviewDetail, ResourceMapQuery, ResourceMapResult } from "../resource-service-contracts.js";
import type { ResourceUsageQuery } from "../resource-contracts.js";
import { ServiceError } from "../service/input.js";
import { StoreError } from "../index/store.js";
import { scanResourceInventory } from "./inventory.js";
import { overviewResourceUsage, emptyResourceUsageStats, listResourceUsage, resourceOverviewIdentity, localResourceUsage, resourceUsageDetail, resourceUsageEvidence } from "./usage.js";
import { buildResourceOverview } from "./overview.js";
import { buildResourceMap } from "./map.js";
import { ResourceManager } from "./management.js";
import { resourceUsageThresholdMatches } from "./classification.js";
import { applyResourceFavorites } from "./favorites.js";

export function summarizeResourceStatus(status: ResourceStatus): ResourceStatusSummary {
  const sources = new Map(status.sources.map(source => [source.id, source]));
  return { observedAt: status.observedAt, clientOptions: status.clientOptions, projects: status.projects, favoriteIds: status.favoriteIds, manualSources: status.manualSources,
    sourceIssues: status.gaps.flatMap(gap => {
      const source = sources.get(gap.sourceId);
      return source ? [{ client: source.client, kind: source.kind, scope: source.scope, project: source.project, reason: gap.reason }] : [];
    }) };
}

export function summarizeResourceCoverage<T extends ResourceOverviewResult | ResourceMapResult>(result: T) {
  const { gaps: _gaps, ...coverage } = result.coverage ?? {};
  return { ...result, coverage: result.coverage ? coverage : null };
}

/** 共用服务边界：派生盘点可刷新，收藏和恢复材料由独立管理库保留。 */
export class ResourceService {
  private snapshot?: ResourceInventorySnapshot;
  private pending?: Promise<ResourceInventorySnapshot>;
  private readonly overviewCache = new Map<string, Promise<ReturnType<typeof overviewResourceUsage>>>();
  private overviewGeneration?: string;
  constructor(readonly library: SessionStore, readonly manager: ResourceManager,
    private readonly inventoryOptions: ResourceInventoryOptions, private readonly projects: () => string[]) {}

  private inventory(): Promise<ResourceInventorySnapshot> {
    return this.snapshot ? Promise.resolve(this.snapshot) : this.scan();
  }
  private scan(): Promise<ResourceInventorySnapshot> {
    if (!this.pending) this.pending = (async () => {
      const snapshot = await scanResourceInventory({ ...this.inventoryOptions, projects: this.projects(), manualSources: this.manager.manualSources() });
      this.snapshot = this.manager.decorateInventory(snapshot);
      this.overviewCache.clear();
      return this.snapshot;
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async status(): Promise<ResourceStatus> {
    const inventory = await this.inventory();
    const history = this.library.resourceClients();
    const clientOptions: ResourceClientOptions = {
      skill: { usage: [], local: [], disabled: [], trash: [], operations: [] },
      mcp: { usage: [], local: [], disabled: [], trash: [], operations: [] },
    };
    for (const kind of ["skill", "mcp"] as const) {
      const local = [...new Set(inventory.entries.filter(entry => entry.kind === kind).map(entry => entry.client))].sort();
      clientOptions[kind].local = local;
      clientOptions[kind].usage = [...new Set([...local, ...history[kind]])].sort();
    }
    for (const row of this.manager.clientOptions()) if (!clientOptions[row.kind][row.view].includes(row.client)) clientOptions[row.kind][row.view].push(row.client);
    return { observedAt: inventory.observedAt, clientOptions, sources: inventory.sources, gaps: inventory.gaps, diagnostics: inventory.diagnostics,
      projects: this.projects(), favoriteIds: this.manager.favorites(), manualSources: this.manager.manualSources() };
  }
  async refresh(): Promise<ResourceStatus> { await this.scan(); return this.status(); }
  async usage(query: ResourceUsageQuery) {
    return { ...listResourceUsage(this.library, query, (await this.inventory()).entries, new Set(this.manager.favorites())), favoriteIds: this.manager.favorites() };
  }
  private async overviewData(query: ResourceOverviewQuery) {
    const scope = { kind: query.kind ?? "skill", client: query.client, from: query.from, to: query.to,
      version: query.version ?? this.library.currentVersion() };
    const inventory = await this.inventory();
    const generation = JSON.stringify([scope.version, inventory.observedAt]);
    if (this.overviewGeneration !== generation) { this.overviewCache.clear(); this.overviewGeneration = generation; }
    // 状态、排序和分页只改变视野；同一索引与盘点范围复用全量聚合。
    const key = JSON.stringify(scope);
    const localQuery = { ...scope, lowSessions: query.lowSessions, inactiveDays: query.inactiveDays };
    const cached = this.overviewCache.get(key);
    const value = cached ?? Promise.resolve().then(() => overviewResourceUsage(this.library, scope, inventory.entries, new Set()));
    this.overviewCache.delete(key);
    this.overviewCache.set(key, value);
    if (this.overviewCache.size > 8) this.overviewCache.delete(this.overviewCache.keys().next().value!);
    try {
      const usage = await value;
      const favorites = new Set(this.manager.favorites());
      const history = usage.history ? { ...usage.history, resources: usage.history.resources.map(row => applyResourceFavorites(row, favorites)) } : null;
      // 收藏及时间分类使用当前状态，历史与本地关联仍复用同一事件聚合。
      const local = await this.localRows(localQuery, false, { inventory: await this.inventory(), history: usage.local });
      return { history, local };
    } catch (error) { if (this.overviewCache.get(key) === value) this.overviewCache.delete(key); throw error; }
  }
  async overview(query: ResourceOverviewQuery) {
    const { history, local } = await this.overviewData(query);
    return { ...buildResourceOverview(history, local.rows, query, { observedAt: local.inventory.observedAt,
      partial: local.partial, favorites: new Set(this.manager.favorites()) }), favoriteIds: this.manager.favorites() };
  }
  async map(query: ResourceMapQuery): Promise<ResourceMapResult> {
    const { history, local } = await this.overviewData(query);
    const overview = buildResourceOverview(history, local.rows, query, { observedAt: local.inventory.observedAt,
      partial: local.partial, favorites: new Set(this.manager.favorites()), unpaginated: true });
    return buildResourceMap(overview, history, query);
  }
  async overviewDetail(id: string, query: ResourceOverviewQuery): Promise<ResourceOverviewDetail> {
    const { history, local } = await this.overviewData(query);
    const kind = query.kind ?? "skill";
    const all = buildResourceOverview(history, local.rows, { ...query, q: undefined, candidate: "all", favorite: false }, {
      observedAt: local.inventory.observedAt, partial: local.partial, favorites: new Set(this.manager.favorites()), unpaginated: true });
    const target = all.resources.find(row => row.identity.id === id);
    if (target) return { resource: target, history: target.hasHistory ? resourceUsageDetail(this.library, id, { ...query, kind, project: undefined },
      local.inventory.entries, new Set(this.manager.favorites()), target.identity) : null, local: local.rows.filter(row => target.localBodyIds.includes(row.body.id)) };
    const legacy = resourceUsageDetail(this.library, id, { ...query, kind, project: undefined }, local.inventory.entries, new Set(this.manager.favorites()));
    const bodyIds = new Set(local.inventory.entries.filter(entry => legacy.resource.association.entryIds.includes(entry.id)).map(entry => entry.bodyId));
    return { resource: { identity: legacy.resource.identity, stats: legacy.resource.stats.events ? legacy.resource.stats : null, clients: legacy.resource.clients,
      favoriteIds: legacy.resource.favoriteIds, protectedByConfiguration: false,
      favorite: legacy.resource.favorite, protected: legacy.resource.favorite, observation: legacy.resource.stats.events ? "used" : "unknown",
      partial: legacy.coverage.partial, usageUnassociated: legacy.resource.association.state !== "linked",
      missingTimeEvents: legacy.resource.stats.missingTimeEvents,
      candidates: [], localBodyIds: [...bodyIds], hasHistory: true }, history: legacy, local: local.rows.filter(row => bodyIds.has(row.body.id)) };
  }
  async usageDetail(id: string, query: ResourceUsageQuery) {
    return { ...resourceUsageDetail(this.library, id, query, (await this.inventory()).entries, new Set(this.manager.favorites())), favoriteIds: this.manager.favorites() };
  }
  async evidence(id: string, query: Parameters<typeof resourceUsageEvidence>[2] = {}) {
    // 只复用已经取得的同版身份；单独查证据不触发全量总览聚合。
    const scope = { kind: query.kind ?? "skill", client: query.client, from: query.from, to: query.to,
      version: query.version ?? this.library.currentVersion() };
    const cached = this.overviewCache.get(JSON.stringify(scope));
    const identity = (await cached)?.history?.resources.find(row => row.identity.id === id)?.identity;
    return resourceUsageEvidence(this.library, id, query, identity);
  }

  setFavorite(id: string, value: boolean) {
    // 名称汇总继承旧历史来源收藏；取消时同步取消这些历史别名，保留本地本体收藏。
    if (!value && id.startsWith("resource:")) {
      try {
        const detail = resourceUsageDetail(this.library, id);
        if (detail.resource.identity.grouping !== "source" || id.startsWith("resource:mcp-source:")) {
          for (const origin of detail.origins) this.manager.setFavorite(origin.id, false);
        }
      } catch (error) {
        if (!(error instanceof StoreError) || !["ANALYSIS_NOT_READY", "SOURCE_NOT_FOUND"].includes(error.code)) throw error;
      }
    }
    this.manager.setFavorite(id, value);
    const favoriteIds = this.manager.favorites();
    if (this.snapshot) {
      const favorites = new Set(favoriteIds);
      this.snapshot = { ...this.snapshot, entries: this.snapshot.entries.map(entry => ({ ...entry, favorite: favorites.has(entry.id) || favorites.has(entry.bodyId) })) };
    }
    return { favoriteIds };
  }

  private async localRows(query: ResourceLocalQuery, historyAvailable = true,
    prepared?: { inventory: ResourceInventorySnapshot; history?: ReturnType<typeof localResourceUsage> }): Promise<{ rows: ResourceLocalRow[]; inventory: ResourceInventorySnapshot; partial: boolean; history?: ReturnType<typeof localResourceUsage> }> {
    const inventory = prepared?.inventory ?? await this.inventory();
    let history = prepared?.history;
    if (historyAvailable) history = localResourceUsage(this.library, query, inventory.entries);
    const favoriteIds = new Set(this.manager.favorites());
    const byId = new Map(inventory.entries.map(entry => [entry.id, entry]));
    const fingerprints = new Map<string, Set<string>>();
    for (const body of inventory.bodies) if (body.contentFingerprint) {
      let ids = fingerprints.get(body.contentFingerprint);
      if (!ids) { ids = new Set(); fingerprints.set(body.contentFingerprint, ids); }
      ids.add(body.id);
    }
    const rows: ResourceLocalRow[] = [];
    const now = Date.now();
    for (const body of inventory.bodies) {
      if (query.kind && query.kind !== body.kind) continue;
      const entries = body.entryIds.flatMap(id => byId.get(id) ? [byId.get(id)!] : []).filter(entry =>
        (!query.client || entry.client === query.client) && (!query.project || (query.project === "none" ? entry.selectionScopes ? entry.selectionScopes.some(scope => scope.scope === "user") : !entry.project
          : entry.project === query.project || entry.selectionScopes?.some(scope => scope.project === query.project))));
      if (!entries.length) continue;
      const q = query.q?.trim().toLocaleLowerCase();
      if (q && ![body.name, body.targetPath, ...entries.map(entry => entry.entryPath)].some(value => value?.toLocaleLowerCase().includes(q))) continue;
      const firstSeenAt = entries.map(entry => (entry as typeof entry & { firstSeenAt?: string }).firstSeenAt ?? entry.observedAt).sort()[0]!;
      const usage = history?.bodies.get(body.id);
      const rowFavoriteIds = [...new Set([body.id, ...entries.flatMap(entry => [entry.id, resourceOverviewIdentity({
        id: entry.id, kind: entry.kind, name: entry.name, client: entry.client }).id]), ...(usage?.favoriteIds ?? [])])];
      const favorite = rowFavoriteIds.some(id => favoriteIds.has(id));
      const usageUnassociated = entries.some(entry => history?.uncertain.has(JSON.stringify([entry.kind, entry.client, entry.name])));
      const missingTimeEvents = usage?.stats.missingTimeEvents ?? 0;
      const sourceUnavailable = entries.some(entry => entry.readState !== "present" || !entry.capabilities.inventory
        || inventory.sources.some(source => source.id === entry.sourceId && ["unreadable", "invalid", "unsupported"].includes(source.readState)));
      const unavailable = !history || history.unscopedUnavailableGaps || sourceUnavailable
        || entries.some(entry => history.unavailableClients.includes(entry.client));
      const partial = unavailable || Boolean(missingTimeEvents) || usageUnassociated || Boolean(history?.unscopedGaps)
        || entries.some(entry => history?.uncertainClients.includes(entry.client) || !entry.capabilities.associate
          || inventory.gaps.some(gap => gap.sourceId === entry.sourceId));
      const unknown = unavailable || usageUnassociated || Boolean((query.from || query.to) && missingTimeEvents);
      const observation = usage?.stats.events || !unknown ? "recorded" : "unknown";
      const candidates: ResourceLocalRow["candidates"] = [];
      if (favorite) candidates.push("favorite");
      if (entries.some(entry => entry.readState === "broken")) candidates.push("broken");
      if (body.contentFingerprint && (fingerprints.get(body.contentFingerprint)?.size ?? 0) > 1) candidates.push("duplicate");
      if (observation === "recorded" && !usage?.stats.events) candidates.push("unused");
      const thresholdMatches = resourceUsageThresholdMatches(usage?.stats, query, now);
      if (thresholdMatches.low) candidates.push("low");
      if (usage?.stats.events && thresholdMatches.old) candidates.push("old");
      const protectedByConfiguration = entries.some(entry => entry.protected);
      const protectedEntry = favorite || protectedByConfiguration;
      if (query.candidate && query.candidate !== "all" && query.candidate !== "review" && !candidates.includes(query.candidate)) continue;
      rows.push({ body, entries, favorite, favoriteIds: rowFavoriteIds, protectedByConfiguration, firstSeenAt, usage: observation === "recorded" ? usage?.stats ?? emptyResourceUsageStats() : null,
        historyIds: usage?.historyIds ?? [], observation, candidates, protected: protectedEntry, partial, usageUnassociated, missingTimeEvents });
    }
    const sort = query.sort ?? "sessions";
    const direction = (query.order ?? (sort === "name" ? "asc" : "desc")) === "asc" ? 1 : -1;
    const metric = (row: ResourceLocalRow): number | null => {
      if (!row.usage) return null;
      if (sort === "recent") return row.usage.lastUsedAt ? Date.parse(row.usage.lastUsedAt) : null;
      return sort === "uses" ? row.usage.events : sort === "calls" ? row.usage.explicitCalls + row.usage.mcpCalls : sort === "reads" ? row.usage.successfulReads : row.usage.sessions;
    };
    rows.sort((a, b) => {
      if (sort === "name") return direction * a.body.name.localeCompare(b.body.name) || a.body.id.localeCompare(b.body.id);
      const left = metric(a), right = metric(b);
      return (left === null ? right === null ? 0 : 1 : right === null ? -1 : direction * (left - right))
        || a.body.name.localeCompare(b.body.name) || a.body.id.localeCompare(b.body.id);
    });
    return { rows, inventory, history, partial: inventory.gaps.some(gap => inventory.sources.some(source => source.id === gap.sourceId
      && (!query.kind || source.kind === query.kind) && (!query.client || source.client === query.client))) || !history || history.partial
      || rows.some(row => row.partial) };
  }
  async local(query: ResourceLocalQuery): Promise<ResourceLocalResult> {
    const { rows, inventory, partial } = await this.localRows(query);
    const page = query.page ?? 1, pageSize = query.pageSize ?? 30;
    return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize,
      observedAt: inventory.observedAt, partial, thresholds: { lowSessions: query.lowSessions ?? 2, inactiveDays: query.inactiveDays ?? 90 } };
  }
  async localDetail(id: string, query: ResourceLocalQuery): Promise<ResourceLocalDetail> {
    const { rows, inventory, history } = await this.localRows({ ...query, q: undefined, candidate: "all" });
    const row = rows.find(row => row.body.id === id);
    if (!row) throw new ServiceError("SOURCE_NOT_FOUND", "本地资源不在所选范围中", { key: "diagnostics.resources.service.m001" });
    const usage = history?.bodies.get(row.body.id);
    return { row, inventory: { observedAt: inventory.observedAt, sources: inventory.sources.filter(source => row.entries.some(entry => entry.sourceId === source.id)), gaps: inventory.gaps, diagnostics: inventory.diagnostics?.filter(diagnostic => row.entries.some(entry => entry.id === diagnostic.selectedEntryId || entry.sourceId === diagnostic.sourceId)) },
      timeZone: history?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, trend: usage?.trend ?? [], clients: usage?.clients ?? [], projects: usage?.projects ?? [] };
  }
  async addSource(source: ResourceManualSource) { this.manager.addManualSource(source); return this.refresh(); }
  async removeSource(id: string) { this.manager.removeManualSource(id); return this.refresh(); }
  private async managementInventory() {
    const scanned = await this.scan();
    const favorites = new Set(this.manager.favorites());
    const snapshot = { ...scanned, entries: scanned.entries.map(entry => ({ ...entry,
      favorite: "favorite" in entry && entry.favorite === true || favorites.has(resourceOverviewIdentity({ id: entry.id, kind: entry.kind, name: entry.name, client: entry.client }).id) })) };
    if (![...favorites].some(id => id.startsWith("resource:"))) return snapshot;
    try {
      const history = localResourceUsage(this.library, {}, snapshot.entries);
      return { ...snapshot, entries: snapshot.entries.map(entry => ({ ...entry,
        favorite: "favorite" in entry && entry.favorite === true || favorites.has(resourceOverviewIdentity({ id: entry.id, kind: entry.kind, name: entry.name, client: entry.client }).id)
          || (history.bodies.get(entry.bodyId)?.favoriteIds.some(id => favorites.has(id)) ?? false) })) };
    } catch (error) {
      if (!(error instanceof StoreError) || error.code !== "ANALYSIS_NOT_READY") throw error;
      return snapshot;
    }
  }
  async preview(input: Parameters<ResourceManager["preview"]>[0]) { return this.manager.preview(input, await this.managementInventory()); }
  async apply(id: string, confirmed: true) {
    const result = await this.manager.apply(id, confirmed, await this.managementInventory());
    await this.scan();
    return result;
  }
}
