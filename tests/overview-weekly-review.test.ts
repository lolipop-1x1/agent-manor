import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { SessionMessage, SessionSourceMeta, SessionUsage } from "../src/session-contracts.js";
import { SessionStore } from "../src/sessions/store.js";
import { PricingService, createPricingEstimator } from "../src/usage/pricing.js";
import type { PricingStatus } from "../src/usage-contracts.js";
import { OverviewManager } from "../src/overview/manager.js";
import { OverviewFactStore } from "../src/overview/facts.js";
import { WeeklyReviewFactStore, weeklyReviewRange } from "../src/overview/weekly-review-facts.js";
import { buildWeeklyReview, weeklyReviewDetail } from "../src/overview/weekly-review.js";
import { weeklyReviewDetailQuery } from "../src/service/overview-input.js";
import { promptCharacterCount, summarizeRoundMetrics } from "../src/sessions/round-metrics.js";
import { clientIds } from "../src/clients.js";
import { parseSessionSource } from "../src/sessions/parser.js";

const now = new Date("2026-10-12T04:00:00Z");
const priceStatus: PricingStatus = { version: "synthetic-price", currency: "USD", source: "bundled", sourceUrl: "https://example.invalid/prices",
  refreshing: false, configuration: { overrides: [], mappings: [] }, prices: [{ model: "synthetic-model", provider: "synthetic-provider",
    input: 10, output: 20, cacheRead: 2, cacheWrite: 10, tiers: [{ context: 200, input: 20, cacheRead: 4 }] }] };
