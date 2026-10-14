import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { appendFile, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";
import { kimiAdapter, kimiHistoryRoots } from "../src/history/adapters/kimi.js";
import { ompAdapter, ompHistoryRoots } from "../src/history/adapters/omp.js";
import { normalizedHash, parseNormalizedSession, type NormalizedSnapshot } from "../src/history/adapters/normalized.js";
import type { HistoryAdapter } from "../src/history/adapters/types.js";
import type { SourceLocation } from "../src/history/types.js";
import { discoverSources, parseSource } from "../src/history/index.js";
import { refreshSessions } from "../src/sessions/refresh.js";
import { SessionStore } from "../src/sessions/store.js";
import { requestSpeed } from "../src/session-speed.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

const epoch = Date.UTC(2026, 9, 1);
const at = (seconds: number) => new Date(epoch + seconds * 1000).toISOString();
const wire = (type: string, seconds: number, extra: Record<string, unknown> = {}) => ({ type, agentId: "main", time: epoch + seconds * 1000, ...extra });
const loop = (type: string, seconds: number, extra: Record<string, unknown> = {}) => wire("context.append_loop_event", seconds, { event: { type, ...extra } });
const encode = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const kimiHeader = { type: "metadata", protocol_version: "1.5", created_at: epoch };
const ompHeader = (extra = {}) => ({ type: "session", version: 3, id: "synthetic-omp", cwd: "/workspace/example", timestamp: at(0), ...extra });
const ompRow = (id: string, parentId: string | null, seconds: number, message: Record<string, unknown>) => ({ type: "message", id, parentId, timestamp: at(seconds), message });
const ompUser = (id = "user", parentId: string | null = null, seconds = 0) => ompRow(id, parentId, seconds, { role: "user", attribution: "user", content: [{ type: "text", text: "合成请求" }], timestamp: epoch + seconds * 1000 });
const tokenUsage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const ompAssistant = (id: string, parentId: string, seconds: number, extra = {}) => ompRow(id, parentId, seconds, {
  role: "assistant", model: "synthetic-model", provider: "synthetic-provider", timestamp: epoch + (seconds - 1) * 1000,
  stopReason: "stop", content: [{ type: "text", text: "合成答复" }], usage: tokenUsage, ...extra,
});
async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-kimi-omp-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function kimiPath(directory: string, session = "synthetic-kimi", agent = "main", stateExtra = {}) {
  const sessionDir = join(directory, "sessions", "synthetic-workspace", session);
  const agentDir = join(sessionDir, "agents", agent); await mkdir(agentDir, { recursive: true });
  await writeFile(join(sessionDir, "state.json"), JSON.stringify({ id: session, version: 2, cwd: "/workspace/example", title: "合成会话", agents: { main: { type: "main" } }, ...stateExtra }));
  return join(agentDir, "wire.jsonl");
}
async function parsed(adapter: HistoryAdapter, location: SourceLocation) {
  const snapshot = await adapter.readRecords!(location) as NormalizedSnapshot;
  const messages = new Map<string, SessionMessage>(); const usages = new Map<string, SessionUsage>();
  const meta = parseNormalizedSession(snapshot, { message: value => { messages.set(value.id, value); }, usage: value => { usages.set(value.id, value); } }, adapter.extract);
  return { snapshot, meta, messages: [...messages.values()], usages: [...usages.values()] };
}

test("Kimi v2 wire 配对工具、请求、压缩、显式终答及包含缓存的用量", async () => temporary(async directory => {
  const path = await kimiPath(directory);
  const rows = [kimiHeader,
    wire("turn.prompt", 0, { turnId: 0, promptId: "prompt", origin: { kind: "user" }, input: [{ type: "text", text: "合成请求" }] }),
    wire("context.append_message", 0.1, { message: { id: "prompt", role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "合成请求" }] } }),
    loop("step.begin", 1, { uuid: "step", turnId: "0" }),
    wire("llm.request", 1.1, { kind: "loop", provider: "synthetic-provider", model: "synthetic-model", thinkingEffort: "high" }),
    loop("content.part", 2, { uuid: "think", stepUuid: "step", part: { type: "think", think: "合成思考" } }),
    loop("tool.call", 2.1, { uuid: "call-event", stepUuid: "step", toolCallId: "call", name: "Read", args: { path: "src/example.ts", line_offset: 3, n_lines: 2 } }),
    loop("tool.result", 2.2, { toolCallId: "call", result: { output: "3\talpha\n4\tbeta", note: "<system>2 lines read from file starting from line 3. Total lines in file: 4. Requested range complete.</system>" } }),
    loop("content.part", 3, { uuid: "text", stepUuid: "step", part: { type: "text", text: "已完成" } }),
    loop("step.end", 4, { uuid: "step", finishReason: "end_turn", llmFirstTokenLatencyMs: 900, llmStreamDurationMs: 2000, usage: { inputOther: 10, inputCacheRead: 3, inputCacheCreation: 2, output: 5 } }),
    wire("turn.ended", 4.1, { turnId: 0, reason: "completed" }),
    wire("context.apply_compaction", 5, { summary: "合成摘要", compactedCount: 4, keptUserMessageCount: 1 }),
  ];
  await writeFile(path, encode(rows));
  const value = await parsed(kimiAdapter, { path, client: "kimi", format: "kimi-wire" });
  assert.equal(value.meta.project, "/workspace/example"); assert.equal(value.meta.title, "合成会话"); assert.equal(value.meta.turnCount, 1);
  assert.equal(value.usages.length, 1); assert.equal(value.usages[0]?.inputTokens, 15); assert.equal(value.usages[0]?.cachedInputTokens, 3); assert.equal(value.usages[0]?.cacheWriteTokens, 2);
  assert.equal(value.usages[0]?.provider, "synthetic-provider"); assert.equal(value.usages[0]?.reasoningEffort, "high"); assert.equal(value.usages[0]?.timing?.durationMs, 2900);
  assert.equal(value.messages.find(message => message.kind === "tool_call")?.status, "success");
  assert.equal(value.messages.find(message => message.text === "已完成")?.final, "explicit");
  assert.ok(value.messages.some(message => message.kind === "compression"));
  const evidence = kimiAdapter.extract("Read", { path: "src/example.ts", line_offset: 3 }, objectResult(rows[7]), "3\talpha\n4\tbeta", { source: {}, cursor: {} });
  assert.equal(evidence[0]?.fragments[0]?.historicalStart, 3); assert.equal(evidence[0]?.fragments[0]?.content, "alpha\nbeta");
  const raw = JSON.stringify(rows[7]); const reference = { path, format: "kimi-wire", sourceId: "kimi:synthetic", recordLine: 8, hash: normalizedHash(raw) };
  assert.equal((await kimiAdapter.readEvidence(reference))?.raw, raw);
}));
test("Kimi usage.record 与 step.end 去重，独立压缩请求保存真实桶", async () => temporary(async directory => {
  const path = await kimiPath(directory); const nativeUsage = { inputOther: 10, inputCacheRead: 3, inputCacheCreation: 2, output: 5 };
  await writeFile(path, encode([kimiHeader,
    wire("context.append_message", 0, { message: { id: "user", role: "user", content: [{ type: "text", text: "合成请求" }] } }),
    loop("step.begin", 1, { uuid: "step" }), wire("llm.request", 1.1, { kind: "loop", provider: "synthetic-provider", model: "model" }),
    loop("content.part", 2, { stepUuid: "step", part: { type: "text", text: "答复" } }),
    wire("usage.record", 3, { model: "model", usageScope: "turn", usage: nativeUsage }), loop("step.end", 3.1, { uuid: "step", finishReason: "end_turn", usage: nativeUsage }),
    wire("llm.request", 4, { kind: "compaction", provider: "synthetic-provider", model: "small-model" }),
    wire("usage.record", 5, { model: "small-model", usageScope: "session", usage: { ...nativeUsage, output: 2 } }),
    wire("context.apply_compaction", 5.1, { summary: "摘要", compactedCount: 2, summaryOutputTokens: 50 }),
  ]));
  const value = await parsed(kimiAdapter, { path, client: "kimi" }); assert.equal(value.usages.length, 2); assert.deepEqual(value.usages.map(item => item.outputTokens), [5, 2]);
}));
function objectResult(row: unknown): unknown { return (row as { event: { result: unknown } }).event.result; }

