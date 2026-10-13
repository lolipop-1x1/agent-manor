import { parentPort, workerData } from "node:worker_threads";
import { AnalysisStore, StoreError } from "../index/store.js";
import type { OverviewCountRow, OverviewPanelResult, OverviewQuery, OverviewSnapshot } from "../overview-contracts.js";
import { SessionStore } from "../sessions/store.js";
import { ServiceError } from "../service/input.js";
import { createPricingEstimator } from "../usage/pricing.js";
import { usageDimensionValue } from "../usage/dimensions.js";
import type { UsageStatistics } from "../usage-contracts.js";
import { buildOverviewReport } from "./analytics.js";
import { factEvidence } from "./evidence-facts.js";
import { coreOverviewInsights, generateOverviewInsights } from "./insights.js";
import { buildOverviewRepositories } from "./repositories.js";
import { OverviewFactStore } from "./facts.js";
import { factDelegation, factDetail, factProcess, factResourceCandidates, factResources, usageRankingDetail } from "./details.js";
import type { OverviewWorkerRequest, OverviewWorkerResponse } from "./worker-contracts.js";
import { WeeklyReviewFactStore } from "./weekly-review-facts.js";
import { buildWeeklyReview, weeklyReviewDetail } from "./weekly-review.js";
import { prepareOverviewDateCache, resolveOverviewRange, resolveTimezone } from "./dates.js";

