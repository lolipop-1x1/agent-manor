import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import test from "node:test";
import Database from "better-sqlite3";
import type { SessionSourceMeta, SessionSummary, SessionUsage } from "../src/session-contracts.js";
import type { PricingStatus, UsageQuery, UsageReport, UsageSource, UsageStatistics, UsageStatisticsView } from "../src/usage-contracts.js";
import { SessionStore, type SessionRevision } from "../src/sessions/store.js";
import { buildUsageReport, buildUsageStatistics } from "../src/usage/analytics.js";
import { UsageManager } from "../src/usage/manager.js";
import { createPricingEstimator, PricingService } from "../src/usage/pricing.js";
import { buildUsageRollup, buildUsageRollupStatistics, canUseUsageRollup } from "../src/usage/rollup.js";
import type { UsageWorkerRequest } from "../src/usage/worker-contracts.js";

const pricing: PricingStatus = { version: "prices-statistics", source: "bundled", sourceUrl: "https://example.invalid/prices",
  refreshing: false, currency: "USD", configuration: { overrides: [
    { model: "synthetic-model", input: 2, output: 5, cacheRead: 0.2, cacheWrite: 3 },
    { model: "unknown", input: 1, output: 4, cacheRead: 0.1, cacheWrite: 2 },
    { model: "literal:unknown", input: 3, output: 6, cacheRead: 0.3, cacheWrite: 4 },
  ], mappings: [] }, prices: [] };
const estimate = createPricingEstimator(pricing);
const views: UsageStatisticsView[] = ["totals", "trend", "distribution"];
function session(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, client: "codex", clientSessionId: id, title: "合成统计会话", titleOrigin: "recorded", models: [],
    messageCount: 1, turnCount: 1, gaps: [], ...extra };
}
function usage(id: string, extra: Partial<SessionUsage> = {}): SessionUsage {
  return { id, model: "synthetic-model", inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, cacheWriteTokens: 0,
    occurredAt: "2026-01-02T01:00:00Z", ...extra };
}
const mixed: UsageSource = { version: "statistics-index", sessions: [
  session("parent", { project: "/workspace/a", childSessionIds: ["child"] }),
  session("child", { client: "claude", project: "/workspace/b", relationship: "child", parentSessionId: "parent" }),
  session("quiet", { project: "unknown", executionMode: "quiet" }),
  session("fork", { project: "literal:unknown", relationship: "fork", parentSessionId: "parent" }),
  session("empty"), session("undated"),
], requests: [
  ...Array.from({ length: 35 }, (_, index) => ({ sessionId: index % 2 ? "parent" : "child", usage: usage(`request-${index}`, {
    model: index % 5 === 0 ? "unpriced-model" : "synthetic-model", inputTokens: index % 7 ? 100 + index : undefined,
    outputTokens: index % 11 ? index : undefined, cachedInputTokens: index % 3 ? 10 : undefined,
    occurredAt: `2026-01-${String(1 + index % 4).padStart(2, "0")}T01:00:00Z`,
  }) })),
  { sessionId: "quiet", usage: usage("literal", { model: "unknown" }) },
  { sessionId: "fork", usage: usage("escaped", { model: "literal:unknown" }) },
  { sessionId: "fork", usage: usage("missing-model", { model: undefined }) },
  { sessionId: "child", usage: usage("zero", { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }) },
  { sessionId: "undated", usage: usage("invalid-date", { occurredAt: "2026-02-30T00:00:00Z" }) },
  { sessionId: "undated", usage: usage("no-date", { occurredAt: undefined, cachedInputTokens: undefined }) },
] };

function project(report: UsageReport, view: UsageStatisticsView): UsageStatistics {
  return { version: report.version, priceVersion: report.priceVersion, timezone: report.timezone, query: report.query,
    totals: report.totals, undated: report.undated, facets: report.facets,
    days: view === "trend" ? report.days.map(day => ({ ...day, groups: [] })) : [],
    groups: view === "distribution" ? report.groups : [] };
}
function rounded(value: unknown): unknown {
  if (typeof value === "number") return Number.isInteger(value) ? value : Number(value.toPrecision(12));
  if (Array.isArray(value)) return value.map(rounded);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rounded(item)]));
  return value;
}

