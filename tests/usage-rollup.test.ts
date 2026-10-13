import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary, SessionUsage } from "../src/session-contracts.js";
import type { PricingStatus, RequestCost, UsageQuery, UsageReport, UsageSource } from "../src/usage-contracts.js";
import { buildUsageReport } from "../src/usage/analytics.js";
import { buildUsageRollup, buildUsageRollupReport, canUseUsageRollup, combineUsageRollups } from "../src/usage/rollup.js";
import type { UsageRollup } from "../src/usage/rollup-contracts.js";
import { createPricingEstimator } from "../src/usage/pricing.js";

const pricing: PricingStatus = { version: "prices-1", source: "bundled", sourceUrl: "https://example.invalid/prices",
  refreshing: false, currency: "USD", configuration: { overrides: [], mappings: [] }, prices: [] };
const estimate = (usage: SessionUsage): RequestCost => {
  const known = usage.model !== undefined && usage.model !== "unpriced";
  const input = usage.inputTokens, output = usage.outputTokens;
  const hasInput = input !== undefined && Number.isFinite(input) && input >= 0;
  const hasOutput = output !== undefined && Number.isFinite(output) && output >= 0;
  return { amount: known && (hasInput || hasOutput) ? ((hasInput ? input : 0) * 2 + (hasOutput ? output : 0) * 3) / 1_000_000 : null,
    coverage: !known ? "missing" : hasInput && hasOutput ? "complete" : hasInput || hasOutput ? "partial" : "missing",
    ...(known ? { price: { provider: "synthetic", model: usage.model!, source: "bundled", input: 2, output: 3 } } : {}),
    freshInputTokens: hasInput && usage.cachedInputTokens !== undefined && usage.cacheWriteTokens !== undefined
      ? input - usage.cachedInputTokens - usage.cacheWriteTokens : undefined };
};
function session(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, client: "codex", clientSessionId: id, title: "合成会话", titleOrigin: "recorded", models: [],
    messageCount: 1, turnCount: 1, gaps: [], ...extra };
}
function usage(id: string, extra: Partial<SessionUsage> = {}): SessionUsage {
  return { id, model: "model-a", inputTokens: 100, outputTokens: 20, cachedInputTokens: 10, cacheWriteTokens: 0,
    occurredAt: "2026-01-01T10:00:00Z", ...extra };
}
function source(sessions: SessionSummary[], requests: [string, SessionUsage][]): UsageSource {
  return { version: "index-1", sessions, requests: requests.map(([sessionId, usage]) => ({ sessionId, usage })) };
}
function hydrated(report: UsageReport, input: UsageSource): UsageReport {
  const usages = new Map(input.requests.map(item => [`${item.sessionId}\0${item.usage.id}`, item.usage]));
  return { ...report, sessions: report.sessions.map(row => ({ ...row, requests: row.requests.map(item => {
    const usage = usages.get(`${row.session.id}\0${item.usage.id}`)!;
    return { usage, cost: estimate(usage) };
  }) })) };
}
function equivalent(left: unknown, right: unknown, path = "report"): void {
  if (typeof left === "number" && typeof right === "number" && /(?:estimatedCost|cacheReadRatio|amount)$/.test(path)) {
    assert.ok(Math.abs(left - right) < 1e-10, `${path}: ${left} != ${right}`); return;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    assert.equal(left.length, right.length, `${path}.length`);
    for (let index = 0; index < left.length; index += 1) equivalent(left[index], right[index], `${path}[${index}]`);
    return;
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort(), `${path}.keys`);
    for (const key of Object.keys(left)) equivalent((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], `${path}.${key}`);
    return;
  }
  assert.deepEqual(left, right, path);
}
function compare(input: UsageSource, query: UsageQuery, rollup?: UsageRollup): UsageReport {
  const timezone = query.timezone ?? "UTC", requested = { ...query, timezone };
  if (!canUseUsageRollup(requested)) {
    assert.throws(() => buildUsageRollupReport(rollup ?? buildUsageRollup(input, timezone, estimate), requested, pricing));
    return buildUsageReport(input, requested, pricing, estimate);
  }
  const actual = buildUsageRollupReport(rollup ?? buildUsageRollup(input, timezone, estimate), requested, pricing);
  equivalent(hydrated(actual, input), buildUsageReport(input, requested, pricing, estimate));
  return actual;
}