test("Kimi undo 切换保留历史分支，配对 undo 不再重复回退", async () => temporary(async directory => {
  const path = await kimiPath(directory);
  await writeFile(path, encode([kimiHeader,
    wire("context.append_message", 0, { message: { id: "first", role: "user", content: [{ type: "text", text: "第一轮" }] } }),
    wire("context.append_message", 1, { message: { id: "first-a", role: "assistant", content: [{ type: "text", text: "第一答" }] } }),
    wire("context.append_message", 2, { message: { id: "second", role: "user", content: [{ type: "text", text: "被回退请求" }] } }),
    wire("context.append_message", 3, { message: { id: "second-a", role: "assistant", content: [{ type: "text", text: "被回退答复" }] } }),
    wire("agent.switched", 4, { branch: "branch-2", base: { branch: "main", line: 3 }, legacyUndoLine: 7 }),
    wire("context.undo", 4, { count: 1 }), wire("context.undone", 4, { turns: 1 }),
    wire("context.append_message", 5, { message: { id: "third", role: "user", content: [{ type: "text", text: "新请求" }] } }),
  ]));
  const value = await parsed(kimiAdapter, { path, client: "kimi" });
  assert.equal(value.messages.find(message => message.text === "第一答")?.currentBranch, true);
  assert.equal(value.messages.find(message => message.text === "被回退答复")?.currentBranch, false);
  assert.equal(value.messages.find(message => message.text === "新请求")?.currentBranch, true);
  assert.equal(value.meta.branches?.filter(branch => branch.current).length, 1);
}));