test("三种轻量视图与完整报告在筛选、覆盖、阈值、日期和未知身份下等价", () => {
  const rollup = buildUsageRollup(mixed, "UTC", estimate);
  const queries: UsageQuery[] = [{}, { from: "2026-01-01", to: "2026-01-06" }, { from: "2026-01-02", to: "2026-01-02" },
    { from: "2026-01-02T01:00:00Z", to: "2026-01-03T01:00:00Z" }, { minTokens: 100, maxTokens: 1500 },
    { minCost: 0.00001 }, { maxCost: 0 }, { metric: "cost", sort: "cost" }, { page: 8, pageSize: 1 },
    { clients: ["codex"], excludeProjects: ["/workspace/a"] }, { projects: ["literal:unknown"] },
    { projects: ["literal:literal:unknown"] }, { models: ["unknown"] }, { models: ["literal:unknown"] },
    { models: ["literal:literal:unknown"] }, { excludeModels: ["unknown", "synthetic-model"] }];
  for (const relationship of ["all", "main", "child"] as const) queries.push({ relationship });
  for (const sessionType of ["all", "interactive", "automation", "fork"] as const) queries.push({ sessionType });
  for (const coverage of ["all", "complete", "partial", "missing"] as const) {
    for (const costCoverage of ["all", "complete", "partial", "missing"] as const) queries.push({ coverage, pricing: costCoverage });
  }
  for (const groupBy of ["project", "model", "client"] as const) {
    for (const interval of ["hour", "day", "week", "month"] as const) queries.push({ groupBy, interval, metric: "requests" });
  }
  for (const patch of queries) {
    const query = { timezone: "UTC", ...patch };
    const oracle = buildUsageReport(mixed, query, pricing, estimate);
    for (const view of views) {
      const expected = rounded(project(oracle, view));
      assert.deepEqual(rounded(buildUsageStatistics(mixed, query, pricing, estimate, view)), expected, JSON.stringify([query, view]));
      if (canUseUsageRollup(query)) assert.deepEqual(rounded(buildUsageRollupStatistics(rollup, query, pricing, view)), expected);
    }
  }
});

test("轻量统计不读取汇总预览或排序请求证据，趋势也不构建维度分组", () => {
  const rollup = buildUsageRollup(mixed, "UTC", estimate);
  for (const cell of rollup.cells) {
    Object.defineProperty(cell, "previews", { get() { throw new Error("轻量统计不能读取预览"); } });
    Object.defineProperty(cell, "latestTime", { get() { throw new Error("轻量统计不能构建会话最近证据"); } });
  }
  for (const view of views) {
    const result = buildUsageRollupStatistics(rollup, { timezone: "UTC", groupBy: "model" }, pricing, view);
    assert.equal(result.totals.requests, mixed.requests.length);
    assert.deepEqual(Object.keys(result).sort(), ["version", "priceVersion", "timezone", "query", "totals", "undated", "days", "groups", "facets"].sort());
    if (view !== "distribution") assert.deepEqual(result.groups, []);
    if (view !== "trend") assert.deepEqual(result.days, []);
    else assert.ok(result.days.every(day => day.groups.length === 0));
    const guarded = structuredClone(mixed);
    for (const request of guarded.requests) {
      const id = request.usage.id;
      let reads = 0;
      Object.defineProperty(request.usage, "id", { get() {
        assert.equal(++reads, 1, "请求身份只用于去重，不再进入会话预览排序"); return id;
      } });
    }
    assert.deepEqual(rounded(buildUsageStatistics(guarded, { timezone: "UTC", groupBy: "model" }, pricing, estimate, view)), rounded(result));
  }
  assert.throws(() => buildUsageReport(mixed, { timezone: "invalid/timezone" }, pricing, estimate));
  for (const view of views) assert.throws(() => buildUsageRollupStatistics(rollup, { timezone: "invalid/timezone" }, pricing, view));
});

