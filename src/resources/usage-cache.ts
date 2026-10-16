import type { ResourceInventoryEntry } from "../resource-inventory-contracts.js";
import type { ResourceUsageQuery } from "../resource-contracts.js";
import type { SessionStore } from "../sessions/store.js";
import { collectResourceUsage, projectResourceUsage } from "./usage.js";

export interface ResourceHistoryReader {
  overview(query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[]): Promise<ReturnType<typeof projectResourceUsage>>;
}

/** 缓存只依赖完整历史版本与统计范围，盘点变化仅重新投影本地关联。 */
export class ResourceUsageCache implements ResourceHistoryReader {
  private readonly cache = new Map<string, ReturnType<typeof collectResourceUsage>>();
  private version?: string;
  constructor(private readonly sessions: SessionStore) {}

  async overview(query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[]) {
    return this.read(query, entries);
  }
  read(query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[]) {
    const version = this.sessions.usageVersion(query.version);
    if (this.version !== version) { this.cache.clear(); this.version = version; }
    const scope = { kind: query.kind, client: query.client, project: query.project, from: query.from, to: query.to, version };
    const key = JSON.stringify(scope);
    let aggregate = this.cache.get(key);
    if (!aggregate) { aggregate = collectResourceUsage(this.sessions, scope); this.cache.set(key, aggregate); }
    this.cache.delete(key); this.cache.set(key, aggregate);
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
    return projectResourceUsage(aggregate, scope, entries, new Set());
  }
}
