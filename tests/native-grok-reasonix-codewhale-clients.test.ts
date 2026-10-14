import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";
import type { SourceLocation } from "../src/history/types.js";
import type { HistoryAdapter } from "../src/history/adapters/types.js";
import { grokAdapter, grokHistoryRoots } from "../src/history/adapters/grok.js";
import { reasonixAdapter, reasonixHistoryRoots } from "../src/history/adapters/reasonix.js";
import { codewhaleAdapter, codewhaleHistoryRoots } from "../src/history/adapters/codewhale.js";
import { normalizedHash, parseNormalizedSession } from "../src/history/adapters/normalized.js";
import type { NormalizedSnapshot } from "../src/history/adapters/normalized.js";
import { errorDescriptor } from "../src/i18n/diagnostics.js";
import { translateMessage } from "../src/i18n/index.js";
import { discoverSources, parseSource, resolveSharedHistory } from "../src/history/index.js";

const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const time = "2026-09-01T01:00:00.000Z";
async function temporary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "manor-native-three-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function save(path: string, value: unknown, lines = false) {
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, lines ? jsonl(value as unknown[]) : JSON.stringify(value));
}
async function session(adapter: HistoryAdapter, location: SourceLocation) {
  const snapshot = await adapter.readRecords!(location) as NormalizedSnapshot;
  const messages = new Map<string, SessionMessage>(); const usages = new Map<string, SessionUsage>();
  const meta = parseNormalizedSession(snapshot, { message: value => messages.set(value.id, value), usage: value => usages.set(value.id, value) }, adapter.extract);
  return { snapshot, meta, messages: [...messages.values()], usages: [...usages.values()] };
}
function grok(update: Record<string, unknown>, id: string, prompt = "prompt-a", extra: Record<string, unknown> = {}) {
  return { timestamp: 1788224400, method: update.sessionUpdate === "turn_completed" || String(update.sessionUpdate).startsWith("response_") ? "_x.ai/session/update" : "session/update",
    params: { sessionId: "grok-session", update, _meta: { eventId: id, promptId: prompt, agentTimestampMs: Date.parse(time), ...extra } } };
}
async function grokFiles(root: string, rows: unknown[]) {
  const path = join(root, "sessions", "workspace", "grok-session", "updates.jsonl");
  await save(path, rows, true);
  await save(join(dirname(path), "summary.json"), { info: { id: "grok-session", cwd: "/workspace/app" }, session_summary: "检查代码", current_model_id: "synthetic-model" });
  return path;
}

test("Grok 原生更新还原工具，逐响应与累计用量分别保留，派生历史不重复", async () => temporary(async root => {
  const rows = [grok({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "读取代码" } }, "u"),
    grok({ sessionUpdate: "response_started", message_id: "response-a", model: "synthetic-model", input_tokens: 80, cache_read_input_tokens: 15, cache_creation_input_tokens: 5 }, "start"),
    grok({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "检查中" } }, "a"),
    grok({ sessionUpdate: "tool_call", toolCallId: "read-a", title: "读取文件", rawInput: { target_file: "src/a.ts" }, status: "pending", _meta: { "x.ai/tool": { name: "read_file" } } }, "call"),
    grok({ sessionUpdate: "tool_call_update", toolCallId: "read-a", status: "completed", content: [{ type: "content", content: { type: "text", text: "1→alpha\nbeta" } }], rawOutput: { FileContent: { absolute_path: "/workspace/app/src/a.ts", offset: 1, raw_output: "alpha\nbeta\n" } } }, "result"),
    grok({ sessionUpdate: "response_completed", message_id: "response-a", stop_reason: "tool_use", usage: { input_tokens: 80, cache_read_input_tokens: 15, cache_creation_input_tokens: 5, output_tokens: 10, reasoning_tokens: 4 } }, "response-end"),
    grok({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "完成" } }, "final"),
    grok({ sessionUpdate: "turn_completed", prompt_id: "prompt-a", stop_reason: "end_turn", usage: { totals: { input_tokens: 100, output_tokens: 10, model_calls: 1, cost_usd_ticks: 20000000 } } }, "turn-end")];
  const path = await grokFiles(root, rows);
  await save(join(dirname(path), "chat_history.jsonl"), [{ role: "user", content: "不应重复" }], true);
  await save(join(dirname(path), "usage.json"), { sessionId: "grok-session", session: { inputTokens: 100, outputTokens: 10, modelCalls: 1, costUsdTicks: 20000000 } });
  const result = await session(grokAdapter, { client: "grok", path });
  assert.equal(result.meta.turnCount, 1); assert.equal(result.usages.length, 1);
  assert.equal(result.usages[0]?.inputTokens, 100); assert.equal(result.usages[0]?.cachedInputTokens, 15); assert.equal(result.usages[0]?.cacheWriteTokens, 5);
  assert.equal(result.usages[0]?.outputTokens, 10); assert.equal(result.usages[0]?.reasoningOutputTokens, 4);
  assert.equal(result.meta.usageReports?.length, 2); assert.equal(result.meta.usageReports?.[1]?.scope, "session");
  assert.equal(result.messages.find(message => message.kind === "tool_call")?.status, "success");
  assert.equal(result.messages.find(message => message.text === "完成")?.final, "explicit");
  const parsed = await parseSource(path, "grok", undefined, grokAdapter.id);
  assert.equal(parsed.events[0]?.kind, "read"); assert.equal(parsed.events[0]?.fragments[0]?.historicalStart, 1);
  assert.equal(parsed.events[0]?.fragments[0]?.content, "alpha\nbeta\n");
  const reference = parsed.events[0]!.sources.at(-1)!;
  assert.equal((await grokAdapter.readEvidence(reference))?.raw, JSON.stringify(rows[4]));
  const changed = await parseSource(path, "grok", parsed, grokAdapter.id);
  assert.equal(changed.hash, parsed.hash);
  await save(join(dirname(path), "usage.json"), { sessionId: "grok-session", session: { inputTokens: 120 } });
  assert.notEqual((await parseSource(path, "grok", changed, grokAdapter.id)).hash, parsed.hash);
}));

