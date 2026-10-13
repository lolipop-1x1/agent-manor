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
const timed = (record: object, seconds: number) => ({ ...record, timestamp: at(seconds), sessionId: "synthetic-session" });
const user = (seconds = 0, id = "user") => timed({ type: "message", role: "user", id, content: "合成请求" }, seconds);
const buddy = (id: string, request: string, seconds: number, output?: number, extra: Record<string, unknown> = {}) => timed({
  type: "message", role: "assistant", id, status: "completed", content: [{ type: "output_text", text: "合成回复" }],
  providerData: { messageId: request, model: "fixture-model", conversationRequestId: "shared-round",
    usage: output === undefined ? undefined : { requests: 1, inputTokens: 100, outputTokens: output } },
  message: output === undefined ? undefined : { usage: { input_tokens: 100, output_tokens: output } }, ...extra,
}, seconds);
const reasoning = (id: string, request: string, seconds: number) => timed({ type: "reasoning", id,
  content: "合成思考", providerData: { messageId: request, conversationRequestId: "shared-round" } }, seconds);
const call = (id: string, request: string, seconds: number, output?: number) => timed({ type: "function_call", id,
  callId: id, name: "fixture_tool", arguments: "{}", providerData: { messageId: request, conversationRequestId: "shared-round",
    usage: output === undefined ? undefined : { requests: 1, inputTokens: 100, outputTokens: output } } }, seconds);
const result = (id: string, seconds: number) => timed({ type: "function_call_result", id: `${id}-result`, callId: id,
  name: "fixture_tool", status: "completed", output: "合成工具结果" }, seconds);
const metrics = (seconds: number, durationMs: number, tokenDelta = 50_000) => timed({ type: "turn-metrics", durationMs, tokenDelta }, seconds);
const qUser = (seconds = 0, id = "user") => timed({ type: "user", uuid: id,
  message: { role: "user", content: [{ type: "text", text: "合成请求" }] } }, seconds);
const qAssistant = (id: string, seconds: number, output = 400, stop: string | null = "end_turn", content: unknown[] = [
  { type: "text", text: "合成回复" }], extra: Record<string, unknown> = {}) => timed({ type: "assistant", uuid: `record-${id}`,
  message: { id, role: "assistant", model: "fixture-model", stop_reason: stop, content,
    usage: { input_tokens: 100, output_tokens: output } }, ...extra }, seconds);
const qResult = (id: string, seconds: number) => timed({ type: "user", uuid: `${id}-result`,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "合成工具结果" }] } }, seconds);

