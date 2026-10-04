import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { Baseline, ParsedSource } from "../src/contracts.js";
import { associateSource, discoverSources, parseSource, resolveSharedHistory } from "../src/history/index.js";
import { patchFragments, physicalLines, shellEvidence } from "../src/history/extraction.js";

const run = promisify(execFile);
const encode = (records: unknown[]) => records.map((record) => JSON.stringify(record) + "\n").join("");
const meta = (extra = {}) => ({ timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id: "synthetic-edge", cwd: "/synthetic/repo", ...extra } });
const command = (extra = {}, timestamp = "2026-01-01T00:00:01Z") => ({ timestamp, type: "event_msg", payload: { type: "item_completed", thread_id: "synthetic-edge", item: { type: "CommandExecution", id: "reused-item", command: ["/bin/zsh", "-lc", "cat src/a.ts"], cwd: "file:///synthetic/repo", status: "completed", exit_code: 0, formatted_output: "alpha\n", ...extra } } });

async function temporary(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-history-edge-"));
  try { await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("具体事件重复记录合并；item ID 复用但新时间保留新调用", async () => temporary(async (directory) => {
  const path = join(directory, "source.jsonl");
  const first = command();
  await writeFile(path, encode([meta(), first, first, command({}, "2026-01-01T00:00:02Z")]));
  const parsed = await parseSource(path, "codex");
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[0]!.sources.length, 2);
  assert.notEqual(parsed.events[0]!.id, parsed.events[1]!.id);
}));

test("CommandExecution 缺 formatted_output 不用隐藏 stdout，失败内容不进入片段", async () => temporary(async (directory) => {
  const path = join(directory, "source.jsonl");
  const missing = command({ stdout: "private full content\n", formatted_output: undefined });
  const failed = command({ exit_code: 1, formatted_output: "some output\n", status: "failed" }, "2026-01-01T00:00:02Z");
  await writeFile(path, encode([meta(), missing, failed]));
  const parsed = await parseSource(path, "codex");
  assert.equal(parsed.events[0]!.status, "success");
  assert.equal(parsed.events[0]!.fragments.length, 0);
  assert.equal(parsed.events[1]!.status, "failure");
  assert.equal(parsed.events[1]!.fragments.length, 0);
  assert.ok(parsed.gaps.some((gap) => gap.kind === "range_unknown"));
}));

test("FileChange 删除、移动和失败分别保留，不从删除邻接行制造修改", async () => temporary(async (directory) => {
  const path = join(directory, "source.jsonl");
  const change = (id: string, status: string, changes: unknown) => ({ type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", id, status, changes } } });
  await writeFile(path, encode([meta(),
    change("delete", "completed", { "/synthetic/repo/src/deleted.ts": { type: "delete" } }),
    change("move", "completed", { "/synthetic/repo/src/old.ts": { type: "update", move_path: "/synthetic/repo/src/new.ts", unified_diff: "@@ -1,1 +1,1 @@\n-old\n+new\n" } }),
    change("failed", "failed", { "/synthetic/repo/src/failed.ts": { type: "add", content: "never written\n" } }),
  ]));
  const parsed = await parseSource(path, "codex");
  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.events[0]!.kind, "edit");
  assert.equal(parsed.events[0]!.fragments.length, 0);
  assert.equal(parsed.events[1]!.path, "/synthetic/repo/src/new.ts");
  assert.ok(JSON.stringify(parsed.events[1]!.input).includes("move_path"));
  assert.equal(parsed.events[2]!.status, "failure");
  assert.equal(parsed.events[2]!.fragments.length, 0);
}));

test("direct exec_command 与 Read 结构化成功形态；请求与具体事件有唯一证据时不双算", async () => temporary(async (directory) => {
  const path = join(directory, "source.jsonl");
  const request = (name: string, id: string, input: unknown) => ({ type: "response_item", payload: { type: "function_call", name, call_id: id, arguments: JSON.stringify(input) } });
  const response = (id: string, result: unknown) => ({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: JSON.stringify(result) } });
  await writeFile(path, encode([meta(), request("exec_command", "one", { cmd: "cat src/a.ts", workdir: "/synthetic/repo" }), command(), response("one", { output: "alpha\n", exit_code: 0 }), request("Read", "two", { file_path: "/synthetic/repo/src/a.ts" }), response("two", { type: "text", file: { filePath: "/synthetic/repo/src/a.ts", content: "alpha\n", numLines: 1, startLine: 1, totalLines: 1 } })]));
  const parsed = await parseSource(path, "codex");
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[0]!.tool, "CommandExecution");
  assert.equal(parsed.events[0]!.sources.length, 3);
  assert.equal(parsed.events[1]!.status, "success");
  assert.equal(parsed.events[1]!.fragments[0]!.content, "alpha\n");
}));

