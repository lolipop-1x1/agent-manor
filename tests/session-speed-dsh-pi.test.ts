import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";
import { requestSpeed, summarizeRequestSpeed } from "../src/session-speed.js";
import { parseSessionSource } from "../src/sessions/parser.js";

const epoch = Date.UTC(2026, 0, 1);
const time = (seconds: number) => epoch + seconds * 1000;
const at = (seconds: number) => new Date(time(seconds)).toISOString();
const encode = (records: unknown[]) => records.map(record => JSON.stringify(record)).join("\n") + "\n";
const dshHeader = (extra = {}) => ({ type: "session", version: 4, id: "synthetic-dsh", cwd: "/synthetic/repo", ...extra });
const dshEvent = (type: string, seq: number, seconds: number, data: Record<string, unknown>) => ({ type, seq, time: time(seconds), data });
const dshUser = (seq = 1, seconds = 0, turn = 1) => dshEvent("user/message", seq, seconds, {
  turn, message: { source: { kind: "user" }, content: [{ type: "text", text: "合成请求" }] },
});
const dshStream = (start: number, end: number, reason = "stop", responseId = "synthetic-response") => [
  { type: "reasoning-chunks", time0: time(start), index: 0, dt: [0], texts: ["合成思考"] },
  { type: "text-chunks", time0: time(start + 0.5), index: 1, dt: [0], texts: ["合成回复"] },
  { type: "chunk", time: time(end), chunk: { type: "finish", reason: { kind: reason },
    replayState: { response: { responseId } } } },
];
const dshAssistant = (seq: number, start: number, end: number, output = 400, extra: Record<string, unknown> = {}) => dshEvent("assistant/message", seq, end + 0.1, {
  turn: 1, step: seq, message: { role: "assistant", source: { kind: "model", model: "synthetic-model" },
    content: [{ type: "reasoning", text: "合成思考" }, { type: "text", text: "合成回复" }] },
  usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: output, reasoningTokens: 50 },
  stream: dshStream(start, end, "stop", `synthetic-response-${seq}`), ...extra,
});
const piHeader = (extra = {}) => ({ type: "session", version: 3, id: "synthetic-pi", timestamp: at(0), cwd: "/synthetic/repo", ...extra });
const piEntry = (id: string, parentId: string | null, seconds: number, message: Record<string, unknown>) => ({
  type: "message", id, parentId, timestamp: at(seconds), message,
});
const piUser = (id = "user", parentId: string | null = null, seconds = 0) => piEntry(id, parentId, seconds, {
  role: "user", content: [{ type: "text", text: "合成请求" }], timestamp: time(seconds),
});
const piAssistant = (id: string, parentId: string, start: number, end: number, output = 400, extra: Record<string, unknown> = {}) => piEntry(id, parentId, end, {
  role: "assistant", model: "synthetic-model", responseId: `synthetic-response-${id}`, timestamp: time(start), stopReason: "stop",
  content: [{ type: "thinking", thinking: "合成思考" }, { type: "text", text: "合成回复" }],
  usage: { input: 100, output, cacheRead: 0, cacheWrite: 0, reasoning: 50 }, ...extra,
});

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-dsh-pi-speed-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function parsed(client: "dsh" | "pi", path: string, records: unknown[]) {
  await writeFile(path, encode(records));
  const messages = new Map<string, SessionMessage>();
  const usages = new Map<string, SessionUsage>();
  await parseSessionSource({ client, path, format: `${client}-jsonl` }, {
    message: value => { messages.set(value.id, value); }, usage: value => { usages.set(value.id, value); },
  });
  return { messages: [...messages.values()], usages: [...usages.values()] };
}

