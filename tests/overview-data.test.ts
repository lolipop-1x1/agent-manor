import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionMessage, SessionSourceMeta, SessionUsage } from "../src/session-contracts.js";
import { SessionStore } from "../src/sessions/store.js";
import { loadOverviewSource } from "../src/overview/data.js";
import { buildOverviewReport } from "../src/overview/analytics.js";
import { generateOverviewInsights } from "../src/overview/insights.js";
import { buildOverviewEvidence } from "../src/overview/evidence.js";
import { now, pricing } from "./overview-fixtures.js";

async function fixture(run: (store: SessionStore) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "manor-overview-facts-"));
  const store = new SessionStore(join(directory, "index.sqlite"));
  try { run(store); } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}
function publishSource(store: SessionStore, id: string, messages: SessionMessage[], requests: SessionUsage[], extra: Partial<SessionSourceMeta> = {}) {
  const summary: SessionSourceMeta = { id, client: "codex", clientSessionId: id, title: "合成会话", titleOrigin: "recorded",
    messageCount: messages.length, turnCount: 1, models: [], gaps: [], path: `/workspace/history/${id}.jsonl`, sourceId: `source-${id}`, ...extra };
  const pending = store.createRevision(summary.path, "synthetic");
  for (const message of messages) pending.sink.message(message);
  for (const request of requests) pending.sink.usage(request);
  pending.flush(); store.finishRevision(pending.revision, summary);
  return { path: summary.path, revision: pending.revision, fingerprint: "synthetic" };
}
const message = (sessionId: string, id: string, ordinal: number, extra: Partial<SessionMessage> = {}): SessionMessage => ({
  sessionId, id, ordinal, recordLine: ordinal + 1, turnId: "turn-a", kind: "user", text: "合成正文", occurredAt: "2026-01-01T12:00:00Z", ...extra,
});
test("请求存储顺序与消息坐标分别保留，压缩洞察和请求明细一致", async () => fixture(store => {
  const revision = publishSource(store, "a", [message("a", "first", 100, { kind: "assistant" }), message("a", "compact", 101, { kind: "compression" }), message("a", "last", 102, { kind: "assistant" })],
    [{ id: "first-request", messageId: "first", model: "model-a", occurredAt: "2026-01-01T12:00:00Z", inputTokens: 100, outputTokens: 10 },
      { id: "last-request", requestMessageIds: ["last"], model: "model-a", occurredAt: "2026-01-01T12:00:00Z", inputTokens: 100, outputTokens: 10 }]);
  const version = store.publish(store.createJob().id, [revision], []), input = loadOverviewSource(store, version);
  assert.deepEqual(input.requests.map(request => request.ordinal), [1, 2]);
  const report = buildOverviewReport(input, { window: "all", timezone: "UTC" }, pricing, now);
  const insight = generateOverviewInsights(input, report.query, pricing, report, now).insights.find(item => item.metric === "input_sequence")!;
  assert.equal(insight.values?.compressions, 1);
  const evidence = buildOverviewEvidence(input, report.query, insight.evidence, pricing, now);
  assert.deepEqual(evidence.rows.map(row => row.values?.eventOrdinal), [100, 102]);
  assert.equal(JSON.parse(String(evidence.rows[1]!.values?.compressions)).length, 1);
}));
test("事实投影读取完整固定版本，正文、工具参数及继承副本均不进入总览source", async () => fixture(store => {
  const revision = publishSource(store, "a", [
    message("a", "user", 1, { text: "synthetic-body-marker".repeat(20000) }),
    message("a", "call", 2, { kind: "tool_call", tool: "mcp__server-a__tool-a", callId: "call-a", resource: { kind: "mcp", name: "server-a", server: "server-a" } }),
    message("a", "result", 3, { kind: "tool_result", callId: "call-a", status: "failure" }),
    message("a", "copied", 4, { copied: true }),
  ], [{ id: "own", messageId: "user", inputTokens: 100, outputTokens: 50, turnId: "turn-a", requestMessageIds: ["user"],
    timing: { basis: "recorded", method: "zcode_request_span", completion: "explicit", durationMs: 2000 } },
  { id: "copied", messageId: "copied", inputTokens: 500, outputTokens: 500 },
  { id: "copied-member", requestMessageIds: ["copied"], inputTokens: 500, outputTokens: 500 },
  { id: "copied-end", timing: { basis: "recorded", method: "zcode_request_span", completion: "explicit", end: { messageId: "copied", recordLine: 4 } } }]);
  const version = store.publish(store.createJob().id, [revision], []);
  const projected = loadOverviewSource(store, version);
  assert.equal(projected.events.length, 3); assert.equal(projected.requests.length, 1); assert(projected.requests[0]!.ordinal! > 0);
  assert.equal(projected.requests[0]!.usage.timing!.durationMs, 2000); assert.deepEqual(projected.requests[0]!.usage.requestMessageIds, ["user"]);
  assert.equal(projected.resources.length, 1); assert.equal(projected.resources[0]!.status, "failure");
  assert(!JSON.stringify(projected).includes("synthetic-body-marker")); assert(projected.events.every(event => !("text" in event)));
  assert.throws(() => loadOverviewSource(store, "unavailable-version"), { code: "VERSION_NOT_FOUND" });
}));
test("父子身份来自同版关系，新发布不会改变旧版投影", async () => fixture(store => {
  const parent = publishSource(store, "parent", [message("parent", "parent-user", 1)], [], { childSessionIds: ["child"] });
  const child = publishSource(store, "child", [message("child", "child-user", 1)], [], { relationship: "child", parentSessionId: "parent" });
  const version = store.publish(store.createJob().id, [parent, child], []);
  store.publish(store.createJob().id, [parent], []);
  const old = loadOverviewSource(store, version);
  assert.equal(old.sessions.length, 2); assert.equal(old.sessions.find(session => session.id === "child")!.parentSessionId, "parent");
  assert.equal(loadOverviewSource(store).sessions.length, 1);
}));