const mixed = source([
  session("parent", { project: "/workspace/a" }),
  session("child", { client: "claude", project: "/workspace/b", relationship: "child", parentSessionId: "parent" }),
  session("quiet", { project: "unknown", executionMode: "quiet" }),
  session("fork", { project: "literal:unknown", relationship: "fork", parentSessionId: "parent" }),
  session("zero"), session("empty"), session("undated"),
], [
  ...Array.from({ length: 60 }, (_, index): [string, SessionUsage] => [index % 2 ? "parent" : "child",
    usage(`request-${String(index).padStart(3, "0")}`, { model: ["model-a", "model-b", "unpriced"][index % 3],
      inputTokens: index % 7 === 0 ? undefined : 50 + index, outputTokens: index % 11 === 0 ? undefined : index,
      occurredAt: `2026-01-${String(1 + index % 4).padStart(2, "0")}T${String(10 + index % 3).padStart(2, "0")}:15:00Z`,
      cachedInputTokens: index % 5 === 0 ? undefined : 10, reasoningOutputTokens: index % 4 === 0 ? 3 : undefined })]),
  ["parent", usage("duplicate", { inputTokens: 10 })], ["parent", usage("duplicate", { inputTokens: 500 })],
  ["quiet", usage("literal-model", { model: "unknown", occurredAt: undefined })],
  ["fork", usage("escaped-model", { model: "literal:unknown" })],
  ["fork", usage("missing-model", { model: undefined })],
  ["zero", usage("zero", { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 })],
  ["undated", usage("invalid-time", { occurredAt: "invalid" })],
  ["undated", usage("no-time", { occurredAt: undefined, inputTokens: undefined, outputTokens: undefined })],
  ["child", usage("invalid-input", { inputTokens: -10, outputTokens: NaN })],
]);

test("小时汇总保留服务商与计价依据，历史、当前快照和手动覆盖的计数与精确分析一致", () => {
  const status: PricingStatus = { ...pricing, configuration: { overrides: [{ model: "manual-model", input: 0, output: 0 }], mappings: [] },
    prices: [{ model: "shared-model", provider: "alpha", source: "network", input: 2, output: 4, cacheRead: 1 },
      { model: "shared-model", provider: "beta", source: "network", input: 8, output: 16, cacheRead: 4 }],
    historicalPrices: [{ model: "shared-model", provider: "alpha", source: "network", input: 3, output: 9, cacheRead: 1,
      priceBasis: "historical", effectiveFrom: "2025-01-01T00:00:00Z", effectiveTo: "2026-02-01T00:00:00Z" }] };
  const input = source([session("priced")], [
    ["priced", usage("history", { model: "shared-model", provider: "alpha" })],
    ["priced", usage("snapshot", { model: "shared-model", provider: "beta" })],
    ["priced", usage("manual", { model: "manual-model" })],
    ["priced", usage("unknown", { model: "shared-model", provider: "missing" })],
  ]);
  const pricingEstimate = createPricingEstimator(status);
  const rollup = buildUsageRollup(input, "UTC", pricingEstimate);
  const aggregated = buildUsageRollupReport(rollup, { timezone: "UTC" }, status);
  const exact = buildUsageReport(input, { timezone: "UTC" }, status, pricingEstimate);
  assert.deepEqual(aggregated.totals, exact.totals);
  assert.deepEqual([exact.totals.historicalPricedRequests, exact.totals.currentSnapshotPricedRequests, exact.totals.manualPricedRequests], [1, 1, 1]);
  assert.equal(exact.totals.unpricedRequests, 1);
  assert.equal("historicalPrices" in aggregated.pricing, false, "普通统计报告不传输完整历史价格表");
  assert.equal(aggregated.sessions[0]?.requests.find(item => item.usage.id === "snapshot")?.usage.provider, "beta");
});

