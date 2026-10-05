import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// 只经真实 CLI/HTTP 验收；所有修改与故障都限制在本脚本创建的临时目录。
const run = promisify(execFile);
const cli = process.env.AGENT_MANOR_E2E_CLI ?? fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-e2e-")));
const repository = join(directory, "repository");
const codex = join(directory, "codex");
const claude = join(directory, "claude");
const codeflicker = join(directory, "codeflicker");
const home = join(directory, "data");
const env = { ...process.env, AGENT_MANOR_HOME: home, AGENT_MANOR_PORT: "0", AGENT_MANOR_CODEX_DIR: codex, AGENT_MANOR_CLAUDE_DIR: claude, AGENT_MANOR_CODEFLICKER_DESKTOP_DIR: join(directory, "missing-desktop"), AGENT_MANOR_CODEFLICKER_DIR: codeflicker };
const encode = (records) => records.map((record) => JSON.stringify(record) + "\n").join("");
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const files = {
  "src/alpha.ts": "export const anchorAlpha = true;\nexport const currentValue = 1;\nexport const anchorOmega = false;\n",
  "src/nested/beta.ts": "export const nestedDelta = 4;\nexport const nestedEpsilon = 5;\n",
  "src/unread.ts": "export const neverReadValue = true;\n",
  "src/ambiguous.ts": "export const repeatedValue = true;\nexport const repeatedTail = false;\nexport const repeatedValue = true;\nexport const repeatedTail = false;\n",
  "src/insert.ts": "export const beforeInsertion = true;\nexport const middleInsertion = 42;\nexport const afterInsertion = false;\n",
  "src/short.ts": "export const shortAnchorBefore = true;\nx=1;\nexport const shortAnchorAfter = false;\n",
  "README.md": "# 端到端验收\n独立人工样本。\n",
  "config.json": "{\"enabled\":true}\n",
  "node_modules/ignored.ts": "依赖不入分母\n",
  "dist/ignored.ts": "构建产物不入分母\n",
};
const source = join(codex, "main.jsonl");
const orphan = join(codex, "orphan.jsonl");
const meta = (id, cwd = repository, extra = {}) => ({ type: "session_meta", payload: { id, cwd, ...extra } });
const call = (id, command, output, exit = 0, cwd = repository, time = "2026-01-01T00:00:01Z") => [
  { timestamp: time, type: "response_item", payload: { type: "function_call", id: `request-${id}`, name: "shell_command", call_id: id, arguments: JSON.stringify({ command, workdir: cwd }) } },
  { timestamp: time, type: "response_item", payload: { type: "function_call_output", call_id: id, output: `Exit code: ${exit}\nOutput:\n${output}` } },
];
const readPair = (id, path, content, cwd = repository) => [
  { timestamp: "2026-01-02T00:00:01Z", type: "assistant", uuid: `request-${id}`, sessionId: "e2e-claude", cwd, message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: path } }] } },
  { timestamp: "2026-01-02T00:00:02Z", type: "user", uuid: `result-${id}`, sourceToolAssistantUUID: `request-${id}`, sessionId: "e2e-claude", cwd, message: { content: [{ type: "tool_result", tool_use_id: id, content }] }, toolUseResult: { type: "text", file: { filePath: path, content, numLines: content.trimEnd().split("\n").length, startLine: 1, totalLines: content.trimEnd().split("\n").length } } },
];
const raw = encode([
  meta("e2e-codex"),
  ...call("alpha-1", "cat src/alpha.ts", files["src/alpha.ts"]),
  ...call("alpha-2", "cat src/alpha.ts", files["src/alpha.ts"]),
  ...call("insert", "cat src/insert.ts", files["src/insert.ts"]),
  ...call("short", "cat src/short.ts", files["src/short.ts"]),
  ...call("ambiguous", "sed -n '1,2p' src/ambiguous.ts", files["src/ambiguous.ts"].split("\n").slice(0, 2).join("\n") + "\n"),
  ...call("search", "rg -n currentValue src/alpha.ts", "src/alpha.ts:2:export const currentValue = 1;\n"),
  ...call("failed", "cat src/nested/beta.ts", "permission denied\n", 1),
  ...call("complex", "cat src/alpha.ts && cat src/unread.ts", files["src/alpha.ts"] + files["src/unread.ts"]),
  { timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "function_call", id: "request-direct", name: "Read", call_id: "direct", arguments: JSON.stringify({ file_path: join(repository, "src/nested/beta.ts") }) } },
  { timestamp: "2026-01-01T00:00:02Z", type: "response_item", payload: { type: "function_call_output", call_id: "direct", output: JSON.stringify({ type: "text", file: { filePath: join(repository, "src/nested/beta.ts"), content: files["src/nested/beta.ts"], startLine: 1, numLines: 2, totalLines: 2 } }) } },
  { timestamp: "2026-01-01T00:00:03Z", type: "event_msg", payload: { type: "item_completed", item: { id: "edit-alpha", type: "FileChange", status: "completed", changes: { "src/alpha.ts": { type: "update", unified_diff: "@@ -1,3 +1,3 @@\n export const anchorAlpha = true;\n-export const currentValue = 0;\n+export const currentValue = 1;\n export const anchorOmega = false;\n" } } } } },
  { timestamp: "2026-01-01T00:00:04Z", type: "event_msg", payload: { type: "item_completed", item: { id: "edit-deleted", type: "FileChange", status: "completed", changes: { "src/deleted.ts": { type: "delete" } } } } },
]);
const orphanRaw = encode([meta("e2e-orphan", null), ...call("orphan-read", "cat src/unread.ts", files["src/unread.ts"], 0, null)]);
const results = [];
let repositoryId;
let completed = false;

