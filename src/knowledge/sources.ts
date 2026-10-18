import { Worker } from "node:worker_threads";
import type { ApiErrorCode } from "../contracts.js";
import type { MessageDescriptor } from "../i18n/types.js";
import { StoreError } from "../index/store.js";
import type { KnowledgeConversation, KnowledgeExtractionScope, KnowledgeSource, KnowledgeSourceReader, KnowledgeTarget } from "../knowledge-contracts.js";

/** 大型历史库的扫描在只读 Worker 中运行，不占用服务的 HTTP 主线程。 */
export class KnowledgeSources implements KnowledgeSourceReader {
  private worker?: Worker;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  constructor(private readonly dbPath: string) {}
  private call<T>(method: string, input: unknown): Promise<T> {
    if (!this.worker) {
      const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
      const url = new URL(`./source-worker.${extension}`, import.meta.url);
      const workerData = { dbPath: this.dbPath };
      const worker = extension === "ts" ? new Worker(`import('tsx/esm/api').then(({register}) => { register(); return import(${JSON.stringify(url.href)}); });`, { eval: true, workerData }) : new Worker(url, { workerData });
      this.worker = worker;
      worker.on("message", (message: { id: number; result?: unknown; error?: { code: ApiErrorCode; message: string; messageDescriptor?: MessageDescriptor } }) => {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new StoreError(message.error.code, message.error.message, message.error.messageDescriptor)); else request.resolve(message.result);
      });
      const failed = (error: Error) => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
      };
      worker.on("error", failed);
      worker.on("exit", () => failed(new Error("Knowledge source worker stopped")));
    }
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      this.worker!.postMessage({ id, method, input });
    });
  }
  plan(scope: KnowledgeExtractionScope): Promise<KnowledgeTarget[]> { return this.call("plan", scope); }
  read(target: KnowledgeTarget): Promise<KnowledgeConversation> { return this.call("read", target); }
  verify(source: KnowledgeSource): Promise<KnowledgeSource> { return this.call("verify", source); }
  async close(): Promise<void> { if (this.worker) await this.worker.terminate(); }
}
