import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRequestTiming, SessionSummary, SessionUsage } from "../src/session-contracts.js";
import type { PricingStatus, RequestCost, UsageQuery, UsageSource } from "../src/usage-contracts.js";
import { buildUsageReport } from "../src/usage/analytics.js";
import { buildUsageRollup, buildUsageRollupReport, canUseUsageRollup } from "../src/usage/rollup.js";

const pricing: PricingStatus = { version: "price", source: "bundled", sourceUrl: "https://example.invalid/prices", refreshing: false,
  currency: "USD", configuration: { overrides: [], mappings: [] }, prices: [] };
const estimate = (usage: SessionUsage): RequestCost => ({ amount: usage.model === "unpriced" ? null : (usage.outputTokens ?? 0) / 1_000_000,
  coverage: usage.model === "unpriced" ? "missing" : usage.inputTokens === undefined ? "partial" : "complete" });
const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({ id, client: "codex", clientSessionId: id,
  title: "合成速度会话", titleOrigin: "recorded", models: [], messageCount: 1, turnCount: 1, gaps: [], ...extra });
const timing = (extra: Partial<SessionRequestTiming> = {}): SessionRequestTiming => ({ basis: "recorded", method: "codex_event_boundary",
  completion: "explicit", durationMs: 2000, ...extra });
const usage = (id: string, extra: Partial<SessionUsage> = {}): SessionUsage => ({ id, model: "model-a", inputTokens: 100, outputTokens: 400,
  occurredAt: "2026-01-01T12:00:00Z", timing: timing(), ...extra });
const source = (requests: SessionUsage[]): UsageSource => ({ version: "index", sessions: [session("main")],
  requests: requests.map(usage => ({ sessionId: "main", usage })) });
const report = (input: UsageSource, query: UsageQuery = {}) => buildUsageReport(input, { timezone: "UTC", includeSpeed: true, ...query }, pricing, estimate);

function compare(input: UsageSource, query: UsageQuery = {}): ReturnType<typeof report> {
  const requested = { timezone: "UTC", includeSpeed: true, ...query };
  const exact = report(input, query);
  if (canUseUsageRollup(requested)) {
    const rollup = JSON.parse(JSON.stringify(buildUsageRollup(input, requested.timezone, estimate)));
    const aggregated = buildUsageRollupReport(rollup, requested, pricing);
    assert.deepEqual(aggregated.speed, exact.speed);
    assert.deepEqual(aggregated.buckets.map(bucket => bucket.key), exact.buckets.map(bucket => bucket.key));
  }
  return exact;
}

test("日期速度使用合格输出除以耗时，资格门槛和计时输出覆盖复用请求速度", () => {
  const input = source([
    usage("fast", { outputTokens: 200, timing: timing({ durationMs: 1000 }) }),
    usage("slow", { outputTokens: 400, timing: timing({ durationMs: 10000 }) }),
    usage("override", { outputTokens: 900, reasoningOutputTokens: 800, timing: timing({ outputTokens: 200, durationMs: 1000 }) }),
    usage("small", { outputTokens: 199 }), usage("short", { timing: timing({ durationMs: 999 }) }),
    usage("partial", { timing: timing({ completion: "partial" }) }), usage("unknown", { timing: timing({ completion: "unknown" }) }),
    usage("missing", { timing: undefined }), usage("negative", { timing: timing({ durationMs: -1000 }) }),
    usage("conflict", { timing: timing({ start: { recordLine: 1, occurredAt: "2026-01-01T00:00:00Z" },
      end: { recordLine: 2, occurredAt: "2026-01-01T00:00:10Z" } }) }),
    usage("invalid-boundary", { timing: timing({ start: { recordLine: 1, occurredAt: "invalid" } }) }),
    usage("missing-output", { outputTokens: undefined }),
    usage("inferred", { timing: timing({ completion: "inferred" }) }),
  ]);
  const result = compare(input).speed!;
  assert.equal(result.requests, 13); assert.equal(result.eligibleRequests, 4);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0]!.requests, 12);
  assert.equal(result.groups[0]!.outputTokens, 1200);
  assert.equal(result.groups[0]!.durationMs, 14000);
  assert.equal(result.groups[0]!.tokensPerSecond, 1200 * 1000 / 14000);
  assert.equal(result.buckets[0]!.tokensPerSecond, result.groups[0]!.tokensPerSecond);
  assert.equal(report(input, { includeSpeed: false }).speed, undefined);
});

test("客户端、原始模型、阶段、估算依据和计时方法隔离，缺模型与无日期只影响对应覆盖", () => {
  const input = source([
    usage("default"), usage("model", { model: "model-b" }), usage("estimated", { timing: timing({ basis: "estimated" }) }),
    usage("generation", { timing: timing({ window: "generation" }) }),
    usage("method", { timing: timing({ method: "claude_message_boundary" }) }),
    usage("no-model", { model: undefined }), usage("empty-model", { model: "" }),
    usage("undated", { occurredAt: undefined }), usage("invalid-date", { occurredAt: "2026-02-30T12:00:00Z" }),
    usage("literal-unknown", { model: "unknown" }), usage("no-group", { timing: { durationMs: 2000, completion: "explicit" } as SessionRequestTiming }),
  ]);
  input.sessions.push(session("child", { client: "claude", relationship: "child", parentSessionId: "main" }));
  input.requests.push({ sessionId: "child", usage: usage("default") });
  const result = compare(input).speed!;
  assert.equal(result.requests, 10); assert.equal(result.eligibleRequests, 10); assert.equal(result.missingTimeRequests, 2);
  assert.equal(result.groups.length, 7);
  assert.equal(result.groups.reduce((total, group) => total + group.requests, 0), 7);
  assert.ok(result.groups.some(group => group.model === "unknown"), "原始模型名 unknown 仍是明确身份");
  const selected = result.groups.find(group => group.window === "generation")!;
  assert.equal(compare(input, { speedGroup: selected.key }).speed!.selectedGroup, selected.key);
  const fallback = compare(input, { speedGroup: selected.key, models: ["model-b"] }).speed!;
  assert.equal(fallback.selectedGroup, fallback.groups[0]!.key);
  const finite = compare(input, { from: "2026-01-01", to: "2026-01-01" }).speed!;
  assert.deepEqual(finite, result);
});

