import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import test from "node:test";
import Database from "better-sqlite3";
import type { SessionMessage, SessionSourceMeta, SessionUsage } from "../src/session-contracts.js";
import { AnalysisStore, StoreError } from "../src/index/store.js";
import { SessionStore } from "../src/sessions/store.js";
import { refreshSessions } from "../src/sessions/refresh.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

async function fixture(run: (store: SessionStore, path: string) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "manor-session-store-"));
  const path = join(directory, "index.sqlite");
  const mapStore = new AnalysisStore(path);
  mapStore.close();
  const store = new SessionStore(path);
  try { await run(store, path); }
  finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

test("活动日志追加只索引固定前缀，已有内容改写拒绝发布且保留前版", async () => fixture(async (store, dbPath) => {
  const sourcePath = join(dbPath, "..", "active.jsonl");
  const encode = (value: unknown) => `${JSON.stringify(value)}\n`;
  const user = (id: string, text: string) => ({ type: "response_item", payload: { type: "message", id, role: "user", content: [{ type: "input_text", text }] } });
  const initial = encode({ type: "session_meta", payload: { id: "active-demo" } }) + encode(user("first", "第一个问题"));
  await writeFile(sourcePath, initial);
  const original = store.createRevision.bind(store);
  let changed = false;
  store.createRevision = (path, fingerprint) => {
    const pending = original(path, fingerprint);
    return { ...pending, sink: { usage: pending.sink.usage, message: value => {
      pending.sink.message(value);
      if (!changed) {
        changed = true;
        appendFileSync(sourcePath, encode(user("second", "第二个问题")));
      }
    } } };
  };
  const roots = isolatedHistoryRoots({ codex: join(dbPath, "..") });
  const first = store.createJob();
  await refreshSessions(store, first.id, roots);
  const id = store.list().sessions[0]!.id;
  assert.equal(store.messages(id).total, 1);
  store.createRevision = original;
  const second = store.createJob();
  await refreshSessions(store, second.id, roots);
  assert.equal(store.messages(id).total, 2);
  const version = store.status().version;
  changed = false;
  // 强制重建才会进入 sink；此时同步改写用于确定性复现校验失败。
  const wrapping = store.createRevision;
  store.createRevision = (path, fingerprint) => {
    const pending = wrapping(path, fingerprint);
    return { ...pending, sink: { usage: pending.sink.usage, message: value => {
      pending.sink.message(value);
      if (!changed) { changed = true; writeFileSync(sourcePath, initial.replace("第一个问题", "改写的问题")); }
    } } };
  };
  const third = store.createJob();
  await assert.rejects(refreshSessions(store, third.id, roots, true));
  assert.equal(store.status().version, version);
  assert.equal(store.status().stale, true);
}));

