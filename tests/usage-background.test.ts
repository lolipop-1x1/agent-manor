import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import test from "node:test";
import Database from "better-sqlite3";
import type { SessionSourceMeta, SessionUsage } from "../src/session-contracts.js";
import { SessionStore, type SessionRevision } from "../src/sessions/store.js";
import { buildUsageReport, buildUsageRequestPage } from "../src/usage/analytics.js";
import { UsageManager } from "../src/usage/manager.js";
import { PricingService } from "../src/usage/pricing.js";
import type { UsageQuery } from "../src/usage-contracts.js";
import type { UsageWorkerRequest } from "../src/usage/worker-contracts.js";
import { startService } from "../src/server.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";
import { StoreError } from "../src/index/store.js";

async function fixture(run: (store: SessionStore, prices: PricingService, cachePath: string, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "manor-usage-background-"));
  const store = new SessionStore(join(directory, "index.sqlite"));
  const prices = new PricingService(directory, { fetch: (async () => { throw new Error("synthetic network failure"); }) as typeof fetch });
  prices.configure({ overrides: [{ model: "synthetic-model", input: 2, output: 5, cacheRead: 0.2, cacheWrite: 3 }], mappings: [] });
  try { await run(store, prices, join(directory, "rollup.sqlite"), directory); }
  finally { prices.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
}

function add(store: SessionStore, id: string, usages: SessionUsage[], extra: Partial<SessionSourceMeta> = {}): SessionRevision {
  const summary: SessionSourceMeta = { id, client: "codex", clientSessionId: id, title: "人工合成后台用量会话", titleOrigin: "recorded",
    path: `/workspace/history/${id}.jsonl`, sourceId: `codex:${id}`, messageCount: 0, turnCount: 0, models: [], gaps: [], ...extra };
  const revision = store.createRevision(summary.path, "synthetic");
  revision.sink.message({ id: "message", sessionId: id, ordinal: 0, recordLine: 1, turnId: "turn", kind: "assistant", text: "合成证据" });
  for (const usage of usages) revision.sink.usage(usage);
  revision.flush(); store.finishRevision(revision.revision, summary);
  return { path: summary.path, revision: revision.revision, fingerprint: "synthetic" };
}

const value = (id: string, extra: Partial<SessionUsage> = {}): SessionUsage => ({ id, model: "synthetic-model", inputTokens: 100,
  outputTokens: 20, cachedInputTokens: 40, occurredAt: "2026-01-02T01:00:00Z", messageId: "message", turnId: "turn",
  requestMessageIds: ["message"], timing: { basis: "recorded", method: "claude_message_boundary", completion: "explicit", durationMs: 10 }, ...extra });

function rounded(value: unknown): unknown {
  if (typeof value === "number") return Number.isInteger(value) ? value : Number(value.toPrecision(12));
  if (Array.isArray(value)) return value.map(rounded);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rounded(item)]));
  return value;
}

test("总览汇总保留统计且不在主线程读取原请求，完整用量报告仍可恢复证据", async () => fixture(async (store, prices, cachePath) => {
  const revision = add(store, "main", Array.from({ length: 30 }, (_, index) => value(`request-${index}`)));
  const version = store.publish(store.createJob().id, [revision], []), manager = new UsageManager(store, prices, cachePath);
  const query = { version, timezone: "UTC", pageSize: 5 };
  const original = store.usageEvidence.bind(store);
  try {
    store.usageEvidence = () => { throw new Error("总览不能恢复无用的原请求预览"); };
    const summary = await manager.summaryReport(query);
    assert.equal(summary.totals.requests, 30); assert.equal(summary.sessions[0]!.requestsTotal, 30);
    assert.deepEqual(summary.sessions[0]!.requests, []); assert.equal(summary.sessions[0]!.requestsLimited, true);
    store.usageEvidence = original;
    const report = await manager.report(query);
    assert.deepEqual(summary.totals, report.totals); assert.deepEqual(summary.groups, report.groups);
    assert.ok(report.sessions[0]!.requests.length > 0); assert.ok(report.sessions[0]!.requests[0]!.usage.timing);
  } finally { store.usageEvidence = original; await manager.close(); }
}));

