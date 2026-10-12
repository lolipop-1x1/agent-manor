import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import type { OverviewQuery, OverviewSource } from "../src/overview-contracts.js";
import type { SessionMessage, SessionSourceMeta, SessionUsage } from "../src/session-contracts.js";
import { SessionStore } from "../src/sessions/store.js";
import { OverviewFactStore } from "../src/overview/facts.js";
import { buildOverviewReport, pairToolCalls, isActivityEvent } from "../src/overview/analytics.js";
import { resolveOverviewRange } from "../src/overview/dates.js";
import { pricing } from "./overview-fixtures.js";

const now = new Date("2026-03-09T12:00:00Z");
const value = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
function message(sessionId: string, id: string, ordinal: number, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { sessionId, id, ordinal, recordLine: ordinal + 1, turnId: "turn-a", kind: "user", text: "synthetic-private-body",
    occurredAt: "2026-03-07T12:00:00Z", ...extra };
}
function revision(store: SessionStore, id: string, messages: SessionMessage[], requests: SessionUsage[], extra: Partial<SessionSourceMeta> = {}) {
  const summary: SessionSourceMeta = { id, client: "codex", clientSessionId: id, title: "合成会话", titleOrigin: "recorded",
    path: `/workspace/history/${id}.jsonl`, sourceId: `source-${id}`, messageCount: messages.length, turnCount: 1, models: [], gaps: [], ...extra };
  const pending = store.createRevision(summary.path, `synthetic-${messages.length}-${requests.length}`);
  for (const item of messages) pending.sink.message(item);
  for (const item of requests) pending.sink.usage(item);
  pending.flush(); store.finishRevision(pending.revision, summary);
  return { path: summary.path, revision: pending.revision, fingerprint: `synthetic-${messages.length}-${requests.length}` };
}
async function fixture(run: (store: SessionStore, path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "manor-overview-revision-facts-"));
  const store = new SessionStore(join(directory, "index.sqlite"));
  try { await run(store, join(directory, "facts.sqlite")); }
  finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}
function history(store: SessionStore) {
  const a = revision(store, "main", [
    message("main", "user", 1, { occurredAt: "2026-03-07T23:30:00Z" }),
    message("main", "assistant", 2, { kind: "assistant", occurredAt: "2026-03-08T06:59:00Z" }),
    message("main", "call", 3, { kind: "tool_call", callId: "call-a", tool: "mcp__server-a__tool-a",
      occurredAt: "2026-03-08T07:01:00Z", resource: { kind: "mcp", name: "server-a", server: "server-a" } }),
    message("main", "result", 4, { kind: "tool_result", callId: "call-a", status: "failure", occurredAt: "2026-03-09T01:00:00Z" }),
    message("main", "body", 5, { kind: "user", status: "success", resource: { kind: "skill_read", name: "skill-a" } }),
    message("main", "unsuccessful-read", 6, { kind: "user", status: "failure", resource: { kind: "skill_read", name: "skill-b" } }),
    message("main", "copied", 7, { copied: true }),
    message("main", "context", 8, { contextSource: "system_injection" }),
    message("main", "missing", 9, { occurredAt: undefined }),
    message("main", "invalid", 10, { occurredAt: "2026-02-30T12:00:00Z" }),
    message("main", "no-zone", 11, { occurredAt: "2026-03-08T12:00:00" }),
    message("main", "unknown-resource", 12, { kind: "tool_call", resource: { kind: "mcp", name: "未记录名称" } }),
  ], [
    { id: "associated", occurredAt: "2026-03-08T07:01:00Z", messageId: "call", requestMessageIds: ["call", "assistant"], model: "model-a", inputTokens: 100, outputTokens: 50 },
    { id: "standalone", occurredAt: "2026-03-08T07:02:00Z", model: "model-b", inputTokens: 300, outputTokens: 200 },
    { id: "cross-day", occurredAt: "2026-03-09T07:02:00Z", messageId: "user", model: "model-a", inputTokens: 200, outputTokens: 20 },
    { id: "mirror", occurredAt: "2026-03-08T07:03:00Z", timing: { basis: "recorded", method: "zcode_request_span", completion: "explicit", end: { messageId: "call", source: "mirror", recordLine: 4 } } },
    { id: "missing-request", model: "model-c", inputTokens: 1 },
    { id: "copied-request", messageId: "copied", inputTokens: 999, outputTokens: 999 },
    { id: "copied-member", requestMessageIds: ["copied"], inputTokens: 999, outputTokens: 999 },
  ], { project: "/workspace/project-a", childSessionIds: ["child"] });
  const b = revision(store, "child", [message("child", "only-agent", 1, { kind: "assistant" })],
    [{ id: "child-request", occurredAt: "2026-03-07T12:00:00Z", inputTokens: 5, outputTokens: 5 }], { relationship: "child", parentSessionId: "main", project: "/workspace/project-a" });
  const c = revision(store, "fork", [message("fork", "own", 1), message("fork", "inherited", 2, { copied: true })], [],
    { relationship: "fork", project: "/workspace/project-b", client: "pi" });
  const version = store.publish(store.createJob().id, [a, b, c], []);
  return { a, b, c, version };
}
function normalizedActivity(activity: ReturnType<typeof buildOverviewReport>["activity"]) {
  return { ...activity, weekdayHours: [...activity.weekdayHours].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour) };
}

