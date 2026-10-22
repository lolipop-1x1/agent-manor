import { releaseIndexWrite, withIndexWriteAsync } from "./write-gate.js";
import type { MessageDescriptor } from "../i18n/types.js";
import { DiagnosticError } from "../i18n/diagnostics.js";
import { Worker } from "node:worker_threads";
import type { IndexMaintenanceResult, Job } from "../contracts.js";
import type { DiscoverRoots } from "../history/index.js";
import { AnalysisStore } from "./store.js";
import { SessionStore } from "../sessions/store.js";
import type { SessionJob, SessionRefreshOptions } from "../session-contracts.js";

export interface WorkerManagerOptions {
  roots?: DiscoverRoots;
  workerUrl?: URL;
  sessionWorkerUrl?: URL;
  writeGate?: SharedArrayBuffer;
}

export interface SessionWorkerRequest extends SessionRefreshOptions { clearCache: boolean }

/** 完整校验覆盖快速检查；清缓存意图只能由同等清理覆盖。 */
export function sessionRequestCovers(existing: SessionWorkerRequest, requested: SessionWorkerRequest): boolean {
  return (!existing.client || existing.client === requested.client)
    && (!requested.clearCache || existing.clearCache)
    && ((existing.mode ?? "quick") === "full" || (requested.mode ?? "quick") === "quick");
}

/** 地图和会话各自串行执行，分别恢复失败，避免长任务跨域排队。 */
export class WorkerManager {
  private worker?: Worker;
  private workerReady?: Promise<void>;
  private sessionWorker?: Worker;
  private sessionWorkerReady?: Promise<void>;
  private sessionFailure?: string;
  private readonly pending = new Map<string, ((job: Job) => void)[]>();
  private readonly cancelled = new Map<string, Job>();
  private readonly active = new Set<string>();
  private readonly sessionActive = new Set<string>();
  private readonly sessionRequests = new Map<string, SessionWorkerRequest>();
  private readonly changeListeners = new Set<(jobs: SessionJob[]) => void>();
  private closed = false;
  private failure?: string;
  private readonly lastMapChecks = new Map<string, number>();
  private readonly pausedMapRepositories = new Set<string>();
  reclaimStatus?: IndexMaintenanceResult;

  constructor(private readonly store: AnalysisStore, private readonly options: WorkerManagerOptions = {}, private readonly sessions?: SessionStore) {
    store.recoverJobs();
    sessions?.recoverJobs();
    // 注入的自定义 Worker 可以在任务前完成控制握手；默认原生 Worker 按首次任务启动。
    if (options.workerUrl) this.worker = this.createWorker();
  }

  private createWorker(kind: "maps" | "sessions" = "maps"): Worker {
    const { store, options } = this;
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const customUrl = kind === "maps" ? options.workerUrl : options.sessionWorkerUrl;
    const workerUrl = customUrl ?? new URL(`../worker.${extension}`, import.meta.url);
    const workerData = { dbPath: store.dbPath, roots: options.roots, writeGate: options.writeGate, kind, lifecycleHandshake: !customUrl };
    // tsx 的源码入口需要在 Worker 自己的隔离环境中安装 ESM 解析钩子。
    const worker = extension === "ts" && !customUrl
      ? new Worker(`import('tsx/esm/api').then(({register}) => { register(); return import(${JSON.stringify(workerUrl.href)}); });`, { eval: true, workerData })
      : new Worker(workerUrl, { workerData });
    if (!customUrl) {
      const readyPromise = new Promise<void>(resolve => {
        const ready = () => { worker.removeListener("message", message); resolve(); };
        const message = (value: { ready?: boolean }) => { if (value.ready) ready(); };
        worker.on("message", message);
        worker.once("error", ready); worker.once("exit", ready);
      });
      if (kind === "maps") this.workerReady = readyPromise;
      else this.sessionWorkerReady = readyPromise;
    }
    const workerOwner = worker.threadId + 1;
    const current = () => (kind === "maps" ? this.worker : this.sessionWorker) === worker;
    worker.on("message", (message: { jobId?: string; reclaim?: IndexMaintenanceResult }) => {
      if (!current()) return;
      if (message.reclaim) { this.reclaimStatus = message.reclaim; this.changed(); }
      if (message.jobId) this.finished(message.jobId);
    });
    const fail = (error: string, descriptor?: MessageDescriptor) => {
      if (!current() || this.closed || (kind === "maps" ? this.failure : this.sessionFailure)) return;
      void this.failed(kind, error, descriptor);
    };
    let error: Error | undefined;
    worker.on("error", failure => { error = failure; });
    worker.on("exit", code => {
      releaseIndexWrite(options.writeGate, workerOwner);
      fail(error?.message ?? `分析 Worker 意外停止（${code}）`, error ? undefined : { key: "diagnostics.index.workerManager.unexpectedExit", params: { code } });
    });
    return worker;
  }