test("DSH 使用最早输出片段到终态的原生区间，工具等待不并入且片段共享请求", async () => temporary(async directory => {
  const call = { type: "tool-call", id: "synthetic-call", name: "fixture_tool", arguments: "{}" };
  const sample = await parsed("dsh", join(directory, "dsh.jsonl"), [dshHeader(), dshUser(),
    dshAssistant(2, 1, 5, 400, { message: { source: { kind: "model", model: "synthetic-model" },
      content: [{ type: "reasoning", text: "合成思考" }, { type: "text", text: "合成回复" }, call] },
      stream: dshStream(1, 5, "tool-calls") }),
    dshEvent("tool/call", 3, 5.2, { turn: 1, step: 2, callId: "synthetic-call", name: "fixture_tool", arguments: "{}" }),
    dshEvent("tool/result", 4, 50, { turn: 1, step: 2, message: { toolCallId: "synthetic-call", isError: true, content: [{ type: "text", text: "合成工具失败" }] } }),
  ]);
  assert.equal(sample.usages.length, 1);
  const usage = sample.usages[0]!;
  assert.equal(usage.timing?.basis, "recorded");
  assert.equal(usage.timing?.window, "generation");
  assert.equal(usage.timing?.completionEvidence, "stream_finish");
  assert.equal(usage.timing?.durationMs, 4000);
  assert.equal(requestSpeed(usage).tokensPerSecond, 100, "不重复添加 reasoning Token");
  assert.ok(usage.requestMessageIds?.includes(sample.messages.find(message => message.kind === "thinking")!.id));
  assert.ok(usage.requestMessageIds?.includes(sample.messages.find(message => message.kind === "assistant")!.id));
  assert.equal(summarizeRequestSpeed(sample.usages).eligibleRequests, 1);
}));

test("DSH 失败尝试与重试分别计数，取消、未知结束、短区间和缺用量保留原因", async () => temporary(async directory => {
  const sample = await parsed("dsh", join(directory, "dsh.jsonl"), [dshHeader(), dshUser(),
    dshEvent("assistant/attempt", 2, 5.1, { turn: 1, step: 1, usage: { outputTokens: 400 }, stream: dshStream(1, 5) }),
    dshAssistant(3, 6, 10, 400, { stream: dshStream(6, 10) }),
    dshAssistant(4, 11, 15, 400, { interrupted: true }),
    dshAssistant(5, 16, 20, 400, { stream: dshStream(16, 20).slice(0, -1) }),
    dshAssistant(6, 21, 21.999),
    dshAssistant(7, 22, 26, 199),
    dshAssistant(8, 27, 31, 400, { usage: undefined }),
  ]);
  assert.equal(sample.usages.length, 7);
  assert.deepEqual(sample.usages.map(usage => requestSpeed(usage).reason ?? "eligible"), [
    "partial_response", "eligible", "partial_response", "end_unconfirmed", "duration_below_threshold", "output_below_threshold", "output_missing",
  ]);
  assert.notEqual(sample.usages[0]?.id, sample.usages[1]?.id, "失败尝试不能合入成功响应身份");
}));

test("DSH 继承和重复投影不重复参与统计，门槛包含等号", async () => temporary(async directory => {
  const owned = dshAssistant(4, 10, 11, 200);
  const sample = await parsed("dsh", join(directory, "dsh.jsonl"), [dshHeader({ isSeeded: true, parentSession: "synthetic-parent" }),
    dshUser(0), dshAssistant(1, 1, 5), dshEvent("session/end-seed", 2, 6, { inherited: true }),
    dshUser(3, 10), owned, owned,
  ]);
  assert.equal(sample.usages.length, 1);
  assert.equal(requestSpeed(sample.usages[0]!).tokensPerSecond, 200);
}));