test("apply_patch 成功变化与失败分开，非标准 hunk 不发明行号", async () => temporary(async (directory) => {
  const path = join(directory, "source.jsonl");
  const request = (id: string) => ({ type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: id, input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n alpha\n-beta\n+gamma\n*** End Patch" } });
  const response = (id: string, text: string) => ({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: text } });
  await writeFile(path, encode([meta(), request("success"), response("success", "Success. Updated the following files:\nM src/a.ts\n"), request("failed"), response("failed", "Exit code: 1\nOutput:\nFailed to locate lines\n")]));
  const parsed = await parseSource(path, "codex");
  assert.equal(parsed.events[0]!.status, "success");
  assert.deepEqual(parsed.events[0]!.fragments.filter((fragment) => fragment.kind === "added").map((fragment) => fragment.content), ["gamma\n"]);
  assert.equal(parsed.events[0]!.fragments[0]!.historicalStart, undefined);
  assert.equal(parsed.events[1]!.status, "failure");
  assert.equal(parsed.events[1]!.fragments.length, 0);
}));

test("Claude 后台接收、持久化输出、未确认覆盖写入不冒充成功读取", async () => temporary(async (directory) => {
  const path = join(directory, "source.jsonl");
  const use = (id: string, name: string, input: unknown) => ({ type: "assistant", uuid: `request-${id}`, sessionId: "synthetic-claude-edge", cwd: "/synthetic/repo", message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (id: string, content: string, structured: unknown) => ({ type: "user", uuid: `result-${id}`, sourceToolAssistantUUID: `request-${id}`, sessionId: "synthetic-claude-edge", cwd: "/synthetic/repo", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] }, toolUseResult: structured });
  await writeFile(path, encode([
    use("background", "Bash", { command: "cat src/a.ts" }), result("background", "Task started", { backgroundTaskId: "synthetic-background", stdout: "", stderr: "" }),
    use("persisted", "Bash", { command: "cat src/a.ts" }), result("persisted", "<persisted-output>\npreview only\n</persisted-output>", { stdout: "full hidden source\n", persistedOutputPath: "/synthetic/tool-results/output" }),
    use("overwrite", "Write", { file_path: "/synthetic/repo/src/a.ts", content: "alpha\n" }), result("overwrite", "Written", {}),
  ]));
  const parsed = await parseSource(path, "claude");
  assert.equal(parsed.events[0]!.status, "unknown");
  assert.equal(parsed.events[0]!.fragments.length, 0);
  assert.equal(parsed.events[1]!.fragments.length, 0);
  assert.ok(!JSON.stringify(parsed.events[1]!.fragments).includes("full hidden"));
  assert.equal(parsed.events[2]!.fragments.length, 0);
  assert.ok(parsed.gaps.some((gap) => gap.kind === "unpaired_call"));
}));

test("Claude 子 agent 来源与父来源关系保存，父摘要不产生子调用", async () => temporary(async (directory) => {
  const path = join(directory, "agent-synthetic.jsonl");
  await writeFile(path, encode([{ type: "assistant", sessionId: "parent-session", agentId: "child-id", isSidechain: true, uuid: "child-request", cwd: "/synthetic/repo", message: { content: [{ type: "tool_use", id: "child-read", name: "Read", input: { file_path: "/synthetic/repo/src/a.ts" } }] } }]));
  const parsed = await parseSource(path, "claude");
  assert.equal(parsed.sessionId, "parent-session/agent/child-id");
  assert.equal(parsed.parentSessionId, "parent-session");
  assert.equal(parsed.relationships[0]!.kind, "subagent");
  assert.equal(resolveSharedHistory([parsed]).events.length, 1);
  assert.equal(resolveSharedHistory([parsed]).gaps[0]!.kind, "source_missing");
}));

test("空白读取与变化行按物理行保留，不把上下文计入新增", () => {
  const evidence = shellEvidence("nl -ba src/a.ts", "1\t\n2\talpha\n")[0]!;
  assert.equal(physicalLines(evidence.fragments[0]!.content).length, 2);
  const fragments = patchFragments([" context", "+", "+new", "-old"], 5, 5);
  assert.equal(fragments.find((fragment) => fragment.kind === "added")!.content, "\nnew\n");
  assert.equal(fragments.find((fragment) => fragment.kind === "added")!.historicalStart, 6);
  assert.equal(fragments.find((fragment) => fragment.kind === "deleted")!.historicalStart, 6);
  assert.equal(fragments.filter((fragment) => fragment.kind === "context").length, 1);
});

test("已知非工具状态记录不制造格式缺口，未知顶层记录显示具体类型", async () => temporary(async (directory) => {
  const path = join(directory, "metadata.jsonl");
  await writeFile(path, encode([meta(),
    { type: "token_usage_record", payload: {} },
    { type: "world_state", payload: {} },
    { type: "inter_agent_communication_metadata", payload: {} },
    { type: "synthetic-unsupported", payload: {} },
    command(),
  ]));
  const parsed = await parseSource(path, "codex");
  const gaps = parsed.gaps.filter(gap => gap.kind === "unsupported_format");
  assert.equal(gaps.length, 1);
  assert.match(gaps[0]!.message, /物理记录 5.*synthetic-unsupported/);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0]!.fragments[0]!.content, "alpha\n");
}));

