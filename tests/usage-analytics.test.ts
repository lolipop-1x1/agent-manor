import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { SessionMessage, SessionSourceMeta, SessionSummary, SessionUsage } from "../src/session-contracts.js";
import type { PricingStatus, RequestCost, UsageQuery, UsageSource } from "../src/usage-contracts.js";
import { SessionStore } from "../src/sessions/store.js";
import { usageDimensionKey, usageDimensionValue } from "../src/usage/dimensions.js";
import { buildUsageReport, buildUsageRequestPage } from "../src/usage/analytics.js";

const pricing: PricingStatus = { version: "prices-1", source: "bundled", sourceUrl: "https://example.invalid/prices",
  refreshing: false, currency: "USD", configuration: { overrides: [], mappings: [] }, prices: [] };
const estimate = (usage: SessionUsage): RequestCost => ({
  amount: usage.model === "unpriced" || !usage.model ? null : usage.inputTokens !== undefined && usage.outputTokens !== undefined
    ? (usage.inputTokens + usage.outputTokens) / 1_000_000 : usage.inputTokens !== undefined ? usage.inputTokens / 1_000_000 : null,
  coverage: usage.model === "unpriced" || !usage.model ? "missing" : usage.inputTokens !== undefined && usage.outputTokens !== undefined
    ? "complete" : usage.inputTokens !== undefined ? "partial" : "missing",
  freshInputTokens: usage.inputTokens !== undefined && usage.cachedInputTokens !== undefined && usage.cacheWriteTokens !== undefined
    ? usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens : undefined,
});
function session(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, client: "codex", clientSessionId: id, title: "合成用量会话", titleOrigin: "recorded", models: [],
    messageCount: 1, turnCount: 1, gaps: [], startedAt: "2026-01-01T00:00:00Z", ...extra };
}
function usage(id: string, extra: Partial<SessionUsage> = {}): SessionUsage {
  return { id, model: "model-a", inputTokens: 100, outputTokens: 20, cachedInputTokens: 10, cacheWriteTokens: 0,
    occurredAt: "2026-01-01T10:00:00Z", ...extra };
}
function source(sessions: SessionSummary[], requests: [string, SessionUsage][]): UsageSource {
  return { version: "index-1", sessions, requests: requests.map(([sessionId, usage]) => ({ sessionId, usage })) };
}
const report = (input: UsageSource, query: UsageQuery = {}) => buildUsageReport(input, { timezone: "UTC", ...query }, pricing, estimate);

test("跨天请求按自身时间归属，分页不改变全图、排行与指标", () => {
  const input = source([session("a", { project: "/workspace/a" }), session("b", { project: "/workspace/b" })], [
    ["a", usage("a-1", { occurredAt: "2026-01-01T23:55:00Z" })], ["a", usage("a-2", { occurredAt: "2026-01-02T00:10:00Z" })],
    ["b", usage("b-1", { inputTokens: 200, occurredAt: "2026-01-02T01:00:00Z" })],
  ]);
  const first = report(input, { from: "2026-01-01", to: "2026-01-03", pageSize: 1, page: 1 });
  const second = report(input, { from: "2026-01-01", to: "2026-01-03", pageSize: 1, page: 2 });
  assert.equal(first.totals.tokens, 460);
  assert.equal(first.totalSessions, 2);
  assert.deepEqual(first.totals, second.totals);
  assert.deepEqual(first.buckets, second.buckets);
  assert.deepEqual(first.groups, second.groups);
  assert.deepEqual(first.days.map(day => [day.key, day.totals.requests]), [["2026-01-01", 1], ["2026-01-02", 2], ["2026-01-03", 0]]);
  assert.equal(first.days.reduce((sum, day) => sum + (day.totals.tokens ?? 0), 0), first.totals.tokens);
  assert.equal(first.groups.reduce((sum, group) => sum + (group.totals.tokens ?? 0), 0), first.totals.tokens);
  assert.notEqual(first.sessions[0]?.session.id, second.sessions[0]?.session.id);
  assert.equal(report(input, { from: "2026-01-02", to: "2026-01-02" }).totals.requests, 2);
});

