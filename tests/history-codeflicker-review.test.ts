import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Baseline, HistoryEvent } from "../src/contracts.js";
import { buildCoverage, matchEvent } from "../src/analysis/index.js";
import { associateSource, parseSource, resolveSharedHistory } from "../src/history/index.js";
import { readHistoryEvidence } from "../src/history/adapters/index.js";

const fixture = (name: string) => new URL(`./fixtures/history/${name}`, import.meta.url).pathname;
const encode = (records: unknown[]) => records.map(record => `${JSON.stringify(record)}\n`).join("");
const message = (uuid: string, role: string, content: unknown[], extra = {}) => ({ type: "message", sessionId: "synthetic-review", uuid, role, content, ...extra });
const call = (id: string, name: string, input: unknown) => message(id, "assistant", [{ type: "tool_use", id, name, input }]);
const result = (id: string, name: string, value: unknown) => message(`result-${id}`, "tool", [{ type: "tool-result", toolCallId: id, toolName: name, result: value }]);

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-codeflicker-review-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function baseline(directory: string, content: string): Baseline {
  return { repository: { id: "synthetic", path: directory, commonDir: directory, name: "synthetic", stale: false },
    hash: "synthetic", createdAt: "2026-01-01T00:00:00Z", git: { dirty: false },
    files: [{ path: "a.ts", category: "source", lineCount: content.split("\n").length - Number(content.endsWith("\n")), hash: "synthetic", content }], excluded: [] };
}

function coverage(base: Baseline, events: HistoryEvent[]) {
  const mappings = events.map(event => matchEvent(event, base.files[0]!));
  return { mappings, value: buildCoverage({ repository: base.repository, version: "synthetic", baseline: base, sources: [], events, mappings, gaps: [], createdAt: base.createdAt }) };
}

test("read 隐藏长行截断不形成近似覆盖，完整前后行保持真实范围", async () => temporary(async directory => {
  const path = join(directory, "session.jsonl");
  const file = join(directory, "a.ts");
  const prefix = ("const veryLongSource = \"" + "abcdefghijklmno".repeat(140)).slice(0, 2000);
  const source = `const stableBefore = 1;\n${prefix}TAIL!\nconst stableAfter = 2;\n`;
  const observed = `const stableBefore = 1;\n${prefix}...\nconst stableAfter = 2;\n`;
  const payload = { type: "text", filePath: file, content: observed, offset: 1, totalLines: 4, limit: 2000, actualLinesRead: 4 };
  await writeFile(path, encode([call("read", "read", { file_path: file }), result("read", "read", { llmContent: JSON.stringify(payload), truncated: false })]));
  const parsed = await parseSource(path, "codeflicker");
  assert.deepEqual(parsed.events[0]!.fragments.map(fragment => [fragment.historicalStart, fragment.content]), [[1, "const stableBefore = 1;\n"], [3, "const stableAfter = 2;\n"]]);
  assert.ok(parsed.gaps.some(gap => gap.kind === "range_unknown" && gap.message.includes("隐藏截断")));
  const base = baseline(directory, source);
  const associated = await associateSource(parsed, base);
  const checked = coverage(base, associated.events);
  assert.deepEqual(checked.mappings[0]!.exactRanges, [{ start: 1, end: 1 }, { start: 3, end: 3 }]);
  assert.deepEqual(checked.mappings[0]!.nearRanges, []);
  assert.equal(checked.value.files[0]!.readExactLines, 2);
  assert.equal(checked.value.files[0]!.readNearLines, 0);
  // 同形态天然源码也保守处理，不通过当前文件补齐历史返回。
  const natural = coverage(baseline(directory, observed), associated.events);
  assert.equal(natural.value.files[0]!.readExactLines, 2);
  const previous = structuredClone(parsed);
  (previous.cursor as { ruleVersion: string }).ruleVersion = "6";
  previous.events[0]!.fragments = [{ kind: "read", content: observed, historicalStart: 1, completeLines: true, path: file }];
  const rebuilt = await parseSource(path, "codeflicker", previous);
  assert.equal((rebuilt.cursor as { ruleVersion: string }).ruleVersion, "7");
  assert.equal((rebuilt.cursor as { parsedRecords: number }).parsedRecords, 2);
  assert.deepEqual(rebuilt.events[0]!.fragments, parsed.events[0]!.fragments);
}));

