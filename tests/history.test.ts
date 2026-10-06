import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Baseline, HistoryEvent, ParsedSource } from "../src/contracts.js";
import { associateSource, discoverSources, historicalWorktrees, normalizeHistoryPath, parseSource, resolveSharedHistory } from "../src/history/index.js";
import { returnedText, shellEvidence } from "../src/history/extraction.js";
import { PARSER_RULE_VERSION } from "../src/version.js";

const fixture = (name: string) => new URL(`./fixtures/history/${name}`, import.meta.url).pathname;
const meta = (id = "synthetic-session", extra = {}) => ({ timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id, cwd: "/synthetic/repo", ...extra } });
const call = (id: string, command = "cat src/a.ts", extra = {}) => ({ type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: id, arguments: JSON.stringify({ command, workdir: "/synthetic/repo" }), ...extra } });
const output = (id: string, content = "alpha\nbeta\n", code = 0) => ({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: `Exit code: ${code}\nOutput:\n${content}` } });
const encode = (records: unknown[]) => records.map((record) => JSON.stringify(record) + "\n").join("");

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-history-test-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("Claude 同会话后续 cwd 补齐发现和来源，metadata-only 会话自动关联", async () => temporary(async (directory) => {
  const path = join(directory, "metadata.jsonl");
  await writeFile(path, encode([
    { type: "file-history-snapshot", sessionId: "metadata-session" },
    { type: "user", sessionId: "different-session", cwd: "/synthetic/other" },
    { type: "user", sessionId: "metadata-session", cwd: directory },
    { type: "user", sessionId: "metadata-session", cwd: "/synthetic/later" },
  ]));
  const [discovered] = await discoverSources({ codex: [], claude: [directory], codeflicker: [], "codeflicker-desktop": [] });
  assert.equal(discovered!.cwd, directory);
  const parsed = await parseSource(path, "claude");
  assert.equal(parsed.cwd, directory);
  assert.equal(parsed.events.length, 0);
  assert.equal((parsed.cursor as { cwd: string }).cwd, "/synthetic/later");
  const repository = { id: "metadata", path: directory, commonDir: directory, name: "metadata", stale: false };
  const baseline: Baseline = { repository, hash: "metadata", createdAt: "2026-01-01T00:00:00Z", git: { dirty: false }, files: [], excluded: [] };
  assert.equal((await associateSource(parsed, baseline)).associated, true);
}));

test("Claude 规则升级重建旧空 cwd 游标，来源首个 cwd 不覆盖逐事件 cwd", async () => temporary(async (directory) => {
  const path = join(directory, "metadata.jsonl");
  await writeFile(path, encode([
    { type: "file-history-snapshot", sessionId: "metadata-session" },
    { type: "user", sessionId: "metadata-session", cwd: directory },
    { type: "assistant", sessionId: "metadata-session", cwd: "/synthetic/later", uuid: "later-request", message: { content: [{ type: "tool_use", id: "later", name: "Read", input: { file_path: "later.ts" } }] } },
  ]));
  const previous = JSON.parse(JSON.stringify(await parseSource(path, "claude"))) as ParsedSource;
  previous.cwd = undefined;
  (previous.cursor as { ruleVersion: string }).ruleVersion = "2";
  const parsed = await parseSource(path, "claude", previous);
  assert.equal(PARSER_RULE_VERSION, "9");
  assert.equal((parsed.cursor as { parsedRecords: number }).parsedRecords, 3);
  assert.equal(parsed.cwd, directory);
  assert.equal(parsed.events[0]!.cwd, "/synthetic/later");
  assert.equal(parsed.sourceId, previous.sourceId);
  const repository = { id: "metadata", path: directory, commonDir: directory, name: "metadata", stale: false };
  const baseline: Baseline = { repository, hash: "metadata", createdAt: "2026-01-01T00:00:00Z", git: { dirty: false }, files: [], excluded: [] };
  assert.equal((await associateSource(parsed, baseline)).associated, true);
}));