  private enqueue(repositoryId: string, clearCache: boolean): Job {
    if (this.closed) throw new DiagnosticError("分析 Worker 已关闭", { key: "diagnostics.index.workerManager.m001" });
    if (!this.worker || this.failure) {
      // 失败任务保持失败；仅在下一次明确刷新时重建，避免自动重试同一溢出任务。
      this.worker = this.createWorker();
      this.failure = undefined;
    }
    const job = this.store.createJob(repositoryId);
    this.active.add(job.id);
    this.worker.postMessage({ type: "refresh", jobId: job.id, clearCache });
    this.changed();
    return job;
  }

  refresh(repositoryId: string): Job {
    this.lastMapChecks.set(repositoryId, Date.now());
    return this.enqueue(repositoryId, false);
  }
  clearCache(repositoryId: string): Job { return this.enqueue(repositoryId, true); }

  deleteRepository(repositoryId: string): void {
    // 清理失败时不撤销任务；事务成功后旧任务结果只保留给内存等待者。
    const jobs = this.store.deleteRepository(repositoryId);
    const jobIds: string[] = [];
    for (const job of jobs) {
      // 已发布但完成消息还未抵达的任务，也必须收束已有等待者。
      if (job.status !== "queued" && job.status !== "running" && !this.active.has(job.id) && !this.pending.has(job.id)) continue;
      jobIds.push(job.id);
      const cancelled: Job = { ...job, status: "cancelled", phase: "仓库分析已取消", phaseDescriptor: { key: "diagnostics.index.store.cancelled" }, progress: 1,
        finishedAt: new Date().toISOString() };
      this.cancelled.set(job.id, cancelled);
      this.active.delete(job.id);
      for (const resolve of this.pending.get(job.id) ?? []) resolve(cancelled);
      this.pending.delete(job.id);
    }
    this.lastMapChecks.delete(repositoryId);
    this.pausedMapRepositories.delete(repositoryId);
    if (!this.closed && !this.failure && jobIds.length) this.worker?.postMessage({ type: "cancel", jobIds });
    this.changed();
  }

  /** 多个可见标签页共享检查间隔，手动刷新仍保持原有排队语义。 */
  autoRefreshRepository(repositoryId: string, now = Date.now(), interval = 60_000): Job | undefined {
    this.store.getRepository(repositoryId);
    if (!interval) return undefined;
    for (const id of this.active) {
      const job = this.store.findJob(id);
      if (job?.repositoryId === repositoryId) return job;
    }
    if (this.pausedMapRepositories.has(repositoryId)) return undefined;
    if (now - (this.lastMapChecks.get(repositoryId) ?? -Infinity) < interval) return undefined;
    const job = this.refresh(repositoryId);
    this.lastMapChecks.set(repositoryId, now);
    return job;
  }

  /** 旧网页的周期入口只观察；后台统一调度，不再因读取推进时间。 */
  autoRefreshSessions(_now = Date.now(), interval = 60_000): SessionJob | undefined {
    if (this.closed || !this.sessions) throw new DiagnosticError("会话索引 Worker 不可用", { key: "diagnostics.index.workerManager.m002" });
    if (!interval) return undefined;
    return this.coveringSessionJob(false);
  }

  get busy(): boolean { return this.active.size > 0 || this.sessionsBusy; }
  get sessionsBusy(): boolean { return this.sessionActive.size > 0; }

  sessionState(): { job: SessionJob; request: SessionWorkerRequest }[] {
    return [...this.sessionActive].map(id => ({ job: this.sessions!.getJob(id), request: this.sessionRequests.get(id)! }));
  }

  activeSessionJobs(): SessionJob[] { return [...this.sessionActive].map(id => this.sessions!.getJob(id)); }

  coveringSessionJob(clearCache = false, options: SessionRefreshOptions = {}): SessionJob | undefined {
    const requested: SessionWorkerRequest = { ...options, mode: clearCache ? "full" : options.mode ?? "quick", clearCache };
    for (const id of this.sessionActive) {
      const request = this.sessionRequests.get(id);
      const job = this.sessions!.getJob(id);
      if (request && (job.status === "queued" || job.status === "running") && sessionRequestCovers(request, requested)) return job;
    }
    return undefined;
  }