test("Grok 失败、取消、未完成工具和末行不补造终答", async () => temporary(async root => {
  const path = await grokFiles(root, [grok({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "修改" } }, "u"),
    grok({ sessionUpdate: "tool_call", toolCallId: "fail", title: "write_file", rawInput: { path: "src/a.ts", content: "never" } }, "call-fail"),
    grok({ sessionUpdate: "tool_call_update", toolCallId: "fail", status: "failed", content: [{ type: "content", content: { type: "text", text: "失败" } }] }, "result-fail"),
    grok({ sessionUpdate: "tool_call", toolCallId: "cancel", title: "bash", rawInput: { command: "cat src/a.ts" } }, "call-cancel"),
    grok({ sessionUpdate: "tool_call_update", toolCallId: "cancel", status: "cancelled" }, "result-cancel"),
    grok({ sessionUpdate: "tool_call", toolCallId: "pending", title: "read_file", rawInput: { target_file: "src/a.ts" } }, "pending"),
    grok({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "未完成" } }, "assistant"),
    grok({ sessionUpdate: "turn_completed", stop_reason: "cancelled" }, "turn")]);
  await appendFile(path, '{"timestamp":');
  const result = await session(grokAdapter, { client: "grok", path });
  assert.ok(result.meta.gaps.some(gap => gap.kind === "incomplete_record")); assert.ok(result.meta.gaps.some(gap => gap.kind === "unpaired_call"));
  assert.equal(result.messages.find(message => message.callId === "fail")?.status, "failure");
  assert.equal(result.messages.find(message => message.callId === "cancel")?.status, "unknown");
  assert.ok(result.messages.filter(message => message.kind === "assistant").every(message => !message.final));
  const parsed = await parseSource(path, "grok", undefined, grokAdapter.id);
  assert.ok(parsed.events.filter(event => event.status !== "success").every(event => event.fragments.length === 0));
}));

test("Grok rewind 保留退出当前分支的活动、冲突身份及父缺失", async () => temporary(async root => {
  const first = grok({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "第一轮" } }, "u1", "p1");
  const path = await grokFiles(root, [first, first, grok({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "第二轮" } }, "u2", "p2"),
    grok({ sessionUpdate: "rewind_marker", target_prompt_index: 1 }, "rw", "p2"),
    grok({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "替换轮次" } }, "u3", "p3"),
    grok({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "冲突" } }, "u3", "p3")]);
  await save(join(dirname(path), "summary.json"), { info: { id: "grok-session" }, parent_session_id: "missing-parent", session_kind: "fork" });
  await writeFile(join(dirname(dirname(path)), ".cwd"), "/workspace/from-marker");
  const result = await session(grokAdapter, { client: "grok", path });
  assert.equal(result.meta.project, "/workspace/from-marker"); assert.equal(result.meta.relationship, "fork");
  assert.equal(result.messages.find(message => message.text === "第二轮")?.currentBranch, false);
  assert.equal(result.messages.filter(message => message.text === "第一轮").length, 1);
  assert.ok(result.meta.gaps.some(gap => gap.kind === "ambiguous")); assert.ok(result.meta.gaps.some(gap => gap.kind === "source_missing"));
}));