test("新版具体命令与 FileChange 优先，wrapper 不双算，重复文本的新调用保留", async () => {
  const parsed = await parseSource(fixture("codex-modern.jsonl"), "codex");
  assert.equal(parsed.events.length, 5);
  assert.equal(parsed.events.filter((event) => event.kind === "read").length, 2);
  assert.notEqual(parsed.events[0]!.id, parsed.events[1]!.id);
  assert.equal(parsed.events[0]!.cwd, "/synthetic/repo");
  assert.equal(parsed.events[0]!.fragments[0]!.content, "alpha\nbeta\n");
  assert.ok(!JSON.stringify(parsed.events).includes("hidden not returned"));
  assert.ok(parsed.events[0]!.sources.length >= 3);
  assert.equal(parsed.events[2]!.kind, "search");
  assert.equal(parsed.events[2]!.status, "failure");
  assert.deepEqual(parsed.events[3]!.fragments.filter((fragment) => fragment.kind === "added").map((fragment) => fragment.content), ["gamma\n"]);
  assert.deepEqual(parsed.events[3]!.fragments.filter((fragment) => fragment.kind === "deleted").map((fragment) => fragment.content), ["beta\n"]);
  assert.equal(parsed.events[3]!.fragments.find((fragment) => fragment.kind === "added")!.historicalStart, 2);
  assert.equal(parsed.events[4]!.path, "/synthetic/repo/src/new.ts");
});

test("Claude Read 取实际范围，Edit 只保留变化，纯删除和覆盖 Write 分开", async () => {
  const parsed = await parseSource(fixture("claude-tools.jsonl"), "claude");
  assert.equal(parsed.events.length, 5);
  const [read, edit, deletion, overwrite, failure] = parsed.events;
  assert.equal(read!.status, "success");
  assert.equal(read!.fragments[0]!.historicalStart, 2);
  assert.equal(read!.fragments[0]!.content, "beta\ngamma\n");
  assert.equal(edit!.fragments.filter((fragment) => fragment.kind === "added")[0]!.content, "delta\n");
  assert.equal(deletion!.status, "success");
  assert.equal(deletion!.fragments.filter((fragment) => fragment.kind === "added").length, 0);
  assert.deepEqual(overwrite!.fragments.filter((fragment) => fragment.kind === "added").map((fragment) => fragment.content), ["delta\n"]);
  assert.equal(failure!.status, "failure");
  assert.equal(failure!.fragments.length, 0);
  assert.notEqual(read!.id, edit!.id);
});

test("旧版 shell_command 结果头与实际返回范围", async () => {
  const parsed = await parseSource(fixture("codex-legacy.jsonl"), "codex");
  assert.equal(parsed.events[0]!.status, "success");
  assert.equal(parsed.events[0]!.fragments[0]!.historicalStart, 2);
  assert.equal(parsed.events[0]!.fragments[0]!.content, "beta\ngamma\n");
});

test("完整字节边界、真正续读、跨轮配对、不完整 Unicode 尾部", async () => temporary(async (directory) => {
  const path = join(directory, "source.jsonl");
  const prefix = encode([meta(), call("pending")]);
  const final = encode([output("pending", "你好\n")]);
  const bytes = Buffer.from(final);
  const split = bytes.indexOf(Buffer.from("你好")) + 2;
  await writeFile(path, Buffer.concat([Buffer.from(prefix), bytes.subarray(0, split)]));
  const first = await parseSource(path, "codex");
  assert.equal(first.completeBytes, Buffer.byteLength(prefix));
  assert.equal(first.events[0]!.status, "unknown");
  assert.ok(first.gaps.some((gap) => gap.kind === "incomplete_record"));
  const saved = JSON.parse(JSON.stringify(first)) as ParsedSource;
  await appendFile(path, bytes.subarray(split));
  const second = await parseSource(path, "codex", saved);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0]!.status, "success");
  assert.equal(second.events[0]!.fragments[0]!.content, "你好\n");
  assert.equal((second.cursor as { parsedRecords: number }).parsedRecords, 1);
  assert.ok(!second.gaps.some((gap) => gap.kind === "unpaired_call" || gap.kind === "incomplete_record"));
  assert.equal(first.events[0]!.status, "unknown");
  const third = await parseSource(path, "codex", second);
  assert.equal((third.cursor as { parsedRecords: number }).parsedRecords, 0);
  assert.deepEqual(third.events, second.events);
}));

