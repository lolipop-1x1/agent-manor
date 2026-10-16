import assert from "node:assert/strict";
import test from "node:test";
import { historyAdapter } from "../src/history/adapters/index.js";
import { callResource, successfulSkillRead } from "../src/sessions/resources.js";

const path = "/synthetic/skills/demo/SKILL.md";
const content = "instructions";
const file = { filePath: path, content, startLine: 1, numLines: 1, totalLines: 1 };
const cases: { format: string; tool: string; input: unknown; result: unknown; visible: string }[] = [
  { format: "codex-jsonl", tool: "functions.exec_command", input: { cmd: `cat ${path}` }, result: {}, visible: content },
  { format: "claude-jsonl", tool: "Read", input: { file_path: path }, result: { file }, visible: `1\t${content}` },
  { format: "codeflicker-jsonl", tool: "read", input: { file_path: path }, result: { llmContent: JSON.stringify({ type: "text", filePath: path,
    content, offset: 1, limit: 1, totalLines: 1, actualLinesRead: 1 }) }, visible: content },
  { format: "codeflicker-desktop-jsonl", tool: "read_file", input: { path, start_line: 1, line_count: 1 },
    result: { start_line: 1, line_count: 1, total_lines: 1 }, visible: content },
  { format: "codeflicker-ide-sqlite", tool: "readFile", input: { path, startLine: 1, endLine: 1 }, result: {}, visible: `1|${content}` },
  { format: "dsh-jsonl", tool: "fs.read", input: { file_path: path }, result: { message: { isError: false },
    meta: { path, offset: 1, totalLines: 1, lines: [{ number: 1, text: content }] } }, visible: `1: ${content}` },
  { format: "pi-jsonl", tool: "read", input: { path }, result: { content: [{ type: "text", text: content }], isError: false }, visible: content },
  { format: "workbuddy-jsonl", tool: "Read", input: { filePath: path, offset: 1 },
    result: { filePath: path, read_file_result: { content, hasMore: false, totalLineCount: 1 } }, visible: content },
  { format: "opencode-sqlite", tool: "read", input: { filePath: path }, result: { metadata: { display: { type: "file", path, text: content,
    lineStart: 1, lineEnd: 1, totalLines: 1 } } }, visible: `<path>${path}</path>\n<type>file</type>\n<content>\n1: ${content}\n\n(End of file - total 1 lines)\n</content>` },
  { format: "zcode-sqlite", tool: "Read", input: { file_path: path }, result: { file }, visible: `1\t${content}` },
  { format: "qoder-jsonl", tool: "Read", input: { file_path: path }, result: { file }, visible: `1\t${content}` },
];

for (const sample of cases) test(`${sample.format} 复用原生读取证据且写入不计 Skill`, () => {
  const adapter = historyAdapter(sample.format);
  assert.ok(adapter, "夹具必须使用已注册的原生适配器");
  assert.deepEqual(successfulSkillRead(sample.tool, sample.input, sample.result, sample.visible, "/synthetic/repo", adapter.extract).resource,
    { kind: "skill_read", name: "demo", path });
  assert.equal(successfulSkillRead("Write", { file_path: path, content }, { success: true }, "written", undefined, adapter.extract).resource, undefined);
});

test("MCP 可见身份与显式 Skill 参数保留，普通名称和 sanitized 名不猜服务", () => {
  assert.deepEqual(callResource("functions.mcp__example__lookup", {}), { kind: "mcp", name: "lookup", server: "example" });
  assert.deepEqual(callResource("mcp__example.lookup", {}), { kind: "mcp", name: "lookup", server: "example" });
  assert.deepEqual(callResource("Skill", { skill: "vendor:demo" }), { kind: "skill_call", name: "vendor:demo" });
  assert.equal(callResource("example_lookup", {}), undefined);
  assert.equal(callResource("Bash", { command: "/skill:demo" }), undefined);
});