test("小时汇总与实时分析在全套筛选、阈值、排序及分页下保持一致", () => {
  const rollup = buildUsageRollup(mixed, "UTC", estimate);
  const queries: UsageQuery[] = [{}, { from: "2026-01-01", to: "2026-01-04" }, { from: "2026-01-02" }, { to: "2025-12-31" },
    { clients: ["codex", "claude"], excludeClients: ["claude"] },
    { projects: ["/workspace/a", "/workspace/b"], excludeProjects: ["/workspace/a"] },
    { projects: ["unknown"] }, { projects: ["literal:unknown"] }, { projects: ["literal:literal:unknown"] },
    { models: ["model-a", "model-b"], excludeModels: ["model-a"] }, { models: ["unknown"] }, { models: ["literal:unknown"] },
    { excludeModels: ["unknown", "model-a"] }, { projects: ["/workspace/a"], excludeProjects: ["/workspace/a"] },
    { minTokens: 0 }, { maxTokens: 0 }, { minTokens: 100, maxTokens: 1000 }, { minCost: 0 }, { maxCost: 0 },
    { minCost: 0.0001, maxCost: 0.003 }, { from: "2026-01-02", to: "2026-01-02", minTokens: 100, maxTokens: 1000 },
    { from: "2026-01-02", models: ["model-b"], minCost: 0.0001 },
    { page: 2, pageSize: 2 }, { page: 8, pageSize: 1 }, { version: "index-1", priceVersion: "prices-1" }];
  for (const relationship of ["all", "main", "child"] as const) queries.push({ relationship });
  for (const sessionType of ["all", "interactive", "automation", "fork"] as const) queries.push({ sessionType });
  for (const coverage of ["all", "complete", "partial", "missing"] as const) {
    for (const costCoverage of ["all", "complete", "partial", "missing"] as const) queries.push({ coverage, pricing: costCoverage });
  }
  for (const sort of ["tokens", "cost", "requests", "recent"] as const) {
    for (const direction of ["asc", "desc"] as const) queries.push({ sort, direction, pageSize: 3, page: 2 });
  }
  for (const query of queries) compare(mixed, query, rollup);
});

test("指标、分组和时间粒度均复用小时汇总，空桶与未定时请求保持原口径", () => {
  const rollup = buildUsageRollup(mixed, "UTC", estimate);
  for (const metric of ["tokens", "cost", "requests"] as const) {
    for (const groupBy of ["project", "model", "client"] as const) {
      for (const interval of ["hour", "day", "week", "month"] as const) {
        compare(mixed, { metric, groupBy, interval, from: "2026-01-01", to: "2026-01-06", pageSize: 2 }, rollup);
      }
    }
  }
  for (const interval of ["hour", "day", "week", "month"] as const) compare(mixed, { interval }, rollup);
  const finite = compare(mixed, { from: "2026-01-02", to: "2026-01-02" }, rollup);
  assert.equal(finite.sessions.find(row => row.session.id === "undated")?.requestsTotal, 2);
  assert.equal(finite.sessions.find(row => row.session.id === "undated")?.totals.tokens, null);
  assert.equal(finite.missingUsageSessions, 0);
  assert.ok(!finite.sessions.some(row => row.session.id === "empty"));
  const overflow = compare(mixed, { from: "2026-01-02", to: "2026-01-02", page: 62, pageSize: 20 }, rollup);
  assert.equal(overflow.page, 1);
  assert.ok(overflow.sessions.length > 0);
  assert.deepEqual(finite.facets, compare(mixed, {}, rollup).facets);
});