test("来源移动保留 sourceId/eventId；替换与截断重建失效调用", async () => temporary(async (directory) => {
  const path = join(directory, "source.jsonl");
  const moved = join(directory, "archived.jsonl");
  await writeFile(path, encode([meta(), call("old"), output("old")]));
  const first = await parseSource(path, "codex");
  await rename(path, moved);
  const second = await parseSource(moved, "codex", first);
  assert.equal(second.sourceId, first.sourceId);
  assert.equal(second.events[0]!.id, first.events[0]!.id);
  assert.equal(second.events[0]!.sources[0]!.path, moved);
  await writeFile(moved, encode([meta(), call("replacement", "cat src/b.ts"), output("replacement", "changed\n")]));
  const replacement = await parseSource(moved, "codex", second);
  assert.equal(replacement.events.length, 1);
  assert.equal(replacement.events[0]!.path, "src/b.ts");
  await writeFile(moved, encode([meta()]));
  const truncated = await parseSource(moved, "codex", replacement);
  assert.equal(truncated.events.length, 0);
}));

test("调用 ID 重用按出现位置保留；同时未配对重用保留歧义", async () => temporary(async (directory) => {
  const path = join(directory, "source.jsonl");
  await writeFile(path, encode([meta(), call("same"), output("same"), call("same"), output("same")]));
  const parsed = await parseSource(path, "codex");
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events.filter((event) => event.status === "success").length, 2);
  assert.notEqual(parsed.events[0]!.id, parsed.events[1]!.id);
  await writeFile(path, encode([meta(), call("same"), call("same"), output("same")]));
  const ambiguous = await parseSource(path, "codex");
  assert.equal(ambiguous.events.filter((event) => event.status === "success").length, 0);
  assert.ok(ambiguous.gaps.some((gap) => gap.kind === "ambiguous"));
}));

