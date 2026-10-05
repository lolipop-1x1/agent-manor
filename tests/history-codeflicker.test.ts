import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Baseline } from "../src/contracts.js";
import { associateSource, discoverSources, parseSource, resolveSharedHistory } from "../src/history/index.js";
import { readHistoryEvidence } from "../src/history/adapters/index.js";
import { physicalLines } from "../src/history/extraction.js";
import { matchEvent } from "../src/analysis/matching.js";

const fixture = new URL("./fixtures/history/codeflicker-native.jsonl", import.meta.url).pathname;
const encode = (records: unknown[]) => records.map(record => `${JSON.stringify(record)}\n`).join("");
const message = (uuid: string, role: string, content: unknown[], extra = {}) => ({ type: "message", sessionId: "synthetic-codeflicker", uuid, role, timestamp: "2026-01-01T00:00:00Z", content, ...extra });
const call = (uuid: string, id: string, name = "read", input: unknown = { file_path: "/synthetic/repo/src/a.ts" }, extra = {}) => message(uuid, "assistant", [{ type: "tool_use", id, name, input }], extra);
const output = (uuid: string, id: string, result: unknown, toolName = "read", extra = {}) => message(uuid, "tool", [{ type: "tool-result", toolCallId: id, toolName, result }], extra);
const readResult = (content = "alpha\nbeta\n", extra = {}) => ({
  llmContent: JSON.stringify({ type: "text", filePath: "/synthetic/repo/src/a.ts", content, totalLines: 3, offset: 1, limit: 3, actualLinesRead: 3, ...extra }),
  returnDisplay: "Read 3 lines.", truncated: false,
});

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-codeflicker-test-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("原生成功 read/edit/write 保留真实工具名、输入与物理记录证据", async () => {
  const parsed = await parseSource(fixture, "codeflicker");
  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.cwd, undefined);
  assert.deepEqual(parsed.events.map(event => [event.tool, event.kind, event.status]), [["read", "read", "success"], ["edit", "edit", "success"], ["write", "edit", "success"]]);
  assert.equal(parsed.events[0]!.fragments[0]!.content, "alpha\nbeta\n");
  assert.equal(physicalLines(parsed.events[0]!.fragments[0]!.content).length, 2);
  assert.deepEqual(parsed.events[1]!.fragments.filter(fragment => fragment.kind === "added").map(fragment => [fragment.content, fragment.historicalStart]), [["gamma\n", 2]]);
  assert.equal(parsed.events[2]!.fragments[0]!.content, "delta\n");
  assert.deepEqual(parsed.events[1]!.input, { file_path: "/synthetic/repo/src/a.ts", old_string: "beta", new_string: "gamma" });
  assert.equal(parsed.gaps.length, 0);
  for (const event of parsed.events) {
    assert.equal(event.sources.length, 2);
    assert.ok(event.sources.every(source => source.format === "codeflicker-jsonl" && source.callId));
    assert.ok((await readHistoryEvidence(event.sources[0]!))?.raw.includes("tool_use"));
    assert.ok((await readHistoryEvidence(event.sources[1]!))?.raw.includes("tool-result"));
  }
});

test("失败、未知、截断和缺失结果不推高源码覆盖", async () => temporary(async directory => {
  const path = join(directory, "states.jsonl");
  await writeFile(path, encode([
    call("failure", "failure"), output("failure-result", "failure", { ...readResult(), isError: true }),
    call("unknown", "unknown"), output("unknown-result", "unknown", { llmContent: "unverified response", returnDisplay: "preview" }),
    call("truncated", "truncated"), output("truncated-result", "truncated", { ...readResult(), truncated: true }),
    call("missing", "missing"),
  ]));
  const parsed = await parseSource(path, "codeflicker");
  assert.deepEqual(parsed.events.map(event => event.status), ["failure", "unknown", "success", "unknown"]);
  assert.ok(parsed.events.every(event => event.fragments.length === 0));
  assert.equal(parsed.gaps.filter(gap => gap.kind === "range_unknown").length, 2);
  assert.equal(parsed.gaps.filter(gap => gap.kind === "unpaired_call").length, 1);
}));

