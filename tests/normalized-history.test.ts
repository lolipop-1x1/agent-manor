import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { normalizedRecord, normalizedSnapshot, parseNormalizedSession, readBoundedJsonl } from "../src/history/adapters/normalized.js";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";

test("规范化保留分支及实际用量，失败工具不会产生 Skill 读取证据", () => {
  const messages = new Map<string, SessionMessage>(); const usages = new Map<string, SessionUsage>();
  const snapshot = normalizedSnapshot({ client: "pi", path: "/workspace/history.jsonl", sessionId: "synthetic-session", cwd: "/workspace/app" }, [
    normalizedRecord({ key: "u", kind: "user", text: "检查文件", currentBranch: true, branchIds: ["leaf-a", "leaf-b"] }, "{}", 1),
    normalizedRecord({ key: "call", kind: "tool_call", tool: "Read", callId: "call-1", input: { file_path: "/workspace/skills/check/SKILL.md" } }, "{}", 2),
    normalizedRecord({ key: "result", kind: "tool_result", callId: "call-1", text: "失败", status: "failure" }, "{}", 3),
    normalizedRecord({ key: "answer", kind: "assistant", text: "完成", currentBranch: true, usageKey: "request-1", usage: { inputTokens: 120, cachedInputTokens: 100, outputTokens: 10 } }, "{}", 4),
    normalizedRecord({ key: "attempt", kind: "system", text: "其他分支请求", currentBranch: false, usageKey: "request-2", usage: { inputTokens: 80, outputTokens: 5 } }, "{}", 5),
  ], { branches: [{ id: "leaf-a", label: "当前", current: true }, { id: "leaf-b", label: "另一分支", current: false }] });
  const meta = parseNormalizedSession(snapshot, { message: value => messages.set(value.id, value), usage: value => usages.set(value.id, value) });
  assert.equal(meta.turnCount, 1); assert.equal(meta.branches?.length, 2); assert.equal(usages.size, 2);
  const call = [...messages.values()].find(value => value.kind === "tool_call")!;
  assert.equal(call.status, "failure"); assert.equal(call.resource, undefined);
  assert.deepEqual([...messages.values()].find(value => value.kind === "user")?.branchIds, ["leaf-a", "leaf-b"]);
  assert.equal([...messages.values()].find(value => value.kind === "assistant")?.final, "inferred");
});

test("中断及未配对工具轮次不补造最终回答", () => {
  const messages = new Map<string, SessionMessage>();
  const snapshot = normalizedSnapshot({ client: "dsh", path: "/workspace/history.zstd", sessionId: "synthetic" }, [
    normalizedRecord({ key: "u1", kind: "user", text: "继续" }, "{}", 1),
    normalizedRecord({ key: "a1", kind: "assistant", text: "部分结果", interrupted: true }, "{}", 2),
    normalizedRecord({ key: "u2", kind: "user", text: "读取" }, "{}", 3),
    normalizedRecord({ key: "a2", kind: "assistant", text: "处理中" }, "{}", 4),
    normalizedRecord({ key: "t2", kind: "tool_call", tool: "read", callId: "pending", input: {} }, "{}", 5),
  ]);
  const meta = parseNormalizedSession(snapshot, { message: value => messages.set(value.id, value), usage: () => {} });
  assert.ok([...messages.values()].filter(value => value.kind === "assistant").every(value => !value.final));
  assert.ok(meta.gaps.some(gap => gap.kind === "unpaired_call"));
});

test("JSONL 流式读取保留坏行与未完成末行缺口", async () => {
  const gaps: Parameters<typeof readBoundedJsonl>[1] = [];
  const rows = await readBoundedJsonl("memory", gaps, Readable.from(['{"type":"message"}\n{invalid}\n{"type":', '"message"}']));
  assert.equal(rows.length, 1); assert.equal(rows[0]?.line, 1);
  assert.deepEqual(gaps.map(gap => gap.kind), ["parse_error", "incomplete_record"]);
});


test("并发复用调用身份保留歧义，不把结果配给最后一个请求", () => {
  const messages = new Map<string, SessionMessage>();
  const meta = parseNormalizedSession(normalizedSnapshot({ client: "pi", path: "/workspace/demo.jsonl", sessionId: "demo" }, [
    normalizedRecord({ key: "u", kind: "user", text: "检查" }, "{}", 1),
    normalizedRecord({ key: "first", kind: "tool_call", callId: "same", tool: "read", input: { path: "a.ts" } }, "{}", 2),
    normalizedRecord({ key: "second", kind: "tool_call", callId: "same", tool: "read", input: { path: "b.ts" } }, "{}", 3),
    normalizedRecord({ key: "result", kind: "tool_result", callId: "same", status: "success", text: "返回" }, "{}", 4),
    normalizedRecord({ key: "answer", kind: "assistant", text: "继续" }, "{}", 5),
  ]), { message: value => messages.set(value.id, value), usage: () => {} });
  assert.ok(meta.gaps.some(gap => gap.kind === "ambiguous"));
  assert.ok([...messages.values()].filter(value => value.kind === "tool_call").every(value => !value.status));
  assert.equal([...messages.values()].find(value => value.kind === "assistant")?.final, undefined);
});