  subscribeChanges(listener: (jobs: SessionJob[]) => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  private changed(jobs: SessionJob[] = []): void { for (const listener of this.changeListeners) listener(jobs); }

  refreshSessions(clearCache = false, options: SessionRefreshOptions = {}): SessionJob {
    if (this.closed || !this.sessions) throw new DiagnosticError("会话索引 Worker 不可用", { key: "diagnostics.index.workerManager.m002" });
    const request: SessionRefreshOptions = clearCache ? { mode: "full" } : { client: options.client, mode: options.mode ?? "quick" };
    const existing = this.coveringSessionJob(clearCache, request);
    if (existing) return existing;
    if (!this.sessionWorker || this.sessionFailure) { this.sessionWorker = this.createWorker("sessions"); this.sessionFailure = undefined; }
    const job = this.sessions.createJob(request);
    this.sessionActive.add(job.id);
    this.sessionRequests.set(job.id, { ...request, clearCache });
    this.sessionWorker.postMessage({ type: "sessions", jobId: job.id, clearCache });
    this.changed([job]);
    return job;
  }

  waitForJob(jobId: string): Promise<Job> {
    const cancelled = this.cancelled.get(jobId);
    if (cancelled) return Promise.resolve(cancelled);
    const job = this.store.getJob(jobId);
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return Promise.resolve(job);
    return new Promise((resolve) => {
      this.pending.set(jobId, [...(this.pending.get(jobId) ?? []), resolve]);
    });
  }

  private finished(jobId: string, notify = true): void {
    if (this.sessionActive.delete(jobId)) {
      this.sessionRequests.delete(jobId);
      this.changed([this.sessions!.getJob(jobId)]);
      return;
    }
    this.active.delete(jobId);
    const job = this.cancelled.get(jobId) ?? this.store.findJob(jobId);
    this.cancelled.delete(jobId);
    if (!job) return;
    if (job.status === "completed") this.pausedMapRepositories.delete(job.repositoryId);
    else if (job.status === "failed" && job.startedAt) this.pausedMapRepositories.add(job.repositoryId);
    for (const resolve of this.pending.get(jobId) ?? []) resolve(job);
    this.pending.delete(jobId);
    if (notify) this.changed();
  }

  private async failed(kind: "maps" | "sessions", error: string, errorDescriptor?: MessageDescriptor, closing = false): Promise<void> {
    if (kind === "maps") this.failure = error;
    else this.sessionFailure = error;
    // 只结算本次故障已有的任务，重试期间新增的任务由新 Worker 负责。
    const sessionIds = kind === "sessions" ? [...this.sessionActive] : [];
    const mapIds = kind === "maps" ? [...this.active] : [];
    const sessionJobs: SessionJob[] = [];
    for (;;) {
      if (this.closed && !closing) return;
      try {
        await withIndexWriteAsync(this.options.writeGate, () => {
          if (this.closed && !closing) return;
          for (const id of sessionIds) {
            if (!this.sessionActive.has(id)) continue;
            const job = this.sessions!.getJob(id);
            if (job.status !== "complete" && job.status !== "failed") this.sessions!.failJob(id, error, errorDescriptor);
            this.sessionActive.delete(id);
            this.sessionRequests.delete(id);
            sessionJobs.push(this.sessions!.getJob(id));
          }
          const mapJobs = mapIds.map(id => this.store.findJob(id));
          const interrupted = mapJobs.find(job => job?.status === "running") ?? mapJobs.find(job => job?.status === "queued");
          for (const id of mapIds) {
            if (!this.active.has(id)) continue;
            const job = this.store.findJob(id);
            if (job && job.repositoryId === interrupted?.repositoryId) this.pausedMapRepositories.add(job.repositoryId);
            if (job && job.status !== "completed" && job.status !== "failed") this.store.failJob(id, error, errorDescriptor);
            this.finished(id, false);
          }
          if (kind === "maps") this.cancelled.clear();
          this.changed(sessionJobs);
        });
        return;
      } catch (failure) {
        // 失败状态也需要写锁；暂时冲突不能从错误回调抛出并终止整个管理线程。
        if (!(failure && typeof failure === "object" && "code" in failure && ["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String(failure.code)))) throw failure;
        await new Promise<void>(resolve => { setTimeout(resolve, 50); });
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(([[this.worker, this.workerReady], [this.sessionWorker, this.sessionWorkerReady]] as const).map(async ([worker, ready]) => {
      if (!worker) return;
      // 原生 SQLite 模块初始化完成后再终止，避免打断 N-API 注册。
      let timer: NodeJS.Timeout | undefined;
      try { if (ready) await Promise.race([ready, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); timer.unref(); })]); }
      finally { if (timer) clearTimeout(timer); }
      await worker.terminate();
    }));
    await Promise.all((["maps", "sessions"] as const).map(kind => this.failed(kind, "后台停止时刷新尚未完成", { key: "diagnostics.index.workerManager.interrupted" }, true)));
  }
}
