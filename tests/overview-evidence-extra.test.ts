import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverviewEvidenceQuery, OverviewQuery, OverviewSnapshot, OverviewSource } from "../src/overview-contracts.js";
import type { SessionMessage, SessionSourceMeta, SessionUsage } from "../src/session-contracts.js";
import { SessionStore } from "../src/sessions/store.js";
import { OverviewFactStore } from "../src/overview/facts.js";
import { factEvidence } from "../src/overview/evidence-facts.js";
import { hydrateFactRequestEvidence } from "../src/overview/evidence-extra.js";
import { buildOverviewEvidence } from "../src/overview/evidence.js";
import { resourceIdentity } from "../src/overview/analytics.js";
import { pricing } from "./overview-fixtures.js";

const now = new Date("2026-03-15T12:00:00Z");
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const query: OverviewQuery = { window: "custom", from: "2026-02-01", to: "2026-03-14", timezone: "UTC", anchorDay: "2026-03-15" };
function message(sessionId: string, id: string, ordinal: number, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { sessionId, id, ordinal, recordLine: ordinal + 1, turnId: "turn-a", kind: "assistant",
    text: "合成原始正文不进入派生调查", occurredAt: "2026-02-01T12:00:00Z", ...extra };
}
function revision(store: SessionStore, id: string, messages: SessionMessage[], usages: SessionUsage[], extra: Partial<SessionSourceMeta> = {}) {
  const summary: SessionSourceMeta = { id, client: "codex", clientSessionId: id, title: `合成会话 ${id}`, titleOrigin: "recorded",
    path: `/workspace/history/${id}.jsonl`, sourceId: `source-${id}`, messageCount: messages.length, turnCount: 1, models: [], gaps: [], ...extra };
  const entry = store.createRevision(summary.path, `synthetic-${id}`);
  for (const item of messages) entry.sink.message(item);
  for (const usage of usages) entry.sink.usage(usage);
  entry.flush(); store.finishRevision(entry.revision, summary);
  return { revision: entry.revision, path: summary.path, fingerprint: `synthetic-${id}` };
}
async function fixture(run: (store: SessionStore, facts: OverviewFactStore, source: OverviewSource) => Promise<void>, large = false): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "manor-evidence-page-")), store = new SessionStore(join(directory, "index.sqlite"));
  let facts: OverviewFactStore | undefined;
  try {
    const entries = history(store);
    if (large) {
      const messages = Array.from({ length: 5000 }, (_, index) => message("bulk", `event-${index}`, index + 1));
      const usages = Array.from({ length: 1200 }, (_, index) => ({ id: `request-${index}`, messageId: `event-${index * 3}`,
        requestMessageIds: Array.from({ length: 18 }, (_, member) => `event-${index * 3 + member}`),
        occurredAt: "2026-02-01T12:00:00Z", inputTokens: index, outputTokens: 1, model: "model-a" }));
      entries.push(revision(store, "bulk", messages, usages));
    }
    store.publish(store.createJob().id, entries, []);
    facts = new OverviewFactStore(store, { path: join(directory, "facts.sqlite") });
    await facts.prepare(query, now);
    await run(store, facts, store.overviewSource());
  } finally { facts?.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
}
function history(store: SessionStore) {
  const main = revision(store, "Main-A", [
    message("Main-A", "outside", 1, { kind: "user", occurredAt: "2026-01-31T23:59:00Z" }),
    message("Main-A", "inside", 2, { kind: "user" }),
    message("Main-A", "call-a", 3, { kind: "tool_call", tool: "read_file", callId: "call-a" }),
    message("Main-A", "result-a", 4, { kind: "tool_result", callId: "call-a", status: "failure", occurredAt: "2026-02-02T12:00:00Z" }),
    message("Main-A", "compression", 5, { kind: "compression" }),
    message("Main-A", "answer", 6, { model: "model-b" }),
    message("Main-A", "retry", 7, { kind: "tool_call", tool: "read_file", callId: "retry", status: "success" }),
    message("Main-A", "another-turn", 8, { kind: "user", turnId: "turn-b", occurredAt: "2026-02-04T12:00:00Z" }),
    message("Main-A", "skill-a", 9, { kind: "tool_call", tool: "skill", resource: { kind: "skill_call", name: "skill-a" } }),
    message("Main-A", "skill-b", 10, { kind: "tool_call", tool: "skill", resource: { kind: "skill_call", name: "skill-b" } }),
    message("Main-A", "skill-reuse", 11, { kind: "tool_call", occurredAt: "2026-02-20T12:00:00Z", resource: { kind: "skill_call", name: "skill-a" } }),
    message("Main-A", "skill-body", 12, { kind: "user", status: "success", resource: { kind: "skill_read", name: "skill-a" } }),
    message("Main-A", "skill-read-failed", 13, { kind: "user", status: "failure", resource: { kind: "skill_read", name: "skill-b" } }),
    message("Main-A", "mcp-a", 14, { kind: "tool_call", tool: "mcp__server-a__search", callId: "mcp-a",
      resource: { kind: "mcp", name: "server-a", server: "server-a" }, status: "failure" }),
    message("Main-A", "mcp-b", 15, { kind: "tool_call", tool: "mcp__server-a__search", callId: "mcp-b",
      resource: { kind: "mcp", name: "server-a", server: "server-a" }, status: "success" }),
    message("Main-A", "missing", 16, { occurredAt: undefined }),
    message("Main-A", "copied", 17, { copied: true }),
    message("Main-A", "injected", 18, { contextSource: "system_injection" }),
    message("Main-A", "observing", 19, { kind: "tool_call", occurredAt: "2026-03-14T12:00:00Z", resource: { kind: "skill_call", name: "recent-skill" } }),
    message("Main-A", "shared-identity", 20, { occurredAt: "2026-02-28T12:00:00Z" }),
    message("Main-A", "unknown-resource", 21, { kind: "tool_call", resource: { kind: "mcp", name: "未记录名称" } }),
    message("Main-A", "undated-resource", 22, { kind: "tool_call", occurredAt: undefined, resource: { kind: "skill_call", name: "undated-skill" } }),
  ], [
    { id: "outside-request", messageId: "outside", occurredAt: "2026-01-31T23:59:00Z", model: "model-a", inputTokens: 1 },
    { id: "first", messageId: "inside", requestMessageIds: ["call-a", "inside"], occurredAt: "2026-02-01T12:00:00Z", model: "model-a", inputTokens: 100, outputTokens: 1 },
    { id: "switch", messageId: "answer", requestMessageIds: ["answer", "retry"], occurredAt: "2026-02-01T12:30:00Z", model: "model-b", inputTokens: 200, outputTokens: 2 },
    { id: "barrier", messageId: "another-turn", occurredAt: "2026-02-04T12:00:00Z", inputTokens: 300 },
    { id: "after-barrier", occurredAt: "2026-02-04T12:01:00Z", model: "model-c", outputTokens: 4 },
    { id: "undated", model: "model-d", occurredAt: undefined },
    { id: "after-undated", occurredAt: "2026-02-05T12:01:00Z", model: "model-a", inputTokens: 500, outputTokens: 5 },
    { id: "same-model", occurredAt: "2026-02-05T12:02:00Z", model: "model-a", inputTokens: 600, outputTokens: 6 },
    { id: "mirror", occurredAt: "2026-02-02T12:01:00Z", model: "model-b", timing: { basis: "recorded", method: "zcode_request_span", completion: "explicit", end: { messageId: "result-a", source: "mirror", recordLine: 5 } } },
    { id: "endpoint", occurredAt: "2026-02-02T12:02:00Z", model: "model-b", timing: { basis: "recorded", method: "zcode_request_span", completion: "explicit", end: { messageId: "result-a", source: "recorded", recordLine: 5 } } },
    { id: "shared-identity", occurredAt: "2026-02-28T12:00:00Z", inputTokens: 7 },
    { id: "copied-request", messageId: "copied", inputTokens: 999 },
  ], { project: "/workspace/project-a", childSessionIds: ["child"] });
  const child = revision(store, "child", [message("child", "user", 1, { kind: "user" }),
    message("child", "skill-a", 2, { kind: "tool_call", resource: { kind: "skill_call", name: "skill-a" } }),
    message("child", "skill-b", 3, { kind: "tool_call", resource: { kind: "skill_call", name: "skill-b" }, turnId: "injected-turn" })],
    [{ id: "child-request", occurredAt: "2026-02-01T12:00:00Z", model: "model-c", inputTokens: 50, outputTokens: 5 }],
    { parentSessionId: "Main-A", relationship: "child", project: "/workspace/project-a" });
  const fork = revision(store, "fork", [message("fork", "user", 1, { kind: "user", occurredAt: undefined })],
    [{ id: "no-time", model: "model-c", inputTokens: 40 }], { relationship: "fork", client: "pi", project: "/workspace/project-b" });
  const partial = revision(store, "partial", [message("partial", "skill", 1, { kind: "tool_call", resource: { kind: "skill_call", name: "partial-skill" } })], [],
    { gaps: [{ kind: "incomplete_record", message: "合成资源记录缺口" }] });
  return [main, child, fork, partial];
}
function snapshot(facts: OverviewFactStore, input: OverviewQuery): OverviewSnapshot {
  const metadata = facts.snapshot(input);
  return { version: metadata.version, priceVersion: pricing.status.version, timezone: input.timezone!, query: { ...input, version: metadata.version, priceVersion: pricing.status.version },
    range: facts.range(input, now) };
}
async function comparePage(facts: OverviewFactStore, source: OverviewSource, input: OverviewQuery, evidence: OverviewEvidenceQuery) {
  const fixed = snapshot(facts, input), actual = await factEvidence(facts, fixed, evidence, pricing, now);
  const expected = buildOverviewEvidence(source, fixed.query, evidence, pricing, now);
  assert.deepEqual(plain(actual), plain(expected), `${JSON.stringify({ input, evidence })}`);
}