test("Reasonix 事件日志为权威，replace 与 append 还原一次且元信息变化触发刷新", async () => temporary(async root => {
  const path = join(root, "sessions", "reasonix-a.jsonl");
  await save(path, [{ role: "user", content: "过时检查点" }], true);
  const first = { schema_version: 1, type: "replace", revision: 3, messages: [{ role: "user", content: "真实请求", createdAt: Date.parse(time) }], created_at: time };
  const call = { role: "assistant", content: "读取", tool_calls: [{ id: "read", name: "read_file", arguments: '{"path":"src/a.ts","offset":0}' }] };
  await save(path.replace(".jsonl", ".events.jsonl"), [first, { schema_version: 1, type: "append", revision: 4, base_revision: 3, message_index: 1,
    messages: [call, { role: "tool", name: "read_file", tool_call_id: "read", content: "1→alpha\n2→beta\n" }, { role: "assistant", content: "结果", modelRef: "synthetic-model" }], created_at: time }], true);
  await save(`${path}.meta`, { id: "reasonix-a", name: "原生会话", workspace_root: "/workspace/app", model: "synthetic-model" });
  const result = await session(reasonixAdapter, { client: "reasonix", path });
  assert.equal(result.messages.filter(message => message.kind === "user").length, 1); assert.equal(result.messages[0]?.text, "真实请求");
  assert.equal(result.meta.project, "/workspace/app"); assert.equal(result.messages.find(message => message.kind === "tool_call")?.status, "success");
  assert.equal(result.usages.length, 0);
  const parsed = await parseSource(path, "reasonix", undefined, reasonixAdapter.id);
  assert.equal(parsed.events[0]?.fragments[0]?.content, "alpha\nbeta\n");
  assert.equal((await reasonixAdapter.readEvidence(parsed.events[0]!.sources.at(-1)!))?.raw.includes('"revision":4'), true);
  await save(`${path}.meta`, { id: "reasonix-a", name: "更名", workspace_root: "/workspace/app", archived: true });
  assert.notEqual((await parseSource(path, "reasonix", parsed, reasonixAdapter.id)).hash, parsed.hash);
  await save(path.replace(".jsonl", ".events.jsonl"), [{ ...first, revision: 5 }], true);
  assert.equal((await parseSource(path, "reasonix", parsed, reasonixAdapter.id)).events.length, 0);
}));

test("Reasonix 不连续 revision、尾行和未来 schema 不退回旧转录", async () => temporary(async root => {
  const path = join(root, "sessions", "broken.jsonl"); await save(path, [{ role: "user", content: "旧内容" }], true);
  const event = path.replace(".jsonl", ".events.jsonl");
  await save(event, [{ schema_version: 3, type: "replace", revision: 1, messages: [{ role: "user", content: "可信前缀" }], created_at: time },
    { schema_version: 3, type: "append", revision: 4, base_revision: 3, message_index: 1, messages: [{ role: "assistant", content: "不可信" }], created_at: time }], true);
  let result = await session(reasonixAdapter, { client: "reasonix", path }); assert.equal(result.messages.length, 1); assert.ok(result.meta.gaps.some(gap => gap.kind === "ambiguous"));
  await save(event, [{ schema_version: 99, type: "replace", messages: [{ role: "user", content: "新格式" }] }], true);
  result = await session(reasonixAdapter, { client: "reasonix", path }); assert.equal(result.messages.length, 0); assert.ok(result.meta.gaps.some(gap => gap.kind === "unsupported_format"));
  await save(event, [{ schema_version: 1, type: "replace", messages: [{ role: "user", content: "完整" }] }], true); await appendFile(event, '{"schema_version":');
  result = await session(reasonixAdapter, { client: "reasonix", path }); assert.equal(result.messages[0]?.text, "完整"); assert.ok(result.meta.gaps.some(gap => gap.kind === "incomplete_record"));
  await writeFile(event, jsonl([{ schema_version: 1, type: "replace", messages: [{ role: "user", content: "首个可信记录" }] }]) + "{broken}\n"
    + jsonl([{ schema_version: 1, type: "append", message_index: 1, messages: [{ role: "assistant", content: "坏行后不应接入" }] }]));
  result = await session(reasonixAdapter, { client: "reasonix", path }); assert.equal(result.messages.length, 1); assert.ok(result.meta.gaps.some(gap => gap.kind === "parse_error"));
}));

