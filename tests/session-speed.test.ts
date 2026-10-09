import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Client } from "../src/contracts.js";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";
import { requestSpeed, summarizeRequestSpeed } from "../src/session-speed.js";
import { parseSessionSource } from "../src/sessions/parser.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const timed = (record: unknown, seconds: number) => ({ ...record as object, timestamp: at(seconds) });
const cUser = (seconds = 0, id = "user") => timed({ type: "response_item", payload: { type: "message", role: "user", id,
  content: [{ type: "input_text", text: "合成请求" }] } }, seconds);
const cModel = (id: string, seconds: number, final = false) => timed({ type: "response_item", payload: { type: "message", id,
  role: "assistant", phase: final ? "final_answer" : "commentary", content: [{ type: "output_text", text: "合成响应" }] } }, seconds);
const cThinking = (id: string, seconds: number) => timed({ type: "response_item", payload: { type: "reasoning", id,
  summary: [{ type: "summary_text", text: "合成思考" }] } }, seconds);
const cCall = (id: string, seconds: number) => timed({ type: "response_item", payload: { type: "function_call", id: `call-${id}`,
  call_id: id, name: "fixture_tool", arguments: "{}" } }, seconds);
const cResult = (id: string, seconds: number) => timed({ type: "response_item", payload: { type: "function_call_output",
  id: `result-${id}`, call_id: id, output: "合成结果" } }, seconds);
const tokenValues = (output: number, input = 100) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: 0 });
const cUsage = (id: string, seconds: number, output = 400, total = output) => timed({ type: "token_usage_record", payload: {
  response_id: id, usage: tokenValues(output), thread_token_usage: tokenValues(total, total) } }, seconds);
const cCount = (seconds: number, output = 400, total = output) => timed({ type: "event_msg", payload: { type: "token_count",
  info: { last_token_usage: tokenValues(output, output === 0 && total === 0 ? 0 : 100), total_token_usage: tokenValues(total, total) } } }, seconds);
const textBlock = { type: "text", text: "合成响应" };
const native = (client: "claude" | "codeflicker", id: string, role: string, seconds: number, content: unknown,
  output?: number, request = id, extra: Record<string, unknown> = {}) => timed(client === "claude"
  ? { type: role, uuid: id, sessionId: "synthetic-session", message: { id: request, role, model: "fixture-model", content,
    usage: output === undefined ? undefined : { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output }, ...extra } }
  : { type: "message", uuid: id, sessionId: "synthetic-session", role, model: "fixture-model", content,
    usage: output === undefined ? undefined : tokenValues(output), metadata: { requestTokenBaseline: { requestId: request } }, ...extra }, seconds);