test("日期采用查询时区，ISO结束排他，夏令时重复小时仍为两个桶", () => {
  const input = source([session("a")], [
    ["a", usage("late", { occurredAt: "2026-01-01T16:05:00Z" })],
    ["a", usage("dst-a", { occurredAt: "2026-11-01T05:15:00Z" })],
    ["a", usage("dst-b", { occurredAt: "2026-11-01T06:15:00Z" })],
  ]);
  assert.equal(report(input, { timezone: "Asia/Shanghai", from: "2026-01-02", to: "2026-01-02" }).totals.requests, 1);
  assert.equal(report(input, { timezone: "UTC", from: "2026-01-02", to: "2026-01-02" }).totals.requests, 0);
  assert.equal(report(input, { from: "2026-11-01T05:15:00Z", to: "2026-11-01T06:15:00Z" }).totals.requests, 1);
  const dst = report(input, { timezone: "America/New_York", from: "2026-11-01", to: "2026-11-01", interval: "hour" });
  assert.deepEqual(dst.buckets.filter(bucket => bucket.totals.requests).map(bucket => bucket.key),
    ["2026-11-01T01:00:00-04:00", "2026-11-01T01:00:00-05:00"]);
  assert.equal(dst.buckets.length, 25);
  assert.equal(dst.days[0]?.totals.requests, 2);
  const european = source([session("a")], [["a", usage("first", { occurredAt: "2026-10-25T00:30:00Z" })],
    ["a", usage("second", { occurredAt: "2026-10-25T01:30:00Z" })]]);
  assert.deepEqual(report(european, { timezone: "Europe/Berlin", interval: "hour" }).buckets.filter(bucket => bucket.totals.requests).map(bucket => bucket.key),
    ["2026-10-25T02:00:00+02:00", "2026-10-25T02:00:00+01:00"]);
  const spring = report(source([], []), { timezone: "America/New_York", from: "2026-03-08", to: "2026-03-08", interval: "hour" });
  assert.equal(spring.buckets.length, 23);
  assert.ok(!spring.buckets.some(bucket => bucket.key.includes("T02:")));
  const fractional = report(source([], []), { timezone: "Asia/Kathmandu", from: "2026-01-01", to: "2026-01-01", interval: "hour" });
  assert.equal(fractional.buckets.length, 24);
  assert.equal(fractional.buckets[0]?.key, "2026-01-01T00:00:00+05:45");
  const halfHour = report(source([], []), { timezone: "Australia/Lord_Howe", from: "2026-04-05", to: "2026-04-05", interval: "hour" });
  assert.equal(halfHour.buckets.length, 25);
  assert.deepEqual(halfHour.buckets.filter(bucket => bucket.key.includes("T01:")).map(bucket => bucket.key),
    ["2026-04-05T01:00:00+11:00", "2026-04-05T01:00:00+10:30"]);
});

test("缺时间保留独立用量，无用量会话可检查且不补造请求与零值", () => {
  const input = source([session("known"), session("undated"), session("empty")], [
    ["known", usage("known")], ["undated", usage("missing-time", { occurredAt: undefined })],
    ["undated", usage("invalid-time", { occurredAt: "invalid" })],
  ]);
  const finite = report(input, { from: "2026-01-01", to: "2026-01-01" });
  assert.equal(finite.totals.requests, 1);
  assert.equal(finite.totals.sessions, 1);
  assert.equal(finite.undated.requests, 2);
  assert.equal(finite.undated.tokens, 240);
  assert.equal(finite.undated.missingTimeRequests, 2);
  assert.equal(finite.totalSessions, 2);
  assert.equal(finite.missingUsageSessions, 0);
  assert.ok(!finite.sessions.some(row => row.session.id === "empty"));
  const undated = finite.sessions.find(row => row.session.id === "undated")!;
  assert.equal(undated.totals.tokens, null);
  assert.equal(undated.undated?.tokens, 240);
  const all = report(input);
  assert.equal(all.missingUsageSessions, 1);
  const empty = all.sessions.find(row => row.session.id === "empty")!;
  assert.equal(empty.totals.tokens, null);
  assert.equal(empty.totals.estimatedCost, null);
  assert.equal(empty.requestsTotal, 0);
  assert.equal(all.totals.requests, 3);
  assert.equal(all.totals.tokens, 360);
  assert.equal(all.buckets.reduce((sum, bucket) => sum + bucket.totals.requests, 0), 1);
  assert.equal(all.groups.reduce((sum, group) => sum + group.totals.requests, 0), 3);
  assert.equal(buildUsageRequestPage(input, finite.query, pricing, estimate, "undated").total, 2);
});

