import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { IDE_FORMAT, readIdeSnapshot } from "../src/history/adapters/codeflicker-ide.js";
import { readHistoryEvidence } from "../src/history/adapters/index.js";
import { parseSessionSource } from "../src/sessions/parser.js";
import { sourceQuickStamp } from "../src/sessions/quick-check.js";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";

async function fixture(run: (directory: string, put: (file: string, key: string, value: unknown) => void) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-ide-usage-"));
  const files = new Map<string, Database.Database>();
  const put = (file: string, key: string, value: unknown) => {
    let db = files.get(file);
    if (!db) { db = new Database(join(directory, file)); db.exec("CREATE TABLE KwaipilotKV(key TEXT PRIMARY KEY,value BLOB)"); files.set(file, db); }
    db.prepare("INSERT OR REPLACE INTO KwaipilotKV VALUES(?,?)").run(key, JSON.stringify(value));
  };
  try { await run(directory, put); }
  finally { for (const db of files.values()) db.close(); await rm(directory, { recursive: true, force: true }); }
}

const messages = [
  { ts: 1_780_000_000_000, role: "user", say: "text", chatId: "chat", text: "合成需求" },
  { ts: 1_780_000_001_000, say: "api_req_started", chatId: "chat", chatModel: "sample-model" },
  { ts: 1_780_000_002_000, say: "text", chatId: "chat", text: "第一条合成回复" },
  { ts: 1_780_000_003_000, say: "api_req_started", chatId: "chat", chatModel: "sample-model" },
  { ts: 1_780_000_004_000, say: "text", chatId: "chat", text: "第二条合成回复" },
  { ts: 1_780_000_005_000, say: "completion_result", chatId: "chat" },
];
const source = (directory: string) => ({ path: join(directory, "composer_data.sqlite"), client: "codeflicker-desktop" as const,
  format: IDE_FORMAT, sessionId: "session", selector: "composerData:session" });
const history = (timestamp = 1_780_000_002_100, input = 100) => ({ sessionId: "session", chatId: "chat", timestamp,
  usage: { prompt_tokens: input, completion_tokens: 20, total_tokens: input + 20, cached_creation_input_tokens: 10, cached_read_input_tokens: 80 }, modelName: "sample-model" });
async function collect(directory: string) {
  const messageMap = new Map<string, SessionMessage>(), usages = new Map<string, SessionUsage>();
  const meta = await parseSessionSource(source(directory), { message: value => messageMap.set(value.id, value), usage: value => usages.set(value.id, value) });
  return { meta, messages: [...messageMap.values()], usages: [...usages.values()] };
}

test("IDE 从逐请求旁路历史恢复用量，关联真实轮次且不重复 API 上下文正文", async () => fixture(async (directory, put) => {
  put("composer_data.sqlite", "composerData:session", { sessionId: "session", localMessages: messages });
  put("index.sqlite", "token_usage_history_session", [history(), history(), history(1_780_000_004_100, 120)]);
  put("index.sqlite", "token_usage_session_session", { totalTokens: 9_000_000, requestCount: 100 });
  const sample = await collect(directory);
  assert.equal(sample.usages.length, 2);
  assert.deepEqual(sample.usages.map(x => [x.inputTokens, x.outputTokens, x.cachedInputTokens, x.cacheWriteTokens]), [[100, 20, 80, 10], [120, 20, 80, 10]]);
  assert.equal(sample.meta.turnCount, 1);
  assert.ok(sample.usages.every(x => x.turnId?.endsWith(":turn:1")));
  assert.deepEqual(sample.messages.filter(x => x.kind === "assistant").map(x => x.text), ["第一条合成回复", "第二条合成回复"]);
  assert.equal(sample.usages[0]!.occurredAt, new Date(history().timestamp).toISOString());
  const marker = sample.messages.find(x => x.id === sample.usages[0]!.messageId)!;
  const snapshot = await readIdeSnapshot(source(directory));
  const raw = snapshot.records.find(x => x.line === marker.recordLine)!.raw;
  const evidence = await readHistoryEvidence({ ...source(directory), sourceId: "synthetic-source", recordLine: marker.recordLine,
    hash: createHash("sha256").update(raw).digest("hex") });
  assert.equal(evidence?.raw, raw);
}));