async function parsed(client: Client, records: unknown[]) {
  const directory = await mkdtemp(join(tmpdir(), "manor-request-speed-"));
  const path = join(directory, "fixture.jsonl");
  const messages = new Map<string, SessionMessage>();
  const usages = new Map<string, SessionUsage>();
  try {
    await writeFile(path, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    await parseSessionSource({ client, path, sessionId: "synthetic-session" }, {
      message: message => { messages.set(message.id, message); }, usage: usage => { usages.set(usage.id, usage); },
    });
    return { messages: [...messages.values()], usages: [...usages.values()] };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const sampleUsage = (id: string, outputTokens = 200, durationMs = 1000): SessionUsage => ({ id, outputTokens,
  timing: { basis: "estimated", method: "codex_event_boundary", completion: "inferred", durationMs } });

test("单请求门槛包含等号，并分别保留缺失、无效、短响应与终态原因", () => {
  assert.equal(requestSpeed(sampleUsage("equal")).tokensPerSecond, 200);
  assert.equal(requestSpeed(sampleUsage("output-low", 199)).reason, "output_below_threshold");
  assert.equal(requestSpeed(sampleUsage("output-high", 201)).tokensPerSecond, 201);
  assert.equal(requestSpeed(sampleUsage("time-low", 200, 999)).reason, "duration_below_threshold");
  assert.ok(requestSpeed(sampleUsage("time-high", 200, 1001)).tokensPerSecond);
  assert.equal(requestSpeed({ id: "old", outputTokens: 400 }).reason, "timing_missing");
  assert.equal(requestSpeed({ ...sampleUsage("missing"), outputTokens: undefined }).reason, "output_missing");
  assert.equal(requestSpeed(sampleUsage("inverse", 400, -1000)).reason, "invalid_timing");
  assert.equal(requestSpeed({ ...sampleUsage("partial"), timing: { ...sampleUsage("partial").timing!, completion: "partial" } }).reason, "partial_response");
  assert.equal(requestSpeed({ ...sampleUsage("unknown"), timing: { ...sampleUsage("unknown").timing!, completion: "unknown" } }).reason, "end_unconfirmed");
});

test("平均值按合格子集的原始输出与耗时加权，重复请求与缺失记录不造零值", () => {
  const first = sampleUsage("one", 480, 12_000);
  const second = sampleUsage("two", 600, 30_000);
  const summary = summarizeRequestSpeed([first, first, second, { id: "missing" }]);
  assert.deepEqual(summary, { requests: 3, eligibleRequests: 2, outputTokens: 1080, durationMs: 42000,
    tokensPerSecond: 1080 / 42 });
  assert.deepEqual(summarizeRequestSpeed([{ id: "missing" }]), { requests: 1, eligibleRequests: 0,
    outputTokens: null, durationMs: null, tokensPerSecond: null });
});

test("Codex 模型片段归组，工具响应独立完成，后续工具等待不并入请求", async () => {
  const sample = await parsed("codex", [cUser(), cThinking("thinking-one", 1), cModel("comment-one", 2), cCall("tool", 3),
    cUsage("request-one", 3.2), cResult("tool", 20), timed({ type: "turn_context", payload: { model: "fixture-model" } }, 20.1),
    cThinking("thinking-two", 21), cModel("answer", 30, true), cUsage("request-two", 30.3, 600, 1000), cCount(30.4, 600, 1000)]);
  assert.equal(sample.usages.length, 2);
  assert.equal(sample.usages[0]?.timing?.completionEvidence, "tool_response_snapshot");
  assert.equal(sample.usages[0]?.timing?.durationMs, 3200);
  assert.equal(sample.usages[1]?.timing?.durationMs, 10200);
  assert.equal(sample.usages[0]?.requestMessageIds?.length, 2);
  assert.equal(sample.usages[1]?.requestMessageIds?.length, 2);
  assert.ok(sample.usages.every(usage => sample.messages.find(message => message.id === usage.messageId)?.kind === "system"));
  assert.ok(sample.usages.flatMap(usage => usage.requestMessageIds ?? []).every(id => ["assistant", "thinking"].includes(sample.messages.find(message => message.id === id)!.kind)));
  assert.equal(summarizeRequestSpeed(sample.usages).eligibleRequests, 2);
});

test("Codex 旧用量延迟到工具返回后，模型结束点回到最后助手项且等待下一批工具齐备", async () => {
  const sample = await parsed("codex", [cUser(), cCall("one", 3), cCall("two", 3.1), cResult("one", 50),
    cCount(50.005), cResult("two", 60), cModel("answer", 70, true), cCount(70.1, 600, 1000)]);
  assert.equal(sample.usages.length, 2);
  assert.equal(sample.usages[0]?.timing?.completionEvidence, "tool_result");
  assert.equal(sample.usages[0]?.timing?.durationMs, 3100);
  assert.equal(sample.usages[0]?.timing?.end?.recordLine, 3);
  assert.equal(sample.messages.find(message => message.id === sample.usages[0]?.timing?.end?.messageId)?.kind, "tool_call",
    "延迟用量不能覆盖排除工具等待时采用的模型结束记录");
  assert.equal(sample.usages[1]?.timing?.durationMs, 10100);
  assert.equal(sample.usages[1]?.timing?.start?.recordLine, 6);
});

test("Codex 投影去重的两个顺序保留原用量定位，不延长后续请求的计时", async () => {
  for (const values of [[cCount(10), cUsage("one", 10.1)], [cUsage("one", 10), cCount(10.1)]]) {
    const sample = await parsed("codex", [cUser(), cModel("answer", 9, true), ...values,
      cUser(20, "next"), cModel("second", 30, true), cUsage("two", 30, 400, 800)]);
    assert.equal(sample.usages.length, 2);
    assert.equal(sample.usages[0]?.timing?.durationMs, 10000);
    assert.equal(sample.messages.find(message => message.id === sample.usages[0]?.messageId)?.recordLine, 3);
    assert.equal(sample.usages[0]?.timing?.end?.messageId, sample.usages[0]?.messageId, "结束边界可定位到原用量记录");
    assert.equal(sample.usages[1]?.timing?.durationMs, 10000);
  }
});

test("Codex 现代与旧用量结束边界保留真实记录定位，未保存的上下文不补造消息身份", async () => {
  for (const count of [cUsage("one", 10), cCount(10)]) {
    const sample = await parsed("codex", [cUser(), timed({ type: "turn_context", payload: { model: "fixture-model" } }, 1),
      cModel("answer", 9, true), count]);
    const request = sample.usages[0]!;
    assert.equal(request.timing?.durationMs, 9000);
    assert.equal(request.timing?.start?.recordLine, 2);
    assert.equal(request.timing?.start?.messageId, undefined, "没有消息的上下文边界只保留来源行号");
    assert.ok(request.timing?.end?.messageId);
    assert.equal(request.timing?.end?.messageId, request.messageId);
    const end = sample.messages.find(message => message.id === request.timing?.end?.messageId);
    assert.equal(end?.kind, "system");
    assert.equal(end?.recordLine, 4);
    assert.equal(end?.occurredAt, request.timing?.end?.occurredAt);
  }
});

test("Codex 相同输出的不同请求分别统计，重复明确身份不改轮次关联", async () => {
  const sample = await parsed("codex", [cUser(), cModel("one", 10, true), cUsage("one", 10), cUser(20, "next"),
    cUsage("one", 20.1), cModel("two", 30, true), cUsage("two", 30, 400, 800)]);
  assert.equal(sample.usages.length, 2);
  assert.notEqual(sample.usages[0]?.id, sample.usages[1]?.id);
  assert.notEqual(sample.usages[0]?.turnId, sample.usages[1]?.turnId);
  assert.equal(sample.usages[0]?.turnId, sample.messages[0]?.turnId);
  const unpaired = await parsed("codex", [cUsage("old", 0), cUser(20), cModel("new", 30, true), cUsage("old", 31)]);
  assert.equal(unpaired.usages.length, 2);
  assert.equal(unpaired.usages[0]?.requestMessageIds, undefined, "没有响应项的旧用量投影不能配给后面的模型请求");
  assert.equal(unpaired.usages[1]?.outputTokens, undefined);
});

test("Codex 未知结束和被中断的模型调用排除，已完成的工具请求不受轮次中断影响", async () => {
  const sample = await parsed("codex", [cUser(), cCall("finished", 3), cUsage("finished", 3), cResult("finished", 10),
    cThinking("partial", 12), cUsage("partial", 13, 500, 900), timed({ type: "event_msg", payload: { type: "turn_aborted" } }, 14)]);
  assert.equal(sample.usages.length, 2);
  assert.ok(requestSpeed(sample.usages[0]!).tokensPerSecond);
  assert.equal(sample.usages[1]?.timing?.completion, "partial");
  assert.equal(requestSpeed(sample.usages[1]!).reason, "partial_response");
  const unknown = await parsed("codex", [cUser(), cModel("comment", 10), cUsage("unknown", 10)]);
  assert.equal(requestSpeed(unknown.usages[0]!).reason, "end_unconfirmed");
});

test("Codex 无用量的已识别模型请求保留分母，复制与压缩零重置不新增请求", async () => {
  const copied = await parsed("codex", [timed({ type: "session_meta", ordinal: 0,
    payload: { id: "synthetic-session", history_base: { thread_id: "synthetic-parent", end_ordinal_exclusive: 10 } } }, 0),
    { ...cUser(0, "copied"), ordinal: 1 }, { ...cModel("copy-answer", 3, true), ordinal: 2 },
    { ...cUsage("copied", 3), ordinal: 3 }, { ...cUser(10, "own"), ordinal: 10 },
    { ...cModel("own-answer", 13, true), ordinal: 11 }, { ...cUsage("own", 13), ordinal: 12 }]);
  assert.equal(copied.usages.length, 1);
  const missing = await parsed("codex", [cUser(), cThinking("thinking", 1), cModel("comment", 2), cCall("request", 3), cResult("request", 10)]);
  assert.equal(missing.usages.length, 1);
  assert.equal(requestSpeed(missing.usages[0]!).reason, "output_missing");
  assert.equal(missing.usages[0]?.messageId, undefined, "未保存用量的请求不能把模型片段当作原用量记录");
  assert.equal(missing.usages[0]?.requestMessageIds?.length, 2, "缺失用量不丢弃已确认的模型消息组关联");
  assert.equal(missing.messages.filter(message => message.kind === "system").length, 0, "不为缺失用量制造原用量事件");
  assert.equal(summarizeRequestSpeed(missing.usages).requests, 1, "缺失请求仍保留在覆盖分母中");
  const reset = await parsed("codex", [cUser(), cModel("one", 3, true), cCount(3),
    timed({ type: "compacted", payload: { message: "合成压缩摘要" } }, 4), cCount(4.1, 0, 0),
    cUser(5, "next"), cModel("two", 8, true), cCount(8, 400, 400)]);
  assert.equal(reset.usages.length, 2);
  assert.equal(summarizeRequestSpeed(reset.usages).eligibleRequests, 2);
});

test("Claude 同 message.id 多块只用最终快照，明确工具结束不要求轮最终回答", async () => {
  const tool = { type: "tool_use", id: "fixture-call", name: "fixture_tool", input: {} };
  const sample = await parsed("claude", [native("claude", "user", "user", 0, "合成请求"),
    native("claude", "thinking", "assistant", 2, [{ type: "thinking", thinking: "合成思考" }], 50, "one"),
    native("claude", "text", "assistant", 8, [textBlock], 200, "one"),
    native("claude", "call", "assistant", 10, [tool], 400, "one", { stop_reason: "tool_use" }),
    native("claude", "result", "user", 50, [{ type: "tool_result", tool_use_id: "fixture-call", content: "合成失败", is_error: true }]),
    native("claude", "final", "assistant", 60, [textBlock], 600, "two", { stop_reason: "end_turn" })]);
  assert.equal(sample.usages.length, 2);
  assert.equal(sample.usages[0]?.outputTokens, 400);
  assert.equal(sample.usages[0]?.requestMessageIds?.length, 2);
  assert.equal(sample.usages[0]?.timing?.durationMs, 10000);
  assert.equal(sample.usages[0]?.timing?.completion, "explicit");
  assert.equal(sample.usages[1]?.timing?.durationMs, 10000);
  assert.equal(summarizeRequestSpeed(sample.usages).eligibleRequests, 2);
});

test("Claude 缺少 stop_reason 时只有实际配对工具结果才能推断结束", async () => {
  const call = native("claude", "call", "assistant", 3, [{ type: "tool_use", id: "tool", name: "fixture_tool", input: {} }], 400);
  const sample = await parsed("claude", [native("claude", "user", "user", 0, "合成请求"), call,
    native("claude", "result", "user", 30, [{ type: "tool_result", tool_use_id: "tool", content: "合成结果" }])]);
  assert.equal(sample.usages[0]?.timing?.completionEvidence, "tool_result");
  assert.equal(sample.usages[0]?.timing?.durationMs, 3000);
  const unknown = await parsed("claude", [native("claude", "user", "user", 0, "合成请求"),
    native("claude", "answer", "assistant", 10, [textBlock], 400)]);
  assert.equal(requestSpeed(unknown.usages[0]!).reason, "end_unconfirmed");
});

test("Claude 明确关联的取消记录剔除部分响应，不将工具超时等同于模型取消", async () => {
  const answer = native("claude", "answer", "assistant", 10, [textBlock], 400, "one", { stop_reason: "end_turn" });
  const cancelled = await parsed("claude", [native("claude", "user", "user", 0, "合成请求"), answer,
    { type: "system", uuid: "interruption", sessionId: "synthetic-session", interruptedMessageId: "answer", timestamp: at(11) }]);
  assert.equal(requestSpeed(cancelled.usages[0]!).reason, "partial_response");
  const missing = await parsed("claude", [native("claude", "user", "user", 0, "合成请求"),
    native("claude", "answer", "assistant", 10, [textBlock], undefined, "one", { stop_reason: "end_turn" })]);
  assert.equal(missing.usages.length, 1);
  assert.equal(requestSpeed(missing.usages[0]!).reason, "output_missing");
  assert.equal(missing.usages[0]?.messageId, undefined);
  assert.equal(missing.usages[0]?.requestMessageIds?.length, 1);
  const finished = await parsed("claude", [native("claude", "user", "user", 0, "合成请求"),
    native("claude", "call", "assistant", 3, [{ type: "tool_use", id: "tool", name: "fixture_tool", input: {} }], 400, "one", { stop_reason: "tool_use" }),
    { ...native("claude", "result", "user", 30, [{ type: "tool_result", tool_use_id: "tool", content: "工具超时" }]),
      toolUseResult: { interrupted: true, timedOutAfterMs: 5000 } }]);
  assert.equal(finished.usages[0]?.timing?.completion, "explicit");
  assert.ok(requestSpeed(finished.usages[0]!).tokensPerSecond);
});

test("Claude 未知中断目标不影响已完成请求或当前其他请求，无目标中断保留已完成请求", async () => {
  const user = native("claude", "user", "user", 0, "合成请求");
  const finished = native("claude", "finished", "assistant", 10, [textBlock], 400, "one", { stop_reason: "end_turn" });
  const unknownTarget = { type: "system", uuid: "interruption", sessionId: "synthetic-session",
    interruptedMessageId: "unrecorded-target", timestamp: at(21) };
  const completed = await parsed("claude", [user, finished, unknownTarget]);
  assert.equal(completed.usages[0]?.timing?.completion, "explicit");
  assert.equal(requestSpeed(completed.usages[0]!).tokensPerSecond, 40);
  const active = await parsed("claude", [user, finished,
    native("claude", "current", "assistant", 20, [textBlock], 400, "two"), unknownTarget]);
  assert.equal(active.usages[0]?.timing?.completion, "explicit");
  assert.equal(active.usages[1]?.timing?.completion, "unknown", "不将其他请求的未知结束伪装为中断");
  assert.equal(active.usages[1]?.timing?.durationMs, 10000);
  assert.equal(requestSpeed(active.usages[1]!).reason, "end_unconfirmed");
  const untargeted = await parsed("claude", [user, finished,
    { type: "system", uuid: "error", sessionId: "synthetic-session", isApiErrorMessage: true, timestamp: at(11) }]);
  assert.equal(untargeted.usages[0]?.timing?.completion, "explicit");
  assert.equal(requestSpeed(untargeted.usages[0]!).tokensPerSecond, 40);
});

test("CodeFlicker CLI 成功结果写入支持估算，重复记录不重计，下一次请求从工具结果开始", async () => {
  const first = native("codeflicker", "first", "assistant", 10, [{ type: "reasoning", text: "合成思考" }, textBlock,
    { type: "tool_use", id: "tool", name: "fixture_tool", input: {} }], 400, "one");
  const result = native("codeflicker", "result", "tool", 50, [{ type: "tool-result", toolCallId: "tool", result: { llmContent: "合成结果" } }]);
  const sample = await parsed("codeflicker", [native("codeflicker", "user", "user", 0, "合成请求"), first, first,
    result, result, native("codeflicker", "answer", "assistant", 60, [textBlock], 600, "two")]);
  assert.equal(sample.usages.length, 2);
  assert.equal(sample.usages[0]?.timing?.completionEvidence, "persisted_stream_result");
  assert.equal(sample.usages[0]?.requestMessageIds?.length, 2);
  assert.equal(sample.usages[0]?.timing?.durationMs, 10000);
  assert.equal(sample.usages[1]?.timing?.durationMs, 10000);
});

test("CodeFlicker CLI 缺少成功写入身份或中断时保留未知与部分，不因用量存在就计算", async () => {
  const user = native("codeflicker", "user", "user", 0, "合成请求");
  const answer = native("codeflicker", "answer", "assistant", 10, [textBlock], 400, "one");
  const unknown = await parsed("codeflicker", [user, { ...answer, metadata: undefined }]);
  assert.equal(requestSpeed(unknown.usages[0]!).reason, "end_unconfirmed");
  const partial = await parsed("codeflicker", [user, { ...answer, isInterrupted: true }]);
  assert.equal(requestSpeed(partial.usages[0]!).reason, "partial_response");
  const finished = await parsed("codeflicker", [user, answer,
    { type: "message", uuid: "error", sessionId: "synthetic-session", role: "assistant", model: "<synthetic>",
      content: [textBlock], isApiErrorMessage: true, timestamp: at(11) }]);
  assert.equal(finished.usages.length, 1);
  assert.ok(requestSpeed(finished.usages[0]!).tokensPerSecond);
});

test("缺失、逆序和无效的原生时间不会产生速度，已结束请求仍保留关联", async () => {
  const user = native("claude", "user", "user", 0, "合成请求");
  const answer = native("claude", "answer", "assistant", 10, [textBlock], 400, "one", { stop_reason: "end_turn" });
  for (const [record, reason] of [[{ ...user, timestamp: undefined }, "timing_missing"], [{ ...user, timestamp: at(11) }, "invalid_timing"],
    [{ ...user, timestamp: "invalid-date" }, "invalid_timing"]] as const) {
    const sample = await parsed("claude", [record, answer]);
    assert.equal(requestSpeed(sample.usages[0]!).reason, reason);
    assert.equal(sample.usages[0]?.requestMessageIds?.length, 1);
  }
});

test("跨会话请求身份复用时分别统计，同会话关联重复仍只计一次", () => {
  const first = { ...sampleUsage("shared-id", 400, 10_000), sessionId: "parent" };
  const second = { ...sampleUsage("shared-id", 600, 30_000), sessionId: "child" };
  assert.deepEqual(summarizeRequestSpeed([first, first, second]), { requests: 2, eligibleRequests: 2,
    outputTokens: 1000, durationMs: 40_000, tokensPerSecond: 25 });
});