test("复杂证据按页身份与完整 oracle 等价：活动、会话、关系、序列和范围", async () => fixture(async (_store, facts, source) => {
  const cases: OverviewEvidenceQuery[] = [
    { kind: "sessions" }, { kind: "sessions", rule: "13" },
    { kind: "sessions", scope: "usage", model: "model-a" }, { kind: "sessions", undated: true },
    { kind: "sessions", period: "previous" }, { kind: "sessions", project: "/workspace/project-b" },
    { kind: "delegation" }, { kind: "delegation", transition: "delegation", modelFrom: "model-a", modelTo: "model-c", sessionId: "child" },
    { kind: "delegation", relationship: "child" }, { kind: "sequence", tool: "read_file" },
    { kind: "sequence", server: "server-a" }, { kind: "sequence", day: "2026-02-01" },
    { kind: "sequence", scope: "usage", model: "model-a" },
    { kind: "requests", transition: "switch" }, { kind: "requests", transition: "switch", modelFrom: "model-a", modelTo: "model-b" },
    { kind: "tools", category: "read" }, { kind: "failures", category: "external" },
    { kind: "activity" }, { kind: "activity", scope: "usage" }, { kind: "activity", day: "2026-02-01" },
    { kind: "activity", tool: "read_file" }, { kind: "activity", category: "external" }, { kind: "activity", undated: true },
    { kind: "activity", status: "failure" }, { kind: "activity", status: "success" }, { kind: "activity", status: "unknown" },
  ];
  for (const filters of [query, { ...query, models: ["model-a"] }, { ...query, window: "all" as const, from: undefined, to: undefined }]) {
    for (const evidence of cases) for (const sort of ["recent", "tokens", "ordinal", "duration"] as const) {
      for (const page of [1, 2, 3]) await comparePage(facts, source, filters, { ...evidence, sort, page, pageSize: 2 });
    }
  }
}));

