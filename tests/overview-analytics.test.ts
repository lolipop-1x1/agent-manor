import assert from "node:assert/strict";
import test from "node:test";
import { buildOverviewReport, pairToolCalls } from "../src/overview/analytics.js";
import { addDays, localDay, resolveOverviewRange } from "../src/overview/dates.js";
import { event, now, pricing, request, resource, session, source } from "./overview-fixtures.js";

const query = { window: "custom" as const, from: "2026-01-01", to: "2026-02-15", timezone: "UTC" };
test("总览按自身活动统计主子会话，继承分叉及摘要跨度不增加活动", () => {
  const sessions = [session("main"), ...Array.from({ length: 4 }, (_, index) => session(`child-${index}`, { relationship: "child", parentSessionId: "main" })),
    session("copied-fork", { relationship: "fork", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-15T00:00:00Z" })];
  const input = source({ sessions, events: sessions.map((row, index) => event(row.id, `event-${index}`, "2026-01-01", { copied: row.id === "copied-fork" })) });
  const report = buildOverviewReport(input, query, pricing, now);
  assert.equal(report.summary.sessions, 5); assert.equal(report.summary.mainSessions, 1); assert.equal(report.summary.childSessions, 4);
  assert.equal(report.summary.activeDays, 1); assert.equal(report.summary.forkSessions, 0);
});
test("系统、上下文、展开Skill正文不产生活跃，实际读取工具仍计活动", () => {
  const input = source({ sessions: [session("a")], events: [
    event("a", "system", "2026-01-01", { kind: "system" }), event("a", "context", "2026-01-02", { contextSource: "agents_md" }),
    event("a", "skill-body", "2026-01-03", { resource: { kind: "skill_read", name: "skill-a" } }),
    event("a", "read-call", "2026-01-04", { kind: "tool_call", tool: "read_file", resource: { kind: "skill_read", name: "skill-a" } }),
  ] });
  const report = buildOverviewReport(input, query, pricing, now);
  assert.equal(report.summary.activeDays, 1); assert.equal(report.activity.days.find(day => day.day === "2026-01-04")!.sessions, 1);
});
test("第一天和第五天有活动只计两天，缺Token请求和自动任务可独立活跃", () => {
  const input = source({ sessions: [session("a"), session("auto", { executionMode: "quiet" })],
    events: [event("a", "first"), event("a", "fifth", "2026-01-05")],
    requests: [request("auto", "missing", "2026-01-06", { inputTokens: undefined, outputTokens: undefined })] });
  const report = buildOverviewReport(input, query, pricing, now);
  assert.equal(report.summary.activeDays, 3); assert.equal(report.summary.sessions, 2); assert.equal(report.summary.tokens, null);
  assert.equal(report.summary.requests, 1); assert.equal(report.activity.crossDaySessions, 1);
});
test("当天未活动延续昨天，历史严格末日且连续记录不越过范围起点", () => {
  const input = source({ sessions: [session("a")], events: [12, 13, 14].map(day => event("a", `event-${day}`, `2026-02-${day}`)) });
  assert.equal(buildOverviewReport(input, { ...query, from: "2026-02-12" }, pricing, now).summary.currentStreak, 3);
  assert.equal(buildOverviewReport(input, { ...query, from: "2026-02-13" }, pricing, now).summary.currentStreak, 2);
  assert.equal(buildOverviewReport(input, { ...query, from: "2026-02-15" }, pricing, now).summary.currentStreak, 0);
  assert.equal(buildOverviewReport(input, { ...query, to: "2026-02-11" }, pricing, now).summary.currentStreak, 0);
  const today = source({ ...input, events: [...input.events, event("a", "today", "2026-02-15")] });
  assert.equal(buildOverviewReport(today, { ...query, from: "2026-02-12" }, pricing, now).summary.currentStreak, 4);
});
test("默认365本地日期、闰日与夏令时使用日历边界", () => {
  const range = resolveOverviewRange(source(), { timezone: "UTC" }, new Date("2024-03-01T12:00:00Z"));
  assert.equal(range.from, addDays("2024-03-01", -364)); assert.equal(range.to, "2024-03-01");
  assert.equal(localDay("2026-03-08T04:30:00Z", "America/New_York"), "2026-03-07");
  assert.equal(localDay("2026-03-08T07:30:00Z", "America/New_York"), "2026-03-08");
  assert.equal(localDay("2026-02-30T12:00:00Z", "UTC"), null); assert.equal(localDay("2026-01-01T12:00:00", "UTC"), null);
});
test("完整日期比较对齐长度，仅历史区间不混入近期变化", () => {
  const range = resolveOverviewRange(source(), { ...query, from: "2026-02-01" }, now);
  assert.deepEqual(range.comparison, { current: { from: "2026-02-01", to: "2026-02-14" }, previous: { from: "2026-01-18", to: "2026-01-31" } });
  assert.equal(resolveOverviewRange(source(), { ...query, from: "2026-02-15" }, now).comparison, null);
  assert.equal(resolveOverviewRange(source(), { ...query, to: "2026-02-10" }, now).recent, null);
  const year = resolveOverviewRange(source(), { timezone: "UTC" }, now);
  assert.deepEqual(year.recent, { current: { from: "2026-01-16", to: "2026-02-14" }, previous: { from: "2025-12-17", to: "2026-01-15" } });
});
test("全部范围纳入无时间记录，有限范围保留缺口且不归日期", () => {
  const input = source({ sessions: [session("a")], events: [event("a", "no-time", undefined, { occurredAt: undefined })],
    requests: [request("a", "no-time", undefined, { occurredAt: undefined })], resources: [resource("a", "no-time", undefined, undefined, { occurredAt: undefined })] });
  const finite = buildOverviewReport(input, query, pricing, now), all = buildOverviewReport(input, { window: "all", timezone: "UTC" }, pricing, now);
  assert.equal(finite.summary.sessions, 0); assert.equal(finite.summary.requests, 0); assert.equal(finite.coverage.missingTimeEvents, 1);
  assert.equal(all.summary.sessions, 1); assert.equal(all.summary.requests, 1); assert.equal(all.summary.activeDays, 0); assert.equal(all.resources.skills[0]!.uses, 1);
  assert.equal(all.range.comparison, null);
});
test("局部模型筛选只改变用量区域、计时与委派用量，六指标和资源不变", () => {
  const input = source({ sessions: [session("a"), session("b")], events: [event("a", "a"), event("b", "b")],
    requests: [request("a", "a"), request("b", "b", undefined, { model: "model-b" })], resources: [resource("b", "b")] });
  const report = buildOverviewReport(input, { ...query, models: ["model-a"] }, pricing, now);
  assert.equal(report.summary.requests, 2); assert.equal(report.summary.tokens, 300); assert.equal(report.usage.totals.requests, 1);
  assert.equal(report.summary.sessions, 2); assert.equal(report.resources.skills[0]!.uses, 1); assert.equal(report.summary.modelCount, 2);
});
test("Skill显式三次和成功读取两次合计五、会话一，失败读取不计使用", () => {
  const input = source({ sessions: [session("a")], events: [event("a", "user")], resources: [
    ...Array.from({ length: 3 }, (_, index) => resource("a", `call-${index}`)),
    ...Array.from({ length: 2 }, (_, index) => resource("a", `read-${index}`, undefined, undefined, { kind: "skill_read" })),
    resource("a", "failed-read", undefined, undefined, { kind: "skill_read", status: "failure" }),
  ] });
  const row = buildOverviewReport(input, query, pricing, now).resources.skills[0]!;
  assert.equal(row.uses, 5); assert.equal(row.explicitCalls, 3); assert.equal(row.successfulReads, 2); assert.equal(row.sessions, 1);
});
test("MCP按服务器汇总且内部工具只来自调用，主子组合各自去重", () => {
  const sessions = [session("a"), session("child", { relationship: "child", parentSessionId: "a" })];
  const input = source({ sessions, events: sessions.map(row => event(row.id, "user")), resources: sessions.flatMap(row => [
    resource(row.id, `${row.id}-skill`), resource(row.id, `${row.id}-skill2`),
    resource(row.id, `${row.id}-mcp`, "server-a", undefined, { kind: "mcp", server: "server-a", tool: "tool-a" }),
    resource(row.id, `${row.id}-mcp2`, "server-a", undefined, { kind: "mcp", server: "server-a", tool: "tool-b" }),
  ]) });
  const report = buildOverviewReport(input, query, pricing, now);
  assert.equal(report.resources.mcp.length, 1); assert.equal(report.resources.mcp[0]!.uses, 4); assert.equal(report.resources.mcp[0]!.tools.length, 2);
  assert.equal(report.resources.combinations.sessions[0]!.count, 2); assert.equal(report.resources.combinations.turns[0]!.count, 2);
});
test("资源后续观察首日重复不算续用，成熟、观察中、范围外和覆盖不足分别保留", () => {
  const input = source({ sessions: [session("a")], resources: [resource("a", "first", "first"), resource("a", "same-day", "first"),
    resource("a", "second", "second"), resource("a", "second-day", "second", "2026-01-02"),
    resource("a", "observing", "observing", "2026-02-01"), resource("a", "gapped", "gapped", "2026-01-03", {
      source: { path: "/workspace/synthetic.jsonl", sourceId: "gapped-source", revision: "r", fingerprint: "f", recordLine: 1 } })],
    gaps: [{ kind: "source_missing", message: "合成缺口", sourceId: "gapped-source" }] });
  const observations = buildOverviewReport(input, query, pricing, now).resources.observations;
  assert.equal(observations.find(row => row.name === "first")!.reused, false); assert.equal(observations.find(row => row.name === "second")!.reused, true);
  assert.equal(observations.find(row => row.name === "observing")!.state, "observing");
  assert.equal(observations.find(row => row.name === "gapped")!.state, "insufficient_coverage");
  const historical = buildOverviewReport(input, { ...query, to: "2026-01-15" }, pricing, now);
  assert.equal(historical.resources.observations.find(row => row.name === "first")!.state, "outside_range");
});
test("工具唯一配对补结果、歧义不推测，成功八失败二未知五的分母正确", () => {
  const input = source({ sessions: [session("a")], events: Array.from({ length: 15 }, (_, index) => event("a", `call-${index}`, undefined,
    { kind: "tool_call", tool: "read_file", ordinal: index, status: index < 8 ? "success" : index < 10 ? "failure" : "unknown" })) });
  const report = buildOverviewReport(input, query, pricing, now);
  assert.equal(report.process.results.failureRate, .2); assert.equal(report.process.results.coverage, 10 / 15); assert.equal(report.process.results.unknown, 5);
  const calls = pairToolCalls([event("a", "call", undefined, { kind: "tool_call", callId: "id" }),
    event("a", "result", undefined, { kind: "tool_result", callId: "id", status: "failure" })]);
  assert.equal(calls[0]!.status, "failure"); assert.equal(calls[0]!.resultMessageId, "result");
  const ambiguous = pairToolCalls([event("a", "call", undefined, { kind: "tool_call", callId: "id" }),
    event("a", "result", undefined, { kind: "tool_result", callId: "id", status: "failure" }),
    event("a", "second-result", undefined, { kind: "tool_result", callId: "id", status: "success" })]);
  assert.equal(ambiguous[0]!.pairing, "ambiguous"); assert.equal(ambiguous[0]!.status, "unknown");
});
test("失败后续仅同真实轮次，同轮多个失败共同后续身份去重", () => {
  const input = source({ sessions: [session("a")], events: [event("a", "user"),
    ...["failure", "failure", "success"].map((status, index) => event("a", `call-${index}`, undefined,
      { kind: "tool_call", ordinal: index + 2, tool: "read_file", status: status as "failure" | "success" })),
    event("a", "next-turn", undefined, { kind: "tool_call", ordinal: 5, turnId: "turn-2", tool: "read_file", status: "success" })] });
  const sequences = buildOverviewReport(input, query, pricing, now).process.failureSequences;
  assert.equal(sequences.length, 1); assert.equal(sequences[0]!.failures.length, 2); assert.equal(sequences[0]!.calls.length, 3);
});
test("计时按客户端模型区间依据和方法分组，短输出仅影响速度样本", () => {
  const timings = [
    { basis: "recorded" as const, window: "response" as const, method: "zcode_request_span" as const },
    { basis: "recorded" as const, window: "generation" as const, method: "zcode_request_span" as const },
    { basis: "estimated" as const, window: "response" as const, method: "codex_event_boundary" as const },
  ];
  const input = source({ sessions: [session("a")], requests: timings.map((timing, index) => request("a", `timing-${index}`, undefined, {
    outputTokens: 50, timing: { ...timing, completion: "explicit", durationMs: 2000 } })) });
  const report = buildOverviewReport(input, query, pricing, now);
  assert.equal(report.process.timing.length, 3); assert(report.process.timing.every(row => row.samples === 1 && row.speed.samples === 0));
});
test("部分Token不与完整请求竞争峰值，零分项保留零", () => {
  const input = source({ sessions: [session("a")], requests: [request("a", "complete"),
    request("a", "partial", undefined, { inputTokens: 9999, outputTokens: undefined }), request("a", "zero", undefined, { inputTokens: 0, outputTokens: 0 })] });
  const report = buildOverviewReport(input, query, pricing, now);
  assert.equal(report.summary.peak!.requestId, "complete"); assert.equal(report.summary.tokenCoverage, "partial");
  const zero = buildOverviewReport(source({ sessions: [session("a")], requests: [request("a", "zero", undefined, { inputTokens: 0, outputTokens: 0 })] }), query, pricing, now);
  assert.equal(zero.summary.tokens, 0); assert.equal(zero.summary.estimatedCost, 0);
});
test("委派分母单列缺来源及缺可靠时间，已确认子活动仍进入分子", () => {
  const sessions = [session("known", { childSessionIds: ["child", "missing"] }), session("none"), session("missing", { childSessionIds: ["lost-child"] }),
    session("undated", { childSessionIds: ["undated-child"] }), session("child", { parentSessionId: "known", relationship: "child" }),
    session("undated-child", { parentSessionId: "undated", relationship: "child" }), session("fork", { relationship: "fork" })];
  const input = source({ sessions, events: sessions.map(row => event(row.id, `event-${row.id}`, undefined, row.id === "undated-child" ? { occurredAt: undefined } : {})) });
  const result = buildOverviewReport(input, query, pricing, now).delegation;
  assert.equal(result.eligibleMainSessions, 2); assert.equal(result.withChildActivity, 1); assert.equal(result.unknownMainSessions, 2); assert.equal(result.forkSessions, 1);
});
test("版本、价格、日期与时区无效明确失败，诊断只返回有界摘要", () => {
  assert.throws(() => buildOverviewReport(source(), { ...query, version: "wrong" }, pricing, now), { code: "VERSION_NOT_FOUND" });
  assert.throws(() => buildOverviewReport(source(), { ...query, priceVersion: "wrong" }, pricing, now), { code: "VERSION_NOT_FOUND" });
  assert.throws(() => buildOverviewReport(source(), { ...query, from: "2026-02-30" }, pricing, now), { code: "INVALID_INPUT" });
  assert.throws(() => buildOverviewReport(source(), { ...query, timezone: "invalid" }, pricing, now), { code: "INVALID_INPUT" });
  const report = buildOverviewReport(source({ gaps: Array.from({ length: 200 }, () => ({ kind: "source_missing", message: "合成缺口" })) }), query, pricing, now);
  assert.equal(report.coverage.gapCount, 200); assert.equal(report.coverage.gaps.length, 100);
});
test("未知资源名称保留来源调查但不增加已知种类、组合或成熟窗口分母", () => {
  const input = source({ sessions: [session("a")], resources: [resource("a", "known"), resource("a", "unknown", "未记录名称")] });
  const report = buildOverviewReport(input, query, pricing, now);
  assert.equal(report.resources.skills.length, 2); assert.equal(report.summary.resourceCount, 1);
  assert.equal(report.resources.combinations.sessions.length, 0);
  assert.equal(report.resources.observations.find(row => row.name === "未记录名称")!.state, "insufficient_coverage");
});