test("空索引、跨时区日期和缺时间独立小计保持轻量报告口径", () => {
  const input = { ...mixed, sessions: [session("dated"), session("undated")], requests: [
    { sessionId: "dated", usage: usage("boundary", { occurredAt: "2026-01-01T16:00:00Z" }) },
    { sessionId: "undated", usage: usage("missing-time", { occurredAt: undefined }) },
  ] };
  for (const source of [input, { ...input, sessions: [], requests: [] }]) {
    const rollup = buildUsageRollup(source, "Asia/Shanghai", estimate);
    const query = { timezone: "Asia/Shanghai", from: "2026-01-02", to: "2026-01-03" };
    for (const view of views) assert.deepEqual(rounded(buildUsageRollupStatistics(rollup, query, pricing, view)),
      rounded(project(buildUsageReport(source, query, pricing, estimate), view)));
  }
  const selected = buildUsageStatistics(input, { timezone: "UTC", from: "2026-01-01", to: "2026-01-01" }, pricing, estimate, "trend");
  assert.equal(selected.totals.requests, 1); assert.equal(selected.undated.requests, 1);
  assert.equal(selected.totals.cacheReadRatio, 0.4); assert.equal(selected.totals.cacheReadRatioRequests, 1);
});

async function fixture(run: (store: SessionStore, prices: PricingService, cachePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "manor-usage-statistics-")), store = new SessionStore(join(directory, "index.sqlite"));
  const prices = new PricingService(directory, { fetch: (async () => { throw new Error("synthetic network failure"); }) as typeof fetch });
  prices.configure(pricing.configuration);
  try { await run(store, prices, join(directory, "rollup.sqlite")); }
  finally { prices.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
}
function add(store: SessionStore, id: string, usages: SessionUsage[], extra: Partial<SessionSourceMeta> = {}, copied = false): SessionRevision {
  const summary: SessionSourceMeta = { id, client: "codex", clientSessionId: id, title: "人工合成统计会话", titleOrigin: "recorded",
    path: `/workspace/history/${id}.jsonl`, sourceId: `codex:${id}`, messageCount: 1, turnCount: 1, models: [], gaps: [], ...extra };
  const pending = store.createRevision(summary.path, "synthetic-statistics");
  pending.sink.message({ id: "message", sessionId: id, ordinal: 0, recordLine: 1, turnId: "turn", kind: "assistant", text: "合成证据", copied });
  for (const value of usages) pending.sink.usage(value);
  pending.flush(); store.finishRevision(pending.revision, summary);
  return { path: summary.path, revision: pending.revision, fingerprint: "synthetic-statistics" };
}

test("Worker 轻量冷查询、视图缓存与重启保留复制排除和原报告证据兼容", async () => fixture(async (store, prices, cachePath) => {
  const revisions = [
    add(store, "parent", Array.from({ length: 31 }, (_, index) => usage(`request-${index}`, { messageId: "message", turnId: "turn",
      requestMessageIds: ["message"], timing: { basis: "recorded", method: "claude_message_boundary", completion: "explicit", durationMs: 20 } })),
    { project: "/workspace/main", childSessionIds: ["child"] }),
    add(store, "child", [usage("child-request", { occurredAt: undefined }), usage("missing", { model: undefined }),
      usage("literal", { model: "unknown" }), usage("escaped", { model: "literal:unknown" })], { client: "claude", project: "/workspace/child" }),
    add(store, "copy", [usage("copied", { messageId: "message", turnId: "turn" })], {}, true), add(store, "empty", []),
  ];
  const version = store.publish(store.createJob().id, revisions, []);
  let manager = new UsageManager(store, prices, cachePath);
  const internal = manager as unknown as { createWorker(): Worker };
  const create = internal.createWorker.bind(manager), messages: UsageWorkerRequest[] = [];
  internal.createWorker = () => {
    const worker = create(), post = worker.postMessage.bind(worker);
    worker.postMessage = ((message: UsageWorkerRequest) => { messages.push(message); post(message); }) as Worker["postMessage"];
    return worker;
  };
  const query: UsageQuery = { version, priceVersion: prices.version(), timezone: "UTC", from: "2026-01-01", to: "2026-01-03", groupBy: "model" };
  const original = store.usageEvidence.bind(store);
  try {
    store.usageEvidence = () => { throw new Error("统计不能在主线程恢复原请求"); };
    const [first, duplicate] = await Promise.all([manager.statistics(query, "trend"), manager.statistics({ ...query }, "trend")]);
    assert.deepEqual(first, duplicate);
    for (const view of views) {
      const actual = await manager.statistics(query, view), price = prices.view(query.priceVersion);
      assert.deepEqual(rounded(actual), rounded(project(buildUsageReport(store.usageSource(version), query, price.status, price.estimate), view)));
      assert.equal(actual.totals.requests, 34); assert.equal(actual.undated.requests, 1);
      actual.totals.requests = -1;
      assert.equal((await manager.statistics(query, view)).totals.requests, 34);
    }
    assert.equal(messages.filter(message => message.type === "statistics").length, 3, "每个 view 具有独立缓存并合并相同在途请求");
    assert.equal(messages.filter(message => message.type === "report" || message.type === "summary").length, 0);
    for (const patch of [{ from: "2026-01-02T01:00:00Z", to: "2026-01-03T01:00:00Z" }, { metric: "cost" as const, sort: "cost" as const },
      { minCost: 0.00001 }, { models: ["unknown"] }, { models: ["literal:unknown"] }, { models: ["literal:literal:unknown"] },
      { relationship: "child" as const }, { pricing: "partial" as const }]) {
      const selected = { ...query, ...patch }, price = prices.view(query.priceVersion);
      assert.deepEqual(rounded(await manager.statistics(selected, "distribution")),
        rounded(project(buildUsageReport(store.usageSource(version), selected, price.status, price.estimate), "distribution")));
    }
    await manager.close();
    const database = new Database(cachePath, { readonly: true });
    let persisted: unknown;
    try { persisted = database.prepare("SELECT revision,client,price_version,timezone,format,json FROM usage_rollup_cache").all(); }
    finally { database.close(); }
    manager = new UsageManager(store, prices, cachePath);
    assert.deepEqual(await manager.statistics(query, "trend"), first);
    const restarted = new Database(cachePath, { readonly: true });
    try { assert.deepEqual(restarted.prepare("SELECT revision,client,price_version,timezone,format,json FROM usage_rollup_cache").all(), persisted); }
    finally { restarted.close(); }
    const summary = await manager.summaryReport(query);
    assert.deepEqual(summary.totals, first.totals); assert.ok(summary.sessions.every(row => row.requests.length === 0));
    store.usageEvidence = original;
    const report = await manager.report(query);
    assert.deepEqual(report.totals, first.totals);
    assert.ok(report.sessions.some(row => row.requests.some(request => request.usage.timing && request.cost.price)));
  } finally { store.usageEvidence = original; await manager.close(); }
}));