test("IDE API 用量只有唯一原生请求与完整正文匹配才补齐，缺失缓存保持未知", async () => fixture(async (directory, put) => {
  put("composer_data.sqlite", "composerData:session", { sessionId: "session", localMessages: messages });
  put("api_history.sqlite", "apiConversationHistory:session", [
    { role: "assistant", chatId: "chat", content: [{ type: "text", text: "第一条合成回复" }], usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } },
    { role: "assistant", chatId: "chat", content: [{ type: "text", text: "第二条合成回复" }], usage: { promptTokens: 120, completionTokens: 20, totalTokens: 140 } },
    { role: "assistant", chatId: "other", content: [{ type: "text", text: "不属于此轮" }], usage: { promptTokens: 900, completionTokens: 90, totalTokens: 990 } },
  ]);
  const sample = await collect(directory);
  assert.equal(sample.usages.length, 2);
  assert.ok(sample.usages.every(x => x.cachedInputTokens === undefined && x.cacheWriteTokens === undefined));
  assert.deepEqual(sample.usages.map(x => x.occurredAt), [new Date(messages[2]!.ts).toISOString(), new Date(messages[4]!.ts).toISOString()]);
}));

test("IDE 历史与 API 副本归同一原生请求；冲突、重复正文及累计缓存不冒充请求", async () => fixture(async (directory, put) => {
  put("composer_data.sqlite", "composerData:session", { sessionId: "session", localMessages: messages.map(x => x.say === "text" && x.role !== "user" ? { ...x, text: "重复回复" } : x) });
  put("index.sqlite", "token_usage_history_session", [history(), { ...history(), usage: { ...history().usage, prompt_tokens: 101 } },
    { ...history(1_780_000_004_100, 120), sessionId: "other" }]);
  put("api_history.sqlite", "apiConversationHistory:session", [
    { role: "assistant", chatId: "chat", content: [{ type: "text", text: "重复回复" }], usage: { promptTokens: 100, completionTokens: 20 } },
  ]);
  put("index.sqlite", "token_usage_session_session_chat", { promptTokens: 100, completionTokens: 20, requestCount: 8 });
  assert.equal((await collect(directory)).usages.filter(x => x.inputTokens !== undefined || x.outputTokens !== undefined).length, 0);
}));

test("IDE 旁路追加参与逻辑指纹；未声明完整依赖的快检继续逐内容核验", async () => fixture(async (directory, put) => {
  put("composer_data.sqlite", "composerData:session", { sessionId: "session", localMessages: messages });
  const before = await readIdeSnapshot(source(directory));
  put("index.sqlite", "token_usage_history_session", [history()]);
  const after = await readIdeSnapshot(source(directory));
  assert.notEqual(before.hash, after.hash);
  assert.equal(await sourceQuickStamp(source(directory)), undefined);
  assert.equal((await collect(directory)).usages.filter(x => x.inputTokens !== undefined || x.outputTokens !== undefined).length, 1);
}));

test("IDE API 匹配拒绝正文子集、重复块及颠倒顺序", async () => fixture(async (directory, put) => {
  const complete = [messages[0]!, messages[1]!, { ...messages[2]!, say: "thinking", text: "合成思考" },
    { ...messages[2]!, ts: messages[2]!.ts + 100, text: "合成回复" }];
  put("composer_data.sqlite", "composerData:session", { sessionId: "session", localMessages: complete });
  const thinking = { type: "thinking", thinking: "合成思考" }, text = { type: "text", text: "合成回复" };
  for (const content of [[text], [thinking, thinking, text], [text, thinking]]) {
    put("api_history.sqlite", "apiConversationHistory:session", [{ role: "assistant", chatId: "chat", content,
      usage: { promptTokens: 100, completionTokens: 20 } }]);
    assert.equal((await collect(directory)).usages.filter(x => x.inputTokens !== undefined || x.outputTokens !== undefined).length, 0);
  }
  put("api_history.sqlite", "apiConversationHistory:session", [{ role: "assistant", chatId: "chat", content: [thinking, text],
    usage: { promptTokens: 100, completionTokens: 20 } }]);
  assert.equal((await collect(directory)).usages.filter(x => x.inputTokens !== undefined || x.outputTokens !== undefined).length, 1);
}));

test("IDE history 和 API 同原生请求只计一次，已知字段冲突保留缺口", async () => fixture(async (directory, put) => {
  put("composer_data.sqlite", "composerData:session", { sessionId: "session", localMessages: messages });
  put("index.sqlite", "token_usage_history_session", [history()]);
  const api = { role: "assistant", chatId: "chat", content: [{ type: "text", text: "第一条合成回复" }],
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } };
  put("api_history.sqlite", "apiConversationHistory:session", [api, api]);
  let sample = await collect(directory);
  assert.equal(sample.usages.length, 2);
  assert.equal(sample.usages.filter(x => x.inputTokens !== undefined).length, 1);
  assert.equal(sample.usages[0]!.cachedInputTokens, 80);
  put("api_history.sqlite", "apiConversationHistory:session", [{ ...api, usage: { ...api.usage, promptTokens: 101 } }]);
  sample = await collect(directory);
  assert.equal(sample.usages.filter(x => x.inputTokens !== undefined || x.outputTokens !== undefined).length, 0);
  assert.ok(sample.meta.gaps.some(x => x.messageDescriptor?.key === "diagnostics.sessions.parser.m017"));
}));

