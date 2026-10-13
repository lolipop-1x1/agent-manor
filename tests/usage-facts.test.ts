import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { SessionMessage, SessionSourceMeta, SessionUsage } from "../src/session-contracts.js";
import { SessionStore, type SessionRevision } from "../src/sessions/store.js";
import { USAGE_FACT_FORMAT_VERSION } from "../src/sessions/usage-facts.js";
import { requestSpeed } from "../src/session-speed.js";

async function fixture(run: (store: SessionStore, path: string) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "manor-usage-facts-"));
  const path = join(directory, "index.sqlite");
  const store = new SessionStore(path);
  try { await run(store, path); }
  finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

function meta(id: string, extra: Partial<SessionSourceMeta> = {}): SessionSourceMeta {
  return { id, client: "codex", clientSessionId: id, title: "人工合成用量会话", titleOrigin: "recorded",
    path: `/workspace/history/${id}.jsonl`, sourceId: `codex:${id}`, messageCount: 0, turnCount: 0, models: [], gaps: [], ...extra };
}

function add(store: SessionStore, summary: SessionSourceMeta, usages: SessionUsage[], messages: Partial<SessionMessage>[] = []): SessionRevision {
  const pending = store.createRevision(summary.path, "synthetic-fingerprint");
  for (const [ordinal, value] of messages.entries()) pending.sink.message({ id: `message-${ordinal}`, sessionId: summary.id,
    ordinal, recordLine: ordinal + 1, turnId: "turn", kind: "assistant", text: "合成正文", ...value });
  for (const usage of usages) pending.sink.usage(usage);
  pending.flush(); store.finishRevision(pending.revision, summary);
  return { path: summary.path, revision: pending.revision, fingerprint: "synthetic-fingerprint" };
}

function compact(usage: SessionUsage): SessionUsage {
  const { messageId: _message, turnId: _turn, requestMessageIds: _members, timing: _timing, ...facts } = usage;
  return facts;
}

test("修订完成时生成结构化事实，缺失、零、原始时间与请求顺序保持不变", async () => fixture((store, path) => {
  const values: SessionUsage[] = [
    { id: "z-zero", model: "synthetic-model", provider: "example-provider", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0,
      reasoningOutputTokens: 0, contextTokens: 0, occurredAt: "2026-01-01T08:00:00+08:00", messageId: "message-0", turnId: "turn",
      requestMessageIds: ["message-0"], timing: { basis: "recorded", method: "claude_message_boundary", completion: "explicit", durationMs: 10 } },
    { id: "a-missing" }, { id: "invalid-time", occurredAt: "invalid", model: "", inputTokens: 12, outputTokens: 3 },
  ];
  const revision = add(store, meta("facts"), values, [{}]);
  store.publish(store.createJob().id, [revision], []);
  assert.deepEqual(store.usageFacts(revision.revision), values.map(compact));
  assert.deepEqual(store.usageFacts(revision.revision), store.usageSource().requests.map(row => compact(row.usage)));
  const database = new Database(path, { readonly: true });
  try {
    const rows = database.prepare("SELECT id,time_ms,input_tokens,eligible FROM session_usage_facts ORDER BY ordinal").all() as
      { id: string; time_ms: number | null; input_tokens: number | null; eligible: number }[];
    assert.deepEqual(rows.map(row => [row.id, row.time_ms, row.input_tokens, row.eligible]), [
      ["z-zero", Date.parse(values[0]!.occurredAt!), 0, 1], ["a-missing", null, null, 1], ["invalid-time", null, 12, 1],
    ]);
    assert.equal(database.pragma("user_version", { simple: true }), 4);
  } finally { database.close(); }
}));

