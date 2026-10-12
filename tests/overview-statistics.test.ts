import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { overviewPanels, type OverviewQuery } from "../src/overview-contracts.js";
import { buildOverviewReport } from "../src/overview/analytics.js";
import { OverviewManager } from "../src/overview/manager.js";
import type { SessionSourceMeta } from "../src/session-contracts.js";
import { SessionStore } from "../src/sessions/store.js";
import { buildUsageReport } from "../src/usage/analytics.js";
import type { UsageManager } from "../src/usage/manager.js";
import { PricingService } from "../src/usage/pricing.js";
import type { UsageQuery, UsageStatistics, UsageStatisticsView } from "../src/usage-contracts.js";

const clock = () => new Date("2026-03-09T12:00:00Z");
const value = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
const sortRows = <T extends { key: string }>(rows: T[]) => [...rows].sort((a, b) => a.key.localeCompare(b.key));
async function fixture(run: (manager: OverviewManager, store: SessionStore, prices: PricingService,
  calls: { query: UsageQuery; view: UsageStatisticsView }[], directory: string, usage: UsageManager) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-overview-statistics-")), store = new SessionStore(join(directory, "index.sqlite"));
  const identities: { id: string; extra?: Partial<SessionSourceMeta>; model?: string }[] = [
    { id: "synthetic-main", extra: { project: "/workspace/project-a", childSessionIds: ["synthetic-child"] }, model: "model-a" },
    { id: "synthetic-child", extra: { project: "/workspace/project-b", relationship: "child", parentSessionId: "synthetic-main" }, model: "unknown" },
    { id: "synthetic-fork", extra: { client: "pi", relationship: "fork", project: "/workspace/project-a" }, model: "literal:model-a" },
    { id: "synthetic-orphan", extra: { relationship: "child", parentSessionId: "synthetic-missing" } },
    { id: "synthetic-uncertain", extra: { childSessionIds: ["synthetic-missing"] }, model: "model-a" },
  ];
  const entries = identities.map(({ id, extra, model }, index) => {
    const path = `/workspace/history/${id}.jsonl`, pending = store.createRevision(path, "synthetic");
    pending.sink.message({ id: "synthetic-user", sessionId: id, ordinal: 0, recordLine: 1, turnId: "synthetic-turn", kind: "user",
      text: "合成正文", occurredAt: "2026-03-09T12:00:00Z" });
    pending.sink.usage({ id: "synthetic-request", messageId: "synthetic-user", model, inputTokens: index * 100,
      outputTokens: index === 3 ? undefined : 20, occurredAt: "2026-03-09T12:00:00Z" });
    if (index < 2) for (const [period, count, inputTokens, day] of [
      ["previous", 20, 100, "2026-02-25"], ["current", index === 0 ? 60 : 20, 200, "2026-03-05"],
    ] as const) for (let requestIndex = 0; requestIndex < count; requestIndex++) {
      pending.sink.usage({ id: `synthetic-${period}-${requestIndex}`, model: "model-a", inputTokens, outputTokens: 20,
        occurredAt: `${day}T12:00:00Z` });
    }
    pending.flush(); store.finishRevision(pending.revision, { id, client: "codex", clientSessionId: id, path, sourceId: "synthetic-source",
      title: "合成会话", titleOrigin: "recorded", models: model ? [model] : [], messageCount: 1, turnCount: 1, gaps: [], ...extra });
    return { path, revision: pending.revision, fingerprint: "synthetic" };
  });
  store.publish(store.createJob().id, entries, []);
  const prices = new PricingService(directory, { fetch: (async () => { throw new Error("synthetic offline"); }) as typeof fetch, now: clock });
  const calls: { query: UsageQuery; view: UsageStatisticsView }[] = [];
  // 旧报告作为独立结果基准；生产总览只允许调用轻量方法。
  const usage = { statistics: async (query: UsageQuery, view: UsageStatisticsView): Promise<UsageStatistics> => {
    calls.push({ query, view });
    const pricing = prices.view(query.priceVersion), report = buildUsageReport(store.overviewSource(query.version), query, pricing.status, pricing.estimate);
    return { version: report.version, priceVersion: report.priceVersion, timezone: report.timezone, query: report.query,
      totals: report.totals, undated: report.undated, facets: report.facets,
      days: view === "trend" ? report.days.map(day => ({ ...day, groups: [] })) : [], groups: view === "distribution" ? report.groups : [] };
  }, summaryReport: () => { throw new Error("默认总览不得构建完整用量报告"); },
  report: () => { throw new Error("默认总览不得构建完整用量报告"); } } as unknown as UsageManager;
  const manager = new OverviewManager(store, prices, () => [], clock, usage);
  try { await run(manager, store, prices, calls, directory, usage); }
  finally { await manager.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
}

test("默认六分区仅请求 totals 和 trend，基础委派及筛选独立且保持兼容", async () => fixture(async (manager, store, prices, calls) => {
  const query: OverviewQuery = { window: "custom", from: "2026-03-09", to: "2026-03-09", timezone: "UTC" };
  const panels = await Promise.all(overviewPanels.map(panel => manager.panel(query, panel)));
  assert.deepEqual(calls.map(call => call.view).sort(), ["totals", "trend"]);
  const core = panels.find(panel => panel.panel === "core")!, usage = panels.find(panel => panel.panel === "usage")!;
  assert.deepEqual(Object.keys(usage.data), ["usage"]);
  assert.deepEqual(usage.data.usage!.groups, []); assert(usage.data.usage!.days.every(day => day.groups.length === 0));
  for (const field of ["sessions", "pricing", "buckets", "totalSessions"]) assert.equal(field in usage.data.usage!, false);
  for (const panel of panels) assert.equal("delegation" in panel.data, false);
  assert.equal("facets" in core.data, false); assert.equal("distributions" in usage.data, false);
  const pricing = prices.view(core.snapshot.priceVersion);
  const expected = buildOverviewReport(store.overviewSource(), core.snapshot.query, pricing, clock());
  assert.deepEqual(value(core.data.summary), value(expected.summary)); assert.deepEqual(value(core.data.activity), value(expected.activity));
  assert.deepEqual(value(usage.data.usage!.totals), value(expected.usage.totals));
  assert.deepEqual(core.data.delegationSummary, { eligibleMainSessions: 1, withChildActivity: 1, unknownMainSessions: 1,
    forkSessions: 1, unknownRelationshipSessions: 1 });
  const facets = await manager.panel(query, "facets");
  assert.deepEqual(facets.data.facets, expected.facets);
  assert.deepEqual(facets.data.facets!.models, ["literal:model-a", "model-a", "unknown"]);
  assert.equal(calls.length, 2, "筛选候选无需用量报告或轻量用量查询");
  const delegation = await manager.panel(query, "delegation");
  assert.deepEqual(delegation.data.delegation, expected.delegation);
  const filtered = await manager.panel({ ...query, models: ["model-a"] }, "delegation");
  const filteredReport = buildOverviewReport(store.overviewSource(), { ...core.snapshot.query, models: ["model-a"] }, pricing, clock());
  assert.deepEqual(filtered.data.delegation, filteredReport.delegation);
  assert.equal(calls.length, 2, "详细委派直接汇总窄请求事实");
}));

test("分布与完整排行严格只查所选维度，缓存按快照及维度隔离", async () => fixture(async (manager, store, prices, calls, directory, usage) => {
  const query: OverviewQuery = { window: "custom", from: "2026-03-09", to: "2026-03-09", timezone: "UTC" };
  const snapshot = await manager.snapshot(query), pricing = prices.view(snapshot.priceVersion);
  const expected = buildOverviewReport(store.overviewSource(), snapshot.query, pricing, clock());
  for (const dimension of ["client", "project", "model"] as const) {
    const before = calls.length, panel = await manager.panel(query, "distribution", dimension), rows = panel.data.distribution!;
    assert.equal(panel.dimension, dimension); assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1)!.view, "distribution"); assert.equal(calls.at(-1)!.query.groupBy, dimension);
    const key = dimension === "client" ? "clients" : dimension === "project" ? "projects" : "models";
    assert.deepEqual(value(sortRows(rows)), value(sortRows(expected.distributions[key])));
    assert.deepEqual(panel.counts, { [key]: rows.length });
    assert.deepEqual(await manager.panel(query, "distribution", dimension), panel); assert.equal(calls.length, before + 1);
    const page = await manager.detail(query, { view: "ranking", dimension, sort: "tokens", page: 2, pageSize: 1 });
    assert.equal(calls.length, before + 2); assert.equal(calls.at(-1)!.query.groupBy, dimension);
    assert.equal(page.total, rows.length); assert.equal(page.rows.length, rows.length > 1 ? 1 : 0);
    const ranking = [...rows].sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1) || a.key.localeCompare(b.key));
    assert.deepEqual(value(page.rows), value(ranking.slice(1, 2)));
  }
  await assert.rejects(manager.panel(query, "distribution"), { code: "INVALID_INPUT" });
  await assert.rejects(manager.panel(query, "usage", "model"), { code: "INVALID_INPUT" });
  await manager.close();
  const raw = new Database(join(directory, "overview-results.sqlite"));
  try { raw.prepare(`UPDATE overview_results SET json=json_set(json,'$.dimension','project')
    WHERE json_extract(json,'$.panel')='distribution' AND json_extract(json,'$.dimension')='client'`).run(); } finally { raw.close(); }
  const restarted = new OverviewManager(store, prices, () => [], clock, usage), before = calls.length;
  try {
    const client = await restarted.panel(query, "distribution", "client");
    assert.equal(client.dimension, "client"); assert.equal(calls.length, before + 1, "缓存维度不匹配必须重新查询");
    const model = await restarted.panel(query, "distribution", "model");
    assert.equal(model.dimension, "model"); assert.equal(calls.length, before + 1, "其他维度仍命中原持久缓存");
  } finally { await restarted.close(); }
}));