test("Kimi 普通 undo 只移除相应锚点，自动注入不产生用户轮次", async () => temporary(async directory => {
  const path = await kimiPath(directory);
  await writeFile(path, encode([kimiHeader,
    wire("context.append_message", 0, { message: { id: "first", role: "user", content: [{ type: "text", text: "原请求" }] } }),
    wire("context.append_message", 1, { message: { role: "user", origin: { kind: "task", taskId: "task" }, content: [{ type: "text", text: "后台通知" }] } }),
    wire("context.append_message", 2, { message: { id: "second", role: "user", content: [{ type: "text", text: "待回退" }] } }),
    wire("context.undo", 3, { count: 1 }),
  ]));
  const value = await parsed(kimiAdapter, { path, client: "kimi" });
  assert.equal(value.meta.turnCount, 2); assert.equal(value.messages.find(message => message.text === "待回退")?.currentBranch, false);
  assert.equal(value.messages.find(message => message.text === "后台通知")?.kind, "context");
}));

test("Kimi 父子 Agent 身份与 fork 前缀各自去重，状态变更参与刷新", async () => temporary(async directory => {
  const parentPath = await kimiPath(directory, "parent", "main", { agents: { main: { type: "main" }, child: { type: "sub", parentAgentId: "main" } } });
  const parentRows = [kimiHeader, wire("context.append_message", 0, { message: { id: "user", role: "user", content: [{ type: "text", text: "共享前缀" }] } })];
  await writeFile(parentPath, encode(parentRows));
  const forkPath = await kimiPath(directory, "fork", "main", { forkedFrom: "parent" });
  await writeFile(forkPath, encode([...parentRows, wire("context.append_message", 1, { message: { id: "fork-user", role: "user", content: [{ type: "text", text: "新增请求" }] } })]));
  const fork = await parsed(kimiAdapter, { path: forkPath, client: "kimi" });
  assert.equal(fork.meta.relationship, "fork"); assert.equal(fork.messages.find(message => message.text === "共享前缀")?.copied, true);
  const childPath = await kimiPath(directory, "parent", "child", { agents: { main: { type: "main" }, child: { type: "sub", parentAgentId: "main" } } });
  await writeFile(childPath, encode([kimiHeader, wire("context.append_message", 0, { agentId: "child", message: { role: "user", content: [{ type: "text", text: "子任务" }] } })]));
  const child = await parsed(kimiAdapter, { path: childPath, client: "kimi" }); assert.equal(child.meta.clientSessionId, "parent/agent/child"); assert.equal(child.meta.relationship, "child");
  const before = child.snapshot.hash;
  await kimiPath(directory, "parent", "child", { title: "更新合成标题", agents: { child: { type: "sub", parentAgentId: "main" } } });
  assert.notEqual((await kimiAdapter.readRecords!({ path: childPath, client: "kimi" })).hash, before);
}));