test("事实复制判定与旧路径一致，保留直接身份优先、消息数组、结束边界与同轮兜底", async () => fixture((store, path) => {
  const values: SessionUsage[] = [
    { id: "copied-direct", messageId: "message-0" },
    { id: "copied-members", requestMessageIds: ["message-1", "message-0"] },
    { id: "copied-end", requestMessageIds: ["message-1"], timing: { basis: "recorded", method: "claude_message_boundary",
      completion: "explicit", end: { messageId: "message-0" } } },
    { id: "copied-turn", turnId: "turn" }, { id: "copied-empty", turnId: "turn", requestMessageIds: [] },
    { id: "direct-priority", messageId: "message-1", requestMessageIds: ["message-0"], turnId: "turn" },
    { id: "missing-direct", messageId: "not-recorded", turnId: "turn" },
    { id: "unknown-member", requestMessageIds: ["not-recorded"], turnId: "turn" },
    { id: "unknown-turn" }, { id: "clean-turn", turnId: "clean" },
  ].map((usage, index) => ({ inputTokens: index, ...usage }));
  const revision = add(store, meta("copied"), values, [{ copied: true }, { copied: false }, { turnId: "clean" }]);
  store.publish(store.createJob().id, [revision], []);
  assert.deepEqual(store.usageFacts(revision.revision), store.usageSource().requests.map(row => compact(row.usage)));
  assert.deepEqual(store.usageFacts(revision.revision).map(row => row.id), ["direct-priority", "missing-direct", "unknown-member", "unknown-turn", "clean-turn"]);
  const database = new Database(path, { readonly: true });
  try {
    const count = database.prepare("SELECT COUNT(*) AS total,SUM(eligible) AS accepted FROM session_usage_facts").get() as { total: number; accepted: number };
    assert.deepEqual(count, { total: values.length, accepted: 5 });
  } finally { database.close(); }
}));

test("事实会话身份、标题与父子关系绑定完整发布版本，不逐会话读取画像", async () => fixture(store => {
  assert.throws(() => store.usageFactSessions(), /尚未完成/);
  const parent = add(store, meta("parent", { childSessionIds: ["child"], titleOrigin: "fallback", title: "" }), [{ id: "parent-use" }]);
  const child = add(store, meta("child", { titleOrigin: "fallback", taskName: "合成子任务", project: "/workspace/project" }), [{ id: "child-use" }]);
  const first = store.publish(store.createJob().id, [parent, child], []);
  add(store, meta("unpublished"), [{ id: "unpublished-use" }]);
  store.profile = () => { throw new Error("事实列表不读取画像"); };
  assert.deepEqual(store.usageFactSessions(first).sessions.map(row => row.session), store.usageSource(first).sessions);
  assert.deepEqual(store.usageFactSessions(first).sessions.map(row => row.revision), [child.revision, parent.revision]);
  const next = store.publish(store.createJob().id, [parent], []);
  assert.equal(store.usageFactSessions(next).sessions.length, 1);
  assert.equal(store.usageFactSessions(first).sessions.length, 2);
  assert.throws(() => store.usageFactSessions("missing-version"), /不存在/);
}));

test("轻量版本校验和目标摘要与完整列表一致，覆盖多级子会话和分叉父标题", async () => fixture(store => {
  assert.throws(() => store.usageVersion(), /尚未完成/);
  const grandparent = add(store, meta("grandparent", { childSessionIds: ["parent"] }), []);
  const parent = add(store, meta("parent", { childSessionIds: ["child"], title: "", titleOrigin: "fallback" }), []);
  const child = add(store, meta("child", { title: "", titleOrigin: "fallback" }), []);
  const fork = add(store, meta("fork", { parentSessionId: "parent", relationship: "fork" }), []);
  const version = store.publish(store.createJob().id, [grandparent, parent, child, fork], []);
  assert.equal(store.usageVersion(), version);
  for (const expected of store.usageFactSessions(version).sessions) {
    assert.deepEqual(store.usageFactSession(version, expected.session.id), expected);
  }
  assert.equal(store.usageFactSession(version, "missing-session"), undefined);
  assert.throws(() => store.usageVersion("missing-version"), /不存在/);
  assert.throws(() => store.usageFactSession("missing-version", "child"), /不存在/);
}));

