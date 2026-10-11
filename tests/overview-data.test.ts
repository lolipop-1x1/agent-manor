import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, readdirSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { serialize } from "node:v8";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
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
test("完整事实缓存跨Store重用并保持报告和分页证据，源版本校验先于缓存", async () => fixture(store => {
  const revision = publishSource(store, "cached", [message("cached", "user", 1, { text: "synthetic-cache-body" })],
    [{ id: "request", messageId: "user", occurredAt: "2026-01-01T12:00:00Z", inputTokens: 100, outputTokens: 20 }]);
  const version = store.publish(store.createJob().id, [revision], []), original = loadOverviewSource(store, version);
  const cache = join(dirname(store.dbPath), "overview-source.bin.gz");
  assert.equal(statSync(cache).mode & 0o777, 0o600);
  const restarted = new SessionStore(store.dbPath), read = restarted.overviewSource.bind(restarted); let reads = 0;
  restarted.overviewSource = requested => { reads += 1; return read(requested); };
  try {
    const restored = loadOverviewSource(restarted, version);
    assert.equal(reads, 0); assert.deepEqual(restored, original);
    const query = { window: "all" as const, timezone: "UTC" };
    assert.deepEqual(buildOverviewReport(restored, query, pricing, now), buildOverviewReport(original, query, pricing, now));
    assert.deepEqual(buildOverviewEvidence(restored, query, { kind: "requests", pageSize: 1 }, pricing, now),
      buildOverviewEvidence(original, query, { kind: "requests", pageSize: 1 }, pricing, now));
    assert.ok(!JSON.stringify(restored).includes("synthetic-cache-body"));
    assert.throws(() => loadOverviewSource(restarted, "synthetic-unavailable"), { code: "VERSION_NOT_FOUND" });
    assert.equal(reads, 0);
  } finally { restarted.close(); }
}));
test("损坏、格式失配和超过压缩上限的事实缓存从完整源重建，只保留一个文件", async () => fixture(store => {
  const revision = publishSource(store, "a", [message("a", "user", 1)], []);
  const version = store.publish(store.createJob().id, [revision], []), expected = loadOverviewSource(store);
  const cache = join(dirname(store.dbPath), "overview-source.bin.gz"), read = store.overviewSource.bind(store); let reads = 0;
  store.overviewSource = requested => { reads += 1; return read(requested); };
  for (const invalid of [Buffer.from("synthetic-invalid-gzip"), gzipSync(serialize({ format: -1, source: expected })),
    gzipSync(serialize({ format: 1, source: { ...expected, version: "synthetic-other-version" } }))]) {
    writeFileSync(cache, invalid);
    assert.deepEqual(loadOverviewSource(store, version), expected);
  }
  truncateSync(cache, 128 * 1024 * 1024 + 1);
  assert.deepEqual(loadOverviewSource(store), expected); assert.equal(reads, 4);
  assert.deepEqual(readdirSync(dirname(store.dbPath)).filter(name => name.startsWith("overview-source")), ["overview-source.bin.gz"]);
}));
test("新发布替换最新事实缓存，旧版请求和不可写缓存不改变查询结果", async () => fixture(store => {
  const first = publishSource(store, "a", [message("a", "first", 1)], []);
  const oldVersion = store.publish(store.createJob().id, [first], []); loadOverviewSource(store);
  const second = publishSource(store, "b", [message("b", "second", 1)], []);
  store.publish(store.createJob().id, [first, second], []);
  const current = loadOverviewSource(store), cache = join(dirname(store.dbPath), "overview-source.bin.gz"), bytes = readFileSync(cache);
  assert.equal(current.sessions.length, 2); assert.equal(loadOverviewSource(store, oldVersion).sessions.length, 1);
  assert.deepEqual(readFileSync(cache), bytes);
  writeFileSync(cache, "synthetic-invalid-cache");
  const temporaryStore = { dbPath: join(cache, "index.sqlite"), usageVersion: store.usageVersion.bind(store), overviewSource: store.overviewSource.bind(store) } as SessionStore;
  assert.deepEqual(loadOverviewSource(temporaryStore), current);
  assert.ok(readdirSync(dirname(store.dbPath)).every(name => !name.endsWith(".tmp")));
}));
