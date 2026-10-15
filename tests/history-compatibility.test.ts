import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ParsedSource } from "../src/contracts.js";
import { parseSource } from "../src/history/index.js";
import { PARSER_RULE_VERSION } from "../src/version.js";
import { physicalLines, shellEvidence, toolEvidence } from "../src/history/extraction.js";

function read(content: string, numLines: number, totalLines: number, visible: string, startLine = 1) {
  return toolEvidence("Read", { file_path: "/synthetic/repo/a.ts", offset: startLine }, {
    file: { filePath: "/synthetic/repo/a.ts", content, numLines, totalLines, startLine },
  }, visible)[0]!;
}

test("Claude SDK 尾 LF 的虚拟 EOF 编号空行须有完整一致证据，覆盖仅物理行", () => {
  const evidence = read("alpha\nbeta\n", 3, 3, "1\talpha\n2\tbeta\n3\t\n");
  assert.equal(evidence.reason, undefined);
  assert.equal(evidence.fragments[0]!.historicalStart, 1);
  assert.equal(evidence.fragments[0]!.content, "alpha\nbeta\n");
  assert.equal(physicalLines(evidence.fragments[0]!.content).length, 2);
  const offset = read("beta\n", 2, 10, "9\tbeta\n10\t\n", 9);
  assert.equal(offset.fragments[0]!.historicalStart, 9);
  assert.equal(physicalLines(offset.fragments[0]!.content).length, 1);
});

test("Claude 物理末尾空行保留，SDK 虚拟末行排除；无尾 LF 及传统物理计数继续支持", () => {
  const emptyLine = read("alpha\n\n", 3, 3, "1\talpha\n2\t\n3\t\n");
  assert.equal(physicalLines(emptyLine.fragments[0]!.content).length, 2);
  assert.deepEqual(physicalLines(emptyLine.fragments[0]!.content), ["alpha", ""]);
  assert.equal(read("alpha\nbeta", 2, 2, "1\talpha\n2\tbeta\n").fragments[0]!.content, "alpha\nbeta");
  assert.equal(read("alpha\nbeta\n", 2, 2, "1\talpha\n2\tbeta\n").fragments[0]!.content, "alpha\nbeta\n");
});

test("计数差一不是通行证：非 EOF、缺可见末行、末行非空、内容或编号矛盾均拒绝", () => {
  for (const [content, count, total, visible] of [
    ["alpha\nbeta\n", 3, 10, "1\talpha\n2\tbeta\n3\t\n"],
    ["alpha\nbeta\n", 3, 3, "1\talpha\n2\tbeta\n"],
    ["alpha\nbeta\n", 3, 3, "1\talpha\n2\tbeta\n3\tnot empty\n"],
    ["alpha\nbeta\n", 3, 3, "1\twrong\n2\tbeta\n3\t\n"],
    ["alpha\nbeta\n", 3, 3, "1\talpha\n3\tbeta\n3\t\n"],
    ["alpha\nbeta", 3, 3, "1\talpha\n2\tbeta\n3\t\n"],
    ["alpha\nbeta\n", 4, 4, "1\talpha\n2\tbeta\n3\t\n4\t\n"],
    ["alpha\nbeta\n", 3, 3, "Preview without verified line numbers"],
    ["alpha\nbeta\n", 3, 3, "1\talpha\n2\tbeta\n3\t\n<system-reminder>unknown extra content</system-reminder>\n"],
  ] as const) {
    const evidence = read(content, count, total, visible);
    assert.equal(evidence.fragments.length, 0);
    assert.ok(evidence.reason?.startsWith("range_unknown:"));
  }
  assert.equal(read("alpha\nbeta\n", 2, 2, "1\talpha\n3\tbeta\n").fragments.length, 0);
});

test("旧规则缓存即使字节未变化也重新解析，恢复完整 Claude Read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-history-compat-"));
  try {
    const path = join(directory, "read.jsonl");
    const records = [
      { type: "assistant", uuid: "synthetic-read", sessionId: "synthetic-compat", cwd: "/synthetic/repo", message: { content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "/synthetic/repo/a.ts" } }] } },
      { type: "user", uuid: "synthetic-result", sourceToolAssistantUUID: "synthetic-read", sessionId: "synthetic-compat", cwd: "/synthetic/repo", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "1\talpha\n2\tbeta\n3\t\n" }] }, toolUseResult: { file: { filePath: "/synthetic/repo/a.ts", content: "alpha\nbeta\n", numLines: 3, startLine: 1, totalLines: 3 } } },
    ];
    await writeFile(path, records.map((record) => JSON.stringify(record) + "\n").join(""));
    const previous = JSON.parse(JSON.stringify(await parseSource(path, "claude"))) as ParsedSource;
    (previous.cursor as { ruleVersion: string }).ruleVersion = "obsolete";
    previous.events[0]!.fragments = [];
    const parsed = await parseSource(path, "claude", previous);
    assert.equal((parsed.cursor as { ruleVersion: string }).ruleVersion, PARSER_RULE_VERSION);
    assert.equal((parsed.cursor as { parsedRecords: number }).parsedRecords, 2);
    assert.equal(physicalLines(parsed.events[0]!.fragments[0]!.content).length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("现代单个 CommandExecution 支持 file URI 与编号返回，组合读取保留路径且不猜输出边界", async () => {
  const path = new URL("./fixtures/history/codex-modern.jsonl", import.meta.url).pathname;
  const original = await readFile(path);
  const parsed = await parseSource(path, "codex");
  assert.equal(parsed.events[0]!.cwd, "/synthetic/repo");
  assert.equal(parsed.events[0]!.kind, "read");
  assert.equal(physicalLines(parsed.events[0]!.fragments[0]!.content).length, 2);
  assert.deepEqual(await readFile(path), original);
  const chain = shellEvidence("nl -ba a.ts && nl -ba b.ts", "1\talpha\n1\tbeta\n")[0]!;
  assert.equal(chain.kind, "read");
  assert.equal(chain.fragments.length, 0);
  assert.ok(chain.reason?.startsWith("range_unknown:"));
});