test("固定范围多段 sed 完整返回时按顺序切分，缺行或截断不猜边界", async () => temporary(async (directory) => {
  const path = join(directory, "bundle.jsonl");
  const script = "sed -n '1,2p' tests/history.test.ts\nsed -n '7p' tests/history.test.ts\nsed -n '3,4p' src/history/index.ts";
  const invocation = `/bin/zsh -lc "${script}"`;
  await writeFile(path, encode([meta(), command({ command: ["/bin/zsh", "-lc", invocation], formatted_output: "one\ntwo\nseven\nthree\nfour\n" })]));
  const parsed = await parseSource(path, "codex");
  assert.equal(parsed.events.length, 3);
  assert.deepEqual(parsed.events.map(event => [event.path, event.fragments[0]!.historicalStart, event.fragments[0]!.content]), [
    ["tests/history.test.ts", 1, "one\ntwo\n"],
    ["tests/history.test.ts", 7, "seven\n"],
    ["src/history/index.ts", 3, "three\nfour\n"],
  ]);
  for (const output of ["one\ntwo\nseven\nthree\n", "one\ntwo\n...20 tokens truncated...\nthree\nfour\n"]) {
    const evidence = shellEvidence(invocation, output);
    assert.ok(evidence.every(part => part.fragments.length === 0));
    assert.ok(evidence.every(part => part.reason?.startsWith("range_unknown:")));
  }
  assert.equal(shellEvidence("sed -n '1,2p' a.ts\ncat b.ts", "one\ntwo\nthree\n")[0]!.kind, "other");
  assert.equal(shellEvidence("/bin/zsh -lc 'cat a.ts && cat b.ts'", "one\ntwo\n")[0]!.kind, "other");
  await writeFile(path, encode([meta(),
    { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "bundle", arguments: JSON.stringify({ cmd: invocation, workdir: "/synthetic/repo" }) } },
    command({ command: ["/bin/zsh", "-lc", invocation], formatted_output: "one\ntwo\nseven\nthree\nfour\n" }),
    { type: "response_item", payload: { type: "function_call_output", call_id: "bundle", output: JSON.stringify({ output: "one\ntwo\nseven\nthree\nfour\n", exit_code: 0 }) } },
  ]));
  const paired = await parseSource(path, "codex");
  assert.equal(paired.events.length, 3);
  assert.ok(paired.events.every(event => event.tool === "CommandExecution" && event.sources.length === 3));
}));

