import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// 预期值由六行匿名源码手算；只经真实 CLI/HTTP 验证，不调用解析与统计实现。
const run = promisify(execFile);
const cli = process.env.AGENT_MANOR_E2E_CLI ?? fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-codeflicker-e2e-")));
const repository = join(directory, "repository");
const codeflicker = join(directory, "codeflicker");
const codex = join(directory, "codex");
const claude = join(directory, "claude");
const home = join(directory, "data");
const env = { ...process.env, AGENT_MANOR_HOME: home, AGENT_MANOR_PORT: "0", AGENT_MANOR_CODEX_DIR: codex,
  AGENT_MANOR_CLAUDE_DIR: claude, AGENT_MANOR_CODEFLICKER_DIR: codeflicker };
const files = {
  "src/a.ts": "export const firstAnchor = true;\nexport const value = 1;\nexport const lastAnchor = false;\n",
  "src/b.ts": "export const createdFirst = 2;\nexport const createdSecond = 3;\n",
  "src/c.ts": "export const separate = 4;\n",
};
const absolute = path => join(repository, path);
const encode = records => records.map(record => JSON.stringify(record) + "\n").join("");
const session = "cf-e2e-native";
const message = (uuid, role, content) => ({ type: "message", sessionId: session, uuid, role,
  timestamp: "2026-01-03T00:00:00Z", version: "0.3.26", content });
const pair = (id, tool, input, result) => [
  message(`request-${id}`, "assistant", [{ type: "tool_use", id, name: tool, input }]),
  message(`result-${id}`, "tool", [{ type: "tool-result", toolCallId: id, toolName: tool, input, result }]),
];
const readResult = (path, content) => ({ llmContent: JSON.stringify({ type: "text", filePath: absolute(path), content,
  totalLines: content.split("\n").length, offset: 1, limit: content.split("\n").length, actualLinesRead: content.split("\n").length }),
  returnDisplay: "文件读取完成", truncated: false, maxResultSizeChars: 10000 });
const writeResult = { llmContent: `File successfully written to ${absolute("src/b.ts")}`, truncated: false,
  returnDisplay: { type: "diff_viewer", filePath: "src/b.ts", absoluteFilePath: absolute("src/b.ts"), originalContent: "",
    newContent: { inputKey: "content" }, writeType: "add", structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2,
      lines: ["+export const createdFirst = 2;", "+export const createdSecond = 3;"] }] } };
const editResult = { llmContent: `File ${absolute("src/a.ts")} successfully edited.`, truncated: false,
  returnDisplay: { type: "diff_viewer", filePath: "src/a.ts", absoluteFilePath: absolute("src/a.ts"),
    originalContent: { inputKey: "old_string" }, newContent: { inputKey: "new_string" }, startLineNumber: 2,
    structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3,
      lines: [" export const firstAnchor = true;", "-export const value = 0;", "+export const value = 1;", " export const lastAnchor = false;"] }] } };
