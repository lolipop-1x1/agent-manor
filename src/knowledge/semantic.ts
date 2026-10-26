import { Worker } from "node:worker_threads";
import type { KnowledgeConfig, KnowledgeDraft, KnowledgeIndexPreview, KnowledgeIndexStatus, KnowledgeList, KnowledgeQuery } from "../knowledge-contracts.js";
import { SemanticError } from "../semantic/config.js";
import { KnowledgeError } from "./store.js";
import type { KnowledgeStore } from "./store.js";
import type { ReusedConnection, SettingsProvider } from "./semantic-engine.js";
import type { KnowledgeSemanticMethod, KnowledgeSemanticResponse, KnowledgeSettingsMethod } from "./semantic-worker-contracts.js";

const stopped = () => new SemanticError("semantic_closed", "知识索引后台已停止", 503, undefined, { key: "knowledge.errors.index_failed" });

/** 主线程只协调配置和任务；知识扫描、分块、排序和向量持久化均由 Worker 执行。 */
export class KnowledgeSemantic {
  private worker?: Worker;
  private initialized?: Promise<void>;
  private sequence = 0;
  private closed = false;
  private active = false;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>();
  constructor(private readonly home: string, private readonly store: KnowledgeStore,
    private readonly provider: SettingsProvider, private readonly reused: ReusedConnection) {
    if (this.store.getState<KnowledgeIndexStatus>("knowledge.semantic")) this.worker = this.createWorker();
  }

  get busy(): boolean { return this.active; }

  private async configuration(method: KnowledgeSettingsMethod): Promise<unknown> {
    switch (method) {
      case "settings": return this.provider.settings();
      case "key": return this.provider.key("embedding");
      case "reusedSettings": return this.reused.settings();
      case "reusedKey": return this.reused.key();
    }
  }
  private createWorker(): Worker {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const url = new URL(`./semantic-worker.${extension}`, import.meta.url);
    const options = { workerData: { home: this.home, dbPath: this.store.dbPath }, resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 } };
    const worker = extension === "ts"
      ? new Worker(`import('tsx/esm/api').then(({register}) => { register(); return import(${JSON.stringify(url.href)}); });`, { ...options, eval: true })
      : new Worker(url, options);
    let initialized!: () => void;
    this.initialized = new Promise<void>(resolve => { initialized = resolve; });
    worker.on("message", (message: KnowledgeSemanticResponse) => {
      if (message.type === "ready") { initialized(); return; }
      if (this.worker !== worker) return;
      if (message.type === "busy") { this.active = message.busy; return; }
      if (message.type === "configuration") {
        void this.configuration(message.method).then(result => worker.postMessage({ type: "configuration", id: message.id, result }),
          error => worker.postMessage({ type: "configuration", id: message.id, error: error instanceof Error ? error.message : String(error) }));
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); pending.cleanup();
      const error = message.error;
      if (!error) pending.resolve(message.result);
      else if (error.kind === "knowledge") pending.reject(new KnowledgeError(error.code as "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT", error.message, error.messageDescriptor));
      else pending.reject(new SemanticError(error.code, error.message, error.status ?? 500, undefined, error.messageDescriptor));
    });
    const failed = (error: Error) => {
      initialized();
      if (this.worker !== worker) return;
      this.worker = undefined; this.active = false;
      for (const request of this.pending.values()) { request.cleanup(); request.reject(error); }
      this.pending.clear();
      const state = this.store.getState<KnowledgeIndexStatus>("knowledge.semantic");
      if (state?.status === "running") this.store.setState("knowledge.semantic", { ...state, status: "failed", error: error.message, errorDescriptor: { key: "knowledge.errors.index_failed" } });
    };
    worker.on("error", failed);
    worker.on("exit", () => failed(stopped()));
    return worker;
  }

  private call<T>(method: KnowledgeSemanticMethod, input?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed && method !== "close") return Promise.reject(stopped());
    if (signal?.aborted) return Promise.reject(new SemanticError("semantic_aborted", "模型请求已取消", 499));
    if (!this.worker) this.worker = this.createWorker();
    const worker = this.worker, id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const abort = () => worker.postMessage({ type: "cancel", id });
      this.pending.set(id, { resolve: value => resolve(value as T), reject, cleanup: () => signal?.removeEventListener("abort", abort) });
      signal?.addEventListener("abort", abort, { once: true });
      worker.postMessage({ id, method, input });
    });
  }
  status(): Promise<KnowledgeIndexStatus> { return this.call("status"); }
  preview(): Promise<KnowledgeIndexPreview> { return this.call("preview"); }
  build(previewId: string): Promise<KnowledgeIndexStatus> { return this.call("build", previewId); }
  action(action: "pause" | "resume"): Promise<KnowledgeIndexStatus> { return this.call("action", action); }
  search(query: KnowledgeQuery): Promise<KnowledgeList> { return this.call("search", query); }
  compareCandidates(candidate: KnowledgeDraft, others: readonly KnowledgeDraft[], config: KnowledgeConfig, signal?: AbortSignal): Promise<number[] | undefined> {
    return this.call("compareCandidates", { candidate, others, config }, signal);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const worker = this.worker;
    if (!worker) return;
    await this.initialized;
    try { if (this.worker === worker) await this.call("close"); }
    finally {
      this.worker = undefined; this.active = false;
      await worker.terminate();
      for (const request of this.pending.values()) { request.cleanup(); request.reject(stopped()); }
      this.pending.clear();
    }
  }
}
