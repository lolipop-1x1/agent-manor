import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";
import { desktopModels } from "../src/sessions/codeflicker-desktop.js";
import { parseSessionSource } from "../src/sessions/parser.js";
import { requestSpeed, summarizeRequestSpeed } from "../src/session-speed.js";
import { DESKTOP_FORMAT } from "../src/history/adapters/codeflicker-desktop.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const nativeUser = (uuid: string, seconds: number, parentUuid?: string) => ({ type: "user", uuid, parentUuid, timestamp: at(seconds), message: { role: "user", content: [] } });
const nativeAssistant = (uuid: string, parentUuid: string, request: string, seconds: number, output = 400, extra: object = {}) => ({
  type: "assistant", uuid, parentUuid, timestamp: at(seconds), message: { id: request, model: "fixture-model",
    usage: { output_tokens: output }, stop_reason: "end_turn" }, ...extra,
});
const cacheAssistant = (id: string, reference: string, seconds: number, output = 400) => ({ id, role: "assistant", kind: "message",
  content: "合成回复", timestamp: at(seconds), duration: 999000, usage: { inputTokens: 100, outputTokens: output,
    cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, extra: { backend: { type: "CLAUDE_CODE" }, "claude-code": { lastEntryUuid: reference } } });

async function parsed(cache: unknown[], mirror: unknown[]) {
  const directory = await mkdtemp(join(tmpdir(), "manor-desktop-speed-"));
  const path = join(directory, "session/message/cache.jsonl");
  const nativePath = join(directory, "session/claude-session/native.jsonl");
  const messages = new Map<string, SessionMessage>(); const usages = new Map<string, SessionUsage>();
  try {
    await mkdir(dirname(path), { recursive: true }); await mkdir(dirname(nativePath), { recursive: true });
    for (const [file, rows] of [[path, cache], [nativePath, mirror]] as const) await writeFile(file, rows.map(value => JSON.stringify(value)).join("\n") + "\n");
    const models = await desktopModels(path);
    await parseSessionSource({ client: "codeflicker-desktop", sessionId: "synthetic-desktop", format: DESKTOP_FORMAT, path }, {
      message: value => { messages.set(value.id, value); }, usage: value => { usages.set(value.id, value); },
    }, { desktopModels: models.entries });
    return { messages: [...messages.values()], usages: [...usages.values()] };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("桌面按助手 UUID 或工具结果的唯一后继请求关联，排除累计时长与工具等待", async () => {
  const sample = await parsed([
    { id: "user", kind: "message", role: "user", timestamp: at(0), content: "合成问题" },
    { id: "thinking", kind: "message", role: "reasoning", timestamp: at(3), content: "合成思考", extra: { "claude-code": { lastEntryUuid: "u0" } } },
    cacheAssistant("first", "a1", 5), cacheAssistant("second", "u1", 25, 600), cacheAssistant("duplicate", "a2", 26, 600),
  ], [nativeUser("u0", 0), nativeAssistant("a1", "u0", "request-one", 4),
    nativeUser("u1", 20, "a1"), nativeAssistant("a2", "u1", "request-two", 24, 600)]);
  assert.equal(sample.usages.length, 2);
  assert.deepEqual(sample.usages.map(value => value.timing?.durationMs), [4000, 4000]);
  assert.deepEqual(sample.usages.map(value => requestSpeed(value).tokensPerSecond), [100, 150]);
  assert.deepEqual(sample.usages.map(value => value.requestMessageIds?.length), [2, 2]);
  assert.equal(summarizeRequestSpeed(sample.usages).tokensPerSecond, 125);
  assert.ok(sample.usages.every(value => value.timing?.start?.source === "mirror" && !value.timing.start.messageId));
});

test("桌面镜像缺失或父记录存在多个后继时不猜测请求，也不用缓存累计时长", async () => {
  const missing = await parsed([cacheAssistant("missing", "absent", 10)], []);
  assert.equal(requestSpeed(missing.usages[0]!).reason, "timing_missing");
  const ambiguous = await parsed([cacheAssistant("ambiguous", "u0", 10)], [nativeUser("u0", 0),
    nativeAssistant("one", "u0", "one", 4), nativeAssistant("two", "u0", "two", 5)]);
  assert.equal(requestSpeed(ambiguous.usages[0]!).reason, "timing_missing");
});

test("桌面用量不一致、原生部分响应和短输出均不进入平均", async () => {
  const mismatch = await parsed([cacheAssistant("mismatch", "a1", 5, 900)], [nativeUser("u0", 0), nativeAssistant("a1", "u0", "one", 4)]);
  assert.equal(requestSpeed(mismatch.usages[0]!).reason, "end_unconfirmed");
  const partial = await parsed([cacheAssistant("partial", "a1", 5)], [nativeUser("u0", 0), nativeAssistant("a1", "u0", "one", 4, 400, { interrupted: true })]);
  assert.equal(requestSpeed(partial.usages[0]!).reason, "partial_response");
  const short = await parsed([cacheAssistant("short", "a1", 5, 199)], [nativeUser("u0", 0), nativeAssistant("a1", "u0", "one", 4, 199)]);
  assert.equal(requestSpeed(short.usages[0]!).reason, "output_below_threshold");
});

test("没有镜像关联的桌面思考仍正常显示", async () => {
  const sample = await parsed([{ id: "thinking", kind: "message", role: "reasoning", timestamp: at(1), content: "保留合成思考" }], []);
  assert.equal(sample.messages[0]?.kind, "thinking");
  assert.equal(sample.messages[0]?.text, "保留合成思考");
});

test("桌面请求的用量冲突不会被后续思考或匹配快照清除", async () => {
  for (const later of [
    { id: "thinking", kind: "message", role: "reasoning", timestamp: at(6), content: "合成思考", extra: { "claude-code": { lastEntryUuid: "a1" } } },
    cacheAssistant("matching-snapshot", "a1", 6),
  ]) {
    const sample = await parsed([cacheAssistant("mismatch", "a1", 5, 900), later],
      [nativeUser("u0", 0), nativeAssistant("a1", "u0", "one", 4)]);
    assert.equal(sample.usages.length, 1);
    assert.equal(requestSpeed(sample.usages[0]!).reason, "end_unconfirmed");
    assert.equal(summarizeRequestSpeed(sample.usages).eligibleRequests, 0);
    assert.equal(sample.usages[0]?.requestMessageIds?.length, 2);
  }
});
