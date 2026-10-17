import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseSource } from "../src/history/index.js";
import { doubaoWorkAdapter } from "../src/history/adapters/doubao-work.js";
import { normalizedSnapshot, type NormalizedSnapshot } from "../src/history/adapters/normalized.js";
import { parseSessionSource } from "../src/sessions/parser.js";
import { SessionStore } from "../src/sessions/store.js";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";
import { writeDoubaoWorkCache } from "./helpers/doubao-work-store.js";

const text = (id: string, value: string, parent = "0") => ({ block_id: id, parent_id: parent, block_type: 10000, content: { text_block: { text: value } } });
const nativeMessage = (id: string, role: number, ordinal: number, blocks: unknown[], ext: Record<string, unknown> = {}) => ({
  message_id: id, user_type: role, index_in_conv: String(ordinal), create_time: "1700000000", content_block: blocks,
  ...(role === 2 ? { bot_reply_message_id: "u" } : {}), ext,
});
const response = (messages: unknown[]) => ({ downlink_body: { pull_recent_conv_chain_downlink_body: {
  cells: [{ conversation: { conversation_id: "synthetic-model-session", name: "Synthetic model selection", messages } }],
} } });
const selection = (value: unknown, label: unknown = "Model") => ({ items: [{ label, value }] });
const answerBlocks = [
  { block_id: "process", parent_id: "0", block_type: 10040, content: { thinking_block: { finish_title: "Synthetic process" } } },
  text("thinking", "Synthetic reasoning", "process"),
  { block_id: "operation", parent_id: "process", block_type: 10019, content: { file_operation_block: {
    operation_type: 1, path: "/synthetic/project/file.txt", header: { summary: "Read synthetic file" }, content: "Synthetic source",
  } } },
  text("answer", "Synthetic answer"),
];

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-doubao-models-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function cache(directory: string, replies: { model?: unknown; extra?: Record<string, unknown>; blocks?: unknown[] }[], userModel?: unknown) {
  return writeDoubaoWorkCache(join(directory, "launcher.leveldb"), [{ account: "DoubaoPC_synthetic", value: response([
    nativeMessage("u", 1, 1, [text("question", "Synthetic question")], { commerce_model_data_v1: userModel }),
    ...replies.map((reply, i) => nativeMessage(`a-${i}`, 2, i + 2, reply.blocks ?? answerBlocks,
      { commerce_model_data_v1: reply.model, ...reply.extra })),
  ]) }]);
}

async function read(path: string) {
  const source = (await doubaoWorkAdapter.discoverFile!({ client: "doubao-work", path, format: doubaoWorkAdapter.id }))[0]!;
  const messages = new Map<string, SessionMessage>();
  const usages: SessionUsage[] = [];
  const meta = await parseSessionSource(source, { message: value => messages.set(value.id, value), usage: value => usages.push(value) });
  return { source, messages: [...messages.values()], usages, meta };
}

test("豆包原生 Auto 和明确模型名进入模型消息与共享画像，不制造请求或用量", async () => temporary(async directory => {
  const path = await cache(directory, [
    { model: selection("Auto") },
    { model: JSON.stringify(selection("Synthetic Model 2 Lite 高")) },
  ], selection("Synthetic user selection"));
  const { source, messages, usages, meta } = await read(path);
  assert.deepEqual(meta.models, ["Auto", "Synthetic Model 2 Lite 高"]);
  assert.deepEqual(messages.filter(message => message.model).map(message => [message.kind, message.model]), [
    ["thinking", "Auto"], ["assistant", "Auto"],
    ["thinking", "Synthetic Model 2 Lite 高"], ["assistant", "Synthetic Model 2 Lite 高"],
  ]);
  assert.ok(messages.filter(message => !["thinking", "assistant"].includes(message.kind)).every(message => message.model === undefined));
  assert.deepEqual(usages, []);
  assert.equal(meta.usageReports, undefined);
  const native = await parseSource(path, "doubao-work", undefined, doubaoWorkAdapter.id, { location: source });
  assert.deepEqual(native.events, []);
  assert.deepEqual(native.relationships, []);

  const store = new SessionStore(join(directory, "sessions.sqlite"));
  try {
    const pending = store.createRevision(path, "synthetic-models");
    const storedMeta = await parseSessionSource(source, pending.sink);
    pending.flush(); store.finishRevision(pending.revision, storedMeta);
    store.publish(store.createJob().id, [{ path, revision: pending.revision, fingerprint: "synthetic-models" }], []);
    const profile = store.profile(storedMeta.id);
    assert.deepEqual(profile.models, [{ model: "Auto", count: 2 }, { model: "Synthetic Model 2 Lite 高", count: 2 }]);
    assert.equal(profile.usage.requests, 0);
    assert.equal(profile.usage.inputTokens, null);
    assert.equal(profile.usage.outputTokens, null);
    assert.equal(profile.usageReports, undefined);
    assert.deepEqual(profile.steps, []);
  } finally { store.close(); }
}));