test("旧索引只创建派生表，旧修订按需一次补齐，重启和格式更新保留原始历史", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-usage-facts-upgrade-"));
  const path = join(directory, "index.sqlite");
  let store = new SessionStore(path);
  try {
    const revision = add(store, meta("legacy"), [{ id: "usage", inputTokens: 5 }]);
    const empty = add(store, meta("empty"), []);
    store.publish(store.createJob().id, [revision, empty], []);
    store.close();
    const old = new Database(path);
    old.exec("DROP TABLE session_usage_facts; DROP TABLE session_usage_fact_revisions;");
    old.close();
    store = new SessionStore(path);
    const inspect = new Database(path);
    try {
      assert.equal((inspect.prepare("SELECT COUNT(*) AS count FROM session_usage_fact_revisions").get() as { count: number }).count, 0);
      assert.throws(() => store.usageFacts(revision.revision), /尚未完成/);
      store.ensureUsageFacts(revision.revision);
      const before = inspect.prepare("SELECT rowid,* FROM session_usage_facts").all();
      store.ensureUsageFacts(revision.revision);
      assert.deepEqual(inspect.prepare("SELECT rowid,* FROM session_usage_facts").all(), before);
      assert.deepEqual(store.usageFacts(revision.revision), [{ id: "usage", inputTokens: 5 }]);
      assert.throws(() => store.usageFacts(empty.revision), /尚未完成/);
      store.ensureUsageFacts(empty.revision);
      assert.deepEqual(store.usageFacts(empty.revision), []);
      inspect.prepare("UPDATE session_usage_fact_revisions SET format_version=0 WHERE revision=?").run(revision.revision);
      inspect.prepare("UPDATE session_usage_facts SET input_tokens=999 WHERE revision=?").run(revision.revision);
      store.ensureUsageFacts(revision.revision);
      assert.deepEqual(store.usageFacts(revision.revision), [{ id: "usage", inputTokens: 5 }]);
      assert.equal((inspect.prepare("SELECT COUNT(*) AS count FROM session_usage").get() as { count: number }).count, 1);
    } finally { inspect.close(); }
    store.close(); store = new SessionStore(path);
    assert.deepEqual(store.usageFacts(revision.revision), [{ id: "usage", inputTokens: 5 }]);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("变化修订不污染前一版本，页内证据只从指定版本与会话取原始请求", async () => fixture(store => {
  const firstValue: SessionUsage = { id: "same-id", inputTokens: 1, messageId: "message-0", requestMessageIds: ["message-0"],
    timing: { basis: "recorded", method: "claude_message_boundary", completion: "explicit", durationMs: 5 } };
  const first = add(store, meta("changed"), [firstValue, { id: "extra", outputTokens: 2 }], [{}]);
  const other = add(store, meta("other"), [{ id: "same-id", inputTokens: 99 }]);
  const version = store.publish(store.createJob().id, [first, other], []);
  const secondValue = { ...firstValue, inputTokens: 3 };
  const second = add(store, meta("changed"), [secondValue], [{}]);
  const next = store.publish(store.createJob().id, [second, other], []);
  assert.deepEqual(store.usageFacts(first.revision), [compact(firstValue), { id: "extra", outputTokens: 2 }]);
  assert.deepEqual(store.usageFacts(second.revision), [compact(secondValue)]);
  assert.deepEqual(store.usageEvidence(version, "changed", ["extra", "same-id", "missing"]), [{ id: "extra", outputTokens: 2 }, firstValue]);
  assert.deepEqual(store.usageEvidence(next, "changed", ["same-id"]), [secondValue]);
  assert.deepEqual(store.usageEvidence(next, "changed", []), []);
  assert.throws(() => store.usageEvidence("missing-version", "changed", []), /不存在/);
  assert.throws(() => store.usageEvidence(version, "missing-session", []), /不存在/);
}));

test("事实与准备标识随修订级联删除，失败事务不遗留部分结果", async () => fixture((store, path) => {
  const revision = add(store, meta("remove"), [{ id: "usage", inputTokens: 4 }]);
  const database = new Database(path);
  try {
    database.exec("PRAGMA foreign_keys=ON");
    database.prepare("DELETE FROM session_usage_fact_revisions WHERE revision=?").run(revision.revision);
    database.prepare("DELETE FROM session_usage_facts WHERE revision=?").run(revision.revision);
    database.exec("CREATE TRIGGER reject_usage_facts BEFORE INSERT ON session_usage_facts BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    assert.throws(() => store.ensureUsageFacts(revision.revision), /synthetic failure/);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM session_usage_fact_revisions").get() as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM session_usage_facts").get() as { count: number }).count, 0);
    database.exec("DROP TRIGGER reject_usage_facts");
    store.ensureUsageFacts(revision.revision);
    store.removeRevision(revision.revision);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM session_usage_fact_revisions").get() as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM session_usage_facts").get() as { count: number }).count, 0);
    assert.throws(() => store.ensureUsageFacts(revision.revision), /不存在/);
    assert.throws(() => store.usageFacts(revision.revision), /不存在/);
  } finally { database.close(); }
}));