test("Kimi 取消、失败、缺结果、未完成尾行及未知协议均保留缺口", async () => temporary(async directory => {
  const path = await kimiPath(directory);
  await writeFile(path, encode([kimiHeader,
    wire("context.append_message", 0, { message: { role: "user", content: [{ type: "text", text: "合成请求" }] } }),
    loop("step.begin", 1, { uuid: "step" }), loop("content.part", 2, { stepUuid: "step", part: { type: "text", text: "取消中的答复" } }),
    loop("tool.call", 2.1, { stepUuid: "step", toolCallId: "missing", name: "Read", args: { path: "example.ts" } }),
    loop("step.end", 3, { uuid: "step", finishReason: "interrupted" }), wire("turn.ended", 4, { turnId: 0, reason: "cancelled" }), wire("future.event", 5),
  ]) + "{\"type\":");
  const value = await parsed(kimiAdapter, { path, client: "kimi" }); assert.equal(value.messages.find(message => message.text === "取消中的答复")?.final, undefined);
  assert.ok(value.meta.gaps.some(gap => gap.kind === "unpaired_call")); assert.ok(value.meta.gaps.some(gap => gap.kind === "incomplete_record")); assert.ok(value.meta.gaps.some(gap => gap.kind === "unsupported_format"));
  await writeFile(path, encode([{ ...kimiHeader, protocol_version: "2.0" }]));
  assert.equal((await parsed(kimiAdapter, { path, client: "kimi" })).messages.length, 0);
}));

test("Kimi 读列片段、追加、编辑未知位置与失败不能制造覆盖", () => {
  const context = { source: {}, cursor: {} };
  const partial = kimiAdapter.extract("Read", { path: "example.ts", column_offset: 5 }, { output: "1\tpartial", note: "<system>1 line read from file starting from line 1. Line 1 fragment: columns [5, 9) of 9. Line complete.</system>" }, "1\tpartial", context);
  assert.equal(partial[0]?.fragments.length, 0);
  const write = kimiAdapter.extract("Write", { path: "example.ts", content: "alpha" }, { output: "Wrote 5 bytes to example.ts" }, "", context);
  assert.equal(write[0]?.fragments[0]?.historicalStart, 1);
  assert.equal(kimiAdapter.extract("Write", { path: "example.ts", content: "alpha", mode: "append" }, { output: "Appended 5 bytes to example.ts" }, "", context)[0]?.fragments.length, 0);
  const edit = kimiAdapter.extract("Edit", { path: "example.ts", old_string: "alpha", new_string: "beta" }, { output: "Replaced 1 occurrence in example.ts" }, "", context);
  assert.ok(edit[0]?.fragments.length); assert.equal(edit[0]?.fragments[0]?.historicalStart, undefined);
  assert.equal(kimiAdapter.extract("Edit", { path: "example.ts", old_string: "alpha", new_string: "beta" }, { isError: true, output: "denied" }, "", context)[0]?.fragments.length, 0);
});

test("Oh My Pi v3 标题、树叶、late model_usage 及独立调用不重复或错误合并", async () => temporary(async directory => {
  const path = join(directory, "session.jsonl");
  await writeFile(path, encode([{ type: "title", v: 1, title: "固定标题槽", updatedAt: at(0), pad: "" }, ompHeader(), ompUser(),
    ompAssistant("answer-a", "user", 2, { responseId: "same-response" }), ompAssistant("duplicate-response", "user", 3, { responseId: "same-response" }),
    { type: "title_change", id: "title-change", parentId: "answer-a", timestamp: at(4), title: "新标题", source: "user" },
    { type: "model_usage", id: "standalone", parentId: "user", activeLeafId: "title-change", timestamp: at(5), purpose: "auto-thinking", provider: "synthetic-provider", model: "synthetic-model", usage: tokenUsage, stopReason: "stop" },
  ]));
  const value = await parsed(ompAdapter, { path, client: "omp" });
  assert.equal(value.meta.title, "新标题"); assert.equal(value.usages.length, 2); assert.ok(value.usages.every(usage => usage.inputTokens === 15));
  assert.ok(value.usages.every(usage => usage.nativeReportedCostUsd === 0));
  assert.equal(value.meta.branches?.find(branch => branch.current)?.id, "title-change");
  assert.equal(value.messages.find(message => message.text === "auto-thinking")?.currentBranch, false);
  assert.equal(value.messages.find(message => message.kind === "assistant" && message.recordLine === 4)?.currentBranch, true);
  assert.equal(value.messages.find(message => message.kind === "assistant" && message.recordLine === 5)?.currentBranch, false);
}));

