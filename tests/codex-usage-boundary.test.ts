import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";
import { parseSessionSource } from "../src/sessions/parser.js";
import { summarizeRoundMetrics } from "../src/sessions/round-metrics.js";
import { buildUsageReport } from "../src/usage/analytics.js";
import type { PricingStatus, RequestCost } from "../src/usage-contracts.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const record = (ordinal: number, type: string, payload: unknown) => ({ ordinal, type, timestamp: at(ordinal), payload });
const header = (cutoff: number, extra = {}) => record(0, "session_meta", { id: "child-fixture", session_id: "parent-fixture",
  parent_thread_id: "parent-fixture", subagent_history_start_ordinal: cutoff,
  source: { subagent: { thread_spawn: { parent_thread_id: "parent-fixture" } } }, ...extra });
const start = (ordinal: number, turn = "child-turn") => record(ordinal, "event_msg", { type: "task_started", turn_id: turn });
const context = (ordinal: number, turn = "child-turn") => record(ordinal, "turn_context", { model: "fixture-model", turn_id: turn });
const message = (ordinal: number, role: string, body: string) => record(ordinal, "response_item", { type: "message", id: `message-${ordinal}`,
  role, content: [{ type: role === "user" ? "input_text" : "output_text", text: body }] });
const completed = (ordinal: number, thread = "child-fixture", turn = "child-turn") => record(ordinal, "event_msg", {
  type: "item_completed", thread_id: thread, turn_id: turn, item: { type: "AgentMessage", id: `item-${ordinal}`, text: "合成回复" } });
const counted = (ordinal: number, input = 100) => record(ordinal, "event_msg", { type: "token_count", info: {
  total_token_usage: { input_tokens: input, output_tokens: 20, cached_input_tokens: 60, total_tokens: input + 20 },
  last_token_usage: { input_tokens: input, output_tokens: 20, cached_input_tokens: 60, total_tokens: input + 20 },
} });