test("Reasonix 子 Agent、失败与取消保留状态，后台 user 不形成用户轮次", async () => temporary(async root => {
  const path = join(root, "sessions", "subagents", "sa_worker.jsonl");
  await save(path, [{ role: "user", content: "任务" }, { role: "user", content: "后台指导", host_authored: true },
    { role: "assistant", content: "执行", tool_calls: [{ id: "shell", name: "bash", arguments: '{"command":"cat src/a.ts"}' }, { id: "edit", name: "edit_file", arguments: '{"path":"src/a.ts"}' }] },
    { role: "tool", tool_call_id: "shell", name: "bash", content: "alpha", tool_execution: { state: "cancelled", exitCode: 0 } },
    { role: "tool", tool_call_id: "edit", name: "edit_file", content: "拒绝", tool_failure: { blocked: true } },
    { role: "assistant", content: "部分输出", local_only: true, interrupted_turn: { pending: true } }], true);
  await save(path.replace(".jsonl", ".meta.json"), { ref: "sa_worker", parentSession: "missing-parent", workspaceRoot: "/workspace/app", status: "cancelled", model: "synthetic-model" });
  const result = await session(reasonixAdapter, { client: "reasonix", path });
  assert.equal(result.meta.turnCount, 1); assert.equal(result.meta.relationship, "child"); assert.ok(result.meta.gaps.some(gap => gap.kind === "source_missing"));
  assert.equal(result.messages.find(message => message.callId === "shell")?.status, "unknown"); assert.equal(result.messages.find(message => message.callId === "edit")?.status, "failure");
  assert.ok(result.messages.filter(message => message.kind === "assistant").every(message => !message.final));
}));

test("Reasonix wire 累计记录不变成请求，压缩与截断覆盖保留", async () => temporary(async root => {
  const path = join(root, "sessions", "wire.jsonl"); await save(path, [{ role: "user", content: "检查" }, { role: "assistant", content: "完成" }], true);
  const stem = path.replace(".jsonl", "");
  await save(`${stem}.wire.jsonl`, [{ kind: "turn_started", msgIndex: 0, authoredTurn: 1 }, { kind: "usage", modelRef: "synthetic-model", usage: { attemptId: "attempt-a", promptTokens: 100, completionTokens: 20, reasoningTokens: 5, cacheHitTokens: 30, currencyCode: "CNY", costUsd: 3 } },
    { kind: "compaction_done", text: "摘要" }, { kind: "turn_done", outcome: "completed" }], true);
  await save(`${stem}.wire.meta.json`, { truncated: true });
  const result = await session(reasonixAdapter, { client: "reasonix", path });
  assert.equal(result.usages.length, 0); assert.equal(result.meta.usageReports?.[0]?.inputTokens, 100); assert.equal(result.meta.usageReports?.[0]?.reportedCostUsd, undefined);
  assert.equal(result.messages.find(message => message.text === "完成")?.final, "explicit"); assert.ok(result.messages.some(message => message.kind === "compression"));
  assert.ok(result.meta.gaps.some(gap => gap.kind === "incomplete_record"));
}));

const entry = (id: string, parent_id: string | null, role: string, blocks: Record<string, unknown>[]) => ({ id, parent_id, kind: "message", created_at: time, message: { role, content: blocks } });
async function whaleFile(root: string, entries: Record<string, unknown>[], leaf: string | null, extra: Record<string, unknown> = {}) {
  const path = join(root, "sessions", "whale-a.json");
  await save(path, { schema_version: 1, metadata: { id: "whale-a", title: "原生会话", workspace: "/workspace/app", model: "synthetic-model", ...extra },
    journal: { schema_version: 1, entries, leaf_id: leaf }, leaf_id: leaf, messages: [{ role: "user", content: [{ type: "text", text: "不应重复导入" }] }] });
  return path;
}

