import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { parseSource, resolveSharedHistory } from "../src/history/index.js";
import { HISTORY_ADAPTERS, readHistoryEvidence } from "../src/history/adapters/index.js";
import type { HistoryAdapter } from "../src/history/adapters/types.js";
import { opencodeAdapter, OPENCODE_FORMAT } from "../src/history/adapters/opencode.js";
import { parseNormalizedSession } from "../src/history/adapters/normalized.js";
import { zcodeAdapter, ZCODE_FORMAT } from "../src/history/adapters/zcode.js";
import { createSqliteReadBudget, readSqliteRows, sqliteJson } from "../src/history/adapters/sqlite-readonly.js";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";

const registry = HISTORY_ADAPTERS as unknown as HistoryAdapter[];

async function registerAdapters<T>(run: () => Promise<T>): Promise<T> {
  const added: HistoryAdapter[] = [];
  for (const adapter of [opencodeAdapter, zcodeAdapter]) {
    if (!registry.some(item => item.id === adapter.id)) {
      registry.push(adapter);
      added.push(adapter);
    }
  }
  try { return await run(); }
  finally { for (const adapter of added) registry.splice(registry.indexOf(adapter), 1); }
}

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-native-sqlite-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function createOpenCodeSchema(database: Database.Database) {
  database.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT,title TEXT,agent TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
  `);
}

function insertOpenCodeSession(database: Database.Database, values: { id: string; directory: string; parent?: string; title?: string; agent?: string }, time = 1) {
  database.prepare("INSERT INTO session VALUES(?,?,?,?,?,?,?)").run(values.id, values.directory, values.parent ?? null,
    values.title ?? "Synthetic session", values.agent ?? null, time, time);
}

function insertOpenCodeMessage(database: Database.Database, sessionId: string, id: string, role: string, time: number,
  extra: Record<string, unknown> = {}) {
  database.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run(id, sessionId, time, time,
    JSON.stringify({ role, time: { created: time }, ...extra }));
}

function insertOpenCodePart(database: Database.Database, sessionId: string, messageId: string, id: string, time: number,
  data: Record<string, unknown>) {
  database.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run(id, messageId, sessionId, time, time,
    JSON.stringify({ id, sessionID: sessionId, messageID: messageId, time: { start: time, end: time + 1 }, ...data }));
}

function insertOpenCodeTools(database: Database.Database, sessionId: string, assistantId: string) {
  const readOutput = "<path>/synthetic/repo/src/read.ts</path>\n<type>file</type>\n<content>\n1: export const alpha = true;\n2: export const beta = false;\n\n(End of file - total 2 lines)\n</content>";
  insertOpenCodePart(database, sessionId, assistantId, "read-part", 3, {
    type: "tool", callID: "read-call", tool: "read",
    state: { status: "completed", input: { filePath: "/synthetic/repo/src/read.ts", offset: 1, limit: 2 }, output: readOutput,
      metadata: { truncated: false, display: { type: "file", path: "/synthetic/repo/src/read.ts", text: "export const alpha = true;\nexport const beta = false;", lineStart: 1, lineEnd: 2, totalLines: 2, truncated: false } }, time: { start: 3, end: 4 } },
  });
  insertOpenCodePart(database, sessionId, assistantId, "edit-part", 4, {
    type: "tool", callID: "edit-call", tool: "edit",
    state: { status: "completed", input: { filePath: "/synthetic/repo/src/edit.ts", oldString: "const old = 1;\n", newString: "const newer = 2;\n" },
      output: "Edit applied successfully.", metadata: {}, time: { start: 4, end: 5 } },
  });
  insertOpenCodePart(database, sessionId, assistantId, "bash-part", 5, {
    type: "tool", callID: "bash-call", tool: "bash",
    state: { status: "completed", input: { command: "cat src/bash.ts" }, output: "export const fromShell = true;\n",
      metadata: { exit: 0 }, time: { start: 5, end: 6 } },
  });
  insertOpenCodePart(database, sessionId, assistantId, "step-part", 6, {
    type: "step-finish", reason: "tool-calls", cost: 0.01,
    tokens: { input: 40, output: 10, reasoning: 3, cache: { read: 5, write: 1 } },
  });
}

function zcodeRoot(directory: string) {
  return { database: join(directory, "cli/db/db.sqlite"), taskIndex: join(directory, "v2/tasks-index.sqlite") };
}

async function createZCodeSchema(directory: string) {
  const paths = zcodeRoot(directory);
  await mkdir(join(directory, "cli/db"), { recursive: true });
  await mkdir(join(directory, "v2"), { recursive: true });
  const database = new Database(paths.database);
  database.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE model_usage(id TEXT PRIMARY KEY,logical_request_id TEXT,attempt_index INTEGER,session_id TEXT,turn_id TEXT,
      assistant_message_id TEXT,parent_user_message_id TEXT,provider_id TEXT,model_id TEXT,status TEXT,started_at TEXT,
      input_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER,cache_creation_input_tokens INTEGER,
      cache_read_input_tokens INTEGER,computed_total_tokens INTEGER,raw_usage_json TEXT,provider_metadata_json TEXT);
    CREATE TABLE turn_usage(id TEXT PRIMARY KEY,session_id TEXT,input_tokens INTEGER,output_tokens INTEGER);
    CREATE TABLE tool_usage(id TEXT PRIMARY KEY,session_id TEXT,tool_call_id TEXT,status TEXT,exit_code INTEGER);
  `);
  const index = new Database(paths.taskIndex);
  index.exec("CREATE TABLE tasks(task_id TEXT PRIMARY KEY,title TEXT,workspace_path TEXT,forked_from_task_id TEXT)");
  return { dbPath: paths.database, taskIndexPath: paths.taskIndex, db: database, index };
}