test("仅截断长行的读取无精确或近似对应；局部 offset 后完整行保留位置", async () => temporary(async directory => {
  const path = join(directory, "session.jsonl");
  const file = join(directory, "a.ts");
  const clipped = `${"x".repeat(2000)}...`;
  const payload = (content: string, extra = {}) => ({ llmContent: JSON.stringify({ type: "text", filePath: file, content, offset: 1, totalLines: 2, limit: 2, actualLinesRead: 2, ...extra }), truncated: false });
  await writeFile(path, encode([call("read", "read", { file_path: file }), result("read", "read", payload(`${clipped}\n`))]));
  const parsed = await parseSource(path, "codeflicker");
  const base = baseline(directory, `${"x".repeat(2000)}TAIL!\n`);
  const mapping = coverage(base, (await associateSource(parsed, base)).events).mappings[0]!;
  assert.deepEqual(mapping.exactRanges, []);
  assert.deepEqual(mapping.nearRanges, []);
  await writeFile(path, encode([call("partial", "read", { file_path: file, offset: 7, limit: 3 }), result("partial", "read", payload(`before\n${clipped}\nafter`, { offset: 7, totalLines: 20, limit: 3, actualLinesRead: 3 }))]));
  const partial = await parseSource(path, "codeflicker");
  assert.deepEqual(partial.events[0]!.fragments.map(fragment => [fragment.historicalStart, fragment.content]), [[7, "before\n"], [9, "after"]]);
}));

test("bash 绝对执行目录归属相对读取并贯通覆盖，目录不泄漏到后续事件", async () => temporary(async directory => {
  const path = join(directory, "session.jsonl");
  const shell = (cwd: string) => ({ llmContent: `Command: cat a.ts\nDirectory: ${cwd}\nStdout: alpha\nbeta\n\nStderr: (empty)\nError: (none)\nExit Code: 0`, truncated: false });
  await writeFile(path, encode([
    call("bash", "bash", { command: "cat a.ts" }), result("bash", "bash", shell(directory)),
    call("relative-directory", "bash", { command: "cat a.ts" }), result("relative-directory", "bash", shell("relative/path")),
    call("read", "read", { file_path: "a.ts" }), result("read", "read", { llmContent: JSON.stringify({ type: "text", filePath: "a.ts", content: "alpha\nbeta\n", totalLines: 3, offset: 1, limit: 3, actualLinesRead: 3 }), truncated: false }),
  ]));
  const parsed = await parseSource(path, "codeflicker");
  assert.equal(parsed.cwd, undefined);
  assert.equal(parsed.events[0]!.cwd, directory);
  assert.ok(parsed.events.slice(1).every(event => event.cwd === undefined));
  const base = baseline(directory, "alpha\nbeta\n");
  const associated = await associateSource(parsed, base);
  assert.equal(associated.events.length, 1);
  const checked = coverage(base, associated.events);
  assert.deepEqual(checked.mappings[0]!.exactRanges, [{ start: 1, end: 2 }]);
  assert.equal(checked.value.files[0]!.readCount, 1);
  assert.equal(checked.value.files[0]!.readExactLines, 2);
}));

test("原生成功 Agent 结果与同项目唯一子身份建立关系，保留父证据而不合并子调用", async () => temporary(async directory => {
  const parentPath = join(directory, "parent.jsonl");
  const childPath = join(directory, "agent-child-a.jsonl");
  await writeFile(parentPath, await readFile(fixture("codeflicker-agent-parent.jsonl")));
  await writeFile(childPath, await readFile(fixture("agent-child-a.jsonl")));
  const parent = await parseSource(parentPath, "codeflicker");
  const child = await parseSource(childPath, "codeflicker");
  const shared = resolveSharedHistory([parent, child]);
  assert.equal(shared.events.length, 2);
  assert.equal(shared.relationships.length, 1);
  assert.equal(shared.relationships[0]!.resolved, true);
  assert.equal(shared.relationships[0]!.relationship.parentSessionId, "synthetic-parent");
  assert.equal(shared.relationships[0]!.relationship.agentId, "child-a");
  const childEvent = shared.events.find(event => event.sessionId === child.sessionId)!;
  assert.equal(childEvent.id, child.events[0]!.id);
  assert.equal(childEvent.parentSessionId, parent.sessionId);
  const proof = childEvent.sources.find(reference => reference.sourceId === parent.sourceId && reference.recordLine === 2)!;
  assert.ok((await readHistoryEvidence(proof))?.raw.includes('"agentId":"child-a"'));
  assert.equal(child.parentSessionId, undefined);
  assert.equal(child.events[0]!.sources.length, 2);
  assert.equal(shared.gaps.length, 0);
  const unchanged = await parseSource(childPath, "codeflicker", child);
  assert.equal((unchanged.cursor as { parsedRecords: number }).parsedRecords, 0);
  assert.deepEqual(resolveSharedHistory([parent, unchanged]).events, shared.events);
  const copyPath = join(directory, "parent-copy.jsonl");
  await writeFile(copyPath, await readFile(parentPath));
  const copy = await parseSource(copyPath, "codeflicker");
  assert.equal(copy.sourceId, parent.sourceId);
  const copied = resolveSharedHistory([parent, copy, child, structuredClone(child)]);
  assert.equal(copied.events.length, 2);
  assert.ok(copied.relationships.every(relationship => relationship.resolved));
  assert.equal(copied.gaps.length, 0);
}));