test("IDE 用量在工具行之后仍会发射，缓存明确零值保留且来源变更后旧证据失效", async () => fixture(async (directory, put) => {
  put("composer_data.sqlite", "composerData:session", { sessionId: "session", localMessages: [messages[0]!, messages[1]!,
    { ts: 1_780_000_002_000, say: "tool", chatId: "chat", text: JSON.stringify({ tool: "readFile", path: "src/example.ts" }) }] });
  const entry = history();
  entry.usage.cached_creation_input_tokens = 0;
  entry.usage.cached_read_input_tokens = 0;
  put("index.sqlite", "token_usage_history_session", [entry]);
  const sample = await collect(directory);
  assert.equal(sample.usages.length, 1);
  assert.equal(sample.usages[0]!.cachedInputTokens, 0);
  assert.equal(sample.messages.filter(x => x.kind === "assistant").length, 0);
  const snapshot = await readIdeSnapshot(source(directory)), row = snapshot.records.find(x => x.record.op === "request_usage")!;
  const reference = { ...source(directory), sourceId: "synthetic-source", recordLine: row.line, hash: createHash("sha256").update(row.raw).digest("hex") };
  assert.ok(await readHistoryEvidence(reference));
  put("index.sqlite", "token_usage_history_session", [{ ...entry, usage: { ...entry.usage, prompt_tokens: 110 } }]);
  assert.equal(await readHistoryEvidence(reference), undefined);
}));

test("IDE 原生缓存字段的两种拼写一致归一，不能用总量差额补推理输出", async () => fixture(async (directory, put) => {
  put("composer_data.sqlite", "composerData:session", { sessionId: "session", localMessages: messages });
  put("index.sqlite", "token_usage_history_session", [{ ...history(), usage: { prompt_tokens: 100, completion_tokens: 20,
    total_tokens: 150, cache_creation_input_tokens: 10, cache_read_input_tokens: 80 } }]);
  const sample = await collect(directory);
  assert.equal(sample.usages[0]!.outputTokens, 20);
  assert.equal(sample.usages[0]!.reasoningOutputTokens, undefined);
  assert.equal(sample.usages[0]!.cachedInputTokens, 80);
  assert.equal(sample.usages[0]!.cacheWriteTokens, 10);
}));

test("IDE 明确原生请求即使 Token 缺失也计步骤，m017 不阻断轮次边界", async () => fixture(async (directory, put) => {
  put("composer_data.sqlite", "composerData:session", { sessionId: "session", localMessages: messages });
  const sample = await collect(directory);
  assert.equal(sample.usages.length, 2);
  assert.ok(sample.usages.every(x => x.inputTokens === undefined && x.outputTokens === undefined));
  const { completeRoundSource, summarizeRoundMetrics, deriveRoundFacts } = await import("../src/sessions/round-metrics.js");
  assert.equal(completeRoundSource(sample.meta.gaps), true);
  assert.equal(summarizeRoundMetrics(sample.messages, sample.usages, completeRoundSource(sample.meta.gaps)).averageSteps, 2);
  assert.equal(deriveRoundFacts(sample.messages, sample.usages, true).rounds[0]!.tokens, null);
  assert.deepEqual(sample.usages.map(x => x.occurredAt), [new Date(messages[1]!.ts).toISOString(), new Date(messages[3]!.ts).toISOString()]);
}));

test("IDE 没有原生请求组的留存回复不补成模型步骤", async () => fixture(async (directory, put) => {
  put("composer_data.sqlite", "composerData:session", { sessionId: "session", localMessages: [messages[0]!, messages[2]!] });
  const sample = await collect(directory);
  const { completeRoundSource, summarizeRoundMetrics } = await import("../src/sessions/round-metrics.js");
  assert.equal(sample.usages.length, 0);
  const metrics = summarizeRoundMetrics(sample.messages, sample.usages, completeRoundSource(sample.meta.gaps));
  assert.equal(metrics.averageSteps, null);
  assert.equal(metrics.averageDurationMs, 2_000);
}));
