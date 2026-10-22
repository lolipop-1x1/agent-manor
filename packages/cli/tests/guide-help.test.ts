import assert from "node:assert/strict";
import test from "node:test";
import type { Command } from "commander";
import { createProgram } from "../src/program.js";

function find(program: Command, path: string): Command {
  return path.split(" ").reduce((command, name) => {
    const child = command.commands.find(item => item.name() === name);
    assert.ok(child, path);
    return child;
  }, program);
}

test("所有扩展查询参数的中英文帮助均解释含义，不再显示通用 API 参数占位", () => {
  for (const language of ["en", "zh-CN"] as const) {
    const walk = (command: Command) => {
      for (const option of command.options) {
        assert.doesNotMatch(option.description, /API parameter:|API 参数：|cli\.guide\./, `${command.name()} ${option.flags}`);
      }
      for (const child of command.commands) walk(child);
    };
    walk(createProgram(language));
  }
});

test("实际帮助展示依赖、正文契约和下一步，补充说明不改变选项解析", () => {
  for (const language of ["en", "zh-CN"] as const) {
    const program = createProgram(language);
    let output = "";
    const capture = (command: Command) => command.configureOutput({ writeOut: value => { output += value; } });
    const requests = find(program, "usage requests");
    capture(requests).outputHelp();
    assert.match(output, /--session-id/);
    assert.match(output, language === "en" ? /--session-id is required/ : /--session-id 必填/);
    assert.match(output, /requestPage\/requestPageSize/);
    assert.match(output, /1\.\.200[\s\S]*100/);
    const clients = requests.options.find(option => option.attributeName() === "clients")!;
    assert.match(clients.description, /JSON/);
    assert.equal(clients.required, true);
    assert.equal(clients.defaultValue, undefined);
    output = "";
    capture(find(program, "knowledge write")).outputHelp();
    assert.match(output, /title.*body.*scope/s);
    assert.match(output, /latestRevisionId/);
    assert.match(output, language === "en" ? /only write when explicitly requested/ : /仅用户明确要求时写入/);
    output = "";
    capture(find(program, "knowledge revise")).outputHelp();
    assert.match(output, /baseRevisionId/);
    assert.match(output, /CONTENT_STALE/);
    output = "";
    capture(find(program, "knowledge extraction preview")).outputHelp();
    assert.match(output, /sessionIds.*turnStart.*turnEnd/);
    assert.match(output, /estimatedTokens\/plannedChunks\/estimatedExtractionCost\/estimatedCost/);
    assert.match(output, language === "en" ? /total null \(unknown\)/ : /总费用为 null，表示未知/);
    assert.doesNotMatch(output, /cli\.guide\./);
    output = "";
    capture(find(program, "semantic test")).outputHelp();
    assert.match(output, /connection:/);
    assert.match(output, /dimensions\/tokens/);
  }
});
