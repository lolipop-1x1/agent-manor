import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseSource } from "../src/history/index.js";
import { readHistoryEvidence } from "../src/history/adapters/index.js";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";
import type { HistoryAdapterContext } from "../src/history/adapters/types.js";
import { codebuddyAdapter } from "../src/history/adapters/codebuddy.js";
import { parseNormalizedSession, normalizedHash } from "../src/history/adapters/normalized.js";
import { qoderAdapter } from "../src/history/adapters/qoder.js";
import { workbuddyAdapter } from "../src/history/adapters/workbuddy.js";

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-jsonl-clients-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function serialized(records: unknown[]): string {
  return `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
}

function sink() {
  const messages: SessionMessage[] = [];
  const usage: SessionUsage[] = [];
  return { messages, usage, value: { message: (message: SessionMessage) => messages.push(message), usage: (item: SessionUsage) => usage.push(item) } };
}

test("WorkBuddy 用 sessions 精确补齐无正文 sessionId，并保留会话与工具行证据", async () => temporary(async directory => {
  const root = join(directory, ".workbuddy");
  const project = join(root, "projects", "encoded-project");
  await mkdir(project, { recursive: true });
  const databasePath = join(root, "workbuddy.db");
  const db = new Database(databasePath);
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, custom_title TEXT)");
  db.prepare("INSERT INTO sessions (id, cwd, title, custom_title) VALUES (?, ?, ?, ?)")
    .run("wb-session-1", "/workspace/workbuddy", "stored title", "chosen title");
  db.prepare("INSERT INTO sessions (id, cwd, title, custom_title) VALUES (?, ?, ?, ?)")
    .run("wb-session-2", "/workspace/second", "second title", null);
  db.close();

  const firstPath = join(project, "wb-session-1.jsonl");
  const records = [
    { type: "message", id: "u1", sessionId: "wb-session-1", role: "user", content: "inspect the file", cwd: "/workspace/workbuddy", timestamp: "2026-10-06T01:00:00.000Z" },
    { type: "message", id: "a1", sessionId: "wb-session-1", role: "assistant", content: "I will inspect it.", status: "completed", cwd: "/workspace/workbuddy", timestamp: "2026-10-06T01:00:01.000Z",
      providerData: { model: "synthetic-model", conversationRequestId: "request-1", usage: { input_tokens: 60, output_tokens: 8, cache_read_input_tokens: 12 } } },
    { type: "reasoning", id: "r1", sessionId: "wb-session-1", content: "synthetic reasoning", timestamp: "2026-10-06T01:00:02.000Z" },
    { type: "function_call", id: "c-edit", sessionId: "wb-session-1", callId: "call-edit", name: "Edit",
      arguments: JSON.stringify({ filePath: "src/example.ts", old_string: "before", new_string: "after" }), timestamp: "2026-10-06T01:00:03.000Z",
      providerData: { model: "synthetic-model", messageId: "request-message-2", conversationRequestId: "same-conversation",
        usage: { inputTokens: 100, inputTokensDetails: { cachedTokens: 20 }, outputTokens: 10, totalTokens: 110 } } },
    { type: "function_call_result", id: "r-edit", sessionId: "wb-session-1", callId: "call-edit", name: "Edit", output: "edited",
      providerData: { workbuddyToolResult: { success: true } }, timestamp: "2026-10-06T01:00:04.000Z" },
    { type: "function_call", id: "c-read", sessionId: "wb-session-1", callId: "call-read", name: "Read",
      arguments: { filePath: "src/example.ts", offset: 1, limit: 2 }, timestamp: "2026-10-06T01:00:05.000Z" },
    { type: "function_call_result", id: "r-read", sessionId: "wb-session-1", callId: "call-read", name: "Read", output: "1\talpha\n2\tbeta",
      providerData: { workbuddyToolResult: { type: "text", content: "1\talpha\n2\tbeta", path: "src/example.ts", totalLineCount: 2, success: true } }, timestamp: "2026-10-06T01:00:06.000Z" },
    { type: "function_call", id: "c-read-unknown", sessionId: "wb-session-1", callId: "call-read-unknown", name: "Read",
      arguments: { filePath: "src/unknown.ts" }, timestamp: "2026-10-06T01:00:06.500Z" },
    { type: "function_call_result", id: "r-read-unknown", sessionId: "wb-session-1", callId: "call-read-unknown", name: "Read", output: "returned content",
      providerData: { workbuddyToolResult: { type: "read_file_result", content: "returned content", path: "src/unknown.ts", totalLineCount: 12 } }, timestamp: "2026-10-06T01:00:06.750Z" },
    { type: "function_call", id: "c-bash", sessionId: "wb-session-1", callId: "call-bash", name: "Bash",
      arguments: { command: "sed -n '4,5p' src/example.ts" }, timestamp: "2026-10-06T01:00:07.000Z" },
    { type: "function_call_result", id: "r-bash", sessionId: "wb-session-1", callId: "call-bash", name: "Bash", output: "four\nfive",
      providerData: { workbuddyToolResult: { type: "text", stdout: "four\nfive", stderr: "", exitCode: 0, success: true } }, timestamp: "2026-10-06T01:00:08.000Z" },
    { type: "message", id: "compact", sessionId: "wb-session-1", role: "assistant", content: "synthetic summary", providerData: { isSummary: true } },
  ];
  const raw = serialized(records);
  await writeFile(firstPath, raw);
  const discovered = await workbuddyAdapter.discoverFile!({ path: firstPath, client: "workbuddy", format: "workbuddy-jsonl" });
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]!.sessionId, "wb-session-1");
  assert.equal(discovered[0]!.cwd, "/workspace/workbuddy");
  const snapshot = await workbuddyAdapter.readRecords!(discovered[0]!);
  const collected = sink();
  const meta = parseNormalizedSession(snapshot, collected.value);
  assert.equal(meta.title, "chosen title");
  assert.equal(meta.project, "/workspace/workbuddy");
  assert.ok(collected.messages.some(message => message.kind === "thinking"));
  assert.ok(collected.messages.some(message => message.kind === "compression"));
  assert.equal(new Set(collected.messages.filter(message => message.kind === "tool_call").map(message => message.id)).size, 4);
  assert.equal(collected.messages.filter(message => message.kind === "tool_result" && message.status === "success").length, 3);
  assert.ok(collected.messages.some(message => message.kind === "tool_result" && message.status === "unknown"));
  assert.equal(collected.usage.length, 2);
  assert.ok(collected.usage.every(usage => usage.inputTokens === undefined));
  assert.deepEqual(collected.usage.map(usage => usage.cachedInputTokens).sort(), [12, 20]);
  assert.ok(meta.gaps.some(gap => gap.kind === "ambiguous" && gap.message.includes("分母")));
  assert.equal(collected.messages.find(message => message.kind === "assistant")?.final, undefined);

  const extract = workbuddyAdapter.extract.bind(workbuddyAdapter);
  const evidence = extract("Read", { filePath: "src/example.ts" }, { read_file_result: { content: "alpha\nbeta", hasMore: false, totalLineCount: 2 } }, "alpha\nbeta", {} as HistoryAdapterContext);
  assert.equal(evidence[0]?.kind, "read");
  assert.equal(evidence[0]?.fragments[0]?.historicalStart, 1);
  assert.equal(evidence[0]?.path, "src/example.ts");
  const edit = extract("Edit", { filePath: "src/example.ts", old_string: "before", new_string: "after" }, {}, "", {} as HistoryAdapterContext);
  assert.equal(edit[0]?.kind, "edit");
  assert.equal(edit[0]?.path, "src/example.ts");
  assert.ok(edit[0]?.fragments.some(fragment => fragment.kind === "added" && fragment.content.includes("after")));
  const bash = extract("Bash", { command: "sed -n '4,5p' src/example.ts" }, { exitCode: 0, stdout: "four\nfive" }, "four\nfive", {} as HistoryAdapterContext);
  assert.equal(bash[0]?.kind, "read");
  assert.equal(bash[0]?.fragments[0]?.historicalStart, 4);
  const unknownRead = extract("Read", { filePath: "src/example.ts" }, { read_file_result: { content: "alpha\nbeta", hasMore: true, totalLineCount: 12 } }, "alpha\nbeta", {} as HistoryAdapterContext);
  assert.ok(unknownRead[0]?.reason?.includes("range_unknown"));

  const targetRow = raw.split("\n")[0]!;
  const reference = { selector: "wb-session-1", sourceId: discovered[0]!.sourceId!, format: discovered[0]!.format!,
    path: firstPath, recordLine: 1, hash: normalizedHash(targetRow) };
  const recalled = await workbuddyAdapter.readEvidence(reference);
  assert.equal(recalled?.raw, targetRow);

  const secondPath = join(project, "wb-session-2.jsonl");
  const noSessionIdRow = JSON.stringify({ type: "message", id: "u2", role: "user", content: "second synthetic prompt", cwd: "/workspace/second" });
  await writeFile(secondPath, `${noSessionIdRow}\n`);
  const second = await workbuddyAdapter.discoverFile!({ path: secondPath, client: "workbuddy", format: "workbuddy-jsonl" });
  const secondSnapshot = await workbuddyAdapter.readRecords!(second[0]!);
  assert.equal(second[0]!.sessionId, "wb-session-2");
  assert.ok(!secondSnapshot.meta.gaps.some(gap => gap.message.includes("未能与 sessions")));
}));

test("WorkBuddy JSON 参数字符串可提取已证实读写，未知终态和未知事件保留缺口", async () => temporary(async directory => {
  const path = join(directory, "synthetic-session.jsonl");
  const rows = [
    { type: "message", id: "user", sessionId: "wb-synthetic", role: "user", content: "inspect sample" },
    { type: "message", id: "assistant", sessionId: "wb-synthetic", role: "assistant", status: "completed", content: "I will inspect it." },
    { type: "function_call", id: "read-call", sessionId: "wb-synthetic", callId: "read-id", name: "Read",
      arguments: JSON.stringify({ filePath: "src/sample.ts", offset: 1 }) },
    { type: "function_call_result", id: "read-result", sessionId: "wb-synthetic", callId: "read-id", name: "Read", output: "alpha\nbeta",
      providerData: { workbuddyToolResult: { path: "src/sample.ts", read_file_result: { content: "alpha\nbeta", hasMore: false, totalLineCount: 2 } } } },
    { type: "function_call", id: "edit-call", sessionId: "wb-synthetic", callId: "edit-id", name: "Edit",
      arguments: JSON.stringify({ filePath: "src/sample.ts", old_string: "before", new_string: "after" }) },
    { type: "function_call_result", id: "edit-result", sessionId: "wb-synthetic", callId: "edit-id", name: "Edit", output: "changed",
      providerData: { workbuddyToolResult: { type: "text", content: "changed" } } },
    { type: "future-event", id: "unknown", sessionId: "wb-synthetic", payload: "before" },
  ];
  await writeFile(path, serialized(rows));
  const [source] = await workbuddyAdapter.discoverFile!({ path, client: "workbuddy", format: "workbuddy-jsonl" });
  const parsed = await parseSource(path, "workbuddy", undefined, "workbuddy-jsonl", { location: source });
  const read = parsed.events.find(event => event.tool === "Read");
  const edit = parsed.events.find(event => event.tool === "Edit");
  assert.equal(read?.status, "success");
  assert.equal(read?.fragments[0]?.historicalStart, 1);
  assert.equal(read?.fragments[0]?.content, "alpha\nbeta");
  assert.equal(edit?.status, "unknown");
  assert.equal(edit?.fragments.length, 0);
  const requestEvidence = await readHistoryEvidence(read!.sources[0]!);
  assert.equal(JSON.parse(requestEvidence!.raw).arguments, JSON.stringify({ filePath: "src/sample.ts", offset: 1 }));

  const before = await workbuddyAdapter.readRecords!(source!);
  const eventRows = before.records.flatMap(row => row.record.normalizedEvent ? [row.record.normalizedEvent] : []);
  assert.ok(eventRows.some(event => event.kind === "context" && event.text === "未适配记录类型 future-event"));
  rows[6] = { ...rows[6]!, payload: "after" };
  await writeFile(path, serialized(rows));
  assert.notEqual((await workbuddyAdapter.readRecords!(source!)).hash, before.hash);
}));

test("WorkBuddy completed 只结束消息；工具活动取消早期候选，截断状态不推终答", async () => temporary(async directory => {
  const path = join(directory, "workbuddy-final.jsonl");
  const rows = [
    { type: "message", id: "user-one", sessionId: "wb-final", role: "user", content: "first prompt" },
    { type: "message", id: "assistant-before-tool", sessionId: "wb-final", role: "assistant", status: "completed", content: "checking first" },
    { type: "function_call", id: "call-one", sessionId: "wb-final", callId: "call-one", name: "Read", arguments: { filePath: "src/sample.ts" } },
    { type: "function_call_result", id: "result-one", sessionId: "wb-final", callId: "call-one", name: "Read", output: "denied",
      providerData: { toolResult: { error: "synthetic failure" } } },
    { type: "message", id: "user-two", sessionId: "wb-final", role: "user", content: "second prompt" },
    { type: "message", id: "assistant-final", sessionId: "wb-final", role: "assistant", status: "completed", content: "completed answer" },
    { type: "message", id: "user-three", sessionId: "wb-final", role: "user", content: "third prompt" },
    { type: "message", id: "assistant-truncated", sessionId: "wb-final", role: "assistant", status: "max_tokens", content: "truncated answer" },
  ];
  await writeFile(path, serialized(rows));
  const [source] = await workbuddyAdapter.discoverFile!({ path, client: "workbuddy", format: "workbuddy-jsonl" });
  const collected = sink();
  const meta = parseNormalizedSession(await workbuddyAdapter.readRecords!(source!), collected.value);
  assert.equal(meta.turnCount, 3);
  assert.equal(collected.messages.find(message => message.text === "checking first")?.final, undefined);
  assert.ok(collected.messages.some(message => message.text === "completed answer" && message.final === "inferred"));
  assert.equal(collected.messages.find(message => message.text === "truncated answer")?.final, undefined);
  assert.ok(collected.messages.some(message => message.kind === "tool_result" && message.status === "failure"));
}));

test("Qoder userType 缺失仍按原生 user 计轮次；max_tokens 不推终答并保留未知事件", async () => temporary(async directory => {
  const path = join(directory, "synthetic-qoder.jsonl");
  const rows = [
    { type: "user", sessionId: "q-synthetic", uuid: "q-string-user", message: { role: "user", content: "ordinary string prompt" } },
    { type: "user", sessionId: "q-synthetic", uuid: "q-injected", isMeta: true,
      message: { role: "user", content: "synthetic injected context" } },
    { type: "user", sessionId: "q-synthetic", uuid: "q-user", message: { role: "user", content: [{ type: "text", text: "real prompt" }] } },
    { type: "assistant", sessionId: "q-synthetic", uuid: "q-assistant", message: { role: "assistant", stop_reason: "max_tokens",
      content: [{ type: "text", text: "truncated answer" }, { type: "tool_use", id: "q-write", name: "Write",
        input: { file_path: "src/new.ts", content: "synthetic file content" } }] } },
    { type: "user", sessionId: "q-synthetic", uuid: "q-write-result", message: { role: "user",
      content: [{ type: "tool_result", tool_use_id: "q-write", content: "created" }] },
      toolUseResult: { content: "synthetic file content", filePath: "src/new.ts", originalFile: null } },
    { type: "future-event", sessionId: "q-synthetic", payload: "before" },
  ];
  await writeFile(path, serialized(rows));
  const [source] = await qoderAdapter.discoverFile!({ path, client: "qoder", format: "qoder-jsonl" });
  const snapshot = await qoderAdapter.readRecords!(source!);
  const collected = sink();
  const meta = parseNormalizedSession(snapshot, collected.value);
  assert.equal(meta.turnCount, 2);
  assert.ok(collected.messages.some(message => message.kind === "user" && message.text === "ordinary string prompt"));
  assert.ok(collected.messages.some(message => message.kind === "context" && message.text === "synthetic injected context"));
  assert.ok(collected.messages.some(message => message.kind === "user" && message.text === "real prompt"));
  assert.equal(collected.messages.find(message => message.text === "truncated answer")?.final, undefined);
  assert.ok(meta.gaps.some(gap => gap.kind === "unsupported_format"));
  assert.ok(snapshot.records.some(row => row.record.normalizedEvent?.text === "未适配记录类型 future-event"));
  const parsed = await parseSource(path, "qoder", undefined, "qoder-jsonl", { location: source });
  const write = parsed.events.find(event => event.tool === "Write");
  assert.equal(write?.status, "unknown");
  assert.equal(write?.fragments.length, 0);
  rows[5] = { ...rows[5]!, payload: "after" };
  await writeFile(path, serialized(rows));
  assert.notEqual((await qoderAdapter.readRecords!(source!)).hash, snapshot.hash);
}));

test("CodeBuddy 未知事件原始改变反映到快照；多会话文件不合并正文", async () => temporary(async directory => {
  const unknownPath = join(directory, "unknown.jsonl");
  const unknown = [
    { type: "message", id: "user", sessionId: "cb-synthetic", role: "user", content: "prompt" },
    { type: "future-event", id: "future", sessionId: "cb-synthetic", payload: "before" },
  ];
  await writeFile(unknownPath, serialized(unknown));
  const [unknownSource] = await codebuddyAdapter.discoverFile!({ path: unknownPath, client: "codebuddy", format: "codebuddy-jsonl" });
  const snapshot = await codebuddyAdapter.readRecords!(unknownSource!);
  assert.ok(snapshot.records.some(row => row.record.normalizedEvent?.kind === "context" && row.record.normalizedEvent.text?.includes("future-event")));
  unknown[1] = { ...unknown[1]!, payload: "after" };
  await writeFile(unknownPath, serialized(unknown));
  assert.notEqual((await codebuddyAdapter.readRecords!(unknownSource!)).hash, snapshot.hash);

  const mixedPath = join(directory, "mixed.jsonl");
  await writeFile(mixedPath, serialized([
    { type: "message", id: "user-a", sessionId: "cb-a", role: "user", content: "first session body" },
    { type: "message", id: "user-b", sessionId: "cb-b", role: "user", content: "second session body" },
  ]));
  const [mixedSource] = await codebuddyAdapter.discoverFile!({ path: mixedPath, client: "codebuddy", format: "codebuddy-jsonl" });
  const mixedSnapshot = await codebuddyAdapter.readRecords!(mixedSource!);
  assert.equal(mixedSnapshot.source.sessionId, undefined);
  assert.equal(mixedSnapshot.records.filter(row => row.record.normalizedEvent).length, 0);
  assert.ok(mixedSnapshot.meta.gaps?.some(gap => gap.kind === "ambiguous"));

  const workbuddyMixedPath = join(directory, "workbuddy-mixed.jsonl");
  await writeFile(workbuddyMixedPath, serialized([
    { type: "message", id: "wb-user-a", sessionId: "wb-a", role: "user", content: "first session body" },
    { type: "message", id: "wb-user-b", sessionId: "wb-b", role: "user", content: "second session body" },
  ]));
  const [workbuddySource] = await workbuddyAdapter.discoverFile!({ path: workbuddyMixedPath, client: "workbuddy", format: "workbuddy-jsonl" });
  const workbuddySnapshot = await workbuddyAdapter.readRecords!(workbuddySource!);
  assert.equal(workbuddySnapshot.source.sessionId, undefined);
  assert.equal(workbuddySnapshot.records.filter(row => row.record.normalizedEvent).length, 0);
  assert.ok(workbuddySnapshot.meta.gaps?.some(gap => gap.kind === "ambiguous"));

  const qoderMixedPath = join(directory, "qoder-mixed.jsonl");
  await writeFile(qoderMixedPath, serialized([
    { type: "user", sessionId: "q-a", uuid: "q-user-a", message: { role: "user", content: "first session body" } },
    { type: "user", sessionId: "q-b", uuid: "q-user-b", message: { role: "user", content: "second session body" } },
  ]));
  const [qoderSource] = await qoderAdapter.discoverFile!({ path: qoderMixedPath, client: "qoder", format: "qoder-jsonl" });
  const qoderSnapshot = await qoderAdapter.readRecords!(qoderSource!);
  assert.equal(qoderSnapshot.source.sessionId, undefined);
  assert.equal(qoderSnapshot.records.filter(row => row.record.normalizedEvent).length, 0);
  assert.ok(qoderSnapshot.meta.gaps?.some(gap => gap.kind === "ambiguous"));
}));

test("CodeBuddy 只把已记录 user 作为用户消息，不补造 assistant 与工具", async () => temporary(async directory => {
  const path = join(directory, "synthetic.jsonl");
  await writeFile(path, serialized([
    { type: "message", id: "cb-user", sessionId: "cb-session", role: "user", cwd: "/workspace/codebuddy",
      content: [{ type: "input_text", text: "synthetic user prompt" }] },
  ]));
  const sources = await codebuddyAdapter.discoverFile!({ path, client: "codebuddy", format: "codebuddy-jsonl" });
  const snapshot = await codebuddyAdapter.readRecords!(sources[0]!);
  const collected = sink();
  const meta = parseNormalizedSession(snapshot, collected.value);
  assert.equal(meta.client, "codebuddy");
  assert.equal(meta.project, "/workspace/codebuddy");
  assert.deepEqual(collected.messages.map(message => [message.kind, message.text]), [["user", "synthetic user prompt"]]);
  assert.equal(collected.usage.length, 0);
}));

test("Qoder 跳过工作区首记录而解析正文，按 tool_use id 配对并不猜 agent 父级", async () => temporary(async directory => {
  const path = join(directory, "qoder-synthetic.jsonl");
  await writeFile(path, serialized([
    { type: "workspace-directories", sessionId: "q-session", directories: ["/workspace/qoder"] },
    { type: "runtime-config", sessionId: "q-session", timestamp: "2026-10-06T01:00:00.000Z", model: "q-model", contextWindow: 32000, reasoningEffort: "medium" },
    { type: "user", sessionId: "q-session", uuid: "q-user", userType: "external", isMeta: false, origin: { kind: "user-input" },
      message: { id: "q-user-msg", role: "user", content: [{ type: "text", text: "inspect synthetic file" }] } },
    { type: "assistant", sessionId: "q-session", uuid: "q-assistant", userType: "external", cwd: "/workspace/qoder", agentId: "agent-synthetic", isSidechain: false,
      message: { id: "q-assistant-msg", role: "assistant", model: "q-model", stop_reason: "tool_use", content: [
      { type: "text", text: "I will inspect it." },
      { type: "tool_use", id: "q-call", name: "Bash", input: { command: "cat src/example.ts" } },
      { type: "tool_use", id: "q-call-failure", name: "Bash", input: { command: "cat src/missing.ts" } },
    ], usage: { input_tokens: 60, output_tokens: 8, cache_read_input_tokens: 12 } } },
    { type: "user", sessionId: "q-session", uuid: "q-result", userType: "external", cwd: "/workspace/qoder",
      message: { id: "q-result-msg", role: "user", content: [{ type: "tool_result", tool_use_id: "q-call", is_error: false, content: "synthetic output" }] },
      toolUseResult: { stdout: "synthetic output", exitCode: 0, kind: "command" } },
    { type: "user", sessionId: "q-session", uuid: "q-result-failure", userType: "external", cwd: "/workspace/qoder",
      message: { id: "q-result-failure-msg", role: "user", content: [{ type: "tool_result", tool_use_id: "q-call-failure", is_error: false, content: "command failed" }] },
      toolUseResult: { stderr: "not found", exitCode: 127, kind: "command" } },
  ]));
  const sources = await qoderAdapter.discoverFile!({ path, client: "qoder", format: "qoder-jsonl" });
  const snapshot = await qoderAdapter.readRecords!(sources[0]!);
  const collected = sink();
  const meta = parseNormalizedSession(snapshot, collected.value);
  assert.equal(meta.client, "qoder");
  assert.equal(meta.project, "/workspace/qoder");
  assert.equal(meta.title, "inspect synthetic file");
  assert.equal(meta.relationship, undefined);
  assert.ok(meta.gaps.some(gap => gap.message.includes("agentId")));
  assert.ok(collected.messages.some(message => message.kind === "user" && message.text === "inspect synthetic file"));
  assert.ok(collected.messages.some(message => message.kind === "tool_call" && message.callId === "q-call"));
  assert.ok(collected.messages.some(message => message.kind === "tool_result" && message.callId === "q-call" && message.status === "success"));
  assert.ok(collected.messages.some(message => message.kind === "tool_result" && message.callId === "q-call-failure" && message.status === "failure"));
  assert.equal(collected.usage[0]?.inputTokens, undefined);
  assert.equal(collected.usage[0]?.cachedInputTokens, 12);
  const bash = qoderAdapter.extract("Bash", { command: "cat src/example.ts" }, { exitCode: 0, stdout: "one\ntwo" }, "one\ntwo", {} as HistoryAdapterContext);
  assert.equal(bash[0]?.kind, "read");
  assert.equal(bash[0]?.path, "src/example.ts");
}));
