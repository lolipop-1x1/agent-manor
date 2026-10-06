import type { SessionStore } from "../sessions/store.js";
import type { ResourceInventoryOptions, ResourceInventorySnapshot, ResourceManualSource } from "../resource-inventory-contracts.js";
import type { ResourceLocalDetail, ResourceLocalQuery, ResourceLocalResult, ResourceLocalRow, ResourceStatus } from "../resource-service-contracts.js";
import type { ResourceUsageQuery } from "../resource-contracts.js";
import { ServiceError } from "../service/input.js";
import { StoreError } from "../index/store.js";
import { scanResourceInventory } from "./inventory.js";
import { emptyResourceUsageStats, listResourceUsage, localResourceUsage, resourceUsageDetail, resourceUsageEvidence } from "./usage.js";
import { ResourceManager } from "./management.js";

/** 共用服务边界：派生盘点可刷新，收藏和恢复材料由独立管理库保留。 */
export class ResourceService {
  private snapshot?: ResourceInventorySnapshot;
  private pending?: Promise<ResourceInventorySnapshot>;
  constructor(readonly library: SessionStore, readonly manager: ResourceManager,
    private readonly inventoryOptions: ResourceInventoryOptions, private readonly projects: () => string[]) {}

  private inventory(): Promise<ResourceInventorySnapshot> {
    return this.snapshot ? Promise.resolve(this.manager.decorateInventory(this.snapshot)) : this.scan();
  }
  private scan(): Promise<ResourceInventorySnapshot> {
    if (!this.pending) this.pending = (async () => {
      const snapshot = await scanResourceInventory({ ...this.inventoryOptions, projects: this.projects(), manualSources: this.manager.manualSources() });
      this.manager.observeInventory(snapshot);
      this.snapshot = snapshot;
      return this.manager.decorateInventory(snapshot);
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async status(): Promise<ResourceStatus> {
    const inventory = await this.inventory();
    return { observedAt: inventory.observedAt, sources: inventory.sources, gaps: inventory.gaps,
      projects: this.projects(), favoriteIds: this.manager.favorites(), manualSources: this.manager.manualSources() };
  }
  async refresh(): Promise<ResourceStatus> { await this.scan(); return this.status(); }
  async usage(query: ResourceUsageQuery) {
    return { ...listResourceUsage(this.library, query, (await this.inventory()).entries, new Set(this.manager.favorites())), favoriteIds: this.manager.favorites() };
  }
  async usageDetail(id: string, query: ResourceUsageQuery) {
    return { ...resourceUsageDetail(this.library, id, query, (await this.inventory()).entries), favoriteIds: this.manager.favorites() };
  }
  evidence(id: string, query: Parameters<typeof resourceUsageEvidence>[2]) { return resourceUsageEvidence(this.library, id, query); }

  private async localRows(query: ResourceLocalQuery): Promise<{ rows: ResourceLocalRow[]; inventory: ResourceInventorySnapshot; partial: boolean; history?: ReturnType<typeof localResourceUsage> }> {
    const inventory = await this.inventory();
    let history: ReturnType<typeof localResourceUsage> | undefined;
    try { history = localResourceUsage(this.library, query, inventory.entries); }
    catch (error) { if (!(error instanceof StoreError) || error.code !== "ANALYSIS_NOT_READY") throw error; }
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
        (!query.client || entry.client === query.client) && (!query.project || (query.project === "none" ? !entry.project : entry.project === query.project)));
      if (!entries.length) continue;
      const q = query.q?.trim().toLocaleLowerCase();
      if (q && ![body.name, body.targetPath, ...entries.map(entry => entry.entryPath)].some(value => value?.toLocaleLowerCase().includes(q))) continue;
      const firstSeenAt = entries.map(entry => (entry as typeof entry & { firstSeenAt?: string }).firstSeenAt ?? entry.observedAt).sort()[0]!;
      const usage = history?.bodies.get(body.id);
      const favorite = favoriteIds.has(body.id) || entries.some(entry => favoriteIds.has(entry.id)) || (usage?.historyIds.some(id => favoriteIds.has(id)) ?? false);
      const uncertain = !history || history.partial || Boolean((query.from || query.to) && usage?.stats.missingTimeEvents) || entries.some(entry => !history.clients.includes(entry.client)
        || history.uncertain.has(JSON.stringify([entry.kind, entry.client, entry.name])));
      const observation = usage?.stats.events ? "recorded" : uncertain ? "unknown" : now - Date.parse(firstSeenAt) < 7 * 86400_000 ? "insufficient" : "recorded";
      const candidates: ResourceLocalRow["candidates"] = [];
      if (favorite) candidates.push("favorite");
      if (entries.some(entry => entry.readState === "broken")) candidates.push("broken");
      if (body.contentFingerprint && (fingerprints.get(body.contentFingerprint)?.size ?? 0) > 1) candidates.push("duplicate");
      if (observation !== "recorded") candidates.push("review");
      else if (!usage?.stats.events) candidates.push("unused");
      if (!uncertain && usage?.stats.sessions && usage.stats.sessions <= (query.lowSessions ?? 2)) candidates.push("low");
      if (!uncertain && usage?.stats.lastUsedAt && now - Date.parse(usage.stats.lastUsedAt) >= (query.inactiveDays ?? 90) * 86400_000) candidates.push("old");
      const protectedEntry = favorite || entries.some(entry => entry.protected);
      // 保护资源保留手动查看入口，不因低使用率成为自动整理候选。
      if (query.candidate && query.candidate !== "all" && (!candidates.includes(query.candidate)
        || protectedEntry && ["unused", "low", "old"].includes(query.candidate))) continue;
      rows.push({ body, entries, favorite, firstSeenAt, usage: usage?.stats ?? (observation === "recorded" ? emptyResourceUsageStats() : null), historyIds: usage?.historyIds ?? [], observation, candidates, protected: protectedEntry });
    }
    const metric = (row: ResourceLocalRow) => query.sort === "calls" ? (row.usage?.explicitCalls ?? 0) + (row.usage?.mcpCalls ?? 0)
      : query.sort === "reads" ? row.usage?.successfulReads ?? 0 : row.usage?.sessions ?? 0;
    rows.sort((a, b) => (query.sort === "recent" ? Date.parse(b.usage?.lastUsedAt ?? "") - Date.parse(a.usage?.lastUsedAt ?? "")
      : query.sort === "name" ? 0 : metric(b) - metric(a)) || a.body.name.localeCompare(b.body.name) || a.body.id.localeCompare(b.body.id));
    return { rows, inventory, history, partial: inventory.gaps.length > 0 || !history || history.partial };
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
    if (!row) throw new ServiceError("SOURCE_NOT_FOUND", "本地资源不在所选范围中");
    const usage = history?.bodies.get(row.body.id);
    return { row, inventory: { observedAt: inventory.observedAt, sources: inventory.sources.filter(source => row.entries.some(entry => entry.sourceId === source.id)), gaps: inventory.gaps },
      timeZone: history?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, trend: usage?.trend ?? [], clients: usage?.clients ?? [], projects: usage?.projects ?? [] };
  }
  async addSource(source: ResourceManualSource) { this.manager.addManualSource(source); return this.refresh(); }
  async removeSource(id: string) { this.manager.removeManualSource(id); return this.refresh(); }
  private async managementInventory() {
    const snapshot = await this.scan();
    const favorites = new Set(this.manager.favorites());
    if (![...favorites].some(id => id.startsWith("resource:"))) return snapshot;
    try {
      const history = localResourceUsage(this.library, {}, snapshot.entries);
      return { ...snapshot, entries: snapshot.entries.map(entry => ({ ...entry,
        favorite: "favorite" in entry && entry.favorite === true || (history.bodies.get(entry.bodyId)?.historyIds.some(id => favorites.has(id)) ?? false) })) };
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