function meta(id: string, extra: Partial<SessionSourceMeta> = {}): SessionSourceMeta {
  return { id, client: "codex", clientSessionId: id, title: "人工合成会话", titleOrigin: "recorded", path: `/workspace/history/${id}.jsonl`, sourceId: `codex:${id}`,
    messageCount: 0, turnCount: 0, models: [], gaps: [], startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", ...extra };
}
function message(id: string, ordinal: number, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { id: `message-${ordinal}`, sessionId: id, ordinal, recordLine: ordinal + 1, turnId: "turn-1", kind: "user", text: "合成正文", ...extra };
}
function source(store: SessionStore, summary: SessionSourceMeta, messages: SessionMessage[], usages: SessionUsage[] = []) {
  const pending = store.createRevision(summary.path, "synthetic-fingerprint");
  for (const value of messages) pending.sink.message(value);
  for (const value of usages) pending.sink.usage(value);
  pending.flush();
  store.finishRevision(pending.revision, summary);
  return { path: summary.path, revision: pending.revision, fingerprint: "synthetic-fingerprint" };
}

test("轻量状态保留数量与任务，缺口按版本读取且发布后不返回旧状态", async () => fixture(store => {
  assert.equal(store.statusSummary().gapCount, 0);
  assert.equal(store.currentVersion(), undefined);
  const revisions = [source(store, meta("summary-session"), [])];
  const first = store.publish(store.createJob().id, revisions, [{ kind: "parse", message: "合成解析缺口", count: 2 }]);
  const { gaps, ...fields } = store.status();
  assert.deepEqual(store.statusSummary(), { ...fields, gapCount: gaps.length });
  assert.deepEqual(store.indexGaps(first), { version: first, gaps });
  const second = store.publish(store.createJob().id, revisions, []);
  assert.equal(store.currentVersion(), second);
  assert.equal(store.statusSummary().version, second);
  assert.equal(store.statusSummary().gapCount, 0);
  assert.deepEqual(store.indexGaps(first).gaps, gaps);
  assert.deepEqual(store.indexGaps(second).gaps, []);
  assert.throws(() => store.indexGaps("missing-version"), /不存在/);
}));

test("紧凑消息从 SQL 完整读回，复制缺省、false 与 true 保持各自含义", async () => fixture((store, path) => {
  const id = "compact-message";
  const records = [
    message(id, 1, { text: "真实用户请求", branchIds: ["branch-a", "branch-b"], currentBranch: true }),
    message(id, 2, { kind: "thinking", text: "思考正文", copied: false, model: "synthetic-model", currentBranch: false }),
    message(id, 3, { kind: "context", text: "上下文正文", copied: true, contextSource: "agents_md", contextEvidence: "wrapper" }),
    message(id, 4, { kind: "tool_call", text: '{"path":"/synthetic/SKILL.md"}', callId: "call-a", tool: "Read", status: "success", durationMs: 0,
      filePaths: ["/synthetic/SKILL.md"], resource: { kind: "skill_read", name: "fixture-skill", path: "/synthetic/SKILL.md" } }),
    message(id, 5, { kind: "tool_result", text: "工具结果正文", callId: "call-a", status: "success" }),
    message(id, 6, { kind: "compression", text: "压缩摘要", turnId: "" }),
    message(id, 7, { kind: "assistant", text: "最终回答", final: "explicit", occurredAt: "2026-01-01T00:00:01Z" }),
  ];
  store.publish(store.createJob().id, [source(store, meta(id), records)], []);
  assert.deepEqual(store.messages(id, { mode: "full", branch: "all" }).messages, records);
  const profile = store.profile(id);
  assert.equal(profile.messageCount, 6);
  assert.equal(profile.compressions, 1);
  assert.equal(profile.resources[0]?.count, 1);
  assert.equal([...store.resourceEvents().events][0]?.status, "success");
  assert.equal(store.timeline(id).events[3]?.callId, "call-a");
  assert.equal(store.search({ q: "工具结果正文", kinds: ["tool_result"] }).hits[0]?.messageId, records[4]?.id);
  const database = new Database(path);
  try {
    const rows = database.prepare("SELECT json,copied FROM session_messages ORDER BY ordinal").all() as { json: string; copied: number | null }[];
    for (const row of rows) {
      const metadata = JSON.parse(row.json) as object;
      for (const key of ["id", "ordinal", "recordLine", "turnId", "kind", "final", "callId", "copied", "text"]) assert.ok(!(key in metadata), key);
    }
    assert.deepEqual(rows.slice(0, 3).map(row => row.copied), [null, 0, 1]);
  } finally { database.close(); }
}));

test("显式消息键在更新、删除空洞、重新插入和 VACUUM 后保持搜索关联", async () => fixture((store, path) => {
  const id = "stable-search-key";
  const pending = store.createRevision("/synthetic/stable.jsonl", "fixture");
  pending.sink.message(message(id, 1, { text: "准备删除词" }));
  pending.sink.message(message(id, 2, { text: "保留搜索词" }));
  pending.flush();
  const database = new Database(path);
  try {
    const key = () => (database.prepare("SELECT message_key AS key FROM session_messages WHERE id='message-2'").get() as { key: number }).key;
    const original = key();
    pending.sink.message(message(id, 2, { text: "更新搜索词" }));
    pending.flush();
    assert.equal(key(), original);
    database.prepare("DELETE FROM session_messages WHERE id='message-1'").run();
    pending.sink.message(message(id, 3, { text: "新增搜索词" }));
    pending.flush();
    store.finishRevision(pending.revision, meta(id));
    store.publish(store.createJob().id, [{ path: "/synthetic/stable.jsonl", revision: pending.revision, fingerprint: "fixture" }], []);
    const before = store.search({ q: "更新搜索词" });
    database.exec("VACUUM");
    assert.equal(key(), original);
    assert.deepEqual(store.search({ q: "更新搜索词" }), before);
    assert.equal(store.search({ q: "准备删除词" }).total, 0);
    assert.equal(store.search({ q: "新增搜索词" }).total, 1);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM session_message_search s LEFT JOIN session_messages m ON m.message_key=s.rowid WHERE m.message_key IS NULL").get() as { count: number }).count, 0);
  } finally { database.close(); }
}));

test("独立会话新库和地图共用新版本初始化，旧版本不修改", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-new-schema-"));
  try {
    const path = join(directory, "index.sqlite");
    const sessions = new SessionStore(path);
    sessions.close();
    const maps = new AnalysisStore(path);
    assert.deepEqual(maps.listRepositories(), []);
    maps.close();
    const oldPath = join(directory, "old.sqlite");
    const database = new Database(oldPath);
    database.pragma("user_version = 3");
    assert.throws(() => new SessionStore(oldPath), /不支持的索引版本/);
    assert.equal(database.pragma("user_version", { simple: true }), 3);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='session_messages'").get() as { count: number }).count, 0);
    database.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("缺失 Skill 来源持久化并贯通画像与资源事件，真实同名独立保留", async () => fixture(store => {
  const id = "resource-provenance";
  const descriptor = { key: "sessions.resource.nameUnrecorded" };
  const records = [message(id, 1, { kind: "tool_call", tool: "Skill", resource: { kind: "skill_call", name: "未记录名称", nameDescriptor: descriptor } }),
    message(id, 2, { kind: "tool_call", tool: "Skill", resource: { kind: "skill_call", name: "未记录名称" } })];
  store.publish(store.createJob().id, [source(store, meta(id), records)], []);
  const read = store.messages(id, { mode: "full" }).messages;
  assert.deepEqual(read[0]?.resource?.nameDescriptor, descriptor);
  assert.equal(read[1]?.resource?.nameDescriptor, undefined);
  const profile = store.profile(id);
  assert.equal(profile.resources.length, 2);
  assert.ok(profile.resources.every(resource => resource.name === "未记录名称" && resource.count === 1));
  assert.equal(profile.resources.filter(resource => resource.nameDescriptor).length, 1);
  const events = [...store.resourceEvents().events];
  assert.deepEqual(events[0]?.nameDescriptor, descriptor);
  assert.equal(events[1]?.nameDescriptor, undefined);
  assert.equal(store.messages(id, { mode: "full", resourceName: "未记录名称" }).total, 2);
}));

test("父标题携带生成描述，列表、消息、搜索和分叉保持真实同名", async () => fixture(store => {
  const unnamed = source(store, meta("unnamed-parent", { title: "未命名会话", titleOrigin: "fallback" }), []);
  const recorded = source(store, meta("recorded-parent", { title: "未命名会话" }), []);
  const child = source(store, meta("generated-child", { parentSessionId: "unnamed-parent", relationship: "child" }), [message("generated-child", 1, { text: "父标题定位" })]);
  const real = source(store, meta("recorded-child", { parentSessionId: "recorded-parent", relationship: "child" }), []);
  const fork = source(store, meta("generated-fork", { parentSessionId: "unnamed-parent", relationship: "fork" }), []);
  store.publish(store.createJob().id, [unnamed, recorded, child, real, fork], []);
  for (const session of [store.messages("generated-child").session, store.messages("generated-fork").session,
    store.list({ includeSubagents: true }).sessions.find(session => session.id === "generated-child")!, store.search({ q: "父标题定位" }).hits[0]!.session]) {
    assert.equal(session.parentTitle, "未命名会话");
    assert.deepEqual(session.parentTitleDescriptor, { key: "sessions.title.unnamed" });
  }
  assert.equal(store.messages("recorded-child").session.parentTitle, "未命名会话");
  assert.equal(store.messages("recorded-child").session.parentTitleDescriptor, undefined);
}));

test("生成正文描述经过索引持久化后保留，搜索使用原文，估算公式附带稳定描述", async () => fixture(store => {
  const summary = meta("generated-description", { messageCount: 2, turnCount: 1 });
  const records = [message(summary.id, 1, { kind: "system", text: "未记录内容", textDescriptor: { key: "sessions.body.unrecorded" } }),
    message(summary.id, 2, { text: "未记录内容" })];
  store.publish(store.createJob().id, [source(store, summary, records)], []);
  const read = store.messages(summary.id, { mode: "full" }).messages;
  assert.equal(read[0]?.text, "未记录内容");
  assert.deepEqual(read[0]?.textDescriptor, { key: "sessions.body.unrecorded" });
  assert.equal(read[1]?.textDescriptor, undefined);
  assert.equal(store.search({ q: "未记录内容", kinds: ["user", "system"] }).total, 2);
  const estimate = store.profile(summary.id).estimate;
  assert.equal(estimate.method, "留存文本字符数 ÷ 4 向上取整；仅为内容体量估算，非计费用量");
  assert.deepEqual(estimate.methodDescriptor, { key: "sessions.estimate.method" });
}));
test("多会话增量发布按真实子目标关联，避免无关会话两两扫描", async () => fixture(store => {
  const revisions = Array.from({ length: 2000 }, (_, index) => {
    const id = `publish-scale-${index}`;
    return source(store, meta(id, index < 20 ? { childSessionIds: [`publish-scale-${index + 100}`] } : {}), [message(id, index)]);
  });
  const first = store.publish(store.createJob().id, revisions, []);
  const start = performance.now();
  store.publish(store.createJob().id, revisions, []);
  const elapsed = performance.now() - start;
  assert.equal(store.status().sessionCount, 2000);
  assert.equal(store.status().sourceCount, 2000);
  assert.equal(store.status().version, first, "未变来源复用完整版本，不制造新版本");
  assert.equal(store.status().previousVersion, undefined);
  assert.equal(store.list().total, 1980);
  assert.equal(store.list({ includeSubagents: true }).total, 2000);
  assert.equal(store.search({ q: "合成正文" }).total, 2000);
  assert.equal(store.messages("publish-scale-100").session.parentSessionId, "publish-scale-0");
  assert.equal(store.profile("publish-scale-0", { includeChildren: true }).messageCount, 2);
  assert.equal(store.list({ version: first }).total, 1980);
  assert.deepEqual(store.status().gaps, []);
  assert.ok(elapsed < 1000, `2000 个未变会话的发布耗时 ${Math.round(elapsed)} 毫秒，超过 1 秒预算`);
}));

test("分支阅读不改变全活动统计，简易保留当前分支的真实历史", async () => fixture(store => {
  const id = "branch-demo";
  const summary = meta(id, { client: "pi", branches: [{ id: "old", label: "尝试", current: false }, { id: "live", label: "当前", current: true }] });
  const rows = [message(id, 1, { turnId: `${id}:turn:1`, text: "共同请求", branchIds: ["old", "live"], currentBranch: true }),
    message(id, 2, { turnId: `${id}:turn:1`, kind: "assistant", text: "旧回答", final: "explicit", branchIds: ["old"], currentBranch: false }),
    message(id, 3, { turnId: `${id}:turn:1`, kind: "compression", text: "摘要", branchIds: ["live"], currentBranch: true }),
    message(id, 4, { turnId: `${id}:turn:1`, kind: "assistant", text: "新回答", final: "explicit", branchIds: ["live"], currentBranch: true })];
  const revision = source(store, summary, rows, [{ id: "usage-old", messageId: rows[1]!.id, inputTokens: 100, outputTokens: 20 }, { id: "usage-live", messageId: rows[3]!.id, inputTokens: 150, outputTokens: 30 }]);
  store.publish(store.createJob().id, [revision], []);
  const profile = store.profile(id);
  assert.deepEqual(store.messages(id, { mode: "brief" }).messages.map(row => row.text), ["共同请求", "新回答"]);
  assert.deepEqual(store.messages(id, { mode: "brief", branch: "old", pageUnit: "turn", messageId: rows[1]!.id }).messages.map(row => row.text), ["共同请求", "旧回答"]);
  assert.equal(store.messages(id, { mode: "full" }).total, 4);
  assert.equal(store.messages(id, { mode: "trace", branch: "current", pageSize: 1, page: 3 }).messages[0]?.text, "新回答");
  assert.equal(store.messages(id, { mode: "brief", branch: "all" }).total, 3);
  assert.equal(store.search({ q: "旧回答" }).total, 1);
  assert.throws(() => store.messages(id, { branch: "unknown" }), /分支不存在/);
  assert.deepEqual(store.profile(id), profile, "阅读切换不得改变请求和 Token 统计");
}));

test("明确委派的孤立子 Agent 默认隐藏，搜索和直接访问可用", async () => fixture(store => {
  const child = source(store, meta("orphan-child", { relationship: "child", parentSessionId: "missing-parent" }), [message("orphan-child", 1, { text: "委派检索样例" })]);
  const independent = source(store, meta("independent"), [message("independent", 2)]);
  store.publish(store.createJob().id, [child, independent], []);
  assert.equal(store.list().total, 1);
  assert.equal(store.list({ includeSubagents: true }).total, 2);
  assert.equal(store.search({ q: "委派检索" }).total, 1);
  assert.equal(store.messages("orphan-child").session.relationship, "child");
  assert.equal(store.messages("orphan-child").session.parentTitle, undefined);
}));

test("默认列表排除 Quiet，类型筛选、分页、搜索与直接访问保持一致", async () => fixture(store => {
  const quiet = source(store, meta("quiet-demo", { client: "codeflicker", executionMode: "quiet", title: "入口合成样例" }), [message("quiet-demo", 1, { text: "Quiet 检索样例" })]);
  const regular = source(store, meta("regular-demo"), [message("regular-demo", 2)]);
  const unknown = source(store, meta("unknown-demo", { client: "codeflicker" }), [message("unknown-demo", 3)]);
  store.publish(store.createJob().id, [quiet, regular, unknown], []);
  assert.equal(store.list().total, 2);
  assert.ok(!store.list().sessions.some(item => item.id === "quiet-demo"));
  assert.equal(store.list({ executionMode: "all", pageSize: 1, page: 3 }).total, 3);
  assert.equal(store.list({ executionMode: "all", pageSize: 1, page: 3 }).sessions.length, 1);
  assert.deepEqual(store.list({ executionMode: "quiet" }).sessions.map(item => item.id), ["quiet-demo"]);
  assert.equal(store.list({ executionMode: "regular", client: "codeflicker" }).total, 1);
  assert.equal(store.search({ q: "Quiet", executionMode: "regular" }).total, 0);
  assert.equal(store.search({ q: "Quiet", executionMode: "quiet" }).total, 1);
  assert.equal(store.search({ q: "Quiet", sessionId: "quiet-demo" }).total, 1);
  assert.equal(store.messages("quiet-demo").session.executionMode, "quiet");
}));

test("搜索索引保留字面匹配、筛选、分页和短词语义，不保存正文副本", async () => fixture((store, path) => {
  const texts = ["防小偷合成场景", "甲乙丙x乙丙丁", "甲乙丙丁", "50%_ literal \\path \"Quoted\"", "Alpha BETA 😄中文测试", "短词防小", "中文隐藏过程"];
  const first = source(store, meta("search-a", { title: "标题防小偷", project: "/workspace/demo" }), texts.map((text, index) =>
    message("search-a", index, { text, kind: index === 6 ? "tool_result" : index % 2 ? "assistant" : "user" })));
  const second = source(store, meta("search-b", { client: "claude", updatedAt: "2026-01-03T00:00:00Z" }), [message("search-b", 0, { text: "防小偷另一个场景" })]);
  store.publish(store.createJob().id, [first, second], []);
  const database = new Database(path);
  try {
    assert.equal(database.prepare("SELECT text FROM session_message_search LIMIT 1").get()?.text, null);
    for (const q of ["防小偷", "甲乙丙丁", "50%_", "\\path", '"Quoted"', "alpha", "😄中文", "防小", "防", "中文隐藏过程", "不存在的关键词"]) {
      for (const options of [{}, { client: "codex" as const, project: "/workspace/demo", page: 2, pageSize: 1 },
        { kinds: ["tool_result"] as const, sessionId: "search-a" }, { from: "2026-01-03T00:00:00Z" }]) {
        const query = { ...options, kinds: options.kinds ? [...options.kinds] : undefined, q };
        database.prepare("UPDATE session_search_state SET complete=0").run();
        const scanned = { search: store.search(query), list: store.list(query) };
        database.prepare("UPDATE session_search_state SET complete=1").run();
        assert.deepEqual({ search: store.search(query), list: store.list(query) }, scanned, q);
      }
    }
    const plan = database.prepare("EXPLAIN QUERY PLAN SELECT rowid FROM session_message_search WHERE session_message_search MATCH ?").all('"防小偷"') as { detail: string }[];
    assert.ok(plan.some(row => row.detail.includes("VIRTUAL TABLE INDEX")));
  } finally { database.close(); }
}));

test("范围搜索保留命中语义、字面字符、分页与旧版本", async () => fixture(store => {
  const first = source(store, meta("scope-a", { client: "pi", project: "/workspace/alpha", title: "Scope A" }), [
    message("scope-a", 0, { text: "bash process legacyneedle 50%_ literal \\path" }),
    message("scope-a", 1, { kind: "assistant", text: "bash process second hit" }),
  ]);
  const second = source(store, meta("scope-b", { client: "pi", project: "/workspace/alpha", title: "Scope B" }), [
    message("scope-b", 0, { text: "bash process other hit" }),
  ]);
  const outside = source(store, meta("scope-c", { client: "claude", project: "/workspace/beta", title: "Scope C" }), [
    message("scope-c", 0, { text: "bash process outside" }),
  ]);
  const fillers = Array.from({ length: 100 }, (_, index) => {
    const id = `scope-filler-${index}`;
    return source(store, meta(id, { client: "pi", project: "/workspace/alpha" }), [message(id, 0, { text: "filler only" })]);
  });
  store.publish(store.createJob().id, [first, second, outside, ...fillers], []);
  const previousVersion = store.status().version!;

  assert.equal(store.search({ q: "bash" }).total, 4);
  assert.equal(store.search({ q: "bash", executionMode: "regular" }).total, 4);
  assert.equal(store.search({ q: "bash", from: "2026-01-01T00:00:00Z" }).total, 4);
  assert.equal(store.search({ q: "bash", client: "pi" }).total, 3);
  assert.equal(store.search({ q: "bash", project: "/workspace/alpha" }).total, 3);
  assert.equal(store.search({ q: "bash", sessionId: "scope-a" }).total, 2);
  assert.equal(store.search({ q: "50%_", sessionId: "scope-a" }).total, 1);
  assert.ok(store.search({ q: "50%_", sessionId: "scope-a" }).hits[0]?.snippet.includes("50%_"));
  const firstPage = store.search({ q: "bash", client: "pi", project: "/workspace/alpha", page: 1, pageSize: 1 });
  const secondPage = store.search({ q: "bash", client: "pi", project: "/workspace/alpha", page: 2, pageSize: 1 });
  assert.equal(firstPage.total, 3);
  assert.equal(secondPage.total, 3);
  assert.equal(firstPage.hits.length, 1);
  assert.equal(secondPage.hits.length, 1);
  assert.notEqual(firstPage.hits[0]?.messageId, secondPage.hits[0]?.messageId);

  const replacement = source(store, meta("scope-a", { client: "pi", project: "/workspace/alpha", title: "Scope A" }), [
    message("scope-a", 0, { text: "current revision only" }),
  ]);
  store.publish(store.createJob().id, [replacement, second, outside], []);
  assert.equal(store.search({ q: "legacyneedle", sessionId: "scope-a" }).total, 0);
  assert.equal(store.search({ q: "legacyneedle", sessionId: "scope-a", version: previousVersion }).total, 1);
}));

test("当前结构后台补索引可中断续建，修改删除及历史版本保持一致", async () => fixture(async (store, path) => {
  const first = source(store, meta("migration"), Array.from({ length: 450 }, (_, index) => message("migration", index, { text: `防小偷合成内容 ${index}` })));
  const version = store.publish(store.createJob().id, [first], []);
  const database = new Database(path);
  database.exec(`DROP TRIGGER session_search_insert; DROP TRIGGER session_search_update; DROP TRIGGER session_search_delete;
    DROP TABLE session_message_search; DROP TABLE session_search_state;`);
  const migrated = new SessionStore(path);
  try {
    const expected = migrated.search({ q: "防小偷" });
    await assert.rejects(migrated.prepareSearchIndex(() => { throw new Error("合成中断"); }), /合成中断/);
    assert.deepEqual(migrated.search({ q: "防小偷" }), expected, "未完成时继续使用完整扫描，不能漏结果");
    const cursor = (database.prepare("SELECT cursor FROM session_search_state").get() as { cursor: number }).cursor;
    assert.ok(cursor > 0 && cursor < 450);
    await migrated.prepareSearchIndex();
    assert.deepEqual(migrated.search({ q: "防小偷" }), expected);
    database.prepare("UPDATE session_messages SET text=? WHERE revision=? AND id=?").run("更新后唯一关键词", first.revision, "message-0");
    assert.equal(migrated.search({ q: "更新后唯一关键词" }).total, 1);
    assert.equal(migrated.search({ q: "防小偷" }).total, 449);
    const next = source(migrated, meta("migration"), [message("migration", 0, { text: "新版唯一关键词" })]);
    migrated.publish(migrated.createJob().id, [next], []);
    assert.equal(migrated.search({ q: "防小偷" }).total, 0);
    assert.equal(migrated.search({ q: "防小偷", version }).total, 449);
    migrated.publish(migrated.createJob().id, [], []);
    assert.equal(database.prepare('SELECT count(*) AS count FROM session_message_search WHERE session_message_search MATCH ?').get('"防小偷"')?.count, 0);
  } finally { migrated.close(); database.close(); }
}));

test("后台补搜索索引与主连接登记任务并发时不会发生读事务写锁升级冲突", async () => fixture(async (store, path) => {
  const current = source(store, meta("concurrent-search"), Array.from({ length: 10_000 }, (_, index) =>
    message("concurrent-search", index, { text: "合成并发索引内容".repeat(20) })));
  store.publish(store.createJob().id, [current], []);
  const database = new Database(path);
  database.exec(`DROP TRIGGER session_search_insert; DROP TRIGGER session_search_update; DROP TRIGGER session_search_delete;
    DROP TABLE session_message_search; DROP TABLE session_search_state;`);
  const worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    import('tsx/esm/api').then(async ({register})=>{
      register();
      const {SessionStore}=await import(${JSON.stringify(new URL("../src/sessions/store.ts", import.meta.url).href)});
      const store=new SessionStore(workerData);
      parentPort.postMessage('ready');
      await store.prepareSearchIndex();
      store.close();
      parentPort.postMessage('complete');
    }).catch(error=>{throw error});
  `, { eval: true, workerData: path });
  const ready = new Promise<void>((resolve, reject) => { worker.on("message", message => { if (message === "ready") resolve(); }); worker.on("error", reject); });
  const complete = new Promise<void>((resolve, reject) => { worker.on("message", message => { if (message === "complete") resolve(); }); worker.on("error", reject); });
  try {
    await ready;
    await Promise.all([complete, (async () => {
      for (let index = 0; index < 100; index += 1) {
        store.createJob();
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    })()]);
    assert.equal(store.search({ q: "合成并发索引内容" }).total, 10_000);
    assert.equal((database.prepare("SELECT complete FROM session_search_state").get() as { complete: number }).complete, 1);
  } finally { await worker.terminate(); database.close(); }
}));

test("默认列表收起明确委派子会话，保留分叉及未确认冲突，搜索仍命中子记录", async () => fixture(store => {
  const parent = source(store, meta("parent", { title: "合成主任务" }), [message("parent", 0)]);
  const child = source(store, meta("child", { parentSessionId: "parent", relationship: "child", titleOrigin: "fallback", taskName: "检查索引" }),
    [message("child", 0, { text: "子任务搜索标记" })]);
  const orphan = source(store, meta("orphan", { parentSessionId: "missing", relationship: "child" }), [message("orphan", 0)]);
  const fork = source(store, meta("fork", { parentSessionId: "parent", relationship: "fork" }), [message("fork", 0)]);
  const competingA = source(store, meta("competing-a", { childSessionIds: ["uncertain"] }), []);
  const competingB = source(store, meta("competing-b", { childSessionIds: ["uncertain"] }), []);
  const uncertain = source(store, meta("uncertain"), []);
  store.publish(store.createJob().id, [parent, child, orphan, fork, competingA, competingB, uncertain], []);
  assert.equal(store.status().sessionCount, 7, "列表筛选不删除子记录");
  assert.equal(store.list().total, 5);
  assert.ok(!store.list().sessions.some(item => item.id === "child"));
  assert.equal(store.list({ includeSubagents: true }).total, 7);
  const paged = store.list({ pageSize: 2 });
  assert.equal(paged.total, 5);
  assert.equal(paged.sessions.length, 2);
  const summary = store.messages("child").session;
  assert.equal(summary.parentTitle, "合成主任务");
  assert.equal(summary.title, "检查索引");
  assert.equal(store.messages("orphan").session.parentTitle, undefined);
  assert.equal(store.messages("fork").session.parentTitle, "合成主任务");
  const hit = store.search({ q: "子任务搜索标记" }).hits[0]!;
  assert.equal(hit.session.id, "child");
  assert.equal(hit.session.parentTitle, "合成主任务");
  assert.equal(store.search({ q: "检查索引" }).hits[0]?.kind, "title");
  store.publish(store.createJob().id, [child, orphan, fork], []);
  assert.equal(store.list().total, 1, "父来源消失不取消已确认的委派身份");
}));

test("子标题规则升级刷新旧子修订，未变化的主会话继续复用", async () => fixture(async (store, dbPath) => {
  const directory = join(dbPath, "..");
  const parentPath = join(directory, "parent.jsonl");
  const childPath = join(directory, "child.jsonl");
  const encode = (records: unknown[]) => records.map(value => JSON.stringify(value) + "\n").join("");
  await writeFile(parentPath, encode([{ type: "session_meta", payload: { id: "parent-demo", title: "合成主会话" } }]));
  await writeFile(childPath, encode([{ type: "session_meta", ordinal: 0, payload: { id: "child-demo", forked_from_id: "parent-demo",
    parent_thread_id: "parent-demo", subagent_history_start_ordinal: 2,
    source: { subagent: { thread_spawn: { parent_thread_id: "parent-demo", agent_path: "/root/check_queries" } } } } },
  { type: "session_meta", ordinal: 1, payload: { id: "parent-demo", title: "复制的父标题" } }]));
  const roots = isolatedHistoryRoots({ codex: directory });
  await refreshSessions(store, store.createJob().id, roots);
  const revisions = store.cachedRevisions();
  const cachedChild = revisions.find(item => item.path === childPath)!;
  const cachedParent = revisions.find(item => item.path === parentPath)!;
  const child = store.list({ includeSubagents: true }).sessions.find(item => item.clientSessionId === "child-demo")!;
  const old = store.createRevision(childPath, cachedChild.fingerprint.replace(":child-title-v2", ":child-title-v1"));
  old.flush();
  store.finishRevision(old.revision, { ...child, title: "未命名会话", titleOrigin: "fallback", relationship: "fork", taskName: undefined, agentName: undefined,
    path: childPath, sourceId: "synthetic-child" });
  store.publish(store.createJob().id, [cachedParent, { ...cachedChild, revision: old.revision, fingerprint: cachedChild.fingerprint.replace(":child-title-v2", ":child-title-v1") }], []);
  await refreshSessions(store, store.createJob().id, roots);
  assert.equal(store.messages(child.id).session.title, "check_queries");
  assert.equal(store.messages(child.id).session.relationship, "child");
  assert.equal(store.list().total, 1, "已确认子来源恢复默认隐藏");
  assert.equal(store.profile(store.list().sessions[0]!.id).children[0]?.id, child.id);
  assert.equal(store.cachedRevisions().find(item => item.path === parentPath)?.revision, cachedParent.revision);
  assert.notEqual(store.cachedRevisions().find(item => item.path === childPath)?.revision, old.revision);
}));

test("长会话画像按消息身份排除复制用量，查询不随请求数反复扫描全部消息", async () => fixture(store => {
  const id = "long-profile";
  const messages = Array.from({ length: 20_000 }, (_, ordinal) => message(id, ordinal, {
    kind: "tool_result", turnId: `turn-${Math.floor(ordinal / 20)}`, text: "合成过程正文".repeat(40),
  }));
  messages[0] = message(id, 0, { copied: true, turnId: "copied-turn" });
  const usages: SessionUsage[] = Array.from({ length: 5_000 }, (_, index) => ({ id: `usage-${index}`, messageId: `message-${index + 1}`, inputTokens: 1 }));
  usages.push({ id: "copied-message", messageId: "message-0", inputTokens: 999 },
    { id: "copied-turn", turnId: "copied-turn", inputTokens: 999 },
    { id: "retained-explicit", messageId: "missing-message", turnId: "copied-turn", inputTokens: 2 },
    { id: "retained-turn", turnId: "turn-2", inputTokens: 3 },
    { id: "unassociated", inputTokens: 4 });
  store.publish(store.createJob().id, [source(store, meta(id), messages, usages)], []);
  const start = performance.now();
  const profile = store.profile(id);
  const elapsed = performance.now() - start;
  assert.equal(profile.messageCount, 19_999);
  assert.equal(profile.usage.requests, 5_003);
  assert.equal(profile.usage.inputTokens, 5_009);
  assert.ok(elapsed < 1_000, `长会话画像耗时 ${Math.round(elapsed)} 毫秒，超过 1 秒预算`);
}));

test("独立表共用新索引版本，首次未就绪、发布及失败只读上一完整版本", async () => fixture((store, path) => {
  const database = new Database(path);
  assert.equal(database.pragma("user_version", { simple: true }), 4);
  assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
  database.close();
  assert.throws(() => store.list(), (error: unknown) => error instanceof StoreError && error.code === "ANALYSIS_NOT_READY");
  assert.throws(() => store.getJob("missing"), (error: unknown) => error instanceof StoreError && error.code === "JOB_NOT_FOUND");
  const first = source(store, meta("first"), [message("first", 1)]);
  const version = store.publish(store.createJob().id, [first], []);
  assert.equal(store.list().total, 1);
  source(store, meta("pending"), [message("pending", 1)]);
  assert.equal(store.list().total, 1);
  const failed = store.createJob();
  store.failJob(failed.id, "合成读取失败");
  assert.equal(store.status().version, version);
  assert.equal(store.status().stale, true);
  assert.equal(store.getJob(failed.id).status, "failed");
  assert.equal(store.messages("first").messages[0]?.text, "合成正文");
}));

test("中文全索引搜索包含标题及正文，工具可选，百分号下划线按字面匹配，定位到未加载页", async () => fixture(store => {
  const values = Array.from({ length: 1005 }, (_, index) => message("search", index, { text: index === 1001 ? "中文边界关键词 50%_命中" : "没有目标" }));
  values.push(message("search", 1006, { kind: "tool_call", text: "工具隐藏关键词", callId: "synthetic-call", tool: "shell" }));
  const revision = source(store, meta("search", { title: "中文标题关键词" }), values);
  store.publish(store.createJob().id, [revision], []);
  assert.equal(store.search({ q: "中文" }).total, 2);
  assert.equal(store.search({ q: "50%_" }).total, 1);
  assert.equal(store.search({ q: "工具隐藏" }).total, 0);
  assert.equal(store.search({ q: "工具隐藏", kinds: ["tool_call"] }).total, 1);
  assert.equal(store.list({ q: "工具隐藏" }).total, 0);
  assert.equal(store.list({ q: "工具隐藏", kinds: ["tool_call"] }).total, 1);
  const result = store.messages("search", { messageId: "message-1001", pageSize: 20 });
  assert.equal(result.page, 51);
  assert.ok(result.messages.some(item => item.id === "message-1001"));
  assert.equal(store.locate({ client: "codex", clientSessionId: "search", callId: "synthetic-call" })?.messageId, "message-1006");
  assert.equal(store.list({ q: "边界关键词" }).total, 1);
}));

test("明确子工具目标关联完整identity，前版关系不漂移，多父冲突及循环不扩大汇总", async () => fixture(store => {
  const parent = source(store, meta("parent-target", { childSessionIds: ["target-child"] }), [message("parent-target", 0)]);
  const child = source(store, meta("target-child"), [message("target-child", 0)]);
  const firstVersion = store.publish(store.createJob().id, [parent, child], []);
  assert.equal(store.messages("target-child").session.parentSessionId, "parent-target");
  assert.equal(store.profile("parent-target", { includeChildren: true }).messageCount, 2);
  const competing = source(store, meta("competing-parent", { childSessionIds: ["target-child"] }), [message("competing-parent", 0)]);
  store.publish(store.createJob().id, [parent, child, competing], []);
  assert.equal(store.messages("target-child").session.parentSessionId, undefined);
  assert.equal(store.profile("parent-target", { includeChildren: true }).messageCount, 1);
  assert.equal(store.messages("target-child", { version: firstVersion }).session.parentSessionId, "parent-target");
  assert.ok(store.status().gaps.some(gap => gap.kind === "ambiguous"));
  const cycleA = source(store, meta("cycle-a", { parentSessionId: "cycle-b", relationship: "child" }), [message("cycle-a", 0)]);
  const cycleB = source(store, meta("cycle-b", { parentSessionId: "cycle-a", relationship: "child" }), [message("cycle-b", 0)]);
  store.publish(store.createJob().id, [cycleA, cycleB], []);
  assert.deepEqual(store.profile("cycle-a", { includeChildren: true }).sessionIds, ["cycle-a"]);
  assert.ok(store.status().gaps.some(gap => gap.message.includes("循环")));
}));

test("消息upsert支持流式更新；简易模式只含用户及有依据最终回答", async () => fixture(store => {
  const pending = store.createRevision("/workspace/history/upsert.jsonl", "synthetic");
  pending.sink.message(message("upsert", 0));
  pending.sink.message(message("upsert", 1, { kind: "assistant", text: "部分" }));
  pending.sink.message(message("upsert", 1, { kind: "assistant", text: "完整回答", final: "explicit" }));
  pending.sink.message(message("upsert", 2, { kind: "thinking", text: "思考内容" }));
  pending.sink.message(message("upsert", 3, { kind: "assistant", text: "过程回复" }));
  pending.flush(); store.finishRevision(pending.revision, meta("upsert"));
  store.publish(store.createJob().id, [{ path: "/workspace/history/upsert.jsonl", revision: pending.revision, fingerprint: "synthetic" }], []);
  assert.equal(store.list().sessions[0]?.messageCount, 4);
  const brief = store.messages("upsert", { mode: "brief" });
  assert.equal(brief.total, 2);
  assert.equal(brief.messages[1]?.text, "完整回答");
}));

test("完整轮次分页保留初始、未知及超大单轮，首末和消息定位不截断过程", async () => fixture(store => {
  const id = "turn-paging";
  const values = [
    message(id, 0, { turnId: `${id}:turn:0`, kind: "system" }),
    message(id, 1, { turnId: `${id}:turn:0`, kind: "thinking" }),
    message(id, 2, { turnId: "", kind: "assistant", final: "explicit" }),
    message(id, 3, { turnId: "large-turn" }),
    ...Array.from({ length: 65 }, (_, index) => message(id, index + 4, { turnId: "large-turn", kind: "tool_call",
      tool: index === 40 ? "patch" : "read", resource: index === 5 ? { kind: "skill_read", name: "synthetic-skill" }
        : index === 30 ? { kind: "mcp", name: "lookup", server: "synthetic-server" } : undefined })),
    message(id, 69, { turnId: "large-turn", kind: "assistant", final: "explicit" }),
    message(id, 70, { turnId: "process-only", kind: "thinking" }),
    message(id, 71, { turnId: "last-complete" }),
    message(id, 72, { turnId: "last-complete", kind: "assistant", final: "inferred" }),
    message(id, 73, { turnId: "unfinished" }),
  ];
  const revision = source(store, meta(id), values);
  const empty = source(store, meta("empty-turns"), []);
  store.publish(store.createJob().id, [revision, empty], []);
  const first = store.messages(id, { pageUnit: "turn", pageSize: 1 });
  assert.equal(first.total, 74);
  assert.equal(first.totalTurns, 5);
  assert.deepEqual(first.turns, [{ id: `${id}:turn:0`, position: 0, messageCount: 2 }, { id: "unknown", position: 1, messageCount: 1 }]);
  assert.equal(first.messages.length, 3);
  const unknown = store.messages(id, { pageUnit: "turn", pageSize: 1, turnPosition: 1 });
  assert.deepEqual(unknown.turns?.at(-1), { id: "unknown", position: 1, messageCount: 1 });
  assert.equal(unknown.messages.at(-1)?.turnId, "", "原始轮次身份不伪造");
  const large = store.messages(id, { pageUnit: "turn", pageSize: 1, page: 1, messageId: "message-60" });
  assert.equal(large.page, 2);
  assert.equal(large.focusMessageId, "message-60");
  assert.equal(large.messages.length, 67);
  assert.equal(large.messages[0]?.id, "message-3");
  assert.equal(large.messages.at(-1)?.id, "message-69");
  const last = store.messages(id, { pageUnit: "turn", pageSize: 2, turnPosition: first.totalTurns });
  assert.equal(last.page, 3);
  assert.deepEqual(last.turns?.map(turn => turn.position), [5]);
  assert.equal(last.messages.at(-1)?.id, "message-73");
  assert.equal(store.messages(id, { pageUnit: "turn", pageSize: 1, page: 999 }).page, 5);
  assert.equal(store.messages(id, { pageUnit: "turn", turnPosition: 1, messageId: "message-73", pageSize: 1 }).page, 5, "消息定位优先于轮次位置");
  const brief = store.messages(id, { mode: "brief", pageUnit: "turn", pageSize: 2 });
  assert.equal(brief.total, 6);
  assert.equal(brief.totalTurns, 4);
  assert.deepEqual(brief.turns, [{ id: "unknown", position: 1, messageCount: 1 }, { id: "large-turn", position: 2, messageCount: 2 }]);
  assert.deepEqual(brief.messages.map(item => item.id), ["message-2", "message-3", "message-69"]);
  const lastBrief = store.messages(id, { mode: "brief", pageUnit: "turn", turnPosition: 4, pageSize: 1 });
  assert.equal(lastBrief.page, 4);
  assert.equal(lastBrief.messages[0]?.id, "message-73");
  assert.equal(store.messages(id, { pageSize: 1 }).messages.length, 1, "缺省仍按消息分页");
  const emptyResult = store.messages("empty-turns", { pageUnit: "turn" });
  assert.equal(emptyResult.totalTurns, 0);
  assert.equal(emptyResult.pageSize, 10);
  assert.deepEqual(emptyResult.turns, []);
  for (const query of [{ pageUnit: "turn", turnPosition: 7 }, { pageUnit: "turn", messageId: "missing-message" },
    { pageUnit: "turn", mode: "brief", messageId: "message-60" }, { turnPosition: 1 }] as const) {
    assert.throws(() => store.messages(id, query), StoreError);
  }
  assert.throws(() => store.messages("missing-session", { pageUnit: "turn" }), { code: "SOURCE_NOT_FOUND" });
  const read = store.messages(id, { pageUnit: "turn", pageSize: 1, toolName: "read" });
  assert.equal(read.focusMessageId, "message-4");
  assert.equal(read.page, 2);
  const skill = store.messages(id, { pageUnit: "turn", resourceKind: "skill_read", resourceName: "synthetic-skill" });
  assert.equal(skill.focusMessageId, "message-9");
  const mcp = store.messages(id, { pageUnit: "turn", resourceKind: "mcp", resourceName: "lookup", resourceServer: "synthetic-server" });
  assert.equal(mcp.focusMessageId, "message-34");
  assert.throws(() => store.messages(id, { toolName: "missing-tool" }), { code: "SOURCE_NOT_FOUND" });
  assert.throws(() => store.messages(id, { mode: "brief", toolName: "read" }), { code: "INVALID_INPUT" });
}));

test("简易视图轮次顺序依据完整消息，过程和最终回复的交错不改变组序号", async () => fixture(store => {
  const revision = source(store, meta("interleaved-turns"), [
    message("interleaved-turns", 0, { turnId: "first", kind: "thinking" }),
    message("interleaved-turns", 1, { turnId: "second" }),
    message("interleaved-turns", 2, { turnId: "first", kind: "assistant", final: "explicit" }),
  ]);
  store.publish(store.createJob().id, [revision], []);
  const result = store.messages("interleaved-turns", { mode: "brief", pageUnit: "turn", pageSize: 1 });
  assert.deepEqual(result.turns, [{ id: "first", position: 1, messageCount: 1 }]);
  assert.equal(result.messages[0]?.ordinal, 2);
}));

test("留存文本估算使用Unicode字符数，按单条向上取整并排除复制正文", async () => fixture(store => {
  const revision = source(store, meta("unicode-estimate"), [
    message("unicode-estimate", 0, { text: "😀中文A" }),
    message("unicode-estimate", 1, { kind: "assistant", text: "😀😀😀😀😀", final: "explicit" }),
    message("unicode-estimate", 2, { kind: "tool_result", text: "" }),
    message("unicode-estimate", 3, { kind: "tool_result", text: "😀".repeat(100), copied: true }),
  ]);
  store.publish(store.createJob().id, [revision], []);
  const profile = store.profile("unicode-estimate");
  assert.equal(profile.estimate.total, 3);
  assert.deepEqual(profile.estimate.byKind, [{ kind: "assistant", tokens: 2 }, { kind: "tool_result", tokens: 0 }, { kind: "user", tokens: 1 }]);
  assert.equal(profile.messageCount, 3);
}));

test("来源identity优先定位子会话，找不到来源时回退原始会话identity", async () => fixture(store => {
  const parent = source(store, meta("locate-parent", { clientSessionId: "shared-raw", sourceId: "codex:parent-source" }), [
    message("locate-parent", 0, { kind: "tool_call", callId: "shared-call", text: "父调用" }),
  ]);
  const child = source(store, meta("locate-child", { clientSessionId: "shared-raw", sourceId: "codex:child-source", parentSessionId: "locate-parent", relationship: "child" }), [
    message("locate-child", 1, { kind: "tool_call", callId: "shared-call", text: "子调用" }),
  ]);
  store.publish(store.createJob().id, [parent, child], []);
  assert.deepEqual(store.locate({ client: "codex", clientSessionId: "shared-raw", sourceId: "codex:child-source", callId: "shared-call" }),
    { sessionId: "locate-child", messageId: "message-1" });
  assert.deepEqual(store.locate({ client: "codex", clientSessionId: "shared-raw", sourceId: "codex:parent-source", callId: "shared-call" }),
    { sessionId: "locate-parent", messageId: "message-0" });
  assert.equal(store.locate({ client: "codex", clientSessionId: "shared-raw", sourceId: "missing-source" }), null);
  const standalone = source(store, meta("locate-standalone", { clientSessionId: "standalone-raw" }), [message("locate-standalone", 2)]);
  store.publish(store.createJob().id, [parent, child, standalone], []);
  assert.deepEqual(store.locate({ client: "codex", clientSessionId: "standalone-raw", sourceId: "missing-source", recordLine: 3 }),
    { sessionId: "locate-standalone", messageId: "message-2" });
  // 分叉事件合并后的来源可指向子副本，来源不能覆盖事件的原生会话身份。
  assert.deepEqual(store.locate({ client: "codex", clientSessionId: "standalone-raw", sourceId: "codex:child-source", recordLine: 3 }),
    { sessionId: "locate-standalone", messageId: "message-2" });
  assert.deepEqual(store.summariesByIdentity([{ client: "codex", sessionId: "standalone-raw" }]).map(session => session.id), ["locate-standalone"]);
  assert.deepEqual(store.summariesByIdentity([{ client: "claude", sessionId: "standalone-raw" }]), []);
}));

test("画像返回超过 200 条的全部请求，父子明细与汇总共同排除复制记录", async () => fixture(store => {
  const usages = Array.from({ length: 257 }, (_, index): SessionUsage => ({
    id: `request-${index}`, messageId: `message-${index}`, inputTokens: index, outputTokens: 0,
    ...(index % 2 === 0 ? { cachedInputTokens: 0 } : {}),
  }));
  const parent = source(store, meta("usage-parent", { childSessionIds: ["usage-child"] }),
    usages.map((_, index) => message("usage-parent", index, { kind: "assistant" })), usages);
  const child = source(store, meta("usage-child", { parentSessionId: "usage-parent", relationship: "child" }), [
    message("usage-child", 0, { copied: true }), message("usage-child", 1, { kind: "assistant" }),
  ], [{ id: "copied-request", messageId: "message-0", inputTokens: 999 }, { id: "child-request", messageId: "message-1", inputTokens: 42 }]);
  store.publish(store.createJob().id, [parent, child], []);

  const own = store.profile("usage-parent");
  assert.equal(own.usage.requests, 257);
  assert.equal(own.steps.length, own.usage.requests);
  assert.deepEqual(own.steps, usages.map(usage => ({ ...usage, sessionId: "usage-parent" })));
  assert.equal(own.steps[0]?.inputTokens, 0);
  assert.equal(own.steps[255]?.cachedInputTokens, undefined);
  assert.equal(own.usage.inputTokens, 256 * 257 / 2);
  assert.equal(own.usage.outputTokens, 0);
  assert.ok(!own.gaps.some(gap => gap.kind === "budget_exceeded"));

  const tree = store.profile("usage-parent", { includeChildren: true });
  assert.equal(tree.steps.length, 258);
  assert.equal(tree.steps.length, tree.usage.requests);
  assert.deepEqual(tree.steps.at(-1), { id: "child-request", messageId: "message-1", inputTokens: 42, sessionId: "usage-child" });
  assert.ok(!tree.steps.some(step => step.id === "copied-request"));
  assert.equal(tree.usage.inputTokens, own.usage.inputTokens! + 42);
  const boundaryPage = store.profile("usage-parent", { includeChildren: true, stepOffset: 250, stepLimit: 20 });
  assert.deepEqual(boundaryPage.steps, tree.steps.slice(250, 270), "父子范围分页保持原顺序且排除复制请求");
  assert.deepEqual(boundaryPage.usage, tree.usage);
  assert.equal(boundaryPage.stepsTotal, 258);
}));

test("画像采用同批缓存分母，未知保持null，reasoning不重复加输出，明确子关系与复制排除", async () => fixture(store => {
  const first = source(store, meta("parent", { childSessionIds: ["child", "missing-child"] }), [
    message("parent", 0, { model: "synthetic-model" }),
    message("parent", 1, { kind: "tool_call", tool: "mcp__example__read", status: "success", durationMs: 50,
      resource: { kind: "mcp", name: "read", server: "example" } }),
    message("parent", 2, { kind: "compression" }),
  ], [
    { id: "request-1", inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 10, contextTokens: 100 },
    { id: "request-2", inputTokens: 200, outputTokens: 30 },
  ]);
  const child = source(store, meta("child", { parentSessionId: "parent", relationship: "child" }), [
    message("child", 0, { copied: true }), message("child", 1, { kind: "assistant", final: "explicit", text: "独立子回复" }),
  ], [{ id: "copied-usage", messageId: "message-0", inputTokens: 999 }, { id: "child-usage", messageId: "message-1", inputTokens: 30, cachedInputTokens: 15 }]);
  const fork = source(store, meta("fork", { parentSessionId: "parent", relationship: "fork" }), [message("fork", 0)], [{ id: "fork-usage", inputTokens: 900 }]);
  const unknown = source(store, meta("unknown"), [message("unknown", 0)]);
  store.publish(store.createJob().id, [first, child, fork, unknown], []);
  const own = store.profile("parent");
  assert.equal(own.usage.requests, 2); assert.equal(own.usage.inputTokens, 300); assert.equal(own.usage.outputTokens, 50);
  assert.equal(own.usage.cacheReadRatio, 0.5); assert.equal(own.usage.cacheRecordedRequests, 1);
  assert.equal(own.usage.reasoningOutputTokens, 10); assert.equal(own.usage.peakContextTokens, 100);
  assert.equal(own.usage.peakInputTokens, 200);
  assert.equal(own.tools[0]?.durationMs, 50); assert.equal(own.resources[0]?.count, 1); assert.equal(own.compressions, 1);
  assert.equal(own.missingChildren, 1);
  const tree = store.profile("parent", { includeChildren: true });
  for (const step of tree.steps) {
    assert.ok(tree.sessionIds.includes(step.sessionId));
    if (step.messageId) assert.ok(store.messages(step.sessionId, { messageId: step.messageId }).messages.some(item => item.id === step.messageId));
  }
  assert.deepEqual(tree.sessionIds, ["parent", "child"]);
  assert.equal(tree.messageCount, 4); assert.equal(tree.usage.inputTokens, 330); assert.equal(tree.usage.requests, 3);
  assert.equal(store.profile("unknown").usage.inputTokens, null);
  assert.equal(store.profile("unknown").usage.cacheReadRatio, null);
  assert.equal(store.profile("unknown").turnCount, 1);
}));

test("来源缺失排除新版，前版可比较，GC只留两版，活动与归档副本不重复", async () => fixture((store, path) => {
  const first = source(store, meta("first"), [message("first", 0)]);
  const older = source(store, meta("first", { path: "/workspace/archive/first.jsonl", updatedAt: "2025-01-01T00:00:00Z" }), [message("first", 0)]);
  const firstVersion = store.publish(store.createJob().id, [first, older], []);
  assert.equal(store.status().sourceCount, 2); assert.equal(store.list().total, 1);
  assert.equal(store.profile("first").messageCount, 1);
  const secondVersion = store.publish(store.createJob().id, [], [{ kind: "source_missing", message: "合成来源已移走", count: 2 }]);
  assert.equal(store.list().total, 0); assert.equal(store.list({ version: firstVersion }).total, 1);
  assert.equal(store.status().previousVersion, firstVersion); assert.equal(store.status().gaps[0]?.count, 2);
  store.publish(store.createJob().id, [], []);
  assert.throws(() => store.list({ version: firstVersion }), (error: unknown) => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
  assert.equal(store.list({ version: secondVersion }).total, 0);
  const database = new Database(path);
  assert.equal((database.prepare("SELECT COUNT(*) AS count FROM session_revisions").get() as { count: number }).count, 0);
  database.close();
}));

test("仅有 CodeFlicker 启停 Hook 的来源可回查过程，简易对话与模型用量保持空", async () => fixture(async (store, path) => {
  const directory = join(path, "..", "hook-history");
  await mkdir(directory);
  const sourcePath = join(directory, "synthetic-hooks.jsonl");
  const records = ["SessionStart", "SessionStart", "SessionStart", "SessionEnd", "SessionEnd"].map((hookEvent, index) => ({
    type: "message", role: "attachment", sessionId: "hook-only-demo", uuid: `hook-${index}`, entrypoint: "cli", model: "fixture-inherited-model",
    content: { type: "hook_success", hookEvent, hookName: "fixture-hook", command: "printf fixture", stdout: "", stderr: "", exitCode: 0, durationMs: index + 1 },
  }));
  await writeFile(sourcePath, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const roots = isolatedHistoryRoots({ codeflicker: directory });
  const refresh = () => refreshSessions(store, store.createJob().id, roots);
  await refresh();
  assert.equal(store.list().total, 0, "仅启停 Hook 不出现在默认对话列表");
  const summary = store.list({ executionMode: "all" }).sessions[0]!;
  assert.equal(summary.messageCount, 5);
  assert.equal(summary.turnCount, 0);
  assert.equal(store.messages(summary.id, { mode: "brief", pageUnit: "turn" }).total, 0);
  const full = store.messages(summary.id, { mode: "full", pageUnit: "turn" });
  assert.equal(full.total, 5);
  assert.deepEqual(full.messages.map(message => message.recordLine), [1, 2, 3, 4, 5]);
  assert.ok(full.messages.every(message => message.kind === "context" && message.contextSource === "hook"));
  assert.equal(store.timeline(summary.id).events.length, 5);
  const profile = store.profile(summary.id);
  assert.equal(profile.messageCount, 5);
  assert.equal(profile.turnCount, 0);
  assert.deepEqual(profile.tools, []);
  assert.deepEqual(profile.models, []);
  assert.equal(profile.usage.requests, 0);
  assert.equal(profile.usage.inputTokens, null);
  assert.equal(store.search({ q: "SessionStart", sessionId: summary.id }).total, 0);
  assert.equal(store.search({ q: "SessionStart", sessionId: summary.id, kinds: ["context"] }).total, 3);
  const revision = store.cachedRevisions()[0]!.revision;
  await refresh();
  assert.equal(store.cachedRevisions()[0]!.revision, revision);
  assert.equal(store.messages(summary.id, { mode: "full" }).total, 5);
  await appendFile(sourcePath, JSON.stringify({ type: "message", role: "user", sessionId: "hook-only-demo", uuid: "real-request", entrypoint: "cli", content: "合成用户问题" }) + "\n");
  await refresh();
  assert.equal(store.list().total, 1, "来源后续出现真实对话后恢复默认展示");
  assert.equal(store.list().sessions[0]?.turnCount, 1);
  assert.equal(store.messages(summary.id, { mode: "full" }).total, 6);
}));

test("真实刷新调用链：未变来源复用、追加重建、清缓存原子重建、缺失排除和读取失败留上版", async () => fixture(async (store, path) => {
  const directory = join(path, "..", "history");
  await mkdir(directory);
  const sourcePath = join(directory, "synthetic.jsonl");
  const encode = (value: unknown) => JSON.stringify(value) + "\n";
  await writeFile(sourcePath, encode({ type: "session_meta", payload: { id: "synthetic-refresh" } })
    + encode({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "人工合成问句" }] } })
    + encode({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "人工合成最终回答" }] } }));
  const roots = isolatedHistoryRoots({ codex: directory });
  const refresh = async (clear = false) => { const job = store.createJob(); await refreshSessions(store, job.id, roots, clear); return store.getJob(job.id); };
  const first = await refresh();
  assert.equal(first.status, "complete");
  assert.equal(store.list({ project: "none" }).total, 1);
  const id = store.list().sessions[0]!.id;
  assert.equal(store.messages(id).total, 2);
  const cached = store.cachedRevisions()[0]!.revision;
  await refresh();
  assert.equal(store.cachedRevisions()[0]!.revision, cached);
  await appendFile(sourcePath, encode({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "追加问句" }] } }));
  const appended = await refresh();
  const appendedRevision = store.cachedRevisions()[0]!.revision;
  assert.notEqual(appendedRevision, cached);
  assert.equal(store.messages(id).total, 3);
  const rebuilt = await refresh(true);
  assert.notEqual(store.cachedRevisions()[0]!.revision, appendedRevision);
  assert.equal(store.messages(id).total, 3);
  assert.equal(store.messages(id, { version: appended.version }).total, 3);
  const failed = store.createJob();
  await assert.rejects(refreshSessions(store, failed.id, { ...roots, codex: sourcePath }));
  assert.equal(store.status().version, rebuilt.version);
  assert.equal(store.status().stale, true);
  assert.equal(store.getJob(failed.id).status, "failed");
  await rm(sourcePath);
  await refresh();
  assert.equal(store.list().total, 0);
  assert.equal(store.status().gaps.find(gap => gap.kind === "source_missing")?.count, 1);
  assert.equal(store.messages(id, { version: rebuilt.version }).total, 3);
}));

test("Codex 标题索引按线程身份关联，改名在正文未变时更新并可检索", async () => fixture(async (store, path) => {
  const home = join(path, "..", "codex-home");
  const sessions = join(home, "sessions");
  const archive = join(home, "archived_sessions");
  await mkdir(sessions, { recursive: true }); await mkdir(archive);
  const encode = (value: unknown) => `${JSON.stringify(value)}\n`;
  const sourcePath = join(archive, "sample.jsonl");
  const content = encode({ type: "session_meta", payload: { id: "synthetic-title" } })
    + encode({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "原始请求" }] } });
  await writeFile(sourcePath, content);
  const index = join(home, "session_index.jsonl");
  await writeFile(index, encode({ id: "unrelated", thread_name: "其他会话" })
    + encode({ id: "synthetic-title", thread_name: "旧标题" }) + "无效索引记录\n"
    + encode({ id: "synthetic-title", thread_name: "索引中的正式名称" }));
  const roots = isolatedHistoryRoots({ codex: [sessions, archive] });
  const refresh = async () => { const job = store.createJob(); await refreshSessions(store, job.id, roots); };
  await refresh();
  const before = store.list().sessions[0]!;
  assert.equal(before.title, "索引中的正式名称");
  assert.equal(before.titleOrigin, "recorded");
  assert.equal(store.list().total, 1, "标题索引不能被当作额外会话");
  const firstRevision = store.cachedRevisions()[0]!.revision;
  await refresh();
  assert.equal(store.cachedRevisions()[0]!.revision, firstRevision);
  const firstVersion = store.status().version;
  await appendFile(index, encode({ id: "synthetic-title", thread_name: "改名后的正式名称" }));
  await refresh();
  assert.equal(store.messages(before.id).session.title, "改名后的正式名称");
  assert.equal(store.list({ version: firstVersion }).sessions[0]?.title, "索引中的正式名称");
  assert.equal(store.search({ q: "改名后的正式名称" }).hits[0]?.kind, "title");
  assert.equal(store.messages(before.id).total, 1);
  await appendFile(index, encode({ id: "synthetic-title", thread_name: "" }));
  await refresh();
  assert.equal(store.list().sessions[0]?.title, "原始请求", "明确空标题不能沿用旧索引名称");
}));

test("Codex 状态库的 name 优先于旧 title，改名刷新且不改写来源", async () => fixture(async (store, path) => {
  const home = join(path, "..", "codex-state-home");
  const sessions = join(home, "sessions");
  await mkdir(sessions, { recursive: true });
  const encode = (value: unknown) => `${JSON.stringify(value)}\n`;
  await writeFile(join(sessions, "sample.jsonl"), encode({ type: "session_meta", payload: { id: "synthetic-state-title" } })
    + encode({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "原始请求" }] } }));
  const state = new Database(join(home, "state_5.sqlite"));
  try {
    state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY,title TEXT,name TEXT)");
    state.prepare("INSERT INTO threads VALUES (?,?,?)").run("synthetic-state-title", "较旧的标题", "状态库正式名称");
    const roots = isolatedHistoryRoots({ codex: sessions });
    const refresh = async () => { const job = store.createJob(); await refreshSessions(store, job.id, roots); };
    await refresh();
    assert.equal(store.list().sessions[0]?.title, "状态库正式名称");
    assert.equal(state.prepare("SELECT name FROM threads").get()?.name, "状态库正式名称");
    await writeFile(join(home, "session_index.jsonl"), encode({ id: "synthetic-state-title", thread_name: "尚未更新的索引名称" }));
    state.prepare("UPDATE threads SET name=?").run("状态库改名结果");
    await refresh();
    assert.equal(store.list().sessions[0]?.title, "状态库改名结果");
  } finally { state.close(); }
}));

test("初始上下文与实际轮次分开计数和分页，总览不搬运正文且遵守版本", async () => fixture(store => {
  const id = "timeline-demo";
  const revision = source(store, meta(id), [
    message(id, 1, { turnId: `${id}:turn:0`, kind: "context", contextSource: "agents_md", text: "私有合成正文" }),
    message(id, 2, { turnId: `${id}:turn:1`, text: "第一轮" }),
    message(id, 3, { turnId: `${id}:turn:1`, kind: "tool_call", callId: "call", tool: "read", occurredAt: "2026-01-01T00:00:00Z" }),
    message(id, 4, { turnId: `${id}:turn:2`, text: "第二轮" }),
  ]);
  const version = store.publish(store.createJob().id, [revision], []);
  const first = store.messages(id, { mode: "trace", pageUnit: "turn", pageSize: 1 });
  assert.equal(first.totalTurns, 2);
  assert.deepEqual(first.turns?.map(turn => turn.position), [0, 1]);
  assert.equal(first.messages.length, 3);
  const second = store.messages(id, { mode: "trace", pageUnit: "turn", pageSize: 1, turnPosition: 2 });
  assert.equal(second.messages[0]?.text, "第二轮");
  assert.equal(second.turns?.[0]?.position, 2);
  const focused = store.messages(id, { pageUnit: "turn", pageSize: 1, messageId: "message-1" });
  assert.equal(focused.page, 1);
  const brief = store.messages(id, { mode: "brief", pageUnit: "turn", pageSize: 1 });
  assert.equal(brief.totalTurns, 2);
  assert.equal(brief.messages[0]?.text, "第一轮");
  const timeline = store.timeline(id);
  assert.equal(timeline.version, version);
  assert.equal(timeline.events.length, 4);
  assert.equal(timeline.events[0]?.contextSource, "agents_md");
  assert.equal(timeline.events[2]?.tool, "read");
  assert.ok(timeline.events.every(event => !("text" in event) && !("json" in event)));
  store.publish(store.createJob().id, [], []);
  assert.equal(store.timeline(id, version).events.length, 4);
  assert.throws(() => store.timeline(id), { code: "SOURCE_NOT_FOUND" });
}));

test("对话兜底仅选本分支末条非空正文，不改写终态，分页和定位保留它", async () => fixture(store => {
  const id = "unfinished-dialogue";
  const records = [
    message(id, 1, { turnId: "first", text: "问题一" }),
    message(id, 2, { turnId: "first", kind: "assistant", text: "中间回复" }),
    message(id, 3, { turnId: "first", kind: "assistant", text: "最后保存回复" }),
    message(id, 4, { turnId: "first", kind: "assistant", text: "\n \t \r " }),
    message(id, 5, { turnId: "first", kind: "tool_call", text: "尚有调用" }),
    message(id, 6, { turnId: "second", text: "问题二" }),
    message(id, 7, { turnId: "second", kind: "assistant", text: "终答", final: "explicit" }),
    message(id, 8, { turnId: "second", kind: "assistant", text: "后续正文" }),
    message(id, 9, { turnId: "first", kind: "assistant", text: "其他分支终答", final: "explicit", branchIds: ["other"], currentBranch: false }),
  ];
  store.publish(store.createJob().id, [source(store, meta(id, { branches: [{ id: "other", label: "other", current: false }] }), records)], []);
  const result = store.messages(id, { mode: "brief", pageUnit: "turn", pageSize: 1 });
  assert.deepEqual(result.messages.map(item => [item.ordinal, item.final, item.unconfirmed]), [[1, undefined, undefined], [3, undefined, true]]);
  assert.equal(result.total, 4);
  assert.equal(store.messages(id, { mode: "brief", pageUnit: "turn", messageId: "message-3" }).focusMessageId, "message-3");
  assert.throws(() => store.messages(id, { mode: "brief", messageId: "message-2" }), { code: "INVALID_INPUT" });
  assert.equal(store.messages(id, { mode: "full" }).messages[2]?.unconfirmed, undefined);
  assert.equal(store.messages(id, { mode: "brief", pageUnit: "turn", page: 2, pageSize: 1 }).messages.at(-1)?.ordinal, 7);
  const directory = store.turnDirectory(id, { pageSize: 1 });
  assert.deepEqual(directory.turns, [{ id: "first", position: 1, question: "问题一" }]);
  assert.equal(store.turnDirectory(id, { pageSize: 1, page: 2 }).turns[0]?.question, "问题二");
}));

test("搜索可见性复用全部分支的简易对话规则，保留终答、兜底与旧版本", async () => fixture(store => {
  const id = "search-reading";
  const records = [
    message(id, 1, { turnId: "first", text: "needle 问题" }),
    message(id, 2, { turnId: "first", kind: "assistant", text: "needle 中间回复" }),
    message(id, 3, { turnId: "first", kind: "assistant", text: "needle 保存回复" }),
    message(id, 4, { turnId: "first", kind: "assistant", text: " \n\t " }),
    message(id, 5, { turnId: "second", kind: "assistant", text: "needle 终答", final: "explicit" }),
    message(id, 6, { turnId: "second", kind: "assistant", text: "needle 后续正文" }),
    message(id, 7, { turnId: "second", kind: "tool_result", text: "needle 工具结果" }),
    message(id, 8, { turnId: "", kind: "assistant", text: "needle 未知轮中间回复" }),
    message(id, 9, { turnId: "unknown", kind: "assistant", text: "needle 未知轮保存回复" }),
  ];
  const first = store.publish(store.createJob().id, [source(store, meta(id), records)], []);
  const query = { q: "needle", pageSize: 100 };
  const assertParity = (version: string) => {
    const visible = new Set(store.messages(id, { version, mode: "brief", branch: "all", pageSize: 100 }).messages.map(item => item.id));
    const result = store.search({ ...query, version });
    for (const hit of result.hits) {
      if (hit.messageId) assert.equal(hit.briefVisible, visible.has(hit.messageId), hit.snippet);
      else assert.equal(hit.briefVisible, undefined);
    }
    for (const hit of store.groupedSearch({ ...query, version }).groups.flatMap(group => group.hits)) {
      assert.equal(hit.briefVisible, result.hits.find(item => item.messageId === hit.messageId)?.briefVisible);
    }
    return result.hits;
  };
  const oldHits = assertParity(first);
  assert.equal(oldHits.find(hit => hit.messageId === "message-3")?.briefVisible, true);
  assert.equal(store.search({ ...query, version: first, q: "中间回复" }).hits.every(hit => hit.briefVisible === false), true);
  const second = store.publish(store.createJob().id, [source(store, meta(id, { branches: [{ id: "other", label: "other", current: false }] }), [
    ...records, message(id, 10, { turnId: "first", kind: "assistant", text: "needle 其他分支终答", final: "explicit", branchIds: ["other"], currentBranch: false }),
  ])], []);
  const newHits = assertParity(second);
  assert.equal(newHits.find(hit => hit.messageId === "message-3")?.briefVisible, false);
  assert.equal(newHits.find(hit => hit.messageId === "message-10")?.briefVisible, true);
  assert.deepEqual(assertParity(first), oldHits);
}));

test("会话级搜索按全量会话分页，保留记录级总数、展开及范围判断", async () => fixture(store => {
  const revisions = [source(store, meta("many", { project: "/synthetic/a" }), Array.from({ length: 30 }, (_, index) => message("many", index, { text: `needle ${index}` }))),
    source(store, meta("few", { project: "/synthetic/b" }), [message("few", 0, { text: "needle" })]),
    source(store, meta("last", { project: "/synthetic/a" }), [message("last", 0, { text: "needle" })])];
  const version = store.publish(store.createJob().id, revisions, []);
  const groups = store.groupedSearch({ q: "needle", pageSize: 2 });
  assert.equal(groups.total, 3); assert.equal(groups.hitCount, 32); assert.equal(groups.groups.length, 2);
  assert.equal(new Set(groups.groups.map(group => group.session.id)).size, 2);
  assert.ok(groups.groups.every(group => group.hits.length <= 3));
  assert.equal(store.groupedSearch({ q: "needle", pageSize: 2, page: 2 }).groups.length, 1);
  assert.equal(store.search({ q: "needle", sessionId: "many", page: 2, pageSize: 12 }).hits.length, 12);
  assert.equal(store.search({ q: "needle" }).total, 32);
  assert.equal(store.matches("many", { project: "/synthetic/b" }).matches, false);
  assert.equal(store.matches("many", { q: "needle", page: 999 }).matches, true);
  assert.equal(store.matches("many", { q: "missing" }).matches, false);
  assert.equal(store.groupedSearch({ q: "needle", version }).version, version);
}));

test("速度画像以完整请求集合加权，缺失与部分响应保留分母，父子同名请求互不覆盖", async () => fixture(store => {
  const timing = (durationMs: number): SessionUsage["timing"] => ({ basis: "estimated", method: "codex_event_boundary", completion: "inferred", durationMs });
  const usages: SessionUsage[] = Array.from({ length: 301 }, (_, index) => ({ id: `request-${index}`, messageId: `message-${index}`,
    outputTokens: 400, reasoningOutputTokens: 100, timing: timing(10_000) }));
  usages[300] = { ...usages[300]!, outputTokens: 6000, timing: timing(100_000) };
  usages.push({ id: "missing-output", requestMessageIds: ["message-301"], timing: timing(1000) },
    { id: "old-usage", outputTokens: 800 },
    { id: "partial", outputTokens: 900, timing: { ...timing(10_000)!, completion: "partial" } });
  const parent = source(store, meta("speed-parent", { childSessionIds: ["speed-child"] }),
    Array.from({ length: 302 }, (_, index) => message("speed-parent", index, { kind: "assistant" })), usages);
  const child = source(store, meta("speed-child", { parentSessionId: "speed-parent", relationship: "child" }), [
    message("speed-child", 0, { copied: true }), message("speed-child", 1, { kind: "assistant" }),
  ], [{ id: "copied", messageId: "message-0", outputTokens: 9999, timing: timing(1000) },
    { id: "request-0", messageId: "message-1", outputTokens: 1000, timing: timing(50_000) }]);
  const version = store.publish(store.createJob().id, [parent, child], []);
  const own = store.profile("speed-parent");
  assert.equal(own.steps.length, 304);
  assert.equal(own.usage.outputTokens, 127700, "原始输出包含不合格请求，推理 Token 不再加到输出");
  assert.deepEqual(own.outputSpeed, { requests: 304, eligibleRequests: 301, outputTokens: 126000,
    durationMs: 3_100_000, tokensPerSecond: 126000 / 3100 });
  const tree = store.profile("speed-parent", { includeChildren: true });
  assert.equal(tree.version, version);
  assert.equal(tree.steps.length, 305);
  assert.deepEqual(tree.outputSpeed, { requests: 305, eligibleRequests: 302, outputTokens: 127000,
    durationMs: 3_150_000, tokensPerSecond: 127000 / 3150 });
  assert.ok(!tree.steps.some(usage => usage.id === "copied"));
}));

test("新请求关联优先于同轮复制回退，分支投影只采用明确消息成员", async () => fixture(store => {
  const id = "speed-branches";
  const records = [
    message(id, 0, { copied: true, branchIds: ["branch-a", "branch-b"], currentBranch: true }),
    message(id, 1, { kind: "thinking", branchIds: ["branch-a", "branch-b"], currentBranch: true }),
    message(id, 2, { kind: "assistant", branchIds: ["branch-a"], currentBranch: true }),
    message(id, 3, { kind: "assistant", branchIds: ["branch-b"], currentBranch: false }),
    message(id, 4, { kind: "system", branchIds: ["branch-a"], currentBranch: true }),
    message(id, 5, { kind: "tool_call", tool: "fixture_tool", branchIds: ["branch-a"], currentBranch: true }),
  ];
  const timing: SessionUsage["timing"] = { basis: "estimated", method: "claude_message_boundary", completion: "explicit", durationMs: 10_000 };
  store.publish(store.createJob().id, [source(store, meta(id), records, [
    { id: "branch-a-request", requestMessageIds: ["message-1", "message-2"], turnId: "turn-1", outputTokens: 400, timing },
    { id: "branch-b-request", requestMessageIds: ["message-3"], turnId: "turn-1", outputTokens: 600, timing },
    { id: "raw-location", messageId: "message-4", outputTokens: 800, timing },
    { id: "copied-group", requestMessageIds: ["message-0"], turnId: "turn-1", outputTokens: 9999, timing },
    { id: "legacy-turn-only", turnId: "turn-1", outputTokens: 9999, timing },
    { id: "unknown-link", requestMessageIds: ["not-saved"], outputTokens: 200, timing },
    { id: "tool-only", requestMessageIds: [], turnId: "turn-1", timing: { ...timing, end: { messageId: "message-5", recordLine: 6 } } },
  ])], []);
  const profile = store.profile(id);
  assert.equal(profile.steps.length, 5);
  assert.deepEqual(store.profile(id, { stepOffset: 1, stepLimit: 3 }).steps, profile.steps.slice(1, 4), "有界分支投影与完整画像一致");
  const rangeUsage = store.messages(id, { mode: "full", pageUnit: "turn", messageLimit: 2 }).usages!;
  assert.deepEqual(rangeUsage.filter(usage => usage.id !== "unknown-link"), profile.steps.filter(usage => usage.id !== "unknown-link"), "轮次完整请求集合保留真实分支成员及复制过滤");
  assert.equal(profile.outputSpeed?.requests, 5);
  assert.equal(profile.outputSpeed?.outputTokens, 2000);
  assert.deepEqual(profile.steps[0]?.branchIds, ["branch-a"], "共同祖先不把后续请求扩到另一分支");
  assert.equal(profile.steps[0]?.currentBranch, true);
  assert.deepEqual(profile.steps[1]?.branchIds, ["branch-b"]);
  assert.equal(profile.steps[1]?.currentBranch, false);
  assert.deepEqual(profile.steps[2]?.branchIds, ["branch-a"]);
  assert.equal(profile.steps[3]?.branchIds, undefined, "未知身份不按同轮补配分支");
  assert.equal(profile.steps[3]?.currentBranch, undefined);
  assert.deepEqual(profile.steps[4]?.branchIds, ["branch-a"], "工具参数请求的结束项提供明确分支依据");
  assert.equal(profile.steps[4]?.currentBranch, true);
}));

test("有界轨迹保留跨页可信配对，整范围重复身份不从单页猜测", async () => fixture(async store => {
  const id = "bounded-tool-pairs";
  const records = Array.from({ length: 650 }, (_, ordinal) => message(id, ordinal, { kind: "context" }));
  records[299] = message(id, 299, { kind: "tool_call", callId: "boundary", tool: "fixture_tool" });
  records[300] = message(id, 300, { kind: "tool_result", callId: "boundary", tool: "fixture_tool", text: "完整伙伴结果".repeat(100) });
  records[10] = message(id, 10, { kind: "tool_call", callId: "duplicate" });
  records[11] = message(id, 11, { kind: "tool_result", callId: "duplicate" });
  records[550] = message(id, 550, { kind: "tool_call", callId: "duplicate" });
  records[15] = message(id, 15, { kind: "tool_call", callId: "conflict", tool: "read" });
  records[510] = message(id, 510, { kind: "tool_result", callId: "conflict", tool: "write" });
  records[20] = message(id, 20, { kind: "tool_call", callId: "branch", branchIds: ["a"], currentBranch: true });
  records[21] = message(id, 21, { kind: "tool_result", callId: "branch", branchIds: ["a"], currentBranch: true });
  records[520] = message(id, 520, { kind: "tool_call", callId: "branch", branchIds: ["b"], currentBranch: false });
  records[521] = message(id, 521, { kind: "tool_result", callId: "branch", branchIds: ["b"], currentBranch: false });
  records[25] = message(id, 25, { kind: "tool_call", callId: "cross-turn" });
  records[525] = message(id, 525, { kind: "tool_result", callId: "cross-turn", turnId: "turn-2" });
  store.publish(store.createJob().id, [source(store, meta(id, { branches: [{ id: "a", label: "a", current: true }, { id: "b", label: "b", current: false }] }), records)], []);
  const query = { mode: "trace", branch: "all", pageUnit: "turn", messageLimit: 300, maxTextChars: 10 } as const;
  const first = store.messages(id, query), second = store.messages(id, { ...query, messageOffset: 300 });
  assert.deepEqual(first.toolPairs, [{ callMessageId: "message-299", resultMessageId: "message-300" }]);
  assert.deepEqual(second.toolPairs, first.toolPairs);
  assert.equal(first.messages.length, 300); assert.equal(first.relatedMessages?.length, 1);
  assert.equal(first.relatedMessages?.[0]?.textLength, 600); assert.equal(first.relatedMessages?.[0]?.textTruncated, true);
  assert.equal([...first.relatedMessages![0]!.text].length, 10);
  assert.equal(store.messages(id, { mode: "full", messageId: "message-300", pageSize: 1 }).messages[0]?.text, records[300]?.text);
  const { traceTurns } = await import("../web/features/sessions/session-trace-model.js");
  const full = traceTurns(store.messages(id, { mode: "trace", pageSize: 200, pageUnit: "turn" }).messages, []);
  const page = traceTurns(first.messages, [], first.toolPairs, first.relatedMessages);
  assert.deepEqual(page[0]?.records.find(record => record.message.id === "message-299")?.result?.id, "message-300");
  assert.equal(page[0]?.records.find(record => record.message.id === "message-10")?.result, undefined);
  assert.equal(full[0]?.records.find(record => record.message.id === "message-10")?.result, undefined);
  assert.equal(traceTurns(second.messages, [], second.toolPairs, second.relatedMessages)[0]?.records.find(record => record.result?.id === "message-300")?.message.id, "message-299");
  const branch = store.messages(id, { ...query, branch: "a" });
  assert.ok(branch.toolPairs?.some(pair => pair.callMessageId === "message-20" && pair.resultMessageId === "message-21"));
  assert.ok(!branch.relatedMessages?.some(value => value.branchIds?.includes("b")));
}));

test("聚合轨迹用完整轮次和时间坐标，替换选中代表不会移动其他节点", async () => fixture(async store => {
  const id = "timeline-projection-bounds";
  const records = Array.from({ length: 1004 }, (_, ordinal) => message(id, ordinal, { kind: "assistant", turnId: ordinal < 1000 ? "turn-first" : `turn-${ordinal}`,
    occurredAt: ordinal === 1000 ? "invalid" : new Date(Date.UTC(2026, 0, 1) + ordinal * 1000).toISOString() }));
  store.publish(store.createJob().id, [source(store, meta(id), records)], []);
  const initial = store.timeline(id, { maxEvents: 4 }), focused = store.timeline(id, { maxEvents: 4, messageId: "message-1003" });
  assert.equal(initial.events.length, 4); assert.ok(initial.events.every(event => event.turnId === "turn-first"));
  assert.deepEqual(initial.projection, focused.projection); assert.equal(initial.projection?.totalTurns, 5); assert.equal(initial.projection?.missingTime, 1);
  assert.equal(initial.projection?.timeEnd, Date.UTC(2026, 0, 1) + 1003_000);
  const { timelineNodes, timelineProjection } = await import("../web/features/sessions/session-trace-model.js");
  for (const mode of ["turn", "time"] as const) {
    const before = timelineProjection(timelineNodes(initial.events), mode, initial.projection), after = timelineProjection(timelineNodes(focused.events), mode, focused.projection);
    for (const span of before.spans) {
      const same = after.spans.find(other => other.event.id === span.event.id);
      if (same) assert.equal(same.x, span.x, "代表替换不移动其他节点");
    }
    assert.equal(before.missing, mode === "time" ? 1 : 0);
    if (mode === "turn") assert.ok(before.spans.every(span => span.x < .2), "首轮代表仍位于全会话第一轮区间");
    else assert.equal(before.end, initial.projection?.timeEnd);
  }
  assert.equal(timelineProjection(timelineNodes(focused.events), "turn", focused.projection).spans.at(-1)?.x, .8);
}));

test("空轮身份归一为未知轮，跨页工具输入结果保持同一详情节点", async () => fixture(async store => {
  const id = "unknown-tool-turn";
  const records = [message(id, 0, { turnId: "", kind: "tool_call", callId: "unknown-call" }), message(id, 1, { turnId: "", kind: "tool_result", callId: "unknown-call" })];
  store.publish(store.createJob().id, [source(store, meta(id), records)], []);
  const result = store.messages(id, { mode: "trace", pageUnit: "turn", messageLimit: 1, messageOffset: 1 });
  const { traceTurns } = await import("../web/features/sessions/session-trace-model.js");
  const turns = traceTurns(result.messages, [], result.toolPairs, result.relatedMessages);
  assert.equal(turns[0]?.id, "unknown"); assert.equal(turns[0]?.records[0]?.message.id, "message-0"); assert.equal(turns[0]?.records[0]?.result?.id, "message-1");
}));

test("显式有界总览跨聚合阈值沿用同一原始记录坐标，工具结果时间不缩短", async () => fixture(async store => {
  const id = "timeline-threshold";
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
  const records = [message(id, 0, { occurredAt: at(0) }), message(id, 1, { occurredAt: at(.5) }),
    message(id, 2, { kind: "tool_call", callId: "timed", occurredAt: at(1) }), message(id, 3, { kind: "tool_result", callId: "timed", occurredAt: at(100) })];
  store.publish(store.createJob().id, [source(store, meta(id), records)], []);
  const aggregate = store.timeline(id, { maxEvents: 3 }), complete = store.timeline(id, { maxEvents: 4 });
  assert.equal(aggregate.aggregated, true); assert.equal(complete.aggregated, false);
  assert.deepEqual(aggregate.projection, complete.projection);
  const { timelineNodes, timelineProjection } = await import("../web/features/sessions/session-trace-model.js");
  for (const mode of ["sequence", "turn", "time"] as const) {
    const left = timelineProjection(timelineNodes(aggregate.events, false), mode, aggregate.projection);
    const right = timelineProjection(timelineNodes(complete.events), mode, complete.projection);
    assert.equal(left.start, right.start); assert.equal(left.end, right.end);
    for (const span of left.spans) {
      const same = right.spans.find(other => other.event.id === span.event.id);
      if (same) assert.equal(same.x, span.x);
    }
    const call = right.spans.find(span => span.event.kind === "tool_call")!;
    assert.equal(call.x, mode === "time" ? .01 : mode === "turn" ? .5 : 2 / 3);
  }
  assert.equal(complete.projection?.timeEnd, Date.UTC(2026, 0, 1) + 100_000);
  assert.equal(store.timeline(id).projection, undefined, "旧未传粒度的接口保持原语义");
}));

test("空会话的有界轨迹投影返回零计数，不返回空值或虚构时间范围", async () => fixture(store => {
  const id = "empty-timeline-projection";
  store.publish(store.createJob().id, [source(store, meta(id), [])], []);
  const result = store.timeline(id, { maxEvents: 1800 });
  assert.deepEqual(result.events, []); assert.equal(result.total, 0); assert.equal(result.aggregated, false);
  assert.deepEqual(result.projection, { totalTurns: 0, missingTime: 0 });
}));

test("问题目录读取有界前缀，保留长技能链接后的问题和技能轮次", async () => fixture(store => {
  const id = "directory-preview";
  const link = `[$review](/synthetic/${"nested/".repeat(30)}SKILL.md) 请检查实际问题`;
  const skill = `<skill><name>review</name><path>/synthetic/SKILL.md</path>${"技能内容".repeat(2000)}</skill>`;
  store.publish(store.createJob().id, [source(store, meta(id), [
    message(id, 1, { turnId: "first", text: link }),
    message(id, 2, { turnId: "second", text: skill }),
  ])], []);
  const directory = store.turnDirectory(id, { pageSize: 50 });
  assert.equal(directory.total, 2);
  assert.equal(directory.turns[0]?.question, link);
  assert.equal(directory.turns[1]?.question, skill.slice(0, 4096));
  assert.deepEqual(directory.turns.map(turn => turn.position), [1, 2]);
  assert.equal(store.messages(id, { mode: "full", maxTextChars: 10000 }).messages[1]?.text, skill);
}));