test("read 验证路径、范围和实际计数；虚拟 EOF 与真正末尾空行分开", async () => temporary(async directory => {
  const examples = [
    ["alpha\nbeta", { actualLinesRead: 2, totalLines: 2, limit: 2 }, "alpha\nbeta"],
    ["alpha\n\n", {}, "alpha\n\n"],
    ["alpha\n", { totalLines: 9, actualLinesRead: 2, limit: 2 }, "alpha\n\n"],
    ["", { totalLines: 0, actualLinesRead: 0, limit: 0 }, ""],
    ["alpha\nbeta\n", { actualLinesRead: 2 }, undefined],
    ["alpha\nbeta\n", { filePath: "/synthetic/other/a.ts" }, undefined],
    ["alpha\nbeta\n", { offset: 2 }, undefined],
    ["alpha\nbeta\n", { totalLines: 2 }, undefined],
  ] as const;
  for (const [index, [content, extra, expected]] of examples.entries()) {
    const path = join(directory, `${index}.jsonl`);
    await writeFile(path, encode([call(`request-${index}`, "read"), output(`result-${index}`, "read", readResult(content, extra))]));
    const parsed = await parseSource(path, "codeflicker");
    if (expected === undefined) {
      assert.equal(parsed.events[0]!.fragments.length, 0);
      assert.ok(parsed.gaps.some(gap => gap.kind === "range_unknown"));
    } else assert.equal(parsed.events[0]!.fragments[0]?.content ?? "", expected);
  }
}));

test("write 覆盖差异与补齐 LF 使用执行后视图，edit 无位置仅保存变化", async () => temporary(async directory => {
  const path = join(directory, "edits.jsonl");
  await writeFile(path, encode([
    call("write", "write", "write", { file_path: "/synthetic/repo/src/a.ts", content: "alpha\ngamma" }),
    output("write-result", "write", { llmContent: "File successfully written to /synthetic/repo/src/a.ts", returnDisplay: { originalContent: "alpha\nbeta\n", writeType: "replace" } }, "write"),
    call("edit", "edit", "edit", { file_path: "/synthetic/repo/src/a.ts", old_string: "gamma", new_string: "delta" }),
    output("edit-result", "edit", { llmContent: "File /synthetic/repo/src/a.ts successfully edited.", returnDisplay: {} }, "edit"),
    call("badpatch", "badpatch", "edit", { file_path: "/synthetic/repo/src/a.ts", old_string: "delta", new_string: "epsilon" }),
    output("badpatch-result", "badpatch", { isError: false, returnDisplay: { structuredPatch: [{ oldStart: 1, oldLines: 20, newStart: 1, newLines: 1, lines: ["+epsilon"] }] } }, "edit"),
  ]));
  const parsed = await parseSource(path, "codeflicker");
  assert.deepEqual(parsed.events[0]!.fragments.filter(fragment => fragment.kind === "added").map(fragment => fragment.content), ["gamma\n"]);
  assert.equal(parsed.events[1]!.fragments.find(fragment => fragment.kind === "added")!.historicalStart, undefined);
  assert.equal(parsed.events[2]!.fragments.find(fragment => fragment.kind === "added")!.historicalStart, undefined);
  assert.equal(parsed.gaps.filter(gap => gap.kind === "range_unknown").length, 2);
}));

test("重复消息 UUID 不重造调用，新的 UUID 可重用 call ID；续读只解析追加", async () => temporary(async directory => {
  const path = join(directory, "incremental.jsonl");
  const request = call("request-1", "reused");
  const result = output("result-1", "reused", readResult());
  await writeFile(path, encode([request, request]));
  const initial = await parseSource(path, "codeflicker");
  assert.equal(initial.events.length, 1);
  await appendFile(path, encode([result, result, call("request-2", "reused"), output("result-2", "reused", readResult())]));
  const continued = await parseSource(path, "codeflicker", JSON.parse(JSON.stringify(initial)));
  assert.equal(continued.events.length, 2);
  assert.ok(continued.events.every(event => event.status === "success"));
  assert.notEqual(continued.events[0]!.id, continued.events[1]!.id);
  assert.equal((continued.cursor as { parsedRecords: number }).parsedRecords, 4);
  assert.equal(continued.gaps.length, 0);
  const unchanged = await parseSource(path, "codeflicker", continued);
  assert.equal((unchanged.cursor as { parsedRecords: number }).parsedRecords, 0);
  assert.deepEqual(unchanged.events, continued.events);
  const moved = join(directory, "moved.jsonl");
  await rename(path, moved);
  const archived = await parseSource(moved, "codeflicker", unchanged);
  assert.equal(archived.sourceId, continued.sourceId);
  assert.ok(archived.events.every(event => event.sources.every(source => source.path === moved)));
}));