test("use_skill 保留明确目录路径，相对目录只由已记录 cwd 解析，名称参数不猜路径", () => {
  assert.deepEqual(callResource("use_skill", { skill_directory: "/synthetic/skills/demo/../demo" }), { kind: "skill_call", name: "demo", path: "/synthetic/skills/demo" });
  assert.deepEqual(callResource("use_skill", { skill_directory: "skills/demo" }, "/synthetic/project"), { kind: "skill_call", name: "demo", path: "/synthetic/project/skills/demo" });
  assert.deepEqual(callResource("use_skill", { skill_directory: "skills/demo" }), { kind: "skill_call", name: "demo", path: "skills/demo" });
  assert.deepEqual(callResource("use_skill", { name: "demo" }, "/synthetic/project"), { kind: "skill_call", name: "demo" });
  assert.deepEqual(callResource("use_skill", { skill_directory: "file:///synthetic/skills/demo", skill: "vendor:demo" }), { kind: "skill_call", name: "vendor:demo", path: "/synthetic/skills/demo" });
});

test("原生 Read 返回路径矛盾时不退回普通正文归属", () => {
  const adapter = historyAdapter("codeflicker-jsonl")!;
  const result = { llmContent: JSON.stringify({ type: "text", filePath: "/synthetic/skills/other/SKILL.md",
    content, offset: 1, limit: 1, totalLines: 1, actualLinesRead: 1 }) };
  assert.equal(successfulSkillRead("read", { file_path: path }, result, result.llmContent, undefined, adapter.extract).resource, undefined);
  assert.equal(successfulSkillRead("Read", { file_path: path }, { file: { ...file, filePath: "/synthetic/other.md" } }, `1\t${content}`).resource, undefined);
});

test("一次成功命令读取多个 Skill 按返回正文确认并去重，不要求精确代码行范围", () => {
  const first = "/synthetic/skills/first/SKILL.md", second = "/synthetic/skills/second/SKILL.md";
  const body = "---\nname: first\n---\n第一份指导。\n---\nname: second\n---\n第二份指导。\n";
  for (const command of [`cat ${first} ${second} ${first}`, `cat ${first} && cat ${second}`, `cat ${first}; cat ${second}`, `cat ${first}\ncat ${second}`, `git status --short; cat ${first} ${second}`]) {
    const read = successfulSkillRead("exec_command", { cmd: command }, {}, body);
    assert.deepEqual(read.resources, [{ kind: "skill_read", name: "first", path: first }, { kind: "skill_read", name: "second", path: second }], command);
  }
  for (const command of [`false && cat ${first}; true`, `cat ${first} || true`, `echo 'name: first'; cat ${first}`, `rg first ${first}`]) {
    assert.equal(successfulSkillRead("exec_command", { cmd: command }, {}, body).resource, undefined, command);
  }
  assert.equal(successfulSkillRead("exec_command", { cmd: `cat ${first} ${second}` }, {}, "name: first is mentioned").resource, undefined);
  const partial = successfulSkillRead("exec_command", { cmd: `cat ${first}; cat ${second}` }, {}, "cat: /synthetic/skills/first/SKILL.md: No such file\n---\nname: second\n---\n第二份指导。\n");
  assert.deepEqual(partial.resource, { kind: "skill_read", name: "second", path: second });
  assert.equal(successfulSkillRead("exec_command", { cmd: `cat ${first} ${second}` }, {}, "```yaml\n---\nname: first\n---\n示例而非文件正文\n```\n").resource, undefined);
  const truncated = successfulSkillRead("exec_command", { cmd: `cat ${first} ${second}` }, {}, "---\nname: first\n---\n正文\n[output truncated]\n---\nname: second\n---\n");
  assert.deepEqual(truncated.resource, { kind: "skill_read", name: "first", path: first });
  assert.equal(successfulSkillRead("exec_command", { cmd: `cat ${first} /synthetic/another/first/SKILL.md` }, {}, body).resource, undefined, "同名不同路径无法由合并正文确定归属时保持未知");
});