const pricing = { status: priceStatus, estimate: createPricingEstimator(priceStatus, true) };
function message(sessionId: string, id: string, ordinal: number, date: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { sessionId, id, ordinal, recordLine: ordinal, turnId: "turn", kind: "user", text: "合成需求", occurredAt: date, ...extra };
}
function usage(id: string, date: string, extra: Partial<SessionUsage> = {}): SessionUsage {
  return { id, turnId: "turn", model: "synthetic-model", provider: "synthetic-provider", occurredAt: date,
    inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, reasoningEffort: "high", ...extra };
}
function revision(store: SessionStore, id: string, messages: SessionMessage[], usages: SessionUsage[], extra: Partial<SessionSourceMeta> = {}) {
  const summary: SessionSourceMeta = { id, client: "codex", clientSessionId: id, title: "合成会话", titleOrigin: "recorded",
    sourceId: `synthetic-${id}`, path: `/workspace/history/${id}.jsonl`, startedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-11T23:00:00Z",
    messageCount: messages.length, turnCount: 3, models: ["synthetic-model"], project: "/workspace/project", gaps: [], ...extra };
  const pending = store.createRevision(summary.path, `synthetic-${id}`);
  for (const row of messages) pending.sink.message(row);
  for (const row of usages) pending.sink.usage(row);
  pending.flush(); store.finishRevision(pending.revision, summary);
  return { path: summary.path, revision: pending.revision, fingerprint: `synthetic-${id}` };
}
async function fixture(run: (store: SessionStore, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-weekly-review-")), store = new SessionStore(join(directory, "index.sqlite"));
  try { await run(store, directory); }
  finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

test("CLI 原始省略零缓存经解析和周复盘计算零命中、普通输入和价差，零输入不算满命中", async () => fixture(async (store, directory) => {
  const path = join(directory, "serialized-cache.jsonl"), at = "2026-10-07T01:00:00Z";
  const assistant = (uuid: string, usage: object) => ({ type: "message", sessionId: "cache-fixture", uuid, role: "assistant", timestamp: at,
    model: "synthetic-model", content: "合成回复", usage,
    metadata: { requestTokenBaseline: { requestId: uuid, requestContextKey: "synthetic-context", historyRevision: 0 } } });
  await writeFile(path, [{ type: "message", sessionId: "cache-fixture", uuid: "u", role: "user", timestamp: at, content: "合成需求" },
    assistant("zero", { input_tokens: 100, output_tokens: 10 }),
    assistant("partial", { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 50 }),
    assistant("empty", { input_tokens: 0, output_tokens: 0 }),
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  const pending = store.createRevision(path, "synthetic-cache");
  const summary = await parseSessionSource({ client: "codeflicker", path }, pending.sink);
  pending.flush(); store.finishRevision(pending.revision, summary);
  const version = store.publish(store.createJob().id, [{ path, revision: pending.revision, fingerprint: "synthetic-cache" }], []);
  const facts = new WeeklyReviewFactStore(store);
  try {
    const query = { version, timezone: "UTC", anchorDay: "2026-10-12" }, data = buildWeeklyReview((await facts.source(query, now)).facts, query, pricing, now);
    assert.deepEqual([data.review.cache.zero, data.review.cache.partial, data.review.cache.full, data.review.cache.unknown], [1, 1, 0, 1]);
    assert.equal(data.review.cache.freshInputTokens, 250);
    assert(Math.abs(data.review.cache.hypotheticalPremium! - 0.0032) < 1e-12);
    assert.equal(data.review.cache.readShare, 50 / 300);
    assert.equal(store.profile(summary.id).usage.cachedInputTokens, 50);
    assert.equal(store.profile(summary.id).usage.cacheWriteTokens, 0);
    assert.equal(weeklyReviewDetail(data, { kind: "cache", filter: "zero" }).total, 1);
  } finally { facts.close(); }
}));

test("所有客户端共用末条回复：无终态、空消息、取消和跨周整轮冷暖结果一致", async () => fixture(async (store, directory) => {
  const sources = clientIds.map(client => revision(store, client, [
    message(client, "u", 0, "2026-10-04T23:59:00Z"),
    message(client, "early", 1, "2026-10-05T00:00:00Z", { kind: "assistant", final: "explicit" }),
    message(client, "last", 2, "2026-10-05T00:01:00Z", { kind: "assistant", finalAt: "2026-10-05T00:10:00Z" }),
    message(client, "blank", 3, "2026-10-05T00:02:00Z", { kind: "assistant", text: "\u3000\u00a0\n\t", final: "explicit" }),
    message(client, "cancel", 4, "2026-10-05T00:03:00Z", { kind: "context", interrupted: true, contextSource: "client" }),
    message(client, "pending", 5, "2026-10-06T00:00:00Z", { turnId: "pending" }),
    message(client, "thinking", 6, "2026-10-06T00:01:00Z", { turnId: "pending", kind: "thinking" }),
  ], [usage("before", "2026-10-04T23:59:30Z"), usage("last", "2026-10-05T00:00:30Z", { messageId: "last",
    timing: { basis: "estimated", method: "qoder_message_boundary", completion: "partial" } })], { client }));
  const version = store.publish(store.createJob().id, sources, []), query = { version, timezone: "UTC", anchorDay: "2026-10-12" };
  const check = async (name: string) => {
    const factsStore = new WeeklyReviewFactStore(store, join(directory, name));
    try {
      for (const client of clientIds) {
        const profile = store.profile(client).roundMetrics!;
        const scoped = { ...query, clients: [client] }, data = buildWeeklyReview((await factsStore.source(scoped, now)).facts, scoped, pricing, now);
        assert.equal(profile.userTurns, 2);
        assert.equal(profile.completedTurns, 1);
        assert.equal(profile.averageSteps, 2);
        assert.equal(profile.averageDurationMs, 120000);
        assert.equal(data.review.rounds.steps.average, profile.averageSteps);
        assert.equal(data.review.rounds.durationMs.average, profile.averageDurationMs);
        assert.equal(data.review.rounds.tokens.average, 220, "跨周整轮使用两个请求，不只取周内请求");
        assert.equal(data.review.cache.requests, 1, "缓存事件窗口仍只取周内请求");
        assert.equal(store.messages(client, { mode: "brief", branch: "all" }).messages.find(row => row.kind === "assistant")!.id, "last");
        assert.deepEqual(buildWeeklyReview((await factsStore.source(scoped, now)).facts, scoped, pricing, now).review, data.review);
      }
    } finally { factsStore.close(); }
  };
  await check("raw-replies.sqlite");
  const overview = new OverviewFactStore(store);
  try { await overview.prepare(query, now); } finally { overview.close(); }
  await check("cached-replies.sqlite");
}));
function history(store: SessionStore) {
  const main = revision(store, "main", [
    message("main", "old-compression", 1, "2026-10-01T01:00:00Z", { kind: "compression", turnId: "old" }),
    message("main", "cross-user", 2, "2026-10-04T15:00:00Z", { turnId: "cross", text: "合成跨周需求" }),
    message("main", "cross-end", 3, "2026-10-04T17:00:00Z", { turnId: "cross", kind: "assistant", final: "explicit" }),
    message("main", "user", 4, "2026-10-07T01:00:00Z", { text: " A\t中\u3000\u00a0😀\r\n" }),
    message("main", "user-block", 5, "2026-10-07T01:00:00Z", { text: "B", recordLine: 4 }),
    message("main", "injected", 6, "2026-10-07T01:00:00Z", { text: "应排除注入", contextSource: "agents_md" }),
    message("main", "copied", 7, "2026-10-07T01:00:00Z", { turnId: "copied-turn", copied: true, text: "应排除复制" }),
    message("main", "failed-call", 8, "2026-10-07T01:00:10Z", { kind: "tool_call", tool: "synthetic-tool", callId: "call" }),
    message("main", "failed-result", 9, "2026-10-07T01:00:20Z", { kind: "tool_result", tool: "synthetic-tool", callId: "call", status: "failure" }),
    message("main", "later-call", 10, "2026-10-07T01:00:30Z", { kind: "tool_call", tool: "synthetic-tool", status: "success" }),
    message("main", "end", 11, "2026-10-07T01:02:00Z", { kind: "assistant", final: "explicit" }),
    message("main", "inferred-user", 12, "2026-10-08T01:00:00Z", { turnId: "inferred" }),
    message("main", "inferred-end", 13, "2026-10-08T01:01:00Z", { turnId: "inferred", kind: "assistant", final: "inferred" }),
    message("main", "current-compression", 14, "2026-10-09T01:00:00Z", { kind: "compression" }),
    message("main", "missing-end-user", 15, "2026-10-10T01:00:00Z", { turnId: "missing-end" }),
    message("main", "missing-end", 16, "", { turnId: "missing-end", kind: "assistant", final: "explicit", occurredAt: undefined }),
    message("main", "today", 17, "2026-10-12T01:00:00Z", { turnId: "today" }),
  ], [
    usage("cross-before", "2026-10-04T15:30:00Z", { turnId: "cross", inputTokens: 400, outputTokens: 20 }),
    usage("cross-after", "2026-10-04T16:30:00Z", { turnId: "cross" }),
    usage("normal-zero", "2026-10-07T01:00:10Z"),
    usage("normal-partial", "2026-10-07T01:00:40Z", { inputTokens: 200, outputTokens: 20, cachedInputTokens: 50, reasoningEffort: "low" }),
    usage("normal-unknown", "2026-10-07T01:01:00Z", { inputTokens: 100, outputTokens: 30, cachedInputTokens: undefined, reasoningEffort: undefined }),
    usage("inferred-usage", "2026-10-08T01:00:30Z", { turnId: "inferred", inputTokens: 50, outputTokens: undefined }),
    usage("copied-usage", "2026-10-07T01:01:00Z", { turnId: "copied-turn", messageId: "copied", inputTokens: 99999 }),
    usage("today-usage", "2026-10-12T01:00:30Z", { turnId: "today" }),
  ], { updatedAt: "2026-10-12T01:00:30Z" });
  const clear = revision(store, "clear", [message("clear", "clear-user", 1, "2026-10-11T01:00:00Z"),
    message("clear", "clear-final", 2, "2026-10-11T01:00:10Z", { kind: "assistant", final: "explicit" })],
  [usage("clear-usage", "2026-10-11T01:00:05Z", { inputTokens: 123, cachedInputTokens: 123 })]);
  const unsupported = revision(store, "unsupported", [message("unsupported", "unsupported-user", 1, "2026-10-11T01:00:00Z")],
    [usage("unsupported-usage", "2026-10-11T01:00:05Z", { inputTokens: 999, cachedInputTokens: 0, cacheWriteTokens: undefined })], { client: "zcode" });
  const child = revision(store, "child", [message("child", "child-user", 1, "2026-10-11T01:00:00Z")],
    [usage("child-usage", "2026-10-11T01:00:05Z", { inputTokens: 50, outputTokens: 5 })], { relationship: "child", parentSessionId: "main" });
  const old = revision(store, "old", [message("old", "old-user", 1, "2026-09-01T01:00:00Z")], [],
    { startedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z" });
  return store.publish(store.createJob().id, [main, clear, unsupported, child, old], []);
}

test("七天复盘口径：完整跨周轮次、缓存档位、压缩支持、输入Unicode和子Agent独立", async () => fixture(async (store, directory) => {
  const version = history(store), factsStore = new WeeklyReviewFactStore(store), query = { version, timezone: "Asia/Shanghai", anchorDay: "2026-10-12" };
  const read = store.weeklyReviewRevisionFacts.bind(store), scanned: string[] = [];
  store.weeklyReviewRevisionFacts = (revisionId, sessionId, scope) => { scanned.push(sessionId); return read(revisionId, sessionId, scope); };
  try {
    const { facts } = await factsStore.source(query, now), data = buildWeeklyReview(facts, query, pricing, now), report = data.review;
    assert.deepEqual([report.range.from, report.range.to, report.range.comparison], ["2026-10-05", "2026-10-11", null]);
    assert(!scanned.includes("old"), "首算不扫描范围外旧会话");
    assert.equal(report.sessions.active, 3);
    assert.equal(report.sessions.compressions, 1);
    assert.equal(report.sessions.compressionSessions, 1);
    assert.equal(report.sessions.uncompressedPeakInput.average, 123, "旧压缩与不支持压缩观测的来源排除");
    assert.equal(report.rounds.completed, 4);
    assert.equal(report.rounds.inferred, 1);
    assert.equal(report.rounds.missingEndTime, 1);
    assert.equal(report.rounds.steps.average, 7 / 4);
    assert.equal(report.rounds.toolCalls.average, 2 / 4);
    assert.equal(report.rounds.tokens.average, (530 + 460 + 133) / 3);
    assert.equal(report.rounds.durationMs.maximum, 7200000);
    assert.equal(report.rounds.longest[0]!.title, "合成跨周需求");
    assert.equal(report.rounds.longest[0]!.messageId, "cross-user");
    assert.equal(report.rounds.topFiveTokenShare, 1);
    assert.equal(report.cache.requests, 7);
    assert.equal(report.cache.zero, 4);
    assert.equal(report.cache.partial, 1);
    assert.equal(report.cache.full, 1);
    assert.equal(report.cache.unknown, 1);
    const partial = weeklyReviewDetail(data, { kind: "cache", filter: "partial" }).rows[0]!;
    assert.equal(partial.freshInputTokens, 150);
    assert.equal(partial.cost!.appliedContextThreshold, 200);
    assert.equal(partial.hypotheticalPremium, 150 * (20 - 4) / 1_000_000);
    assert.equal(report.cache.premiumMissing, 2, "缓存字段缺失或非Codex缺缓存写入分项，不冒充价差样本");
    assert.equal(report.extensions.children.requests, 1);
    assert.equal(report.extensions.children.tokens, 55);
    assert.equal(report.extensions.tools.failures, 1);
    assert.equal("subsequentCalls" in report.extensions.tools, false);
    assert.equal(report.extensions.tools.failedRounds, 1);
    const prompt = weeklyReviewDetail(data, { kind: "prompts" }).rows.find(row => row.messageId === "user")!;
    assert.equal(prompt.promptCharacters, 4);
    assert.equal(promptCharacterCount(" A\t中\u3000\u00a0😀\r\nB"), 4);
    const raw = read(store.usageFactSession(version, "main")!.revision, "main");
    const profile = summarizeRoundMetrics(raw.events.map(event => ({ ...event, text: event.id === "user" ? " A\t中\u3000\u00a0😀\r\n" : event.id === "user-block" ? "B" : event.promptPreview })), raw.requests.map(request => request.usage));
    assert.equal(profile.promptInputs, 5, "单会话含今天和跨周原始输入，周复盘只按事件日期");
    assert.equal(report.preferences.userMessages, 5);
    assert.equal(report.preferences.hours[9]!.messages, 5);
    assert.equal(report.preferences.reasoning.find(row => row.key === "unknown")!.count, 1);
    assert.equal(report.coverage.triggerIdentity, "unclassified");
    assert.equal(report.coverage.automaticSessions, null);
    assert.equal(weeklyReviewDetail(data, { kind: "models", key: "synthetic-model", pageSize: 2, page: 2 }).rows.length, 2);
    assert.equal(weeklyReviewDetail(data, { kind: "rounds", filter: "inferred" }).total, 1);
    const before = scanned.length;
    await factsStore.source(query, now);
    assert.equal(scanned.length, before, "派生事实复用同修订，无正文或消息重新扫描");
    const cachePath = join(directory, "weekly-review-facts-v2.sqlite");
    assert.equal(statSync(cachePath).mode & 0o777, 0o600);
    const cache = new Database(cachePath, { readonly: true });
    try { assert.equal((cache.prepare("SELECT COUNT(*) AS count FROM weekly_events WHERE json LIKE '%应排除注入%'").get() as { count: number }).count, 0); }
    finally { cache.close(); }
  } finally { factsStore.close(); }
}));

test("复盘范围固定完整本地日期，跨DST不取过去168小时，详情输入严格校验", () => {
  assert.deepEqual([weeklyReviewRange({ timezone: "America/New_York" }, new Date("2026-03-09T03:30:00Z")).from,
    weeklyReviewRange({ timezone: "America/New_York" }, new Date("2026-03-09T03:30:00Z")).to], ["2026-03-01", "2026-03-07"]);
  assert.equal(weeklyReviewDetailQuery(JSON.stringify({ kind: "cache", filter: "unknown", pageSize: 10 })).filter, "unknown");
  assert.equal(weeklyReviewDetailQuery(JSON.stringify({ kind: "sessionRounds", sort: "rounds" })).sort, "rounds");
  assert.equal(weeklyReviewDetailQuery(JSON.stringify({ kind: "sessionRounds", sort: "recent" })).sort, "recent");
  for (const value of [{ kind: "nope" }, { kind: "rounds", filter: "zero" }, { kind: "cache", pageSize: 101 }, { kind: "prompts", key: "x" },
    { kind: "sessionRounds", filter: "ended" }, { kind: "sessionRounds", key: "x" }, { kind: "sessionRounds", sort: "tokens" }, { kind: "rounds", sort: "rounds" }])
    assert.throws(() => weeklyReviewDetailQuery(JSON.stringify(value)));
});

test("平均每会话轮次按窗口内真实发起统计，回复跨周、通知、子会话和无新需求活动不混入", async () => fixture(async store => {
  const a = revision(store, "a", [
    message("a", "cross-user", 1, "2026-10-04T10:00:00Z", { turnId: "cross" }),
    message("a", "cross-end", 2, "2026-10-06T01:00:00Z", { turnId: "cross", kind: "assistant" }),
    message("a", "a-user", 3, "2026-10-07T01:00:00Z", { turnId: "first" }),
    message("a", "a-block", 4, "2026-10-07T01:00:00Z", { turnId: "first", recordLine: 3 }),
    message("a", "a-end", 5, "2026-10-07T01:01:00Z", { turnId: "first", kind: "assistant" }),
    message("a", "notification", 6, "2026-10-08T01:00:00Z", { turnId: "notification", contextSource: "agents_md" }),
    message("a", "copied", 7, "2026-10-08T01:00:00Z", { turnId: "copied", copied: true }),
    message("a", "pending", 8, "2026-10-09T01:00:00Z", { turnId: "pending" }),
    message("a", "today", 9, "2026-10-12T01:00:00Z", { turnId: "today" }),
  ], [], { updatedAt: "2026-10-12T01:00:00Z" });
  const b = revision(store, "b", [message("b", "b-user", 1, "2026-10-11T01:00:00Z")], [], { client: "claude", project: "/workspace/other" });
  const continuing = revision(store, "continuing", [message("continuing", "old", 1, "2026-10-01T01:00:00Z"),
    message("continuing", "reply", 2, "2026-10-10T01:00:00Z", { kind: "assistant" })], []);
  const boundary = revision(store, "boundary", [message("boundary", "boundary-user", 1, "2026-10-04T17:00:00Z")], []);
  const child = revision(store, "child", [message("child", "child-user", 1, "2026-10-11T01:00:00Z")], [], { relationship: "child", parentSessionId: "a" });
  const fork = revision(store, "unknown-fork", [message("unknown-fork", "fork-user", 1, "2026-10-11T01:00:00Z")], [],
    { relationship: "fork", gaps: [{ kind: "incomplete_record", message: "合成继承边界未知", messageDescriptor: { key: "diagnostics.sessions.parser.m019" } }] });
  const version = store.publish(store.createJob().id, [a, b, continuing, boundary, child, fork], []), factsStore = new WeeklyReviewFactStore(store);
  try {
    const query = { version, timezone: "UTC", anchorDay: "2026-10-12" }, source = await factsStore.source(query, now);
    const data = buildWeeklyReview(source.facts, query, pricing, now), metric = data.review.sessions.roundsPerSession;
    assert.equal(data.review.sessions.active, 3);
    assert.equal(data.review.rounds.started, 3);
    assert.equal(data.review.rounds.completed, 3, "跨周回复与本周发起是不同的范围");
    assert.deepEqual(metric, { average: 1.5, median: 1.5, p90: 1.9, maximum: 2, samples: 2, missing: 0 });
    const detail = weeklyReviewDetail(data, { kind: "sessionRounds" });
    assert.equal(detail.total, metric.samples);
    assert.equal(detail.rows.reduce((sum, row) => sum + row.roundCount!, 0), data.review.rounds.started);
    assert.deepEqual(detail.rows.map(row => [row.sessionId, row.roundCount]), [["a", 2], ["b", 1]]);
    assert.equal(detail.rows[0]!.messageId, "pending");
    assert.equal(detail.rows[0]!.occurredAt, "2026-10-09T01:00:00Z");
    assert.equal(weeklyReviewDetail(data, { kind: "sessionRounds", sort: "recent" }).rows[0]!.sessionId, "b");
    const paged = weeklyReviewDetail(data, { kind: "sessionRounds", pageSize: 1, page: 2 });
    assert.equal(paged.total, 2); assert.equal(paged.rows[0]!.sessionId, "b");
    assert.deepEqual(paged.review.sessions.roundsPerSession, metric);
    for (const [scope, average, samples, started] of [
      [{ clients: ["codex"] }, 2, 1, 2], [{ projects: ["/workspace/other"] }, 1, 1, 1],
      [{ clients: ["dsh"] }, null, 0, 0],
    ] as const) {
      const scoped = { ...query, ...scope, clients: scope.clients ? [...scope.clients] : undefined, projects: scope.projects ? [...scope.projects] : undefined };
      const report = buildWeeklyReview((await factsStore.source(scoped, now)).facts, scoped, pricing, now).review;
      assert.equal(report.sessions.roundsPerSession.average, average);
      assert.equal(report.sessions.roundsPerSession.samples, samples); assert.equal(report.rounds.started, started);
    }
    const local = { ...query, timezone: "Asia/Shanghai" };
    const localData = buildWeeklyReview((await factsStore.source(local, now)).facts, local, pricing, now);
    assert.equal(localData.review.sessions.roundsPerSession.average, 4 / 3);
    assert.equal(localData.review.sessions.roundsPerSession.samples, 3);
    const continuedOnly = buildWeeklyReview(source.facts.filter(fact => fact.session.id === "continuing"), query, pricing, now).review;
    assert.equal(continuedOnly.sessions.active, 1); assert.equal(continuedOnly.rounds.completed, 1);
    assert.equal(continuedOnly.sessions.roundsPerSession.average, null, "没有新发起轮次的活跃会话不进入分母，也不补零");
  } finally { factsStore.close(); }
}));

test("正文隐藏不否定用量与压缩支持，留存缺口和未知fork边界保持独立排除", async () => fixture(async store => {
  const pair = (id: string) => [message(id, `${id}-user`, 1, "2026-10-07T01:00:00Z"),
    message(id, `${id}-final`, 2, "2026-10-07T01:00:10Z", { kind: "assistant", final: "explicit" })];
  const hidden = revision(store, "hidden", pair("hidden"), [usage("hidden-request", "2026-10-07T01:00:05Z", { inputTokens: 123, contextTokens: 999999 })],
    { gaps: [{ kind: "unsupported_format", message: "合成隐藏正文", messageDescriptor: { key: "diagnostics.sessions.parser.m012" } }] });
  const truncated = revision(store, "truncated", pair("truncated"), [usage("truncated-request", "2026-10-07T01:00:05Z", { inputTokens: 999 })],
    { gaps: [{ kind: "incomplete_record", message: "合成留存缺口" }] });
  const fork = revision(store, "fork", pair("fork"), [usage("fork-request", "2026-10-07T01:00:05Z", { inputTokens: 777 })],
    { relationship: "fork", gaps: [{ kind: "ambiguous", message: "合成共享边界未知", messageDescriptor: { key: "diagnostics.sessions.parser.m019" } }] });
  const version = store.publish(store.createJob().id, [hidden, truncated, fork], []), factsStore = new WeeklyReviewFactStore(store);
  try {
    const query = { version, timezone: "UTC" }, data = buildWeeklyReview((await factsStore.source(query, now)).facts, query, pricing, now);
    assert.equal(data.review.sessions.active, 2);
    assert.equal(data.review.rounds.completed, 2);
    assert.equal(data.review.rounds.tokens.samples, 1);
    assert.equal(data.review.rounds.tokens.missing, 1);
    assert.equal(data.review.rounds.tokens.average, 133);
    assert.equal(data.review.sessions.uncompressedPeakInput.average, 123, "只使用输入事实，不复用混合语义contextTokens");
    assert.equal(data.review.coverage.unknownForkSessions, 1);
    assert.equal(data.review.coverage.unsupportedCompressionSessions, 1);
    assert.equal(weeklyReviewDetail(data, { kind: "projects", key: "/workspace/project" }).total, 2);
    assert.equal(data.ranks.projects![0]!.count, 2);
  } finally { factsStore.close(); }
}));

test("后台复盘跳过年范围准备，重复和重启缓存复用，价格与版本绑定", async () => fixture(async (store, directory) => {
  const version = history(store), prices = new PricingService(directory), manager = new OverviewManager(store, prices, () => [], () => now);
  const internal = manager as unknown as { nextId: number; dispatch(type: string, ...args: unknown[]): Promise<unknown> };
  const dispatch = internal.dispatch.bind(manager), dispatched: string[] = [];
  internal.dispatch = (type, ...args) => { dispatched.push(type); return dispatch(type, ...args); };
  let restart: OverviewManager | undefined;
  try {
    const query = { version, timezone: "Asia/Shanghai", window: "365" as const, from: "2020-01-01", to: "2026-10-12", models: ["unselected-model"] };
    const [first, second] = await Promise.all([manager.review(query), manager.review(query)]);
    assert.deepEqual(first, second); assert.equal(first.cache.requests, 7);
    assert.deepEqual(dispatched, ["review"], "不为周复盘发起整年prepare与旧洞察聚合");
    assert.equal(first.query.models, undefined);
    const detail = await manager.reviewDetail(first.query, { kind: "rounds", sort: "duration", pageSize: 1 });
    assert.equal(detail.rows[0]!.durationMs, 7200000); assert.equal(detail.version, first.version); assert.equal(detail.priceVersion, first.priceVersion);
    assert.deepEqual(detail.range, first.range);
    const count = internal.nextId; await manager.review(query); assert.equal(internal.nextId, count);
    await manager.close(); restart = new OverviewManager(store, prices, () => [], () => now);
    assert.deepEqual(await restart.review(query), first); assert.equal((restart as unknown as { nextId: number }).nextId, 0);
    await assert.rejects(restart.review({ ...query, version: "deleted-synthetic-version" }));
    await restart.close();
    const persisted = new Database(join(directory, "overview-results.sqlite"));
    try {
      const cached = persisted.prepare("SELECT key,json FROM overview_results WHERE json_extract(key,'$[1]')='review'").get() as { key: string; json: string };
      assert.equal(JSON.parse(cached.key)[0], "weekly-review-v14");
      const incomplete = JSON.parse(cached.json); delete incomplete.sessions.roundsPerSession;
      persisted.prepare("UPDATE overview_results SET json=? WHERE key=?").run(JSON.stringify(incomplete), cached.key);
    } finally { persisted.close(); }
    restart = new OverviewManager(store, prices, () => [], () => now);
    assert.deepEqual(await restart.review(query), first);
    assert.equal((restart as unknown as { nextId: number }).nextId, 1, "缺新增指标的持久结果必须重算，不能进入界面");
  } finally { await manager.close(); await restart?.close(); }
}));

test("源索引被后台刷新持有写锁时复盘仍可只读统计，不回填源用量事实", async () => fixture(async store => {
  const version = history(store), writer = new Database(store.dbPath), factsStore = new WeeklyReviewFactStore(store);
  writer.exec("BEGIN IMMEDIATE");
  writer.prepare("UPDATE session_state SET json=json WHERE id=1").run();
  try {
    const before = (writer.prepare("SELECT COUNT(*) AS count FROM session_usage_fact_revisions").get() as { count: number }).count;
    const query = { version, timezone: "Asia/Shanghai" };
    const source = await factsStore.source(query, now), report = buildWeeklyReview(source.facts, query, pricing, now).review;
    assert.equal(report.rounds.completed, 4);
    assert.equal(report.cache.requests, 7);
    assert.equal((writer.prepare("SELECT COUNT(*) AS count FROM session_usage_fact_revisions").get() as { count: number }).count, before,
      "周复盘不得通过ensureUsageFacts争用源索引写锁");
  } finally { writer.exec("ROLLBACK"); writer.close(); factsStore.close(); }
}));

test("复盘Worker首次启动也不请求源库写锁，源索引持续刷新时HTTP管理通道可完成", async () => fixture(async (store, directory) => {
  const version = history(store), writer = new Database(store.dbPath), pricing = new PricingService(directory);
  const manager = new OverviewManager(store, pricing, () => [], () => now);
  writer.exec("BEGIN IMMEDIATE"); writer.prepare("UPDATE session_state SET json=json WHERE id=1").run();
  try {
    const before = (writer.prepare("SELECT COUNT(*) AS count FROM session_usage_fact_revisions").get() as { count: number }).count;
    const result = await manager.review({ version, timezone: "Asia/Shanghai", anchorDay: "2026-10-12" });
    assert.equal(result.rounds.completed, 4);
    assert.equal(result.cache.requests, 7);
    assert.equal((writer.prepare("SELECT COUNT(*) AS count FROM session_usage_fact_revisions").get() as { count: number }).count, before);
  } finally { writer.exec("ROLLBACK"); writer.close(); await manager.close(); }
}));

test("请求缺轮次时按消息身份定位并保留歧义，旧需求正文不参与周预览", async () => fixture(async (store, directory) => {
  const messages = [message("indexed", "start", 1, "2026-10-04T01:00:00Z", { turnId: "cross" }),
    message("indexed", "block", 2, "2026-10-04T01:00:00Z", { turnId: "cross", recordLine: 1 }),
    ...Array.from({ length: 2000 }, (_, index) => message("indexed", `tool-${index}`, index + 3, "2026-10-04T02:00:00Z", { kind: "tool_call", turnId: "old" })),
    message("indexed", "other", 2003, "2026-10-07T01:00:00Z", { turnId: "other" }),
    message("indexed", "end", 2004, "2026-10-07T01:01:00Z", { turnId: "cross", kind: "assistant", final: "explicit" }),
    ...Array.from({ length: 20 }, (_, index) => message("indexed", `old-user-${index}`, 3000 + index, "2026-10-01T01:00:00Z",
      { turnId: `old-turn-${index}`, text: "旧需求正文".repeat(2000) }))];
  const entry = revision(store, "indexed", messages, [
    usage("linked", "2026-10-04T02:00:00Z", { turnId: undefined, messageId: "start", requestMessageIds: ["block"] }),
    usage("ambiguous", "2026-10-07T01:00:00Z", { turnId: undefined, messageId: undefined, requestMessageIds: ["start", "other"] }),
  ], { client: "claude" });
  const version = store.publish(store.createJob().id, [entry], []), query = { version, timezone: "UTC", anchorDay: "2026-10-12" };
  const prepare = Database.prototype.prepare, plans: string[][] = [];
  let previews = 0;
  Database.prototype.prepare = function (sql: string) {
    if (sql.includes("AS prompt_characters")) this.function("substr", { deterministic: true }, (value, start, length) => {
      previews += 1;
      return [...String(value)].slice(Number(start) - 1, Number(start) - 1 + Number(length)).join("");
    });
    const statement = prepare.call(this, sql);
    if (sql.includes("prompt_preview FROM session_messages") || sql.includes("AS resolved_turn") || sql.includes("AND (kind='user' OR kind='assistant' AND final IS NOT NULL)") || sql.includes("INDEXED BY session_message_overview_projection") || sql.includes("INDEXED BY session_message_reply_boundary")) {
      const database = this, all = statement.all.bind(statement);
      statement.all = (...args: unknown[]) => {
        plans.push((prepare.call(database, `EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map(row => row.detail));
        return all(...args);
      };
    }
    return statement;
  };
  const facts = new WeeklyReviewFactStore(store, join(directory, "indexed.sqlite"));
  try {
    const data = buildWeeklyReview((await facts.source(query, now)).facts, query, pricing, now);
    assert.equal(data.review.rounds.completed, 1);
    assert.equal(data.review.rounds.steps.average, 1);
    assert.equal(data.review.rounds.tokens.average, 110);
    assert.equal(data.review.coverage.unassignedRequests, 1);
    assert.equal(previews, 3, "只恢复跨周轮次及周内相关需求预览");
    assert(plans.some(plan => plan.some(row => row.includes("SEARCH m") && row.includes("revision=? AND id=?"))), "缺轮次请求按复合消息身份定位");
    assert(!plans.some(plan => plan.some(row => row.startsWith("SEARCH m") && row.endsWith("(revision=?)"))), "请求关联不逐条扫描全部会话消息");
    assert(plans.some(plan => plan.some(row => row.includes("session_message_reply_boundary"))), "回复边界通过稀疏索引读取，不扫描旧工具正文");
    assert(plans.some(plan => plan.some(row => row.includes("session_message_overview_projection"))), "活动和工具投影从覆盖索引读取元信息");
    const overview = new OverviewFactStore(store);
    try { await overview.prepare(query, now); } finally { overview.close(); }
    const cached = new WeeklyReviewFactStore(store, join(directory, "indexed-cached.sqlite"));
    try {
      const actual = buildWeeklyReview((await cached.source(query, now)).facts, query, pricing, now);
      assert.deepEqual(actual.review, data.review);
      assert.deepEqual(actual.rows, data.rows, "窄请求缓存保留跨周完整轮次和无法唯一归属的请求");
    } finally { cached.close(); }

  } finally { facts.close(); Database.prototype.prepare = prepare; }
}));

test("缺投影索引的只读旧库回退读取，统计与新索引一致", async () => fixture(async (store, directory) => {
  const version = history(store), query = { version, timezone: "Asia/Shanghai", anchorDay: "2026-10-12" };
  const first = new WeeklyReviewFactStore(store, join(directory, "projection-first.sqlite"));
  let expected;
  try { expected = buildWeeklyReview((await first.source(query, now)).facts, query, pricing, now).review; }
  finally { first.close(); }
  const database = new Database(store.dbPath);
  try { database.exec("DROP INDEX session_message_overview_projection_v2; DROP INDEX session_message_round_boundary; DROP INDEX session_message_reply_boundary"); }
  finally { database.close(); }
  const readonly = new SessionStore(store.dbPath, { readonly: true }), fallback = new WeeklyReviewFactStore(readonly, join(directory, "projection-fallback.sqlite"));
  try { assert.deepEqual(buildWeeklyReview((await fallback.source(query, now)).facts, query, pricing, now).review, expected); }
  finally { fallback.close(); readonly.close(); }
}));

test("既有总览窄缓存与源读取口径相同，跨窗口配对和纯结果活动不丢失", async () => fixture(async (store, directory) => {
  const a = revision(store, "cross-result", [
    message("cross-result", "old-user", 1, "2026-10-04T01:00:00Z"),
    message("cross-result", "old-call", 2, "2026-10-04T02:00:00Z", { kind: "tool_call", callId: "old", tool: "tool" }),
    message("cross-result", "window-result", 3, "2026-10-05T01:00:00Z", { kind: "tool_result", callId: "old", status: "success" }),
  ], []);
  const b = revision(store, "later-result", [
    message("later-result", "user", 1, "2026-10-11T01:00:00Z"),
    message("later-result", "call", 2, "2026-10-11T23:00:00Z", { kind: "tool_call", callId: "late", tool: "tool" }),
    message("later-result", "after-result", 3, "2026-10-12T01:00:00Z", { kind: "tool_result", callId: "late", status: "failure" }),
  ], []);
  const version = store.publish(store.createJob().id, [a, b], []), query = { version, timezone: "UTC", anchorDay: "2026-10-12" };
  const raw = new WeeklyReviewFactStore(store, join(directory, "raw.sqlite"));
  let expected;
  try { expected = buildWeeklyReview((await raw.source(query, now)).facts, query, pricing, now).review; }
  finally { raw.close(); }
  const overview = new OverviewFactStore(store);
  try { await overview.prepare(query, now); } finally { overview.close(); }
  const cached = new WeeklyReviewFactStore(store, join(directory, "cached.sqlite"));
  try {
    const result = buildWeeklyReview((await cached.source(query, now)).facts, query, pricing, now).review;
    assert.deepEqual(result, expected);
    assert.equal(result.sessions.active, 2, "窗口内只有工具结果的会话仍有自身活动");
    assert.equal(result.extensions.tools.failures, 1, "窗口内调用的窗口外明确结果仍可配对");
  } finally { cached.close(); }
}));

test("可选窄缓存的工具JSON损坏时退回源事实，不改变失败与轮次统计", async () => fixture(async (store, directory) => {
  const version = history(store), query = { version, timezone: "Asia/Shanghai", anchorDay: "2026-10-12" };
  const raw = new WeeklyReviewFactStore(store, join(directory, "corrupt-raw.sqlite"));
  let expected;
  try { expected = buildWeeklyReview((await raw.source(query, now)).facts, query, pricing, now); }
  finally { raw.close(); }
  const overview = new OverviewFactStore(store);
  try { await overview.prepare(query, now); } finally { overview.close(); }
  const database = new Database(join(directory, "overview-facts-v2.sqlite"));
  try { database.prepare("UPDATE overview_fact_events SET json='{' WHERE id='failed-call'").run(); }
  finally { database.close(); }
  const cached = new WeeklyReviewFactStore(store, join(directory, "corrupt-cached.sqlite"));
  try {
    const actual = buildWeeklyReview((await cached.source(query, now)).facts, query, pricing, now);
    assert.deepEqual(actual.review, expected.review);
    assert.deepEqual(actual.rows, expected.rows);
  } finally { cached.close(); }
}));

test("纯子Agent活动与用量仍可统计，同一来源在新版本恢复用户身份时不复用子Agent省略的轮次", async () => fixture(async (store, directory) => {
  const parent = revision(store, "parent", [], [], { childSessionIds: ["role"] });
  const child = revision(store, "role", [message("role", "user", 1, "2026-10-07T01:00:00Z"),
    message("role", "final", 2, "2026-10-07T01:01:00Z", { kind: "assistant", final: "explicit" })],
    [usage("role-request", "2026-10-07T01:00:30Z")]);
  const active = revision(store, "only-thinking", [message("only-thinking", "thinking", 1, "2026-10-08T01:00:00Z", { kind: "thinking" })], [],
    { relationship: "child", parentSessionId: "parent" });
  const version = store.publish(store.createJob().id, [parent, child, active], []), query = { version, timezone: "UTC", anchorDay: "2026-10-12" };
  const overview = new OverviewFactStore(store);
  try { await overview.prepare(query, now); } finally { overview.close(); }
  const cache = new WeeklyReviewFactStore(store, join(directory, "role-cache.sqlite"));
  try {
    const source = await cache.source(query, now), report = buildWeeklyReview(source.facts, query, pricing, now).review;
    assert.equal(report.rounds.completed, 0);
    assert.equal(report.extensions.children.sessions, 2);
    assert.equal(report.extensions.children.requests, 1);
    assert.deepEqual(source.facts.find(row => row.session.id === "only-thinking")!.activityDays, ["2026-10-08"]);
    const independent = store.publish(store.createJob().id, [child], []);
    const next = buildWeeklyReview((await cache.source({ ...query, version: independent }, now)).facts, { ...query, version: independent }, pricing, now).review;
    assert.equal(next.rounds.completed, 1);
    assert.equal(next.rounds.steps.average, 1);
    assert.equal(next.preferences.promptCharacters.average, 4);
    assert.equal(next.extensions.children.sessions, 0);
  } finally { cache.close(); }
}));

test("窄事实的活动日投影保留夏令时边界与不同本地日期", async () => fixture(async (store, directory) => {
  const entry = revision(store, "dst", [message("dst", "early", 1, "2026-03-08T04:59:59Z", { kind: "thinking" }),
    message("dst", "late", 2, "2026-03-08T07:00:00Z", { kind: "assistant" }),
    message("dst", "outside", 3, "2026-03-09T04:00:00Z", { kind: "thinking" })], [],
    { startedAt: "2026-03-08T04:59:59Z", updatedAt: "2026-03-09T04:00:00Z" });
  const version = store.publish(store.createJob().id, [entry], []), query = { version, timezone: "America/New_York", anchorDay: "2026-03-09" };
  const raw = new WeeklyReviewFactStore(store, join(directory, "dst-raw.sqlite"));
  let expected;
  try { expected = await raw.source(query, now); } finally { raw.close(); }
  assert.deepEqual(expected.facts[0]!.activityDays, ["2026-03-07", "2026-03-08"]);
  const overview = new OverviewFactStore(store);
  try { await overview.prepare(query, now); } finally { overview.close(); }
  const cached = new WeeklyReviewFactStore(store, join(directory, "dst-cached.sqlite"));
  try {
    const actual = await cached.source(query, now);
    assert.deepEqual(actual.facts[0]!.activityDays, expected.facts[0]!.activityDays);
    assert.deepEqual(buildWeeklyReview(actual.facts, query, pricing, now).review, buildWeeklyReview(expected.facts, query, pricing, now).review);
  } finally { cached.close(); }
}));

test("范围移动复用不可变修订覆盖，跨时区缓存至多四份且裁剪后可重建", async () => fixture(async (store, directory) => {
  const version = history(store), factsStore = new WeeklyReviewFactStore(store);
  const read = store.weeklyReviewRevisionFacts.bind(store), scans: string[] = [];
  store.weeklyReviewRevisionFacts = (revisionId, sessionId, scope) => { scans.push(sessionId); return read(revisionId, sessionId, scope); };
  try {
    const query = { version, timezone: "UTC", anchorDay: "2026-10-12" };
    await factsStore.source(query, now); const first = scans.length;
    const shifted = buildWeeklyReview((await factsStore.source({ ...query, anchorDay: "2026-10-13" }, now)).facts, { ...query, anchorDay: "2026-10-13" }, pricing, now).review;
    assert.deepEqual(scans.slice(first), ["main"], "跨日只重读含新末日活动的来源，其余不可变来源复用覆盖");
    assert.equal(shifted.rounds.completed, 3);
    assert.equal(shifted.cache.requests, 7, "新窗口末日的请求仍被纳入");
    for (const timezone of ["Asia/Shanghai", "Europe/London", "America/New_York", "Pacific/Kiritimati", "Asia/Tokyo"])
      await factsStore.source({ ...query, timezone }, now);
    const database = new Database(join(directory, "weekly-review-facts-v2.sqlite"), { readonly: true });
    try { assert.equal((database.prepare("SELECT MAX(count) AS maximum FROM (SELECT COUNT(*) AS count FROM weekly_revisions GROUP BY source_revision)").get() as { maximum: number }).maximum, 4); }
    finally { database.close(); }
    await factsStore.source(query, now);
    assert.equal(buildWeeklyReview((await factsStore.source(query, now)).facts, query, pricing, now).review.rounds.completed, 3);
  } finally { factsStore.close(); }
}));

test("工具失败保留MCP服务器身份，Codex短标题复用既有请求提取并保持长度原值", async () => fixture(async store => {
  const prompt = "<in-app-browser-context>\n合成注入\n</in-app-browser-context>\n## My request:\n请修复合成页面";
  const r = revision(store, "server", [
    message("server", "user", 1, "2026-10-07T01:00:00Z", { text: prompt }),
    message("server", "failed", 2, "2026-10-07T01:00:01Z", { kind: "tool_call", tool: "query", status: "failure", resource: { kind: "mcp", name: "server-a", server: "server-a" } }),
    message("server", "other", 3, "2026-10-07T01:00:02Z", { kind: "tool_call", tool: "query", status: "success", resource: { kind: "mcp", name: "server-b", server: "server-b" } }),
    message("server", "end", 4, "2026-10-07T01:00:03Z", { kind: "assistant", final: "explicit" }),
  ], [usage("usage", "2026-10-07T01:00:02Z")]);
  const version = store.publish(store.createJob().id, [r], []), factsStore = new WeeklyReviewFactStore(store);
  try {
    const query = { version, timezone: "UTC" }, data = buildWeeklyReview((await factsStore.source(query, now)).facts, query, pricing, now);
    assert.equal(data.review.rounds.longest[0]!.title, "请修复合成页面");
    assert.equal(data.review.preferences.promptCharacters.average, promptCharacterCount(prompt));
    const row = weeklyReviewDetail(data, { kind: "tools", key: data.ranks.tools![0]!.key }).rows[0]!;
    assert.equal(row.server, "server-a");
    assert.equal("subsequentCalls" in row, false);
  } finally { factsStore.close(); }
}));

test("子Agent与排行完整Token小计占比保留双方请求样本，缺输出的大输入不冒充完整分母", async () => fixture(async store => {
  const parent = revision(store, "coverage-main", [message("coverage-main", "user", 1, "2026-10-07T01:00:00Z")],
    [usage("complete", "2026-10-07T01:00:01Z", { inputTokens: 5, outputTokens: 5 }),
      usage("unknown-output", "2026-10-07T01:00:02Z", { inputTokens: 1_000_000, outputTokens: undefined })]);
  const child = revision(store, "coverage-child", [message("coverage-child", "child-user", 1, "2026-10-07T01:00:00Z")],
    [usage("child-complete", "2026-10-07T01:00:01Z", { inputTokens: 50, outputTokens: 5 })],
    { relationship: "child", parentSessionId: "coverage-main" });
  const version = store.publish(store.createJob().id, [parent, child], []), factsStore = new WeeklyReviewFactStore(store);
  try {
    const query = { version, timezone: "UTC" }, data = buildWeeklyReview((await factsStore.source(query, now)).facts, query, pricing, now);
    const children = data.review.extensions.children;
    assert.equal(children.tokens, 55);
    assert.equal(children.tokenShare, 55 / 65);
    assert.deepEqual([children.tokenSamples, children.tokenMissing, children.userTokenSamples, children.userTokenMissing], [1, 0, 1, 1]);
    const model = data.review.preferences.models[0]!;
    assert.equal(model.tokens, 10);
    assert.deepEqual([model.tokenSamples, model.tokenMissing], [1, 1]);
    const project = data.review.extensions.projects[0]!;
    assert.deepEqual([project.tokenSamples, project.tokenMissing], [1, 1]);
  } finally { factsStore.close(); }
}));

test("无请求用量的执行仍算活跃，规则升级重算一次后复用，原始与窄缓存等价", async () => fixture(async (store, directory) => {
  const own = revision(store, "assistant-only", [
    message("assistant-only", "old-user", 1, "2026-10-04T01:00:00Z"),
    message("assistant-only", "assistant", 2, "2026-10-07T01:00:00Z", { kind: "assistant" }),
    message("assistant-only", "thinking", 3, "2026-10-08T01:00:00Z", { kind: "thinking" }),
  ], []);
  const excluded = revision(store, "excluded-only", [
    message("excluded-only", "old-user", 1, "2026-10-04T01:00:00Z"),
    message("excluded-only", "copied", 2, "2026-10-07T01:00:00Z", { kind: "assistant", copied: true }),
    message("excluded-only", "injected", 3, "2026-10-08T01:00:00Z", { kind: "thinking", contextSource: "client" }),
  ], []);
  const version = store.publish(store.createJob().id, [own, excluded], []), query = { version, timezone: "UTC", anchorDay: "2026-10-12" };
  const path = join(directory, "activity.sqlite"), raw = new WeeklyReviewFactStore(store, path);
  let expected;
  try { expected = buildWeeklyReview((await raw.source(query, now)).facts, query, pricing, now).review; }
  finally { raw.close(); }
  assert.equal(expected.sessions.active, 1);
  assert.equal(expected.cache.requests, 0);
  const database = new Database(path);
  try {
    for (const row of database.prepare("SELECT revision,json FROM weekly_revisions").all() as { revision: string; json: string }[]) {
      const metadata = JSON.parse(row.json); metadata.activityDays = [];
      database.prepare("UPDATE weekly_revisions SET format=5,json=? WHERE revision=?").run(JSON.stringify(metadata), row.revision);
    }
  } finally { database.close(); }
  const read = store.weeklyReviewRevisionFacts;
  let upgradedReads = 0;
  store.weeklyReviewRevisionFacts = (...args) => { upgradedReads += 1; return read.apply(store, args); };
  const upgraded = new WeeklyReviewFactStore(store, path);
  try {
    assert.deepEqual(buildWeeklyReview((await upgraded.source(query, now)).facts, query, pricing, now).review, expected);
    assert(upgradedReads > 0, "旧结束规则须从不可变索引补齐依据");
    const reads = upgradedReads;
    await upgraded.source(query, now);
    assert.equal(upgradedReads, reads, "同规则暖缓存不重复读取");
  }
  finally { upgraded.close(); store.weeklyReviewRevisionFacts = read; }
  const overview = new OverviewFactStore(store);
  try { await overview.prepare(query, now); } finally { overview.close(); }
  const cached = new WeeklyReviewFactStore(store, join(directory, "activity-cached.sqlite"));
  try { assert.deepEqual(buildWeeklyReview((await cached.source(query, now)).facts, query, pricing, now).review, expected); }
  finally { cached.close(); }
}));

test("千个旧会话与五千请求首算只扫描近期候选，工具失败聚合及重读保持有界", async context => fixture(async store => {
  const old = Array.from({ length: 1000 }, (_, index) => revision(store, `old-${index}`, [], [],
    { startedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z" }));
  const longPrompt = "😀 \u3000\n".repeat(1000);
  const events = [message("large", "user", 1, "2026-10-07T01:00:00Z", { text: longPrompt })];
  for (let index = 0; index < 5000; index += 1) events.push(message("large", `call-${index}`, index + 2, "2026-10-07T01:00:10Z",
    { kind: "tool_call", text: "synthetic-tool-body".repeat(20), tool: `tool-${index % 10}`, status: index % 10 === 0 ? "failure" : "success" }));
  events.push(message("large", "final", 5002, "2026-10-07T01:02:00Z", { kind: "assistant", final: "explicit" }));
  const recent = revision(store, "large", events, Array.from({ length: 5000 }, (_, index) => usage(`request-${index}`, "2026-10-07T01:00:10Z")));
  const version = store.publish(store.createJob().id, [...old, recent], []), factsStore = new WeeklyReviewFactStore(store);
  const read = store.weeklyReviewRevisionFacts.bind(store), scanned: string[] = [];
  store.weeklyReviewRevisionFacts = (revisionId, sessionId, scope) => { scanned.push(sessionId); return read(revisionId, sessionId, scope); };
  store.profile = () => { throw new Error("周复盘禁止完整画像"); };
  store.overviewSource = () => { throw new Error("周复盘禁止完整跨会话正文"); };
  try {
    const query = { version, timezone: "UTC" }, start = performance.now();
    const data = buildWeeklyReview((await factsStore.source(query, now)).facts, query, pricing, now);
    const cold = performance.now() - start;
    assert.deepEqual(scanned, ["large"]);
    assert.equal(data.review.rounds.steps.average, 5000);
    assert.equal(data.review.preferences.promptCharacters.average, 1000);
    assert.equal(data.review.extensions.tools.failures, 500);
    assert.equal(data.review.cache.requests, 5000);
    const prompt = weeklyReviewDetail(data, { kind: "prompts" }).rows[0]!;
    assert(prompt.title.length <= 240, "定位只保留120个Unicode字符的短片段");
    assert.equal(weeklyReviewDetail(data, { kind: "cache", pageSize: 100 }).rows.length, 100);
    const repeat = performance.now(); await factsStore.source(query, now);
    assert.equal(scanned.length, 1);
    context.diagnostic(`合成冷算 ${cold.toFixed(1)} ms，持久窄事实重读 ${(performance.now() - repeat).toFixed(1)} ms；1001会话只扫描1个候选。`);
  } finally { factsStore.close(); }
}));

test("画像和七天复盘共用末条回复与消息关联，跨周按回复记录时间取整轮", async () => fixture(async (store, directory) => {
  const source = revision(store, "unified", [
    message("unified", "cross-user", 1, "2026-10-04T12:00:00Z", { turnId: "cross" }),
    message("unified", "cross-end", 2, "2026-10-05T02:00:00Z", { turnId: "cross", kind: "assistant", final: "inferred", finalEvidence: "normal_stop", finalAt: "2026-10-05T02:00:00Z" }),
    message("unified", "user", 3, "2026-10-07T01:00:00Z", { turnId: "normal" }),
    message("unified", "end", 4, "2026-10-07T01:01:00Z", { turnId: "normal", kind: "assistant", final: "explicit" }),
    message("unified", "weak-user", 5, "2026-10-07T02:00:00Z", { turnId: "weak" }),
    message("unified", "weak-end", 6, "2026-10-07T02:01:00Z", { turnId: "weak", kind: "assistant", final: "inferred" }),
  ], [
    usage("cross-before", "2026-10-04T13:00:00Z", { turnId: undefined, messageId: "cross-end" }),
    usage("cross-last", "2026-10-05T01:59:00Z", { turnId: "cross", messageId: "cross-end" }),
    usage("normal", "2026-10-07T01:00:30Z", { turnId: "normal", messageId: "end" }),
    usage("weak", "2026-10-07T02:00:30Z", { turnId: "weak", messageId: "weak-end" }),
  ]);
  const version = store.publish(store.createJob().id, [source], []), query = { version, timezone: "Asia/Shanghai", anchorDay: "2026-10-12" };
  const profile = store.profile("unified", {}), factsStore = new WeeklyReviewFactStore(store);
  try {
    const { facts } = await factsStore.source(query, now), data = buildWeeklyReview(facts, query, pricing, now);
    assert.equal(profile.roundMetrics!.completedTurns, 3);
    assert.equal(profile.roundMetrics!.averageSteps, 4 / 3);
    assert.equal(profile.roundMetrics!.averageDurationMs, (14 * 3600000 + 60000 + 60000) / 3);
    assert.equal(data.review.rounds.completed, profile.roundMetrics!.completedTurns);
    assert.equal(data.review.rounds.steps.average, profile.roundMetrics!.averageSteps);
    assert.equal(data.review.rounds.durationMs.average, profile.roundMetrics!.averageDurationMs);
    assert.equal(data.review.rounds.inferredIncluded, 2);
    assert.equal(data.review.rounds.steps.inferredSamples, 2);
    const detail = weeklyReviewDetail(data, { kind: "rounds", filter: "ended" });
    assert.equal(detail.total, 3);
    assert.equal(detail.rows.find(row => row.turnId === "cross")!.tokens, 220);
    const warm = await factsStore.source(query, now);
    assert.deepEqual(buildWeeklyReview(warm.facts, query, pricing, now).review, data.review);
  } finally { factsStore.close(); }
}));

test("请求计时跨午夜不改变回复日期归属，冷暖投影一致", async () => fixture(async (store, directory) => {
  const records = [
    message("timed", "u", 1, "2026-10-04T15:58:00Z"),
    message("timed", "thinking", 2, "2026-10-04T15:58:10Z", { kind: "thinking" }),
    message("timed", "end", 3, "2026-10-04T15:59:00Z", { kind: "assistant", final: "explicit" }),
  ];
  const requests = [usage("before", "2026-10-04T15:58:20Z"), usage("last", "2026-10-04T16:01:00Z", {
    messageId: "thinking", requestMessageIds: ["thinking"], timing: { basis: "estimated", method: "codex_event_boundary", completion: "explicit",
      end: { messageId: "end", recordLine: 3, occurredAt: "2026-10-04T16:01:00Z" } },
  })];
  const source = revision(store, "timed", records, requests), version = store.publish(store.createJob().id, [source], []);
  const query = { version, timezone: "Asia/Shanghai", anchorDay: "2026-10-12" }, expected = store.profile("timed", {}).roundMetrics!;
  assert.equal(expected.averageDurationMs, 60000);
  const check = async (name: string) => {
    const facts = new WeeklyReviewFactStore(store, join(directory, name));
    try {
      const report = buildWeeklyReview((await facts.source(query, now)).facts, query, pricing, now).review;
      assert.equal(report.rounds.steps.average, null);
      assert.equal(report.rounds.durationMs.average, null);
      assert.equal(report.rounds.completed, 0);
    } finally { facts.close(); }
  };
  await check("raw-timing.sqlite");
  const overview = new OverviewFactStore(store);
  try { await overview.prepare(query, now); } finally { overview.close(); }
  await check("cached-timing.sqlite");
}));

test("请求身份缺口不将已知步骤小计当完整均值，画像与周复盘均保持未知", async () => fixture(async store => {
  const source = revision(store, "incomplete", [message("incomplete", "u", 1, "2026-10-07T01:00:00Z"),
    message("incomplete", "a", 2, "2026-10-07T01:01:00Z", { kind: "assistant", final: "explicit" })], [usage("known", "2026-10-07T01:00:30Z")],
  { gaps: [{ kind: "ambiguous", message: "合成请求身份缺口", messageDescriptor: { key: "diagnostics.sessions.parserUsage.m003" } }] });
  const version = store.publish(store.createJob().id, [source], []), profile = store.profile("incomplete", {}).roundMetrics!, facts = new WeeklyReviewFactStore(store);
  try {
    const query = { version, timezone: "Asia/Shanghai", anchorDay: "2026-10-12" }, report = buildWeeklyReview((await facts.source(query, now)).facts, query, pricing, now).review;
    assert.equal(profile.averageSteps, null);
    assert.equal(report.rounds.steps.average, null);
    assert.equal(report.rounds.steps.samples, 0);
    assert.equal(report.rounds.durationMs.average, profile.averageDurationMs);
  } finally { facts.close(); }
}));

test("辅助事件、附件和用量分项缺口不抹掉完整请求步骤，未知事件仍保持保守", async () => fixture(async store => {
  const gaps = [
    { key: "diagnostics.history.adapters.qoder.m004" }, { key: "diagnostics.history.adapters.codebuddy.resourceCoverage" },
    { key: "diagnostics.history.adapters.codebuddy.m006", params: { p0: "summary" } },
    { key: "diagnostics.history.adapters.opencode.m006", params: { p0: "step-start" } },
    { key: "diagnostics.history.adapters.zcode.m004", params: { p0: "step-finish" } },
    { key: "diagnostics.history.adapters.dsh.m016", params: { p0: "permission/preset" } },
    { key: "diagnostics.history.adapters.opencode.m002" },
  ].map(messageDescriptor => ({ kind: "unsupported_format" as const, message: "合成辅助字段缺口", messageDescriptor }));
  const records = [message("auxiliary", "u", 1, "2026-10-07T01:00:00Z"),
    message("auxiliary", "a", 2, "2026-10-07T01:01:00Z", { kind: "assistant", final: "explicit" })];
  const source = revision(store, "auxiliary", records, [usage("known", "2026-10-07T01:00:30Z", { inputTokens: undefined })], { gaps });
  const unknown = revision(store, "unknown-event", records.map(row => ({ ...row, sessionId: "unknown-event" })), [usage("known", "2026-10-07T01:00:30Z")],
    { gaps: [{ kind: "unsupported_format", message: "未知来源事件", messageDescriptor: { key: "diagnostics.history.adapters.dsh.m016", params: { p0: "unknown-event" } } }] });
  const version = store.publish(store.createJob().id, [source, unknown], []), facts = new WeeklyReviewFactStore(store);
  try {
    const query = { version, timezone: "UTC", anchorDay: "2026-10-12" };
    const report = buildWeeklyReview((await facts.source(query, now)).facts, query, pricing, now).review;
    assert.equal(store.profile("auxiliary").roundMetrics!.averageSteps, 1);
    assert.equal(report.rounds.steps.average, 1);
    assert.equal(report.rounds.steps.samples, 1);
    assert.equal(report.rounds.tokens.samples, 0);
    assert.equal(store.profile("unknown-event").roundMetrics!.averageSteps, null);
  } finally { facts.close(); }
}));

test("按回复时间无需补查请求结束记录，旧请求不搬运", async () => fixture(async (store, directory) => {
  const rows = [message("long", "old-u", 1, "2026-09-01T01:00:00Z", { turnId: "old" }),
    message("long", "old-a", 2, "2026-09-01T02:00:00Z", { turnId: "old", kind: "assistant", final: "explicit" }),
    message("long", "new-u", 3, "2026-10-07T01:00:00Z"),
    message("long", "new-a", 4, "2026-10-07T01:01:00Z", { kind: "assistant", final: "explicit" })];
  const requests = [...Array.from({ length: 2000 }, (_, index) => usage(`old-${index}`, "2026-09-01T01:30:00Z", {
    turnId: "old", messageId: "old-a", timing: { basis: "estimated", method: "codex_event_boundary", completion: "explicit",
      end: { messageId: "old-a", occurredAt: "2026-09-01T02:00:00Z", recordLine: 2 } },
  })), usage("new", "2026-10-07T01:02:00Z", { messageId: "new-a", timing: { basis: "estimated", method: "codex_event_boundary", completion: "explicit",
    end: { messageId: "new-a", occurredAt: "2026-10-07T01:02:00Z", recordLine: 4 } } })];
  const source = revision(store, "long", rows, requests), version = store.publish(store.createJob().id, [source], []);
  const prepare = Database.prototype.prepare; let materialized = 0;
  Database.prototype.prepare = function (sql: string) {
    const statement = prepare.call(this, sql);
    if (sql.includes("FROM session_usage WHERE revision=?") && sql.includes("ORDER BY rowid")) {
      const iterate = statement.iterate.bind(statement);
      statement.iterate = function* (...args: unknown[]) { for (const row of iterate(...args)) { materialized += 1; yield row; } };
    }
    return statement;
  };
  const facts = new WeeklyReviewFactStore(store, join(directory, "long-facts.sqlite"));
  try {
    const query = { version, timezone: "UTC", anchorDay: "2026-10-12" };
    const report = buildWeeklyReview((await facts.source(query, now)).facts, query, pricing, now).review;
    assert.equal(report.rounds.completed, 1);
    assert.equal(report.rounds.steps.average, 1);
    assert.equal(report.rounds.durationMs.average, 60000);
    assert.equal(materialized, 0, "不为回复边界读取额外请求结束元信息");
  } finally { facts.close(); Database.prototype.prepare = prepare; }
}));