test("多工具结果分别配对；并发重用 ID 无强关联字段时保持歧义", async () => temporary(async directory => {
  const path = join(directory, "multi.jsonl");
  await writeFile(path, encode([
    message("multi-request", "assistant", [{ type: "tool_use", id: "a", name: "read", input: { file_path: "/synthetic/repo/src/a.ts" } }, { type: "tool_use", id: "b", name: "grep", input: { path: "/synthetic/repo/src", pattern: "alpha" } }]),
    message("multi-result", "tool", [{ type: "tool-result", toolCallId: "a", toolName: "read", result: readResult() }, { type: "tool-result", toolCallId: "b", toolName: "grep", result: { isError: false, llmContent: "matching paths" } }]),
    call("ambiguous-a", "reused"), call("ambiguous-b", "reused"), output("ambiguous-result", "reused", readResult()),
  ]));
  const parsed = await parseSource(path, "codeflicker");
  assert.deepEqual(parsed.events.map(event => [event.kind, event.status]), [["read", "success"], ["search", "success"], ["read", "unknown"], ["read", "unknown"]]);
  assert.equal(parsed.gaps.filter(gap => gap.kind === "ambiguous").length, 1);
  assert.equal(parsed.gaps.filter(gap => gap.kind === "unpaired_call").length, 2);
}));

test("不完整 JSONL 尾部等待追加，替换旧前缀后重建", async () => temporary(async directory => {
  const path = join(directory, "tail.jsonl");
  const result = encode([output("result", "read", readResult())]);
  await writeFile(path, encode([call("request", "read")]) + result.slice(0, -1));
  const partial = await parseSource(path, "codeflicker");
  assert.equal(partial.events[0]!.status, "unknown");
  assert.ok(partial.gaps.some(gap => gap.kind === "incomplete_record"));
  await appendFile(path, "\n");
  const complete = await parseSource(path, "codeflicker", partial);
  assert.equal(complete.events[0]!.status, "success");
  assert.equal((complete.cursor as { parsedRecords: number }).parsedRecords, 1);
  await writeFile(path, encode([call("replacement", "new")]));
  const replaced = await parseSource(path, "codeflicker", complete);
  assert.equal(replaced.events.length, 1);
  assert.equal(replaced.events[0]!.status, "unknown");
  assert.notEqual(replaced.events[0]!.id, complete.events[0]!.id);
}));

test("发现主会话与显式子来源，排除 requests；不反解项目 slug 为 cwd", async () => temporary(async directory => {
  const project = join(directory, "users-synthetic-repo");
  await mkdir(join(project, "requests"), { recursive: true });
  await mkdir(join(project, "file-history"), { recursive: true });
  await writeFile(join(project, "main.jsonl"), encode([call("main", "read")]));
  await writeFile(join(project, "agent-child.jsonl"), encode([call("child", "read", "read", {}, { sessionId: "child-session", parentSessionId: "synthetic-codeflicker" })]));
  await writeFile(join(project, "requests", "replay.jsonl"), encode([call("replay", "read")]));
  await writeFile(join(project, "file-history", "snapshot.jsonl"), encode([call("snapshot", "read")]));
  const discovered = await discoverSources({ codex: [], claude: [], codeflicker: [directory], "codeflicker-desktop": [] });
  assert.equal(discovered.length, 2);
  assert.ok(discovered.every(source => source.client === "codeflicker" && source.cwd === undefined));
  const child = await parseSource(join(project, "agent-child.jsonl"), "codeflicker");
  assert.equal(child.parentSessionId, "synthetic-codeflicker");
  assert.deepEqual(child.relationships, [{ kind: "subagent", parentSessionId: "synthetic-codeflicker", agentId: undefined }]);
  const parent = await parseSource(join(project, "main.jsonl"), "codeflicker");
  assert.equal(resolveSharedHistory([parent, child]).events.length, 2);
  await writeFile(join(project, "agent-unconfirmed.jsonl"), encode([call("unconfirmed", "read", "read", {}, { sessionId: "agent-unconfirmed" })]));
  const unconfirmed = await parseSource(join(project, "agent-unconfirmed.jsonl"), "codeflicker");
  assert.equal(unconfirmed.parentSessionId, undefined);
  assert.ok(resolveSharedHistory([parent, unconfirmed]).gaps.some(gap => gap.kind === "ambiguous"));
  assert.equal(resolveSharedHistory([parent, child, unconfirmed]).events.length, 3);
}));

