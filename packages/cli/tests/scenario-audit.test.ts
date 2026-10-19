import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Command } from "commander";
import { createProgram } from "../src/program.js";

test("场景审计覆盖每个实际注册命令及根默认动作，新增命令必须声明输出用途", async () => {
  const registered: string[] = [];
  const walk = (command: Command, parents: string[]) => {
    for (const child of command.commands) {
      const path = [...parents, child.name()];
      if (!child.commands.length || (child as unknown as { _actionHandler?: unknown })._actionHandler) registered.push(path.join(" "));
      walk(child, path);
    }
  };
  walk(createProgram("en"), []);
  const document = await readFile(new URL("../../../.scratch/cli-scenario-audit/command-audit.md", import.meta.url), "utf8");
  const audited = [...document.matchAll(/^\| `am ([^`]+)` \|/gm)].map(match => match[1]!);
  assert.equal(new Set(audited).size, audited.length);
  assert.deepEqual(audited.sort(), registered.sort());
  assert.equal(registered.length, 126);
});
