import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { opencodeAdapter, OPENCODE_FORMAT } from "../src/history/adapters/opencode.js";
import { zcodeAdapter, ZCODE_FORMAT } from "../src/history/adapters/zcode.js";
import { parseNormalizedSession } from "../src/history/adapters/normalized.js";
import type { NormalizedEvent, NormalizedSnapshot } from "../src/history/adapters/normalized.js";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";
import { requestSpeed, summarizeRequestSpeed } from "../src/session-speed.js";

const at = (milliseconds: number) => new Date(Date.UTC(2026, 0, 1) + milliseconds).toISOString();

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-sqlite-speed-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function collect(snapshot: NormalizedSnapshot) {
  const messages = new Map<string, SessionMessage>();
  const usages = new Map<string, SessionUsage>();
  parseNormalizedSession(snapshot, { message: value => messages.set(value.id, value), usage: value => usages.set(value.id, value) });
  return { messages: [...messages.values()], usages: [...usages.values()],
    events: snapshot.records.map(row => row.record.normalizedEvent as NormalizedEvent | undefined).filter((value): value is NormalizedEvent => Boolean(value)) };
}

function commonSchema(database: Database.Database) {
  database.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT,title TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT);
  `);
  database.prepare("INSERT INTO session VALUES(?,?,?,?)").run("session", "/synthetic/repo", null, "Synthetic session");
  message(database, "user", { role: "user", content: "合成请求", time: { created: at(0) }, turnId: "turn" });
}

function message(database: Database.Database, id: string, data: Record<string, unknown>, session = "session", created = 0) {
  database.prepare("INSERT INTO message VALUES(?,?,?,?)").run(id, session, created, JSON.stringify(data));
}

function part(database: Database.Database, id: string, messageId: string, data: Record<string, unknown>, created = 0) {
  database.prepare("INSERT INTO part VALUES(?,?,?,?,?)").run(id, messageId, "session", created, JSON.stringify(data));
}

async function zcodeDatabase(directory: string) {
  const path = join(directory, "cli/db/db.sqlite");
  await mkdir(join(directory, "cli/db"), { recursive: true });
  const database = new Database(path);
  commonSchema(database);
  database.exec(`CREATE TABLE model_usage(id TEXT PRIMARY KEY,logical_request_id TEXT,attempt_index INTEGER,
    session_id TEXT,assistant_message_id TEXT,parent_user_message_id TEXT,status TEXT,started_at TEXT,completed_at TEXT,
    duration_ms REAL,first_token_at TEXT,time_to_first_token_ms REAL,cancelled_by_user INTEGER,output_tokens INTEGER,
    input_tokens INTEGER,reasoning_tokens INTEGER);`);
  return { database, path };
}

function zcodeUsage(database: Database.Database, id: string, extra: Record<string, unknown> = {}) {
  const values = { id, logical_request_id: id, attempt_index: 0, session_id: "session", assistant_message_id: id,
    parent_user_message_id: "user", status: "completed", started_at: at(1_000), completed_at: at(11_000),
    duration_ms: 10_000, first_token_at: at(3_000), time_to_first_token_ms: 2_000,
    cancelled_by_user: 0, output_tokens: 400, input_tokens: 100, reasoning_tokens: 50, ...extra };
  const keys = Object.keys(values);
  database.prepare(`INSERT INTO model_usage(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...Object.values(values));
}

async function zcodeSnapshot(path: string) {
  return zcodeAdapter.readRecords!({ client: "zcode", path, format: ZCODE_FORMAT, selector: "session", sessionId: "session" }) as Promise<NormalizedSnapshot>;
}

async function openCodeSnapshot(path: string) {
  return opencodeAdapter.readRecords!({ client: "opencode", path, format: OPENCODE_FORMAT, selector: "session", sessionId: "session" }) as Promise<NormalizedSnapshot>;
}

function openCodeAssistant(database: Database.Database, id: string, extra: Record<string, unknown> = {}, output = 400, reasoning = 50) {
  message(database, id, { role: "assistant", parentID: "user", modelID: "fixture-model", finish: "stop",
    time: { created: at(1_000), completed: at(11_000) }, ...extra }, "session", 1_000);
  part(database, `${id}-text`, id, { type: "text", text: "合成回复" }, 2_000);
  part(database, `${id}-usage`, id, { type: "step-finish", tokens: { input: 100, output, reasoning, cache: { read: 0, write: 0 } } }, 11_000);
}