test("无 cwd 来源仍按实际绝对文件路径归属，Hook 和用户内容不制造工具活动", async () => temporary(async directory => {
  const path = join(directory, "session.jsonl");
  const file = join(directory, "a.ts");
  await writeFile(file, "alpha\nbeta\n");
  await writeFile(path, encode([
    call("absolute", "read", "read", { file_path: file }),
    output("absolute-result", "read", readResult("alpha\nbeta\n", { filePath: file })),
    message("hook", "system", [{ type: "tool_use", id: "hook", name: "bash", input: { command: "cat a.ts" } }]),
    message("user-example", "user", [{ type: "tool_use", id: "example", name: "write", input: { file_path: file, content: "example" } }]),
  ]));
  const parsed = await parseSource(path, "codeflicker");
  const baseline: Baseline = { repository: { id: "synthetic", path: directory, commonDir: directory, name: "synthetic", stale: false }, hash: "synthetic", createdAt: "2026-01-01T00:00:00Z", git: { dirty: false }, files: [{ path: "a.ts", category: "source", lineCount: 2, hash: "synthetic", content: "alpha\nbeta\n" }], excluded: [] };
  const associated = await associateSource(parsed, baseline);
  assert.equal(associated.associated, true);
  assert.equal(associated.events.length, 1);
  assert.equal(associated.events[0]!.path, "a.ts");
  assert.equal(parsed.cwd, undefined);
}));

test("无 cwd 的相对读写请求按已核验的工具返回绝对路径归属，不推断后续调用目录", async () => temporary(async directory => {
  const path = join(directory, "relative.jsonl");
  const contents = ["const readContent = true;\n", "const stableContext = true;\nconst changedContent = true;\n", "const writtenContent = true;\n"];
  const files = contents.map((content, index) => ({ path: `src/${index}.ts`, content, category: "source" as const, lineCount: physicalLines(content).length, hash: `file-${index}` }));
  await writeFile(path, encode([
    call("relative-read", "read", "read", { file_path: "./src/0.ts" }),
    output("relative-read-result", "read", readResult(contents[0], { filePath: join(directory, "src/0.ts"), totalLines: 2, limit: 2, actualLinesRead: 2 })),
    call("relative-edit", "edit", "edit", { file_path: "src/1.ts", old_string: "oldContent", new_string: "changedContent" }),
    output("relative-edit-result", "edit", { llmContent: "File src/1.ts successfully edited.", returnDisplay: { absoluteFilePath: join(directory, "src/1.ts"), structuredPatch: [
      { oldStart: 1, newStart: 1, oldLines: 2, newLines: 2, lines: [" const stableContext = true;", "-const oldContent = true;", "+const changedContent = true;"] },
    ] } }, "edit"),
    call("relative-write", "write", "write", { file_path: "src/2.ts", content: contents[2] }),
    output("relative-write-result", "write", { llmContent: "File successfully written to src/2.ts", returnDisplay: { absoluteFilePath: join(directory, "src/2.ts") } }, "write"),
    call("no-return", "missing", "read", { file_path: "src/0.ts" }),
  ]));
  const parsed = await parseSource(path, "codeflicker");
  assert.deepEqual(parsed.events.slice(0, 3).map(event => event.path), files.map(file => join(directory, file.path)));
  assert.ok(parsed.events.slice(0, 3).every(event => event.fragments.length > 0));
  assert.equal(parsed.cwd, undefined);
  assert.equal(parsed.events[3]!.cwd, undefined);
  const baseline: Baseline = { repository: { id: "synthetic", path: directory, commonDir: directory, name: "synthetic", stale: false }, hash: "synthetic", createdAt: "2026-01-01T00:00:00Z", git: { dirty: false }, files, excluded: [] };
  const associated = await associateSource(parsed, baseline);
  assert.equal(associated.events.length, 3);
  assert.deepEqual(associated.events.map((event, index) => matchEvent(event, files[index]!).exactRanges), [[{ start: 1, end: 1 }], [{ start: 2, end: 2 }], [{ start: 1, end: 1 }]]);
}));

