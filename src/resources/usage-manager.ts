import { Worker } from "node:worker_threads";
import type { ApiErrorCode } from "../contracts.js";
import type { MessageDescriptor } from "../i18n/types.js";
import { StoreError } from "../index/store.js";
import type { ResourceInventoryEntry } from "../resource-inventory-contracts.js";
import type { ResourceUsageQuery, ResourceUsageIdentity, ResourceUsageDetail, ResourceUsageDetailSummary, ResourceUsageEvidenceQuery, ResourceUsageEvidenceResult } from "../resource-contracts.js";
import type { SessionStore } from "../sessions/store.js";
import type { ResourceHistoryReader } from "./usage-cache.js";

type Overview = Awaited<ReturnType<ResourceHistoryReader["overview"]>>;
interface Results { overview: Overview; detail: ResourceUsageDetail; summary: ResourceUsageDetailSummary; evidence: ResourceUsageEvidenceResult }
type Result = Results[keyof Results];
export interface ResourceHistoryRequest { id: number; operation: keyof Results; resourceId?: string; identity?: ResourceUsageIdentity; query: ResourceUsageEvidenceQuery; entries: readonly ResourceInventoryEntry[] }
export type ResourceHistoryResponse = { id: number; result: Result } | {
  id: number; error: { code: ApiErrorCode; message: string; messageDescriptor?: MessageDescriptor };
};
interface Job { id: number; key: string; promise: Promise<Result>; resolve(value: Result): void; reject(error: Error): void }

/** 资源历史通过独立只读连接计算，缓存未命中也不占用 HTTP 主线程。 */
export class ResourceUsageManager implements ResourceHistoryReader {
  private worker?: Worker;
  private readonly jobs = new Map<number, Job>();
  private readonly pending = new Map<string, Job>();
  private readonly generations = new WeakMap<readonly ResourceInventoryEntry[], number>();
  private generation = 0;
  private nextId = 0;
  private closed = false;
  constructor(private readonly sessions: SessionStore) {}

  overview(query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[]): Promise<Overview> {
    return this.request("overview", query, entries);
  }
  detail(id: string, query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[], identity?: ResourceUsageIdentity) {
    return this.request("detail", query, entries, id, identity);
  }
  summary(id: string, query: ResourceUsageQuery, entries: readonly ResourceInventoryEntry[], identity?: ResourceUsageIdentity) {
    return this.request("summary", query, entries, id, identity);
  }
  evidence(id: string, query: ResourceUsageEvidenceQuery, identity?: ResourceUsageIdentity) {
    return this.request("evidence", query, [], id, identity);
  }
  private request<K extends keyof Results>(operation: K, query: ResourceUsageEvidenceQuery, entries: readonly ResourceInventoryEntry[], resourceId?: string, identity?: ResourceUsageIdentity): Promise<Results[K]> {
    if (this.closed) return Promise.reject(this.stopped());
    const fixed = { ...query, version: this.sessions.usageVersion(query.version) };
    if (!this.generations.has(entries)) this.generations.set(entries, ++this.generation);
    const key = JSON.stringify([operation, resourceId, identity, fixed, operation === "evidence" ? 0 : this.generations.get(entries)]);
    const previous = this.pending.get(key);
    if (previous) return previous.promise as Promise<Results[K]>;
    if (this.jobs.size >= 16) return Promise.reject(new StoreError("ANALYSIS_NOT_READY", "资源统计队列已满，请稍后重试", { key: "diagnostics.resources.history.busy" }));
    let resolve!: Job["resolve"], reject!: Job["reject"];
    const promise = new Promise<Result>((success, failure) => { resolve = success; reject = failure; });
    const job: Job = { id: ++this.nextId, key, promise, resolve, reject };
    this.jobs.set(job.id, job); this.pending.set(key, job);
    try { this.worker ??= this.createWorker(); this.worker.postMessage({ id: job.id, operation, resourceId, identity, query: fixed, entries } satisfies ResourceHistoryRequest); }
    catch (error) { this.failed(error instanceof Error ? error : new Error(String(error))); }
    return promise as Promise<Results[K]>;
  }

  private stopped() { return new StoreError("INTERNAL_ERROR", "资源统计后台已停止", { key: "diagnostics.resources.history.stopped" }); }
  private createWorker(): Worker {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const url = new URL(`./usage-worker.${extension}`, import.meta.url);
    const workerData = { dbPath: this.sessions.dbPath };
    const worker = extension === "ts"
      ? new Worker(`import('tsx/esm/api').then(({register}) => { register(); return import(${JSON.stringify(url.href)}); });`, { eval: true, workerData })
      : new Worker(url, { workerData });
    worker.on("message", (message: ResourceHistoryResponse) => {
      if (this.worker !== worker) return;
      const job = this.jobs.get(message.id); if (!job) return;
      this.jobs.delete(job.id); this.pending.delete(job.key);
      if ("error" in message) job.reject(new StoreError(message.error.code, message.error.message, message.error.messageDescriptor));
      else job.resolve(message.result);
    });
    worker.on("error", error => { if (this.worker === worker) this.failed(error); });
    worker.on("exit", () => { if (this.worker === worker && !this.closed) this.failed(this.stopped()); });
    return worker;
  }
  private failed(error: Error): void {
    const worker = this.worker; this.worker = undefined;
    for (const job of this.jobs.values()) job.reject(error);
    this.jobs.clear(); this.pending.clear();
    if (worker) void worker.terminate();
  }
  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker; this.worker = undefined;
    for (const job of this.jobs.values()) job.reject(this.stopped());
    this.jobs.clear(); this.pending.clear();
    if (worker) await worker.terminate();
  }
}