test("Codewhale canonical journal 保留分支、当前叶及 execution 关联，不重复 messages", async () => temporary(async root => {
  const path = await whaleFile(root, [entry("u", null, "user", [{ type: "text", text: "请求" }]),
    entry("call", "u", "assistant", [{ type: "tool_use", id: "provider-reused", execution_id: "exec-a", name: "bash", input: { command: "cat src/a.ts" } }]),
    entry("result", "call", "user", [{ type: "tool_result", tool_use_id: "provider-reused", execution_id: "exec-a", content: "alpha\n", is_error: false }]),
    entry("answer", "result", "assistant", [{ type: "text", text: "完成" }]),
    entry("other", "u", "assistant_interrupted", [{ type: "text", text: "其他分支" }]),
    { id: "compact", parent_id: "answer", kind: "compaction", summary: "摘要", created_at: time }], "compact", { archived: true, total_tokens: 300, cost: { session_cost_usd: 0.1, subagent_cost_usd: 0.2 } });
  const result = await session(codewhaleAdapter, { client: "codewhale", path });
  assert.equal(result.meta.turnCount, 1); assert.equal(result.messages.filter(message => message.kind === "user").length, 1); assert.equal(result.usages.length, 0);
  assert.equal(result.messages.find(message => message.text === "其他分支")?.currentBranch, false); assert.equal(result.meta.branches?.length, 2);
  assert.equal(result.messages.find(message => message.kind === "tool_call")?.callId, "execution:exec-a"); assert.equal(result.messages.find(message => message.kind === "tool_call")?.status, "success");
  assert.ok(result.messages.some(message => message.kind === "compression")); assert.equal(result.meta.usageReports?.[0]?.scope, "session");
  assert.ok(Math.abs(result.meta.usageReports![0]!.reportedCostUsd! - 0.3) < 1e-8);
  const parsed = await parseSource(path, "codewhale", undefined, codewhaleAdapter.id); assert.equal(parsed.events[0]?.kind, "read"); assert.equal(parsed.events[0]?.fragments[0]?.content, "alpha\n");
  assert.equal((await codewhaleAdapter.readEvidence(parsed.events[0]!.sources[0]!))?.raw, await readFile(path, "utf8"));
}));

test("Codewhale 父 journal 身份核验复制记录，父来源缺失不猜测", async () => temporary(async root => {
  const copied = entry("inherited-u", null, "user", [{ type: "text", text: "父请求" }]);
  await save(join(root, "sessions", "parent.json"), { metadata: { id: "parent" }, journal: { schema_version: 1, entries: [copied], leaf_id: "inherited-u" } });
  const path = await whaleFile(root, [copied, entry("new-u", "inherited-u", "user", [{ type: "text", text: "子请求" }])], "new-u", { parent_session_id: "parent" });
  let result = await session(codewhaleAdapter, { client: "codewhale", path }); assert.equal(result.messages.find(message => message.text === "父请求")?.copied, true); assert.equal(result.meta.relationship, "fork");
  await rm(join(root, "sessions", "parent.json")); result = await session(codewhaleAdapter, { client: "codewhale", path }); assert.ok(result.meta.gaps.some(gap => gap.kind === "source_missing"));
  assert.equal(result.messages.find(message => message.text === "父请求")?.copied, false);
}));

test("Codewhale archive 旁路恢复父链，叶游标回退和来源删除使旧证据失效", async () => temporary(async root => {
  const path = await whaleFile(root, [entry("answer", "u", "assistant", [{ type: "text", text: "回答" }])], "answer");
  await save(join(root, "sessions", ".journal-archive", "whale-a.jsonl"), [entry("u", null, "user", [{ type: "text", text: "从归档恢复" }])], true);
  const result = await session(codewhaleAdapter, { client: "codewhale", path }); assert.ok(result.messages.some(message => message.text === "从归档恢复")); assert.ok(!result.meta.gaps.some(gap => gap.kind === "source_missing"));
  const parsed = await parseSource(path, "codewhale", undefined, codewhaleAdapter.id);
  const raw = JSON.parse(await readFile(path, "utf8")); raw.leaf_id = "u"; raw.journal.leaf_id = "u"; await save(path, raw);
  assert.notEqual((await parseSource(path, "codewhale", parsed, codewhaleAdapter.id)).hash, parsed.hash);
  const reference = { sourceId: "codewhale:whale-a", path, recordLine: 1, hash: normalizedHash(JSON.stringify(raw)) };
  const link = join(root, "sessions", "link.json"); await symlink(path, link); assert.equal(await codewhaleAdapter.readEvidence({ ...reference, path: link }), undefined);
  await rm(path); assert.equal(await codewhaleAdapter.readEvidence(reference), undefined);
}));