test("重复 Claude uuid 只合并已证明的记录，sourceToolAssistantUUID 解开 ID 重用", async () => temporary(async (directory) => {
  const path = join(directory, "source.jsonl");
  const rows = (await readFile(fixture("claude-tools.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  await writeFile(path, encode([rows[0], rows[0], rows[1], rows[1], rows[2], rows[3]]));
  const parsed = await parseSource(path, "claude");
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[0]!.sources.length, 4);
  assert.equal(parsed.events[1]!.status, "success");
}));

test("fork 引用只使用完整父字节边界，复制有证明才去重，缺父源列缺口", async () => temporary(async (directory) => {
  const parentPath = join(directory, "parent.jsonl");
  const childPath = join(directory, "child.jsonl");
  const originalCalls = [call("first", "cat src/a.ts", { id: "shared-response-id" }), output("first")];
  const parentRaw = encode([meta("parent"), ...originalCalls]);
  await writeFile(parentPath, parentRaw);
  const childMeta = meta("child", { forked_from_id: "parent", history_base: { thread_id: "parent", end_byte_offset: Buffer.byteLength(parentRaw), end_ordinal_exclusive: 999 } });
  await writeFile(childPath, encode([childMeta]));
  const parent = await parseSource(parentPath, "codex");
  const referenceOnly = await parseSource(childPath, "codex");
  assert.equal(resolveSharedHistory([parent, referenceOnly]).events.length, 1);
  assert.equal(resolveSharedHistory([referenceOnly]).gaps[0]!.kind, "source_missing");
  await writeFile(childPath, encode([childMeta, ...originalCalls, call("second"), output("second")]));
  const copied = await parseSource(childPath, "codex");
  const merged = resolveSharedHistory([parent, copied]);
  assert.equal(merged.events.length, 2);
  assert.equal(merged.events[0]!.sources.length, 4);
  assert.equal(merged.relationships[0]!.resolved, true);
  copied.relationships[0]!.endByteOffset! -= 1;
  assert.ok(resolveSharedHistory([parent, copied]).gaps.some((gap) => gap.kind === "ambiguous"));
}));

test("Codex 子来源的继承字段和复制父头部不改变身份，明确共享边界仍可去重", async () => temporary(async (directory) => {
  const parentPath = join(directory, "parent.jsonl");
  const childPath = join(directory, "child.jsonl");
  const parentRaw = encode([meta("parent"), call("shared", "cat src/a.ts", { id: "shared-request" }), output("shared")]);
  await writeFile(parentPath, parentRaw);
  const childHeader = meta("child", { forked_from_id: "parent", subagent_history_start_ordinal: 5,
    source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } });
  await writeFile(childPath, encode([childHeader, meta("parent"), call("own"), output("own")]));
  const child = await parseSource(childPath, "codex");
  assert.equal(child.sessionId, "child");
  assert.equal(child.parentSessionId, "parent");
  assert.equal(child.relationships[0]!.kind, "subagent");
  const parent = await parseSource(parentPath, "codex");
  assert.equal(resolveSharedHistory([parent, child]).gaps.length, 0);
  const sharedHeader = meta("child", { ...childHeader.payload,
    history_base: { thread_id: "parent", end_byte_offset: Buffer.byteLength(parentRaw), end_ordinal_exclusive: 5 } });
  await writeFile(childPath, encode([sharedHeader, meta("parent"), call("shared", "cat src/a.ts", { id: "shared-request" }), output("shared"), call("own"), output("own")]));
  const shared = await parseSource(childPath, "codex");
  assert.equal(shared.relationships[0]!.kind, "subagent");
  assert.equal(resolveSharedHistory([parent, shared]).events.length, 2);
}));

test("无 fork 来源证明的相同请求和结果不会跨来源合并", async () => temporary(async (directory) => {
  const firstPath = join(directory, "one.jsonl");
  const secondPath = join(directory, "two.jsonl");
  await writeFile(firstPath, encode([meta("one"), call("same"), output("same")]));
  await writeFile(secondPath, encode([meta("two"), call("same"), output("same")]));
  assert.equal(resolveSharedHistory([await parseSource(firstPath, "codex"), await parseSource(secondPath, "codex")]).events.length, 2);
}));

test("读取源文件只读，发现嵌套与归档目录，头部候选含 cwd", async () => temporary(async (directory) => {
  await writeFile(join(directory, "source.jsonl"), encode([meta()]));
  await writeFile(join(directory, "ignore.txt"), "not a source");
  const sources = await discoverSources({ codex: directory, claude: [], codeflicker: [], "codeflicker-desktop": [] });
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.cwd, "/synthetic/repo");
  assert.equal(sources[0]!.sessionId, "synthetic-session");
  const original = await readFile(sources[0]!.path);
  await parseSource(sources[0]!.path, "codex");
  assert.deepEqual(await readFile(sources[0]!.path), original);
}));

test("会话 cwd 不把外部工具路径归给仓库；URI 规范化并拒绝非本机 URI", async () => {
  const source = await parseSource(fixture("codex-modern.jsonl"), "codex");
  source.events.push({ ...source.events[0]!, id: "external", path: "/synthetic/other/private.ts" });
  const baseline: Baseline = { repository: { id: "repo", path: "/synthetic/repo", commonDir: "/synthetic/repo/.git", name: "repo", stale: false }, hash: "base", createdAt: "2026-01-01T00:00:00Z", git: { dirty: false }, excluded: [], files: [{ path: "src/a.ts", content: "alpha\nbeta\n", hash: "file", category: "source", lineCount: 2 }] };
  const association = await associateSource(source, baseline);
  assert.equal(association.associated, true);
  assert.equal(association.events.filter((event) => event.id === "external").length, 0);
  assert.equal(association.events[0]!.path, "src/a.ts");
  assert.equal(normalizeHistoryPath("file:///synthetic/repo/a%20b.ts"), "/synthetic/repo/a b.ts");
  assert.equal(normalizeHistoryPath("file://remotehost/repo"), undefined);
});