test("Oh My Pi 辅助标题索引不导入 prompt 或 recap 副本，索引变化参与刷新", async () => temporary(async directory => {
  const sessionDir = join(directory, "sessions", "project"); await mkdir(sessionDir, { recursive: true }); const path = join(sessionDir, "session.jsonl");
  await writeFile(path, encode([ompHeader(), ompUser()])); const databasePath = join(directory, "history.db");
  const db = new Database(databasePath); db.exec("CREATE TABLE session_titles(session_id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER)");
  db.prepare("INSERT INTO session_titles VALUES (?, ?, ?)").run("synthetic-omp", "辅助标题", 1); db.close();
  const first = await parsed(ompAdapter, { path, client: "omp" }); assert.equal(first.meta.title, "辅助标题"); assert.equal(first.meta.turnCount, 1);
  const writer = new Database(databasePath); writer.prepare("UPDATE session_titles SET title = ? WHERE session_id = ?").run("更新辅助标题", "synthetic-omp"); writer.close();
  const second = await parsed(ompAdapter, { path, client: "omp" }); assert.notEqual(second.snapshot.hash, first.snapshot.hash); assert.equal(second.meta.title, "更新辅助标题");
}));
test("Oh My Pi 推理是输出子桶，orchestration及工具成本不混入请求Token", async () => temporary(async directory => {
  const path = join(directory, "usage.jsonl");
  const nativeUsage = { ...tokenUsage, reasoningTokens: 2, contextTokens: 30, orchestration: { input: 400, output: 600, cacheRead: 200 }, cost: { ...tokenUsage.cost, total: 0.123 } };
  await writeFile(path, encode([ompHeader(), ompUser(), ompAssistant("assistant", "user", 2, { usage: nativeUsage })]));
  const value = await parsed(ompAdapter, { path, client: "omp" }); const report = value.usages[0]!;
  assert.equal(report.inputTokens, 15); assert.equal(report.outputTokens, 5); assert.equal(report.reasoningOutputTokens, 2); assert.equal(report.contextTokens, 30); assert.equal(report.nativeReportedCostUsd, 0.123);
}));

test("Oh My Pi fork 和子 Agent 使用父头原生身份，工具聚合用量不计入父模型", async () => temporary(async directory => {
  const parentPath = join(directory, "parent.jsonl"); const parentRows = [ompHeader({ id: "native-parent" }), ompUser(), ompAssistant("answer", "user", 2)];
  await writeFile(parentPath, encode(parentRows)); const forkPath = join(directory, "fork.jsonl");
  await writeFile(forkPath, encode([ompHeader({ id: "native-fork", parentSession: parentPath }), ...parentRows.slice(1), ompUser("new-user", "answer", 4)]));
  const fork = await parsed(ompAdapter, { path: forkPath, client: "omp" }); assert.equal(fork.meta.relationship, "fork"); assert.ok(fork.messages.some(message => message.copied)); assert.equal(fork.usages.length, 0);
  const childPath = join(directory, "child.jsonl");
  await writeFile(childPath, encode([ompHeader({ id: "native-child", parentSession: parentPath }),
    { type: "session_init", id: "init", parentId: null, timestamp: at(0), task: "子任务", systemPrompt: ["合成系统"], tools: [] },
    ompUser("child-user", "init", 1), ompAssistant("child-answer", "child-user", 2),
  ]));
  const child = await parsed(ompAdapter, { path: childPath, client: "omp" }); assert.equal(child.meta.relationship, "child"); assert.ok(child.meta.parentSessionId); assert.equal(child.usages.length, 1);
  const toolPath = join(directory, "tool.jsonl");
  await writeFile(toolPath, encode([ompHeader(), ompUser(), ompAssistant("call", "user", 1, { stopReason: "toolUse", content: [{ type: "toolCall", id: "task-call", name: "task", arguments: {} }] }),
    ompRow("result", "call", 2, { role: "toolResult", toolCallId: "task-call", toolName: "task", content: [{ type: "text", text: "子任务完成" }], isError: false, details: { usage: { ...tokenUsage, input: 200 } } }),
  ]));
  const tool = await parsed(ompAdapter, { path: toolPath, client: "omp" }); assert.equal(tool.usages.length, 1); assert.equal(tool.usages[0]?.inputTokens, 15); assert.ok(tool.meta.gaps.some(gap => gap.message.includes("工具专用")));
}));

