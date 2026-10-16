import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellEvidence } from "../src/history/extraction.js";
import { parseSource } from "../src/history/index.js";

test("搜索参数、正则、逻辑后缀和文件模式不充当文件路径", () => {
  for (const command of ["rg --files -g '*.kt'", "rg --files -g '!*.iml'", "rg -n 'alpha|beta'", "rg -n -g '*.ts' -e alpha -e beta"]) {
    assert.ok(shellEvidence(command, "").every(event => event.path === undefined), command);
  }
  assert.deepEqual(shellEvidence("rg 'sample' src || true", "").map(event => [event.kind, event.path]), [["search", "src"]]);
  assert.deepEqual(shellEvidence("rg -n --glob '*.ts' 'sample' src/a.ts src/b.ts", "").map(event => event.path), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(shellEvidence("rg -nA 3 'sample' src | head -20", "").map(event => event.path), ["src"]);
  assert.ok(shellEvidence("rg --unknown-value value sample", "").every(event => event.path === undefined));
});

test("Codex 原生命令兼容输出字段，源码片段仍只来自明确读取范围", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-codex-output-"));
  try {
  for (const field of ["formatted_output", "aggregated_output"]) {
      const path = join(directory, `${field}.jsonl`);
      await writeFile(path, [
        { type: "session_meta", payload: { id: "synthetic-output", cwd: "/synthetic/repo" } },
        { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "read", command: "cat src/a.ts", status: "completed", exit_code: 0, [field]: "alpha\n" } } },
        { type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: "bundle", command: "cat src/a.ts src/b.ts", status: "completed", exit_code: 0, [field]: "alpha\nbeta\n" } } },
      ].map(row => JSON.stringify(row) + "\n").join(""));
      const reads = (await parseSource(path, "codex")).events.filter(event => event.kind === "read");
      assert.equal(reads.length, 3, field);
      assert.equal(reads[0]?.fragments[0]?.content, "alpha\n", field);
      assert.ok(reads.slice(1).every(event => event.fragments.length === 0), "多文件输出不能因此获得伪造的代码行范围");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("切换目录后的单次读取使用实际目录，不把日志或命令参数当作路径", () => {
  const event = shellEvidence("cd /workspace/example && cat src/a.ts", "alpha\n")[0]!;
  assert.equal(event.path, "/workspace/example/src/a.ts");
  assert.equal(event.fragments[0]?.content, "alpha\n");
  assert.ok(shellEvidence("cat src/a.ts && cat src/b.ts", "alpha\nbeta\n").every(event => event.fragments.length === 0));
  assert.deepEqual(shellEvidence("cat src/a.ts && cat src/b.ts", "alpha\nbeta\n").map(event => event.path), ["src/a.ts", "src/b.ts"]);
});

test("同一文件的多个明确 sed 范围按返回顺序恢复，短输出不猜边界", () => {
  const command = "sed -n '1,2p;5,6p' src/a.ts";
  const event = shellEvidence(command, "one\ntwo\nfive\nsix\n")[0]!;
  assert.equal(event.path, "src/a.ts");
  assert.deepEqual(event.fragments.map(fragment => [fragment.historicalStart, fragment.content]), [[1, "one\ntwo\n"], [5, "five\nsix\n"]]);
  assert.equal(shellEvidence(command, "one\ntwo\nfive\n")[0]?.fragments.length, 0);
  for (const selector of ["1,3p;2,4p", "3p;1p"]) assert.equal(shellEvidence(`sed -n '${selector}' src/a.ts`, "one\ntwo\nthree\nfour\n")[0]?.fragments.length, 0);
});

test("显式多行命令保留读取证据，混合输出不能作为单文件完整正文", () => {
  const events = shellEvidence("git status --short\ncat src/a.ts\nrg -n sample src", " M src/a.ts\nalpha\nsrc/a.ts:1:sample\n");
  const read = events.find(event => event.kind === "read");
  assert.equal(read?.path, "src/a.ts");
  assert.equal(read?.fragments.length, 0);
  assert.ok(!events.some(event => event.path === "--short" || event.path === "sample"));
});

test("目录盘点、版本状态和构建命令不充当源码读取失败", () => {
  for (const command of ["ls -la src", "find src -type f", "git status --short", "npm test", "mvn test", "pwd"]) {
    assert.deepEqual(shellEvidence(command, "合成命令输出"), [{ kind: "other", fragments: [] }], command);
  }
});

test("Shell 注释不作为路径，注释内连接符不拆成命令", () => {
  assert.deepEqual(shellEvidence("cat src/a.ts # note; ignored", "alpha\n").map(event => event.path), ["src/a.ts"]);
  const events = shellEvidence("cat src/a.ts # ignored && cat false.ts\nrg sample src", "");
  assert.deepEqual(events.map(event => event.path), ["src/a.ts", "src"]);
});

test("组合命令的最终成功不能证明被短路或较早的读取成功，现代与配对事件保持一致", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-shell-status-"));
  try {
    for (const modern of [false, true]) {
      const commands = ["cat missing.ts || true", "false && cat skipped.ts; true", "cat first.ts; cat last.ts", "cd /workspace/example && cat src/a.ts"];
      const records: unknown[] = [{ type: "session_meta", payload: { id: "synthetic-shell-status", cwd: "/workspace/example" } }];
      commands.forEach((command, index) => {
        if (modern) records.push({ type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", id: String(index), command, status: "completed", exit_code: 0, formatted_output: "alpha\n" } } });
        else records.push(
          { type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: String(index), arguments: JSON.stringify({ command }) } },
          { type: "response_item", payload: { type: "function_call_output", call_id: String(index), output: "Exit code: 0\nOutput:\nalpha\n" } },
        );
      });
      const path = join(directory, `${modern ? "modern" : "paired"}.jsonl`);
      await writeFile(path, records.map(record => JSON.stringify(record) + "\n").join(""));
      const reads = (await parseSource(path, "codex")).events.filter(event => event.kind === "read");
      assert.equal(reads.length, 5);
      assert.ok(reads.slice(0, 4).every(event => event.status === "unknown" && event.fragments.length === 0));
      assert.equal(reads[4]!.status, "success");
      assert.equal(reads[4]!.path, "/workspace/example/src/a.ts");
      assert.equal(reads[4]!.fragments[0]?.content, "alpha\n");
    }
    assert.ok(shellEvidence("cat a.ts || cd /workspace/other && cat b.ts", "alpha\n").every(event => event.path === undefined));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