async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) { if (check()) return; await pause(10); }
  assert.fail("合成后台任务未在限定时间内完成");
}

test("真实 Worker 冷查询、并发合并与缓存保持精确统计，页内还原完整证据和价格", async () => fixture(async (store, prices, cachePath) => {
  const usages = Array.from({ length: 31 }, (_, index) => value(`request-${String(index).padStart(2, "0")}`, {
    occurredAt: index % 2 ? "2026-01-02T01:00:00Z" : "2026-01-03T02:00:00Z", inputTokens: 100 + index,
  }));
  const main = add(store, "main", usages, { project: "/workspace/main", childSessionIds: ["child"] });
  const child = add(store, "child", [value("child-request", { cacheWriteTokens: 0 }), value("undated", { occurredAt: undefined }),
    { id: "unknown", outputTokens: 0 }], { client: "claude", project: "/workspace/child", titleOrigin: "fallback", taskName: "合成子任务" });
  const empty = add(store, "empty", []);
  const version = store.publish(store.createJob().id, [main, child, empty], []);
  const manager = new UsageManager(store, prices, cachePath);
  const internal = manager as unknown as { createWorker(): Worker };
  const create = internal.createWorker.bind(manager), messages: UsageWorkerRequest[] = [];
  internal.createWorker = () => {
    const worker = create(), post = worker.postMessage.bind(worker);
    worker.postMessage = ((message: UsageWorkerRequest) => { messages.push(message); post(message); }) as Worker["postMessage"];
    return worker;
  };
  try {
    const query: UsageQuery = { version, priceVersion: prices.version(), timezone: "Asia/Shanghai", from: "2026-01-01", to: "2026-01-04",
      groupBy: "model", pageSize: 2 };
    const [first, duplicate] = await Promise.all([manager.report(query), manager.report({ ...query })]);
    assert.deepEqual(first, duplicate);
    assert.equal(messages.filter(message => message.type === "report").length, 1);
    const view = prices.view(query.priceVersion), source = store.usageSource(version);
    assert.deepEqual(rounded(first), rounded(buildUsageReport(source, query, view.status, view.estimate)));
    assert.ok(first.sessions.some(row => row.requests.some(request => request.usage.timing && request.cost.price)));
    first.sessions[0]!.session.title = "调用方修改";
    const cached = await manager.report(query);
    assert.notEqual(cached.sessions[0]!.session.title, "调用方修改");
    assert.equal(messages.filter(message => message.type === "report").length, 1);
    for (const patch of [{ page: 2 }, { metric: "requests" as const, interval: "hour" as const }, { relationship: "child" as const },
      { models: ["unknown"] }, { minTokens: 1000 }, { from: "2026-01-02T01:00:00Z", to: "2026-01-03T03:00:00Z" },
      { metric: "cost" as const, sort: "cost" as const, minCost: 0.00001 }]) {
      const selected = { ...query, ...patch };
      assert.deepEqual(rounded(await manager.report(selected)), rounded(buildUsageReport(source, selected, view.status, view.estimate)));
    }
    const page = await manager.requests(query, "main", 2, 12);
    assert.deepEqual(page, buildUsageRequestPage(source, query, view.status, view.estimate, "main", 2, 12));
    assert.equal(page.requests[0]!.cost.coverage, "complete", "Codex 没有缓存写分项时保留 Worker 的来源口径");
    assert.deepEqual(await manager.requests(query, "absent"), buildUsageRequestPage(source, query, view.status, view.estimate, "absent"));
    const status = manager.status(query);
    assert.equal(status.state, "ready");
    assert.deepEqual([status.version, status.priceVersion, status.timezone], [version, prices.version(), "Asia/Shanghai"]);
    assert.equal(manager.status({ ...query, timezone: "UTC" }).state, "idle");
  } finally { await manager.close(); }
}));