test("时区小时预计算保留跨日、夏令时重复小时、缩短小时及非整小时偏移", () => {
  const cases = [
    { timezone: "Asia/Shanghai", day: "2026-01-02", times: ["2026-01-01T16:05:00Z", "2026-01-02T15:59:59Z"] },
    { timezone: "America/New_York", day: "2026-11-01", times: ["2026-11-01T05:15:00Z", "2026-11-01T06:15:00Z"] },
    { timezone: "Europe/Berlin", day: "2026-10-25", times: ["2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z"] },
    { timezone: "America/New_York", day: "2026-03-08", times: ["2026-03-08T06:15:00Z", "2026-03-08T07:15:00Z"] },
    { timezone: "Asia/Kathmandu", day: "2026-01-01", times: ["2025-12-31T18:30:00Z", "2026-01-01T18:00:00Z"] },
    { timezone: "Australia/Lord_Howe", day: "2026-04-05", times: ["2026-04-04T14:15:00Z", "2026-04-04T15:15:00Z"] },
    { timezone: "Australia/Lord_Howe", day: "2026-10-04", times: ["2026-10-03T15:15:00Z", "2026-10-03T15:45:00Z"] },
  ];
  for (const { timezone, day, times } of cases) {
    const input = source([session("time")], times.map((occurredAt, index) => ["time", usage(`time-${index}`, { occurredAt })]));
    for (const interval of ["hour", "day", "week", "month"] as const) compare(input, { timezone, interval, from: day, to: day });
    compare(source([], []), { timezone, interval: "hour", from: day, to: day });
  }
});

test("按修订组合复用统计而更新当前会话身份，支持空索引和范围裁剪后的全局facets", () => {
  const parts = mixed.sessions.map(session => buildUsageRollup({ ...mixed, sessions: [session],
    requests: mixed.requests.filter(item => item.sessionId === session.id) }, "UTC", estimate));
  const sessions = mixed.sessions.map(session => ({ ...session, title: "当前标题", project: "/workspace/current" }));
  const input = { ...mixed, version: "index-2", sessions };
  compare(input, { from: "2026-01-02", to: "2026-01-03" }, combineUsageRollups(parts, input.version, sessions));
  compare(source([], []), { timezone: "Asia/Shanghai" }, combineUsageRollups([], "index-1", [], "Asia/Shanghai"));
  const current = buildUsageRollup(mixed, "UTC", estimate);
  const cropped = { ...current, cells: current.cells.filter(cell => !cell.day || cell.day === "2026-01-02") };
  compare(mixed, { from: "2026-01-02", to: "2026-01-02" }, cropped);
  assert.throws(() => combineUsageRollups([current, { ...current, timezone: "Asia/Shanghai" }], "index-1", mixed.sessions));
});

test("持久化分片字节数加会话头部可保守估算组合 rollup 大小", () => {
  const parts = mixed.sessions.map(current => {
    const part = buildUsageRollup({ ...mixed, sessions: [current],
      requests: mixed.requests.filter(item => item.sessionId === current.id) }, "UTC", estimate);
    part.sessions = [];
    return part;
  });
  const partsBytes = parts.reduce((total, part) => total + Buffer.byteLength(JSON.stringify(part)), 0);
  const headerBytes = Buffer.byteLength(JSON.stringify({ version: mixed.version, timezone: "UTC", sessions: mixed.sessions,
    cells: [], sessionIdsWithUsage: [], models: [] }));
  const combined = combineUsageRollups(parts, mixed.version, mixed.sessions, "UTC");
  const serializedBytes = Buffer.byteLength(JSON.stringify(combined));
  assert.ok(serializedBytes <= partsBytes + headerBytes + 1024,
    `${serializedBytes} combined bytes should fit in the ${partsBytes + headerBytes + 1024} byte upper bound`);
});

test("每小时证据紧凑有界，同时间按身份排序，跨cell合并后可恢复完整原始请求", () => {
  const count = 1000;
  const input = source([session("large")], Array.from({ length: count }, (_, index) => ["large", usage(`request-${String(count - index).padStart(4, "0")}`, {
    model: index % 3 ? "model-a" : "model-b", occurredAt: index % 4 ? "2026-01-01T10:00:00Z" : undefined,
    requestMessageIds: Array.from({ length: 100 }, (_, message) => `message-${message}`),
    timing: { basis: "recorded", method: "claude_message_boundary", completion: "explicit", end: { recordLine: index } },
  })]));
  const rollup = buildUsageRollup(input, "UTC", estimate);
  assert.ok(rollup.cells.length < count / 10);
  assert.ok(rollup.cells.every(cell => cell.previews.length <= 12));
  assert.ok(rollup.cells.every(cell => cell.previews.every(preview => !("price" in preview.cost)
    && !("requestMessageIds" in preview.usage) && !("timing" in preview.usage))));
  const restored = JSON.parse(JSON.stringify(rollup)) as UsageRollup;
  const result = compare(input, { from: "2026-01-01", to: "2026-01-01" }, restored);
  assert.equal(result.sessions[0]?.requestsTotal, count);
  assert.equal(result.sessions[0]?.requests.length, 12);
  compare(input, {}, restored);
});