test("bash 固定多文件 sed 派生活动继承本次绝对执行目录并分别进入覆盖", async () => temporary(async directory => {
  const path = join(directory, "session.jsonl");
  const command = "sed -n '1,1p' a.ts\nsed -n '1,1p' b.ts";
  await writeFile(path, encode([call("bundle", "bash", { command }), result("bundle", "bash", {
    llmContent: `Command: ${command}\nDirectory: ${directory}\nStdout: alpha\nbeta\n\nStderr: (empty)\nError: (none)\nExit Code: 0`, truncated: false,
  })]));
  const parsed = await parseSource(path, "codeflicker");
  assert.equal(parsed.events.length, 2);
  assert.ok(parsed.events.every(event => event.cwd === directory));
  assert.equal(parsed.cwd, undefined);
  assert.equal((parsed.cursor as { cwd?: string }).cwd, undefined);
  const base = baseline(directory, "alpha\n");
  base.files.push({ path: "b.ts", category: "source", lineCount: 1, hash: "synthetic-b", content: "beta\n" });
  const associated = await associateSource(parsed, base);
  assert.deepEqual(associated.events.map(event => event.path), ["a.ts", "b.ts"]);
  const mappings = associated.events.map(event => matchEvent(event, base.files.find(file => file.path === event.path)!));
  const covered = buildCoverage({ repository: base.repository, version: "synthetic", baseline: base, sources: [], events: associated.events, mappings, gaps: [], createdAt: base.createdAt });
  assert.deepEqual(covered.files.map(file => [file.path, file.readCount, file.readExactLines]), [["a.ts", 1, 1], ["b.ts", 1, 1]]);
  const previous = structuredClone(parsed);
  (previous.cursor as { ruleVersion: string }).ruleVersion = "6";
  delete previous.events[1]!.cwd;
  const rebuilt = await parseSource(path, "codeflicker", previous);
  assert.equal((rebuilt.cursor as { ruleVersion: string; parsedRecords: number }).ruleVersion, "7");
  assert.equal((rebuilt.cursor as { parsedRecords: number }).parsedRecords, 2);
  assert.deepEqual(rebuilt.events, parsed.events);
}));

test("失败、未知、跨项目、身份不符及多父候选不能建立原生子关系", async () => temporary(async directory => {
  const parentText = await readFile(fixture("codeflicker-agent-parent.jsonl"), "utf8");
  const parentPath = join(directory, "parent.jsonl");
  const childPath = join(directory, "agent-child-a.jsonl");
  await writeFile(parentPath, parentText);
  await writeFile(childPath, await readFile(fixture("agent-child-a.jsonl")));
  const parent = await parseSource(parentPath, "codeflicker");
  const child = await parseSource(childPath, "codeflicker");
  const secondPath = join(directory, "second-parent.jsonl");
  await writeFile(secondPath, parentText.replaceAll("synthetic-parent", "second-parent"));
  const second = await parseSource(secondPath, "codeflicker");
  const otherClient = await parseSource(parentPath, "codex", undefined, "codeflicker-jsonl");
  for (const status of ["failure", "unknown"] as const) {
    const invalid = structuredClone(parent); invalid.events[0]!.status = status;
    assert.equal(resolveSharedHistory([invalid, child]).relationships.length, 0);
  }
  await mkdir(join(directory, "other-project"));
  const outside = { ...parent, path: join(directory, "other-project", "parent.jsonl") };
  const mismatch = { ...child, sessionId: "agent-another" };
  const missingResultId = structuredClone(parent); delete (missingResultId.events[0]!.output as Record<string, unknown>).agentId;
  for (const sources of [[outside, child], [parent, mismatch], [missingResultId, child], [parent, second, child], [otherClient, child]]) {
    const shared = resolveSharedHistory(sources);
    assert.equal(shared.relationships.length, 0);
    assert.ok(shared.gaps.some(gap => gap.kind === "ambiguous"));
    assert.ok(shared.events.filter(event => event.sessionId === child.sessionId).every(event => event.parentSessionId === undefined));
  }
}));