test("历史 worktree 创建与清单交叉确认，只关联已确认时间内的活动", async () => temporary(async directory => {
  const root = join(directory, "repo");
  const worktree = join(directory, "old-worktree");
  const nested = join(directory, "child-worktree");
  const baseline: Baseline = { repository: { id: "repo", path: root, commonDir: join(root, ".git"), name: "repo", stale: false },
    hash: "base", createdAt: "2026-01-01T00:00:00Z", git: { dirty: false }, excluded: [], files: [{ path: "src/a.ts", content: "alpha\n", hash: "file", category: "source", lineCount: 1 }] };
  const source = await parseSource(fixture("codex-modern.jsonl"), "codex");
  const command = (id: string, cmd: string, content: string, seconds: number, cwd = root): HistoryEvent => ({ ...source.events[0]!, id,
    tool: "CommandExecution", kind: "other", path: undefined, fragments: [], cwd, status: "success",
    occurredAt: `2026-01-01T00:00:0${seconds}Z`, input: { command: ["/bin/sh", "-c", cmd] }, output: { formatted_output: content } });
  const created = command("created", `mkdir -p '${join(directory, "notes")}' && git worktree add '${worktree}' -b first`,
    "Preparing worktree (new branch 'first')\nHEAD is now at abc123 fixture\n", 2);
  const child = command("child", `git worktree add -b second '${nested}'`, "Preparing worktree (new branch 'second')\nHEAD is now at abc123 fixture\n", 3, worktree);
  const porcelain = (paths: string[]) => paths.map(path => `worktree ${path}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/main\n\n`).join("");
  const listed = command("listed", "git worktree list --porcelain", porcelain([root, worktree, nested]), 5);
  const trees = await historicalWorktrees([listed, child, created], baseline);
  assert.equal(trees.length, 2);
  const read = { ...source.events[0]!, cwd: root, path: join(worktree, "src/a.ts"), occurredAt: "2026-01-01T00:00:04Z" };
  const associated = await associateSource({ ...source, cwd: root, events: [read] }, baseline, trees);
  assert.equal(associated.events[0]!.path, "src/a.ts");
  assert.deepEqual(associated.events[0]!.fragments, read.fragments.map(fragment => ({ ...fragment, path: "src/a.ts" })));
  for (const time of ["2026-01-01T00:00:01Z", "2026-01-01T00:00:06Z", undefined]) {
    assert.equal((await associateSource({ ...source, events: [{ ...read, occurredAt: time }] }, baseline, trees)).events.length, 0);
  }
  for (const [create, list] of [
    [{ ...created, status: "failure" }, listed], [created, { ...listed, status: "failure" }],
    [{ ...created, output: { formatted_output: "HEAD is now at abc123 fixture\n" } }, listed],
    [created, { ...listed, output: { formatted_output: "Warning: truncated output\n" + porcelain([root, worktree]) } }],
    [created, { ...listed, output: { formatted_output: porcelain([join(directory, "other-repo"), worktree]) } }],
    [created, { ...listed, input: { command: ["/bin/sh", "-c", "cat note && git worktree list --porcelain"] } }],
    [created, { ...listed, input: { command: ["python", "-c", "git worktree list --porcelain"] } }],
  ] as [HistoryEvent, HistoryEvent][]) assert.equal((await historicalWorktrees([create, list], baseline)).length, 0);
  await promisify(execFile)("git", ["init", "--quiet", worktree]);
  assert.equal((await historicalWorktrees([created, listed], baseline)).length, 0, "路径被独立仓库占用时不合并");
}));