test("观察与组合仅聚合资源和真实轮次，页内消息与对象状态等价", async () => fixture(async (_store, facts, source) => {
  const skillA = source.resources.find(event => event.name === "skill-a")!, skillB = source.resources.find(event => event.name === "skill-b")!;
  const resourceId = resourceIdentity(skillA), resourceId2 = resourceIdentity(skillB);
  const cases: OverviewEvidenceQuery[] = [
    { kind: "observations" }, { kind: "observations", resourceId }, { kind: "observations", observationState: "mature" },
    { kind: "observations", observationState: "observing" }, { kind: "observations", observationState: "insufficient_coverage" },
    { kind: "observations", day: "2026-02-01" }, { kind: "observations", day: "2026-02-01", observationState: "outside_range" },
    { kind: "combinations" }, { kind: "combinations", resourceId, resourceId2 },
    { kind: "combinations", unit: "turn", resourceId, resourceId2 }, { kind: "combinations", unit: "turn" },
    { kind: "combinations", unit: "turn", sessionId: "child" }, { kind: "combinations", resourceId, resourceId2: "not-present" },
  ];
  for (const evidence of cases) for (const sort of ["recent", "ordinal"] as const) for (const page of [1, 2, 3]) {
    await comparePage(facts, source, query, { ...evidence, sort, page, pageSize: 2 });
  }
}));