function insertZCodeConversation(database: Database.Database) {
  database.prepare("INSERT INTO session VALUES(?,?,?,?)").run("session-one", "/synthetic/session-dir", "Session fallback", null);
  database.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run("user-one", "session-one", 1, 1,
    JSON.stringify({ role: "user", content: "synthetic request", turnId: "turn-one", time: { created: 1 } }));
  database.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run("assistant-one", "session-one", 2, 2,
    JSON.stringify({ role: "assistant", content: "synthetic response", turnId: "turn-one", model: { modelID: "fixture-model" },
      tokens: { input: 999, output: 999 }, time: { created: 2 } }));
  database.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run("tool-part", "assistant-one", "session-one", 3, 3,
    JSON.stringify({ type: "tool", id: "tool-part", callID: "tool-call", tool: "read_file", state: {
      status: "completed", input: { file_path: "/synthetic/repo/src/file.ts" }, output: { file: { filePath: "/synthetic/repo/src/file.ts", content: "export const ok = true;" } },
    } }));
  database.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run("assistant-final", "session-one", 4, 4,
    JSON.stringify({ role: "assistant", content: "", turnId: "turn-one", model: { modelID: "fixture-model" },
      finish: "stop", time: { created: 4, completed: 5 } }));
  database.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run("assistant-final-text", "assistant-final", "session-one", 5, 5,
    JSON.stringify({ type: "text", id: "assistant-final-text", text: "synthetic final answer" }));
  database.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run("user-two", "session-one", 6, 6,
    JSON.stringify({ role: "user", content: "second synthetic request", turnId: "turn-two", time: { created: 6 } }));
  database.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run("assistant-truncated", "session-one", 7, 7,
    JSON.stringify({ role: "assistant", content: "truncated response", turnId: "turn-two", finish: "length",
      time: { created: 7, completed: 8 } }));
  database.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run("user-three", "session-one", 9, 9,
    JSON.stringify({ role: "user", content: "third synthetic request", turnId: "turn-three", time: { created: 9 } }));
  database.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run("assistant-interrupted", "session-one", 10, 10,
    JSON.stringify({ role: "assistant", content: "interrupted response", turnId: "turn-three", finish: "stop", interrupted: true,
      time: { created: 10, completed: 11 } }));
  database.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run("user-four", "session-one", 12, 12,
    JSON.stringify({ role: "user", content: "fourth synthetic request", turnId: "turn-four", time: { created: 12 } }));
  database.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run("assistant-failed", "session-one", 13, 13,
    JSON.stringify({ role: "assistant", content: "failed response", turnId: "turn-four", finish: "stop", error: { message: "synthetic failure" },
      time: { created: 13, completed: 14 } }));
  const rawUsage = JSON.stringify({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 3, totalTokens: 14 });
  const metadata = JSON.stringify({ anthropic: { usage: { input_tokens: 10, output_tokens: 4 } } });
  const insertUsage = database.prepare("INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insertUsage.run("attempt-zero", "request-one", 0, "session-one", "turn-one", "assistant-one", "user-one", "anthropic", "fixture-model", "completed", "2026-01-01T00:00:01.000Z", 10, 4, 1, 3, 2, 14, rawUsage, metadata);
  insertUsage.run("attempt-one", "request-one", 1, "session-one", "turn-one", "assistant-one", "user-one", "anthropic", "fixture-model", "error", "2026-01-01T00:00:02.000Z", 10, 4, 1, 3, 2, 14, rawUsage, metadata);
  const unverifiedRaw = JSON.stringify({ inputTokens: 20, outputTokens: 8, cacheReadTokens: 4, cacheWriteTokens: 2, totalTokens: 28 });
  insertUsage.run("attempt-unknown", "request-two", 0, "session-one", "turn-one", "assistant-one", "user-one", "other", "fixture-model", "completed", "2026-01-01T00:00:03.000Z", 20, 8, 2, 2, 4, 28, unverifiedRaw, "{}");
  database.prepare("INSERT INTO turn_usage VALUES(?,?,?,?)").run("turn-aggregate", "session-one", 1_000, 1_000);
}

test("OpenCode 普通 JSONL 之外的 SQLite 多会话快照包含 WAL、Task 子会话证据与不猜 generic parent_id", async () => temporary(directory => registerAdapters(async () => {
  const path = join(directory, "opencode.db");
  const writer = new Database(path);
  writer.pragma("journal_mode = WAL");
  writer.pragma("wal_autocheckpoint = 0");
  createOpenCodeSchema(writer);
  insertOpenCodeSession(writer, { id: "parent", directory: "/synthetic/repo", title: "Parent" });
  insertOpenCodeMessage(writer, "parent", "parent-assistant", "assistant", 2);
  insertOpenCodePart(writer, "parent", "parent-assistant", "task-part", 3, { type: "tool", callID: "task-call", tool: "task",
    state: { status: "completed", input: { prompt: "synthetic" }, output: "done",
      metadata: { parentSessionId: "parent", sessionId: "child" } } });
  insertOpenCodeSession(writer, { id: "child", directory: "/synthetic/repo/sub", parent: "parent", title: "Parent (@builder subagent)", agent: "builder" });
  insertOpenCodeMessage(writer, "child", "child-user", "user", 1);
  const wal = await stat(`${path}-wal`);
  assert.ok(wal.size > 0);
  const found = await opencodeAdapter.discoverFile!({ path, client: "opencode", format: OPENCODE_FORMAT });
  assert.deepEqual(found.map(source => source.selector).sort(), ["child", "parent"]);
  const child = await parseSource(path, "opencode", undefined, OPENCODE_FORMAT, { location: found.find(source => source.sessionId === "child")! });
  assert.equal(child.relationships[0]?.parentSessionId, "parent");
  assert.equal(child.relationships[0]?.kind, "subagent");
  assert.equal(child.relationships[0]?.sources?.length, 1);
  const parent = await parseSource(path, "opencode", undefined, OPENCODE_FORMAT, { location: found.find(source => source.sessionId === "parent")! });
  const shared = resolveSharedHistory([parent, child]);
  assert.equal(shared.relationships.find(item => item.sourceId === child.sourceId)?.resolved, true);
  const parentSnapshot = await opencodeAdapter.readRecords!({ ...found.find(source => source.sessionId === "parent")! });
  const parentMeta = parentSnapshot.records[0]?.record.normalizedMeta as { childSessionIds?: string[] } | undefined;
  assert.ok(parentMeta?.childSessionIds?.includes("child"));
  insertOpenCodeSession(writer, { id: "generic-child", directory: "/synthetic/repo", parent: "parent", title: "Ordinary session", agent: "builder" }, 4);
  const generic = await parseSource(path, "opencode", undefined, OPENCODE_FORMAT, { location: {
    path, client: "opencode", format: OPENCODE_FORMAT, selector: "generic-child", sessionId: "generic-child",
  } });
  assert.equal(generic.relationships.length, 0);
  assert.ok(generic.gaps.some(gap => gap.kind === "ambiguous"));
  writer.close();
})));

test("OpenCode parseSource 提取 native read/edit/bash 结果并可按原始证据回查", async () => temporary(directory => registerAdapters(async () => {
  const path = join(directory, "opencode.db");
  const database = new Database(path);
  createOpenCodeSchema(database);
  insertOpenCodeSession(database, { id: "tools", directory: "/synthetic/repo" });
  insertOpenCodeMessage(database, "tools", "user", "user", 1);
  insertOpenCodeMessage(database, "tools", "assistant", "assistant", 2, {
    parentID: "user", tokens: { input: 80, output: 20, reasoning: 5, cache: { read: 10, write: 2 } },
  });
  insertOpenCodePart(database, "tools", "assistant", "assistant-text", 2, { type: "text", text: "synthetic assistant" });
  insertOpenCodeTools(database, "tools", "assistant");
  const location = { path, client: "opencode" as const, format: OPENCODE_FORMAT, selector: "tools", sessionId: "tools" };
  const parsed = await parseSource(path, "opencode", undefined, OPENCODE_FORMAT, { location });
  const read = parsed.events.find(event => event.tool === "read")!;
  const edit = parsed.events.find(event => event.tool === "edit")!;
  const bash = parsed.events.find(event => event.tool === "bash")!;
  assert.equal(read.status, "success");
  assert.equal(read.kind, "read");
  assert.equal(read.fragments[0]?.historicalStart, 1);
  assert.equal(read.fragments[0]?.content, "export const alpha = true;\nexport const beta = false;");
  assert.equal(edit.status, "success");
  assert.ok(edit.fragments.some(fragment => fragment.kind === "added" && fragment.content.includes("newer")));
  assert.equal(bash.status, "success");
  assert.equal(bash.fragments[0]?.historicalStart, 1);
  const evidence = read.sources.find(source => source.selector === "tools")!;
  const reread = await readHistoryEvidence(evidence);
  assert.ok(reread);
  assert.equal(JSON.parse(reread.raw).id, "read-part");
  assert.equal(await readHistoryEvidence({ ...evidence, hash: "wrong" }), undefined);

  const snapshot = await opencodeAdapter.readRecords!({ ...location });
  const messages = new Map<string, SessionMessage>();
  const usage = new Map<string, SessionUsage>();
  const summary = parseNormalizedSession(snapshot, { message: value => messages.set(value.id, value), usage: value => usage.set(value.id, value) });
  assert.equal(usage.size, 1);
  assert.equal([...usage.values()][0]?.inputTokens, 46);
  assert.equal([...usage.values()][0]?.cachedInputTokens, 5);
  assert.equal([...usage.values()][0]?.cacheWriteTokens, 1);
  assert.equal([...usage.values()][0]?.outputTokens, 13);
  assert.equal([...usage.values()][0]?.reasoningOutputTokens, 3);
  assert.equal([...messages.values()].find(message => message.text === "synthetic assistant")?.text, "synthetic assistant");
  assert.ok(summary.gaps.some(gap => gap.kind === "unpaired_call") === false);

  database.prepare("UPDATE session SET title=? WHERE id=?").run("Changed title", "tools");
  const changed = await opencodeAdapter.readRecords!({ ...location });
  assert.notEqual(changed.hash, snapshot.hash);
  const original = parsed.events.find(event => event.tool === "read")!.sources[0]!;
  database.prepare("UPDATE part SET data=? WHERE id=?").run(JSON.stringify({ id: "read-part", type: "tool", callID: "read-call", tool: "read",
    state: { status: "completed", input: { filePath: "/synthetic/repo/src/read.ts" }, output: "changed", metadata: {} } }), "read-part");
  assert.equal(await readHistoryEvidence(original), undefined);
  database.close();
})));

test("OpenCode 缺失读取编号或 Bash exit 不补造范围和成功终态", async () => temporary(directory => registerAdapters(async () => {
  const path = join(directory, "opencode.db");
  const database = new Database(path);
  createOpenCodeSchema(database);
  insertOpenCodeSession(database, { id: "unknown", directory: "/synthetic/repo" });
  insertOpenCodeMessage(database, "unknown", "user", "user", 1);
  insertOpenCodeMessage(database, "unknown", "assistant", "assistant", 2);
  insertOpenCodePart(database, "unknown", "assistant", "truncated-read", 3, { type: "tool", callID: "read", tool: "read",
    state: { status: "completed", input: { filePath: "/synthetic/repo/src/read.ts" }, output: "partial", metadata: { truncated: true } } });
  insertOpenCodePart(database, "unknown", "assistant", "unknown-bash", 4, { type: "tool", callID: "bash", tool: "bash",
    state: { status: "completed", input: { command: "cat src/read.ts" }, output: "source line\n", metadata: {} } });
  const parsed = await parseSource(path, "opencode", undefined, OPENCODE_FORMAT, { location: {
    path, client: "opencode", format: OPENCODE_FORMAT, selector: "unknown", sessionId: "unknown",
  } });
  const read = parsed.events.find(event => event.tool === "read")!;
  const bash = parsed.events.find(event => event.tool === "bash")!;
  assert.equal(read.status, "success");
  assert.equal(read.fragments.length, 0);
  assert.ok(read.reason?.startsWith("range_unknown:"));
  assert.equal(bash.status, "unknown");
  assert.equal(bash.fragments.length, 0);
  assert.ok(parsed.gaps.some(gap => gap.kind === "ambiguous"));
  database.close();
})));

test("OpenCode 顶层模型字段与合成压缩过程不会制造用户轮次或截断终答", async () => temporary(directory => registerAdapters(async () => {
  const path = join(directory, "opencode.db");
  const database = new Database(path);
  createOpenCodeSchema(database);
  insertOpenCodeSession(database, { id: "turn-boundaries", directory: "/synthetic/repo" });
  insertOpenCodeMessage(database, "turn-boundaries", "synthetic-user", "user", 1);
  insertOpenCodePart(database, "turn-boundaries", "synthetic-user", "synthetic-text", 1,
    { type: "text", text: "synthetic compaction continuation", metadata: { compaction_continue: true } });
  insertOpenCodeMessage(database, "turn-boundaries", "injected-user", "user", 2);
  insertOpenCodePart(database, "turn-boundaries", "injected-user", "injected-text", 2,
    { type: "text", text: "synthetic injected context", metadata: { synthetic: true } });
  insertOpenCodeMessage(database, "turn-boundaries", "compressed-user", "user", 3);
  insertOpenCodePart(database, "turn-boundaries", "compressed-user", "user-summary", 3,
    { type: "compaction", summary: "user-role compression" });
  insertOpenCodeMessage(database, "turn-boundaries", "real-user", "user", 4);
  insertOpenCodePart(database, "turn-boundaries", "real-user", "real-user-text", 4, { type: "text", text: "real prompt" });
  insertOpenCodeMessage(database, "turn-boundaries", "truncated", "assistant", 5,
    { parentID: "real-user", providerID: "provider-x", modelID: "model-x", finish: "max_tokens", time: { created: 3, completed: 4 } });
  insertOpenCodePart(database, "turn-boundaries", "truncated", "truncated-text", 5, { type: "text", text: "truncated answer" });
  insertOpenCodeMessage(database, "turn-boundaries", "error", "assistant", 6,
    { parentID: "real-user", providerID: "provider-e", modelID: "model-e", error: { message: "synthetic failure" }, time: { created: 4, completed: 5 } });
  insertOpenCodePart(database, "turn-boundaries", "error", "error-text", 6, { type: "text", text: "failed answer" });
  insertOpenCodeMessage(database, "turn-boundaries", "unfinished", "assistant", 7,
    { parentID: "real-user", providerID: "provider-u", modelID: "model-u", time: { created: 5 } });
  insertOpenCodePart(database, "turn-boundaries", "unfinished", "unfinished-text", 7, { type: "text", text: "unfinished answer" });
  insertOpenCodeMessage(database, "turn-boundaries", "complete", "assistant", 8,
    { parentID: "real-user", providerID: "provider-y", modelID: "model-y", time: { created: 6, completed: 7 } });
  insertOpenCodePart(database, "turn-boundaries", "complete", "complete-text", 8, { type: "text", text: "complete answer" });
  insertOpenCodePart(database, "turn-boundaries", "complete", "future-part", 9,
    { type: "future-part", payload: "before" });
  insertOpenCodeMessage(database, "turn-boundaries", "summary", "assistant", 10,
    { parentID: "real-user", summary: true, time: { created: 7, completed: 8 } });
  insertOpenCodePart(database, "turn-boundaries", "summary", "summary-part", 10,
    { type: "compaction", summary: "compressed context" });

  const snapshot = await opencodeAdapter.readRecords!({ path, client: "opencode", format: OPENCODE_FORMAT,
    selector: "turn-boundaries", sessionId: "turn-boundaries" });
  const messages = new Map<string, SessionMessage>();
  const summary = parseNormalizedSession(snapshot, { message: message => messages.set(message.id, message), usage: () => undefined });
  assert.equal(summary.turnCount, 1);
  assert.equal([...messages.values()].find(message => message.text === "synthetic compaction continuation")?.kind, "compression");
  assert.equal([...messages.values()].find(message => message.text === "synthetic injected context")?.kind, "context");
  assert.equal([...messages.values()].find(message => message.text === "user-role compression")?.kind, "compression");
  assert.equal([...messages.values()].find(message => message.text === "truncated answer")?.final, undefined);
  assert.equal([...messages.values()].find(message => message.text === "failed answer")?.final, undefined);
  assert.equal([...messages.values()].find(message => message.text === "unfinished answer")?.final, undefined);
  assert.equal([...messages.values()].find(message => message.text === "complete answer")?.final, "inferred");
  assert.equal([...messages.values()].find(message => message.text === "complete answer")?.model, "provider-y/model-y");
  assert.ok([...messages.values()].some(message => message.kind === "compression" && message.text === "compressed context"));
  assert.ok(summary.gaps.some(gap => gap.kind === "unsupported_format" && gap.message.includes("future-part")));
  const unknownPart = snapshot.records.find(row => row.record.normalizedEvent?.text?.includes("future-part"));
  assert.equal(JSON.parse(unknownPart!.raw).id, "future-part");
  database.prepare("UPDATE part SET data=? WHERE id=?").run(JSON.stringify({ id: "future-part", type: "future-part", payload: "after" }), "future-part");
  assert.notEqual((await opencodeAdapter.readRecords!({ path, client: "opencode", format: OPENCODE_FORMAT,
    selector: "turn-boundaries", sessionId: "turn-boundaries" })).hash, snapshot.hash);
  database.close();
})));

test("SQLite JSON 损坏、未知 schema 与迭代预算均显式保留缺口", async () => temporary(directory => registerAdapters(async () => {
  const gaps: { kind: string; message: string }[] = [];
  assert.deepEqual(sqliteJson("{invalid", gaps), {});
  assert.ok(gaps.some(gap => gap.kind === "parse_error"));

  const budgetDatabase = new Database(":memory:");
  budgetDatabase.exec("CREATE TABLE rows(id INTEGER,value TEXT); INSERT INTO rows VALUES(1,'ok'),(2,'this row crosses the byte budget');");
  const recordGaps: { kind: string; message: string }[] = [];
  const recordBudget = createSqliteReadBudget(1, 10_000);
  const recordRows = readSqliteRows(budgetDatabase, "SELECT * FROM rows ORDER BY id", recordGaps, recordBudget);
  assert.deepEqual(recordRows.map(row => row.id), [1]);
  assert.equal(recordBudget.exceeded, true);
  assert.ok(recordGaps.some(gap => gap.kind === "budget_exceeded"));
  const budgetGaps: { kind: string; message: string }[] = [];
  const budget = createSqliteReadBudget(10, 32);
  const rows = readSqliteRows(budgetDatabase, "SELECT * FROM rows ORDER BY id", budgetGaps, budget);
  assert.deepEqual(rows.map(row => row.id), [1]);
  assert.equal(budget.exceeded, true);
  assert.ok(budgetGaps.some(gap => gap.kind === "budget_exceeded"));
  budgetDatabase.close();

  const openCodePath = join(directory, "unknown-opencode.db");
  const openCode = new Database(openCodePath);
  openCode.exec("CREATE TABLE unfamiliar(value TEXT)");
  openCode.close();
  const openCodeSources = await opencodeAdapter.discoverFile!({ path: openCodePath, client: "opencode", format: OPENCODE_FORMAT });
  assert.equal(openCodeSources.length, 1);
  assert.ok(openCodeSources[0]?.adapterGap?.kind === "unsupported_format");
  assert.ok((await opencodeAdapter.readRecords!(openCodeSources[0]!)).meta.gaps?.some(gap => gap.kind === "unsupported_format"));

  const zcodePath = join(directory, "unknown-zcode.db");
  const zcode = new Database(zcodePath);
  zcode.exec("CREATE TABLE unfamiliar(value TEXT)");
  zcode.close();
  const zcodeSources = await zcodeAdapter.discoverFile!({ path: zcodePath, client: "zcode", format: ZCODE_FORMAT });
  assert.equal(zcodeSources.length, 1);
  assert.ok(zcodeSources[0]?.adapterGap?.kind === "unsupported_format");
  assert.ok((await zcodeAdapter.readRecords!(zcodeSources[0]!)).meta.gaps?.some(gap => gap.kind === "unsupported_format"));
})));

test("ZCode 任务索引按 session.id 关联；model_usage 按尝试计数，忽略消息与 turn_usage 汇总", async () => temporary(async directory => registerAdapters(async () => {
  const paths = await createZCodeSchema(directory);
  paths.db.pragma("journal_mode = WAL");
  paths.db.pragma("wal_autocheckpoint = 0");
  paths.index.pragma("journal_mode = WAL");
  paths.index.pragma("wal_autocheckpoint = 0");
  insertZCodeConversation(paths.db);
  paths.index.prepare("INSERT INTO tasks VALUES(?,?,?,?)").run("session-one", "Indexed title", "/synthetic/zcode-task", null);
  const found = await zcodeAdapter.discoverFile!({ path: paths.dbPath, client: "zcode", format: ZCODE_FORMAT });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.sessionId, "session-one");
  assert.equal(found[0]?.cwd, "/synthetic/zcode-task");
  const snapshot = await zcodeAdapter.readRecords!({ ...found[0]! });
  assert.equal(snapshot.meta.title, "Indexed title");
  assert.equal(snapshot.source.cwd, "/synthetic/zcode-task");
  const finalEvent = snapshot.records.find(row => row.record.normalizedEvent?.text === "synthetic final answer")?.record.normalizedEvent as { allowInferredFinal?: boolean } | undefined;
  assert.equal(finalEvent?.allowInferredFinal, true);
  const messages = new Map<string, SessionMessage>();
  const usage = new Map<string, SessionUsage>();
  const summary = parseNormalizedSession(snapshot, { message: value => messages.set(value.id, value), usage: value => usage.set(value.id, value) });
  assert.equal(usage.size, 3);
  assert.equal([...usage.values()].filter(item => item.inputTokens === 15).length, 2);
  const verifiedUsage = [...usage.values()].filter(item => item.inputTokens === 15);
  assert.ok(verifiedUsage.every(item => item.outputTokens === 4 && item.reasoningOutputTokens === 1
    && item.cachedInputTokens === 2 && item.cacheWriteTokens === 3));
  const unverifiedUsage = [...usage.values()].find(item => item.inputTokens === undefined)!;
  assert.equal(unverifiedUsage.cachedInputTokens, 4);
  assert.equal(unverifiedUsage.cacheWriteTokens, 2);
  assert.equal(unverifiedUsage.outputTokens, 8);
  assert.equal(unverifiedUsage.reasoningOutputTokens, 2);
  assert.equal([...usage.values()].filter(item => item.inputTokens === undefined).length, 1);
  assert.equal([...usage.values()].filter(item => item.inputTokens === 1_000).length, 0);
  assert.equal([...messages.values()].filter(item => item.kind === "tool_call").length, 1);
  assert.equal([...messages.values()].find(item => item.kind === "tool_call")?.status, "success");
  const assistants = [...messages.values()].filter(item => item.kind === "assistant");
  assert.equal(assistants.length, 5);
  assert.equal(assistants.find(item => item.text === "synthetic response")?.model, "fixture-model");
  assert.equal(assistants.find(item => item.text === "synthetic response")?.recordLine, 2);
  assert.equal(assistants.find(item => item.text === "synthetic response")?.final, undefined);
  assert.equal(assistants.find(item => item.text === "synthetic final answer")?.final, "inferred");
  assert.equal(assistants.find(item => item.text === "truncated response")?.final, undefined);
  assert.equal(assistants.find(item => item.text === "interrupted response")?.final, undefined);
  assert.equal(assistants.find(item => item.text === "failed response")?.final, undefined);
  assert.equal([...messages.values()].filter(item => item.text === "model usage attempt").length, 3);
  assert.ok(summary.gaps.some(gap => gap.message.includes("包含关系未核验")));
  assert.ok(summary.gaps.some(gap => gap.message.includes("未充分对照")));
  paths.index.prepare("UPDATE tasks SET title=? WHERE task_id=?").run("Changed title", "session-one");
  const changed = await zcodeAdapter.readRecords!({ ...found[0]! });
  assert.notEqual(changed.hash, snapshot.hash);
  paths.db.close();
  paths.index.close();
})));
