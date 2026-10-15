import { Worker } from "node:worker_threads";
import type { MessageDescriptor } from "../i18n/types.js";
import { DiagnosticError } from "../i18n/diagnostics.js";
import type { SourceLocation } from "../history/types.js";
import type { SessionMessage, SessionSourceMeta, SessionUsage } from "../session-contracts.js";
import type { SessionParseOptions } from "./parser.js";

export type ImportItem = { type: "message"; value: SessionMessage; terms: string } | { type: "usage"; value: SessionUsage };
export type ImportParseOptions = Pick<SessionParseOptions, "byteLimit" | "title" | "projectMetadata" | "desktopModels">;
export interface ImportRequest { id: number; source: SourceLocation; options: ImportParseOptions; hash: boolean }
export type ImportResponse = { id: number; type: "batch"; items: ImportItem[] }
  | { id: number; type: "done"; meta: SessionSourceMeta; hash?: string }
  | { id: number; type: "error"; message: string; descriptor?: MessageDescriptor };
interface Job extends ImportRequest {
  batch(items: ImportItem[]): void;
  resolve(result: { meta: SessionSourceMeta; hash?: string }): void;
  reject(error: Error): void;
}
interface Slot { worker?: Worker; ack: Int32Array; active?: Job; failure?: Error }
const closedError = () => new DiagnosticError("解析线程池已关闭", { key: "diagnostics.sessions.import.closed" });

/** 每个解析线程只发送一个未确认批次，数据库提交后才继续，限制跨线程积压。 */
export class SessionImportPool {
  private readonly slots: Slot[];
  private readonly queue: Job[] = [];
  private nextId = 0;
  private closed = false;

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1 || size > 4) throw new RangeError("解析并发数必须介于 1 和 4 之间");
    this.slots = Array.from({ length: size }, () => ({ ack: new Int32Array(new SharedArrayBuffer(4)) }));
  }

  parse(source: SourceLocation, options: ImportParseOptions, hash: boolean, batch: Job["batch"]): Promise<{ meta: SessionSourceMeta; hash?: string }> {
    if (this.closed) return Promise.reject(closedError());
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.nextId, source, options, hash, batch, resolve, reject });
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (slot.active || !this.queue.length) continue;
      slot.active = this.queue.shift()!;
      try {
        slot.worker ??= this.createWorker(slot);
        const { id, source, options, hash } = slot.active;
        Atomics.store(slot.ack, 0, 0);
        slot.worker.postMessage({ id, source, options, hash } satisfies ImportRequest);
      } catch (error) { this.failed(slot, error instanceof Error ? error : new Error(String(error))); }
    }
  }

  private createWorker(slot: Slot): Worker {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const url = new URL(`./import-worker.${extension}`, import.meta.url), workerData = { ack: slot.ack };
    const worker = extension === "ts"
      ? new Worker(`import('tsx/esm/api').then(({register}) => { register(); return import(${JSON.stringify(url.href)}); });`, { eval: true, workerData })
      : new Worker(url, { workerData });
    worker.on("message", (message: ImportResponse) => {
      const job = slot.active;
      if (slot.worker !== worker || !job || message.id !== job.id) return;
      if (message.type === "batch") {
        try { job.batch(message.items); }
        catch (error) { slot.failure = error instanceof Error ? error : new Error(String(error)); }
        Atomics.store(slot.ack, 0, slot.failure ? -1 : 1); Atomics.notify(slot.ack, 0);
        return;
      }
      slot.active = undefined;
      if (message.type === "error") job.reject(slot.failure ?? new DiagnosticError(message.message, message.descriptor));
      else job.resolve({ meta: message.meta, hash: message.hash });
      slot.failure = undefined;
      this.dispatch();
    });
    worker.on("error", error => { if (slot.worker === worker) this.failed(slot, error); });
    worker.on("exit", () => {
      if (slot.worker === worker && !this.closed) this.failed(slot, new DiagnosticError("解析线程意外停止", { key: "diagnostics.sessions.import.stopped" }));
    });
    return worker;
  }

  private failed(slot: Slot, error: Error): void {
    const worker = slot.worker; slot.worker = undefined;
    slot.active?.reject(error); slot.active = undefined; slot.failure = undefined;
    if (worker) void worker.terminate();
    this.dispatch();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(closedError());
    await Promise.all(this.slots.map(async slot => {
      slot.active?.reject(closedError()); slot.active = undefined;
      Atomics.store(slot.ack, 0, -1); Atomics.notify(slot.ack, 0);
      const worker = slot.worker; slot.worker = undefined;
      if (worker) await worker.terminate();
    }));
  }
}