test("请求上下文成员只读当前页与前邻居，跨日压缩、未知模型和缺时不桥接", async () => fixture(async (store, facts, source) => {
  const fixed = snapshot(facts, query), metadata = facts.snapshot(fixed.query), rawScope = facts.sqlScope(fixed.query, now);
  const scope = { metadata, revisions: rawScope.revisions, globalRevisions: rawScope.revisions, time: "f.time_ms>=? AND f.time_ms<?", values: [JSON.stringify(rawScope.revisions), rawScope.bounds!.fromMs, rawScope.bounds!.toMs],
    initial: buildOverviewEvidence({ ...metadata, events: [], requests: [], resources: [] }, fixed.query, { kind: "requests" }, pricing, now), range: fixed.range, query: fixed.query };
  const read = store.overviewRequestMembers.bind(store), memberCalls: string[][] = [];
  store.overviewRequestMembers = (revisionId, ids) => { assert(ids, "成员必须有页级身份限制"); memberCalls.push(ids); return read(revisionId, ids); };
  for (const requestId of ["switch", "after-barrier", "after-undated", "same-model"]) {
    memberCalls.length = 0;
    const evidence: OverviewEvidenceQuery = { kind: "requests", requestId };
    const raw = facts.readRows<Parameters<OverviewFactStore["decodeRequest"]>[0]>(`SELECT f.*,r.session_id FROM overview_fact_requests f
      JOIN overview_fact_revisions r ON r.revision=f.revision WHERE f.id=?`, [requestId]);
    const rows = hydrateFactRequestEvidence(facts, fixed, evidence, scope, raw, pricing);
    assert.deepEqual(plain(rows), plain(buildOverviewEvidence(source, fixed.query, evidence, pricing, now).rows));
    assert.equal(memberCalls.flat().length, 2, "只恢复当前与直接前邻居");
  }
}));

test("大活动调查不调用完整 source，解码事件仅一页、成员按128批即时释放", async () => fixture(async (store, facts, source) => {
  const originalSource = facts.source.bind(facts), originalEvents = facts.decodeEvent.bind(facts), originalResources = facts.decodeResource.bind(facts);
  facts.source = async () => { throw new Error("禁止完整 source"); };
  let decodedEvents = 0, decodedResources = 0, maximumMembers = 0;
  facts.decodeEvent = raw => { decodedEvents += 1; return originalEvents(raw); };
  facts.decodeResource = raw => { decodedResources += 1; return originalResources(raw); };
  const originalMembers = store.overviewRequestMembers.bind(store);
  store.overviewRequestMembers = (revisionId, ids) => {
    assert(ids); maximumMembers = Math.max(maximumMembers, ids.length); return originalMembers(revisionId, ids);
  };
  const originalRequests = facts.decodeRequest.bind(facts); let decodedRequests = 0;
  facts.decodeRequest = raw => { decodedRequests += 1; return originalRequests(raw); };
  try {
    await comparePage(facts, source, query, { kind: "activity", pageSize: 7, page: 2, sort: "recent" });
    assert(decodedEvents <= 7); assert.equal(decodedResources, 0); assert(maximumMembers <= 128);
    decodedEvents = 0; decodedRequests = 0;
    await comparePage(facts, source, query, { kind: "sessions", pageSize: 2, sort: "tokens" });
    assert.equal(decodedEvents, 0); assert.equal(decodedRequests, 0);
    await comparePage(facts, source, query, { kind: "observations", pageSize: 2 });
    assert(decodedResources <= 2);
  } finally { facts.source = originalSource; }
}, true));

test("时间范围含夏令时和模型交集，旧关系版本不受新版本及追加身份影响", async () => fixture(async (store, facts, source) => {
  for (const timezone of ["Asia/Shanghai", "America/New_York", "Pacific/Kiritimati"]) {
    const input = { ...query, timezone }; await facts.prepare(input, now);
    for (const evidence of [{ kind: "sessions", rule: "13" }, { kind: "delegation", sessionId: "child" },
      { kind: "requests", transition: "switch", day: "2026-02-02" }, { kind: "combinations", unit: "turn" },
      { kind: "activity", day: "2026-02-02" }] as OverviewEvidenceQuery[]) await comparePage(facts, source, input, evidence);
  }
  const oldVersion = source.version;
  const next = revision(store, "Main-A", [message("Main-A", "new", 1)], [{ id: "new-model", model: "new-model", occurredAt: "2026-02-01T12:00:00Z" }]);
  const children = store.usageFactSessions(oldVersion).sessions.filter(entry => entry.session.id !== "Main-A").map(entry => ({
    revision: entry.revision, path: `/workspace/history/${entry.session.id}.jsonl`, fingerprint: `synthetic-${entry.session.id}` }));
  store.publish(store.createJob().id, [next, ...children], []); await facts.prepare(query, now);
  await comparePage(facts, source, { ...query, version: oldVersion }, { kind: "delegation", sessionId: "child", transition: "delegation", modelFrom: "model-a", modelTo: "model-c" });
}));
