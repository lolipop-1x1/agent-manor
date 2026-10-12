import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import type { Repository } from "../contracts.js";
import { StoreError } from "../index/store.js";
import type { OverviewDetailPage, OverviewDetailQuery, OverviewDistributionDimension, OverviewEvidencePage, OverviewEvidenceQuery, OverviewPanel,
  OverviewPanelResult, OverviewQuery, OverviewReport, OverviewSnapshot, WeeklyReview, WeeklyReviewDetailPage, WeeklyReviewDetailQuery } from "../overview-contracts.js";
import type { SessionStore } from "../sessions/store.js";
import { UsageResultCache } from "../usage/cache.js";
import { UsageManager } from "../usage/manager.js";
import type { PricingService } from "../usage/pricing.js";
import type { UsageQuery, UsageStatistics, UsageStatisticsView } from "../usage-contracts.js";
import type { OverviewWorkerRequest, OverviewWorkerResponse, OverviewWorkerResult } from "./worker-contracts.js";
import { localDay, resolveOverviewRange, resolveTimezone } from "./dates.js";
import { weeklyReviewRange } from "./weekly-review-facts.js";
import { OverviewResultStore } from "./result-store.js";

type Lane = "core" | "usage" | "analysis" | "detail" | "repositories" | "review";
type RequestExtra = Pick<OverviewWorkerRequest, "panel" | "dimension" | "detail" | "evidence" | "reviewDetail">;
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
    const url = new URL(`./worker.${extension}`, import.meta.url), workerData = { dbPath: this.sessions.dbPath, preparesFacts: lane === "core", reviewOnly: lane === "review" };
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
        }, lane === "repositories" ? 0 : lane === "review" ? 120000 : 2000);
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
    const semantic = type === "panel" && ["core", "resources", "repositories", "facets"].includes(panel ?? "") ? { ...query, models: undefined } : query;
    return JSON.stringify([type === "review" || type === "review_detail" ? "weekly-review-v7" : 6, type, this.canonicalQuery(semantic), extra,
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
  private valid(value: unknown, query: OverviewQuery, type: OverviewWorkerRequest["type"], extra: RequestExtra): value is OverviewWorkerResult {
    if (!value || typeof value !== "object") return false;
    const result = value as OverviewWorkerResult, snapshot = "snapshot" in result ? result.snapshot : result;
    if (!("version" in snapshot) || snapshot.version !== query.version || snapshot.priceVersion !== query.priceVersion
      || snapshot.timezone !== query.timezone || !snapshot.range || snapshot.range.today !== query.anchorDay) return false;
    if (type === "review" || type === "review_detail") {
      if (JSON.stringify(snapshot.range) !== JSON.stringify(weeklyReviewRange(query, this.now()))) return false;
      return type === "review" ? "rounds" in result && !!result.rounds.steps && "preferences" in result
        : "rows" in result && Array.isArray(result.rows) && Number.isSafeInteger(result.total);
    }
    const global = type === "panel" && ["core", "resources", "repositories", "facets"].includes(extra.panel ?? "");
    const normalize = (value: OverviewQuery) => this.canonicalQuery(global ? { ...value, models: undefined } : value);
    if (query.window !== "all") {
      const expected = resolveOverviewRange({ version: query.version!, sessions: [], events: [], resources: [], requests: [], gaps: [] }, query, this.now());
      if (JSON.stringify(snapshot.range) !== JSON.stringify(expected)) return false;
    }
    if (type === "evidence") return "rows" in result && Array.isArray(result.rows) && Number.isSafeInteger(result.total);
    if (!("query" in snapshot) || JSON.stringify(normalize(snapshot.query)) !== JSON.stringify(normalize(query))) return false;
    if (type === "panel") {
      if (!("panel" in result) || result.panel !== extra.panel || result.dimension !== extra.dimension || !result.data || typeof result.data !== "object") return false;
      const data = result.data;
      return result.panel === "core" ? !!data.summary && Number.isSafeInteger(data.summary.sessions) && !!data.totals && Array.isArray(data.activity?.days) && !!data.delegationSummary && !!data.coverage
        : result.panel === "usage" ? !!data.usage?.totals && Array.isArray(data.usage.days) && !("sessions" in data.usage)
        : result.panel === "distribution" ? Array.isArray(data.distribution)
        : result.panel === "delegation" ? !!data.delegation && Number.isSafeInteger(data.delegation.assignedRequests)
        : result.panel === "facets" ? Array.isArray(data.facets?.clients) && Array.isArray(data.facets?.projects) && Array.isArray(data.facets?.models)
        : result.panel === "resources" ? Array.isArray(data.resources?.skills) && Array.isArray(data.resources?.mcp)
        : result.panel === "process" ? Array.isArray(data.process?.tools) && !!data.process?.results
        : result.panel === "repositories" ? Array.isArray(data.repositories)
        : Array.isArray(data.insights) && Array.isArray(data.featuredInsights) && data.insights.length <= 5 && data.featuredInsights.length <= 5;
    }
    if (type === "detail") return "rows" in result && Array.isArray(result.rows) && Number.isSafeInteger(result.total);
    if (type === "report") return "summary" in result && Array.isArray(result.featuredInsights) && result.featuredInsights.length <= 5;
    return "query" in result && "range" in result;
  }
  private usageStatistics(snapshot: OverviewSnapshot, view: UsageStatisticsView, extra: UsageQuery = {}): Promise<UsageStatistics> {
    const query = snapshot.query;
    return this.usage.statistics({ version: snapshot.version, priceVersion: snapshot.priceVersion, timezone: snapshot.timezone,
      clients: query.clients, projects: query.projects?.map(project => project === "none" ? "unknown" : project),
      ...(snapshot.range.all ? {} : { from: snapshot.range.from, to: snapshot.range.to }), groupBy: "model", interval: "week", ...extra }, view);
  }
  private async payload(type: OverviewWorkerRequest["type"], query: OverviewQuery, extra: RequestExtra) {
    const payload: Partial<OverviewWorkerRequest> = {};
    if (type === "panel" && extra.panel === "core") {
      payload.globalUsage = await this.usageStatistics(await this.snapshot(query), "totals");
    } else if (type === "panel" && extra.panel === "process" && query.models?.length) {
      const global = await this.panel({ ...query, models: undefined }, "process");
      payload.globalProcess = { process: global.data.process!, counts: global.counts };
    } else if (type === "panel" && extra.panel === "usage") {
      payload.usage = await this.usageStatistics(await this.snapshot(query), "trend", { models: query.models });
    } else if (type === "panel" && extra.panel === "distribution" || type === "detail" && extra.detail?.view === "ranking" && extra.detail.dimension !== "tool") {
      const dimension = extra.dimension ?? extra.detail?.dimension ?? "model";
      payload.usage = await this.usageStatistics(await this.snapshot(query), "distribution", {
        models: query.models, groupBy: dimension as OverviewDistributionDimension });
    } else if (type === "panel" && extra.panel === "insights") {
      const snapshot = await this.snapshot(query);
      const comparison = async (period: NonNullable<OverviewSnapshot["range"]["comparison"]>) => {
        const read = (range: typeof period.current, groupBy: "project" | "model", coverage: "complete" | "all" = "complete") => this.usageStatistics(snapshot,
          coverage === "complete" ? "totals" : "distribution", { ...range, models: query.models, coverage, groupBy });
        const [current, previous, currentProjects, previousProjects, currentAll, previousAll] = await Promise.all([read(period.current, "model"),
          read(period.previous, "model"), read(period.current, "project", "all"), read(period.previous, "project", "all"),
          read(period.current, "model", "all"), read(period.previous, "model", "all")]);
        return { current, previous, currentProjects, previousProjects, currentModels: currentAll, previousModels: previousAll, currentMissing: currentAll.totals.requests - current.totals.requests,
          previousMissing: previousAll.totals.requests - previous.totals.requests };
      };
      const recent = async (period: NonNullable<OverviewSnapshot["range"]["recent"]>) => {
        const read = (range: typeof period.current, coverage: "complete" | "all") => this.usageStatistics(snapshot, "totals",
          { ...range, models: query.models, coverage });
        const [current, previous, currentAll, previousAll] = await Promise.all([read(period.current, "complete"), read(period.previous, "complete"),
          read(period.current, "all"), read(period.previous, "all")]);
        return { current, previous, currentMissing: currentAll.totals.requests - current.totals.requests,
          previousMissing: previousAll.totals.requests - previous.totals.requests };
      };
      payload.insightUsage = { comparison: snapshot.range.comparison ? await comparison(snapshot.range.comparison) : undefined,
        recent: snapshot.range.recent ? await recent(snapshot.range.recent) : undefined };
    }
    return payload;
  }
  private dispatch(type: OverviewWorkerRequest["type"], query: OverviewQuery, lane: Lane,
    extra: RequestExtra = {}, payload: Partial<OverviewWorkerRequest> = {}): Promise<OverviewWorkerResult> {
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
    extra: RequestExtra = {}): Promise<OverviewWorkerResult> {
    const fixed = this.fixed(query), key = this.key(type, fixed, extra), current = this.inFlight.get(key);
    if (current) return current.then(result => this.bindQuery(result, fixed));
    const cached = this.cache.get(key) ?? this.persisted.get(key, (value): value is OverviewWorkerResult => this.valid(value, fixed, type, extra));
    if (cached) { this.cache.set(key, cached); return Promise.resolve(this.bindQuery(cached, fixed)); }
    const lane: Lane = type === "review" || type === "review_detail" ? "review" : type === "snapshot" || type === "panel" && extra.panel === "core" ? "core"
      : type === "panel" && ["usage", "distribution", "facets"].includes(extra.panel ?? "") ? "usage"
      : type === "detail" || type === "evidence" ? "detail" : extra.panel === "repositories" ? "repositories" : "analysis";
    const preparation = type === "review" || type === "review_detail" || type === "panel" && extra.panel === "repositories" && fixed.window !== "all" ? Promise.resolve() : this.ensureFacts(fixed);
    const response = preparation.then(() => this.payload(type, fixed, extra)).then(payload => this.dispatch(type, fixed, lane, extra, payload))
      .then(result => {
        if (!this.valid(result, fixed, type, extra)) throw new StoreError("INTERNAL_ERROR", "总览统计快照不匹配", { key: "diagnostics.server.m003" });
        this.cache.set(key, result); this.persisted.put(key, result); return this.bindQuery(result, fixed);
      })
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
  async panel(query: OverviewQuery, panel: OverviewPanel, dimension?: OverviewDistributionDimension): Promise<OverviewPanelResult> {
    if (panel === "distribution" ? !dimension || !["client", "project", "model"].includes(dimension) : dimension !== undefined) {
      throw new StoreError("INVALID_INPUT", "无效总览参数：dimension", { key: "diagnostics.usage.input.invalid", params: { field: "dimension" } });
    }
    const result = await this.execute("panel", query, { panel, ...(dimension ? { dimension } : {}) }) as OverviewPanelResult;
    return structuredClone({ ...result, snapshot: { ...result.snapshot, query: { ...result.snapshot.query, models: query.models } } });
  }
  async detail(query: OverviewQuery, detail: OverviewDetailQuery): Promise<OverviewDetailPage> {
    return structuredClone(await this.execute("detail", query, { detail }) as OverviewDetailPage);
  }
  private reviewQuery(query: OverviewQuery): OverviewQuery {
    const fixed = this.fixed(query), range = weeklyReviewRange(fixed, this.now());
    return { ...fixed, window: "custom", from: range.from, to: range.to, models: undefined };
  }
  async review(query: OverviewQuery): Promise<WeeklyReview> {
    return structuredClone(await this.execute("review", this.reviewQuery(query)) as WeeklyReview);
  }
  async reviewDetail(query: OverviewQuery, reviewDetail: WeeklyReviewDetailQuery): Promise<WeeklyReviewDetailPage> {
    return structuredClone(await this.execute("review_detail", this.reviewQuery(query), { reviewDetail }) as WeeklyReviewDetailPage);
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