test("Oh My Pi 原生 skill 展开及 MCP 结构化身份，后台上下文不增加需求轮次", async () => temporary(async directory => {
  const path = join(directory, "resources.jsonl");
  await writeFile(path, encode([ompHeader(),
    { type: "custom_message", id: "skill", parentId: null, timestamp: at(0), customType: "skill-prompt", attribution: "user", content: "合成 Skill 正文", details: { name: "synthetic", path: "/workspace/skills/synthetic/SKILL.md", lineCount: 1 } },
    ompRow("injection", "skill", 1, { role: "user", attribution: "agent", content: [{ type: "text", text: "后台注入" }] }),
    ompAssistant("call", "injection", 2, { stopReason: "toolUse", content: [{ type: "toolCall", id: "mcp-call", name: "mcp__synthetic_read", arguments: {} }] }),
    ompRow("result", "call", 3, { role: "toolResult", toolCallId: "mcp-call", toolName: "mcp__synthetic_read", isError: false, content: [{ type: "text", text: "合成 MCP 返回" }], details: { serverName: "synthetic", mcpToolName: "read" } }),
  ]));
  const value = await parsed(ompAdapter, { path, client: "omp" }); assert.equal(value.meta.turnCount, 1);
  assert.equal(value.messages.find(message => message.text === "合成 Skill 正文")?.resource?.kind, "skill_read");
  assert.equal(value.messages.find(message => message.kind === "tool_call")?.resource?.server, "synthetic");
  assert.equal(value.messages.find(message => message.text === "后台注入")?.kind, "context");
}));

test("Oh My Pi 精确读窗口和实际 patch；列截断和格式化 write 不伪造覆盖", () => {
  const context = { source: {}, cursor: {} };
  const result = { isError: false, content: [{ type: "text", text: "[example.ts#ABCD]\n3:alpha\n4:beta" }], details: { resolvedPath: "/workspace/example.ts", displayContent: { text: "alpha\nbeta", startLine: 3, lineNumbers: [3, 4] } } };
  const read = ompAdapter.extract("read", { path: "example.ts:3-4" }, result, "[example.ts#ABCD]\n3:alpha\n4:beta", context);
  assert.equal(read[0]?.fragments[0]?.historicalStart, 3); assert.equal(read[0]?.path, "/workspace/example.ts");
  const partial = ompAdapter.extract("read", { path: "example.ts" }, { ...result, details: { ...result.details, meta: { limits: { columnTruncated: { maxColumn: 2 } } } } }, "3:al…", context);
  assert.equal(partial[0]?.fragments.length, 0);
  const edit = ompAdapter.extract("edit", { path: "example.ts" }, { isError: false, details: { diff: "--- a/example.ts\n+++ b/example.ts\n@@ -1,1 +1,1 @@\n-before\n+after\n" } }, "", context);
  assert.ok(edit[0]?.fragments.some(fragment => fragment.kind === "added" && fragment.content.includes("after")));
  const write = ompAdapter.extract("write", { path: "example.ts", content: "before" }, { isError: false, details: { resolvedPath: "/workspace/example.ts" } }, "Successfully wrote 6 bytes to example.ts", context);
  assert.equal(write[0]?.fragments.length, 0);
});

test("Oh My Pi 追加、重写、重复事件、缺父及未完成尾行均保留刷新与原始证据", async () => temporary(async directory => {
  const path = join(directory, "refresh.jsonl"); const header = ompHeader(); const first = ompUser();
  await writeFile(path, encode([header, first])); const before = await parsed(ompAdapter, { path, client: "omp" });
  await appendFile(path, encode([ompAssistant("answer", "user", 2)])); const appended = await parsed(ompAdapter, { path, client: "omp" }); assert.notEqual(appended.snapshot.hash, before.snapshot.hash);
  const raw = JSON.stringify(first); assert.equal((await ompAdapter.readEvidence({ path, format: "omp-jsonl", sourceId: "omp:synthetic", recordLine: 2, hash: normalizedHash(raw) }))?.raw, raw);
  await writeFile(path, encode([header, ompUser("rewritten"), ompRow("future", "missing", 3, { role: "future", content: "合成未知" }), ompRow("future", "missing", 4, { role: "future", content: "重复" })]) + "{\"type\":");
  const rewritten = await parsed(ompAdapter, { path, client: "omp" }); assert.notEqual(rewritten.snapshot.hash, appended.snapshot.hash);
  assert.ok(rewritten.meta.gaps.some(gap => gap.kind === "ambiguous")); assert.ok(rewritten.meta.gaps.some(gap => gap.kind === "source_missing")); assert.ok(rewritten.meta.gaps.some(gap => gap.kind === "incomplete_record")); assert.ok(rewritten.meta.gaps.some(gap => gap.kind === "unsupported_format"));
  assert.equal(await ompAdapter.readEvidence({ path, format: "omp-jsonl", sourceId: "omp:synthetic", recordLine: 2, hash: normalizedHash(raw) }), undefined);
}));