async function parsed(records: unknown[]) {
  const directory = await mkdtemp(join(tmpdir(), "manor-codex-boundary-"));
  const path = join(directory, "fixture.jsonl");
  const messages = new Map<string, SessionMessage>();
  const usages = new Map<string, SessionUsage>();
  try {
    await writeFile(path, records.map(value => `${JSON.stringify(value)}\n`).join(""));
    const meta = await parseSessionSource({ path, client: "codex", sessionId: "child-fixture" }, {
      message: value => { messages.set(value.id, value); }, usage: value => { usages.set(value.id, value); },
    });
    return { meta, messages: [...messages.values()], usages: [...usages.values()] };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("Codex 分页子历史重新编号后，自身线程确认的轮次与用量不被复制边界排除", async () => {
  const sample = await parsed([header(16), start(1), context(2), message(3, "user", "合成子任务"),
    message(4, "assistant", "合成回复"), completed(5), counted(6)]);
  assert.equal(sample.usages.length, 1);
  assert.equal(sample.usages[0]?.inputTokens, 100);
  assert.equal(sample.messages.find(value => value.kind === "user")?.copied, undefined);
  assert.equal(sample.meta.title, "合成子任务");
  const rounds = summarizeRoundMetrics(sample.messages, sample.usages);
  assert.equal(rounds.averageSteps, 1);
  assert.equal(rounds.averageDurationMs, 1_000);
});

test("Codex 自身执行起点之前的明确父历史仍被排除，不能重复计入父请求", async () => {
  const sample = await parsed([header(20), start(1, "parent-turn"), context(2, "parent-turn"),
    message(3, "user", "合成父请求"), message(4, "assistant", "合成父回复"), completed(5, "parent-fixture", "parent-turn"), counted(6, 300),
    start(7), context(8), message(9, "user", "合成子请求"), message(10, "assistant", "合成子回复"), completed(11), counted(12)]);
  assert.equal(sample.usages.length, 1);
  assert.equal(sample.usages[0]?.inputTokens, 100);
  assert.equal(sample.messages.find(value => value.text === "合成父请求")?.copied, true);
  assert.equal(sample.messages.find(value => value.text === "合成子请求")?.copied, undefined);
  assert.equal(sample.meta.title, "合成子请求");
  assert.deepEqual(sample.meta.contextSnapshots?.map(snapshot => snapshot.usedTokens), [120], "父历史的上下文快照也必须排除");
});

test("Codex 真正分叉的父历史边界与身份保持不变", async () => {
  const sample = await parsed([record(0, "session_meta", { id: "child-fixture", history_base: { thread_id: "parent-fixture", end_ordinal_exclusive: 10 } }),
    start(1, "parent-turn"), context(2, "parent-turn"), message(3, "user", "合成父请求"),
    completed(4, "parent-fixture", "parent-turn"), counted(5, 300), start(10), context(11), message(12, "user", "合成分叉请求"),
    message(13, "assistant", "合成分叉回复"), completed(14), counted(15)]);
  assert.equal(sample.meta.relationship, "fork");
  assert.equal(sample.usages.length, 1);
  assert.equal(sample.usages[0]?.inputTokens, 100);
  assert.equal(sample.messages.find(value => value.text === "合成父请求")?.copied, true);
});

test("Codex 父线程事件或无法关联执行起点的自身事件不能推翻复制边界", async () => {
  const parent = await parsed([header(20), start(1), context(2), message(3, "user", "合成父请求"),
    completed(4, "parent-fixture"), counted(5)]);
  assert.equal(parent.usages.length, 0);
  assert.equal(parent.messages.find(value => value.kind === "user")?.copied, true);
  const unlinked = await parsed([header(20), message(1, "user", "合成未知请求"), completed(2), counted(3)]);
  assert.equal(unlinked.usages.length, 0);
  assert.equal(unlinked.messages.find(value => value.kind === "user")?.copied, true);
});

test("Codex 缺少 task_started 时仍可用原生 turn_context 关联自身执行起点", async () => {
  const sample = await parsed([header(20), context(1), message(2, "user", "合成请求"),
    message(3, "assistant", "合成回复"), completed(4), counted(5)]);
  assert.equal(sample.usages.length, 1);
  assert.equal(sample.messages.find(value => value.kind === "user")?.copied, undefined);
});

test("Codex 原生请求用量记录也可通过明确线程和轮次身份确认自身执行", async () => {
  const sample = await parsed([header(20), context(1), message(2, "user", "合成请求"), message(3, "assistant", "合成回复"),
    record(4, "token_usage_record", { thread_id: "child-fixture", turn_id: "child-turn", response_id: "fixture-response",
      usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 60 },
      thread_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 60 } })]);
  assert.equal(sample.usages.length, 1);
  assert.equal(sample.usages[0]?.inputTokens, 100);
  assert.equal(sample.messages.find(value => value.kind === "user")?.copied, undefined);
});

test("Codex 首轮只有工具请求时，后续自身轮次或未关联事件不覆盖最早执行边界", async () => {
  const sample = await parsed([header(30), start(1, "parent-turn"), context(2, "parent-turn"),
    record(3, "event_msg", { type: "user_message", message: "合成父请求" }), completed(4, "parent-fixture", "parent-turn"), counted(5, 300),
    start(6, "first-own-turn"), context(7, "first-own-turn"),
    record(8, "response_item", { type: "function_call", id: "fixture-call", call_id: "fixture-call", name: "fixture_tool", arguments: "{}" }),
    completed(9, "child-fixture", "first-own-turn"), counted(10),
    record(11, "response_item", { type: "function_call_output", call_id: "fixture-call", output: "合成工具结果" }),
    start(12, "second-own-turn"), context(13, "second-own-turn"), completed(14, "child-fixture", "second-own-turn"),
    completed(15, "child-fixture", "unlinked-turn"), message(16, "assistant", "合成最终回复"), counted(17, 500)]);
  assert.equal(sample.usages.length, 2);
  assert.deepEqual(sample.usages.map(value => value.inputTokens), [100, 500]);
  assert.equal(sample.messages.find(value => value.kind === "tool_call")?.copied, undefined);
  assert.equal(sample.messages.find(value => value.kind === "system" && value.recordLine === 6), undefined,
    "父用量不生成自身用量定位消息");
});

const snapshot = (extra = {}) => ({ thread_id: "child-fixture", turn_id: "prior-own-turn", response_id: "prior-response",
  usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 60 },
  thread_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 60 }, ...extra });
