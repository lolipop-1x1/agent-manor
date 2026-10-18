import { Worker } from "node:worker_threads";
import type { ApiErrorCode } from "../contracts.js";
import type { MessageDescriptor } from "../i18n/types.js";
import { StoreError, type AnalysisStore } from "../index/store.js";
import type { MapOperation, MapQuery, MapQueryService } from "./query-service.js";

export type MapWorkerResult = Awaited<ReturnType<MapQueryService["execute"]>>;
export interface MapWorkerRequest { id: number; type: MapOperation; query: MapQuery & { version: string } }
export type MapWorkerResponse = { id: number; result: MapWorkerResult } | {
  id: number; error: { code: ApiErrorCode; message: string; messageDescriptor?: MessageDescriptor };
};
interface Subscriber { resolve(result: MapWorkerResult): void; reject(error: Error): void; dispose(): void }
interface Job extends MapWorkerRequest { key: string; subscribers: Set<Subscriber> }
const aborted = () => new DOMException("Map query cancelled", "AbortError");
const stopped = () => new StoreError("INTERNAL_ERROR", "地图查询后台已停止", { key: "codeMap.error.queryStopped" });
const internalError = (error: unknown) => error instanceof StoreError ? error
  : new StoreError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error), { key: "diagnostics.server.m003" });

/** HTTP 主线程只固定版本与管理订阅；大分块读取和覆盖计算在独立查询线程执行。 */
export class MapQueryManager {
  private worker?: Worker;
  private active?: Job;
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private nextId = 0;
  private closed = false;

  constructor(private readonly analysis: AnalysisStore, private readonly maxQueued = 16) {}

  execute(type: MapOperation, query: MapQuery, signal?: AbortSignal): Promise<MapWorkerResult> {
    if (this.closed) return Promise.reject(stopped());
    if (signal?.aborted) return Promise.reject(aborted());
    let fixed: MapWorkerRequest["query"];
    try { fixed = { ...query, version: this.analysis.analysisVersion(query.repositoryId, query.version) }; }
    catch (error) { return Promise.reject(error); }
    const key = JSON.stringify([type, Object.entries({ ...fixed, summary: fixed.summary ?? false })
      .filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))]);
    let job = this.jobs.get(key);
    if (!job) {
      if (this.active && this.queue.length >= this.maxQueued) return Promise.reject(new StoreError("ANALYSIS_NOT_READY", "地图查询队列已满，请稍后重试", { key: "codeMap.error.queryBusy" }));
      job = { id: ++this.nextId, type, query: fixed, key, subscribers: new Set() };
      this.jobs.set(key, job); this.queue.push(job);
    }
    const current = job;
    const result = new Promise<MapWorkerResult>((resolve, reject) => {
      const cancel = () => {
        subscriber.dispose(); current.subscribers.delete(subscriber); reject(aborted());
        // 同步 SQLite 无法中断；活动作业继续完成，供随后同条件订阅复用。
        if (current.subscribers.size || this.active === current) return;
        if (this.jobs.get(key) === current) this.jobs.delete(key);
        const index = this.queue.indexOf(current);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const subscriber: Subscriber = { resolve, reject, dispose: () => signal?.removeEventListener("abort", cancel) };
      current.subscribers.add(subscriber);
      signal?.addEventListener("abort", cancel, { once: true });
    });
    this.dispatch();
    return result;
  }

  private dispatch(): void {
    if (this.closed || this.active || !this.queue.length) return;
    this.active = this.queue.shift()!;
    try {
      this.worker ??= this.createWorker();
      const { id, type, query } = this.active;
      this.worker.postMessage({ id, type, query } satisfies MapWorkerRequest);
    } catch (error) { this.failed(internalError(error)); }
  }

  private createWorker(): Worker {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const url = new URL(`./query-worker.${extension}`, import.meta.url);
    const workerData = { dbPath: this.analysis.dbPath };
    const worker = extension === "ts"
      ? new Worker(`import('tsx/esm/api').then(({register}) => { register(); return import(${JSON.stringify(url.href)}); });`, { eval: true, workerData })
      : new Worker(url, { workerData });
    this.observe(worker);
    return worker;
  }

  private observe(worker: Worker): void {
    worker.on("message", (message: MapWorkerResponse) => {
      if (this.worker !== worker || message.id !== this.active?.id) return;
      const job = this.active; this.active = undefined;
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      for (const subscriber of job.subscribers) {
        subscriber.dispose();
        if ("error" in message) subscriber.reject(new StoreError(message.error.code, message.error.message, message.error.messageDescriptor));
        else subscriber.resolve(message.result);
      }
      this.dispatch();
    });
    worker.on("error", error => { if (this.worker === worker) this.failed(internalError(error)); });
    worker.on("exit", () => { if (this.worker === worker && !this.closed) this.failed(stopped()); });
  }

  private failed(error: Error): void {
    const previous = this.worker; this.worker = undefined;
    if (previous) void previous.terminate();
    if (this.active) {
      const job = this.active; this.active = undefined;
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      for (const subscriber of job.subscribers) { subscriber.dispose(); subscriber.reject(error); }
    }
    this.dispatch();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.queue, ...(this.active ? [this.active] : [])]) {
      for (const subscriber of job.subscribers) { subscriber.dispose(); subscriber.reject(stopped()); }
    }
    this.queue.length = 0; this.jobs.clear(); this.active = undefined;
    const worker = this.worker; this.worker = undefined;
    if (worker) await worker.terminate();
  }
}