async function parsed(client: Client, records: unknown[]) {
  const directory = await mkdtemp(join(tmpdir(), "manor-json-request-speed-"));
  const path = join(directory, "fixture.jsonl");
  const messages = new Map<string, SessionMessage>();
  const usages = new Map<string, SessionUsage>();
  try {
    await writeFile(path, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    await parseSessionSource({ client, path, format: `${client}-jsonl`, sessionId: "synthetic-session" }, {
      message: value => { messages.set(value.id, value); }, usage: value => { usages.set(value.id, value); },
    });
    return { messages: [...messages.values()], usages: [...usages.values()] };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("CodeBuddy 单请求原生回合时长与输出用量配对，不用总 tokenDelta 或持久化间隔", async () => {
  const sample = await parsed("codebuddy", [user(), reasoning("thinking", "request-one", 1), buddy("answer", "request-one", 2.6, 226),
    metrics(2.901, 2598, 28731), user(10, "user-two"), buddy("answer-two", "request-two", 17, 592), metrics(17.082, 6920, 60111)]);
  assert.equal(sample.usages.length, 2);
  assert.equal(sample.usages[0]?.outputTokens, 226);
  assert.equal(sample.usages[0]?.timing?.durationMs, 2598);
  assert.equal(sample.usages[0]?.timing?.start, undefined);
  assert.equal(sample.usages[0]?.timing?.completionEvidence, "turn_metrics");
  assert.equal(sample.usages[0]?.requestMessageIds?.length, 2);
  assert.equal(requestSpeed(sample.usages[0]!).tokensPerSecond, 226 / 2.598);
  assert.ok(Math.abs(requestSpeed(sample.usages[1]!).tokensPerSecond! - 592 / 6.920) < 1e-10);
});

test("CodeBuddy 思考临时身份只沿同 trace 的唯一直接子记录关联到请求", async () => {
  const sample = await parsed("codebuddy", [user(), timed({ type: "reasoning", id: "thinking", parentId: "user",
    content: "合成思考", providerData: { messageId: "temporary-message", traceId: "trace-one", conversationRequestId: "round-one" } }, 1),
    buddy("answer", "final-message", 3, 400, { parentId: "thinking", providerData: { messageId: "final-message", traceId: "trace-one",
      conversationRequestId: "round-one", usage: { requests: 1, inputTokens: 100, outputTokens: 400 } } }), metrics(3.2, 3000)]);
  assert.equal(sample.usages.length, 1);
  assert.equal(sample.usages[0]?.requestMessageIds?.length, 2);
  assert.equal(requestSpeed(sample.usages[0]!).tokensPerSecond, 400 / 3);
});

test("CodeBuddy 复杂回合保留每个请求用量，回合总时长不分摊到模型调用", async () => {
  const sample = await parsed("codebuddy", [user(), reasoning("thinking", "request-one", 1), call("tool", "request-one", 4, 400),
    result("tool", 20), buddy("answer", "request-two", 30, 600), metrics(31, 30_000)]);
  assert.equal(sample.usages.length, 2);
  assert.ok(sample.usages.every(usage => requestSpeed(usage).reason === "end_unconfirmed"));
  assert.equal(summarizeRequestSpeed(sample.usages).eligibleRequests, 0);
  const multiple = await parsed("codebuddy", [user(), buddy("one", "one", 2, 400), buddy("two", "two", 4, 400), metrics(5, 4000)]);
  assert.equal(multiple.usages.length, 2);
  assert.ok(multiple.usages.every(usage => usage.timing?.durationMs === undefined));
  const toolRound = await parsed("codebuddy", [user(), call("tool", "tool-request", 2, 116), result("tool", 3),
    buddy("answer", "answer-request", 6, 592), metrics(7, 6920)]);
  assert.deepEqual(toolRound.usages.map(usage => usage.outputTokens), [116, 592]);
  assert.ok(toolRound.usages.every(usage => usage.timing?.durationMs === undefined));
  assert.equal(summarizeRequestSpeed(toolRound.usages).eligibleRequests, 0);
});

test("CodeBuddy 取消、请求数不明、重复指标、矛盾用量均不输出速度", async () => {
  for (const [answer, endings, reason] of [
    [buddy("cancelled", "one", 3, 400, { status: "cancelled" }), [metrics(4, 3000)], "partial_response"],
    [buddy("unknown-count", "one", 3, 400, { providerData: { messageId: "one", usage: { outputTokens: 400, requests: 2 } } }), [metrics(4, 3000)], "end_unconfirmed"],
    [buddy("conflict", "one", 3, 400, { message: { usage: { input_tokens: 100, output_tokens: 600 } } }), [metrics(4, 3000)], "output_missing"],
    [buddy("duplicate", "one", 3, 400), [metrics(4, 3000), metrics(5, 4000)], "end_unconfirmed"],
  ] as const) {
    const sample = await parsed("codebuddy", [user(), answer, ...endings]);
    assert.equal(requestSpeed(sample.usages[0]!).reason, reason);
  }
});

test("WorkBuddy 同一模型请求合并片段，全部工具结果确认结束且工具等待不进分母", async () => {
  const sample = await parsed("workbuddy", [user(), reasoning("thinking", "request-one", 1), call("one", "request-one", 3),
    call("two", "request-one", 4, 400), result("one", 20), result("two", 30), buddy("answer", "request-two", 40, 800)]);
  assert.equal(sample.usages.length, 2);
  assert.equal(sample.usages[0]?.timing?.durationMs, 4000);
  assert.equal(sample.usages[0]?.timing?.completionEvidence, "tool_result");
  assert.equal(sample.usages[0]?.requestMessageIds?.length, 1);
  assert.equal(sample.usages[1]?.timing?.durationMs, 10_000);
  assert.equal(sample.usages[1]?.timing?.start?.recordLine, 6);
  assert.equal(requestSpeed(sample.usages[0]!).tokensPerSecond, 100);
  assert.equal(requestSpeed(sample.usages[1]!).tokensPerSecond, 80);
});

test("WorkBuddy 不把用量或共享回合 ID 当作完成；取消和缺身份仍保留请求", async () => {
  const unknown = await parsed("workbuddy", [user(), call("one", "request-one", 3, 400)]);
  assert.equal(requestSpeed(unknown.usages[0]!).reason, "end_unconfirmed");
  const pending = await parsed("workbuddy", [user(), call("one", "request-one", 2), call("two", "request-one", 3, 400), result("one", 4)]);
  assert.equal(requestSpeed(pending.usages[0]!).reason, "end_unconfirmed");
  const continued = await parsed("workbuddy", [user(), buddy("comment", "request-one", 2), call("one", "request-one", 3, 400)]);
  assert.equal(requestSpeed(continued.usages[0]!).reason, "end_unconfirmed", "消息 completed 不能提前结束仍有工具参数的模型请求");
  const cancelled = await parsed("workbuddy", [user(), buddy("cancelled", "request-one", 3, 400, { status: "cancelled" })]);
  assert.equal(requestSpeed(cancelled.usages[0]!).reason, "partial_response");
  const absent = await parsed("workbuddy", [user(), buddy("missing", "request-one", 3)]);
  assert.equal(absent.usages.length, 1);
  assert.equal(requestSpeed(absent.usages[0]!).reason, "output_missing");
  const unidentified = await parsed("workbuddy", [user(), buddy("unknown", "request-one", 3, 400,
    { providerData: { conversationRequestId: "shared-round", usage: { outputTokens: 400 } } })]);
  assert.equal(requestSpeed(unidentified.usages[0]!).reason, "timing_missing");
});

test("Qoder 合并相同请求快照、同请求思考与回复共享计时，工具等待不计入", async () => {
  const first = qAssistant("one", 4, 400, null, [{ type: "thinking", thinking: "合成思考" },
    { type: "text", text: "合成回复" }, { type: "tool_use", id: "tool-one", name: "fixture_tool", input: {} },
    { type: "tool_use", id: "tool-two", name: "fixture_tool", input: {} }]);
  const sample = await parsed("qoder", [qUser(), first, { ...first, uuid: "duplicate-record", timestamp: at(10) },
    qResult("tool-one", 20), qResult("tool-two", 30), qAssistant("two", 40, 800)]);
  assert.equal(sample.usages.length, 2);
  assert.equal(sample.usages[0]?.timing?.durationMs, 4000);
  assert.equal(sample.usages[0]?.timing?.completionEvidence, "tool_result");
  assert.equal(sample.usages[0]?.requestMessageIds?.length, 2);
  assert.equal(sample.messages.filter(message => ["assistant", "thinking"].includes(message.kind)).length, 3);
  assert.equal(sample.usages[1]?.timing?.durationMs, 10_000);
  assert.equal(requestSpeed(sample.usages[0]!).tokensPerSecond, 100);
  assert.equal(summarizeRequestSpeed(sample.usages).eligibleRequests, 2);
});

test("Qoder 完成与短请求门槛分别保留，缺结束或取消不计算", async () => {
  for (const [answer, reason] of [
    [qAssistant("one", 1, 200), undefined],
    [qAssistant("one", 1, 199), "output_below_threshold"],
    [qAssistant("one", 0.999, 200), "duration_below_threshold"],
    [qAssistant("one", 1, 400, null), "end_unconfirmed"],
    [qAssistant("one", 1, 400, "end_turn", undefined, { interrupted: true }), "partial_response"],
  ] as const) {
    const sample = await parsed("qoder", [qUser(), answer]);
    assert.equal(requestSpeed(sample.usages[0]!).reason, reason);
    if (reason === "partial_response") assert.ok(sample.messages.every(message => message.final === undefined && message.finalEvidence === undefined));
  }
});

test("Qoder end_turn 的后续工具撤销终答，失败后新请求完整结束恢复", async () => {
  const continued = await parsed("qoder", [qUser(), qAssistant("one", 3, 400, "end_turn", [
    { type: "text", text: "early answer" }, { type: "tool_use", id: "tool", name: "fixture_tool", input: {} },
  ]), qResult("tool", 4)]);
  assert.ok(continued.messages.every(message => message.final === undefined && message.finalEvidence === undefined));
  const retried = await parsed("qoder", [qUser(), qAssistant("failed", 1, 400, "end_turn", undefined, { interrupted: true }),
    qAssistant("complete", 2)]);
  const replies = retried.messages.filter(message => message.kind === "assistant");
  assert.equal(replies[0]?.final, undefined);
  assert.equal(replies[1]?.final, "explicit");
  assert.equal(replies[1]?.finalEvidence, "normal_stop");
  const truncated = await parsed("qoder", [qUser(), qAssistant("complete", 1), qAssistant("truncated", 2, 400, "max_tokens")]);
  assert.ok(truncated.messages.every(message => message.final === undefined && message.finalEvidence === undefined));
});

test("原生请求更新由失败恢复为完整响应时，终答依据跟随后续完整快照", async () => {
  for (const client of ["workbuddy", "codebuddy"] as const) {
    const sample = await parsed(client, [user(), buddy("failed", "same-request", 1, 400, { interrupted: true }),
      buddy("completed", "same-request", 2, 400)]);
    const replies = sample.messages.filter(message => message.kind === "assistant");
    assert.equal(replies[0]?.final, undefined);
    assert.equal(replies[1]?.final, "inferred");
    assert.equal(replies[1]?.finalEvidence, "response_completed");
  }
  const qoder = await parsed("qoder", [qUser(), qAssistant("same-request", 1, 400, "end_turn", undefined, { interrupted: true }),
    qAssistant("same-request", 2)]);
  const answer = qoder.messages.find(message => message.kind === "assistant");
  assert.equal(answer?.final, "explicit");
  assert.equal(answer?.finalEvidence, "normal_stop");
});

test("Qoder 冲突用量不任选快照，未返回的并行工具不推请求结束", async () => {
  const conflicting = await parsed("qoder", [qUser(), qAssistant("one", 3, 400), qAssistant("one", 4, 500)]);
  assert.equal(conflicting.usages.length, 1);
  assert.equal(requestSpeed(conflicting.usages[0]!).reason, "output_missing");
  const pending = await parsed("qoder", [qUser(), qAssistant("one", 3, 400, null, [
    { type: "tool_use", id: "tool-one", name: "fixture_tool", input: {} },
    { type: "tool_use", id: "tool-two", name: "fixture_tool", input: {} },
  ]), qResult("tool-one", 20)]);
  assert.equal(requestSpeed(pending.usages[0]!).reason, "end_unconfirmed");
});