test("多模型按请求筛选，包含和排除组合涵盖全部维度与unknown", () => {
  const input = source([session("a", { project: "/workspace/a" }), session("b", { client: "claude", project: "/workspace/b" }), session("unknown")], [
    ["a", usage("a-1", { model: "model-a" })], ["a", usage("a-2", { model: "model-b", inputTokens: 200 })],
    ["b", usage("b-1", { model: "model-b" })], ["unknown", usage("u", { model: undefined })],
  ]);
  assert.equal(report(input, { models: ["model-b"] }).totals.tokens, 340);
  assert.equal(report(input, { models: ["model-a", "model-b"], excludeModels: ["model-a"],
    clients: ["codex", "claude"], excludeClients: ["claude"], projects: ["/workspace/a", "/workspace/b"] }).totals.tokens, 220);
  assert.equal(report(input, { excludeProjects: ["/workspace/a", "/workspace/b"] }).totals.requests, 1);
  const unknown = report(input, { projects: ["unknown"], models: ["unknown"], groupBy: "model" });
  assert.equal(unknown.totals.tokens, 120);
  assert.equal(unknown.totals.unpricedRequests, 1);
  assert.equal(unknown.groups[0]?.key, "unknown");
  assert.deepEqual(unknown.facets.projects, ["/workspace/a", "/workspace/b", "unknown"]);
  assert.deepEqual(unknown.facets.models, ["model-a", "model-b", "unknown"]);
  assert.equal(report(input, { projects: ["/workspace/a"], excludeProjects: ["/workspace/a"] }).totalSessions, 0);
});

test("真实 unknown 与 literal 前缀不与缺失模型和项目合并，分别包含与排除", () => {
  const input = source([session("missing"), session("literal", { project: "unknown" }), session("escaped", { project: "literal:unknown" })], [
    ["missing", usage("missing", { model: undefined })], ["literal", usage("literal", { model: "unknown" })],
    ["escaped", usage("escaped", { model: "literal:unknown" })],
  ]);
  const all = report(input, { groupBy: "model" });
  assert.deepEqual(all.facets.models, ["literal:literal:unknown", "literal:unknown", "unknown"]);
  assert.deepEqual(all.facets.projects, all.facets.models);
  assert.equal(all.groups.length, 3);
  for (const [raw, id] of [[undefined, "missing"], ["unknown", "literal"], ["literal:unknown", "escaped"]] as const) {
    const key = usageDimensionKey(raw);
    assert.equal(usageDimensionValue(key), raw);
    assert.equal(report(input, { models: [key], projects: [key] }).sessions[0]?.session.id, id);
    assert.equal(report(input, { excludeModels: [key] }).totals.requests, 2);
    assert.equal(report(input, { excludeProjects: [key] }).totals.requests, 2);
  }
  assert.equal(all.groups.find(group => group.key === "literal:unknown")?.label, "unknown");
  assert.equal(all.groups.find(group => group.key === "literal:literal:unknown")?.label, "literal:unknown");
});