test("三个格式登记重构后保持既有事件 ID；顶层父关系字段与来源元数据一致", async () => temporary(async directory => {
  const identities = [
    ["codex-legacy.jsonl", "codex", "codex:7e10671a2ed5affa4df7f45f:9b0bda131bcd3ca7bcfeb739"],
    ["claude-tools.jsonl", "claude", "claude:f594d5e8d0335a53a1ac4274:4f1ce3a63a8f496fe84bc02f"],
    ["codeflicker-native.jsonl", "codeflicker", "codeflicker:4f6a48b9cf0591cca9d0b452:cbf7bc6847289070a2bc8f53"],
  ] as const;
  for (const [name, client, id] of identities) assert.equal((await parseSource(fixture(name), client)).events[0]!.id, id);
  for (const client of ["codex", "claude", "codeflicker"] as const) {
    for (const field of ["parent_thread_id", "forked_from_id"] as const) {
      const record = client === "codex" ? { type: "session_meta", payload: { id: "child" }, [field]: "parent" }
        : client === "claude" ? { type: "assistant", sessionId: "child", message: { content: [] }, [field]: "parent" }
          : message("child", "assistant", [], { sessionId: "child", [field]: "parent" });
      const path = join(directory, `${client}-${field}.jsonl`);
      await writeFile(path, encode([record]));
      const parsed = await parseSource(path, client);
      assert.equal(parsed.parentSessionId, "parent");
      assert.equal(parsed.relationships[0]!.parentSessionId, "parent");
      assert.equal(parsed.relationships[0]!.kind, field === "forked_from_id" ? "fork" : "subagent");
    }
  }
}));

test("显式父字段与成功 Agent 父证明矛盾时撤销当前父关系，保留原始声明与缺口", async () => temporary(async directory => {
  const parentPath = join(directory, "parent.jsonl");
  const secondPath = join(directory, "second.jsonl");
  const childPath = join(directory, "agent-child-a.jsonl");
  await writeFile(parentPath, await readFile(fixture("codeflicker-agent-parent.jsonl")));
  await writeFile(secondPath, encode([message("second", "assistant", [], { sessionId: "second" })]));
  const childRecords = (await readFile(fixture("agent-child-a.jsonl"), "utf8")).trim().split("\n").map(line => ({ ...JSON.parse(line), parentSessionId: "second" }));
  await writeFile(childPath, encode(childRecords));
  const sources = await Promise.all([parentPath, secondPath, childPath].map(path => parseSource(path, "codeflicker")));
  const child = sources[2]!;
  assert.equal(child.parentSessionId, "second");
  assert.equal(child.events[0]!.parentSessionId, "second");
  const relationshipOnly = { ...child, parentSessionId: undefined };
  const fieldOnly = { ...child, relationships: [] };
  for (const candidate of [child, relationshipOnly, fieldOnly]) {
    const shared = resolveSharedHistory([sources[0]!, sources[1]!, candidate]);
    assert.ok(shared.gaps.some(gap => gap.sourceId === child.sourceId && gap.kind === "ambiguous"));
    assert.equal(shared.relationships.filter(item => item.sourceId === child.sourceId).length, 0);
    assert.deepEqual(shared.invalidatedParentSourceIds, [child.sourceId]);
    assert.equal(shared.events.find(event => event.sessionId === child.sessionId)!.parentSessionId, undefined);
  }
  assert.equal(child.parentSessionId, "second");
  assert.equal(child.relationships[0]!.parentSessionId, "second");
  assert.equal(child.events[0]!.parentSessionId, "second");
}));
