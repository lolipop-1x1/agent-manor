import { Worker } from "node:worker_threads";
import type { Job } from "../contracts.js";
import type { DiscoverRoots } from "../history/index.js";
import { AnalysisStore } from "./store.js";
import { SessionStore } from "../sessions/store.js";
import type { SessionJob, SessionRefreshOptions } from "../session-contracts.js";

export interface WorkerManagerOptions {
  roots?: DiscoverRoots;
  workerUrl?: URL;
}

/** 一个长期 Worker 串行分析全部仓库，主线程只登记任务和查询完整版本。 */
export class WorkerManager {
  private worker: Worker;
  private readonly pending = new Map<string, ((job: Job) => void)[]>();
  private readonly active = new Set<string>();
  private readonly sessionActive = new Set<string>();
  private readonly sessionRequests = new Map<string, string>();
  private closed = false;
  private failure?: string;

  constructor(private readonly store: AnalysisStore, private readonly options: WorkerManagerOptions = {}, private readonly sessions?: SessionStore) {
    store.recoverJobs();
    sessions?.recoverJobs();
    this.worker = this.createWorker();
  }

  private createWorker(): Worker {
    const { store, options } = this;
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const workerUrl = options.workerUrl ?? new URL(`../worker.${extension}`, import.meta.url);
    // tsx 的源码入口需要在 Worker 自己的隔离环境中安装 ESM 解析钩子。
    const worker = extension === "ts" && !options.workerUrl
      ? new Worker(`import('tsx/esm/api').then(({register}) => { register(); return import(${JSON.stringify(workerUrl.href)}); });`, { eval: true, workerData: { dbPath: store.dbPath, roots: options.roots } })
      : new Worker(workerUrl, { workerData: { dbPath: store.dbPath, roots: options.roots } });
    worker.on("message", (message: { jobId?: string }) => {
      if (this.worker === worker && message.jobId) this.finished(message.jobId);
    });
    worker.on("error", (error) => { if (this.worker === worker && !this.closed) this.failed(error.message); });
    worker.on("exit", (code) => {
      if (this.worker === worker && !this.closed) this.failed(`分析 Worker 意外停止（${code}）`);
    });
    return worker;
  }

  private enqueue(repositoryId: string, clearCache: boolean): Job {
    if (this.closed) throw new Error("分析 Worker 已关闭");
    if (this.failure) {
      // 失败任务保持失败；仅在下一次明确刷新时重建，避免自动重试同一溢出任务。
      this.worker = this.createWorker();
      this.failure = undefined;
    }
    const job = this.store.createJob(repositoryId);
    this.active.add(job.id);
    this.worker.postMessage({ type: "refresh", jobId: job.id, clearCache });
    return job;
  }

  refresh(repositoryId: string): Job { return this.enqueue(repositoryId, false); }
  clearCache(repositoryId: string): Job { return this.enqueue(repositoryId, true); }

  refreshSessions(clearCache = false, options: SessionRefreshOptions = {}): SessionJob {
    if (this.closed || !this.sessions) throw new Error("会话索引 Worker 不可用");
    const request: SessionRefreshOptions = clearCache ? { mode: "full" } : { client: options.client, mode: options.mode ?? "quick" };
    const key = JSON.stringify([clearCache, request.client ?? null, request.mode]);
    if (!clearCache) {
      for (const id of this.sessionActive) if (this.sessionRequests.get(id) === key) return this.sessions.getJob(id);
    }
    if (this.failure) { this.worker = this.createWorker(); this.failure = undefined; }
    const job = this.sessions.createJob(request);
    this.sessionActive.add(job.id);
    this.sessionRequests.set(job.id, key);
    this.worker.postMessage({ type: "sessions", jobId: job.id, clearCache });
    return job;
  }

  waitForJob(jobId: string): Promise<Job> {
    const job = this.store.getJob(jobId);
    if (job.status === "completed" || job.status === "failed") return Promise.resolve(job);
    return new Promise((resolve) => {
      this.pending.set(jobId, [...(this.pending.get(jobId) ?? []), resolve]);
    });
  }

  private finished(jobId: string): void {
    if (this.sessionActive.delete(jobId)) { this.sessionRequests.delete(jobId); return; }
    this.active.delete(jobId);
    const job = this.store.getJob(jobId);
    for (const resolve of this.pending.get(jobId) ?? []) resolve(job);
    this.pending.delete(jobId);
  }

  private failed(error: string): void {
    this.failure = error;
    for (const id of [...this.sessionActive]) {
      const job = this.sessions!.getJob(id);
      if (job.status !== "complete" && job.status !== "failed") this.sessions!.failJob(id, error);
      this.sessionActive.delete(id);
      this.sessionRequests.delete(id);
    }
    for (const id of [...this.active]) {
      const job = this.store.getJob(id);
      if (job.status !== "completed" && job.status !== "failed") this.store.failJob(id, error);
      this.finished(id);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.worker.terminate();
    this.failed("后台停止时刷新尚未完成");
  }
}
