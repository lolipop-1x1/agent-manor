import { releaseIndexWrite } from "./write-gate.js";
import { Worker } from "node:worker_threads";
import type { IndexMaintenanceResult, Job, RegisterRepositoryResponse } from "../contracts.js";
import type { DiscoverRoots } from "../history/index.js";
import type { SessionJob, SessionRefreshOptions } from "../session-contracts.js";
import { DiagnosticError, errorDescriptor } from "../i18n/diagnostics.js";
import { StoreError } from "./store.js";
import type { SessionStore } from "../sessions/store.js";
import { sessionRequestCovers, type SessionWorkerRequest } from "./worker-manager.js";
import type { MessageDescriptor } from "../i18n/types.js";

export interface TaskCommands {
  register: { args: [path: string]; result: RegisterRepositoryResponse };
  associate: { args: [repositoryId: string, sourceId: string]; result: Job };
  delete: { args: [repositoryId: string]; result: void };
  refresh: { args: [repositoryId: string, retained?: boolean]; result: Job };
  clearCache: { args: [repositoryId: string]; result: Job };
  autoRefresh: { args: [repositoryId: string, now: number, interval: number]; result: Job | undefined };
  sessions: { args: [clearCache: boolean, options: SessionRefreshOptions]; result: SessionJob };
  retainJobs: { args: [ids: string[], retained: boolean]; result: void };
  close: { args: []; result: void };
}
export type TaskCommand = { [K in keyof TaskCommands]: { id: number; type: K; args: TaskCommands[K]["args"] } }[keyof TaskCommands];
export interface TaskState {
  busy: boolean;
  sessions: { job: SessionJob; request: SessionWorkerRequest }[];
  reclaim?: IndexMaintenanceResult;
}
export type TaskMessage = { state: TaskState; jobs: SessionJob[] } | { ready: true } | {
  id: number; result?: unknown; error?: { code?: StoreError["code"]; message: string; messageDescriptor?: MessageDescriptor };
};

/** HTTP 只异步提交短写操作；任务登记等待 SQLite 锁时不占用请求线程。 */
export class IndexTaskManager {
  private readonly worker: Worker;
  readonly ready: Promise<void>;
  private nextId = 0;
  private closed = false;
  private failure?: Error;
  private state: TaskState = { busy: false, sessions: [] };
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly listeners = new Set<(jobs: SessionJob[]) => void>();

  constructor(dbPath: string, roots: DiscoverRoots | undefined, private readonly sessions: SessionStore, writeGate = new SharedArrayBuffer(4), onFailure?: (error: Error) => void) {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const url = new URL(`./task-worker.${extension}`, import.meta.url);
    const workerData = { dbPath, roots, writeGate };
    this.worker = extension === "ts"
      ? new Worker(`import('tsx/esm/api').then(({register}) => { register(); return import(${JSON.stringify(url.href)}); });`, { eval: true, workerData })
      : new Worker(url, { workerData });
    const workerOwner = this.worker.threadId + 1;
    this.ready = new Promise<void>((resolve, reject) => {
      this.worker.on("message", (message: TaskMessage) => {
        if ("ready" in message) { resolve(); return; }
        if ("state" in message) {
          this.state = message.state;
          for (const listener of this.listeners) listener(message.jobs);
          return;
        }
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          const { code, message: text, messageDescriptor } = message.error;
          pending?.reject(code ? new StoreError(code, text, messageDescriptor) : new DiagnosticError(text, messageDescriptor));
        } else pending?.resolve(message.result);
      });
      const failed = (error: Error) => {
        if (this.failure) return;
        this.failure = new StoreError("INTERNAL_ERROR", error.message, errorDescriptor(error));
        reject(this.failure);
        for (const pending of this.pending.values()) pending.reject(this.failure);
        this.pending.clear();
        onFailure?.(this.failure);
      };
      this.worker.on("error", failed);
      this.worker.on("exit", code => { releaseIndexWrite(writeGate, workerOwner); if (!this.closed) failed(new DiagnosticError(`分析 Worker 意外停止（${code}）`, { key: "diagnostics.index.workerManager.unexpectedExit", params: { code } })); });
    });
  }

  private async execute<K extends keyof TaskCommands>(type: K, ...args: TaskCommands[K]["args"]): Promise<TaskCommands[K]["result"]> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (this.closed) throw new DiagnosticError("分析 Worker 已关闭", { key: "diagnostics.index.workerManager.m001" });
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve: value => resolve(value as TaskCommands[K]["result"]), reject });
      this.worker.postMessage({ id, type, args });
    });
  }

  assertHealthy() { if (this.failure) throw this.failure; }

  registerRepository(path: string) { return this.execute("register", path); }
  associateSource(repositoryId: string, sourceId: string) { return this.execute("associate", repositoryId, sourceId); }
  deleteRepository(repositoryId: string) { return this.execute("delete", repositoryId); }
  refresh(repositoryId: string, retained = false) { return this.execute("refresh", repositoryId, retained); }
  retainJobs(ids: string[], retained: boolean) { return this.execute("retainJobs", ids, retained); }
  clearCache(repositoryId: string) { return this.execute("clearCache", repositoryId); }
  autoRefreshRepository(repositoryId: string, now: number, interval: number) { return this.execute("autoRefresh", repositoryId, now, interval); }
  refreshSessions(clearCache = false, options: SessionRefreshOptions = {}) {
    const existing = this.coveringSessionJob(clearCache, options);
    return existing ? Promise.resolve(existing) : this.execute("sessions", clearCache, options);
  }
  autoRefreshSessions(_now: number, interval: number) { return interval ? this.coveringSessionJob() : undefined; }
  get busy() { return this.state.busy; }
  get sessionsBusy() { return this.state.sessions.length > 0; }
  get reclaimStatus() { return this.state.reclaim; }
  activeSessionJobs() { return this.state.sessions.map(({ job }) => this.sessions.getJob(job.id)); }
  coveringSessionJob(clearCache = false, options: SessionRefreshOptions = {}) {
    const request = { ...options, mode: clearCache ? "full" as const : options.mode ?? "quick", clearCache };
    const entry = this.state.sessions.find(entry => sessionRequestCovers(entry.request, request)
      && ["queued", "running"].includes(this.sessions.getJob(entry.job.id).status));
    return entry ? this.sessions.getJob(entry.job.id) : undefined;
  }
  subscribeChanges(listener: (jobs: SessionJob[]) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  async close(): Promise<void> {
    if (this.closed) return;
    try { await this.execute("close"); }
    finally { this.closed = true; this.listeners.clear(); await this.worker.terminate(); }
  }
}