test("用量洞察使用轻量总量与两项分布，规则和比较区间沿用兼容报告", async () => fixture(async (manager, _store, _prices, calls) => {
  const query: OverviewQuery = { window: "custom", from: "2026-03-01", to: "2026-03-08", timezone: "UTC", models: ["model-a"] };
  const insights = await manager.panel(query, "insights");
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map(call => `${call.view}:${call.query.groupBy}`).sort(),
    ["distribution:model", "distribution:model", "distribution:project", "distribution:project", "totals:model", "totals:model"]);
  assert(calls.every(call => call.query.models?.[0] === "model-a"));
  assert.deepEqual(calls.filter(call => call.view === "totals").map(call => [call.query.from, call.query.to]),
    [["2026-03-01", "2026-03-08"], ["2026-02-21", "2026-02-28"]]);
  assert.equal(calls.filter(call => call.query.coverage === "complete").length, 2);
  const report = await manager.report(query);
  assert(insights.data.insights!.some(insight => insight.rule === "01"));
  assert(insights.data.insights!.some(insight => insight.rule === "07"));
  assert.deepEqual(insights.data.insights, report.insights); assert.deepEqual(insights.data.featuredInsights, report.featuredInsights);
  assert.equal(calls.length, 6, "旧 report 兼容入口保持原独立实现");
  calls.length = 0;
  const annual = await manager.panel({ window: "365", timezone: "UTC" }, "insights");
  assert.equal(calls.length, 10);
  assert.equal(calls.filter(call => call.view === "distribution").length, 4, "只有同长度比较需要项目及模型分布，近期变化只读总量");
  const annualReport = await manager.report({ window: "365", timezone: "UTC" });
  assert.deepEqual(annual.data.insights, annualReport.insights);
}));