test("轻量前台查询只等待必要修订，未齐历史仍提供完整模型候选", async () => fixture(async (store, prices, cachePath) => {
  const active = add(store, "old-active", [usage("recent-request")], { startedAt: "2020-01-01T00:00:00Z" });
  const undated = add(store, "undated", [usage("missing-time", { occurredAt: undefined, model: "literal:unknown" })]);
  const history = Array.from({ length: 10 }, (_, index) => add(store, `history-${index}`, Array.from({ length: 1800 }, (_, request) =>
    usage(`request-${request}`, { model: `historical-model-${index}`, occurredAt: "2020-06-01T10:00:00Z" })), { updatedAt: "2099-01-01T00:00:00Z" }));
  const version = store.publish(store.createJob().id, [active, undated, ...history], []), manager = new UsageManager(store, prices, cachePath);
  const query: UsageQuery = { version, priceVersion: prices.version(), timezone: "UTC", from: "2026-01-01", to: "2026-01-03" };
  const internal = manager as unknown as { execute(type: "prepare", query: UsageQuery): Promise<unknown> };
  const background = internal.execute("prepare", query);
  try {
    const result = await manager.statistics(query, "trend");
    const database = new Database(cachePath, { readonly: true });
    try {
      const prepared = database.prepare("SELECT revision FROM usage_rollup_cache WHERE price_version=? AND timezone=?")
        .all(query.priceVersion!, query.timezone!) as { revision: string }[];
      assert.ok(prepared.length < history.length + 2, "前台统计不等待全部历史");
      assert.ok(prepared.some(row => row.revision === active.revision));
      assert.ok(prepared.some(row => row.revision === undated.revision));
    } finally { database.close(); }
    assert.equal(result.totals.requests, 1); assert.equal(result.undated.requests, 1);
    assert.ok(result.facets.models.includes("historical-model-9") && result.facets.models.includes("literal:literal:unknown"));
    const price = prices.view(query.priceVersion);
    assert.deepEqual(rounded(result), rounded(project(buildUsageReport(store.usageSource(version), query, price.status, price.estimate), "trend")));
    await background;
    assert.equal(manager.status(query).state, "ready");
  } finally { await manager.close(); await background.catch(() => undefined); }
}));