test("事实时间严格沿用统计解析，批量元数据覆盖缺时间、复制排除和原始unknown维度", async () => fixture((store, path) => {
  const revision = add(store, meta("metadata"), [
    { id: "first", model: "unknown", occurredAt: "2026-01-01T00:00:00+14:00" },
    { id: "last", model: "literal:unknown", occurredAt: "2026-01-02T23:00:00-12:00" },
    { id: "no-model", occurredAt: "2026-01-01" },
    { id: "no-zone", occurredAt: "2026-01-01T12:00:00" },
    { id: "bad-calendar", occurredAt: "2026-02-30T12:00:00Z" },
    { id: "invalid", occurredAt: "invalid" },
    { id: "copied", model: "excluded-model", occurredAt: "2099-01-01T00:00:00Z", messageId: "message-0" },
  ], [{ copied: true }]);
  const empty = add(store, meta("empty-metadata"), []);
  const values = store.usageFactMetadata([revision.revision, empty.revision, revision.revision]);
  assert.deepEqual(values, [{ revision: revision.revision, hasUsage: true, undatedCount: 4,
    minTime: Date.parse("2026-01-01T00:00:00+14:00"), maxTime: Date.parse("2026-01-02T23:00:00-12:00"),
    models: ["literal:literal:unknown", "literal:unknown", "unknown"] },
  { revision: empty.revision, hasUsage: false, undatedCount: 0, models: [] }]);
  assert.deepEqual(store.usageFactMetadata([]), []);
  const database = new Database(path);
  try {
    const missing = database.prepare("SELECT id FROM session_usage_facts WHERE time_ms IS NULL ORDER BY ordinal").all() as { id: string }[];
    assert.deepEqual(missing.map(row => row.id), ["no-model", "no-zone", "bad-calendar", "invalid"]);
    database.prepare("UPDATE session_usage_fact_revisions SET format_version=? WHERE revision=?")
      .run(USAGE_FACT_FORMAT_VERSION - 1, revision.revision);
    assert.throws(() => store.usageFactMetadata([revision.revision]), /尚未完成/);
    store.ensureUsageFacts(revision.revision);
    assert.deepEqual(store.usageFactMetadata([revision.revision])[0], values[0]);
  } finally { database.close(); }
}));

test("事实补齐批次只提交一次，任一修订失败回滚整批且原始请求不变", async () => fixture((store, path) => {
  const first = add(store, meta("batch-first"), [{ id: "first", inputTokens: 5 }]);
  const second = add(store, meta("batch-second"), [{ id: "second", outputTokens: 6 }]);
  const database = new Database(path);
  try {
    database.exec("DELETE FROM session_usage_fact_revisions");
    database.exec("UPDATE session_usage_facts SET input_tokens=999");
    const before = database.prepare("SELECT * FROM session_usage_facts ORDER BY revision,ordinal").all();
    const raw = database.prepare("SELECT id,json FROM session_usage ORDER BY id").all();
    database.exec("CREATE TRIGGER reject_second_batch_fact BEFORE INSERT ON session_usage_facts WHEN NEW.id='second' BEGIN SELECT RAISE(ABORT,'synthetic batch failure'); END");
    assert.throws(() => store.ensureUsageFactsBatch([first.revision, second.revision]), /synthetic batch failure/);
    assert.deepEqual(database.prepare("SELECT * FROM session_usage_facts ORDER BY revision,ordinal").all(), before);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM session_usage_fact_revisions").get() as { count: number }).count, 0);
    assert.deepEqual(database.prepare("SELECT id,json FROM session_usage ORDER BY id").all(), raw);
    database.exec("DROP TRIGGER reject_second_batch_fact");
    store.ensureUsageFactsBatch([first.revision, second.revision, first.revision]);
    assert.deepEqual(store.usageFacts(first.revision), [{ id: "first", inputTokens: 5 }]);
    assert.deepEqual(store.usageFacts(second.revision), [{ id: "second", outputTokens: 6 }]);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM session_usage_fact_revisions").get() as { count: number }).count, 2);
    assert.deepEqual(database.prepare("SELECT id,json FROM session_usage ORDER BY id").all(), raw);
    store.ensureUsageFactsBatch([]);
  } finally { database.close(); }
}));