const { dbPath, preparesFacts, reviewOnly } = workerData as { dbPath: string; preparesFacts?: boolean; reviewOnly?: boolean };
// 统计通道只读已发布源索引，回填只写各自派生库，避免与历史刷新争锁。
const sessions = new SessionStore(dbPath, { readonly: true }), repositories = reviewOnly ? undefined : new AnalysisStore(dbPath, { readonly: true });
let factStore: OverviewFactStore | undefined;
let weeklyFacts: WeeklyReviewFactStore | undefined;
let weeklyData: { key: string; data: ReturnType<typeof buildWeeklyReview> } | undefined;
let weeklyPending: { key: string; promise: Promise<ReturnType<typeof buildWeeklyReview>> } | undefined;
let weeklyQueue: Promise<unknown> = Promise.resolve();
function preparedWeeklyReview(request: OverviewWorkerRequest, now: Date): Promise<ReturnType<typeof buildWeeklyReview>> {
  const query = request.query, key = JSON.stringify([query.version, request.pricing.version, query.timezone, query.anchorDay, query.clients, query.projects]);
  if (weeklyData?.key === key) return Promise.resolve(weeklyData.data);
  if (weeklyPending?.key === key) return weeklyPending.promise;
  const promise = weeklyQueue.catch(() => undefined).then(async () => {
    if (weeklyData?.key === key) return weeklyData.data;
    // 一次仅保留一个固定查询的中间聚合，详情复用价格与排行，不重复读取全部请求。
    weeklyData = undefined;
    const { facts } = await (weeklyFacts ??= new WeeklyReviewFactStore(sessions)).source(query, now);
    const pricing = { status: request.pricing, estimate: createPricingEstimator(request.pricing, true) };
    const data = buildWeeklyReview(facts, query, pricing, now);
    weeklyData = { key, data }; return data;
  }).finally(() => { if (weeklyPending?.promise === promise) weeklyPending = undefined; });
  weeklyPending = { key, promise }; weeklyQueue = promise; return promise;
}
const facts = (writer = false) => factStore ??= new OverviewFactStore(sessions, { repairCorruption: writer || preparesFacts, readonly: !(writer || preparesFacts) });
function distribution(report: UsageStatistics): OverviewCountRow[] {
  return report.groups.map(group => ({ key: group.key, name: usageDimensionValue(group.key) ?? "未知",
    ...(usageDimensionValue(group.key) === undefined ? { nameDescriptor: { key: "overview.unknown" } } : {}),
    count: group.totals.requests, requests: group.totals.requests, sessions: group.totals.sessions,
    tokens: group.totals.tokens, estimatedCost: group.totals.estimatedCost,
    costCoverage: group.totals.estimatedCost === null ? "missing"
      : group.totals.partiallyPricedRequests || group.totals.unpricedRequests ? "partial" : "complete" }));
}
function leaders(rows: OverviewCountRow[]): OverviewCountRow[] {
  const result = new Map<string, OverviewCountRow>();
  for (const key of ["count", "tokens", "estimatedCost"] as const) for (const row of [...rows]
    .sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1) || a.key.localeCompare(b.key)).slice(0, 8)) result.set(row.key, row);
  return [...result.values()];
}
async function handle(request: OverviewWorkerRequest): Promise<void> {
  try {
    // 版本不可用时不允许从派生缓存或旧修订继续返回。
    const version = sessions.usageVersion(request.query.version), query = request.query, now = new Date(request.now);
    prepareOverviewDateCache(version, resolveTimezone(query.timezone));
    if (request.type === "review" || request.type === "review_detail") {
      const data = await preparedWeeklyReview(request, now);
      const result = request.type === "review" ? data.review : weeklyReviewDetail(data, request.reviewDetail!);
      // 与持久JSON缓存使用相同可序列化形态，重启复用不改变缺失字段。
      parentPort!.postMessage({ id: request.id, type: "result", result: JSON.parse(JSON.stringify(result)) } satisfies OverviewWorkerResponse);
      return;
    }
    if (request.type === "prepare") await facts(true).prepare(query, now);
    else if (!(request.type === "panel" && request.panel === "repositories" || request.type === "detail" && request.detail?.view === "ranking" && request.detail.dimension !== "tool")
      || query.window === "all") facts().sqlScope(query, now);
    const metadata = () => ({ version, sessions: sessions.usageFactSessions(version).sessions.map(row => row.session),
      events: [], requests: [], resources: [], gaps: sessions.overviewGaps(version) });
    const snapshot: OverviewSnapshot = { version, priceVersion: request.pricing.version, timezone: query.timezone!, query,
      range: factStore ? factStore.range(query, now) : resolveOverviewRange(metadata(), query, now) };
    const pricing = { status: request.pricing, estimate: createPricingEstimator(request.pricing) };
    const source = (purpose: "resources" | "process" | "requests" | "evidence", scope = query, options?: { fullSessions?: boolean; sessionIds?: string[]; eventKinds?: ("user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "compression")[] }) => facts().source(scope, purpose, now, { ...options, prepared: true });
    let result;
    if (request.type === "snapshot" || request.type === "prepare") result = snapshot;
    else if (request.type === "panel") {
      const panel = request.panel!, output: OverviewPanelResult = { snapshot, panel, data: {}, ...(request.dimension ? { dimension: request.dimension } : {}) };
      if (panel === "core") output.data = facts().core(query, request.globalUsage!, now);
      else if (panel === "usage") output.data = { usage: request.usage };
      else if (panel === "distribution") {
        const rows = distribution(request.usage!);
        output.data = { distribution: leaders(rows) };
        output.counts = { [request.dimension === "client" ? "clients" : request.dimension === "project" ? "projects" : "models"]: rows.length };
      } else if (panel === "delegation") output.data = { delegation: factDelegation(facts(), snapshot, now) };
      else if (panel === "facets") output.data = { facets: facts().facets(query) };
      else if (panel === "resources") {
        const result = factResources(facts(), snapshot, now); output.data = { resources: result.resources }; output.counts = result.counts;
      } else if (panel === "process") {
        const result = factProcess(facts(), snapshot, now);
        output.data = { process: result.process }; output.counts = result.counts;
      } else if (panel === "repositories") output.data = { repositories: buildOverviewRepositories(repositories!, request.repositories,
        factStore ? factStore.snapshot(query) : metadata(), query, snapshot.range, snapshot.timezone) };
      else if (panel === "insights") {
        const { resources, previousResources, currentResources } = factResourceCandidates(facts(), snapshot, now), { process } = factProcess(facts(), snapshot, now, true);
        output.data = coreOverviewInsights({ query, range: snapshot.range, priceVersion: snapshot.priceVersion, resources, process },
          { ...request.insightUsage, previousResources, currentResources });
      }
      result = output;
    } else if (request.type === "detail") {
      const detail = request.detail!;
      result = detail.view === "ranking" && detail.dimension !== "tool"
        ? usageRankingDetail(request.usage!, snapshot, detail)
        : factDetail(facts(), snapshot, detail, now);
    } else if (request.type === "evidence") {
      const evidence = request.evidence!;
      result = await factEvidence(facts(), snapshot, evidence, pricing, now);
    } else {
      const narrow = await source("evidence", query, { fullSessions: true });
      const report = buildOverviewReport(narrow, query, pricing, now);
      report.repositories = buildOverviewRepositories(repositories!, request.repositories, facts().snapshot(query), query, report.range, report.timezone);
      Object.assign(report, generateOverviewInsights(narrow, query, pricing, report));
      report.process.failureSequences = []; result = report;
    }
    parentPort!.postMessage({ id: request.id, type: "result", result } satisfies OverviewWorkerResponse);
  } catch (error) {
    const known = error instanceof StoreError || error instanceof ServiceError;
    parentPort!.postMessage({ id: request.id, type: "error", error: { code: known ? error.code : "INTERNAL_ERROR",
      message: known ? error.message : "总览统计失败", messageDescriptor: known ? error.messageDescriptor : { key: "diagnostics.server.m003" } } } satisfies OverviewWorkerResponse);
  }
}
parentPort!.on("message", (request: OverviewWorkerRequest) => { void handle(request); });
parentPort!.on("close", () => { factStore?.close(); weeklyFacts?.close(); sessions.close(); repositories?.close(); });
