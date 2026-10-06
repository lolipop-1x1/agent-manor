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
function captureSearchStatements(store: SessionStore, query: Parameters<SessionStore["search"]>[0]): string[] {
  const database = (store as unknown as { database: { prepare: (sql: string) => unknown } }).database;
  const descriptor = Object.getOwnPropertyDescriptor(database, "prepare");
  const original = database.prepare;
  const statements: string[] = [];
  Object.defineProperty(database, "prepare", { configurable: true, writable: true, value: (sql: string) => {
    statements.push(sql);
    return original.call(database, sql);
  } });
  try { store.search(query); }
  finally {
    if (descriptor) Object.defineProperty(database, "prepare", descriptor);
    else Reflect.deleteProperty(database, "prepare");
  }
  return statements;
}

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
  assert.equal(store.status().previousVersion, first);
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

test("限定搜索按有界元数据选择计划，保留全局结果、字面字符、分页与旧版本", async () => fixture(store => {
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

  const defaultRegularStatements = captureSearchStatements(store, { q: "bash", executionMode: "regular" });
  assert.ok(!defaultRegularStatements.some(sql => sql.includes("WITH scoped AS")), "默认 regular 搜索不做范围计数");
  assert.ok(defaultRegularStatements.some(sql => sql.includes("FROM session_messages m CROSS JOIN session_version_sessions v")));
  const dateOnlyStatements = captureSearchStatements(store, { q: "bash", from: "2026-01-01T00:00:00Z" });
  assert.ok(!dateOnlyStatements.some(sql => sql.includes("WITH scoped AS")), "仅日期筛选不做范围计数");
  const wideClientStatements = captureSearchStatements(store, { q: "bash", client: "pi" });
  assert.ok(wideClientStatements.some(sql => sql.includes("WITH scoped AS")));
  assert.ok(wideClientStatements.some(sql => sql.includes("LIMIT 101")));
  assert.ok(wideClientStatements.some(sql => sql.includes("FROM session_messages m CROSS JOIN session_version_sessions v")), "宽 client 范围仍由 FTS 命中驱动");
  assert.ok(!wideClientStatements.some(sql => /FROM session_version_sessions v\s+CROSS JOIN session_revisions r/.test(sql)));
  const wideProjectStatements = captureSearchStatements(store, { q: "bash", project: "/workspace/alpha" });
  assert.ok(wideProjectStatements.some(sql => sql.includes("FROM session_messages m CROSS JOIN session_version_sessions v")), "宽 project 范围仍由 FTS 命中驱动");
  assert.ok(!wideProjectStatements.some(sql => /FROM session_version_sessions v\s+CROSS JOIN session_revisions r/.test(sql)));
  const narrowSessionStatements = captureSearchStatements(store, { q: "bash", sessionId: "scope-a" });
  assert.ok(narrowSessionStatements.some(sql => /FROM session_version_sessions v\s+CROSS JOIN session_revisions r/.test(sql)), "小会话范围先筛修订再读取正文");

  assert.equal(store.search({ q: "bash" }).total, 4);
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

test("旧数据库后台补索引可中断续建，修改删除及历史版本保持一致", async () => fixture(async (store, path) => {
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

test("独立表保留地图迁移版本，首次未就绪、发布及失败只读上一完整版本", async () => fixture((store, path) => {
  const database = new Database(path);
  assert.equal(database.pragma("user_version", { simple: true }), 3);
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
