import { Worker } from "node:worker_threads";
import type { ApiErrorCode } from "../contracts.js";
import type { MessageDescriptor } from "../i18n/types.js";
import { StoreError } from "../index/store.js";
import type { SessionQuery, SessionGroupedSearchResult, SessionSearchResult, SessionListResult } from "../session-contracts.js";
import type { SessionStore } from "./store.js";

export type SearchOperation = "groups" | "records" | "matches" | "list";
export type SearchResult = SessionGroupedSearchResult | SessionSearchResult | SessionListResult | { version: string; matches: boolean };
export interface SearchRequest {
  id: number; type: SearchOperation; query: SessionQuery & { sessionId?: string }; cancellation: Int32Array;
}
export type SearchResponse = { id: number; result: SearchResult } | {
  id: number; error: { code: ApiErrorCode; message: string; messageDescriptor?: MessageDescriptor };
};
interface Subscriber { resolve(result: SearchResult): void; reject(error: Error): void; dispose(): void }
interface Job extends SearchRequest { key: string; subscribers: Set<Subscriber> }
const aborted = () => new DOMException("Search cancelled", "AbortError");
const stopped = () => new StoreError("INTERNAL_ERROR", "搜索后台已停止", { key: "diagnostics.sessions.search.stopped" });

/** 主线程固定版本、合并同条件订阅；同步 SQLite 查询由单独的只读 Worker 执行。 */
export class SessionSearchManager {
  private worker?: Worker;
  private active?: Job;
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private nextId = 0;
  private closed = false;

  constructor(private readonly sessions: SessionStore, private readonly maxQueued = 16) {}

  execute(type: SearchOperation, query: SessionQuery & { sessionId?: string }, signal?: AbortSignal): Promise<SearchResult> {
    if (this.closed) return Promise.reject(stopped());
    if (signal?.aborted) return Promise.reject(aborted());
    let fixed: typeof query;
    try { fixed = { ...query, version: this.sessions.usageVersion(query.version) }; }
    catch (error) { return Promise.reject(error); }
    const key = JSON.stringify([type, Object.fromEntries(Object.entries(fixed).sort(([a], [b]) => a.localeCompare(b)))]);
    let job = this.jobs.get(key);
    if (!job) {
      if (this.active && this.queue.length >= this.maxQueued) return Promise.reject(new StoreError("ANALYSIS_NOT_READY", "搜索队列已满，请稍后重试", { key: "diagnostics.sessions.search.busy" }));
      job = { id: ++this.nextId, type, query: fixed, key, cancellation: new Int32Array(new SharedArrayBuffer(4)), subscribers: new Set() };
      this.jobs.set(key, job); this.queue.push(job);
    }
    const current = job;
    const result = new Promise<SearchResult>((resolve, reject) => {
      const cancel = () => {
        subscriber.dispose(); current.subscribers.delete(subscriber); reject(aborted());
        if (current.subscribers.size) return;
        Atomics.store(current.cancellation, 0, 1);
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
      const { id, type, query, cancellation } = this.active;
      this.worker.postMessage({ id, type, query, cancellation } satisfies SearchRequest);
    } catch (error) { this.failed(error instanceof Error ? error : new Error(String(error))); }
  }

  private createWorker(): Worker {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const url = new URL(`./search-worker.${extension}`, import.meta.url);
    const workerData = { dbPath: this.sessions.dbPath };
    const worker = extension === "ts"
      ? new Worker(`import('tsx/esm/api').then(({register}) => { register(); return import(${JSON.stringify(url.href)}); });`, { eval: true, workerData })
      : new Worker(url, { workerData });
    worker.on("message", (message: SearchResponse) => {
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
    worker.on("error", error => { if (this.worker === worker) this.failed(error); });
    worker.on("exit", () => { if (this.worker === worker && !this.closed) this.failed(stopped()); });
    return worker;
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
    const jobs = [...this.queue, ...(this.active ? [this.active] : [])];
    for (const job of jobs) {
      Atomics.store(job.cancellation, 0, 1);
      for (const subscriber of job.subscribers) { subscriber.dispose(); subscriber.reject(stopped()); }
    }
    this.queue.length = 0; this.jobs.clear(); this.active = undefined;
    const worker = this.worker; this.worker = undefined;
    if (worker) await worker.terminate();
  }
}
