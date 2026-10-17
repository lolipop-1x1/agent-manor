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
import { summarizeRoundMetrics } from "../src/sessions/round-metrics.js";

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

test("OpenCode 步骤与补丁引用保留为过程，不冒充工具调用或代码修改", async () => temporary(async directory => {
  const path = join(directory, "opencode.db"), writer = new Database(path);
  createOpenCodeSchema(writer);
  insertOpenCodeSession(writer, { id: "metadata", directory: "/synthetic/repo" });
  insertOpenCodeMessage(writer, "metadata", "assistant", "assistant", 1);
  insertOpenCodePart(writer, "metadata", "assistant", "step", 2, { type: "step-start", snapshot: "synthetic-snapshot" });
  insertOpenCodePart(writer, "metadata", "assistant", "patch", 3, { type: "patch", hash: "synthetic-patch", files: ["/synthetic/repo/example.ts"] });
  insertOpenCodePart(writer, "metadata", "assistant", "future", 4, { type: "future-part" });
  writer.close();
  const source = { path, client: "opencode" as const, format: OPENCODE_FORMAT, selector: "metadata", sessionId: "metadata" };
  const snapshot = await opencodeAdapter.readRecords!(source);
  assert.deepEqual(snapshot.meta.gaps?.filter(gap => gap.messageDescriptor?.key === "diagnostics.history.adapters.opencode.m006")
    .map(gap => gap.messageDescriptor?.params?.p0), ["future-part"]);
  const messages: SessionMessage[] = [];
  parseNormalizedSession(snapshot, { message: value => messages.push(value), usage: () => {} });
  assert.equal(messages.filter(message => message.kind === "tool_call" || message.kind === "tool_result").length, 0);
  assert.equal(messages.filter(message => message.kind === "context").length, 3);
  assert.deepEqual(messages.find(message => message.filePaths?.length)?.filePaths, ["/synthetic/repo/example.ts"]);
  const parsed = await parseSource(path, "opencode", undefined, OPENCODE_FORMAT, { location: source });
  assert.equal(parsed.events.length, 0, "补丁标识及文件清单不能补造代码修改范围");
}));

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
  const unverifiedRaw = JSON.stringify({ inputTokens: 21, outputTokens: 8, cacheReadTokens: 4, cacheWriteTokens: 2, totalTokens: 29 });
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

