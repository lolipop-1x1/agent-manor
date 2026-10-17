import type { ResourceInventoryEntry } from "../resource-inventory-contracts.js";
import type { ResourceUsageQuery, ResourceUsageIdentity, ResourceUsageDetail, ResourceUsageDetailSummary, ResourceUsageEvidenceQuery, ResourceUsageEvidenceResult, ResourceEventStream, ResourceUsageEvent } from "../resource-contracts.js";
import type { SessionStore } from "../sessions/store.js";
import { UsageResultCache } from "../usage/cache.js";
import { collectResourceUsage, projectResourceUsage, resourceUsageDetail, resourceUsageEvidence, findResourceUsageIdentity } from "./usage.js";

export interface ResourceHistoryReader {
  overview(query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[]): Promise<ReturnType<typeof projectResourceUsage>>;
  detail(id: string, query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[], identity?: ResourceUsageIdentity): Promise<ResourceUsageDetail>;
  summary(id: string, query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[], identity?: ResourceUsageIdentity): Promise<ResourceUsageDetailSummary>;
  evidence(id: string, query: ResourceUsageEvidenceQuery, identity?: ResourceUsageIdentity): Promise<ResourceUsageEvidenceResult>;
}

export function summarizeUsageDetail(detail: ResourceUsageDetail): ResourceUsageDetailSummary {
  const { gaps, ...coverage } = detail.coverage;
  return { ...detail, coverage: { ...coverage, gapCount: gaps.length } };
}

/** 缓存只依赖完整历史版本与统计范围，盘点变化仅重新投影本地关联。 */
export class ResourceUsageCache implements ResourceHistoryReader {
  private readonly cache = new Map<string, ReturnType<typeof collectResourceUsage>>();
  private version?: string;
  // 仅缓存无正文的查询元数据；总预算 64 MiB，单范围至多 32 MiB。
  private readonly streams = new UsageResultCache<ResourceEventStream>(64 * 1024 * 1024, 4);
  constructor(private readonly sessions: SessionStore) {}

  async overview(query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[]) {
    return this.read(query, entries);
  }
  private events(query: ResourceUsageQuery, identity?: ResourceUsageIdentity): ResourceEventStream | undefined {
    const version = this.useVersion(query);
    const scope = { version, kind: query.kind ?? identity?.kind, client: query.client ?? identity?.client,
      project: query.project ?? identity?.project ?? (identity?.client ? "none" : undefined) };
    const key = JSON.stringify(scope), cached = this.streams.get(key);
    if (cached) return cached;
    const { events: source, ...context } = this.sessions.resourceEvents(scope);
    const events: ResourceUsageEvent[] = [];
    let bytes = JSON.stringify(context).length * 2 + 512;
    for (const event of source) {
      bytes += JSON.stringify(event).length * 2 + 512;
      if (bytes > 32 * 1024 * 1024) return undefined;
      events.push(event);
    }
    if (bytes > 32 * 1024 * 1024) return undefined;
    const stream = { ...context, events };
    this.streams.set(key, stream, bytes);
    return stream;
  }
  private useVersion(query: ResourceUsageQuery): string {
    const version = this.sessions.usageVersion(query.version);
    if (this.version !== version) { this.cache.clear(); this.streams.clear(); this.version = version; }
    return version;
  }
  read(query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[]) {
    const version = this.useVersion(query);
    const scope = { kind: query.kind, client: query.client, project: query.project, from: query.from, to: query.to, version };
    const key = JSON.stringify(scope);
    let aggregate = this.cache.get(key);
    if (!aggregate) { aggregate = collectResourceUsage(this.sessions, scope, this.events(scope)); this.cache.set(key, aggregate); }
    this.cache.delete(key); this.cache.set(key, aggregate);
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
    return projectResourceUsage(aggregate, scope, entries, new Set());
  }
  private target(id: string, query: ResourceUsageQuery, identity?: ResourceUsageIdentity) {
    const resolved = identity?.id === id ? identity : findResourceUsageIdentity(this.sessions, id, query, this.events(query));
    // 旧来源身份的无项目范围不能被显式项目覆盖，冲突时保留原查询的交集语义。
    if (resolved.client && resolved.project === undefined && query.project && query.project !== "none") return { identity: resolved, stream: undefined };
    return { identity: resolved, stream: this.events(query, resolved) };
  }
  detailNow(id: string, query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[], identity?: ResourceUsageIdentity) {
    const target = this.target(id, query, identity);
    return resourceUsageDetail(this.sessions, id, query, entries, new Set(), target.identity, target.stream);
  }
  async detail(id: string, query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[], identity?: ResourceUsageIdentity) {
    return this.detailNow(id, query, entries, identity);
  }
  async summary(id: string, query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[], identity?: ResourceUsageIdentity) {
    return summarizeUsageDetail(this.detailNow(id, query, entries, identity));
  }
  evidenceNow(id: string, query: ResourceUsageEvidenceQuery, identity?: ResourceUsageIdentity) {
    const target = this.target(id, query, identity);
    return resourceUsageEvidence(this.sessions, id, query, target.identity, target.stream);
  }
  async evidence(id: string, query: ResourceUsageEvidenceQuery, identity?: ResourceUsageIdentity) {
    return this.evidenceNow(id, query, identity);
  }
}