test("重启复用持久化汇总，价格和时区变化独立重算，旧价格报告保留固定版本", async () => fixture(async (store, prices, cachePath) => {
  const revision = add(store, "persistent", [value("request")]);
  const version = store.publish(store.createJob().id, [revision], []);
  let manager = new UsageManager(store, prices, cachePath);
  const query: UsageQuery = { version, priceVersion: prices.version(), timezone: "Asia/Shanghai" };
  try {
    const first = await manager.report(query);
    await manager.close();
    const database = new Database(cachePath, { readonly: true });
    let original: unknown;
    try { original = database.prepare("SELECT revision,client,price_version,timezone,format,json FROM usage_rollup_cache").all(); }
    finally { database.close(); }
    manager = new UsageManager(store, prices, cachePath);
    assert.deepEqual(await manager.report(query), first);
    const persisted = new Database(cachePath, { readonly: true });
    try { assert.deepEqual(persisted.prepare("SELECT revision,client,price_version,timezone,format,json FROM usage_rollup_cache").all(), original); }
    finally { persisted.close(); }
    prices.configure({ overrides: [{ model: "synthetic-model", input: 8, output: 20, cacheRead: 0.8 }], mappings: [] });
    const next = await manager.report({ ...query, priceVersion: prices.version() });
    assert.equal(next.totals.tokens, first.totals.tokens);
    assert.ok(next.totals.estimatedCost! > first.totals.estimatedCost!);
    assert.equal((await manager.report(query)).totals.estimatedCost, first.totals.estimatedCost);
    assert.equal((await manager.report({ ...query, timezone: "America/New_York" })).timezone, "America/New_York");
    await prices.refresh(true);
    const errorState = await manager.report({ ...query, priceVersion: prices.version() });
    assert.equal(errorState.pricing.errorDescriptor?.key, "diagnostics.usage.pricing.fetch", "缓存命中同步当前价格错误状态");
  } finally { await manager.close(); }
}));

test("后台启动和增量版本检测自动准备，新版本与已回收版本的缓存不混用", async () => fixture(async (store, prices, cachePath) => {
  const manager = new UsageManager(store, prices, cachePath);
  try {
    assert.equal(manager.status().state, "idle");
    manager.start();
    const first = add(store, "versioned", [value("request", { inputTokens: 1 })]);
    const version = store.publish(store.createJob().id, [first], []);
    await waitUntil(() => manager.status().state === "ready");
    assert.equal(manager.status().version, version);
    const old = await manager.report({ version });
    const second = add(store, "versioned", [value("request", { inputTokens: 2 })]);
    const next = store.publish(store.createJob().id, [second], []);
    await waitUntil(() => manager.status().state === "ready");
    assert.equal(manager.status().version, next);
    assert.equal((await manager.report({ version })).totals.tokens, old.totals.tokens);
    assert.notEqual((await manager.report({ version: next })).totals.tokens, old.totals.tokens);
    const third = add(store, "versioned", [value("request", { inputTokens: 3 })]);
    store.publish(store.createJob().id, [third], []);
    await assert.rejects(manager.report({ version }), error => !!error && typeof error === "object" && "code" in error && error.code === "VERSION_NOT_FOUND");
    const oldPrice = prices.version();
    prices.configure({ overrides: [{ model: "synthetic-model", input: 6, output: 10, cacheRead: 0.6 }], mappings: [] });
    assert.notEqual(prices.version(), oldPrice);
    await waitUntil(() => manager.status().state === "ready");
    assert.equal(manager.status().priceVersion, prices.version());
  } finally { await manager.close(); }
}));