test("OpenCode 依据原始总量区分独立推理与已包含推理，冲突总量保留未知", async () => temporary(directory => registerAdapters(async () => {
  const path = join(directory, "opencode.db");
  const database = new Database(path);
  try {
    createOpenCodeSchema(database);
    insertOpenCodeSession(database, { id: "usage", directory: "/synthetic/repo" });
    for (const [index, [model, reportedTotal]] of [["separate", 59], ["included", 56], ["conflict", 99]].entries()) {
      insertOpenCodeMessage(database, "usage", `assistant-${index}`, "assistant", index + 1, {
        providerID: "example-provider", modelID: model,
        tokens: { input: 40, output: 10, reasoning: 3, total: reportedTotal, cache: { read: 5, write: 1 } },
      });
    }
    const snapshot = await opencodeAdapter.readRecords!({ path, client: "opencode", format: OPENCODE_FORMAT, selector: "usage", sessionId: "usage" });
    const usages: SessionUsage[] = [];
    parseNormalizedSession(snapshot, { message: () => undefined, usage: value => usages.push(value) });
    assert.equal(usages.length, 3);
    assert.equal(usages.find(usage => usage.model === "example-provider/separate")!.outputTokens, 13);
    assert.equal(usages.find(usage => usage.model === "example-provider/included")!.outputTokens, 10);
    assert.equal(usages.find(usage => usage.model === "example-provider/conflict")!.outputTokens, undefined);
    assert.ok(usages.every(usage => usage.inputTokens === 46 && usage.reasoningOutputTokens === 3));
  } finally { database.close(); }
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

test("OpenCode invalid 是失败，自定义工具 completed 不补造 MCP 身份或协议成功", async () => temporary(async directory => {
  const path = join(directory, "opencode.db");
  const writer = new Database(path);
  createOpenCodeSchema(writer);
  insertOpenCodeSession(writer, { id: "resource-status", directory: "/synthetic/repo" });
  insertOpenCodeMessage(writer, "resource-status", "assistant", "assistant", 1);
  for (const [index, tool] of ["invalid", "example_lookup", "mcp__example__lookup", "skill"].entries()) {
    insertOpenCodePart(writer, "resource-status", "assistant", `part-${index}`, index + 2, { type: "tool", callID: `call-${index}`, tool,
      state: { status: "completed", input: { name: "demo" }, output: "returned", metadata: {} } });
  }
  writer.close();
  const snapshot = await opencodeAdapter.readRecords!({ path, client: "opencode", format: OPENCODE_FORMAT, selector: "resource-status" });
  const messages = new Map<string, SessionMessage>();
  parseNormalizedSession(snapshot, { message: value => messages.set(value.id, value), usage: () => {} });
  const calls = [...messages.values()].filter(message => message.kind === "tool_call");
  assert.deepEqual(calls.map(message => [message.tool, message.status]), [["invalid", "failure"], ["example_lookup", "unknown"], ["mcp__example__lookup", "unknown"], ["skill", "success"]]);
  assert.equal(calls[1]?.resource, undefined);
  assert.deepEqual(calls[2]?.resource, { kind: "mcp", name: "lookup", server: "example" });
}));

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
  assert.equal([...messages.values()].find(message => message.text === "complete answer")?.finalEvidence, "response_completed");
  assert.equal([...messages.values()].find(message => message.text === "complete answer")?.occurredAt, new Date(7).toISOString());
  assert.equal([...messages.values()].find(message => message.text === "complete answer")?.finalAt, new Date(7).toISOString());
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

test("OpenCode 混合 user 正文与 synthetic text part 保留真实用户轮次", async () => temporary(directory => registerAdapters(async () => {
  const path = join(directory, "opencode-mixed-synthetic.db");
  const database = new Database(path);
  createOpenCodeSchema(database);
  insertOpenCodeSession(database, { id: "mixed-synthetic", directory: "/synthetic/repo" });
  insertOpenCodeMessage(database, "mixed-synthetic", "mixed-user", "user", 1);
  insertOpenCodePart(database, "mixed-synthetic", "mixed-user", "body-part", 1,
    { type: "text", text: "explain attached file" });
  insertOpenCodePart(database, "mixed-synthetic", "mixed-user", "attachment-part", 2,
    { type: "text", text: "contents of attached file", synthetic: true });
  insertOpenCodeMessage(database, "mixed-synthetic", "file-user", "user", 3);
  insertOpenCodePart(database, "mixed-synthetic", "file-user", "file-text-part", 3,
    { type: "text", text: "text/plain attachment contents", synthetic: true });
  insertOpenCodePart(database, "mixed-synthetic", "file-user", "file-part", 4,
    { type: "file", mime: "text/plain", url: "data:text/plain;base64,eA==", filename: "synthetic.txt" });
  insertOpenCodeMessage(database, "mixed-synthetic", "synthetic-only-user", "user", 5);
  insertOpenCodePart(database, "mixed-synthetic", "synthetic-only-user", "synthetic-only-part", 5,
    { type: "text", text: "only injected content", synthetic: true });

  const snapshot = await opencodeAdapter.readRecords!({ path, client: "opencode", format: OPENCODE_FORMAT,
    selector: "mixed-synthetic", sessionId: "mixed-synthetic" });
  const messages = new Map<string, SessionMessage>();
  const summary = parseNormalizedSession(snapshot, { message: message => messages.set(message.id, message), usage: () => undefined });
  assert.equal(summary.turnCount, 2);
  assert.ok([...messages.values()].some(message => message.kind === "user" && message.text === "explain attached file"));
  assert.ok([...messages.values()].some(message => message.kind === "context" && message.text === "contents of attached file"));
  assert.ok([...messages.values()].some(message => message.kind === "user" && message.text === ""));
  assert.ok([...messages.values()].some(message => message.kind === "context" && message.text === "text/plain attachment contents"));
  assert.ok([...messages.values()].some(message => message.kind === "context" && message.text === "only injected content"));
  const userRow = snapshot.records.find(row => row.record.normalizedEvent?.key === "message:mixed-user")!;
  const userRaw = JSON.parse(userRow.raw) as { parts: { id: string }[] };
  assert.deepEqual(userRaw.parts.map(part => part.id), ["body-part"]);
  const syntheticRow = snapshot.records.find(row => row.record.normalizedEvent?.key === "synthetic-part:attachment-part")!;
  assert.equal(JSON.parse(syntheticRow.raw).id, "attachment-part");
  assert.equal(snapshot.records.find(row => row.record.normalizedEvent?.key === "message:file-user")?.record.normalizedEvent?.kind, "user");
  assert.equal(snapshot.records.find(row => row.record.normalizedEvent?.key === "message:synthetic-only-user")?.record.normalizedEvent?.kind, "context");
  database.close();
})));

test("OpenCode 正常 stop 提供结束依据，工具 stop 和未知 finish 只有请求完成", async () => temporary(async directory => {
  const path = join(directory, "opencode-finish.db");
  const database = new Database(path);
  createOpenCodeSchema(database);
  insertOpenCodeSession(database, { id: "finish", directory: "/synthetic/repo" });
  for (const [index, finish] of ["stop", "tool-calls", "future-finish"].entries()) {
    const offset = index * 10;
    insertOpenCodeMessage(database, "finish", `user-${index}`, "user", offset);
    insertOpenCodePart(database, "finish", `user-${index}`, `user-text-${index}`, offset, { type: "text", text: "prompt" });
    insertOpenCodeMessage(database, "finish", `assistant-${index}`, "assistant", offset + 1,
      { parentID: `user-${index}`, finish, time: { created: offset + 1, completed: offset + 2 } });
    insertOpenCodePart(database, "finish", `assistant-${index}`, `answer-text-${index}`, offset + 1, { type: "text", text: finish });
  }
  database.close();
  const messages = new Map<string, SessionMessage>();
  parseNormalizedSession(await opencodeAdapter.readRecords!({ path, client: "opencode", format: OPENCODE_FORMAT, selector: "finish", sessionId: "finish" }),
    { message: value => messages.set(value.id, value), usage: () => {} });
  const values = [...messages.values()];
  assert.equal(values.find(message => message.text === "stop")?.final, "inferred");
  assert.equal(values.find(message => message.text === "stop")?.finalEvidence, "normal_stop");
  for (const text of ["tool-calls", "future-finish"]) {
    assert.equal(values.find(message => message.text === text)?.final, undefined);
    assert.equal(values.find(message => message.text === text)?.finalEvidence, undefined);
  }
}));

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

test("ZCode 缺少供应商补充元数据时仍保留已核验的输入与缓存用量", async () => temporary(async directory => registerAdapters(async () => {
  const paths = await createZCodeSchema(directory);
  try {
    paths.db.prepare("INSERT INTO session VALUES(?,?,?,?)").run("session-one", "/synthetic/project", "Synthetic usage", null);
    paths.db.prepare("INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "attempt-one", "request-one", 0, "session-one", "turn-one", null, null, "example-provider", "fixture-model", "completed",
      "2026-01-01T00:00:01.000Z", 100, 7, null, 0, 25, 107,
      JSON.stringify({ inputTokens: 100, outputTokens: 7, cacheReadTokens: 25, cacheWriteTokens: 0, totalTokens: 107 }),
      JSON.stringify({ rawFinishReason: "stop" }));
    const found = await zcodeAdapter.discoverFile!({ path: paths.dbPath, client: "zcode", format: ZCODE_FORMAT });
    const snapshot = await zcodeAdapter.readRecords!(found[0]!);
    const usages: SessionUsage[] = [];
    parseNormalizedSession(snapshot, { message: () => undefined, usage: value => usages.push(value) });
    assert.equal(usages.length, 1);
    assert.equal(usages[0]!.inputTokens, 125);
    assert.equal(usages[0]!.provider, "example-provider");
    assert.equal(usages[0]!.outputTokens, 7);
    assert.equal(usages[0]!.cachedInputTokens, 25);
    assert.equal(usages[0]!.cacheWriteTokens, 0);
    assert.ok(!snapshot.meta.gaps?.some(gap => gap.messageDescriptor?.key === "diagnostics.history.adapters.zcode.m007"));
  } finally { paths.db.close(); paths.index.close(); }
})));

test("ZCode 确认零输入允许缺原始桶，但明确冲突不能伪装为零", async () => temporary(async directory => registerAdapters(async () => {
  const paths = await createZCodeSchema(directory);
  try {
    paths.db.prepare("INSERT INTO session VALUES(?,?,?,?)").run("session-one", "/synthetic/project", "Synthetic zero usage", null);
    const insert = paths.db.prepare("INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const [index, raw] of [{}, { inputTokens: 1 }, { cacheReadTokens: 1 }].entries()) {
      insert.run(`attempt-${index}`, `request-${index}`, 0, "session-one", "turn-one", null, null, "example-provider", "fixture-model", "completed",
        "2026-01-01T00:00:01.000Z", 0, 7, null, 0, 0, 7, JSON.stringify(raw), "{}");
    }
    const found = await zcodeAdapter.discoverFile!({ path: paths.dbPath, client: "zcode", format: ZCODE_FORMAT });
    const snapshot = await zcodeAdapter.readRecords!(found[0]!);
    const usages: SessionUsage[] = [];
    parseNormalizedSession(snapshot, { message: () => undefined, usage: value => usages.push(value) });
    assert.equal(usages.length, 3);
    assert.equal(usages.filter(usage => usage.inputTokens === 0).length, 1);
    assert.equal(usages.filter(usage => usage.inputTokens === undefined).length, 2);
    assert.equal(snapshot.meta.gaps?.filter(gap => gap.messageDescriptor?.key === "diagnostics.history.adapters.zcode.m007").length, 2);
  } finally { paths.db.close(); paths.index.close(); }
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
  assert.equal(assistants.find(item => item.text === "synthetic final answer")?.finalEvidence, "normal_stop");
  assert.equal(assistants.find(item => item.text === "synthetic final answer")?.occurredAt, new Date(5).toISOString());
  assert.equal(assistants.find(item => item.text === "synthetic final answer")?.finalAt, new Date(5).toISOString());
  assert.ok(assistants.filter(item => item.final === undefined).every(item => item.finalEvidence === undefined));
  assert.equal(assistants.find(item => item.text === "truncated response")?.final, undefined);
  assert.equal(assistants.find(item => item.text === "interrupted response")?.final, undefined);
  assert.equal(assistants.find(item => item.text === "failed response")?.final, undefined);
  assert.equal([...messages.values()].filter(item => item.text === "model usage attempt").length, 3);
  assert.ok(summary.gaps.some(gap => gap.message.includes("包含关系未核验")));
  assert.ok(summary.gaps.some(gap => gap.messageDescriptor?.key === "diagnostics.history.adapters.zcode.m007"));
  paths.index.prepare("UPDATE tasks SET title=? WHERE task_id=?").run("Changed title", "session-one");
  const changed = await zcodeAdapter.readRecords!({ ...found[0]! });
  assert.notEqual(changed.hash, snapshot.hash);
  paths.db.close();
  paths.index.close();
})));

test("ZCode 步骤开始与文件附件元数据不产生代码活动或不支持诊断", async () => temporary(async directory => {
  const paths = await createZCodeSchema(directory);
  try {
    paths.db.prepare("INSERT INTO session VALUES(?,?,?,?)").run("metadata", "/synthetic/repo", "Synthetic metadata", null);
    insertOpenCodeMessage(paths.db, "metadata", "user", "user", 1, { content: "查看附件" });
    insertOpenCodeMessage(paths.db, "metadata", "assistant", "assistant", 2, { content: "已收到" });
    insertOpenCodePart(paths.db, "metadata", "assistant", "start", 2, { type: "step-start" });
    insertOpenCodePart(paths.db, "metadata", "user", "attachment", 1, { type: "file", filename: "example.png", mime: "image/png",
      url: "https://example.invalid/attachment", source: { type: "file", path: "/synthetic/attachment.png", text: "" }, metadata: { storageKind: "local", sizeBytes: 1, recoverability: "available" } });
    const source = { path: paths.dbPath, client: "zcode" as const, format: ZCODE_FORMAT, selector: "metadata" };
    const snapshot = await zcodeAdapter.readRecords!(source);
    assert.ok(!snapshot.meta.gaps?.some(gap => gap.kind === "unsupported_format"));
    assert.equal((await parseSource(paths.dbPath, "zcode", undefined, ZCODE_FORMAT, { location: source })).events.length, 0);
    insertOpenCodePart(paths.db, "metadata", "assistant", "future", 3, { type: "future-part" });
    assert.ok((await zcodeAdapter.readRecords!(source)).meta.gaps?.some(gap => gap.kind === "unsupported_format"));
  } finally { paths.db.close(); paths.index.close(); }
}));

test("ZCode 无请求表用量时读取步骤结束用量，消息快照不重复累计", async () => temporary(async directory => {
  const paths = await createZCodeSchema(directory);
  paths.db.prepare("INSERT INTO session VALUES(?,?,?,?)").run("legacy", "/synthetic/repo", "Legacy usage", null);
  const insertMessage = paths.db.prepare("INSERT INTO message VALUES(?,?,?,?,?)");
  insertMessage.run("user", "legacy", 1000, 1000, JSON.stringify({ role: "user", content: "request", turnId: "turn" }));
  insertMessage.run("assistant", "legacy", 2000, 5000, JSON.stringify({ role: "assistant", content: "answer", turnId: "turn",
    model: { modelID: "fixture-model" }, finish: "stop", time: { created: 2000, completed: 5000 },
    tokens: { total: 260, input: 230, output: 30, reasoning: 0, cache: { read: 170, write: 0 } } }));
  const insertPart = paths.db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)");
  for (const [id, input, output, read, end] of [["step-one", 100, 10, 60, 3000], ["step-two", 130, 20, 110, 5000]] as const) {
    insertPart.run(id, "assistant", "legacy", end, end, JSON.stringify({ id, type: "step-finish", reason: "stop",
      tokens: { total: input + output, input, output, reasoning: 0, cache: { read, write: 0 } } }));
  }
  const source = { path: paths.dbPath, client: "zcode" as const, format: ZCODE_FORMAT, selector: "legacy" };
  const snapshot = await zcodeAdapter.readRecords!(source);
  const usage = new Map<string, SessionUsage>();
  parseNormalizedSession(snapshot, { message: () => undefined, usage: value => usage.set(value.id, value) });
  assert.equal(usage.size, 2);
  assert.deepEqual([...usage.values()].map(value => [value.inputTokens, value.outputTokens, value.cachedInputTokens]), [[100, 10, 60], [130, 20, 110]]);
  assert.ok([...usage.values()].every(value => value.turnId.endsWith(":turn:1") && value.model === "fixture-model"));
  assert.equal([...usage.values()][0]?.occurredAt, new Date(3000).toISOString());
  assert.ok(!snapshot.meta.gaps?.some(gap => gap.message.includes("step-finish")));
  const previousHash = snapshot.hash;
  paths.db.prepare("UPDATE part SET data=? WHERE id=?").run(JSON.stringify({ id: "step-two", type: "step-finish", reason: "stop",
    tokens: { total: 151, input: 130, output: 21, reasoning: 0, cache: { read: 110, write: 0 } } }), "step-two");
  assert.notEqual((await zcodeAdapter.readRecords!(source)).hash, previousHash);
  paths.db.close(); paths.index.close();
}));

test("ZCode 仅有消息用量时核验总量，空响应占位不生成零请求", async () => temporary(async directory => {
  const paths = await createZCodeSchema(directory);
  paths.db.prepare("INSERT INTO session VALUES(?,?,?,?)").run("legacy", "/synthetic/repo", "Legacy usage", null);
  const insert = paths.db.prepare("INSERT INTO message VALUES(?,?,?,?,?)");
  insert.run("user", "legacy", 1000, 1000, JSON.stringify({ role: "user", content: "request", time: { created: 1000 } }));
  insert.run("answer", "legacy", 2000, 3000, JSON.stringify({ role: "assistant", content: "answer", finish: "stop",
    time: { created: 2000, completed: 3000 }, tokens: { total: 110, input: 100, output: 10, reasoning: 0, cache: { read: 80, write: 0 } } }));
  insert.run("placeholder", "legacy", 4000, 4000, JSON.stringify({ role: "assistant",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }));
  const snapshot = await zcodeAdapter.readRecords!({ path: paths.dbPath, client: "zcode", format: ZCODE_FORMAT, selector: "legacy" });
  const usages = new Map<string, SessionUsage>();
  const messages = new Map<string, SessionMessage>();
  parseNormalizedSession(snapshot, { message: value => messages.set(value.id, value), usage: value => usages.set(value.id, value) });
  assert.equal(usages.size, 1);
  assert.equal([...usages.values()][0]?.inputTokens, 100);
  assert.equal([...usages.values()][0]?.cachedInputTokens, 80);
  assert.equal(summarizeRoundMetrics([...messages.values()], [...usages.values()]).averageDurationMs, 2000);
  insert.run("conflict", "legacy", 5000, 6000, JSON.stringify({ role: "assistant", content: "partial usage", finish: "stop",
    tokens: { total: 999, input: 100, output: 10, reasoning: 0, cache: { read: 80, write: 0 } } }));
  const changed = await zcodeAdapter.readRecords!({ path: paths.dbPath, client: "zcode", format: ZCODE_FORMAT, selector: "legacy" });
  const partial = new Map<string, SessionUsage>();
  parseNormalizedSession(changed, { message: () => undefined, usage: value => partial.set(value.id, value) });
  assert.equal(partial.size, 2);
  assert.equal([...partial.values()].filter(value => value.inputTokens === undefined && value.outputTokens === 10).length, 1);
  assert.ok(changed.meta.gaps?.some(gap => gap.messageDescriptor?.key === "diagnostics.history.adapters.zcode.legacyUsage"));
  paths.db.close(); paths.index.close();
}));

test("ZCode 混合代际按助手身份选择请求表或旧式用量，零值空占位不算请求", async () => temporary(async directory => {
  const paths = await createZCodeSchema(directory);
  insertZCodeConversation(paths.db);
  paths.db.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run("legacy-extra", "session-one", 20, 30,
    JSON.stringify({ role: "assistant", content: "独立旧式响应", finish: "stop", time: { created: 20, completed: 30 },
      tokens: { total: 110, input: 100, output: 10, reasoning: 0, cache: { read: 80, write: 0 } } }));
  paths.db.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run("placeholder", "session-one", 40, 40,
    JSON.stringify({ role: "assistant", tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }));
  const snapshot = await zcodeAdapter.readRecords!({ path: paths.dbPath, client: "zcode", format: ZCODE_FORMAT, selector: "session-one" });
  const usage = new Map<string, SessionUsage>();
  parseNormalizedSession(snapshot, { message: () => undefined, usage: value => usage.set(value.id, value) });
  assert.equal(usage.size, 4);
  assert.equal([...usage.values()].filter(value => value.inputTokens === 100 && value.outputTokens === 10).length, 1);
  assert.ok([...usage.values()].every(value => value.inputTokens !== 0 || value.outputTokens !== 0));
  paths.db.close(); paths.index.close();
}));

test("OpenCode 与 ZCode 未知 message role 保留 context、缺口与原始行", async () => temporary(async directory => registerAdapters(async () => {
  const openCodePath = join(directory, "opencode-unknown-role.db");
  const openCode = new Database(openCodePath);
  createOpenCodeSchema(openCode);
  insertOpenCodeSession(openCode, { id: "unknown-role-opencode", directory: "/synthetic/repo" });
  insertOpenCodeMessage(openCode, "unknown-role-opencode", "unknown-role-message", "future-role", 1,
    { content: "synthetic unknown content" });
  insertOpenCodePart(openCode, "unknown-role-opencode", "unknown-role-message", "unknown-role-text", 1,
    { type: "text", text: "synthetic text part" });
  const openCodeSnapshot = await opencodeAdapter.readRecords!({ path: openCodePath, client: "opencode", format: OPENCODE_FORMAT,
    selector: "unknown-role-opencode", sessionId: "unknown-role-opencode" });
  const openCodeMessages = new Map<string, SessionMessage>();
  const openCodeMeta = parseNormalizedSession(openCodeSnapshot,
    { message: message => openCodeMessages.set(message.id, message), usage: () => undefined });
  assert.equal(openCodeMeta.turnCount, 0);
  assert.ok([...openCodeMessages.values()].some(message => message.kind === "context" && message.text === "synthetic text part"));
  assert.ok(openCodeMeta.gaps.some(gap => gap.kind === "unsupported_format" && gap.message.includes("future-role")));
  const openCodeRow = openCodeSnapshot.records.find(row => row.record.normalizedEvent?.key === "message:unknown-role-message")!;
  const openCodeRaw = JSON.parse(openCodeRow.raw) as { message: { id: string }; parts: { id: string }[] };
  assert.equal(openCodeRow.line, 1);
  assert.equal(openCodeRaw.message.id, "unknown-role-message");
  assert.deepEqual(openCodeRaw.parts.map(part => part.id), ["unknown-role-text"]);
  openCode.close();

  const paths = await createZCodeSchema(directory);
  paths.db.prepare("INSERT INTO session VALUES(?,?,?,?)").run("unknown-role-zcode", "/synthetic/session-dir", "Unknown role", null);
  paths.db.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run("unknown-role-message", "unknown-role-zcode", 1, 1,
    JSON.stringify({ role: "future-role", content: "synthetic unknown content", time: { created: 1 } }));
  paths.db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run("unknown-role-text", "unknown-role-message", "unknown-role-zcode", 1, 1,
    JSON.stringify({ type: "text", id: "unknown-role-text", text: "synthetic text part" }));
  paths.db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run("unknown-role-future-part", "unknown-role-message", "unknown-role-zcode", 2, 2,
    JSON.stringify({ type: "future-part", id: "unknown-role-future-part", payload: "first" }));
  const [zcodeSource] = await zcodeAdapter.discoverFile!({ path: paths.dbPath, client: "zcode", format: ZCODE_FORMAT });
  const zcodeSnapshot = await zcodeAdapter.readRecords!({ ...zcodeSource! });
  const zcodeMessages = new Map<string, SessionMessage>();
  const zcodeMeta = parseNormalizedSession(zcodeSnapshot,
    { message: message => zcodeMessages.set(message.id, message), usage: () => undefined });
  assert.equal(zcodeMeta.turnCount, 0);
  assert.ok([...zcodeMessages.values()].some(message => message.kind === "context" && message.text.includes("synthetic unknown content")));
  assert.ok(zcodeMeta.gaps.some(gap => gap.kind === "unsupported_format" && gap.message.includes("future-role")));
  assert.ok(zcodeMeta.gaps.some(gap => gap.kind === "unsupported_format" && gap.message.includes("future-part")));
  const zcodeRow = zcodeSnapshot.records.find(row => row.record.normalizedEvent?.key === "message:unknown-role-message")!;
  const zcodeRaw = JSON.parse(zcodeRow.raw) as { message: { id: string }; textParts: { id: string }[] };
  assert.equal(zcodeRow.line, 1);
  assert.equal(zcodeRaw.message.id, "unknown-role-message");
  assert.deepEqual(zcodeRaw.textParts.map(part => part.id), ["unknown-role-text"]);
  const unknownPart = zcodeSnapshot.records.find(row => row.record.normalizedEvent?.key === "unknown-part:unknown-role-future-part")!;
  assert.equal(JSON.parse(JSON.parse(unknownPart.raw).data).payload, "first");
  paths.db.prepare("UPDATE part SET data=? WHERE id=?").run(
    JSON.stringify({ type: "future-part", id: "unknown-role-future-part", payload: "second" }), "unknown-role-future-part");
  assert.notEqual((await zcodeAdapter.readRecords!({ ...zcodeSource! })).hash, zcodeSnapshot.hash);
  paths.db.close();
  paths.index.close();
})));