test("ZCode 原生请求时长与首字边界完整保留，思考和工具参数按明确助手身份关联", async () => temporary(async directory => {
  const { database, path } = await zcodeDatabase(directory);
  message(database, "response", { role: "assistant", turnId: "turn", content: "合成回复", time: { created: at(1_000) } });
  part(database, "thinking", "response", { type: "reasoning", text: "合成思考" }, 2_000);
  part(database, "call", "response", { type: "tool", callID: "tool", tool: "read", state: { input: {} } }, 10_000);
  zcodeUsage(database, "request", { assistant_message_id: "response" });
  database.close();
  const sample = collect(await zcodeSnapshot(path));
  assert.equal(sample.usages.length, 1);
  const usage = sample.usages[0]!;
  assert.equal(usage.timing?.basis, "recorded");
  assert.equal(usage.timing?.window, "response");
  assert.equal(usage.timing?.completionEvidence, "request_completed");
  assert.equal(usage.timing?.durationMs, 10_000);
  assert.equal(usage.timing?.firstToken?.occurredAt, at(3_000));
  assert.ok(usage.timing?.start?.recordLine);
  assert.equal(requestSpeed(usage).tokensPerSecond, 40);
  assert.equal(usage.requestMessageIds?.length, 2);
  const requestKeys = sample.events.filter(event => ["assistant", "thinking", "tool_call"].includes(event.kind)).map(event => event.requestKey);
  assert.equal(new Set(requestKeys).size, 1);
  assert.ok(requestKeys[0]);
}));

test("ZCode 按请求尝试区分重试，重复快照只计算一次且不猜多尝试的消息归属", async () => temporary(async directory => {
  const { database, path } = await zcodeDatabase(directory);
  message(database, "shared", { role: "assistant", content: "合成回复", time: { created: at(1_000) } });
  zcodeUsage(database, "error", { logical_request_id: "logical", assistant_message_id: "shared", status: "error" });
  zcodeUsage(database, "success", { logical_request_id: "logical", attempt_index: 1, assistant_message_id: "shared" });
  zcodeUsage(database, "success-copy", { logical_request_id: "logical", attempt_index: 1, assistant_message_id: "shared" });
  database.close();
  const sample = collect(await zcodeSnapshot(path));
  assert.equal(sample.usages.length, 2);
  assert.equal(sample.usages.filter(usage => requestSpeed(usage).tokensPerSecond !== undefined).length, 1);
  assert.ok(sample.usages.every(usage => usage.requestMessageIds?.length === 0));
  assert.equal(sample.events.find(event => event.key === "message:shared")?.requestKey, undefined);
  assert.equal(summarizeRequestSpeed(sample.usages).eligibleRequests, 1);
}));

test("ZCode 门槛、取消、未知结束以及原生时长不一致均保留可解释的未计算原因", async () => temporary(async directory => {
  const { database, path } = await zcodeDatabase(directory);
  zcodeUsage(database, "equal", { output_tokens: 200, completed_at: at(2_000), duration_ms: 1_000, first_token_at: null, time_to_first_token_ms: null });
  zcodeUsage(database, "short-output", { output_tokens: 199 });
  zcodeUsage(database, "short-time", { completed_at: at(1_999), duration_ms: 999 });
  zcodeUsage(database, "cancelled", { cancelled_by_user: 1 });
  zcodeUsage(database, "unknown", { status: "pending" });
  zcodeUsage(database, "mismatch", { duration_ms: 1_001 });
  zcodeUsage(database, "no-end", { completed_at: null });
  zcodeUsage(database, "invalid-first", { first_token_at: at(20_000) });
  database.close();
  const sample = collect(await zcodeSnapshot(path));
  const reasons = sample.usages.map(value => requestSpeed(value).reason);
  assert.equal(sample.usages.filter(value => requestSpeed(value).tokensPerSecond === 200).length, 1);
  assert.equal(reasons.filter(reason => reason === "output_below_threshold").length, 1);
  assert.equal(reasons.filter(reason => reason === "duration_below_threshold").length, 1);
  assert.equal(reasons.filter(reason => reason === "partial_response").length, 1);
  assert.equal(reasons.filter(reason => reason === "end_unconfirmed").length, 1);
  assert.equal(reasons.filter(reason => reason === "timing_missing").length, 2);
  assert.equal(sample.usages.filter(value => requestSpeed(value).tokensPerSecond === 40 && !value.timing?.firstToken).length, 1);
}));