test("Codewhale 循环、重复与未来 journal schema 明确保留缺口", async () => temporary(async root => {
  const loop = entry("loop", "loop", "user", [{ type: "text", text: "循环" }]); const path = await whaleFile(root, [loop, loop], "loop");
  let result = await session(codewhaleAdapter, { client: "codewhale", path }); assert.ok(result.meta.gaps.some(gap => gap.kind === "parse_error")); assert.ok(result.meta.gaps.some(gap => gap.kind === "ambiguous"));
  const raw = JSON.parse(await readFile(path, "utf8")); raw.journal.schema_version = 99; await save(path, raw);
  result = await session(codewhaleAdapter, { client: "codewhale", path }); assert.equal(result.messages.length, 0); assert.ok(result.meta.gaps.some(gap => gap.kind === "unsupported_format"));
  raw.schema_version = 99; raw.journal.schema_version = 1; await save(path, raw);
  result = await session(codewhaleAdapter, { client: "codewhale", path }); assert.equal(result.messages.length, 0); assert.ok(result.meta.gaps.some(gap => gap.kind === "unsupported_format"));
}));

test("Codewhale 晚到ledger变化参与刷新，部分报告不冒充会话总量或请求", async () => temporary(async root => {
  const path = await whaleFile(root, [entry("u", null, "user", [{ type: "text", text: "检查" }])], "u", { cost: { session_cost_usd: 0.1 } });
  const ledger = join(root, "sessions", ".late-usage", "whale-a.json");
  const record = { source_fingerprint: "a".repeat(64), turn_fingerprint: "b".repeat(64), usage: { input_tokens: 100, output_tokens: 20, prompt_cache_hit_tokens: 30, reasoning_tokens: 5 } };
  await save(ledger, { schema_version: 1, records: [record] });
  const before = await session(codewhaleAdapter, { client: "codewhale", path }); const parsed = await parseSource(path, "codewhale", undefined, codewhaleAdapter.id);
  assert.equal(before.usages.length, 0); assert.deepEqual(before.meta.usageReports?.map(report => report.scope), ["session", "turn"]);
  assert.equal(before.meta.usageReports?.[0]?.reportedCostUsd, 0.1); assert.equal(before.meta.usageReports?.[1]?.inputTokens, 100);
  assert.ok(before.meta.gaps.some(gap => gap.kind === "incomplete_record"));
  const reference = { sourceId: "codewhale:whale-a", path, recordLine: 3, hash: normalizedHash(JSON.stringify(record)) };
  assert.equal((await codewhaleAdapter.readEvidence(reference))?.raw, JSON.stringify(record));
  await save(ledger, { schema_version: 1, records: [{ ...record, usage: { ...record.usage, output_tokens: 25 } }] });
  const changed = await parseSource(path, "codewhale", parsed, codewhaleAdapter.id); assert.notEqual(changed.hash, parsed.hash);
  assert.equal(await codewhaleAdapter.readEvidence(reference), undefined);
  await writeFile(ledger, "codewhale-session-deleted-v1\n");
  const found = await discoverSources({ codewhale: [join(root, "sessions")] }, { clients: ["codewhale"] }); assert.equal(found.length, 0);
}));

test("三客户端 roots 沿原生覆盖与候选过滤，派生旁路不成为会话", async () => temporary(async root => {
  assert.deepEqual(grokHistoryRoots(root, { GROK_HOME: "~/grok" }), [join(root, "grok", "sessions")]);
  assert.deepEqual(codewhaleHistoryRoots(root, { CODEWHALE_HOME: "~/whale" }), [join(root, "whale", "sessions")]);
  assert.deepEqual(codewhaleHistoryRoots(root, { CODEWHALE_HOME: "relative" }), []);
  await save(join(root, ".reasonix", "config.toml"), {}); await writeFile(join(root, ".reasonix", "config.toml"), `[storage]\nstate = "${root}/relocated"\n`);
  assert.deepEqual(reasonixHistoryRoots(root, {}), [join(root, "relocated", "sessions"), join(root, "relocated", "projects"), join(root, "relocated", "archive")]);
  await grokFiles(root, [grok({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "发现" } }, "u")]);
  await save(join(root, "sessions", "workspace", "grok-session", "chat_history.jsonl"), [{ role: "user", content: "派生" }], true);
  const sources = await discoverSources({ grok: [join(root, "sessions")] }, { clients: ["grok"] }); assert.equal(sources.length, 1);
}));