test("查询错误可恢复，Worker 故障明确绑定失败身份，关闭拒绝在途请求并释放线程", async () => fixture(async (store, prices, _cachePath, directory) => {
  const revision = add(store, "errors", [value("request")]);
  const version = store.publish(store.createJob().id, [revision], []);
  const cacheDirectory = join(directory, "missing-cache-directory"), cachePath = join(cacheDirectory, "cache.sqlite");
  const manager = new UsageManager(store, prices, cachePath);
  const query: UsageQuery = { version, priceVersion: prices.version(), timezone: "UTC" };
  try {
    await assert.rejects(manager.report({ ...query, timezone: "invalid/timezone" }), /timezone/);
    await assert.rejects(manager.report({ ...query, priceVersion: "missing-price-version" }), /不可用/);
    await assert.rejects(manager.report(query));
    assert.equal(manager.status(query).state, "failed");
    assert.deepEqual([manager.status(query).version, manager.status(query).priceVersion, manager.status(query).timezone], [version, prices.version(), "UTC"]);
    await mkdir(cacheDirectory);
    assert.equal((await manager.report(query)).totals.requests, 1);
    await assert.rejects(manager.requests(query, "errors", 0), /requestPage/);
    assert.equal((await manager.requests(query, "errors")).total, 1);
  } finally { await manager.close(); }
  const closing = new UsageManager(store, prices, cachePath);
  const stopped = (error: unknown): boolean => error instanceof StoreError && error.code === "INTERNAL_ERROR"
    && error.messageDescriptor?.key === "diagnostics.usage.worker.stopped";
  const pending = closing.report(query), rejected = assert.rejects(pending, stopped);
  await closing.close(); await rejected;
  await closing.close();
  await assert.rejects(closing.report(query), stopped);
  await assert.rejects(closing.requests(query, "errors"), stopped);
}));

test("用量 Worker 异常退出返回专用稳定诊断与实际退出码", async () => fixture(async (store, prices, cachePath) => {
  const revision = add(store, "unexpected-exit", [value("request")]);
  const version = store.publish(store.createJob().id, [revision], []);
  const manager = new UsageManager(store, prices, cachePath);
  try {
    const pending = manager.report({ version, timezone: "UTC" });
    const worker = (manager as unknown as { worker: Worker }).worker;
    let failure: StoreError | undefined;
    const rejected = assert.rejects(pending, error => {
      if (!(error instanceof StoreError)) return false;
      failure = error;
      return error.code === "INTERNAL_ERROR" && error.messageDescriptor?.key === "diagnostics.usage.worker.unexpectedExit";
    });
    // 外部终止模拟意外退出，管理器自身尚未关闭。
    const code = await worker.terminate();
    await rejected;
    assert.deepEqual(failure!.messageDescriptor?.params, { code });
    assert.equal(manager.status({ version, timezone: "UTC" }).state, "failed");
  } finally { await manager.close(); }
}));

