import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parseSource } from "../src/history/index.js";
import { geminiAdapter, geminiHistoryRoots, acceptsGeminiHistoryFile } from "../src/history/adapters/gemini.js";
import { qwenAdapter, qwenHistoryRoots, acceptsQwenHistoryFile } from "../src/history/adapters/qwen.js";
import { normalizedHash, parseNormalizedSession, type NormalizedSnapshot } from "../src/history/adapters/normalized.js";
import type { HistoryAdapter } from "../src/history/adapters/types.js";
import type { SourceLocation } from "../src/history/types.js";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";

const timestamp = "2026-10-14T01:00:00.000Z";
const serialized = (rows: unknown[]) => `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-native-google-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function sink() {
  const messages = new Map<string, SessionMessage>(); const usages = new Map<string, SessionUsage>();
  return { messages, usages, value: { message: (message: SessionMessage) => messages.set(message.id, message), usage: (usage: SessionUsage) => usages.set(usage.id, usage) } };
}

async function parsed(adapter: HistoryAdapter, source: SourceLocation) {
  const snapshot = await adapter.readRecords!(source) as NormalizedSnapshot;
  const collected = sink(); const meta = parseNormalizedSession(snapshot, collected.value, adapter.extract);
  return { snapshot, meta, messages: [...collected.messages.values()], usages: [...collected.usages.values()] };
}

async function geminiFile(directory: string, rows: unknown[], name = "session-synthetic.jsonl") {
  const root = join(directory, ".gemini"); const project = join(root, "tmp", "synthetic-project"); const path = join(project, "chats", name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(join(root, "projects.json"), JSON.stringify({ projects: { "/workspace/synthetic": "synthetic-project" } }));
  await writeFile(join(project, ".project_root"), "/workspace/synthetic"); await writeFile(path, serialized(rows));
  return { path, root, project };
}

const geminiHeader = { sessionId: "gemini-synthetic", projectHash: "not-a-path", startTime: timestamp, kind: "main" };
const geminiMessage = (id: string, content: string, extra: Record<string, unknown> = {}) => ({ id, type: "gemini", timestamp, content, model: "synthetic-model", ...extra });
const user = { id: "g-user", type: "user", timestamp, content: [{ text: "Inspect the synthetic file" }] };
const response = (id: string, name: string, output: string) => [{ functionResponse: { id, name, response: { output } } }];
const q = (uuid: string, parentUuid: string | null, type: string, extra: Record<string, unknown> = {}) => ({ uuid, parentUuid, sessionId: "qwen-synthetic", cwd: "/workspace/synthetic", version: "0.25.1", timestamp, type, ...extra });

test("Gemini 折叠完整消息更新、补丁与回退，用量和工具只形成一份当前状态", async () => temporary(async directory => {
  const call = { id: "read-one", name: "read_file", args: { file_path: "src/example.ts", start_line: 2, end_line: 3 }, timestamp, status: "executing" };
  const rows = [geminiHeader, user, geminiMessage("g-answer", "before", { toolCalls: [call] }),
    geminiMessage("g-answer", "before", { thoughts: [{ subject: "Inspect", description: "Synthetic thought", timestamp }],
      tokens: { input: 100, output: 10, cached: 20, thoughts: 3, tool: 0, total: 113 },
      toolCalls: [{ ...call, status: "success", result: response(call.id, call.name, "two\nthree") }] }),
    { $patch: { updates: [{ id: "g-answer", content: [{ text: "patched answer" }], toolCalls: [{ id: call.id, result: response(call.id, call.name, "two\nthree") }] }] } },
    geminiMessage("g-discard", "discarded", { tokens: { input: 500, output: 60, cached: 0, thoughts: 0 } }),
    { $rewindTo: "g-discard" }, { $set: { summary: "Synthetic title", lastUpdated: timestamp } }];
  const file = await geminiFile(directory, rows);
  const [source] = await geminiAdapter.discoverFile!({ path: file.path, client: "gemini" });
  const result = await parsed(geminiAdapter, source!);
  assert.equal(result.meta.project, "/workspace/synthetic"); assert.equal(result.meta.title, "Synthetic title");
  assert.equal(result.messages.filter(message => message.kind === "assistant").length, 1);
  assert.equal(result.messages.find(message => message.kind === "assistant")?.text, "patched answer");
  assert.equal(result.messages.find(message => message.kind === "assistant")?.final, undefined);
  assert.equal(result.messages.filter(message => message.kind === "tool_call").length, 1);
  assert.equal(result.messages.find(message => message.kind === "tool_call")?.status, "success");
  assert.ok(result.messages.some(message => message.kind === "thinking" && message.text.includes("Synthetic thought")));
  assert.equal(result.usages.length, 1); assert.equal(result.usages[0]?.inputTokens, 100); assert.equal(result.usages[0]?.outputTokens, 13);
  assert.equal(result.usages[0]?.cachedInputTokens, 20); assert.equal(result.usages[0]?.reasoningOutputTokens, 3);
  assert.equal(result.usages[0]?.timing, undefined); assert.equal(result.usages[0]?.requestMessageIds, undefined);
  assert.ok(result.meta.gaps.some(gap => gap.message.includes("实际请求覆盖未知")));
  const original = JSON.stringify(rows[4]);
  assert.equal((await geminiAdapter.readEvidence({ sourceId: source!.sourceId!, format: "gemini-jsonl", path: file.path, recordLine: 5, hash: normalizedHash(original) }))?.raw, original);
  assert.equal(await geminiAdapter.readEvidence({ sourceId: source!.sourceId!, path: file.path, recordLine: 5, hash: normalizedHash("other") }), undefined);
}));

test("Gemini 原生 order/remove/checkpoint 与未知 rewind 保持相同加载规则", async () => temporary(async directory => {
  const rows = [geminiHeader, user, geminiMessage("first", "one"), geminiMessage("second", "two"),
    { $patch: { id: "first", content: "changed", removeIds: ["second"], orderIds: ["first", "g-user"] } }];
  const file = await geminiFile(directory, rows);
  const first = await parsed(geminiAdapter, { path: file.path, client: "gemini" });
  assert.deepEqual(first.messages.filter(message => ["user", "assistant"].includes(message.kind)).map(message => message.text), ["changed", user.content[0]!.text]);
  await writeFile(file.path, serialized([...rows, { $set: { messages: [user, geminiMessage("checkpoint", "saved checkpoint")] } }]));
  const second = await parsed(geminiAdapter, { path: file.path, client: "gemini" });
  assert.deepEqual(second.messages.filter(message => message.kind === "assistant").map(message => message.text), ["saved checkpoint"]);
  await writeFile(file.path, serialized([...rows, { $rewindTo: "missing-id" }]));
  const third = await parsed(geminiAdapter, { path: file.path, client: "gemini" });
  assert.equal(third.messages.filter(message => ["user", "assistant"].includes(message.kind)).length, 0);
  assert.ok(third.meta.gaps.some(gap => gap.kind === "source_missing"));
}));

test("Gemini 项目旁路变更、子会话、冲突、坏行及尾行分别保留证据边界", async () => temporary(async directory => {
  const file = await geminiFile(directory, [{ ...geminiHeader, kind: "subagent", sessionId: "synthetic-child" }, user], "synthetic-parent/synthetic-child.jsonl");
  const before = await parsed(geminiAdapter, { path: file.path, client: "gemini" });
  assert.equal(before.meta.relationship, "child"); assert.ok(before.meta.parentSessionId?.startsWith("gemini:"));
  await writeFile(join(file.root, "projects.json"), JSON.stringify({ projects: { "/workspace/changed": "synthetic-project" } }));
  const conflicting = await parsed(geminiAdapter, { path: file.path, client: "gemini" });
  assert.notEqual(conflicting.snapshot.hash, before.snapshot.hash); assert.equal(conflicting.meta.project, undefined);
  assert.ok(conflicting.meta.gaps.some(gap => gap.kind === "ambiguous" && gap.message.includes("路径冲突")));
  await writeFile(file.path, `${serialized([geminiHeader, user, { type: "future-native", value: "one" }])}{bad}\n{"incomplete":`);
  const broken = await parsed(geminiAdapter, { path: file.path, client: "gemini" });
  assert.ok(broken.meta.gaps.some(gap => gap.kind === "parse_error")); assert.ok(broken.meta.gaps.some(gap => gap.kind === "incomplete_record"));
  assert.ok(broken.meta.gaps.some(gap => gap.kind === "unsupported_format"));
  assert.ok(broken.messages.some(message => message.kind === "context" && message.text.includes("future-native")));
  assert.equal(geminiAdapter.quickCheck, undefined);
}));

test("Gemini 错误、取消、缺少工具结果和缺失用量不补造成功或 API 请求", async () => temporary(async directory => {
  const call = (id: string, status: string) => ({ id, name: "read_file", args: { file_path: "src/example.ts" }, timestamp, status });
  const file = await geminiFile(directory, [geminiHeader, user, geminiMessage("tools", "", { toolCalls: [call("error", "error"), call("cancelled", "cancelled"), call("pending", "executing")] }), geminiMessage("end", "still unknown")]);
  const result = await parsed(geminiAdapter, { path: file.path, client: "gemini" });
  assert.equal(result.usages.length, 0);
  assert.equal(result.messages.find(message => message.kind === "tool_result" && message.callId === "error")?.status, "failure");
  assert.equal(result.messages.find(message => message.kind === "tool_result" && message.callId === "cancelled")?.status, "unknown");
  assert.ok(result.meta.gaps.some(gap => gap.kind === "unpaired_call"));
  assert.ok(result.messages.filter(message => message.kind === "assistant").every(message => !message.final));
}));

test("Gemini 工具证据只接受实际返回窗口、确认 diff 和正常 Shell 输出", () => {
  const context = { source: {}, cursor: {} };
  const read = geminiAdapter.extract("read_file", { file_path: "src/a.ts", start_line: 3, end_line: 4 }, { status: "success" }, "third\nfourth", context);
  assert.equal(read[0]?.fragments[0]?.historicalStart, 3);
  const truncated = geminiAdapter.extract("read_file", { file_path: "src/a.ts" }, { status: "success" }, "\nIMPORTANT: The file content has been truncated.\nStatus: Showing lines 5-6 of 10 total lines.\nAction: Read more.\n\n--- FILE CONTENT (truncated) ---\nfive\nsix", context);
  assert.equal(truncated[0]?.fragments[0]?.historicalStart, 5); assert.ok(truncated[0]?.reason);
  assert.equal(geminiAdapter.extract("read_file", { file_path: "src/a.ts" }, { status: "success" }, "partial... [truncated]", context)[0]?.fragments.length, 0);
  const edit = geminiAdapter.extract("replace", { file_path: "src/a.ts", old_string: "requested", new_string: "guess" }, { status: "success", resultDisplay: { fileDiff: "@@ -2 +2 @@\n-before\n+actual" } }, "", context);
  assert.ok(edit[0]?.fragments.some(fragment => fragment.content.includes("actual")));
  assert.equal(geminiAdapter.extract("replace", { file_path: "src/a.ts", old_string: "before", new_string: "after" }, { status: "success" }, "done", context)[0]?.fragments.length, 0);
  const shell = geminiAdapter.extract("run_shell_command", { command: "sed -n '3,4p' src/a.ts" }, { status: "success" }, "Output: third\nfourth\nExit Code: 0", context);
  assert.equal(shell[0]?.fragments[0]?.historicalStart, 3);
  const wrappedShell = geminiAdapter.extract("run_shell_command", { command: "sed -n '3,4p' src/a.ts" }, { status: "success" }, "<untrusted_context>\nOutput: third\nfourth\nExit Code: 0\n</untrusted_context>", context);
  assert.equal(wrappedShell[0]?.fragments[0]?.historicalStart, 3);
  assert.equal(geminiAdapter.extract("run_shell_command", { command: "cat src/a.ts" }, { status: "success" }, "Output: failed\nExit Code: 1", context)[0]?.fragments.length, 0);
});

test("Qwen 汇总 UUID 片段与用量、配对结果、明确压缩及终答，不补造请求耗时", async () => temporary(async directory => {
  const path = join(directory, "qwen.jsonl");
  const rows = [q("u", null, "user", { promptId: "p", provenance: "real_user", executionContext: { authType: "openai" }, message: { role: "user", parts: [{ text: "Synthetic prompt" }] } }),
    q("a", "u", "assistant", { model: "synthetic", message: { role: "model", parts: [{ text: "first fragment" }, { thought: true, text: "think" }, { functionCall: { id: "read", name: "read_file", args: { file_path: "src/a.ts", offset: 2, limit: 2 } } }] }, usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 8, thoughtsTokenCount: 3, cachedContentTokenCount: 20 } }),
    q("a", "u", "assistant", { message: { role: "model", parts: [{ text: "second fragment" }] }, usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 3, cachedContentTokenCount: 20 } }),
    q("r", "a", "tool_result", { message: { role: "user", parts: response("read", "read_file", "third\nfourth") }, toolCallResult: { callId: "read", status: "success" } }),
    q("c", "r", "system", { subtype: "chat_compression", systemPayload: { info: { compressionStatus: 1 }, compressedHistory: [{ role: "user", parts: [{ text: "summary" }] }] } }),
    q("final", "c", "assistant", { model: "synthetic", message: { role: "model", parts: [{ text: "Synthetic final" }] } }),
    q("end", "final", "system", { subtype: "turn_result", systemPayload: { promptId: "p", state: "completed", stopReason: "end_turn", endedAt: Date.parse(timestamp) + 1000 } })];
  await writeFile(path, serialized(rows));
  const result = await parsed(qwenAdapter, { path, client: "qwen" });
  assert.equal(result.meta.turnCount, 1); assert.equal(result.messages.filter(message => message.kind === "assistant").length, 2);
  assert.equal(result.messages.find(message => message.kind === "assistant")?.text, "first fragment\nsecond fragment");
  assert.ok(result.messages.some(message => message.kind === "thinking")); assert.ok(result.messages.some(message => message.kind === "compression"));
  assert.equal(result.messages.find(message => message.kind === "tool_call")?.status, "success");
  assert.equal(result.messages.find(message => message.text === "Synthetic final")?.final, "explicit");
  assert.equal(result.usages.length, 1); assert.equal(result.usages[0]?.outputTokens, 10); assert.equal(result.usages[0]?.reasoningOutputTokens, 3);
  assert.equal(result.usages[0]?.timing, undefined); assert.equal(result.usages[0]?.provider, undefined);
  const raw = JSON.stringify(rows[2]);
  assert.equal((await qwenAdapter.readEvidence({ sourceId: result.snapshot.source.sourceId!, path, recordLine: 3, hash: normalizedHash(raw) }))?.raw, raw);
  assert.equal(qwenAdapter.quickCheck, undefined);
}));

test("Qwen 父链保留回退后多分支，父缺失与循环不猜测连接", async () => temporary(async directory => {
  const path = join(directory, "qwen-tree.jsonl");
  await writeFile(path, serialized([q("u", null, "user", { message: { parts: [{ text: "prompt" }] } }), q("old", "u", "assistant", { message: { parts: [{ text: "old branch" }] } }),
    q("rewind", "u", "system", { subtype: "rewind", systemPayload: { truncatedCount: 1 } }), q("new", "rewind", "assistant", { message: { parts: [{ text: "new branch" }] } })]));
  const result = await parsed(qwenAdapter, { path, client: "qwen" });
  assert.equal(result.meta.branches?.length, 2); assert.equal(result.messages.find(message => message.text === "new branch")?.currentBranch, true);
  assert.equal(result.messages.find(message => message.text === "old branch")?.currentBranch, false);
  assert.equal(result.messages.find(message => message.text === "prompt")?.branchIds?.length, 2);
  await writeFile(path, serialized([q("missing", "gone", "assistant", { message: { parts: [{ text: "orphan" }] } }), q("cycle", "cycle", "assistant")]));
  const broken = await parsed(qwenAdapter, { path, client: "qwen" });
  assert.ok(broken.meta.gaps.some(gap => gap.kind === "source_missing")); assert.ok(broken.meta.gaps.some(gap => gap.kind === "parse_error"));
}));

test("Qwen sidechain 单独发现且不增加主会话需求，分叉复制不再计用量", async () => temporary(async directory => {
  const path = join(directory, "qwen-agent.jsonl");
  await writeFile(path, serialized([q("u", null, "user", { message: { parts: [{ text: "human" }] } }),
    q("child-u", null, "user", { isSidechain: true, agentId: "synthetic-agent", message: { parts: [{ text: "agent task" }] } }),
    q("child-a", "child-u", "assistant", { isSidechain: true, agentId: "synthetic-agent", message: { parts: [{ text: "agent output" }] }, usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } })]));
  const sources = await qwenAdapter.discoverFile!({ path, client: "qwen" }); assert.equal(sources.length, 2);
  const main = await parsed(qwenAdapter, sources[0]!); const child = await parsed(qwenAdapter, sources[1]!);
  assert.equal(main.meta.turnCount, 1); assert.equal(main.usages.length, 0); assert.equal(child.meta.relationship, "child");
  assert.ok(child.messages.some(message => message.text === "agent output")); assert.equal(child.usages.length, 1);
  await writeFile(path, serialized([q("inherited", null, "assistant", { forkedFrom: { sessionId: "synthetic-parent", messageUuid: "inherited" }, message: { parts: [{ text: "copied output" }] }, usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 } }), q("new", "inherited", "user", { message: { parts: [{ text: "new prompt" }] } })]));
  const fork = await parsed(qwenAdapter, { path, client: "qwen" }); assert.equal(fork.meta.relationship, "fork");
  assert.equal(fork.usages.length, 0); assert.ok(fork.messages.some(message => message.copied));
}));

test("Qwen provider 未知时不猜推理包含关系，字段缺失、真实零及缓存冲突分别保留", async () => temporary(async directory => {
  const path = join(directory, "qwen-usage.jsonl");
  await writeFile(path, serialized([q("u", null, "user"), q("unknown", "u", "assistant", { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 3, cachedContentTokenCount: 101 } }),
    q("zero", "unknown", "assistant", { usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, thoughtsTokenCount: 0, cachedContentTokenCount: 0 } }), q("missing", "zero", "assistant")]));
  const result = await parsed(qwenAdapter, { path, client: "qwen" }); assert.equal(result.usages.length, 2);
  assert.equal(result.usages[0]?.outputTokens, undefined); assert.equal(result.usages[0]?.cachedInputTokens, undefined);
  assert.equal(result.usages[1]?.inputTokens, 0); assert.equal(result.usages[1]?.outputTokens, 0);
  await writeFile(path, serialized([q("u", null, "user", { executionContext: { authType: "gemini" } }), q("a", "u", "assistant", { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 3 } })]));
  assert.equal((await parsed(qwenAdapter, { path, client: "qwen" })).usages[0]?.outputTokens, 13);
}));

test("Qwen 失败、取消、缺少结果、未知 subtype 和完整同尺寸内容刷新", async () => temporary(async directory => {
  const path = join(directory, "qwen-status.jsonl");
  const rows = [q("u", null, "user"), q("a", "u", "assistant", { message: { parts: ["bad", "cancel", "pending"].map(id => ({ functionCall: { id, name: "read_file", args: { file_path: "src/a.ts" } } })) } }),
    q("bad-r", "a", "tool_result", { message: { parts: response("bad", "read_file", "error") }, toolCallResult: { status: "error", error: { message: "synthetic failure" } } }),
    q("cancel-r", "bad-r", "tool_result", { message: { parts: response("cancel", "read_file", "cancelled") }, toolCallResult: { status: "cancelled" } }),
    q("future", "cancel-r", "system", { subtype: "future_type", systemPayload: { value: "first" } })];
  await writeFile(path, `${serialized(rows)}{"incomplete":`);
  const first = await parsed(qwenAdapter, { path, client: "qwen" });
  assert.ok(first.messages.some(message => message.kind === "tool_result" && message.status === "failure"));
  assert.ok(first.messages.some(message => message.kind === "tool_result" && message.status === "unknown"));
  assert.ok(first.meta.gaps.some(gap => gap.kind === "unpaired_call")); assert.ok(first.meta.gaps.some(gap => gap.kind === "incomplete_record"));
  assert.ok(first.meta.gaps.some(gap => gap.kind === "unsupported_format"));
  rows[4] = q("future", "cancel-r", "system", { subtype: "future_type", systemPayload: { value: "other" } });
  await writeFile(path, `${serialized(rows)}{"incomplete":`);
  assert.notEqual((await parsed(qwenAdapter, { path, client: "qwen" })).snapshot.hash, first.snapshot.hash);
}));

test("Qwen 工具参数偏移、实际 diff 与结构化 shell 返回保留严格范围", () => {
  const context = { source: {}, cursor: {} };
  const read = qwenAdapter.extract("read_file", { file_path: "src/a.ts", offset: 2, limit: 2 }, { status: "success" }, "third\nfourth", context);
  assert.equal(read[0]?.fragments[0]?.historicalStart, 3);
  const window = qwenAdapter.extract("read_file", { file_path: "src/a.ts" }, { status: "success" }, "Showing lines 5-6 of at least 20 total lines.\n\n---\n\nfive\nsix", context);
  assert.equal(window[0]?.fragments[0]?.historicalStart, 5);
  assert.equal(qwenAdapter.extract("read_file", { file_path: "src/a.ts" }, { status: "success" }, "partial... [truncated]", context)[0]?.fragments.length, 0);
  const result = { status: "success", resultDisplay: { fileDiff: "@@ -2 +2 @@\n-before\n+actual", originalContent: "before", newContent: "actual" } };
  assert.ok(qwenAdapter.extract("edit", { file_path: "src/a.ts", old_string: "before", new_string: "requested" }, result, "", context)[0]?.fragments.some(fragment => fragment.content.includes("actual")));
  assert.equal(qwenAdapter.extract("edit", { file_path: "src/a.ts" }, { ...result, resultDisplay: { ...result.resultDisplay, truncatedForSession: true } }, "", context)[0]?.fragments.length, 0);
  const shell = { status: "success", resultDisplay: { type: "shell_result", version: 1, outcome: "completed", exitCode: 0, truncated: false, output: "third\nfourth" } };
  assert.equal(qwenAdapter.extract("run_shell_command", { command: "sed -n '3,4p' src/a.ts" }, shell, "", context)[0]?.fragments[0]?.historicalStart, 3);
  assert.equal(qwenAdapter.extract("run_shell_command", { command: "cat src/a.ts" }, { status: "success" }, "unproven", context)[0]?.fragments.length, 0);
});

test("原生目录覆盖、候选文件过滤与 Qwen 会话副本选择", () => {
  assert.deepEqual(geminiHistoryRoots("/synthetic-home", { GEMINI_CLI_HOME: "/synthetic-override" }), ["/synthetic-override/.gemini/tmp", "/synthetic-override/.cache/.gemini/tmp"]);
  assert.deepEqual(qwenHistoryRoots("/synthetic-home", { QWEN_HOME: "/qwen-home", QWEN_RUNTIME_DIR: "~/runtime" }), ["/synthetic-home/runtime/projects"]);
  assert.equal(acceptsGeminiHistoryFile("/runtime/tmp/project/chats/session.jsonl"), true); assert.equal(acceptsGeminiHistoryFile("/runtime/tmp/log.jsonl"), false);
  assert.equal(acceptsQwenHistoryFile("/runtime/projects/project/chats/archive/session.jsonl"), true); assert.equal(acceptsQwenHistoryFile("/runtime/projects/project/requests/request.jsonl"), false);
  const older: SourceLocation = { path: "/runtime/projects/project/chats/archive/a.jsonl", client: "qwen", format: "qwen-jsonl", sessionId: "same", sourceCompleteness: { supported: true, complete: true, fingerprint: "old", version: 20 } };
  const current: SourceLocation = { ...older, path: "/runtime/projects/project/chats/a.jsonl", sourceCompleteness: { supported: true, complete: true, fingerprint: "new", version: 10 } };
  const selected = qwenAdapter.selectSources!([older, current]); assert.equal(selected.length, 1); assert.equal(selected[0]?.path, current.path); assert.equal(selected[0]?.adapterGap?.kind, "ambiguous");
  const codexActive: SourceLocation = { path: "/synthetic/codex/sessions/same.jsonl", client: "codex", format: "codex-jsonl", sessionId: "same" };
  const codexArchive: SourceLocation = { ...codexActive, path: "/synthetic/codex/archived_sessions/same.jsonl" };
  assert.deepEqual(qwenAdapter.selectSources!([codexActive, codexArchive, older, current]).filter(location => location.client === "codex"), [codexActive, codexArchive]);
  assert.deepEqual(geminiAdapter.selectSources!([codexActive, codexArchive, older, current]), [codexActive, codexArchive, older, current]);
});

test("Gemini 同会话来源副本按明确更新时间选择且不影响其他客户端", async () => temporary(async directory => {
  const earlier = await geminiFile(directory, [geminiHeader, user, geminiMessage("answer", "earlier"), { $set: { lastUpdated: "2026-10-14T01:00:00.000Z" } }], "session-earlier.jsonl");
  const later = await geminiFile(directory, [geminiHeader, user, geminiMessage("answer", "later"), { $set: { lastUpdated: "2026-10-14T02:00:00.000Z" } }], "session-later.jsonl");
  const [first] = await geminiAdapter.discoverFile!({ path: earlier.path, client: "gemini" }); const [second] = await geminiAdapter.discoverFile!({ path: later.path, client: "gemini" });
  const other: SourceLocation = { path: "/synthetic/qwen/same.jsonl", client: "qwen", format: "qwen-jsonl", sessionId: first!.sessionId };
  const selected = geminiAdapter.selectSources!([first!, second!, other]); assert.equal(selected.length, 2);
  assert.equal(selected.find(source => source.client === "gemini")?.path, later.path); assert.ok(selected.includes(other));
}));

test("Qwen 绝对用户runtime配置可自动发现，env优先且相对路径不猜旧cwd", async () => temporary(async directory => {
  const home = join(directory, "user"); const root = join(home, ".qwen"); await mkdir(root, { recursive: true });
  await writeFile(join(root, "settings.json"), JSON.stringify({ advanced: { runtimeOutputDir: "~/synthetic-runtime" } }));
  assert.deepEqual(qwenHistoryRoots(home, {}), [join(home, "synthetic-runtime", "projects")]);
  assert.deepEqual(qwenHistoryRoots(home, { QWEN_RUNTIME_DIR: "/explicit-runtime" }), ["/explicit-runtime/projects"]);
  await writeFile(join(root, "settings.json"), JSON.stringify({ advanced: { runtimeOutputDir: "relative-runtime" } }));
  assert.deepEqual(qwenHistoryRoots(home, {}), [join(root, "projects")]);
}));

test("Gemini 与 Qwen 共享代码地图解析及原始工具回读形成同一确认内容", async () => temporary(async directory => {
  const gemini = await geminiFile(directory, [geminiHeader, user, geminiMessage("call", "", { toolCalls: [{ id: "read-map", name: "read_file", args: { file_path: "src/example.ts", start_line: 2 }, timestamp,
    status: "success", result: response("read-map", "read_file", "two\nthree") }] })]);
  const g = await parseSource(gemini.path, "gemini", undefined, "gemini-jsonl");
  assert.equal(g.cwd, "/workspace/synthetic"); assert.equal(g.events[0]?.status, "success"); assert.equal(g.events[0]?.fragments[0]?.historicalStart, 2);
  assert.equal((await geminiAdapter.readEvidence(g.events[0]!.sources[0]!))?.raw, JSON.stringify(geminiMessage("call", "", { toolCalls: [{ id: "read-map", name: "read_file", args: { file_path: "src/example.ts", start_line: 2 }, timestamp, status: "success", result: response("read-map", "read_file", "two\nthree") }] })));
  const path = join(directory, "qwen-map.jsonl");
  await writeFile(path, serialized([q("u", null, "user"), q("a", "u", "assistant", { message: { parts: [{ functionCall: { id: "read-map", name: "read_file", args: { file_path: "src/example.ts", offset: 1, limit: 2 } } }] } }),
    q("r", "a", "tool_result", { toolCallResult: { status: "success" }, message: { parts: response("read-map", "read_file", "two\nthree") } })]));
  const result = await parseSource(path, "qwen", undefined, "qwen-jsonl");
  assert.equal(result.events[0]?.status, "success"); assert.equal(result.events[0]?.fragments[0]?.historicalStart, 2);
  assert.equal(result.events[0]?.fragments[0]?.content, g.events[0]?.fragments[0]?.content);
  assert.ok(await qwenAdapter.readEvidence(result.events[0]!.sources[0]!));
}));
