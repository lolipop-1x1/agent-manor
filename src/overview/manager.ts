import { Worker } from "node:worker_threads";
import type { Repository } from "../contracts.js";
import { StoreError } from "../index/store.js";
import type { OverviewEvidencePage, OverviewEvidenceQuery, OverviewQuery, OverviewReport } from "../overview-contracts.js";
import type { SessionStore } from "../sessions/store.js";
import { UsageResultCache } from "../usage/cache.js";
import type { PricingService } from "../usage/pricing.js";
import type { OverviewWorkerRequest, OverviewWorkerResponse } from "./worker-contracts.js";
import { localDay } from "./dates.js";

type Result = OverviewReport | OverviewEvidencePage;
interface Pending { resolve(value: Result): void; reject(error: Error): void }
const stopped = () => new StoreError("INTERNAL_ERROR", "总览统计后台已停止", { key: "diagnostics.server.m003" });

/** 全量事件与仓库聚合均留在后台，主线程仅固定版本、合并请求与缓存紧凑结果。 */
export class OverviewManager {
  private worker?: Worker;
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  private readonly inFlight = new Map<string, Promise<Result>>();
  private readonly cache = new UsageResultCache<Result>(32 * 1024 * 1024, 24);

  constructor(private readonly sessions: SessionStore, private readonly pricing: PricingService,
    private readonly repositories: () => Repository[], private readonly now: () => Date = () => new Date()) {}

  private createWorker(): Worker {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const url = new URL(`./worker.${extension}`, import.meta.url), workerData = { dbPath: this.sessions.dbPath };
    const worker = extension === "ts"
      ? new Worker(`import('tsx/esm/api').then(({register}) => { register(); return import(${JSON.stringify(url.href)}); });`, { eval: true, workerData })
      : new Worker(url, { workerData });
    worker.on("message", (message: OverviewWorkerResponse) => {
      if (this.closed || this.worker !== worker) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.type === "result") request.resolve(message.result);
      else request.reject(new StoreError(message.error.code, message.error.message, message.error.messageDescriptor));
    });
    worker.on("error", error => { if (!this.closed && this.worker === worker) this.fail(error); });
    worker.on("exit", () => { if (!this.closed && this.worker === worker) this.fail(stopped()); });
    return worker;
  }

  private fail(error: Error): void {
    const worker = this.worker; this.worker = undefined;
    if (worker) void worker.terminate().catch(() => undefined);
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear(); this.cache.clear();
  }

  private execute(type: OverviewWorkerRequest["type"], query: OverviewQuery, evidence?: OverviewEvidenceQuery): Promise<Result> {
    if (this.closed) return Promise.reject(stopped());
    const pricing = this.pricing.view(query.priceVersion).status;
    const fixed = { ...query, version: this.sessions.usageVersion(query.version), priceVersion: pricing.version,
      timezone: query.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone };
    const now = this.now();
    const day = fixed.anchorDay ?? localDay(now, fixed.timezone)!;
    fixed.anchorDay = day;
    const repositories = this.repositories();
    const key = JSON.stringify([type, Object.fromEntries(Object.entries(fixed).sort(([a], [b]) => a.localeCompare(b))),
      evidence, day, repositories.map(row => [row.id, row.version, row.stale])]);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    if (!this.worker) this.worker = this.createWorker();
    const id = ++this.nextId;
    const response = new Promise<Result>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker!.postMessage({ id, type, query: fixed, pricing, repositories, now: now.toISOString(), evidence } satisfies OverviewWorkerRequest); }
      catch (error) { this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    }).then(result => { this.cache.set(key, result); return result; })
      .finally(() => { if (this.inFlight.get(key) === response) this.inFlight.delete(key); });
    this.inFlight.set(key, response);
    return response;
  }

  async report(query: OverviewQuery): Promise<OverviewReport> {
    const result = await this.execute("report", query) as OverviewReport;
    return structuredClone({ ...result, usage: { ...result.usage, pricing: this.pricing.summary(result.priceVersion) } });
  }

  async evidence(query: OverviewQuery, evidence: OverviewEvidenceQuery): Promise<OverviewEvidencePage> {
    return structuredClone(await this.execute("evidence", query, evidence) as OverviewEvidencePage);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const worker = this.worker; this.worker = undefined;
    for (const request of this.pending.values()) request.reject(stopped());
    this.pending.clear(); this.inFlight.clear(); this.cache.clear();
    if (worker) await worker.terminate();
  }
}
