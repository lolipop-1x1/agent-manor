import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_ADAPTERS } from "../src/history/adapters/index.js";
import type { HistoryAdapter } from "../src/history/adapters/types.js";
import { parseSource } from "../src/history/index.js";
import { createNormalizedAdapter, normalizedHash, normalizedRecord, normalizedSnapshot, parseNormalizedSession, readBoundedJsonl } from "../src/history/adapters/normalized.js";
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


test("原始物理位置变动使来源指纹失效，不能复用旧证据行号", () => {
  const source = { client: "pi" as const, path: "/workspace/demo.jsonl", sessionId: "demo" };
  const event = { key: "request", kind: "user" as const, text: "检查" };
  assert.notEqual(normalizedSnapshot(source, [normalizedRecord(event, "{}", 1)]).hash,
    normalizedSnapshot(source, [normalizedRecord(event, "{}", 2)]).hash);
});


test("原生容器变更重建活动，未变快照复用且不保留已删除调用", async () => {
  const location = { client: "pi" as const, path: "/workspace/native-container", sessionId: "demo", cwd: "/workspace/app" };
  const records = [normalizedRecord({ key: "call", kind: "tool_call" as const, callId: "read-1", tool: "Read", input: { file_path: "src/a.ts" } }, "请求", 1),
    normalizedRecord({ key: "result", kind: "tool_result" as const, callId: "read-1", status: "success" as const, text: "1: alpha", result: { file: { filePath: "src/a.ts", content: "alpha", startLine: 1, numLines: 1, totalLines: 1 } } }, "结果", 2)];
  let snapshot = normalizedSnapshot(location, records);
  const adapter = createNormalizedAdapter({ id: "synthetic-native", readSnapshot: async () => snapshot });
  // 测试进程内临时注册，产品注册表不暴露动态加载入口。
  const adapters = HISTORY_ADAPTERS as HistoryAdapter[]; adapters.push(adapter);
  try {
    const first = await parseSource(location.path, location.client, undefined, adapter.id);
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0]?.status, "success");
    const unchanged = await parseSource(location.path, location.client, first, adapter.id);
    assert.equal((unchanged.cursor as { parsedRecords: number }).parsedRecords, 0);
    snapshot = normalizedSnapshot(location, []);
    const changed = await parseSource(location.path, location.client, unchanged, adapter.id);
    assert.equal(changed.events.length, 0);
    assert.notEqual(changed.hash, first.hash);
  } finally { adapters.splice(adapters.indexOf(adapter), 1); }
});

test("原生证据缺失或改写时不可用，符号链接不能替代原来源", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-native-evidence-"));
  try {
    const path = join(directory, "native.jsonl"); await writeFile(path, "{}\n");
    const adapter = createNormalizedAdapter({ id: "synthetic", readSnapshot: async source => normalizedSnapshot(source,
      [normalizedRecord({ key: "read", kind: "tool_call" }, "原始记录", 1)]) });
    const reference = { sourceId: "pi:demo", path, recordLine: 1, hash: normalizedHash("原始记录") };
    assert.equal((await adapter.readEvidence(reference))?.raw, "原始记录");
    assert.equal(await adapter.readEvidence({ ...reference, hash: "changed" }), undefined);
    const link = join(directory, "link.jsonl"); await symlink(path, link);
    assert.equal(await adapter.readEvidence({ ...reference, path: link }), undefined);
    await rm(path);
    assert.equal(await adapter.readEvidence(reference), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