test("OpenCode 速度使用原生输出分项，工具执行等待与推理分项不进入分子或时长", async () => temporary(async directory => {
  const path = join(directory, "opencode.db");
  const database = new Database(path);
  commonSchema(database);
  openCodeAssistant(database, "response", { finish: "tool-calls" }, 400, 100);
  part(database, "thinking", "response", { type: "reasoning", text: "合成思考" }, 2_000);
  part(database, "call", "response", { type: "tool", callID: "tool", tool: "read", state: { status: "completed", input: {},
    output: "合成工具结果", time: { start: at(11_000), end: at(90_000) } } }, 10_000);
  database.close();
  const sample = collect(await openCodeSnapshot(path));
  assert.equal(sample.usages.length, 1);
  const usage = sample.usages[0]!;
  assert.equal(usage.outputTokens, 500, "保留既有用量口径");
  assert.equal(usage.timing?.outputTokens, 400);
  assert.equal(usage.timing?.durationMs, 10_000);
  assert.equal(usage.timing?.basis, "estimated");
  assert.equal(usage.timing?.window, "response");
  assert.equal(usage.timing?.completionEvidence, "stop_reason");
  assert.equal(requestSpeed(usage).tokensPerSecond, 40);
  assert.equal(summarizeRequestSpeed(sample.usages).outputTokens, 400);
  assert.equal(usage.requestMessageIds?.length, 2);
  assert.ok(sample.events.find(event => event.key === "tool-call:call")?.requestKey);
}));

test("OpenCode 未确认或失败的请求排除，门槛使用原生输出而非输出加推理", async () => temporary(async directory => {
  const path = join(directory, "opencode.db");
  const database = new Database(path);
  commonSchema(database);
  openCodeAssistant(database, "short-output", {}, 199, 1_000);
  openCodeAssistant(database, "short-time", { time: { created: at(1_000), completed: at(1_999) } }, 200);
  openCodeAssistant(database, "unknown", { finish: "" });
  openCodeAssistant(database, "error", { error: { message: "合成失败" } });
  openCodeAssistant(database, "cancelled", { finish: "aborted" });
  openCodeAssistant(database, "equal", { time: { created: at(1_000), completed: at(2_000) } }, 200);
  database.close();
  const sample = collect(await openCodeSnapshot(path));
  assert.equal(sample.usages.length, 6);
  const reasons = sample.usages.map(value => requestSpeed(value).reason);
  assert.equal(reasons.filter(reason => reason === "output_below_threshold").length, 1);
  assert.equal(reasons.filter(reason => reason === "duration_below_threshold").length, 1);
  assert.equal(reasons.filter(reason => reason === "end_unconfirmed").length, 1);
  assert.equal(reasons.filter(reason => reason === "partial_response").length, 2);
  assert.equal(sample.usages.filter(value => requestSpeed(value).tokensPerSecond === 200).length, 1);
}));

test("OpenCode 重复用量快照归同一请求，其他会话历史与合成压缩不补成请求速度", async () => temporary(async directory => {
  const path = join(directory, "opencode.db");
  const database = new Database(path);
  commonSchema(database);
  openCodeAssistant(database, "response");
  part(database, "usage-copy", "response", { type: "step-finish", tokens: { input: 100, output: 400, reasoning: 50, cache: { read: 0, write: 0 } } }, 11_001);
  openCodeAssistant(database, "synthetic", { synthetic: true });
  openCodeAssistant(database, "compression", { summary: true });
  database.prepare("INSERT INTO session VALUES(?,?,?,?)").run("other-session", "/synthetic/repo", null, "Synthetic parent");
  message(database, "parent-response", { role: "assistant", finish: "stop", time: { created: at(0), completed: at(10_000) },
    tokens: { input: 100, output: 400, reasoning: 0, cache: { read: 0, write: 0 } } }, "other-session");
  database.close();
  const sample = collect(await openCodeSnapshot(path));
  assert.equal(sample.usages.filter(value => requestSpeed(value).tokensPerSecond !== undefined).length, 1);
  assert.equal(summarizeRequestSpeed(sample.usages).eligibleRequests, 1);
  assert.ok(!sample.events.some(event => event.key === "message:parent-response"));
  assert.equal(sample.events.find(event => event.key === "message:synthetic")?.requestKey, undefined);
  assert.equal(sample.events.find(event => event.key === "message:compression")?.requestKey, undefined);
}));