test("主子会话各自新增量，项目不继承父会话，类型不靠标题猜测", () => {
  const input = source([session("parent", { project: "/workspace/parent" }),
    session("child", { relationship: "child", parentSessionId: "parent", project: "/workspace/child" }),
    session("quiet", { executionMode: "quiet", title: "普通标题" }),
    session("fork", { relationship: "fork", parentSessionId: "parent" })], [
    ["parent", usage("one")], ["child", usage("one")], ["quiet", usage("one")], ["fork", usage("one")],
  ]);
  assert.equal(report(input).totals.requests, 4);
  assert.equal(report(input, { relationship: "child" }).totals.requests, 1);
  assert.equal(report(input, { relationship: "main" }).totals.requests, 3);
  assert.equal(report(input, { projects: ["/workspace/child"] }).sessions[0]?.session.parentSessionId, "parent");
  assert.equal(report(input, { sessionType: "automation" }).sessions[0]?.session.id, "quiet");
  assert.equal(report(input, { sessionType: "fork" }).sessions[0]?.session.id, "fork");
  assert.equal(report(input, { sessionType: "interactive" }).totals.requests, 2);
});

test("用量与价格覆盖分别过滤，部分分项小计和真实零不会成为完整记录", () => {
  const input = source([session("a"), session("empty")], [
    ["a", usage("complete")], ["a", usage("partial", { outputTokens: undefined })],
    ["a", usage("missing", { inputTokens: undefined, outputTokens: undefined, cachedInputTokens: undefined, cacheWriteTokens: undefined })],
    ["a", usage("zero", { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 })],
    ["a", usage("unpriced", { model: "unpriced" })],
  ]);
  const all = report(input);
  assert.equal(all.totals.completeTokenRequests, 3);
  assert.equal(all.totals.partialTokenRequests, 1);
  assert.equal(all.totals.missingTokenRequests, 1);
  assert.equal(all.totals.tokens, 340);
  assert.equal(all.totals.pricedRequests, 2);
  assert.equal(all.totals.partiallyPricedRequests, 1);
  assert.equal(all.totals.unpricedRequests, 2);
  assert.equal(report(input, { coverage: "complete" }).totals.requests, 3);
  assert.equal(report(input, { coverage: "partial" }).totals.requests, 1);
  const missing = report(input, { coverage: "missing" });
  assert.equal(missing.totals.tokens, null);
  assert.equal(missing.totals.requests, 1);
  assert.equal(missing.missingUsageSessions, 1);
  assert.equal(report(input, { pricing: "missing", coverage: "complete" }).totals.requests, 1);
  const zero = report(input, { maxTokens: 0, minTokens: 0, coverage: "complete", excludeModels: ["unpriced"] });
  assert.equal(zero.totalSessions, 0);
  const zeroOnly = report(source([session("zero")], [["zero", usage("zero", { inputTokens: 0, outputTokens: 0 })]]));
  assert.equal(zeroOnly.totals.tokens, 0);
  assert.equal(zeroOnly.totals.estimatedCost, 0);
});

test("Token与费用阈值针对会话当前过滤范围，稳定排序将未知值放在末尾", () => {
  const input = source([session("a"), session("b"), session("empty")], [
    ["a", usage("a1", { inputTokens: 80 })], ["a", usage("a2", { inputTokens: 80 })],
    ["b", usage("b1", { inputTokens: 120 })],
  ]);
  const tokens = report(input, { minTokens: 180, maxTokens: 220 });
  assert.equal(tokens.totalSessions, 1);
  assert.equal(tokens.sessions[0]?.session.id, "a");
  assert.equal(tokens.totals.tokens, 200);
  assert.equal(tokens.totals.requests, 2);
  const cost = report(input, { minCost: 0.00018, maxCost: 0.00022 });
  assert.equal(cost.sessions[0]?.session.id, "a");
  const ascending = report(input, { sort: "tokens", direction: "asc" });
  assert.deepEqual(ascending.sessions.map(row => row.session.id), ["b", "a", "empty"]);
  assert.equal(report(input, { minTokens: 0 }).totalSessions, 2);
});