test("Pi 按两层时间估算含等待区间，工具结果不延长请求且 responseId 去重", async () => temporary(async directory => {
  const first = piAssistant("first", "user", 1, 5, 400, { stopReason: "toolUse",
    content: [{ type: "thinking", thinking: "合成思考" }, { type: "text", text: "合成回复" },
      { type: "toolCall", id: "synthetic-call", name: "fixture_tool", arguments: {} }] });
  const sample = await parsed("pi", join(directory, "pi.jsonl"), [piHeader(), piUser(), first,
    piEntry("result", "first", 50, { role: "toolResult", toolCallId: "synthetic-call", isError: true, content: [{ type: "text", text: "合成工具失败" }] }),
    piAssistant("second", "result", 51, 61, 600),
    piAssistant("duplicate", "second", 51, 61, 600, { responseId: "synthetic-response-second" }),
  ]);
  assert.equal(sample.usages.length, 2);
  assert.equal(sample.usages[0]?.timing?.basis, "estimated");
  assert.equal(sample.usages[0]?.timing?.window, "response");
  assert.equal(sample.usages[0]?.timing?.completion, "explicit", "工具请求的完成不依赖工具执行成功");
  assert.equal(sample.usages[0]?.timing?.durationMs, 4000);
  assert.equal(sample.usages[1]?.timing?.durationMs, 10000);
  assert.equal(requestSpeed(sample.usages[0]!).tokensPerSecond, 100);
  assert.equal(summarizeRequestSpeed(sample.usages).eligibleRequests, 2);
}));

test("Pi 错误、取消和截断不计算；缺失时间与用量不补零，原生 entryId 可兜底", async () => temporary(async directory => {
  const sample = await parsed("pi", join(directory, "pi.jsonl"), [piHeader(), piUser(),
    piAssistant("error", "user", 0, 2, 400, { stopReason: "error" }),
    piAssistant("aborted", "error", 2, 4, 400, { stopReason: "aborted" }),
    piAssistant("length", "aborted", 4, 6, 400, { stopReason: "length" }),
    piAssistant("unknown", "length", 6, 8, 400, { stopReason: undefined }),
    piAssistant("missing-time", "unknown", 8, 10, 400, { timestamp: undefined }),
    piAssistant("missing-usage", "missing-time", 10, 12, 400, { usage: undefined }),
    piAssistant("threshold", "missing-usage", 12, 13, 200, { responseId: undefined }),
  ]);
  assert.equal(sample.usages.length, 7);
  assert.deepEqual(sample.usages.map(usage => requestSpeed(usage).reason ?? "eligible").sort(), [
    "partial_response", "partial_response", "partial_response", "end_unconfirmed", "timing_missing", "output_missing", "eligible",
  ].sort());
  assert.equal(requestSpeed(sample.usages.find(usage => usage.outputTokens === 200)!).tokensPerSecond, 200);
}));

test("Pi 父历史复制记录保留展示但从请求速度汇总排除", async () => temporary(async directory => {
  const parentPath = join(directory, "2026-01-01T00-00-00-000Z_synthetic-parent.jsonl");
  const copied = piAssistant("copied", "user", 0, 4);
  await writeFile(parentPath, encode([piHeader({ id: "synthetic-parent" }), piUser(), copied]));
  const sample = await parsed("pi", join(directory, "child.jsonl"), [piHeader({ parentSession: parentPath }), piUser(), copied,
    piUser("owned-user", "copied", 5), piAssistant("owned", "owned-user", 5, 9),
  ]);
  assert.ok(sample.messages.some(message => message.kind === "assistant" && message.copied));
  assert.equal(sample.usages.length, 1);
  assert.equal(summarizeRequestSpeed(sample.usages).eligibleRequests, 1);
}));

test("DSH seeded 历史缺少继承边界时不把无法核验的复制记录算作新请求速度", async () => temporary(async directory => {
  const sample = await parsed("dsh", join(directory, "dsh.jsonl"), [dshHeader({ isSeeded: true }), dshUser(), dshAssistant(2, 1, 5)]);
  assert.equal(sample.usages.length, 1);
  assert.equal(requestSpeed(sample.usages[0]!).reason, "timing_missing");
  assert.equal(summarizeRequestSpeed(sample.usages).eligibleRequests, 0);
}));
