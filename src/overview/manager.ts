import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import type { Repository } from "../contracts.js";
import { StoreError } from "../index/store.js";
import type { OverviewDetailPage, OverviewDetailQuery, OverviewEvidencePage, OverviewEvidenceQuery, OverviewPanel,
  OverviewPanelResult, OverviewQuery, OverviewReport, OverviewSnapshot } from "../overview-contracts.js";
import type { SessionStore } from "../sessions/store.js";
import { UsageResultCache } from "../usage/cache.js";
import { UsageManager } from "../usage/manager.js";
import type { PricingService } from "../usage/pricing.js";
import type { UsageQuery, UsageReport } from "../usage-contracts.js";
import type { OverviewWorkerRequest, OverviewWorkerResponse, OverviewWorkerResult } from "./worker-contracts.js";
import { localDay, resolveOverviewRange, resolveTimezone } from "./dates.js";
import { OverviewResultStore } from "./result-store.js";

type Lane = "core" | "analysis" | "detail" | "repositories";
interface Pending { lane: Lane; resolve(value: OverviewWorkerResult): void; reject(error: Error): void }
const stopped = () => new StoreError("INTERNAL_ERROR", "总览统计后台已停止", { key: "diagnostics.server.m003" });

/** 核心、区域和调查互不排队；缓存命中先核对完整版本，再跳过事实及用量准备。 */
export class OverviewManager {
  private readonly workers = new Map<Lane, Worker>();
  private readonly idleWorkers = new Map<Lane, NodeJS.Timeout>();
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  private readonly inFlight = new Map<string, Promise<OverviewWorkerResult>>();
  private readonly preparedFacts = new Set<string>();
  private readonly preparingFacts = new Map<string, Promise<void>>();
  private preparation: Promise<void> = Promise.resolve();
  private readonly cache = new UsageResultCache<OverviewWorkerResult>(32 * 1024 * 1024, 48);
  private readonly persisted: OverviewResultStore;
  private readonly usage: UsageManager;
  private readonly ownsUsage: boolean;
  constructor(private readonly sessions: SessionStore, private readonly pricing: PricingService,
    private readonly repositories: () => Repository[], private readonly now: () => Date = () => new Date(), usage?: UsageManager) {
    this.ownsUsage = !usage;
    this.usage = usage ?? new UsageManager(sessions, pricing, join(dirname(sessions.dbPath), "usage-rollups.sqlite"));
    this.persisted = new OverviewResultStore(join(dirname(sessions.dbPath), "overview-results.sqlite"));
  }
  private createWorker(lane: Lane): Worker {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const url = new URL(`./worker.${extension}`, import.meta.url), workerData = { dbPath: this.sessions.dbPath, preparesFacts: lane === "core" };
    const resourceLimits = { maxOldGenerationSizeMb: lane === "repositories" ? 192 : 512, maxYoungGenerationSizeMb: 32 };
    const worker = extension === "ts"
      ? new Worker(`import('tsx/esm/api').then(({register}) => { register(); return import(${JSON.stringify(url.href)}); });`, { eval: true, workerData, resourceLimits })
      : new Worker(url, { workerData, resourceLimits });
    worker.on("message", (message: OverviewWorkerResponse) => {
      if (this.closed || this.workers.get(lane) !== worker) return;
      const request = this.pending.get(message.id); if (!request) return;
      this.pending.delete(message.id);
      if (message.type === "result") request.resolve(message.result);
      else request.reject(new StoreError(message.error.code, message.error.message, message.error.messageDescriptor));
      // 结果已进入主线程及持久缓存，闲置通道释放 SQLite 与临时分析内存。
      if (![...this.pending.values()].some(value => value.lane === lane)) {
        const timer = setTimeout(() => {
          this.idleWorkers.delete(lane);
          if (this.workers.get(lane) !== worker) return;
          this.workers.delete(lane); void worker.terminate().catch(() => undefined);
        }, lane === "repositories" ? 0 : 2000);
        timer.unref(); this.idleWorkers.set(lane, timer);
      }
    });
    const fail = (error: Error) => {
      if (this.closed || this.workers.get(lane) !== worker) return;
      this.workers.delete(lane); void worker.terminate().catch(() => undefined);
      const failure = "code" in error && error.code === "ERR_WORKER_OUT_OF_MEMORY"
        ? new StoreError("ANALYSIS_NOT_READY", "总览请求超过统计内存预算", { key: "diagnostics.overview.memoryCapacity" }) : error;
      for (const [id, request] of this.pending) if (request.lane === lane) { request.reject(failure); this.pending.delete(id); }
    };
    worker.on("error", fail); worker.on("exit", () => fail(stopped()));
    this.workers.set(lane, worker); return worker;
  }
  private fixed(query: OverviewQuery): OverviewQuery {
    if (this.closed) throw stopped();
    const timezone = resolveTimezone(query.timezone);
    return { ...query, version: this.sessions.usageVersion(query.version), priceVersion: this.pricing.view(query.priceVersion).status.version,
      timezone, anchorDay: query.anchorDay ?? localDay(this.now(), timezone)! };
  }
  private key(type: OverviewWorkerRequest["type"], query: OverviewQuery, extra: object): string {
    const panel = (extra as { panel?: OverviewPanel }).panel;
    const semantic = type === "panel" && ["core", "resources", "repositories"].includes(panel ?? "") ? { ...query, models: undefined } : query;
    return JSON.stringify([5, type, this.canonicalQuery(semantic), extra,
      type === "report" || panel === "repositories" ? this.repositories().map(row => [row.id, row.version, row.stale]) : undefined]);
  }
  private canonicalQuery(query: OverviewQuery): object {
    const window = query.window ?? (query.from || query.to ? "custom" : "365");
    const range = window === "all" ? null : resolveOverviewRange({ version: query.version!, sessions: [], events: [], requests: [], resources: [], gaps: [] }, query, this.now());
    return Object.fromEntries(Object.entries({ ...query, window, ...(range ? { from: range.from, to: range.to } : {}) })
      .sort(([a], [b]) => a.localeCompare(b)));
  }
  private bindQuery(result: OverviewWorkerResult, query: OverviewQuery): OverviewWorkerResult {
    return "snapshot" in result ? { ...result, snapshot: { ...result.snapshot, query } } : { ...result, query };
  }
  private valid(value: unknown, query: OverviewQuery, type: OverviewWorkerRequest["type"]): value is OverviewWorkerResult {
    if (!value || typeof value !== "object") return false;
    const result = value as OverviewWorkerResult, snapshot = "snapshot" in result ? result.snapshot : result;
    if (!("version" in snapshot) || snapshot.version !== query.version || snapshot.priceVersion !== query.priceVersion
      || snapshot.timezone !== query.timezone || !snapshot.range || snapshot.range.today !== query.anchorDay) return false;
    const normalize = (value: OverviewQuery) => this.canonicalQuery({ ...value, models: undefined });
    if (!("query" in snapshot) || JSON.stringify(normalize(snapshot.query)) !== JSON.stringify(normalize(query))) return false;
    if (query.window !== "all") {
      const expected = resolveOverviewRange({ version: query.version!, sessions: [], events: [], resources: [], requests: [], gaps: [] }, query, this.now());
      if (JSON.stringify(snapshot.range) !== JSON.stringify(expected)) return false;
    }
    if (type === "panel") {
      if (!("panel" in result) || !result.data || typeof result.data !== "object") return false;
      const data = result.data;
      return result.panel === "core" ? !!data.summary && Number.isSafeInteger(data.summary.sessions) && !!data.totals && Array.isArray(data.activity?.days) && !!data.facets && !!data.coverage
        : result.panel === "usage" ? !!data.usage?.totals && !!data.distributions && !!data.delegation
        : result.panel === "resources" ? Array.isArray(data.resources?.skills) && Array.isArray(data.resources?.mcp)
        : result.panel === "process" ? Array.isArray(data.process?.tools) && !!data.process?.results
        : result.panel === "repositories" ? Array.isArray(data.repositories)
        : Array.isArray(data.insights) && Array.isArray(data.featuredInsights) && data.insights.length <= 5 && data.featuredInsights.length <= 5;
    }
    if (type === "detail" || type === "evidence") return "rows" in result && Array.isArray(result.rows) && Number.isSafeInteger(result.total);
    if (type === "report") return "summary" in result && Array.isArray(result.featuredInsights) && result.featuredInsights.length <= 5;
    return "query" in result && "range" in result;
  }
  private async usageReport(snapshot: OverviewSnapshot, extra: UsageQuery = {}): Promise<UsageReport> {
    const query = snapshot.query;
    const result = await this.usage.summaryReport({ version: snapshot.version, priceVersion: snapshot.priceVersion, timezone: snapshot.timezone,
      clients: query.clients, projects: query.projects?.map(project => project === "none" ? "unknown" : project),
      ...(snapshot.range.all ? {} : { from: snapshot.range.from, to: snapshot.range.to }), groupBy: "model", interval: "week",
      pageSize: 5, ...extra });
    return { ...result, sessions: result.sessions.map(row => ({ ...row, requests: [], requestsLimited: row.requestsTotal > 0 })) };
  }
  private async payload(type: OverviewWorkerRequest["type"], query: OverviewQuery, extra: Pick<OverviewWorkerRequest, "panel" | "detail" | "evidence">) {
    const payload: Partial<OverviewWorkerRequest> = {};
    if (type === "panel" && extra.panel === "core") {
      payload.globalUsage = await this.usageReport(await this.snapshot(query));
    } else if (type === "panel" && extra.panel === "usage" || type === "detail" && extra.detail?.view === "ranking" && extra.detail.dimension !== "tool") {
      const snapshot = await this.snapshot(query), models = query.models;
      const [clients, projects, model] = await Promise.all([this.usageReport(snapshot, { models, groupBy: "client" }),
        this.usageReport(snapshot, { models, groupBy: "project" }), this.usageReport(snapshot, { models, groupBy: "model" })]);
      payload.usage = model; payload.dimensions = { clients, projects, models: model };
    } else if (type === "panel" && extra.panel === "insights") {
      const snapshot = await this.snapshot(query);
      const comparison = async (period: NonNullable<OverviewSnapshot["range"]["comparison"]>) => {
        const read = (range: typeof period.current, groupBy: "project" | "model", coverage: "complete" | "all" = "complete") => this.usageReport(snapshot,
          { ...range, models: query.models, coverage, groupBy });
        const [current, previous, currentProjects, previousProjects, currentAll, previousAll] = await Promise.all([read(period.current, "model"),
          read(period.previous, "model"), read(period.current, "project", "all"), read(period.previous, "project", "all"),
          this.usageReport(snapshot, { ...period.current, models: query.models }), this.usageReport(snapshot, { ...period.previous, models: query.models })]);
        return { current, previous, currentProjects, previousProjects, currentModels: currentAll, previousModels: previousAll, currentMissing: currentAll.totals.requests - current.totals.requests,
          previousMissing: previousAll.totals.requests - previous.totals.requests };
      };
      payload.insightUsage = { comparison: snapshot.range.comparison ? await comparison(snapshot.range.comparison) : undefined,
        recent: snapshot.range.recent ? await comparison(snapshot.range.recent) : undefined };
    }
    return payload;
  }
  private dispatch(type: OverviewWorkerRequest["type"], query: OverviewQuery, lane: Lane,
    extra: Pick<OverviewWorkerRequest, "panel" | "detail" | "evidence"> = {}, payload: Partial<OverviewWorkerRequest> = {}): Promise<OverviewWorkerResult> {
    if (this.closed) return Promise.reject(stopped());
    const worker = this.workers.get(lane) ?? this.createWorker(lane), id = ++this.nextId;
    clearTimeout(this.idleWorkers.get(lane)); this.idleWorkers.delete(lane);
    return new Promise<OverviewWorkerResult>((resolve, reject) => {
      this.pending.set(id, { lane, resolve, reject });
      try { worker.postMessage({ id, type, query, pricing: this.pricing.view(query.priceVersion).status,
        repositories: this.repositories(), now: this.now().toISOString(), ...extra, ...payload } satisfies OverviewWorkerRequest); }
      catch (error) { this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  /** 同版本、时区只由核心通道回填一次；其他查询等待落盘，避免整库重复准备。 */
  private ensureFacts(query: OverviewQuery): Promise<void> {
    const key = JSON.stringify([query.version, query.timezone]);
    if (this.preparedFacts.has(key)) return Promise.resolve();
    const pending = this.preparingFacts.get(key);
    if (pending) return pending;
    const operation = this.preparation.then(async () => {
      await this.dispatch("prepare", query, "core");
      this.preparedFacts.add(key);
      while (this.preparedFacts.size > 16) this.preparedFacts.delete(this.preparedFacts.values().next().value!);
    }).finally(() => { if (this.preparingFacts.get(key) === operation) this.preparingFacts.delete(key); });
    this.preparingFacts.set(key, operation);
    this.preparation = operation.catch(() => undefined);
    return operation;
  }
  private execute(type: OverviewWorkerRequest["type"], query: OverviewQuery,
    extra: Pick<OverviewWorkerRequest, "panel" | "detail" | "evidence"> = {}): Promise<OverviewWorkerResult> {
    const fixed = this.fixed(query), key = this.key(type, fixed, extra), current = this.inFlight.get(key);
    if (current) return current.then(result => this.bindQuery(result, fixed));
    const cached = this.cache.get(key) ?? this.persisted.get(key, (value): value is OverviewWorkerResult => this.valid(value, fixed, type));
    if (cached) { this.cache.set(key, cached); return Promise.resolve(this.bindQuery(cached, fixed)); }
    const lane: Lane = type === "snapshot" || type === "panel" && extra.panel === "core" ? "core"
      : type === "detail" || type === "evidence" ? "detail" : extra.panel === "repositories" ? "repositories" : "analysis";
    const preparation = type === "panel" && extra.panel === "repositories" && fixed.window !== "all" ? Promise.resolve() : this.ensureFacts(fixed);
    const response = preparation.then(() => this.payload(type, fixed, extra)).then(payload => this.dispatch(type, fixed, lane, extra, payload))
      .then(result => { this.cache.set(key, result); this.persisted.put(key, result); return this.bindQuery(result, fixed); })
      .finally(() => { if (this.inFlight.get(key) === response) this.inFlight.delete(key); });
    this.inFlight.set(key, response); return response;
  }
  async snapshot(query: OverviewQuery): Promise<OverviewSnapshot> {
    const fixed = this.fixed(query);
    if (fixed.window !== "all") {
      const range = resolveOverviewRange({ version: fixed.version!, sessions: [], events: [], requests: [], resources: [], gaps: [] }, fixed, this.now());
      return { version: fixed.version!, priceVersion: fixed.priceVersion!, timezone: fixed.timezone!, query: fixed, range };
    }
    return structuredClone(await this.execute("snapshot", fixed) as OverviewSnapshot);
  }
  async panel(query: OverviewQuery, panel: OverviewPanel): Promise<OverviewPanelResult> {
    const result = await this.execute("panel", query, { panel }) as OverviewPanelResult;
    return structuredClone({ ...result, snapshot: { ...result.snapshot, query: { ...result.snapshot.query, models: query.models } }, data: { ...result.data, ...(result.data.usage
      ? { usage: { ...result.data.usage, pricing: this.pricing.summary(result.snapshot.priceVersion) } } : {}) } });
  }
  async detail(query: OverviewQuery, detail: OverviewDetailQuery): Promise<OverviewDetailPage> {
    return structuredClone(await this.execute("detail", query, { detail }) as OverviewDetailPage);
  }
  async report(query: OverviewQuery): Promise<OverviewReport> {
    const result = await this.execute("report", query) as OverviewReport;
    return structuredClone({ ...result, usage: { ...result.usage, pricing: this.pricing.summary(result.priceVersion) } });
  }
  async evidence(query: OverviewQuery, evidence: OverviewEvidenceQuery): Promise<OverviewEvidencePage> {
    return structuredClone(await this.execute("evidence", query, { evidence }) as OverviewEvidencePage);
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    for (const timer of this.idleWorkers.values()) clearTimeout(timer);
    this.idleWorkers.clear();
    const workers = [...this.workers.values()]; this.workers.clear();
    for (const request of this.pending.values()) request.reject(stopped());
    this.pending.clear(); this.inFlight.clear(); this.preparedFacts.clear(); this.preparingFacts.clear(); this.cache.clear(); this.persisted.close();
    await Promise.all(workers.map(worker => worker.terminate()));
    if (this.ownsUsage) await this.usage.close();
  }
}