test("完整日期桶的未知点保留null，组内无合格样本和只有一个样本均保留正确范围", () => {
  const input = source([usage("single", { occurredAt: "2026-01-02T12:00:00Z" }),
    usage("ineligible", { occurredAt: "2026-01-04T12:00:00Z", outputTokens: 10 })]);
  const result = compare(input, { from: "2026-01-01", to: "2026-01-05" }).speed!;
  assert.deepEqual(result.buckets.map(bucket => bucket.tokensPerSecond), [null, 200, null, null, null]);
  assert.deepEqual(result.buckets.map(bucket => bucket.requests), [0, 1, 0, 1, 0]);
  const missing = compare(input, { from: "2026-01-04", to: "2026-01-04" }).speed!;
  assert.equal(missing.groups[0]!.tokensPerSecond, null);
  assert.equal(missing.groups[0]!.outputTokens, null); assert.equal(missing.groups[0]!.durationMs, null);
  const empty = compare(input, { from: "2026-01-06", to: "2026-01-07" }).speed!;
  assert.deepEqual(empty.groups, []); assert.equal(empty.selectedGroup, null);
  assert.deepEqual(empty.buckets.map(bucket => bucket.tokensPerSecond), [null, null]);
});

test("速度与用量共享全部筛选、会话阈值、请求身份和分页，精确范围与费用阈值使用原始集合", () => {
  const sessions = [session("main", { project: "/workspace/a" }),
    session("child", { client: "claude", project: "/workspace/b", relationship: "child", parentSessionId: "main" }),
    session("quiet", { executionMode: "quiet" }), session("fork", { relationship: "fork" })];
  const input: UsageSource = { version: "index", sessions, requests: sessions.flatMap(current => Array.from({ length: 16 }, (_, index) => ({
    sessionId: current.id, usage: usage(`request-${index}`, { model: ["model-a", "model-b", "unpriced"][index % 3],
      inputTokens: index % 4 ? 100 : undefined, outputTokens: index % 5 ? 400 : undefined,
      occurredAt: index === 15 ? undefined : `2026-01-${String(index % 3 + 1).padStart(2, "0")}T12:00:00Z`,
      timing: timing({ basis: index % 3 ? "recorded" : "estimated" }) }),
  }))) };
  input.requests.push({ ...input.requests[0]!, usage: { ...input.requests[0]!.usage, outputTokens: 800 } });
  const queries: UsageQuery[] = [{}, { from: "2026-01-02", to: "2026-01-03" }, { clients: ["codex"] }, { excludeClients: ["codex"] },
    { projects: ["/workspace/a"] }, { excludeProjects: ["/workspace/b"] }, { models: ["model-a"] }, { excludeModels: ["model-a"] },
    { minTokens: 6000 }, { maxTokens: 6000 }, { page: 2, pageSize: 1 }];
  for (const relationship of ["all", "main", "child"] as const) queries.push({ relationship });
  for (const sessionType of ["all", "interactive", "automation", "fork"] as const) queries.push({ sessionType });
  for (const coverage of ["all", "complete", "partial", "missing"] as const) {
    for (const pricing of ["all", "complete", "partial", "missing"] as const) queries.push({ coverage, pricing });
  }
  for (const query of queries) {
    const result = compare(input, query);
    assert.equal(result.speed!.requests, result.totals.requests - result.totals.missingTimeRequests);
    assert.equal(result.speed!.missingTimeRequests, result.undated.requests);
  }
  assert.deepEqual(compare(input, { page: 2, pageSize: 1 }).speed, compare(input).speed);
  for (const query of [{ from: "2026-01-02T12:00:00Z", to: "2026-01-03T12:00:00Z" }, { minCost: 0.005 }, { maxCost: 0.005 }]) {
    assert.equal(canUseUsageRollup(query), false);
    const result = compare(input, query);
    const ids = new Set(result.sessions.map(row => row.session.id));
    const selected = { ...input, requests: input.requests.filter(item => ids.has(item.sessionId)), sessions: input.sessions.filter(item => ids.has(item.id)) };
    assert.deepEqual(result.speed, report(selected, { ...query, minCost: undefined, maxCost: undefined }).speed);
  }
});

test("速度时间粒度沿用时区与夏令时重复小时边界", () => {
  for (const [timezone, from, times] of [
    ["Asia/Shanghai", "2026-01-02", ["2026-01-01T16:05:00Z", "2026-01-02T15:59:59Z"]],
    ["America/New_York", "2026-11-01", ["2026-11-01T05:15:00Z", "2026-11-01T06:15:00Z"]],
    ["Australia/Lord_Howe", "2026-04-05", ["2026-04-04T14:15:00Z", "2026-04-04T15:15:00Z"]],
  ] as const) {
    const input = source(times.map((occurredAt, index) => usage(`time-${index}`, { occurredAt })));
    for (const interval of ["hour", "day", "week", "month"] as const) {
      const result = compare(input, { timezone, interval, from, to: from });
      assert.equal(result.speed!.buckets.reduce((sum, bucket) => sum + bucket.eligibleRequests, 0), 2);
    }
  }
});