test("HTTP 准备状态与报告绑定同一身份，非法参数失败且服务关闭释放后台任务", async () => fixture(async (store, prices, _cachePath, directory) => {
  const revision = add(store, "http-status", [value("request")]);
  const version = store.publish(store.createJob().id, [revision], []);
  const service = await startService({ home: directory, startupRefresh: false, roots: isolatedHistoryRoots(),
    resourceInventory: { userHome: join(directory, "isolated-user"), environment: {} },
    usagePricing: { fetch: (async () => { throw new Error("synthetic network failure"); }) as typeof fetch } });
  const base = `http://127.0.0.1:${service.instance.port}/api/v1/usage`;
  const identity = new URLSearchParams({ version, priceVersion: prices.version(), timezone: "UTC" });
  try {
    const before = await fetch(`${base}/status?${identity}`);
    assert.equal(before.status, 200);
    const status = await before.json();
    assert.deepEqual([status.version, status.priceVersion, status.timezone], [version, prices.version(), "UTC"]);
    const report = await fetch(`${base}?${identity}`);
    assert.equal(report.status, 200);
    assert.equal((await report.json()).totals.requests, 1);
    let ready;
    for (let count = 0; count < 100; count++) {
      ready = await (await fetch(`${base}/status?${identity}`)).json();
      if (ready.state === "ready") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(ready.state, "ready");
    const invalid = await fetch(`${base}/status?timezone=invalid`);
    assert.equal(invalid.status, 400);
    const absent = await fetch(`${base}/status?version=missing`);
    assert.equal(absent.status, 404);
  } finally { await service.close(); }
}));

test("近30天查询只等必要修订，旧会话近期请求和缺时间证据优先，历史后台继续且全集筛选完整", async () => fixture(async (store, prices, cachePath) => {
  const day = new Date().toISOString().slice(0, 10), midnight = Date.parse(`${day}T00:00:00Z`);
  const oldActive = add(store, "old-active", [value("recent-request", { occurredAt: new Date(midnight - 10 * 3_600_000).toISOString() })],
    { project: "/workspace/active", startedAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z" });
  const recent = add(store, "recent", [value("recent-request", { occurredAt: new Date(midnight + 3_600_000).toISOString() })],
    { project: "/workspace/recent", startedAt: day });
  const undated = add(store, "undated-history", [value("old-request", { model: "unknown", occurredAt: "2010-01-01T00:00:00Z" }),
    value("missing-time", { model: "literal:unknown", occurredAt: "2026-02-30T12:00:00Z" })], { project: "/workspace/undated" });
  const empty = add(store, "empty-history", [], { project: "/workspace/empty" });
  const history = Array.from({ length: 10 }, (_, index) => add(store, `history-${index}`, Array.from({ length: 1800 }, (_, request) =>
    value(`request-${request}`, { model: `historical-model-${index}`, occurredAt: "2020-06-01T10:00:00Z" })), {
    project: `/workspace/history-${index}`, updatedAt: "2099-01-01T00:00:00Z",
  }));
  const version = store.publish(store.createJob().id, [oldActive, recent, undated, empty, ...history], []);
  const query: UsageQuery = { version, priceVersion: prices.version(), timezone: "Pacific/Kiritimati",
    from: new Date(midnight - 29 * 86_400_000).toISOString().slice(0, 10), to: day, pageSize: 200 };
  const manager = new UsageManager(store, prices, cachePath);
  const internal = manager as unknown as { execute(type: "prepare", query: UsageQuery): Promise<unknown> };
  const background = internal.execute("prepare", query);
  try {
    const report = await manager.report(query);
    const database = new Database(cachePath, { readonly: true });
    try {
      const prepared = database.prepare("SELECT revision FROM usage_rollup_cache WHERE price_version=? AND timezone=?")
        .all(query.priceVersion!, query.timezone!) as { revision: string }[];
      assert.ok(prepared.length < history.length + 4, "近期报告不等待全部历史小时汇总");
      assert.ok(prepared.some(row => row.revision === oldActive.revision), "按请求时间识别旧会话的近期活动");
      assert.ok(prepared.some(row => row.revision === undated.revision), "日期范围外的缺时间证据仍需准备");
    } finally { database.close(); }
    assert.equal(report.totals.requests, 2);
    assert.equal(report.undated.requests, 1);
    assert.ok(report.facets.models.includes("historical-model-9"));
    assert.ok(report.facets.models.includes("literal:unknown") && report.facets.models.includes("literal:literal:unknown"));
    assert.equal(report.missingUsageSessions, 0);
    // 后台尚未齐时订阅历史范围，不能把近期部分组合当成全量 family 缓存。
    const historicalQuery = { ...query, from: "2020-06-01", to: "2020-06-01", timezone: query.timezone };
    const historicalResult = manager.report(historicalQuery);
    const view = prices.view(query.priceVersion), source = store.usageSource(version);
    assert.deepEqual(rounded(report), rounded(buildUsageReport(source, query, view.status, view.estimate)));
    const historical = await historicalResult;
    assert.deepEqual(rounded(historical), rounded(buildUsageReport(source, historicalQuery, view.status, view.estimate)));
    await background;
    assert.equal(manager.status(query).state, "ready");
    const complete = await manager.report({ ...query, from: undefined, to: undefined });
    assert.deepEqual(rounded(complete), rounded(buildUsageReport(source, { ...query, from: undefined, to: undefined }, view.status, view.estimate)));
  } finally { await manager.close(); await background.catch(() => undefined); }
}));

for (const change of ["timezone", "price", "version"] as const) {
  test(`新${change}前台查询在旧family历史未齐时推进，并保留版本口径及同family合并`, async () => fixture(async (store, prices, cachePath) => {
    const day = new Date().toISOString().slice(0, 10), midnight = Date.parse(`${day}T00:00:00Z`);
    const active = add(store, "active-family", [value("recent-request", { occurredAt: new Date(midnight + 3_600_000).toISOString() })]);
    const history = Array.from({ length: 12 }, (_, index) => add(store, `old-family-${index}`, Array.from({ length: 2000 }, (_, request) =>
      value(`request-${request}`, { model: `old-model-${index}`, occurredAt: "2020-06-01T10:00:00Z" }))));
    const version = store.publish(store.createJob().id, [active, ...history], []);
    const oldQuery: UsageQuery = { version, priceVersion: prices.version(), timezone: "UTC",
      from: new Date(midnight - 29 * 86_400_000).toISOString().slice(0, 10), to: day };
    const manager = new UsageManager(store, prices, cachePath);
    const internal = manager as unknown as { execute(type: "prepare", query: UsageQuery): Promise<unknown> };
    let oldComplete = false;
    const background = internal.execute("prepare", oldQuery).then(() => { oldComplete = true; });
    try {
      await manager.report(oldQuery);
      assert.equal(oldComplete, false, "前台切换前旧历史仍在预热");
      let query = { ...oldQuery };
      if (change === "timezone") query.timezone = "Asia/Shanghai";
      if (change === "price") {
        prices.configure({ overrides: [{ model: "synthetic-model", input: 4, output: 10, cacheRead: 0.4 }], mappings: [] });
        query.priceVersion = prices.version();
      }
      if (change === "version") {
        const replacement = add(store, "active-family", [value("recent-request", { inputTokens: 200,
          occurredAt: new Date(midnight + 3_600_000).toISOString() })]);
        query.version = store.publish(store.createJob().id, [replacement, ...history], []);
      }
      const [report, duplicate] = await Promise.all([manager.report(query), manager.report({ ...query })]);
      assert.deepEqual(report, duplicate);
      assert.equal(oldComplete, false, "新family查询不等待旧family完整预热");
      const database = new Database(cachePath, { readonly: true });
      try {
        const count = database.prepare(`SELECT COUNT(*) AS count FROM usage_rollup_cache WHERE price_version=? AND timezone=?
          AND revision IN (SELECT value FROM json_each(?))`)
          .get(oldQuery.priceVersion!, oldQuery.timezone!, JSON.stringify([active, ...history].map(item => item.revision))) as { count: number };
        assert.ok(count.count < history.length + 1, "新family返回时旧family持久历史汇总尚未齐");
      } finally { database.close(); }
      const view = prices.view(query.priceVersion), source = store.usageSource(query.version);
      assert.deepEqual(rounded(report), rounded(buildUsageReport(source, query, view.status, view.estimate)));
      assert.equal(report.facets.models.length, history.length + 1);
      await background;
      assert.equal(manager.status(oldQuery).state, "ready");
    } finally { await manager.close(); await background.catch(() => undefined); }
  }));
}

test("速度 Worker 按需查询、精确事实缓存隔离、重启和旧格式回填均与原请求分析一致", async () => fixture(async (store, prices, cachePath) => {
  const speedValue = (id: string, extra: Partial<SessionUsage> = {}): SessionUsage => value(id, { outputTokens: 400,
    timing: { basis: "recorded", method: "codex_event_boundary", completion: "explicit", durationMs: 2000 }, ...extra });
  const main = add(store, "speed-main", [speedValue("first"), speedValue("slow", { timing: {
    basis: "recorded", method: "codex_event_boundary", completion: "inferred", durationMs: 10000, outputTokens: 200 } }),
    speedValue("undated", { occurredAt: undefined }), speedValue("missing-model", { model: undefined }),
    speedValue("partial", { timing: { basis: "estimated", method: "codex_event_boundary", completion: "partial", durationMs: 3000 } })]);
  const child = add(store, "speed-child", [speedValue("first", { timing: { basis: "recorded", window: "generation",
    method: "claude_message_boundary", completion: "explicit", durationMs: 1000 } })], { client: "claude", relationship: "child", parentSessionId: "speed-main" });
  const version = store.publish(store.createJob().id, [main, child], []);
  const query: UsageQuery = { version, priceVersion: prices.version(), timezone: "UTC", from: "2026-01-01", to: "2026-01-04" };
  const source = store.usageSource(version), view = prices.view(query.priceVersion);
  let manager = new UsageManager(store, prices, cachePath);
  try {
    assert.equal((await manager.report(query)).speed, undefined);
    const first = await manager.report({ ...query, includeSpeed: true });
    assert.deepEqual(first.speed, buildUsageReport(source, { ...query, includeSpeed: true }, view.status, view.estimate).speed);
    assert.equal(first.speed!.requests, 5); assert.equal(first.speed!.eligibleRequests, 4); assert.equal(first.speed!.missingTimeRequests, 1);
    for (const patch of [{ from: "2026-01-02T00:00:00Z", to: "2026-01-03T00:00:00Z" }, { minCost: 0.001 }, { maxCost: 0.002 },
      { metric: "cost" as const }, { relationship: "child" as const }, { page: 2, pageSize: 1 }]) {
      const selected = { ...query, ...patch };
      assert.equal((await manager.report(selected)).speed, undefined);
      const speedQuery = { ...selected, includeSpeed: true };
      const actual = await manager.report(speedQuery);
      assert.deepEqual(actual.speed, buildUsageReport(source, speedQuery, view.status, view.estimate).speed);
    }
    for (const speedGroups of [first.speed!.groups.map(group => group.key).reverse(), []]) {
      const multiQuery = { ...query, includeSpeed: true, speedGroups };
      assert.deepEqual((await manager.report(multiQuery)).speed, buildUsageReport(source, multiQuery, view.status, view.estimate).speed);
      const exactQuery = { ...multiQuery, minCost: 0.001 };
      assert.deepEqual((await manager.report(exactQuery)).speed, buildUsageReport(source, exactQuery, view.status, view.estimate).speed);
    }
    await manager.close(); manager = new UsageManager(store, prices, cachePath);
    assert.deepEqual((await manager.report({ ...query, includeSpeed: true })).speed, first.speed);
    await manager.close();
    const facts = new Database(store.dbPath), cache = new Database(cachePath);
    try {
      facts.prepare("UPDATE session_usage_fact_revisions SET format_version=0").run();
      facts.prepare("UPDATE session_usage_facts SET timing_duration_ms=1").run();
      cache.prepare("UPDATE usage_rollup_cache SET format=0").run();
    } finally { facts.close(); cache.close(); }
    manager = new UsageManager(store, prices, cachePath);
    assert.deepEqual((await manager.report({ ...query, includeSpeed: true })).speed, first.speed);
    assert.deepEqual(store.usageSource(version), source, "派生格式升级不修改原始请求");
    prices.configure({ overrides: [{ model: "synthetic-model", input: 4, output: 10 }], mappings: [] });
    const repriced = await manager.report({ ...query, priceVersion: prices.version(), includeSpeed: true });
    assert.deepEqual(repriced.speed, first.speed, "无费用筛选时价格变化不改变速度事实");
  } finally { await manager.close(); }
}));