test("Codewhale 迁移来源选择不丢其它客户端的同身份入口", () => {
  const foreign: SourceLocation[] = [{ client: "codex", format: "codex-jsonl", path: "/workspace/active.jsonl", sessionId: "same" },
    { client: "codex", format: "codex-jsonl", path: "/workspace/archive.jsonl", sessionId: "same" },
    { client: "claude", format: "claude-jsonl", path: "/workspace/claude.jsonl", sessionId: "same" }];
  const native: SourceLocation[] = [{ client: "codewhale", format: codewhaleAdapter.id, path: "/workspace/.deepseek/sessions/same.json", sessionId: "same" },
    { client: "codewhale", format: codewhaleAdapter.id, path: "/workspace/.codewhale/sessions/same.json", sessionId: "same" }];
  const selected = codewhaleAdapter.selectSources!([...foreign, ...native]);
  assert.deepEqual(selected.filter(source => source.client !== "codewhale"), foreign);
  assert.deepEqual(selected.filter(source => source.client === "codewhale"), [native[1]]);
});


test("Grok 连续 rewind 的下标基于当前 prompt 列表，旧分支仍保留", async () => temporary(async root => {
  const user = (prompt: string) => grok({ sessionUpdate: "user_message_chunk", content: { type: "text", text: prompt } }, `user-${prompt}`, prompt);
  const path = await grokFiles(root, [user("p1"), user("p2"), user("p3"), grok({ sessionUpdate: "rewind_marker", target_prompt_index: 1 }, "rewind-one", "p3"),
    user("p4"), user("p5"), grok({ sessionUpdate: "rewind_marker", target_prompt_index: 2 }, "rewind-two", "p5")]);
  const result = await session(grokAdapter, { path, client: "grok" });
  assert.deepEqual(result.messages.filter(message => message.kind === "user" && message.currentBranch).map(message => message.text), ["p1", "p4"]);
  assert.deepEqual(result.messages.filter(message => message.kind === "user" && !message.currentBranch).map(message => message.text), ["p2", "p3", "p5"]);
}));

test("Reasonix superseded 版本核验共同转录前缀，旧分支独有工具与用户活动保持可读", async () => temporary(async root => {
  const parent = join(root, "sessions", "parent.jsonl"); const version = join(root, "sessions", "version.jsonl");
  const prefix = [{ role: "user", content: "共同需求" }, { role: "assistant", content: "读取", tool_calls: [{ id: "common-call", name: "read_file", arguments: '{"path":"src/common.ts"}' }] },
    { role: "tool", tool_call_id: "common-call", name: "read_file", content: "1→common" }];
  const tail = [{ role: "user", content: "退出当前分支的需求" }, { role: "assistant", content: "读取旧分支", tool_calls: [{ id: "old-call", name: "read_file", arguments: '{"path":"src/old.ts"}' }] },
    { role: "tool", tool_call_id: "old-call", name: "read_file", content: "1→old" }];
  await save(parent, [{ role: "user", content: "过期检查点" }], true);
  await save(parent.replace(".jsonl", ".events.jsonl"), [{ schema_version: 3, type: "replace", revision: 1, messages: prefix, created_at: time }], true);
  await save(version, [...prefix, ...tail], true); await save(`${version}.meta`, { id: "version", parent_id: "parent", superseded: true, workspace_root: "/workspace/app" });
  let result = await session(reasonixAdapter, { path: version, client: "reasonix" });
  assert.equal(result.messages.filter(message => message.copied).length, 4); assert.equal(result.messages.filter(message => message.kind === "user" && !message.copied).length, 1);
  assert.ok(result.messages.filter(message => message.kind !== "context").every(message => message.currentBranch === false && message.branchIds?.includes("superseded")));
  assert.equal(result.meta.branches?.[0]?.id, "superseded");
  assert.equal(result.snapshot.meta.relationships?.[0]?.copiedRecordIdentityHashes?.length, 3);
  const parsed = await parseSource(version, "reasonix", undefined, reasonixAdapter.id); assert.deepEqual(parsed.events.map(event => event.path), ["src/old.ts"]);
  const parsedParent = await parseSource(parent, "reasonix", undefined, reasonixAdapter.id);
  const shared = resolveSharedHistory([parsedParent, parsed]);
  assert.equal(shared.relationships.find(item => item.sourceId === parsed.sourceId)?.resolved, true);
  assert.ok(!shared.gaps.some(gap => gap.sourceId === parsed.sourceId && gap.kind === "ambiguous"));
  assert.deepEqual(shared.events.map(event => event.path), ["src/common.ts", "src/old.ts"]);
  const unverified = structuredClone(parsed); unverified.relationships[0]!.copiedRecordIdentityProof = undefined;
  const unresolved = resolveSharedHistory([parsedParent, unverified]);
  assert.equal(unresolved.relationships.find(item => item.sourceId === parsed.sourceId)?.resolved, false);
  assert.ok(unresolved.gaps.some(gap => gap.sourceId === parsed.sourceId && gap.kind === "ambiguous"));
  assert.equal((await reasonixAdapter.readEvidence(parsed.events[0]!.sources.at(-1)!))?.raw, JSON.stringify(tail[2]));
  await save(`${version}.meta`, { id: "version", parent_id: "parent", workspace_root: "/workspace/app" });
  result = await session(reasonixAdapter, { path: version, client: "reasonix" }); assert.ok(result.messages.every(message => !message.copied));
  const ordinary = await parseSource(version, "reasonix", undefined, reasonixAdapter.id);
  assert.equal(resolveSharedHistory([parsedParent, ordinary]).relationships.find(item => item.sourceId === ordinary.sourceId)?.resolved, false);
  await save(`${version}.meta`, { id: "version", parent_id: "parent", superseded: true, workspace_root: "/workspace/app" });
  await rm(parent); await rm(parent.replace(".jsonl", ".events.jsonl"));
  result = await session(reasonixAdapter, { path: version, client: "reasonix" }); assert.ok(result.messages.every(message => !message.copied)); assert.ok(result.meta.gaps.some(gap => gap.kind === "source_missing"));
  const missingParent = await parseSource(version, "reasonix", undefined, reasonixAdapter.id);
  const missing = resolveSharedHistory([missingParent]); assert.equal(missing.relationships[0]?.resolved, false); assert.ok(missing.gaps.some(gap => gap.kind === "source_missing"));
}));

