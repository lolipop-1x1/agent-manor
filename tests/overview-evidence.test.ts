import assert from "node:assert/strict";
import test from "node:test";
import { buildOverviewEvidence } from "../src/overview/evidence.js";
import { resourceIdentity } from "../src/overview/analytics.js";
import { buildOverviewReport } from "../src/overview/analytics.js";
import { event, now, pricing, request, resource, session, source } from "./overview-fixtures.js";

const query = { window: "custom" as const, from: "2026-01-01", to: "2026-02-15", timezone: "UTC" };
test("月份追加边界与所选比较期取交，前期不被裁到当期", () => {
  const input = source({ sessions: [session("a")], requests: [request("a", "before", "2026-02-05"), request("a", "inside", "2026-02-15"), request("a", "previous", "2026-02-04")] });
  const filters = { ...query, from: "2026-02-10", to: "2026-02-20", anchorDay: "2026-03-01" };
  assert.deepEqual(buildOverviewEvidence(input, filters, { kind: "requests", from: "2026-02-01", to: "2026-02-28" }, pricing, now).rows.map(row => row.requestId), ["inside"]);
  assert.deepEqual(buildOverviewEvidence(input, filters, { kind: "requests", period: "previous", day: "2026-02-04" }, pricing, now).rows.map(row => row.requestId), ["previous"]);
  assert.equal(buildOverviewEvidence(input, filters, { kind: "requests", day: "2026-02-05", period: "current" }, pricing, now).total, 0);
});
test("跨午夜沿用报告快照日期，比较和近期证据不漂移", () => {
  const firstNow = new Date("2026-03-01T12:00:00Z"), nextNow = new Date("2026-03-02T12:00:00Z");
  const input = source({ sessions: [session("a")], requests: [request("a", "february", "2026-02-28"), request("a", "march", "2026-03-01")] });
  const report = buildOverviewReport(input, { window: "365", timezone: "UTC" }, pricing, firstNow);
  for (const period of ["current", "previous", "recent", "recent_previous"] as const) {
    const first = buildOverviewEvidence(input, report.query, { kind: "requests", period }, pricing, firstNow);
    const later = buildOverviewEvidence(input, report.query, { kind: "requests", period }, pricing, nextNow);
    assert.deepEqual(later.range, first.range); assert.deepEqual(later.rows, first.rows);
  }
});
test("证据分页不改变完整数量，定位字段完整且不包含消息正文", () => {
  const input = source({ sessions: [session("a")], events: Array.from({ length: 6 }, (_, index) => event("a", `event-${index}`, `2026-01-0${index + 1}`)) });
  const first = buildOverviewEvidence(input, query, { kind: "activity", pageSize: 2 }, pricing, now);
  const second = buildOverviewEvidence(input, query, { kind: "activity", pageSize: 2, page: 2 }, pricing, now);
  assert.equal(first.total, 6); assert.equal(second.total, 6); assert.equal(first.rows.length, 2); assert.equal(second.rows.length, 2);
  assert(first.rows.every(row => row.messageId && !("text" in row))); assert.notEqual(first.rows[0]!.id, second.rows[0]!.id);
});
test("无时间事实按需调查，不进入普通有限范围", () => {
  const input = source({ sessions: [session("a")], events: [event("a", "dated"), event("a", "undated", undefined, { occurredAt: undefined })],
    requests: [request("a", "undated", undefined, { occurredAt: undefined })] });
  assert.equal(buildOverviewEvidence(input, query, { kind: "requests" }, pricing, now).total, 0);
  const undated = buildOverviewEvidence(input, query, { kind: "requests", undated: true }, pricing, now);
  assert.equal(undated.total, 1); assert.equal(undated.rows[0]!.day, undefined);
  assert.equal(buildOverviewEvidence(input, query, { kind: "activity", undated: true }, pricing, now).total, 2);
});
test("局部用量证据应用模型筛选，资源及工具证据保持全局范围", () => {
  const input = source({ sessions: [session("a")], requests: [request("a", "a"), request("a", "b", undefined, { model: "model-b" })], resources: [resource("a", "resource")] });
  assert.equal(buildOverviewEvidence(input, { ...query, models: ["model-a"] }, { kind: "requests", scope: "global" }, pricing, now).total, 2);
  assert.equal(buildOverviewEvidence(input, { ...query, models: ["model-a"] }, { kind: "requests", scope: "usage" }, pricing, now).total, 1);
  assert.equal(buildOverviewEvidence(input, { ...query, models: ["model-a"] }, { kind: "resources" }, pricing, now).total, 1);
});
test("峰值请求精确定位，原始ordinal片段不受分页改变", () => {
  const requests = [request("a", "first"), request("a", "peak"), request("a", "last")].map((value, index) => ({ ...value, ordinal: index + 1 }));
  const input = source({ sessions: [session("a")], requests });
  assert.deepEqual(buildOverviewEvidence(input, query, { kind: "requests", requestId: "peak" }, pricing, now).rows.map(row => row.requestId), ["peak"]);
  assert.deepEqual(buildOverviewEvidence(input, query, { kind: "requests", ordinalFrom: 2, ordinalTo: 3, sort: "ordinal" }, pricing, now).rows.map(row => row.requestId), ["peak", "last"]);
});
test("真实相邻模型切换不跨未知模型拼接，分段上下文回查原顺序", () => {
  const requests = [request("a", "a"), request("a", "unknown", undefined, { model: undefined }), request("a", "b", undefined, { model: "model-b" }),
    request("a", "c", undefined, { model: "model-c" })].map((value, index) => ({ ...value, ordinal: index + 1 }));
  const input = source({ sessions: [session("a")], requests });
  const noBridge = buildOverviewEvidence(input, query, { kind: "requests", transition: "switch", modelFrom: "model-a", modelTo: "model-b" }, pricing, now);
  assert.equal(noBridge.total, 0);
  const actual = buildOverviewEvidence(input, query, { kind: "requests", transition: "switch", modelFrom: "model-b", modelTo: "model-c" }, pricing, now);
  assert.equal(actual.total, 1); assert.equal(actual.rows[0]!.values!.previousRequestId, "b");
});
test("跨日会话证据保留完整日期和间隔，单日会话不进入rule13", () => {
  const input = source({ sessions: [session("a"), session("b")], events: [event("a", "first"), event("a", "fifth", "2026-01-05"), event("b", "one")] });
  const evidence = buildOverviewEvidence(input, query, { kind: "sessions", rule: "13" }, pricing, now);
  assert.equal(evidence.total, 1); assert.deepEqual(evidence.rows[0]!.dates, ["2026-01-01", "2026-01-05"]);
  assert.equal(evidence.rows[0]!.values!.maxGapDays, 4); assert.equal(evidence.rows[0]!.values!.dateGaps, "[4]");
});
test("组合证据主子会话独立，轮次缺真实用户开头不能虚构", () => {
  const a = resource("a", "a", "skill-a"), b = resource("a", "b", "skill-b");
  const input = source({ sessions: [session("a"), session("child", { relationship: "child", parentSessionId: "a" })],
    events: [event("a", "user")], resources: [a, b, { ...a, sessionId: "child", id: "child-a" }, { ...b, sessionId: "child", id: "child-b" }] });
  assert.equal(buildOverviewEvidence(input, query, { kind: "combinations", resourceId: resourceIdentity(a), resourceId2: resourceIdentity(b) }, pricing, now).total, 2);
  assert.equal(buildOverviewEvidence(input, query, { kind: "combinations", unit: "turn", resourceId: resourceIdentity(a), resourceId2: resourceIdentity(b) }, pricing, now).total, 1);
});
test("工具失败证据按同版唯一结果配对，后续过程不跨轮次", () => {
  const input = source({ sessions: [session("a")], events: [event("a", "user"),
    event("a", "call", undefined, { ordinal: 2, kind: "tool_call", tool: "read_file", callId: "call" }),
    event("a", "result", undefined, { ordinal: 3, kind: "tool_result", callId: "call", status: "failure" }),
    event("a", "later", undefined, { ordinal: 4, kind: "tool_call", tool: "read_file", status: "success" }),
    event("a", "next", undefined, { ordinal: 5, kind: "tool_call", tool: "read_file", turnId: "turn-2", status: "success" })] });
  const failures = buildOverviewEvidence(input, query, { kind: "failures" }, pricing, now);
  assert.equal(failures.total, 1); assert.equal(failures.rows[0]!.resultMessageId, "result");
  assert.equal(buildOverviewEvidence(input, query, { kind: "sequence", tool: "read_file" }, pricing, now).total, 2);
});
test("追加条件不能越过报告客户端项目模型，失效版本及非法分页明确失败", () => {
  const input = source({ sessions: [session("a", { project: "/workspace/a" }), session("b", { client: "claude", project: "/workspace/b" })],
    requests: [request("a", "a"), request("b", "b", undefined, { model: "model-b" })] });
  assert.equal(buildOverviewEvidence(input, { ...query, clients: ["codex"] }, { kind: "requests", client: "claude" }, pricing, now).total, 0);
  assert.equal(buildOverviewEvidence(input, { ...query, models: ["model-a"] }, { kind: "requests", scope: "usage", model: "model-b" }, pricing, now).total, 0);
  assert.throws(() => buildOverviewEvidence(input, query, { kind: "requests", pageSize: 201 }, pricing, now), { code: "INVALID_INPUT" });
  assert.throws(() => buildOverviewEvidence(input, { ...query, version: "wrong" }, { kind: "requests" }, pricing, now), { code: "VERSION_NOT_FOUND" });
});
test("主子模型组合回查子会话自身记录和父自身模型，不按父树合并", () => {
  const input = source({ sessions: [session("parent"), session("child", { relationship: "child", parentSessionId: "parent" })],
    requests: [request("parent", "parent-request"), request("child", "child-request", undefined, { model: "model-b" })] });
  const evidence = buildOverviewEvidence(input, query, { kind: "delegation", transition: "delegation", modelFrom: "model-a", modelTo: "model-b", sessionId: "child" }, pricing, now);
  assert.equal(evidence.total, 1); assert.equal(evidence.rows[0]!.sessionId, "child"); assert.equal(evidence.rows[0]!.values!.parentSessionId, "parent");
  assert.equal(evidence.rows[0]!.values!.parentModels, '["model-a"]'); assert.equal(evidence.rows[0]!.values!.childModels, '["model-b"]');
  assert.equal(evidence.rows[0]!.values!.requests, 1);
});
test("工具同名不同服务器用opaque identity精确调查，不串失败后续", () => {
  const input = source({ sessions: [session("a")], events: [event("a", "user"),
    event("a", "failed-a", undefined, { ordinal: 2, kind: "tool_call", tool: "search", status: "failure", resource: { kind: "mcp", name: "search", server: "server-a" } }),
    event("a", "success-b", undefined, { ordinal: 3, kind: "tool_call", tool: "search", status: "success", resource: { kind: "mcp", name: "search", server: "server-b" } })] });
  const calls = buildOverviewEvidence(input, query, { kind: "tools", toolId: JSON.stringify(["search", "server-a"]) }, pricing, now);
  assert.equal(calls.total, 1); assert.equal(calls.rows[0]!.messageId, "failed-a");
  assert.equal(calls.rows[0]!.values!.server, "server-a");
  const sequence = buildOverviewEvidence(input, query, { kind: "sequence", server: "server-a", tool: "search" }, pricing, now);
  assert.deepEqual(sequence.rows.map(row => row.messageId), ["failed-a"]);
});
test("资源工具维度身份区分缺失、原名unknown和literal前缀", () => {
  const input = source({ sessions: [session("a")], resources: [resource("a", "missing", "server-a", undefined, { kind: "mcp", server: "server-a" }),
    resource("a", "literal", "server-a", undefined, { kind: "mcp", server: "server-a", tool: "unknown" }),
    resource("a", "prefixed", "server-a", undefined, { kind: "mcp", server: "server-a", tool: "literal:x" })] });
  for (const [toolKey, id] of [["unknown", "missing"], ["literal:unknown", "literal"], ["literal:literal:x", "prefixed"]]) {
    assert.deepEqual(buildOverviewEvidence(input, query, { kind: "resources", toolKey }, pricing, now).rows.map(row => row.id), [id]);
  }
});
test("模型请求通过结束边界关联消息时不重复增加活动记录", () => {
  const input = source({ sessions: [session("a")], events: [event("a", "response", undefined, { kind: "assistant" })],
    requests: [request("a", "request", undefined, { timing: { basis: "recorded", method: "zcode_request_span", completion: "explicit",
      end: { messageId: "response", recordLine: 1 } } })] });
  assert.equal(buildOverviewEvidence(input, query, { kind: "activity" }, pricing, now).total, 1);
});