test("日期边界只允许完整当地日期，精确ISO范围退回事实路径并保留原校验", () => {
  assert.equal(canUseUsageRollup({}), true);
  assert.equal(canUseUsageRollup({ from: "2026-01-01", to: "2026-01-02" }), true);
  assert.equal(canUseUsageRollup({ from: "2026-01-01T12:00:00Z" }), false);
  assert.equal(canUseUsageRollup({ to: "2026-01-02T00:00:00+08:00" }), false);
  assert.equal(canUseUsageRollup({ from: "2026-02-30" }), false);
  const rollup = buildUsageRollup(mixed, "UTC", estimate);
  for (const query of [{ version: "missing" }, { priceVersion: "missing" }, { timezone: "invalid/timezone" },
    { from: "2026-02-30" }, { to: "invalid" }, { from: "2026-01-03", to: "2026-01-01" },
    { page: 0 }, { pageSize: 201 }, { minTokens: -1 }, { minCost: NaN }, { minTokens: 10, maxTokens: 1 }]) {
    assert.throws(() => buildUsageRollupReport(rollup, query, pricing));
    assert.throws(() => buildUsageReport(mixed, { timezone: "UTC", ...query }, pricing, estimate));
  }
  assert.throws(() => buildUsageRollupReport(rollup, { from: "2026-01-01T12:00:00Z" }, pricing));
  assert.throws(() => buildUsageRollup(mixed, "invalid/timezone", estimate));
});

test("费用阈值与费用排序回到精确事实路径，防止浮点加法顺序影响会话选择", () => {
  const input = source([session("a"), session("b")], ["a", "b"].flatMap(id => Array.from({ length: 13 }, (_, index): [string, SessionUsage] => [id,
    usage(`request-${index}`, { model: id, inputTokens: index, outputTokens: 1,
      occurredAt: `2026-01-01T${String(index % (id === "a" ? 3 : 2)).padStart(2, "0")}:00:00Z` })])));
  const oracle = buildUsageReport(input, { timezone: "UTC" }, pricing, estimate);
  const value = oracle.sessions[0]!.totals.estimatedCost!;
  for (const query of [{ minCost: value }, { maxCost: value }, { sort: "cost" as const }, { metric: "cost" as const }]) {
    assert.equal(canUseUsageRollup(query), false);
    const result = compare(input, query);
    equivalent(result, buildUsageReport(input, { timezone: "UTC", ...query }, pricing, estimate));
  }
  assert.equal(canUseUsageRollup({ minTokens: 0, maxTokens: 1000, sort: "tokens", metric: "requests" }), true);
});

test("项目与原始模型计数来自最终请求集合，不受分组与分页影响，真实unknown不算缺失", () => {
  for (const groupBy of ["client", "model", "project"] as const) for (const page of [1, 2]) {
    const report = compare(mixed, { groupBy, page, pageSize: 1 });
    assert.equal(report.projectCount, 4); assert.equal(report.modelCount, 5);
  }
  const selected = compare(mixed, { projects: ["/workspace/a"], models: ["model-a"] });
  assert.equal(selected.projectCount, 1); assert.equal(selected.modelCount, 1);
  const missing = compare(mixed, { models: ["unknown"] });
  assert.equal(missing.projectCount, 1); assert.equal(missing.modelCount, 0);
  const literal = compare(mixed, { models: ["literal:unknown"] });
  assert.equal(literal.modelCount, 1); assert.equal(literal.projectCount, 1);
  const empty = compare(mixed, { minTokens: 1e20 });
  assert.equal(empty.projectCount, 0); assert.equal(empty.modelCount, 0);
});
