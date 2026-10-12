import { parentPort, workerData } from "node:worker_threads";
import { AnalysisStore, StoreError } from "../index/store.js";
import type { OverviewCountRow, OverviewPanelResult, OverviewQuery, OverviewReport, OverviewResources, OverviewSnapshot } from "../overview-contracts.js";
import { SessionStore } from "../sessions/store.js";
import { ServiceError } from "../service/input.js";
import { createPricingEstimator } from "../usage/pricing.js";
import { usageDimensionValue } from "../usage/dimensions.js";
import type { UsageReport } from "../usage-contracts.js";
import { buildDelegation, buildOverviewReport, buildProcess, buildResources, resourceIdentity, selectedSource, validDuration } from "./analytics.js";
import { buildOverviewEvidence } from "./evidence.js";
import { coreOverviewInsights, generateOverviewInsights } from "./insights.js";
import { buildOverviewRepositories } from "./repositories.js";
import { OverviewFactStore } from "./facts.js";
import { overviewDetail } from "./details.js";
import type { OverviewWorkerRequest, OverviewWorkerResponse } from "./worker-contracts.js";
import { localDay, prepareOverviewDateCache, resolveTimezone } from "./dates.js";

const { dbPath } = workerData as { dbPath: string };
const sessions = new SessionStore(dbPath), repositories = new AnalysisStore(dbPath), facts = new OverviewFactStore(sessions);
const emptyResources = (): OverviewResources => ({ skills: [], mcp: [], observations: [], combinations: { sessions: [], turns: [] }, missingTimeEvents: 0, missingTurnEvents: 0 });
function distribution(report: UsageReport): OverviewCountRow[] {
  return report.groups.map(group => ({ key: group.key, name: usageDimensionValue(group.key) ?? "未知",
    ...(usageDimensionValue(group.key) === undefined ? { nameDescriptor: { key: "overview.unknown" } } : {}),
    count: group.totals.requests, requests: group.totals.requests, sessions: group.totals.sessions,
    tokens: group.totals.tokens, estimatedCost: group.totals.estimatedCost }));
}
function leaders(rows: OverviewCountRow[]): OverviewCountRow[] {
  const result = new Map<string, OverviewCountRow>();
  for (const key of ["count", "tokens", "estimatedCost"] as const) for (const row of [...rows]
    .sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1) || a.key.localeCompare(b.key)).slice(0, 8)) result.set(row.key, row);
  return [...result.values()];
}
function rank(rows: OverviewCountRow[], sort?: string): OverviewCountRow[] {
  const key = sort === "tokens" ? "tokens" : sort === "cost" ? "estimatedCost" : sort === "sessions" ? "sessions" : "count";
  return [...rows].sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1) || a.key.localeCompare(b.key));
}
async function handle(request: OverviewWorkerRequest): Promise<void> {
  try {
    // 版本不可用时不允许从派生缓存或旧修订继续返回。
    const version = sessions.usageVersion(request.query.version), query = request.query, now = new Date(request.now);
    prepareOverviewDateCache(version, resolveTimezone(query.timezone));
    if (!(request.type === "panel" && request.panel === "repositories" || request.type === "detail" && request.detail?.view === "ranking" && request.detail.dimension !== "tool")
      || query.window === "all") await facts.prepare(query, now);
    const snapshot: OverviewSnapshot = { version, priceVersion: request.pricing.version, timezone: query.timezone!, query,
      range: facts.range(query, now) };
    const pricing = { status: request.pricing, estimate: createPricingEstimator(request.pricing) };
    const source = (purpose: "resources" | "process" | "requests" | "evidence", scope = query, options?: { fullSessions?: boolean; sessionIds?: string[]; eventKinds?: ("user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "compression")[] }) => facts.source(scope, purpose, now, options);
    let result;
    if (request.type === "snapshot") result = snapshot;
    else if (request.type === "panel") {
      const panel = request.panel!, output: OverviewPanelResult = { snapshot, panel, data: {} };
      if (panel === "core") output.data = facts.core(query, request.globalUsage!, now);
      else if (panel === "usage") {
        const full = { clients: distribution(request.dimensions!.clients), projects: distribution(request.dimensions!.projects), models: distribution(request.dimensions!.models) };
        const narrow = await source("requests"), selected = selectedSource(narrow, query, snapshot.range), usageSelected = selectedSource(narrow, query, snapshot.range, true);
        const active = facts.activitySessions(query, now);
        output.data = { usage: request.usage, distributions: { clients: leaders(full.clients), projects: leaders(full.projects), models: leaders(full.models) },
          delegation: buildDelegation(narrow, selected, usageSelected, new Set(active.activeIds), snapshot.timezone, undefined, new Set(active.datedIds)) };
        output.counts = { clients: full.clients.length, projects: full.projects.length, models: full.models.length };
      } else if (panel === "resources") {
        const narrow = await source("resources"), resources = buildResources(narrow, selectedSource(narrow, query, snapshot.range), snapshot.range, snapshot.timezone, false);
        const skills = resources.skills.slice(0, 5), mcp = resources.mcp.slice(0, 5), ids = new Set([...skills, ...mcp].map(row => row.id));
        const days = new Map<string, Map<string, { uses: number; sessions: Set<string> }>>();
        for (const event of selectedSource(narrow, query, snapshot.range).resources) {
          const id = resourceIdentity(event); if (!ids.has(id)) continue;
          const day = localDay(event.occurredAt, snapshot.timezone); if (!day) continue;
          const trend = days.get(id) ?? new Map<string, { uses: number; sessions: Set<string> }>(), point = trend.get(day) ?? { uses: 0, sessions: new Set<string>() };
          point.uses++; point.sessions.add(event.sessionId); trend.set(day, point); days.set(id, trend);
        }
        for (const row of [...skills, ...mcp]) row.days = [...(days.get(row.id) ?? [])].sort(([a], [b]) => a.localeCompare(b))
          .map(([day, point]) => ({ day, uses: point.uses, sessions: point.sessions.size }));
        output.data = { resources: { ...resources, skills, mcp } };
        output.counts = { skills: resources.skills.length, mcp: resources.mcp.length };
      } else if (panel === "process") {
        const narrow = await source("process"), selected = selectedSource(narrow, query, snapshot.range), usage = selectedSource(narrow, query, snapshot.range, true);
        const process = buildProcess(narrow, selected, usage, snapshot.timezone, undefined, false);
        process.missingTimingRequests = usage.requests.filter(row => !validDuration(row.usage)).length;
        const tools = new Map(process.tools.slice(0, 8).map(row => [row.key, row]));
        for (const row of [...process.tools].sort((a, b) => b.results.failure - a.results.failure).slice(0, 5)) if (row.results.failure) tools.set(row.key, row);
        output.counts = { tools: process.tools.length }; output.data = { process: { ...process, tools: [...tools.values()] } };
      } else if (panel === "repositories") output.data = { repositories: buildOverviewRepositories(repositories, request.repositories,
        facts.snapshot(query), query, snapshot.range, snapshot.timezone) };
      else if (panel === "insights") {
        const resourcesSource = await source("resources"), processSource = await source("process");
        const resources = buildResources(resourcesSource, selectedSource(resourcesSource, query, snapshot.range), snapshot.range, snapshot.timezone, false);
        const process = buildProcess(processSource, selectedSource(processSource, query, snapshot.range), { ...processSource, requests: [] }, snapshot.timezone, undefined, false);
        const previous = snapshot.range.comparison?.previous;
        let previousResources: OverviewResources | undefined, currentResources: OverviewResources | undefined;
        if (previous) {
          const previousQuery: OverviewQuery = { ...query, window: "custom", ...previous };
          const previousSource = await source("resources", previousQuery);
          previousResources = buildResources(previousSource, selectedSource(previousSource, previousQuery, { ...snapshot.range, ...previous }),
            { ...snapshot.range, ...previous }, snapshot.timezone, false);
          const current = snapshot.range.comparison!.current, currentQuery = { ...query, window: "custom" as const, ...current };
          const currentSource = await source("resources", currentQuery);
          currentResources = buildResources(currentSource, selectedSource(currentSource, currentQuery, { ...snapshot.range, ...current }),
            { ...snapshot.range, ...current }, snapshot.timezone, false);
        }
        output.data = coreOverviewInsights({ query, range: snapshot.range, priceVersion: snapshot.priceVersion, resources, process },
          { ...request.insightUsage, previousResources, currentResources });
      }
      result = output;
    } else if (request.type === "detail") {
      const detail = request.detail!, purpose = detail.view === "resource" || detail.view === "resources" || detail.view === "observations" || detail.view === "combinations"
        ? "resources" : detail.view === "timing" || detail.view === "timings" || detail.dimension === "tool" ? "process" : "requests";
      const narrow = request.dimensions && detail.view === "ranking" ? facts.snapshot(query)
        : await source(purpose, query, { fullSessions: detail.view === "transitions", ...(detail.view === "months" ? { eventKinds: ["user", "assistant", "thinking", "tool_call", "tool_result", "compression"] as ("user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "compression")[] } : {}) });
      let ranking: OverviewCountRow[] | undefined;
      if (detail.view === "ranking") {
        ranking = detail.dimension === "tool" ? buildProcess(narrow, selectedSource(narrow, query, snapshot.range), { ...narrow, requests: [] }, snapshot.timezone, undefined, false).tools
          : distribution(request.dimensions![detail.dimension === "client" ? "clients" : detail.dimension === "project" ? "projects" : "models"]);
        ranking = rank(ranking, detail.sort);
      }
      result = overviewDetail(narrow, snapshot, detail, ranking);
    } else if (request.type === "evidence") {
      const evidence = request.evidence!;
      // 兼容调查口径先保留所选会话完整顺序，追加条件在证据构建中只缩小范围。
      const narrow = await source("evidence", query, { fullSessions: true, ...(evidence.sessionId ? { sessionIds: [evidence.sessionId] } : {}) });
      result = buildOverviewEvidence(narrow, query, evidence, pricing, now);
    } else {
      const narrow = await source("evidence", query, { fullSessions: true });
      const report = buildOverviewReport(narrow, query, pricing, now);
      report.repositories = buildOverviewRepositories(repositories, request.repositories, facts.snapshot(query), query, report.range, report.timezone);
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
parentPort!.on("close", () => { facts.close(); sessions.close(); repositories.close(); });