async function command(args, failure = false) {
  let result;
  try { result = await run(process.execPath, [cli, ...args, "--json"], { cwd: directory, env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }); }
  catch (error) { if (!failure) throw error; result = error; }
  const output = result.stdout || result.stderr;
  return JSON.parse(output);
}
const coverage = (args = []) => command(["coverage", repositoryId, ...args]);
const refresh = async () => {
  const result = await command(["refresh", repositoryId, "--wait"]);
  assert.equal(result.job.status, "completed", result.job.error);
  return coverage();
};
const sem = (value) => ({ summary: value.summary, files: value.files, gaps: value.gaps });
async function step(name, action) {
  const started = Date.now();
  await action();
  results.push({ name, milliseconds: Date.now() - started, status: "passed" });
  console.log(`PASS ${name}`);
}

try {
  for (const path of [codex, claude, codeflicker, repository]) await mkdir(path, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repository, path, ".."), { recursive: true });
    await writeFile(join(repository, path), content);
  }
  await run("git", ["init", "-q", repository]);
  await run("git", ["-C", repository, "add", "src", "README.md", "config.json"]);
  await run("git", ["-C", repository, "-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "人工验收基线"]);
  await writeFile(source, raw);
  await writeFile(orphan, orphanRaw);
  await writeFile(join(claude, "main.jsonl"), encode([
    ...readPair("beta", join(repository, "src/nested/beta.ts"), files["src/nested/beta.ts"]),
    ...readPair("docs", join(repository, "README.md"), files["README.md"]),
    ...readPair("config", join(repository, "config.json"), files["config.json"]),
    { timestamp: "2026-01-02T00:00:03Z", type: "assistant", uuid: "request-write", sessionId: "e2e-claude", cwd: repository, message: { content: [{ type: "tool_use", id: "write", name: "Write", input: { file_path: join(repository, "src/unread.ts"), content: files["src/unread.ts"] } }] } },
    { timestamp: "2026-01-02T00:00:04Z", type: "user", uuid: "result-write", sourceToolAssistantUUID: "request-write", sessionId: "e2e-claude", cwd: repository, message: { content: [{ type: "tool_result", tool_use_id: "write", content: "Written" }] }, toolUseResult: { type: "create", filePath: join(repository, "src/unread.ts"), content: files["src/unread.ts"] } },
  ]));

  await step("未启动 stop 不创建后台；登记按需启动并完成分析", async () => {
    assert.equal((await command(["stop"])).running, false);
    const registered = await command(["register", repository, "--wait"]);
    repositoryId = registered.repository.id;
    assert.equal(registered.job.status, "completed", registered.job.error);
    assert.equal((await command(["status"])).instance.host, "127.0.0.1");
    assert.equal((await command(["repositories"])).repositories.length, 1);
  });
  await step("人工分母、读取/编辑、重复次数、失败/搜索/歧义分别核对", async () => {
    const value = await coverage();
    assert.equal(value.summary.fileCount, 6);
    assert.equal(value.summary.lineCount, 16);
    assert.deepEqual(value.summary.readExact, { files: 4, lines: 11 }, JSON.stringify(value.files.map((file) => ({ path: file.path, read: file.readExactLines, count: file.readCount }))));
    assert.deepEqual(value.summary.readNear, { files: 0, lines: 0 });
    assert.deepEqual(value.summary.editExact, { files: 2, lines: 2 });
    const alpha = value.files.find((file) => file.path === "src/alpha.ts");
    assert.equal(alpha.readCount, 2);
    assert.equal(alpha.searchCount, 1);
    assert.equal(value.files.find((file) => file.path === "src/nested/beta.ts").failedCount, 1);
    assert.equal(value.files.find((file) => file.path === "src/ambiguous.ts").readExactLines, 0);
    assert.ok(value.gaps.some((gap) => gap.kind === "ambiguous"));
    assert.ok(value.gaps.some((gap) => gap.kind === "unsupported_tool"));
  });
  await step("客户端、时间、类别、目录与零分母筛选", async () => {
    assert.deepEqual((await coverage(["--client", "claude"])).summary.readExact, { files: 1, lines: 2 });
    assert.deepEqual((await coverage(["--from", "2026-01-02T00:00:00Z", "--to", "2026-01-02T23:59:59Z"])).summary.readExact, { files: 1, lines: 2 });
    const all = await coverage(["--categories", "source,config,docs,unknown"]);
    assert.equal(all.summary.fileCount, 8);
    assert.equal(all.summary.lineCount, 19);
    assert.equal(all.summary.readExact.lines, 14);
    assert.equal((await coverage(["--directory", "src/nested"])).summary.lineCount, 2);
    assert.equal((await coverage(["--categories", "unknown"])).summary.lineCount, 0);
  });
  await step("固定版本的文件、分页事件、证据、热点和未观察读取", async () => {
    const value = await coverage();
    const options = ["--version", value.version, "--client", "codex", "--directory", "src"];
    const detail = await command(["file", repositoryId, "src/alpha.ts", ...options]);
    assert.equal(detail.content, files["src/alpha.ts"]);
    assert.equal(detail.version, value.version);
    const events = await command(["events", repositoryId, "--path", "src/alpha.ts", "--page-size", "1", ...options]);
    assert.equal(events.events.length, 1);
    assert.ok(events.total > 1);
    const next = await command(["events", repositoryId, "--path", "src/alpha.ts", "--page", "2", "--page-size", "1", ...options]);
    assert.notEqual(events.events[0].id, next.events[0].id);
    const evidence = await command(["evidence", repositoryId, events.events[0].id, ...options]);
    assert.equal(evidence.version, value.version);
    assert.ok(evidence.records.length > 0);
    assert.equal(evidence.unavailable.length, 0);
    assert.ok((await command(["hotspots", repositoryId, "--metric", "activity", "--limit", "2", ...options])).files.length <= 2);
    assert.ok((await command(["unobserved", repositoryId])).files.some((file) => file.path === "src/unread.ts"));
    const deleted = await command(["events", repositoryId, "--path", "src/deleted.ts", ...options]);
    assert.equal(deleted.total, 1);
    assert.ok((await command(["evidence", repositoryId, deleted.events[0].id, ...options])).records.length > 0);
  });
  await step("反复刷新不重复计数，清缓存重建语义一致", async () => {
    const original = await coverage();
    assert.deepEqual(sem(await refresh()), sem(original));
    assert.equal((await command(["cacheclear", repositoryId, "--wait"])).job.status, "completed");
    assert.deepEqual(sem(await coverage()), sem(original));
  });
  await step("当前文件变化先禁止旧高亮；单字符变化精确/近似分开", async () => {
    await writeFile(join(repository, "src/alpha.ts"), files["src/alpha.ts"].replace("currentValue = 1", "currentValue = 2"));
    const stale = await command(["file", repositoryId, "src/alpha.ts"]);
    assert.equal(stale.contentStale, true);
    assert.equal(stale.content, null);
    const changed = await refresh();
    assert.equal(changed.summary.readExact.lines, 10);
    assert.equal(changed.summary.readNear.lines, 1);
    const detail = await command(["file", repositoryId, "src/alpha.ts"]);
    assert.deepEqual(detail.file.readNearRanges, [{ start: 2, end: 2 }]);
    await writeFile(join(repository, "src/alpha.ts"), files["src/alpha.ts"].replace("currentValue = 1", "currentValue = 0"));
    const reverted = await refresh();
    assert.equal(reverted.files.find((file) => file.path === "src/alpha.ts").editCount, 1);
    assert.equal(reverted.files.find((file) => file.path === "src/alpha.ts").editExactLines, 1);
    await writeFile(join(repository, "src/alpha.ts"), files["src/alpha.ts"]);
    await refresh();
  });
  await step("插入行重映射、短行单字符变化与重复上下文保守判定", async () => {
    await writeFile(join(repository, "src/insert.ts"), "export const newlyInserted = true;\n" + files["src/insert.ts"]);
    await writeFile(join(repository, "src/short.ts"), files["src/short.ts"].replace("x=1;", "x=2;"));
    await refresh();
    const inserted = await command(["file", repositoryId, "src/insert.ts"]);
    assert.deepEqual(inserted.file.readExactRanges, [{ start: 2, end: 4 }]);
    const short = await command(["file", repositoryId, "src/short.ts"]);
    assert.equal(short.file.readExactLines, 2);
    assert.equal(short.file.readNearLines, 1);
    await writeFile(join(repository, "src/insert.ts"), files["src/insert.ts"]);
    await writeFile(join(repository, "src/short.ts"), files["src/short.ts"]);
    await refresh();
  });
  await step("待关联来源手动关联，清缓存保留关联", async () => {
    const sources = await command(["sources", repositoryId]);
    const candidate = sources.unassociated.find((item) => item.sessionId === "e2e-orphan");
    assert.ok(candidate);
    assert.equal((await command(["associate", repositoryId, candidate.sourceId, "--wait"])).job.status, "completed");
    assert.equal((await coverage()).summary.readExact.lines, 12);
    await command(["cacheclear", repositoryId, "--wait"]);
    assert.equal((await coverage()).summary.readExact.lines, 12);
    assert.ok((await command(["sources", repositoryId])).sources.some((item) => item.sourceId === candidate.sourceId && item.association === "manual"));
  });
  await step("复制来源去重、移动来源不增加活动、旧引用不可回查有说明", async () => {
    const original = await coverage();
    await writeFile(join(codex, "copy.jsonl"), raw);
    assert.deepEqual((await refresh()).summary, original.summary);
    assert.equal((await coverage()).files.find((file) => file.path === "src/alpha.ts").readCount, 2);
    await rm(join(codex, "copy.jsonl"));
    await rename(source, join(codex, "moved.jsonl"));
    assert.deepEqual((await refresh()).summary, original.summary);
    await rename(join(codex, "moved.jsonl"), source);
    await refresh();
  });
  await step("未完整 JSONL 尾行等待，补齐结果后只增加一次覆盖", async () => {
    const before = await coverage();
    const appended = call("appended", "cat src/unread.ts", files["src/unread.ts"], 0, repository, "2026-01-03T00:00:00Z");
    const response = JSON.stringify(appended[1]);
    await appendFile(source, encode([appended[0]]) + response.slice(0, 30));
    const partial = await refresh();
    assert.deepEqual(partial.summary, before.summary);
    assert.ok(partial.gaps.some((gap) => gap.kind === "incomplete_record"));
    await appendFile(source, response.slice(30) + "\n");
    const full = await refresh();
    assert.equal(full.files.find((file) => file.path === "src/unread.ts").readCount, 2);
    await writeFile(source, raw);
    assert.equal((await refresh()).files.find((file) => file.path === "src/unread.ts").readCount, 1);
  });
  await step("来源缺失新版排除、上版保留、恢复后重建", async () => {
    const before = await coverage();
    await rename(source, join(directory, "missing.jsonl"));
    const missing = await refresh();
    assert.equal(missing.summary.readExact.lines, 3);
    assert.ok(missing.gaps.some((gap) => gap.kind === "source_missing"));
    assert.deepEqual((await coverage(["--version", before.version])).summary, before.summary);
    await rename(join(directory, "missing.jsonl"), source);
    assert.deepEqual((await refresh()).summary, before.summary);
  });
  await step("原始证据变化不回读错误正文", async () => {
    const version = (await coverage()).version;
    const events = await command(["events", repositoryId, "--client", "codex", "--path", "src/alpha.ts", "--kind", "read"]);
    const event = events.events[0];
    await writeFile(source, raw.replaceAll("currentValue = 1", "currentValue = 9"));
    const evidence = await command(["evidence", repositoryId, event.id, "--version", version]);
    assert.ok(evidence.unavailable.length > 0);
    assert.ok(!JSON.stringify(evidence.records).includes("currentValue = 9"));
    await writeFile(source, raw);
    await refresh();
  });
  await step("明确分叉复制的父历史不重复计数，子会话新读取保留", async () => {
    const before = await coverage();
    const inherited = raw.trim().split("\n").slice(1).map((line) => JSON.parse(line));
    await writeFile(join(codex, "fork.jsonl"), encode([meta("e2e-fork", repository, { history_base: { thread_id: "e2e-codex", end_byte_offset: Buffer.byteLength(raw) } }), ...inherited]));
    assert.deepEqual((await refresh()).summary, before.summary);
    assert.equal((await coverage()).files.find((file) => file.path === "src/alpha.ts").readCount, 2);
    const child = readPair("child-beta", join(repository, "src/nested/beta.ts"), files["src/nested/beta.ts"]).map((record) => ({ ...record, agentId: "child-beta", isSidechain: true }));
    await writeFile(join(claude, "agent-child.jsonl"), encode(child));
    const withChild = await refresh();
    assert.deepEqual(withChild.summary, before.summary);
    assert.equal(withChild.files.find((file) => file.path === "src/nested/beta.ts").readCount, 3);
    const events = await command(["events", repositoryId, "--path", "src/nested/beta.ts", "--client", "claude"]);
    assert.ok(events.events.some((event) => event.parentSessionId === "e2e-claude"));
    await rm(join(codex, "fork.jsonl"));
    await rm(join(claude, "agent-child.jsonl"));
    await refresh();
  });
  await step("Git worktree 正确归属，相同 remote 的独立 clone 不混入", async () => {
    const before = await coverage();
    const worktree = join(directory, "worktree");
    const independent = join(directory, "independent");
    await run("git", ["-C", repository, "worktree", "add", "--detach", worktree]);
    await run("git", ["clone", "-q", repository, independent]);
    const linkedSource = join(codex, "worktree.jsonl");
    const foreignSource = join(codex, "independent.jsonl");
    await writeFile(linkedSource, encode([meta("e2e-worktree", worktree), ...call("linked", "cat src/unread.ts", files["src/unread.ts"], 0, worktree)]));
    await writeFile(foreignSource, encode([meta("e2e-independent", independent), ...call("foreign", "cat src/unread.ts", files["src/unread.ts"], 0, independent)]));
    const scoped = await refresh();
    assert.deepEqual(scoped.summary, before.summary);
    assert.equal(scoped.files.find((file) => file.path === "src/unread.ts").readCount, 2);
    const sources = await command(["sources", repositoryId]);
    assert.ok(sources.sources.some((item) => item.sessionId === "e2e-worktree"));
    assert.ok(!sources.sources.some((item) => item.sessionId === "e2e-independent"));
    await rm(linkedSource); await rm(foreignSource);
    await run("git", ["-C", repository, "worktree", "remove", worktree]);
    await refresh();
  });
  await step("多仓库并发刷新串行完成，查询继续绑定完整版本", async () => {
    const other = join(directory, "second-repository");
    await mkdir(other);
    await run("git", ["init", "-q", other]);
    await writeFile(join(other, "empty.ts"), "export const separateRepository = true;\n");
    const registered = await command(["register", other, "--wait"]);
    assert.equal(registered.job.status, "completed");
    const before = await coverage();
    const requested = await Promise.all([command(["refresh", repositoryId]), command(["refresh", registered.repository.id])]);
    assert.deepEqual((await coverage(["--version", before.version])).summary, before.summary);
    const finished = await Promise.all(requested.map((item) => command(["jobs", item.job.id, "--wait"])));
    for (const item of finished) assert.equal(item.job.status, "completed");
    const ordered = finished.map((item) => item.job).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    assert.ok(ordered[1].startedAt >= ordered[0].finishedAt);
    assert.equal((await command(["coverage", registered.repository.id])).summary.readExact.lines, 0);
  });
  await step("临时读取失败不当缺失，失败保留旧版并标过期", async () => {
    const before = await coverage();
    await chmod(source, 0);
    try {
      const failed = await command(["refresh", repositoryId, "--wait"], true);
      assert.equal(failed.job.status, "failed");
      const after = await coverage();
      assert.equal(after.version, before.version);
      assert.equal(after.stale, true);
      assert.deepEqual(after.summary, before.summary);
    } finally { await chmod(source, 0o600); }
    assert.equal((await refresh()).stale, false);
  });
  await step("无效查询拒绝，服务保持可用", async () => {
    for (const args of [["--client", "invalid"], ["--from", "bad"], ["--directory", "../outside"], ["--version", "unknown"]]) {
      assert.ok((await command(["coverage", repositoryId, ...args], true)).error);
    }
    assert.ok((await command(["file", repositoryId, "../outside"], true)).error);
    assert.equal((await coverage()).summary.readExact.lines, 12);
  });
  await step("显式停止、再次查询按需启动并检查工作区变化", async () => {
    const old = (await command(["status"])).instance.id;
    assert.equal((await command(["stop"])).stopping, true);
    for (let i = 0; i < 100; i++) {
      try { await readFile(join(home, "service.json")); await pause(25); }
      catch { break; }
    }
    await writeFile(join(repository, "src/unread.ts"), files["src/unread.ts"] + "export const startupAddedLine = true;\n");
    const status = await command(["status"]);
    assert.notEqual(status.instance.id, old);
    for (const job of status.jobs.filter((job) => job.status === "running" || job.status === "queued")) await command(["jobs", job.id, "--wait"]);
    assert.equal((await coverage()).summary.lineCount, 17);
    await writeFile(join(repository, "src/unread.ts"), files["src/unread.ts"]);
    await refresh();
  });
  const status = await command(["status"]);
  const state = { directory, repository, repositoryId, codex, claude, home, cli, url: `http://127.0.0.1:${status.instance.port}`, version: (await coverage()).version, results };
  await writeFile(join(directory, "state.json"), JSON.stringify(state, null, 2));
  completed = true;
  console.log(JSON.stringify({ passed: results.length, ...(process.argv.includes("--keep") ? { state: join(directory, "state.json"), url: state.url } : {}) }));
} finally {
  if (!completed || !process.argv.includes("--keep")) {
    await command(["stop"]).catch(() => undefined);
    if (!process.argv.includes("--keep")) await rm(directory, { recursive: true, force: true });
    else console.log(JSON.stringify({ diagnosticDirectory: directory }));
  }
}