test("豆包模型展示字段拒绝坏 JSON、歧义、非文本与未知数值类型", async () => temporary(async directory => {
  const invalid: unknown[] = [undefined, null, "{bad", "[]", [], {}, { label: "Model", value: "Auto" },
    { items: null }, { items: {} }, { items: [] }, { items: [{ label: "Model", value: "Auto" }, { label: "Model", value: "Other" }] },
    { items: [{ label: "Model", value: "Auto" }, { label: "", value: "" }] },
    selection(""), selection("   "), selection(38), selection("38"), selection("+38"), selection("38.5"),
    selection("Synthetic model", " "), selection("Synthetic model", 38), selection({ name: "Synthetic model" }),
    selection("x".repeat(201)), selection("Synthetic\nmodel"), selection("Synthetic\0model")];
  const path = await cache(directory, invalid.map(model => ({ model, extra: { model_id: 38, llm_model_type: 38, model_type: 38 } })), selection("Auto"));
  const { messages, meta, usages } = await read(path);
  assert.deepEqual(meta.models, []);
  assert.ok(messages.every(message => message.model === undefined));
  assert.deepEqual(usages, []);
}));

test("豆包每条回复只使用自己的模型展示，未知角色与普通上下文不继承", async () => temporary(async directory => {
  const path = await writeDoubaoWorkCache(join(directory, "launcher.leveldb"), [{ account: "DoubaoPC_synthetic", value: response([
    nativeMessage("u", 1, 1, [text("question", "Synthetic question")], { commerce_model_data_v1: selection("User only") }),
    nativeMessage("a-1", 2, 2, answerBlocks, { commerce_model_data_v1: selection("Auto") }),
    nativeMessage("a-2", 2, 3, [text("answer", "Unreported model")]),
    nativeMessage("a-3", 2, 4, [], { commerce_model_data_v1: selection("  Synthetic Model 3  ") }),
    nativeMessage("other", 3, 5, [text("context", "Unknown role")], { commerce_model_data_v1: selection("Other role") }),
  ]) }]);
  const { messages, meta } = await read(path);
  assert.deepEqual(meta.models, ["Auto", "Synthetic Model 3"]);
  assert.equal(messages.find(message => message.text === "Unreported model")?.model, undefined);
  assert.equal(messages.find(message => message.text === "Unknown role")?.model, undefined);
  assert.equal(messages.find(message => message.kind === "assistant" && message.text === "")?.model, "Synthetic Model 3");
}));

test("豆包模型规范化参与哈希，旧版无模型快照与原生模型变化均重新解析", async () => temporary(async directory => {
  const path = await cache(directory, [{ model: selection("Auto") }]);
  const first = await read(path);
  const current = await doubaoWorkAdapter.readRecords!(first.source) as NormalizedSnapshot;
  const events = current.records.filter(row => row.record.normalizedEvent);
  const raw = JSON.parse(events[0]!.raw) as { conversation: Record<string, unknown> };
  const nativeMessages = new Map(events.map(row => [row.line, (JSON.parse(row.raw) as { message: unknown }).message]));
  const fingerprint = JSON.stringify({ ...raw.conversation, messages: [...nativeMessages.values()] });
  const rows = events.map(row => {
    const event = { ...(row.record.normalizedEvent as Record<string, unknown>) };
    delete event.model;
    return { ...row, record: { normalizedEvent: event } };
  });
  assert.equal(normalizedSnapshot(current.source, events, current.meta, fingerprint).hash, current.hash);
  const old = normalizedSnapshot(current.source, rows, current.meta, fingerprint);
  assert.notEqual(current.hash, old.hash);
  assert.ok(current.records.some(row => (row.record.normalizedEvent as { model?: string } | undefined)?.model === "Auto"));
  const parsed = await parseSource(path, "doubao-work", undefined, doubaoWorkAdapter.id, { location: first.source });
  const upgraded = await parseSource(path, "doubao-work", { ...parsed, hash: old.hash }, doubaoWorkAdapter.id, { location: first.source });
  assert.ok((upgraded.cursor as { parsedRecords: number }).parsedRecords > 0, "原始缓存未变时也不复用旧版无模型规范化结果");
  await cache(directory, [{ model: selection("Synthetic Model 4") }]);
  const changed = await read(path);
  const next = await doubaoWorkAdapter.readRecords!(changed.source);
  assert.notEqual(next.hash, current.hash);
  assert.notEqual(changed.source.sourceCompleteness?.fingerprint, first.source.sourceCompleteness?.fingerprint);
  assert.deepEqual(changed.meta.models, ["Synthetic Model 4"]);
  const refreshed = await parseSource(path, "doubao-work", parsed, doubaoWorkAdapter.id, { location: changed.source });
  assert.ok((refreshed.cursor as { parsedRecords: number }).parsedRecords > 0);
  assert.deepEqual(refreshed.events, []);
}));