test("缓存比例的分子分母来自相同可计算请求集合，推理和缓存不重复累计", () => {
  const input = source([session("a")], [
    ["a", usage("pair", { inputTokens: 100, outputTokens: 40, cachedInputTokens: 20, cacheWriteTokens: 10, reasoningOutputTokens: 30 })],
    ["a", usage("no-cache", { inputTokens: 900, cachedInputTokens: undefined, cacheWriteTokens: undefined })],
    ["a", usage("invalid-cache", { inputTokens: 20, cachedInputTokens: 50, cacheWriteTokens: undefined })],
  ]);
  const result = report(input);
  assert.equal(result.totals.tokens, 1100);
  assert.equal(result.totals.freshInputTokens, 70);
  assert.equal(result.totals.reasoningTokens, 30);
  assert.equal(result.totals.cacheReadRatio, 0.2);
  assert.equal(result.totals.cacheReadRatioRequests, 1);
  assert.equal(result.days[0]?.totals.cacheReadRatioRequests, 1);
  assert.equal(result.groups[0]?.totals.cacheReadRatioRequests, 1);
  assert.equal(result.totals.inputTokens, 1020);
});

test("周与月聚合保持日总量，没有活动的所选日期保留空桶", () => {
  const input = source([session("a")], [["a", usage("first", { occurredAt: "2026-01-04T10:00:00Z" })],
    ["a", usage("second", { occurredAt: "2026-01-05T10:00:00Z" })]]);
  const weekly = report(input, { interval: "week", from: "2026-01-01", to: "2026-01-10" });
  assert.deepEqual(weekly.buckets.map(bucket => [bucket.key, bucket.totals.requests]), [["2025-12-29", 1], ["2026-01-05", 1]]);
  assert.equal(weekly.days.length, 10);
  const monthly = report(input, { interval: "month", from: "2026-01-01", to: "2026-02-03" });
  assert.deepEqual(monthly.buckets.map(bucket => [bucket.key, bucket.totals.requests]), [["2026-01-01", 2], ["2026-02-01", 0]]);
  const empty = report(source([], []), { from: "2026-01-01", to: "2026-01-03" });
  assert.equal(empty.days.length, 3);
  assert.equal(empty.totals.tokens, null);
  assert.equal(empty.days[0]?.totals.requests, 0);
});

test("可靠请求身份更新快照，数值相同的新请求不会去重，证据分页可取全部", () => {
  const requests: [string, SessionUsage][] = Array.from({ length: 31 }, (_, index) => ["a", usage(`request-${String(index).padStart(2, "0")}`)]);
  requests.push(["a", usage("request-00", { inputTokens: 200 })]);
  const input = source([session("a")], requests);
  const result = report(input);
  assert.equal(result.totals.requests, 31);
  assert.equal(result.totals.tokens, 3820);
  assert.equal(result.sessions[0]?.requests.length, 12);
  assert.equal(result.sessions[0]?.requestsTotal, 31);
  assert.equal(result.sessions[0]?.requestsLimited, true);
  const first = buildUsageRequestPage(input, result.query, pricing, estimate, "a", 1, 20);
  const second = buildUsageRequestPage(input, result.query, pricing, estimate, "a", 2, 20);
  assert.equal(first.total, 31);
  assert.equal(second.requests.length, 11);
  assert.equal(new Set([...first.requests, ...second.requests].map(item => item.usage.id)).size, 31);
  assert.equal(buildUsageRequestPage(input, result.query, pricing, estimate, "missing").total, 0);
});

test("超大单会话的无时间请求可全部聚合且主响应只返回有界证据", () => {
  const count = 130_000;
  const input = source([session("large")], Array.from({ length: count }, (_, index) => ["large", usage(`request-${index}`, { occurredAt: undefined })]));
  const result = report(input);
  assert.equal(result.totals.requests, count);
  assert.equal(result.totals.tokens, count * 120);
  assert.equal(result.undated.requests, count);
  assert.equal(result.buckets.length, 0);
  assert.equal(result.sessions[0]?.requests.length, 12);
  assert.equal(result.sessions[0]?.requestsTotal, count);
  const last = buildUsageRequestPage(input, result.query, pricing, estimate, "large", count / 200, 200);
  assert.equal(last.requests.length, 200);
  assert.equal(last.total, count);
});

