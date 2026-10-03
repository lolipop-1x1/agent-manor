import { Worker } from "node:worker_threads";
import type { Job } from "../contracts.js";
import type { DiscoverRoots } from "../history/index.js";
import { AnalysisStore } from "./store.js";

export interface WorkerManagerOptions {
  roots?: DiscoverRoots;
  workerUrl?: URL;
}

/** 一个长期 Worker 串行分析全部仓库，主线程只登记任务和查询完整版本。 */
export class WorkerManager {
  private readonly worker: Worker;
  private readonly pending = new Map<string, ((job: Job) => void)[]>();
  private readonly active = new Set<string>();
  private closed = false;
  private failure?: string;

  constructor(private readonly store: AnalysisStore, options: WorkerManagerOptions = {}) {
    store.recoverJobs();
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const workerUrl = options.workerUrl ?? new URL(`../worker.${extension}`, import.meta.url);
    // tsx 的源码入口需要在 Worker 自己的隔离环境中安装 ESM 解析钩子。
    this.worker = extension === "ts" && !options.workerUrl
      ? new Worker(`import('tsx/esm/api').then(({register}) => { register(); return import(${JSON.stringify(workerUrl.href)}); });`, { eval: true, workerData: { dbPath: store.dbPath, roots: options.roots } })
      : new Worker(workerUrl, { workerData: { dbPath: store.dbPath, roots: options.roots } });
    this.worker.on("message", (message: { jobId?: string }) => {
      if (message.jobId) this.finished(message.jobId);
    });
    this.worker.on("error", (error) => this.failed(error.message));
    this.worker.on("exit", (code) => {
      if (!this.closed) this.failed(`分析 Worker 意外停止（${code}）`);
    });
  }

  private enqueue(repositoryId: string, clearCache: boolean): Job {
    if (this.closed) throw new Error("分析 Worker 已关闭");
    if (this.failure) throw new Error(this.failure);
    const job = this.store.createJob(repositoryId);
    this.active.add(job.id);
    this.worker.postMessage({ type: "refresh", jobId: job.id, clearCache });
    return job;
  }

  refresh(repositoryId: string): Job { return this.enqueue(repositoryId, false); }
  clearCache(repositoryId: string): Job { return this.enqueue(repositoryId, true); }

  waitForJob(jobId: string): Promise<Job> {
    const job = this.store.getJob(jobId);
    if (job.status === "completed" || job.status === "failed") return Promise.resolve(job);
    return new Promise((resolve) => {
      this.pending.set(jobId, [...(this.pending.get(jobId) ?? []), resolve]);
    });
  }

  private finished(jobId: string): void {
    this.active.delete(jobId);
    const job = this.store.getJob(jobId);
    for (const resolve of this.pending.get(jobId) ?? []) resolve(job);
    this.pending.delete(jobId);
  }

  private failed(error: string): void {
    this.failure = error;
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