test("速度事实按需保留判定所需计时，格式回填不触碰原始证据与复制排除", async () => fixture((store, path) => {
  const values: SessionUsage[] = [
    { id: "eligible", messageId: "message-0", model: "model-a", outputTokens: 900, timing: {
      basis: "recorded", window: "generation", method: "opencode_message_span", completion: "explicit", durationMs: 2000,
      outputTokens: 400, start: { recordLine: 1, occurredAt: "2026-01-01T00:00:00Z", messageId: "message-0" },
      end: { recordLine: 2, occurredAt: "2026-01-01T00:00:02Z", messageId: "message-0" },
      firstToken: { recordLine: 1, occurredAt: "2026-01-01T00:00:00Z" }, completionEvidence: "stream_finish",
    } },
    { id: "invalid-boundary", outputTokens: 400, timing: { basis: "estimated", method: "codex_event_boundary",
      completion: "inferred", durationMs: 2000, start: { recordLine: 3, occurredAt: "invalid" } } },
    { id: "copied", messageId: "message-1", outputTokens: 400, timing: { basis: "recorded", method: "claude_message_boundary",
      completion: "explicit", durationMs: 1000 } },
    { id: "missing-group", outputTokens: 400, timing: { completion: "explicit", durationMs: 1000 } as SessionUsage["timing"] },
    { id: "zero-output", outputTokens: 400, timing: { basis: "recorded", method: "claude_message_boundary",
      completion: "explicit", durationMs: 1000, outputTokens: 0 } },
  ];
  const revision = add(store, meta("timing-projection"), values, [{}, { copied: true }]);
  store.publish(store.createJob().id, [revision], []);
  const plain = store.usageFacts(revision.revision);
  assert.ok(plain.every(value => value.timing === undefined));
  const projected = store.usageFacts(revision.revision, true);
  assert.deepEqual(projected.map(value => value.id), ["eligible", "invalid-boundary", "missing-group", "zero-output"]);
  assert.deepEqual(projected[0]!.timing, { basis: "recorded", window: "generation", method: "opencode_message_span",
    completion: "explicit", durationMs: 2000, outputTokens: 400,
    start: { recordLine: 1, occurredAt: "2026-01-01T00:00:00Z" }, end: { recordLine: 2, occurredAt: "2026-01-01T00:00:02Z" } });
  assert.equal(projected[1]!.timing!.start!.occurredAt, "invalid");
  assert.deepEqual(projected.map(value => requestSpeed(value)), values.filter(value => value.id !== "copied").map(value => requestSpeed(value)));
  assert.equal(projected[3]!.timing!.outputTokens, 0, "计时输出为零不能回退为用量输出");
  const database = new Database(path);
  try {
    const original = database.prepare("SELECT json FROM session_usage ORDER BY rowid").all();
    database.prepare("UPDATE session_usage_fact_revisions SET format_version=?").run(USAGE_FACT_FORMAT_VERSION - 1);
    database.prepare("UPDATE session_usage_facts SET timing_duration_ms=NULL,timing_basis=NULL").run();
    assert.throws(() => store.usageFacts(revision.revision, true), /尚未完成/);
    store.ensureUsageFacts(revision.revision);
    assert.deepEqual(store.usageFacts(revision.revision, true), projected);
    assert.deepEqual(database.prepare("SELECT json FROM session_usage ORDER BY rowid").all(), original);
  } finally { database.close(); }
}));