test("版本、时间、单位范围和分页输入错误明确失败", () => {
  const input = source([], []);
  for (const query of [{ version: "missing" }, { priceVersion: "missing" }, { timezone: "invalid/timezone" },
    { from: "2026-02-30" }, { from: "2026-02-30T00:00:00Z" }, { to: "invalid" }, { from: "2026-01-03", to: "2026-01-01" },
    { page: 0 }, { pageSize: 201 }, { minTokens: -1 }, { minCost: NaN }, { minTokens: 10, maxTokens: 1 }]) {
    assert.throws(() => report(input, query));
  }
  assert.throws(() => buildUsageRequestPage(input, {}, pricing, estimate, "a", 0));
  assert.throws(() => buildUsageRequestPage(input, {}, pricing, estimate, "a", 1, 201));
});

test("全局索引只读取有效发布副本、批量父子关系与非复制请求，未发布修订不可见", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-usage-index-"));
  const store = new SessionStore(join(directory, "index.sqlite"));
  const add = (id: string, extra: Partial<SessionSourceMeta>, usages: SessionUsage[], messages: Partial<SessionMessage>[] = []) => {
    const meta: SessionSourceMeta = { ...session(id), path: `/workspace/history/${id}.jsonl`, sourceId: `codex:${id}`, ...extra };
    const pending = store.createRevision(meta.path, "synthetic-fingerprint");
    for (const [ordinal, extra] of messages.entries()) pending.sink.message({ id: `message-${ordinal}`, sessionId: id, ordinal,
      recordLine: ordinal + 1, turnId: "turn", kind: "assistant", text: "合成正文", ...extra });
    for (const item of usages) pending.sink.usage(item);
    pending.flush(); store.finishRevision(pending.revision, meta);
    return { path: meta.path, revision: pending.revision, fingerprint: "synthetic-fingerprint" };
  };
  try {
    assert.throws(() => store.usageSource(), /尚未完成/);
    const parent = add("parent", { childSessionIds: ["child"], project: "/workspace/parent" }, [usage("parent-use")], [{}]);
    const child = add("child", { titleOrigin: "fallback", taskName: "合成子任务", project: "/workspace/child" }, [
      usage("own", { messageId: "message-1" }), usage("copied", { messageId: "message-0" }),
      usage("group-copy", { requestMessageIds: ["message-0"] }), usage("timing-copy", { timing: {
        basis: "recorded", method: "claude_message_boundary", completion: "explicit", end: { recordLine: 1, messageId: "message-0" },
      } }),
    ], [{ copied: true }, { copied: false }]);
    const oldCopy = add("parent", { path: "/workspace/history/archived-parent.jsonl", messageCount: 0 }, [usage("old-duplicate")]);
    const first = store.publish(store.createJob().id, [parent, child, oldCopy], []);
    add("unpublished", {}, [usage("unpublished")]);
    store.profile = () => { throw new Error("全局统计不应逐会话读取画像"); };
    const result = store.usageSource(first);
    assert.deepEqual(result.requests.map(item => item.usage.id).sort(), ["own", "parent-use"]);
    assert.equal(result.sessions.length, 2);
    const childSummary = result.sessions.find(item => item.id === "child")!;
    assert.equal(childSummary.relationship, "child");
    assert.equal(childSummary.parentSessionId, "parent");
    assert.equal(childSummary.title, "合成子任务");
    assert.equal(childSummary.project, "/workspace/child");
    assert.equal(childSummary.parentTitle, "合成用量会话");
    assert.ok(!("path" in childSummary));
    assert.ok(!("sourceId" in childSummary));
    assert.equal(report(result).totals.requests, 2);
    const next = store.publish(store.createJob().id, [parent], []);
    assert.equal(store.usageSource(next).requests.length, 1);
    assert.equal(store.usageSource(first).requests.length, 2);
    assert.throws(() => store.usageSource("missing-version"), /不存在/);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});


test("有限范围排除无用量会话后，旧链接超出页数时回到末页且指标不变", () => {
  const input = source([session("known"), session("empty")], [["known", usage("known")]]);
  const query = { from: "2026-01-01", to: "2026-01-01", pageSize: 20 };
  const first = report(input, query), overflow = report(input, { ...query, page: 62 });
  assert.equal(overflow.page, 1);
  assert.deepEqual(overflow.sessions, first.sessions);
  assert.deepEqual(overflow.totals, first.totals);
  assert.equal(report(source([], []), { ...query, page: 62 }).page, 1);
});