test("Read 结构化内容行数或显示文本不一致不产生主要覆盖片段", async () => temporary(async (directory) => {
  const path = join(directory, "bad-read.jsonl");
  const rows = (await readFile(fixture("claude-tools.jsonl"), "utf8")).trim().split("\n").slice(0, 2).map((line) => JSON.parse(line));
  rows[1].toolUseResult.file.numLines = 100;
  await writeFile(path, encode(rows));
  const parsed = await parseSource(path, "claude");
  assert.equal(parsed.events[0]!.status, "success");
  assert.equal(parsed.events[0]!.fragments.length, 0);
  assert.ok(parsed.gaps.some((gap) => gap.kind === "range_unknown"));
  rows[1].toolUseResult.file.numLines = 2;
  rows[1].message.content[0].content = "2\twrong\n3\tgamma\n";
  await writeFile(path, encode(rows));
  assert.equal((await parseSource(path, "claude")).events[0]!.fragments.length, 0);
}));

test("Shell 安全矩阵支持范围且复杂组合未知，搜索不入读取", () => {
  for (const [command, output, start] of [
    ["cat src/a.ts", "alpha\n", 1], ["sed -n '2,3p' src/a.ts", "beta\ngamma\n", 2],
    ["head -n 2 src/a.ts", "alpha\nbeta\n", 1], ["head -2 src/a.ts", "alpha\nbeta\n", 1],
    ["tail -n +3 src/a.ts", "gamma\n", 3], ["tail -2 src/a.ts", "beta\ngamma\n", undefined],
    ["nl -ba src/a.ts | sed -n '2,3p'", "2\tbeta\n3\tgamma\n", 2],
  ] as const) assert.equal(shellEvidence(command, output)[0]!.fragments[0]!.historicalStart, start, command);
  assert.equal(shellEvidence("cat a.ts b.ts", "alpha\nbeta\n").length, 2);
  assert.equal(shellEvidence("cat a.ts b.ts", "alpha\nbeta\n")[0]!.fragments.length, 0);
  for (const command of ["cat a.ts && cat b.ts", "cat a.ts; cat b.ts", "cat $FILE", "cat a.ts > out", "head -c 10 a.ts", "nl a.ts", "python read.py"]) assert.ok(shellEvidence(command, "alpha\n")[0]!.reason?.startsWith("unsupported_tool:"), command);
  assert.equal(shellEvidence("rg -n alpha src/a.ts", "1:alpha\n")[0]!.kind, "search");
  assert.equal(shellEvidence("rg --files", "src/a.ts\n")[0]!.kind, "other");
  assert.equal(shellEvidence("head -n 1 src/a.ts", "one\ntwo\n")[0]!.fragments.length, 0);
});

test("截断标记保留完整前缀；源码普通 truncated 字样不误判", () => {
  assert.deepEqual(returnedText("const truncated = false;\n"), { content: "const truncated = false;\n", truncated: false });
  assert.deepEqual(returnedText("alpha\npartial…12 tokens truncated…tail"), { content: "alpha\n", truncated: true });
  assert.deepEqual(returnedText("Chunk ID: x\nWarning: truncated output (original token count: 10)\nFinal output:\nuncertain\n"), { content: "", truncated: true });
  assert.equal(returnedText("<persisted-output>\npreview\n</persisted-output>").content, "");
});

test("坏行、无终态结果和未知 exec 包装保留缺口，不伪造读取", async () => temporary(async (directory) => {
  const path = join(directory, "source.jsonl");
  await writeFile(path, encode([meta(), call("unknown")]) + "{bad json}\n" + encode([{ type: "response_item", payload: { type: "function_call_output", call_id: "unknown", output: "alpha\n" } }, { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "wrapper", input: "for (const c of stored) text(await run(c));" } }, { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "wrapper", output: "Script completed\n" } }]));
  const parsed = await parseSource(path, "codex");
  assert.ok(parsed.gaps.some((gap) => gap.kind === "parse_error"));
  assert.ok(parsed.gaps.some((gap) => gap.kind === "unsupported_tool"));
  assert.equal(parsed.events[0]!.status, "unknown");
  assert.equal(parsed.events[0]!.fragments.length, 0);
}));