test("工具返回路径不能绕过请求后缀、父目录或已知 cwd 的校验", async () => temporary(async directory => {
  for (const [index, requested, returned, cwd] of [
    [0, "src/a.ts", join(directory, "other/a.ts"), undefined],
    [1, "../a.ts", join(directory, "a.ts"), undefined],
    [2, "src/a.ts", join(directory, "other/src/a.ts"), directory],
  ] as const) {
    const path = join(directory, `${index}.jsonl`);
    await writeFile(path, encode([
      call(`mismatch-${index}`, "read", "read", { file_path: requested }, { cwd }),
      output(`mismatch-result-${index}`, "read", readResult("alpha\nbeta\n", { filePath: returned })),
    ]));
    const parsed = await parseSource(path, "codeflicker");
    assert.equal(parsed.events[0]!.path, requested);
    assert.equal(parsed.events[0]!.fragments.length, 0);
    assert.ok(parsed.gaps.some(gap => gap.kind === "range_unknown"));
  }
}));

test("同一原生格式用于不同客户端时保留身份，内容相同不合并真实调用", async () => {
  const codeflicker = await parseSource(fixture, "codeflicker");
  const codex = await parseSource(fixture, "codex", undefined, "codeflicker-jsonl");
  assert.ok(codex.events.every(event => event.client === "codex" && event.sources.every(source => source.sourceId.startsWith("codex:"))));
  assert.notEqual(codex.sourceId, codeflicker.sourceId);
  assert.deepEqual(codex.events.map(event => [event.tool, event.kind, event.status, event.fragments]), codeflicker.events.map(event => [event.tool, event.kind, event.status, event.fragments]));
  assert.equal(resolveSharedHistory([codeflicker, codex]).events.length, 6);
});

test("原生 bash 终态包装只读取实际 stdout，截断或后台返回保持缺口；搜索独立计数", async () => temporary(async directory => {
  const path = join(directory, "bash.jsonl");
  const shell = (code: number, stdout: string) => ({ llmContent: `Command: cat /synthetic/repo/src/a.ts\nDirectory: /synthetic/repo\nStdout: ${stdout}\nStderr: (empty)\nError: (none)\nExit Code: ${code}`, returnDisplay: stdout, truncated: false });
  await writeFile(path, encode([
    call("bash-success", "bash-success", "bash", { command: "cat /synthetic/repo/src/a.ts" }), output("bash-result", "bash-success", shell(0, "alpha\nbeta\n"), "bash"),
    call("bash-failure", "bash-failure", "bash", { command: "cat /synthetic/repo/src/a.ts" }), output("bash-failure-result", "bash-failure", shell(1, "alpha\n"), "bash"),
    call("bash-truncated", "bash-truncated", "bash", { command: "cat /synthetic/repo/src/a.ts" }), output("bash-truncated-result", "bash-truncated", shell(0, "alpha\n... [9 lines truncated] ..."), "bash"),
    call("bash-background", "bash-background", "bash", { command: "cat /synthetic/repo/src/a.ts" }), output("bash-background-result", "bash-background", { llmContent: "Task is running in background" }, "bash"),
    call("grep", "grep", "grep", { path: "/synthetic/repo/src", pattern: "alpha" }), output("grep-result", "grep", { llmContent: JSON.stringify({ mode: "content", numFiles: 1, filenames: [], content: "alpha", numLines: 1, durationMs: 1, truncated: false }) }, "grep"),
  ]));
  const parsed = await parseSource(path, "codeflicker");
  assert.deepEqual(parsed.events.map(event => event.status), ["success", "failure", "success", "unknown", "success"]);
  assert.equal(parsed.events[0]!.fragments[0]!.content, "alpha\nbeta\n");
  assert.ok(parsed.events.slice(1).every(event => event.fragments.length === 0));
  assert.equal(parsed.events[4]!.kind, "search");
  assert.equal(parsed.gaps.filter(gap => gap.kind === "range_unknown").length, 2);
}));
