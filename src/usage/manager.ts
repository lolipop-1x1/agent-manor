import { Worker } from "node:worker_threads";
import type { MessageDescriptor } from "../i18n/types.js";
import { StoreError } from "../index/store.js";
import type { SessionProfile, SessionUsage } from "../session-contracts.js";
import type { SessionStore } from "../sessions/store.js";
import type { RequestCost, SessionCostSummary, UsagePreparationStatus, UsageQuery, UsageReport, UsageRequestPage } from "../usage-contracts.js";
import { queryOf, timeKeys } from "./analytics.js";
import { UsageResultCache } from "./cache.js";
import type { PricingService } from "./pricing.js";
import { preparationKey } from "./worker-contracts.js";
import type { UsageWorkerRequest, UsageWorkerResponse } from "./worker-contracts.js";

type Result = UsageReport | UsageRequestPage | SessionCostSummary;
interface Pending {
  query: UsageQuery;
  resolve(result: Result | null): void;
  reject(error: Error): void;
}
const interrupted = () => new StoreError("INTERNAL_ERROR", "用量统计后台已停止", { key: "diagnostics.usage.worker.stopped" });
const requestKey = (type: UsageWorkerRequest["type"], query: UsageQuery, extra: object): string =>
  JSON.stringify([type, Object.fromEntries(Object.entries(query).sort(([left], [right]) => left.localeCompare(right))), extra]);

/** 主线程只查询版本、传递价格快照并读取页内证据，全量统计由隔离 Worker 承担。 */
export class UsageManager {
  private worker?: Worker;
  private readonly pending = new Map<number, Pending>();
  private readonly inFlight = new Map<string, Promise<Result | null>>();
  private readonly cache = new UsageResultCache<Result>(16 * 1024 * 1024, 24);
  private readonly preparations = new Map<string, UsagePreparationStatus>();
  private nextId = 0;
  private closed = false;
  private timer?: NodeJS.Timeout;
  private lastPreparation?: string;

  constructor(private readonly sessions: SessionStore, private readonly pricing: PricingService, private readonly cachePath: string) {}

  private fixed(query: UsageQuery): UsageQuery {
    if (this.closed) throw interrupted();
    const version = this.sessions.usageVersion(query.version), price = this.pricing.summary(query.priceVersion);
    const result = queryOf(query, { version, sessions: [], requests: [] }, { ...price, configuration: { overrides: [], mappings: [] }, prices: [] });
    timeKeys(result.timezone!, "hour");
    return result;
  }

  private update(status: UsagePreparationStatus): void {
    const key = preparationKey(status);
    this.preparations.delete(key); this.preparations.set(key, { ...status });
    while (this.preparations.size > 24) this.preparations.delete(this.preparations.keys().next().value!);
  }

  private createWorker(): Worker {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const url = new URL(`./worker.${extension}`, import.meta.url);
    const workerData = { dbPath: this.sessions.dbPath, cachePath: this.cachePath };
    const resourceLimits = { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 };
    // 源码运行时在 Worker 内注册 tsx，不依赖主线程的模块解析钩子。
    const worker = extension === "ts"
      ? new Worker(`import('tsx/esm/api').then(({register}) => { register(); return import(${JSON.stringify(url.href)}); });`, { eval: true, workerData, resourceLimits })
      : new Worker(url, { workerData, resourceLimits });
    worker.on("message", (message: UsageWorkerResponse) => {
      if (this.worker !== worker || this.closed) return;
      if (message.type === "status") { this.update(message.status); return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.type === "result") request.resolve(message.result);
      else request.reject(new StoreError(message.error.code, message.error.message, message.error.messageDescriptor));
    });
    worker.on("error", error => {
      if (this.worker !== worker || this.closed) return;
      if ("code" in error && error.code === "ERR_WORKER_OUT_OF_MEMORY") this.failed("用量统计超过内存预算", { key: "diagnostics.usage.worker.memoryCapacity" });
      else this.failed(error.message);
    });
    worker.on("exit", code => {
      if (this.worker === worker && !this.closed) this.failed(`用量统计 Worker 意外停止（${code}）`,
        { key: "diagnostics.usage.worker.unexpectedExit", params: { code } });
    });
    return worker;
  }

  private failed(message: string, messageDescriptor: MessageDescriptor = { key: "diagnostics.server.m003" }): void {
    const previous = this.worker; this.worker = undefined;
    if (previous) void previous.terminate().catch(() => undefined);
    const failure = new StoreError("INTERNAL_ERROR", message, messageDescriptor);
    for (const request of this.pending.values()) {
      this.update({ state: "failed", version: request.query.version, priceVersion: request.query.priceVersion, timezone: request.query.timezone,
        preparedSessions: 0, totalSessions: 0 });
      request.reject(failure);
    }
    this.pending.clear(); this.cache.clear(); this.lastPreparation = undefined;
  }