test("Reasonix 父版本不完整时不按相似正文去重，父变化会使已有证据重建", async () => temporary(async root => {
  const parent = join(root, "sessions", "parent.jsonl"); const version = join(root, "sessions", "version.jsonl"); const prefix = { role: "user", content: "共同文本" };
  await save(parent, [prefix], true); await save(version, [prefix], true); await save(`${version}.meta`, { id: "version", parent_id: "parent", superseded: true });
  const before = await parseSource(version, "reasonix", undefined, reasonixAdapter.id);
  await appendFile(parent, '{"role":');
  const after = await parseSource(version, "reasonix", before, reasonixAdapter.id); assert.notEqual(after.hash, before.hash);
  const result = await session(reasonixAdapter, { path: version, client: "reasonix" }); assert.ok(result.messages.every(message => !message.copied)); assert.ok(result.meta.gaps.some(gap => gap.kind === "ambiguous"));
}));

test("Grok 项目标记和 Reasonix 根配置超预算保留可翻译诊断", async () => temporary(async root => {
  const path = await grokFiles(root, [grok({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "检查" } }, "u")]);
  await save(join(dirname(path), "summary.json"), { info: { id: "grok-session" } }); const marker = join(dirname(dirname(path)), ".cwd");
  await writeFile(marker, "/workspace/example"); await truncate(marker, 64 * 1024 + 1);
  const result = await session(grokAdapter, { path, client: "grok" }); assert.equal(result.meta.project, undefined);
  const gap = result.meta.gaps.find(gap => gap.kind === "budget_exceeded")!; assert.match(translateMessage("en", gap.messageDescriptor!), /bounded read/);
  const config = join(root, ".reasonix", "config.toml"); await mkdir(dirname(config)); await writeFile(config, "[storage]\nstate = '/workspace/example'\n"); await truncate(config, 16 * 1024 * 1024 + 1);
  assert.throws(() => reasonixHistoryRoots(root, {}), error => { const descriptor = errorDescriptor(error); assert.ok(descriptor); assert.match(translateMessage("en", descriptor), /bounded read/); return true; });
}));

test("Codewhale oversized 原生来源失败带中英文产品描述", async () => temporary(async root => {
  const path = await whaleFile(root, [], null); await truncate(path, 128 * 1024 * 1024 + 1);
  await assert.rejects(codewhaleAdapter.readRecords!({ path, client: "codewhale" }), error => {
    const descriptor = errorDescriptor(error); assert.equal(descriptor?.key, "diagnostics.history.adapters.codewhale.m018");
    assert.match(translateMessage("en", descriptor!), /^Codewhale source exceeds/); assert.match(translateMessage("zh-CN", descriptor!), /超过有界读取上限/); return true;
  });
}));