const records = [
  { type: "config", config: {} },
  ...pair("a-one", "read", { file_path: absolute("src/a.ts") }, readResult("src/a.ts", files["src/a.ts"])),
  ...pair("a-two", "read", { file_path: absolute("src/a.ts") }, readResult("src/a.ts", files["src/a.ts"])),
  ...pair("b-write", "write", { file_path: absolute("src/b.ts"), content: files["src/b.ts"] }, writeResult),
  ...pair("a-edit", "edit", { file_path: absolute("src/a.ts"), old_string: "export const value = 0;", new_string: "export const value = 1;" }, editResult),
  ...pair("c-failed", "read", { file_path: absolute("src/c.ts") }, { isError: true, llmContent: "permission denied" }),
  ...pair("c-search", "grep", { path: absolute("src/c.ts"), pattern: "separate" }, { isError: false, llmContent: "匹配一行" }),
  ...pair("c-unknown", "read", { file_path: absolute("src/c.ts") }, { llmContent: "已返回但无法确认实际读取范围" }),
  ...pair("c-truncated", "read", { file_path: absolute("src/c.ts") }, { ...readResult("src/c.ts", files["src/c.ts"]), truncated: true }),
  message("request-c-pending", "assistant", [{ type: "tool_use", id: "c-pending", name: "read", input: { file_path: absolute("src/c.ts") } }]),
];
const source = join(codeflicker, "native.jsonl");
const raw = encode(records);
const sourceHash = createHash("sha256").update(raw).digest("hex");
let repositoryId;
let url;
let completed = false;
const results = [];
async function command(args, failure = false) {
  let result;
  try { result = await run(process.execPath, [cli, ...args, "--json"], { cwd: directory, env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }); }
  catch (error) { if (!failure) throw error; result = error; }
  return JSON.parse(result.stdout || result.stderr);
}
const coverage = (extra = []) => command(["coverage", repositoryId, "--client", "codeflicker", ...extra]);
const refresh = async () => {
  const response = await command(["refresh", repositoryId, "--wait"]);
  assert.equal(response.job.status, "completed", response.job.error);
  return coverage();
};
const semantic = result => ({ summary: result.summary, files: result.files });
async function step(name, action) {
  const started = Date.now();
  await action();
  results.push({ name, milliseconds: Date.now() - started, status: "passed" });
  console.log(`PASS ${name}`);
}
try {
  for (const path of [join(repository, "src"), codeflicker, codex, claude, join(codeflicker, "requests")]) await mkdir(path, { recursive: true });
  for (const [path, content] of Object.entries(files)) await writeFile(absolute(path), content);
  await run("git", ["init", "-q", repository]);
  await writeFile(source, raw);
  // requests 含完整重放仍不得成为独立工具活动。
  await writeFile(join(codeflicker, "requests", "replay.jsonl"), raw);
  await writeFile(join(codex, "native.jsonl"), encode([
    { type: "session_meta", payload: { id: "cf-e2e-codex", cwd: repository } },
    { type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "c", arguments: JSON.stringify({ command: "cat src/c.ts", workdir: repository }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "c", output: `Exit code: 0\nOutput:\n${files["src/c.ts"]}` } },
  ]));
  await step("真实后台/Worker登记并分析CodeFlicker", async () => {
    const registered = await command(["register", repository, "--wait"]);
    assert.equal(registered.job.status, "completed", registered.job.error);
    repositoryId = registered.repository.id;
    const status = await command(["status"]);
    url = `http://127.0.0.1:${status.instance.port}`;
  });
  await step("六行人工答案：读取3行、修改3行、两次读取不增加覆盖", async () => {
    const result = await coverage();
    assert.deepEqual(result.summary, { fileCount: 3, lineCount: 6, readExact: { files: 1, lines: 3 },
      readNear: { files: 0, lines: 0 }, editExact: { files: 2, lines: 3 }, editNear: { files: 0, lines: 0 } });
    const a = result.files.find(file => file.path === "src/a.ts");
    assert.equal(a.readCount, 2);
    assert.deepEqual(a.editExactRanges, [{ start: 2, end: 2 }]);
    const c = result.files.find(file => file.path === "src/c.ts");
    assert.equal(c.readExactLines, 0);
    assert.equal(c.failedCount, 1);
    assert.equal(c.searchCount, 1);
    assert.ok(c.unknownCount >= 2);
    assert.ok(result.gaps.some(gap => gap.kind === "unpaired_call"));
  });
  await step("CLI/API相同版本、客户端筛选与requests排除", async () => {
    const result = await coverage();
    const response = await fetch(`${url}/api/v1/repositories/${repositoryId}/coverage?client=codeflicker&version=${result.version}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
    assert.equal((await command(["coverage", repositoryId])).summary.readExact.lines, 4);
    assert.equal((await command(["coverage", repositoryId, "--client", "codex"])).summary.readExact.lines, 1);
    assert.equal((await command(["coverage", repositoryId, "--client", "claude"])).summary.readExact.lines, 0);
    const events = await command(["events", repositoryId, "--client", "codeflicker"]);
    assert.equal(events.total, 9);
    assert.ok(events.events.every(event => event.client === "codeflicker"));
    const sources = await command(["sources", repositoryId, "--client", "codeflicker"]);
    assert.equal(sources.sources.length, 1);
    assert.ok(![...sources.sources, ...sources.unassociated].some(item => item.path.includes("/requests/")));
  });
  await step("当前代码范围与原始物理行哈希回查", async () => {
    const result = await coverage();
    const detail = await command(["file", repositoryId, "src/a.ts", "--client", "codeflicker", "--version", result.version]);
    assert.equal(detail.content, files["src/a.ts"]);
    assert.deepEqual(detail.file.readExactRanges, [{ start: 1, end: 3 }]);
    const event = detail.events.find(event => event.kind === "read" && event.status === "success");
    const evidence = await command(["evidence", repositoryId, event.id, "--client", "codeflicker", "--version", result.version]);
    assert.equal(evidence.version, result.version);
    assert.equal(evidence.records.length, 2);
    assert.equal(evidence.unavailable.length, 0);
    const physical = raw.trimEnd().split("\n");
    for (const record of evidence.records) {
      assert.equal(record.raw, physical[record.source.recordLine - 1]);
      assert.equal(createHash("sha256").update(record.raw).digest("hex"), record.source.hash);
      assert.equal(record.source.format, "codeflicker-jsonl");
    }
  });
  await step("重复刷新、清缓存与来源副本不虚增活动", async () => {
    const result = await coverage();
    assert.deepEqual(semantic(await refresh()), semantic(result));
    await command(["cacheclear", repositoryId, "--wait"]);
    assert.deepEqual(semantic(await coverage()), semantic(result));
    await writeFile(join(codeflicker, "copy.jsonl"), raw);
    assert.deepEqual(semantic(await refresh()), semantic(result));
    await rm(join(codeflicker, "copy.jsonl"));
    await refresh();
  });
  await step("追加半行保持上版证据，补齐结果只增加一次", async () => {
    const appended = pair("c-append", "read", { file_path: absolute("src/c.ts") }, readResult("src/c.ts", files["src/c.ts"]));
    const response = JSON.stringify(appended[1]);
    await appendFile(source, encode([appended[0]]) + response.slice(0, 40));
    assert.equal((await refresh()).summary.readExact.lines, 3);
    await appendFile(source, response.slice(40) + "\n");
    assert.equal((await refresh()).summary.readExact.lines, 4);
    // 截断读取已成功但范围未知；新增完整结果只再增加一次成功读取。
    assert.equal((await refresh()).files.find(file => file.path === "src/c.ts").readCount, 2);
    await writeFile(source, raw);
    assert.equal((await refresh()).summary.readExact.lines, 3);
  });
  await step("来源缺失排除新版本，旧版本仍可对照", async () => {
    const before = await coverage();
    await rename(source, join(directory, "missing.jsonl"));
    const missing = await refresh();
    assert.equal(missing.summary.readExact.lines, 0);
    assert.equal(missing.summary.editExact.lines, 0);
    assert.ok(missing.gaps.some(gap => gap.kind === "source_missing"));
    assert.deepEqual((await coverage(["--version", before.version])).summary, before.summary);
    await rename(join(directory, "missing.jsonl"), source);
    assert.deepEqual((await refresh()).summary, before.summary);
  });
  await step("SDK隐式长行截断不计近似，Shell执行目录支持相对读取", async () => {
    const before = await coverage();
    const prefix = 'export const longText = "' + "abcdefghijklmno".repeat(140);
    const content = prefix.slice(0, 2000) + "TAIL!\n";
    await writeFile(absolute("src/d.ts"), content);
    await appendFile(source, encode([
      ...pair("d-clipped", "read", { file_path: absolute("src/d.ts") }, readResult("src/d.ts", content.slice(0, 2000) + "...\n")),
      ...pair("c-shell", "bash", { command: "cat src/c.ts" }, {
        llmContent: `Command: cat src/c.ts\nDirectory: ${repository}\nStdout: ${files["src/c.ts"]}\nStderr: (empty)\nError: (none)\nExit Code: 0`, truncated: false,
      }),
    ]));
    const result = await refresh();
    const clipped = result.files.find(file => file.path === "src/d.ts");
    assert.equal(clipped.readExactLines, 0);
    assert.equal(clipped.readNearLines, 0);
    assert.equal(result.files.find(file => file.path === "src/c.ts").readExactLines, 1);
    assert.equal(result.summary.readExact.lines, 4);
    await rm(absolute("src/d.ts"));
    await writeFile(source, raw);
    assert.deepEqual(semantic(await refresh()), semantic(before));
  });
  assert.equal(createHash("sha256").update(await readFile(source)).digest("hex"), sourceHash);
  const state = { directory, repository, repositoryId, home, codex, claude, codeflicker, source, sourceHash, cli, url, version: (await coverage()).version, results };
  await writeFile(join(directory, "state.json"), JSON.stringify(state, null, 2));
  completed = true;
  console.log(JSON.stringify({ passed: results.length, ...(process.argv.includes("--keep") ? { state: join(directory, "state.json"), url } : {}) }));
} finally {
  if (!completed || !process.argv.includes("--keep")) {
    await command(["stop"]).catch(() => undefined);
    if (!process.argv.includes("--keep")) await rm(directory, { recursive: true, force: true });
    else console.log(JSON.stringify({ diagnosticDirectory: directory }));
  }
}