  private hydrate(result: Result): Result {
    if ("scope" in result) return result;
    const view = this.pricing.view(result.priceVersion);
    const restore = (sessionId: string, requests: { usage: SessionUsage; cost: RequestCost }[], client?: string) => {
      if (!requests.length) return [];
      const original = new Map(this.sessions.usageEvidence(result.version, sessionId, requests.map(row => row.usage.id)).map(usage => [usage.id, usage]));
      return requests.map(row => {
        const usage = original.get(row.usage.id);
        if (!usage) throw new StoreError("SOURCE_NOT_FOUND", "会话不存在于当前索引版本", { key: "diagnostics.sessions.store.m011" });
        const estimated = view.estimate(usage, client);
        // 请求页不包含客户端身份，保留 Worker 的金额和覆盖判定，只补充适用价格证据。
        const cost = client ? estimated : { ...row.cost, ...(estimated.price ? { price: estimated.price } : {}) };
        return { usage, cost };
      });
    };
    if ("totals" in result) return { ...result, sessions: result.sessions.map(row => ({ ...row,
      requests: restore(row.session.id, row.requests, row.session.client) })), pricing: this.pricing.summary(result.priceVersion) };
    return { ...result, requests: restore(result.sessionId, result.requests) };
  }

  private execute(type: UsageWorkerRequest["type"], query: UsageQuery, extra: Pick<UsageWorkerRequest, "sessionId" | "page" | "pageSize" | "sessionIds" | "scope"> = {}): Promise<Result | null> {
    if (this.closed) return Promise.reject(interrupted());
    const key = requestKey(type, query, extra), current = this.inFlight.get(key);
    if (current) return current;
    const cached = type === "prepare" ? undefined : this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    const pricing = this.pricing.view(query.priceVersion).status;
    if (!this.worker) this.worker = this.createWorker();
    const id = ++this.nextId;
    const response = new Promise<Result | null>((resolve, reject) => {
      this.pending.set(id, { query, resolve, reject });
      try { this.worker!.postMessage({ id, type, query, pricing, ...extra } satisfies UsageWorkerRequest); }
      catch (error) { this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    }).then(value => {
      if (!value) return null;
      const hydrated = this.hydrate(value); this.cache.set(key, hydrated); return hydrated;
    }).finally(() => { if (this.inFlight.get(key) === response) this.inFlight.delete(key); });
    this.inFlight.set(key, response);
    return response;
  }

  async report(query: UsageQuery): Promise<UsageReport> {
    const result = await this.execute("report", this.fixed(query)) as UsageReport;
    return structuredClone({ ...result, pricing: this.pricing.summary(result.priceVersion) });
  }

  async requests(query: UsageQuery, sessionId: string, page = 1, pageSize = 100): Promise<UsageRequestPage> {
    const result = await this.execute("requests", this.fixed(query), { sessionId, page, pageSize }) as UsageRequestPage;
    return structuredClone(result);
  }

  async sessionCost(profile: Pick<SessionProfile, "version" | "sessionIds" | "scope">, priceVersion?: string): Promise<SessionCostSummary> {
    const result = await this.execute("sessionCost", this.fixed({ version: profile.version, priceVersion }),
      { sessionIds: profile.sessionIds, scope: profile.scope }) as SessionCostSummary;
    return structuredClone(result);
  }

  status(query: UsageQuery = {}): UsagePreparationStatus {
    if (this.closed) throw interrupted();
    const version = query.version ?? this.sessions.currentVersion();
    if (!version) return { state: "idle", priceVersion: this.pricing.summary(query.priceVersion).version,
      timezone: query.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, preparedSessions: 0, totalSessions: 0 };
    const fixed = this.fixed(query), status = this.preparations.get(preparationKey(fixed));
    return status ? { ...status } : { state: "idle", version: fixed.version, priceVersion: fixed.priceVersion, timezone: fixed.timezone,
      preparedSessions: 0, totalSessions: 0 };
  }

  start(): void {
    if (this.closed || this.timer) return;
    const check = () => {
      if (this.closed || !this.sessions.currentVersion()) return;
      try {
        const query = this.fixed({}), key = preparationKey(query);
        if (key === this.lastPreparation) return;
        this.lastPreparation = key;
        void this.execute("prepare", query).catch(() => {
          this.update({ state: "failed", version: query.version, priceVersion: query.priceVersion, timezone: query.timezone,
            preparedSessions: 0, totalSessions: 0 });
        });
      } catch { /* 新版本发布或价格视图变化时在下次检查重新准备。 */ }
    };
    check(); this.timer = setInterval(check, 2000); this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    const worker = this.worker; this.worker = undefined;
    if (worker) await worker.terminate();
    for (const request of this.pending.values()) request.reject(interrupted());
    this.pending.clear(); this.inFlight.clear(); this.cache.clear(); this.preparations.clear();
  }
}