const compacted = (ordinal: number, value: unknown) => record(ordinal, "compacted", { message: "合成压缩摘要", latest_token_usage_record: value });

test("Codex 压缩后仅留最近请求快照时恢复自身用量，不补造时间、模型或轮次", async () => {
  const sample = await parsed([header(20), compacted(1, snapshot()), compacted(2, snapshot())]);
  assert.equal(sample.usages.length, 1);
  const value = sample.usages[0]!;
  assert.equal(value.inputTokens, 100);
  assert.equal(value.outputTokens, 20);
  assert.equal(value.cachedInputTokens, 60);
  assert.equal(value.occurredAt, undefined);
  assert.equal(value.model, undefined);
  assert.equal(value.turnId, undefined);
  assert.equal(sample.messages.find(row => row.id === value.messageId)?.recordLine, 2, "定位原快照记录而不是历史末行");
  assert.equal(sample.messages.find(row => row.id === value.messageId)?.occurredAt, undefined);
  const pricing: PricingStatus = { version: "fixture-prices", source: "bundled", sourceUrl: "https://example.invalid/prices", refreshing: false,
    currency: "USD", prices: [], configuration: { overrides: [], mappings: [] } };
  const missing: RequestCost = { amount: null, coverage: "missing" };
  const report = buildUsageReport({ version: "fixture-index", sessions: [sample.meta], requests: [{ sessionId: sample.meta.id, usage: value }] },
    { from: "2026-01-01", to: "2026-01-01" }, pricing, () => missing);
  assert.equal(report.totals.requests, 0);
  assert.equal(report.undated.requests, 1);
  assert.equal(report.undated.tokens, 120);
});

test("Codex 快照在完整原生记录之前或之后出现时不重复计数且不覆盖完整请求", async () => {
  const full = record(4, "token_usage_record", snapshot({ model: "snapshot-ignored", timestamp: at(4) }));
  const old = snapshot({ usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 }, model: "old-snapshot" });
  for (const records of [[compacted(1, old), context(2, "prior-own-turn"), message(3, "user", "合成请求"), full],
    [context(1, "prior-own-turn"), message(2, "user", "合成请求"), full, compacted(5, old)]]) {
    const sample = await parsed([header(0), ...records]);
    assert.equal(sample.usages.length, 1);
    assert.equal(sample.usages[0]?.inputTokens, 100);
    assert.equal(sample.usages[0]?.model, "fixture-model");
    assert.equal(sample.usages[0]?.occurredAt, at(4));
  }
});

test("Codex 已保存旧式投影的完整累计进度与单次分项吻合时不重复恢复快照", async () => {
  const projected = counted(4);
  const matching = snapshot({ usage: projected.payload.info.last_token_usage, thread_token_usage: projected.payload.info.total_token_usage });
  const sample = await parsed([header(0), context(1, "prior-own-turn"), message(2, "user", "合成请求"),
    message(3, "assistant", "合成回复"), projected, compacted(5, matching)]);
  assert.equal(sample.usages.length, 1);
  assert.equal(sample.usages[0]?.inputTokens, 100);
  assert.equal(sample.usages[0]?.occurredAt, at(4));
});

test("Codex 父线程、缺失响应身份或没有有效用量分项的压缩快照不生成自身请求", async () => {
  const sample = await parsed([header(20), compacted(1, snapshot({ thread_id: "parent-fixture" })),
    compacted(2, snapshot({ response_id: undefined })), compacted(3, snapshot({ usage: { total_tokens: 100 } }))]);
  assert.equal(sample.usages.length, 0);
});

test("Codex 快照自身保存的模型时间及可关联原生轮次可保留", async () => {
  const sample = await parsed([header(0), context(1, "prior-own-turn"), message(2, "user", "合成请求"),
    compacted(3, snapshot({ model: "recorded-snapshot-model", timestamp: at(2), model_provider: "fixture-provider" }))]);
  assert.equal(sample.usages.length, 1);
  assert.equal(sample.usages[0]?.model, "recorded-snapshot-model");
  assert.equal(sample.usages[0]?.occurredAt, at(2));
  assert.equal(sample.usages[0]?.provider, "fixture-provider");
  assert.equal(sample.usages[0]?.turnId, sample.messages.find(value => value.kind === "user")?.turnId);
});