test("发现嵌套归档、缺失默认根不报错，未知记录保留 unsupported_format", async () => temporary(async (directory) => {
  await mkdir(join(directory, "archived"));
  await mkdir(join(directory, "active", "year"), { recursive: true });
  await writeFile(join(directory, "archived", "old.jsonl"), encode([meta()]));
  await writeFile(join(directory, "active", "year", "new.jsonl"), encode([meta(), { type: "synthetic-unsupported" }]));
  const found = await discoverSources({ codex: [join(directory, "archived"), join(directory, "active"), join(directory, "missing")], claude: [] });
  assert.equal(found.length, 2);
  const parsed = await parseSource(join(directory, "active", "year", "new.jsonl"), "codex");
  assert.ok(parsed.gaps.some((gap) => gap.kind === "unsupported_format"));
}));

test("Git commonDir 证明 worktree 归属，相同 remote 的独立 clone 不关联", async () => temporary(async (directory) => {
  const repository = join(directory, "repo");
  const worktree = join(directory, "worktree");
  const independent = join(directory, "independent");
  await mkdir(repository);
  await run("git", ["init", repository]);
  await writeFile(join(repository, "a.ts"), "alpha\n");
  await run("git", ["-C", repository, "add", "a.ts"]);
  await run("git", ["-C", repository, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-m", "synthetic baseline"]);
  await run("git", ["-C", repository, "worktree", "add", "--detach", worktree]);
  await run("git", ["clone", repository, independent]);
  const commonDir = (await run("git", ["-C", repository, "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  const baseline: Baseline = { repository: { id: "synthetic-git", path: repository, commonDir, name: "synthetic", stale: false }, hash: "baseline", createdAt: "2026-01-01T00:00:00Z", git: { dirty: false }, excluded: [], files: [{ path: "a.ts", category: "source", content: "alpha\n", hash: "file", lineCount: 1 }] };
  const fixturePath = new URL("./fixtures/history/codex-modern.jsonl", import.meta.url).pathname;
  const source = await parseSource(fixturePath, "codex");
  source.cwd = worktree;
  source.events = [{ ...source.events[0]!, cwd: worktree, path: join(worktree, "a.ts") }];
  const linked = await associateSource(source, baseline);
  assert.equal(linked.associated, true);
  assert.equal(linked.events[0]!.path, "a.ts");
  source.cwd = independent;
  source.events = [{ ...source.events[0]!, cwd: independent, path: join(independent, "a.ts") }];
  assert.equal((await associateSource(source, baseline)).associated, false);
}));

test("规则升级重建而非续读；重叠来源中成功结果补强待配对事件", async () => temporary(async (directory) => {
  const path = join(directory, "source.jsonl");
  const rows = (await readFile(new URL("./fixtures/history/codex-legacy.jsonl", import.meta.url), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  await writeFile(path, encode(rows.slice(0, 2)));
  const pending = await parseSource(path, "codex");
  await writeFile(path, encode(rows));
  const upgraded = JSON.parse(JSON.stringify(pending)) as ParsedSource;
  (upgraded.cursor as { ruleVersion: string }).ruleVersion = "obsolete";
  const complete = await parseSource(path, "codex", upgraded);
  assert.equal((complete.cursor as { parsedRecords: number }).parsedRecords, 3);
  const merged = resolveSharedHistory([pending, complete]);
  assert.equal(merged.events.length, 1);
  assert.equal(merged.events[0]!.status, "success");
  assert.equal(merged.events[0]!.fragments.length, 1);
}));

test("fork 只有同文本弱身份时保留新调用并列歧义，不能凭 callId 文本去重", async () => temporary(async (directory) => {
  const request = { type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "reused", arguments: JSON.stringify({ command: "cat src/a.ts" }) } };
  const response = { type: "response_item", payload: { type: "function_call_output", call_id: "reused", output: "Exit code: 0\nOutput:\nalpha\n" } };
  const parentPath = join(directory, "parent.jsonl");
  const childPath = join(directory, "child.jsonl");
  const parentRaw = encode([meta({ id: "parent" }), request, response]);
  await writeFile(parentPath, parentRaw);
  await writeFile(childPath, encode([meta({ id: "child", history_base: { thread_id: "parent", end_byte_offset: Buffer.byteLength(parentRaw) } }), request, response]));
  const result = resolveSharedHistory([await parseSource(parentPath, "codex"), await parseSource(childPath, "codex")]);
  assert.equal(result.events.length, 2);
  assert.ok(result.gaps.some((gap) => gap.kind === "ambiguous"));
}));