test("客户端 home 与 OMP profile/XDG 加载规则不改变客户端身份", async () => temporary(async directory => {
  assert.deepEqual(kimiHistoryRoots(directory, {}), [join(directory, ".kimi-code", "sessions")]); assert.deepEqual(kimiHistoryRoots(directory, { KIMI_CODE_HOME: "/workspace/kimi" }), ["/workspace/kimi/sessions"]);
  assert.deepEqual(ompHistoryRoots(directory, {}), [join(directory, ".omp", "agent", "sessions")]);
  assert.deepEqual(ompHistoryRoots(directory, { OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/workspace/ignored" }), [join(directory, ".omp", "profiles", "work", "agent", "sessions")]);
  assert.deepEqual(ompHistoryRoots(directory, { OMP_PROFILE: "", PI_PROFILE: "work" }), [join(directory, ".omp", "agent", "sessions")]);
  const xdg = join(directory, "data"); await mkdir(join(xdg, "omp"), { recursive: true });
  assert.deepEqual(ompHistoryRoots(directory, { XDG_DATA_HOME: xdg }), [join(xdg, "omp", "sessions")]);
  assert.deepEqual(ompHistoryRoots(directory, { XDG_DATA_HOME: xdg, PI_CODING_AGENT_DIR: "/workspace/custom" }), ["/workspace/custom/sessions"]);
}));

test("Kimi 与 Oh My Pi 共用发现、地图、会话索引和证据回读，刷新重写发布完整结果", async () => temporary(async directory => {
  const path = await kimiPath(directory); const kimiRows = [kimiHeader,
    wire("context.append_message", 0, { message: { id: "user", role: "user", content: [{ type: "text", text: "端到端合成请求" }] } }),
    loop("step.begin", 1, { uuid: "step" }), loop("tool.call", 2, { stepUuid: "step", toolCallId: "read", name: "Read", args: { path: "src/example.ts" } }),
    loop("tool.result", 3, { toolCallId: "read", result: { output: "1\talpha", note: "<system>1 line read from file starting from line 1. Total lines in file: 1. Requested range complete.</system>" } }),
  ];
  await writeFile(path, encode(kimiRows)); const ompDir = join(directory, "omp-sources"); await mkdir(ompDir); const ompPath = join(ompDir, "session.jsonl");
  await writeFile(ompPath, encode([ompHeader(), ompUser(), ompAssistant("assistant", "user", 2)]));
  const roots = isolatedHistoryRoots({ kimi: join(directory, "sessions"), omp: ompDir }); const sources = await discoverSources(roots);
  assert.deepEqual(sources.map(source => source.client).sort(), ["kimi", "omp"]);
  const kimiSource = sources.find(source => source.client === "kimi")!;
  const history = await parseSource(path, "kimi", undefined, "kimi-wire", { location: kimiSource });
  assert.equal(history.events[0]?.status, "success"); assert.equal(history.events[0]?.fragments[0]?.historicalStart, 1);
  assert.equal((await kimiAdapter.readEvidence(history.events[0]!.sources[0]!))?.raw, JSON.stringify(kimiRows[3]));
  const store = new SessionStore(join(directory, "index.sqlite"));
  try {
    const first = store.createJob(); await refreshSessions(store, first.id, roots); assert.equal(store.getJob(first.id).status, "complete");
    assert.equal(store.list({ client: "kimi" }).total, 1); assert.equal(store.list({ client: "omp" }).total, 1);
    await writeFile(ompPath, encode([ompHeader(), ompUser("rewritten")]));
    const second = store.createJob(); await refreshSessions(store, second.id, roots); assert.equal(store.getJob(second.id).status, "complete");
    assert.equal(store.getJob(second.id).counts?.parsed, 1);
  } finally { store.close(); }
}));


test("Kimi 长工具步骤只使用原生 LLM 时长，无指标不以工具完成时间推算速度", async () => temporary(async directory => {
  const path = await kimiPath(directory); const usage = { inputOther: 10, inputCacheRead: 0, inputCacheCreation: 0, output: 400 };
  const rows = (metrics: Record<string, number>) => [kimiHeader,
    wire("context.append_message", 0, { message: { id: "user", role: "user", content: "检查" } }),
    loop("step.begin", 0, { uuid: "step" }), wire("llm.request", 0.1, { model: "synthetic-model" }),
    loop("content.part", 2, { stepUuid: "step", part: { type: "text", text: "调用工具" } }),
    loop("tool.call", 2, { stepUuid: "step", toolCallId: "read", name: "Read", args: { path: "src/example.ts" } }),
    loop("tool.result", 62, { toolCallId: "read", result: { output: "1\talpha", note: "1 line read from file starting from line 1." } }),
    loop("step.end", 62, { uuid: "step", finishReason: "tool_calls", usage, ...metrics }),
  ];
  await writeFile(path, encode(rows({ llmFirstTokenLatencyMs: 900, llmStreamDurationMs: 2000 })));
  let result = await parsed(kimiAdapter, { path, client: "kimi" });
  assert.equal(result.usages[0]?.timing?.method, "kimi_llm_metrics"); assert.equal(result.usages[0]?.timing?.window, "response"); assert.equal(result.usages[0]?.timing?.durationMs, 2900);
  assert.equal(result.usages[0]?.timing?.end, undefined); assert.equal(requestSpeed(result.usages[0]!).tokensPerSecond, 400000 / 2900);
  await writeFile(path, encode(rows({ llmStreamDurationMs: 2000 })));
  result = await parsed(kimiAdapter, { path, client: "kimi" }); assert.equal(result.usages[0]?.timing?.window, "generation"); assert.equal(result.usages[0]?.timing?.durationMs, 2000);
  await writeFile(path, encode(rows({})));
  result = await parsed(kimiAdapter, { path, client: "kimi" }); assert.equal(result.usages[0]?.timing?.durationMs, undefined); assert.equal(requestSpeed(result.usages[0]!).reason, "timing_missing");
}));

test("Kimi 无工具结束、失败与重试保留分别记录的模型时间，失败不进入速度", async () => temporary(async directory => {
  const path = await kimiPath(directory); const usage = { inputOther: 10, inputCacheRead: 0, inputCacheCreation: 0, output: 400 };
  await writeFile(path, encode([kimiHeader,
    wire("context.append_message", 0, { message: { id: "user", role: "user", content: "检查" } }),
    loop("step.begin", 1, { uuid: "failed" }), wire("llm.request", 1.1, { model: "synthetic-model" }),
    loop("content.part", 2, { stepUuid: "failed", part: { type: "text", text: "部分" } }),
    loop("step.end", 8, { uuid: "failed", finishReason: "error", usage, llmFirstTokenLatencyMs: 200, llmStreamDurationMs: 1300 }),
    loop("step.begin", 10, { uuid: "retried" }), wire("llm.request", 10.1, { model: "synthetic-model" }),
    loop("content.part", 12, { stepUuid: "retried", part: { type: "text", text: "完成" } }),
    loop("step.end", 14, { uuid: "retried", finishReason: "end_turn", usage, llmFirstTokenLatencyMs: 300, llmStreamDurationMs: 1700 }),
  ]));
  const result = await parsed(kimiAdapter, { path, client: "kimi" }); assert.equal(result.usages.length, 2);
  assert.equal(result.usages[0]?.timing?.durationMs, 1500); assert.equal(requestSpeed(result.usages[0]!).reason, "partial_response");
  assert.equal(result.usages[1]?.timing?.durationMs, 2000); assert.equal(requestSpeed(result.usages[1]!).tokensPerSecond, 200);
}));

test("Kimi state 元信息超过预算或链接到其他文件时不读取，保留缺口与目录身份", async () => temporary(async directory => {
  const path = await kimiPath(directory); await writeFile(path, encode([kimiHeader, wire("context.append_message", 1, { message: { id: "u", role: "user", content: "检查" } })]));
  const state = join(dirname(dirname(dirname(path))), "state.json"); await truncate(state, 16 * 1024 * 1024 + 1);
  let result = await parsed(kimiAdapter, { path, client: "kimi" }); assert.equal(result.meta.clientSessionId, "synthetic-kimi"); assert.ok(result.meta.gaps.some(gap => gap.kind === "budget_exceeded"));
  await rm(state); const external = join(directory, "external.json"); await writeFile(external, JSON.stringify({ id: "external-session", cwd: "/workspace/external" })); await symlink(external, state);
  result = await parsed(kimiAdapter, { path, client: "kimi" }); assert.equal(result.meta.clientSessionId, "synthetic-kimi"); assert.equal(result.meta.project, undefined); assert.ok(result.meta.gaps.some(gap => gap.kind === "parse_error"));
}));