for (const timezone of ["UTC", "Asia/Shanghai", "America/New_York", "Pacific/Kiritimati"]) {
  test(`持久核心与旧完整聚合等价：${timezone} 的日期、复制、父子、未知及节奏`, async () => fixture(async (store, path) => {
    history(store); const facts = new OverviewFactStore(store, { path });
    try {
      const original = store.overviewSource();
      const queries: OverviewQuery[] = [
        { window: "all", timezone }, { window: "365", timezone },
        { from: "2026-03-08", to: "2026-03-08", window: "custom", timezone },
        { window: "365", timezone, clients: ["codex"], projects: ["/workspace/project-a"], models: ["model-a"] },
        { window: "7", timezone, clients: ["pi"] }, { window: "7", timezone, clients: ["unseen"] },
      ];
      for (const query of queries) {
        await facts.prepare(query, now);
        const expected = buildOverviewReport(original, { ...query, models: undefined }, pricing, now);
        const actual = facts.core(query, expected.usage, now);
        assert.deepEqual(value(actual.summary), value(expected.summary));
        assert.deepEqual(value(normalizedActivity(actual.activity)), value(normalizedActivity(expected.activity)));
        assert.deepEqual(value(actual.facets), value(expected.facets));
        assert.deepEqual(value(actual.coverage), value(expected.coverage));
        assert.deepEqual(facts.range(query, now), resolveOverviewRange(original, query, now));
      }
      assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally { facts.close(); }
  }));
}

test("分区窄事实保留调用跨日配对、调查成员原顺序及范围外请求序列边界", async () => fixture(async (store, path) => {
  history(store); const facts = new OverviewFactStore(store, { path });
  try {
    const query: OverviewQuery = { from: "2026-03-08", to: "2026-03-08", window: "custom", timezone: "UTC" };
    const selected = await facts.source(query, "process", now);
    assert.equal(selected.events.find(event => event.id === "call")!.status, "failure");
    assert.equal(selected.events.find(event => event.id === "call")!.resultMessageId, "result");
    assert(!selected.requests.some(request => request.usage.id === "cross-day"));
    const full = await facts.source(query, "requests", now, { fullSessions: true, sessionIds: ["main"] });
    assert(full.requests.some(request => request.usage.id === "cross-day"));
    assert(full.requests.some(request => request.usage.id === "missing-request"));
    assert(full.sessions.some(session => session.id === "child"));
    assert(full.requests.every(request => request.sessionId === "main"));
    assert(full.requests.every(request => request.usage.requestMessageIds === undefined));
    const months = await facts.source(query, "requests", now, { eventKinds: ["user", "assistant", "thinking", "tool_call", "tool_result", "compression"] });
    assert(months.events.some(event => event.id === "assistant"));
    assert.equal(months.resources.length, 0);
    assert(months.requests.every(request => request.usage.requestMessageIds === undefined));
    const evidence = await facts.source(query, "evidence", now);
    assert.deepEqual(evidence.requests.find(request => request.usage.id === "associated")!.usage.requestMessageIds, ["call", "assistant"]);
    assert.equal(evidence.requests.find(request => request.usage.id === "standalone")!.usage.requestMessageIds, undefined);
    assert(evidence.events.some(event => event.id === "result"));
    const original = store.overviewSource();
    assert.deepEqual(value(evidence.requests), value(original.requests));
    const expectedCalls = pairToolCalls(original.events.filter(isActivityEvent));
    assert.deepEqual(value(evidence.events.find(event => event.id === "call")), value(expectedCalls.find(event => event.id === "call")));
    assert(!JSON.stringify(evidence).includes("synthetic-private-body"));
    assert(evidence.events.every(event => !("text" in event) && !("arguments" in event)));
  } finally { facts.close(); }
}));

test("未完成准备不返回部分统计，按范围活动与全版本有日期身份分别保留", async () => fixture(async (store, path) => {
  history(store); const facts = new OverviewFactStore(store, { path });
  const query: OverviewQuery = { timezone: "UTC", clients: ["pi"] };
  try {
    const expected = buildOverviewReport(store.overviewSource(), query, pricing, now);
    assert.throws(() => facts.core(query, expected.usage, now), { code: "ANALYSIS_NOT_READY" });
    assert.throws(() => facts.range({ window: "all", timezone: "UTC" }, now), { code: "ANALYSIS_NOT_READY" });
    await facts.prepare(query, now);
    assert.deepEqual(facts.activitySessions(query, now).activeIds, ["fork"]);
    assert.deepEqual(new Set(facts.activitySessions(query, now).datedIds), new Set(["main", "child", "fork"]));
  } finally { facts.close(); }
}));

test("重启读取持久修订，新增版本只准备变化项，并且旧版关系独立", async () => fixture(async (store, path) => {
  const { a, b, c, version } = history(store);
  const first = new OverviewFactStore(store, { path }); await first.prepare({ timezone: "UTC" }, now); first.close();
  const prepare = store.overviewRevisionFacts.bind(store); const read: string[] = [];
  store.overviewRevisionFacts = (revision, id) => { read.push(revision); return prepare(revision, id); };
  const second = new OverviewFactStore(store, { path });
  try {
    await second.prepare({ timezone: "UTC" }, now); assert.deepEqual(read, []);
    const changed = revision(store, "main", [message("main", "new", 1)], []);
    const next = store.publish(store.createJob().id, [changed, b, c], []);
    await second.prepare({ timezone: "UTC" }, now);
    assert.deepEqual(read, [changed.revision]);
    assert.equal(second.snapshot({ version }).sessions.find(session => session.id === "child")!.parentSessionId, "main");
    assert.equal(second.snapshot({ version: next }).version, next);
    await second.prepare({ version, timezone: "UTC" }, now);
    assert.deepEqual(read, [changed.revision]);
    const database = new Database(store.dbPath); database.prepare("DELETE FROM session_versions WHERE id=?").run(version); database.close();
    assert.throws(() => second.snapshot({ version }), { code: "VERSION_NOT_FOUND" });
    await assert.rejects(second.prepare({ version, timezone: "UTC" }, now), { code: "VERSION_NOT_FOUND" });
    assert(read.includes(changed.revision)); assert(!read.includes(a.revision));
  } finally { second.close(); }
}));

test("缺失派生行与失效格式按修订原子重建，完整源版本仍决定结果", async () => fixture(async (store, path) => {
  const { a } = history(store); const first = new OverviewFactStore(store, { path }); await first.prepare({ timezone: "UTC" }, now); first.close();
  const database = new Database(path); database.prepare("DELETE FROM overview_fact_events WHERE revision=? AND id='user'").run(a.revision); database.close();
  const second = new OverviewFactStore(store, { path });
  try {
    await second.prepare({ timezone: "UTC" }, now);
    const report = buildOverviewReport(store.overviewSource(), { timezone: "UTC" }, pricing, now);
    assert.deepEqual(value(second.core({ timezone: "UTC" }, report.usage, now).summary), value(report.summary));
  } finally { second.close(); }
  const stale = new Database(path); stale.prepare("UPDATE overview_fact_revisions SET format=0 WHERE revision=?").run(a.revision); stale.close();
  const third = new OverviewFactStore(store, { path });
  try { await third.prepare({ timezone: "UTC" }, now); assert((await third.source({ timezone: "UTC" }, "evidence", now)).events.some(event => event.id === "user")); }
  finally { third.close(); }
}));

test("损坏JSON只重建该修订，损坏文件及不可写缓存明确失败且不回填整库内存", async () => fixture(async (store, path) => {
  history(store); let facts = new OverviewFactStore(store, { path }); await facts.prepare({ timezone: "UTC" }, now); facts.close();
  const malformed = new Database(path); malformed.prepare("UPDATE overview_fact_requests SET json='{' WHERE id='associated'").run(); malformed.close();
  facts = new OverviewFactStore(store, { path });
  const reads: string[] = [], original = store.overviewRevisionFacts.bind(store);
  store.overviewRevisionFacts = (revision, id) => { reads.push(revision); return original(revision, id); };
  try { assert((await facts.source({ timezone: "UTC" }, "evidence", now)).requests.some(request => request.usage.id === "associated")); }
  finally { facts.close(); }
  assert.equal(reads.length, 1);
  writeFileSync(path, "broken sqlite cache");
  assert.throws(() => new OverviewFactStore(store, { path }), { code: "ANALYSIS_NOT_READY" });
  const repaired = new OverviewFactStore(store, { path, repairCorruption: true });
  try { await repaired.prepare({ timezone: "UTC" }, now); assert.equal(repaired.activitySessions({ timezone: "UTC" }, now).activeIds.length, 3); }
  finally { repaired.close(); }
  assert.equal(readFileSync(`${path}.corrupt`, "utf8"), "broken sqlite cache");
  const blocked = join(path, "unwritable.sqlite");
  assert.throws(() => new OverviewFactStore(store, { path: blocked }), { code: "ANALYSIS_NOT_READY" });
  assert.equal(store.overviewSource().sessions.length, 3);
}));

test("超额时不serialize、不清共享事实；另一个读者及重启仍复用完整修订", async () => fixture(async (store, path) => {
  history(store); const first = new OverviewFactStore(store, { path }), limited = new OverviewFactStore(store, { path, maxBytes: 1 });
  await first.prepare({ timezone: "UTC" }, now);
  const report = buildOverviewReport(store.overviewSource(), { timezone: "UTC" }, pricing, now);
  const read = store.overviewRevisionFacts.bind(store); let reads = 0;
  store.overviewRevisionFacts = (revision, id) => { reads += 1; return read(revision, id); };
  const serialize = Database.prototype.serialize;
  Database.prototype.serialize = () => { throw new Error("禁止整库复制到内存"); };
  try {
    await assert.rejects(limited.prepare({ timezone: "UTC" }, now), { code: "ANALYSIS_NOT_READY" });
    await first.prepare({ timezone: "UTC" }, now);
    assert.deepEqual(value(first.core({ timezone: "UTC" }, report.usage, now).summary), value(report.summary));
    assert.equal(reads, 0);
    const restart = new OverviewFactStore(store, { path });
    try { await restart.prepare({ timezone: "UTC" }, now); assert.equal(reads, 0); }
    finally { restart.close(); }
    assert(statSync(path).size > 1);
  } finally { Database.prototype.serialize = serialize; limited.close(); first.close(); }
}));

test("有限日期保留资源无时间覆盖，SQL范围覆盖夏令时与严格本地日", async () => fixture(async (store, path) => {
  const entry = revision(store, "resource-time", [
    message("resource-time", "missing-resource", 1, { kind: "tool_call", occurredAt: undefined,
      resource: { kind: "mcp", name: "server-a", server: "server-a" } }),
    message("resource-time", "dst-before", 2, { occurredAt: "2026-03-08T04:59:59.999Z" }),
    message("resource-time", "dst-start", 3, { occurredAt: "2026-03-08T05:00:00Z" }),
    message("resource-time", "dst-end", 4, { occurredAt: "2026-03-09T03:59:59.999Z" }),
    message("resource-time", "dst-after", 5, { occurredAt: "2026-03-09T04:00:00Z" }),
  ], []);
  store.publish(store.createJob().id, [entry], []);
  const facts = new OverviewFactStore(store, { path });
  const query: OverviewQuery = { window: "custom", from: "2026-03-08", to: "2026-03-08", timezone: "America/New_York" };
  try {
    const resources = await facts.source(query, "resources", now);
    assert(resources.resources.some(row => row.id.includes("missing-resource")));
    const report = buildOverviewReport(resources, query, pricing, now);
    assert.equal(report.resources.missingTimeEvents, 1);
    assert.equal(report.resources.mcp.length, 0);
    const process = await facts.source(query, "process", now, { eventKinds: ["user"] });
    const bounds = facts.sqlScope(query, now).bounds!;
    assert.equal(bounds.toMs - bounds.fromMs, 23 * 3600000);
    const rows = facts.readRows<{ id: string }>(`SELECT id FROM overview_fact_events WHERE time_ms>=? AND time_ms<? ORDER BY ordinal`, [bounds.fromMs, bounds.toMs]);
    assert.deepEqual(rows.map(row => row.id), ["dst-start", "dst-end"]);
    assert(process.events.some(row => row.id === "dst-start"));
    assert.throws(() => facts.readRows("DELETE FROM overview_fact_events"), /只读/);
    const autumn: OverviewQuery = { window: "custom", from: "2026-11-01", to: "2026-11-01", timezone: "America/New_York" };
    const fall = facts.sqlScope(autumn, now).bounds!;
    assert.equal(fall.toMs - fall.fromMs, 25 * 3600000);
  } finally { facts.close(); }
}));

test("SQLite容量上限回滚新增修订，保留旧版完整事实和并存读者", async () => fixture(async (store, path) => {
  const { a, b, c, version } = history(store);
  const writer = new OverviewFactStore(store, { path, maxBytes: 128 * 1024 });
  await writer.prepare({ timezone: "UTC" }, now);
  const reader = new OverviewFactStore(store, { path });
  const original = buildOverviewReport(store.overviewSource(version), { version, timezone: "UTC" }, pricing, now);
  try {
    const large = revision(store, "large-new", Array.from({ length: 2000 }, (_, ordinal) => message("large-new", `synthetic-event-${ordinal}`.padEnd(80, "e"), ordinal)), []);
    const next = store.publish(store.createJob().id, [a, b, c, large], []);
    await assert.rejects(writer.prepare({ version: next, timezone: "UTC" }, now), error =>
      !!error && typeof error === "object" && "messageDescriptor" in error
        && (error.messageDescriptor as { key?: string })?.key === "diagnostics.overview.cacheCapacity");
    assert(statSync(path).size <= 128 * 1024);
    assert.equal(writer.readRows<{ count: number }>("SELECT COUNT(*) count FROM overview_fact_revisions WHERE revision=?", [large.revision])[0]!.count, 0);
    await reader.prepare({ version, timezone: "UTC" }, now);
    assert.deepEqual(value(reader.core({ version, timezone: "UTC" }, original.usage, now).summary), value(original.summary));
  } finally { reader.close(); writer.close(); }
}));

test("读lane不回填或裁剪派生库，原请求成员只按当前页身份恢复", async () => fixture(async (store, path) => {
  history(store); const writer = new OverviewFactStore(store, { path });
  await writer.prepare({ timezone: "UTC" }, now); writer.close();
  const reader = new OverviewFactStore(store, { path, readonly: true });
  const revisionRead = store.overviewRevisionFacts.bind(store), memberRead = store.overviewRequestMembers.bind(store);
  const requested: (string[] | undefined)[] = [];
  store.overviewRevisionFacts = () => { throw new Error("读lane不得回填原事实"); };
  store.overviewRequestMembers = (revision, ids) => { requested.push(ids); return memberRead(revision, ids); };
  try {
    const source = await reader.source({ timezone: "UTC" }, "process", now, { prepared: true });
    assert(source.events.some(event => event.id === "call"));
    assert.equal(requested.length, 0);
    await assert.rejects(reader.prepare({ timezone: "UTC" }, now), { code: "ANALYSIS_NOT_READY" });
    const rows = reader.readRows<Parameters<OverviewFactStore["decodeRequest"]>[0]>(`SELECT f.*,r.session_id FROM overview_fact_requests f
      JOIN overview_fact_revisions r ON r.revision=f.revision WHERE f.id='associated'`);
    const hydrated = reader.hydrateRequestMembers(rows);
    assert.deepEqual(hydrated[0]!.usage.requestMessageIds, ["call", "assistant"]);
    assert.deepEqual(requested, [["associated"]]);
    const database = new Database(path);
    try { database.prepare("UPDATE overview_fact_events SET json='{' WHERE id='call'").run(); } finally { database.close(); }
    await assert.rejects(reader.source({ timezone: "UTC" }, "process", now, { prepared: true }), { code: "ANALYSIS_NOT_READY" });
    assert.equal(reader.readRows<{ count: number }>("SELECT COUNT(*) count FROM overview_fact_revisions")[0]!.count, 3);
  } finally { reader.close(); store.overviewRevisionFacts = revisionRead; store.overviewRequestMembers = memberRead; }
}));

test("两个跨线程缓存读者并发首次准备，不覆盖完整修订或产生时间桶主键冲突", async () => fixture(async (store, path) => {
  history(store);
  const code = `const { parentPort,workerData }=require('node:worker_threads');
    (async()=>{const {register}=await import('tsx/esm/api');register(); const {SessionStore}=await import(workerData.store); const {OverviewFactStore}=await import(workerData.facts);
      const sessions=new SessionStore(workerData.index),facts=new OverviewFactStore(sessions,{path:workerData.path});
      parentPort.postMessage({ready:true}); parentPort.once('message',async()=>{try{await facts.prepare({timezone:'UTC'},new Date('2026-03-09T12:00:00Z'));
        parentPort.postMessage({version:facts.snapshot().version,ids:facts.activitySessions({timezone:'UTC'},new Date('2026-03-09T12:00:00Z')).activeIds});
      }catch(error){parentPort.postMessage({error:String(error)})}finally{facts.close();sessions.close()}});
    })().catch(error=>parentPort.postMessage({error:String(error)}));`;
  const workers = Array.from({ length: 2 }, () => new Worker(code, { eval: true, workerData: {
    store: new URL("../src/sessions/store.ts", import.meta.url).href, facts: new URL("../src/overview/facts.ts", import.meta.url).href,
    index: store.dbPath, path } }));
  try {
    await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => {
      worker.once("error", reject); worker.once("message", result => result.ready ? resolve() : reject(new Error(result.error)));
    })));
    const results = workers.map(worker => new Promise<{ version: string; ids: string[] }>((resolve, reject) => {
      worker.once("error", reject); worker.once("message", result => result.error ? reject(new Error(result.error)) : resolve(result));
    }));
    for (const worker of workers) worker.postMessage({ start: true });
    const [a, b] = await Promise.all(results); assert.deepEqual(a, b); assert.equal(a!.ids.length, 3);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
}));
