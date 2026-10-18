import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { startService } from "../../../src/server.js";
import { apiRequest } from "../../../src/service/runtime.js";
import { isolatedHistoryRoots } from "../../../tests/helpers/history-roots.js";
import { humanOutput } from "../src/output/format.js";
const run = promisify(execFile);

test("实际CLI服务和Skill状态用中英文可读摘要，JSON字段与原始值不随语言改变", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-human-cli-"));
  const cli = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
  const hook = fileURLToPath(import.meta.resolve("tsx/esm"));
  const command = async (language: string, args: string[], json = false) => run(process.execPath,
    ["--import", hook, cli, "--home", join(directory, "data"), "--lang", language, ...(json ? ["--json"] : []), ...args], { cwd: tmpdir(), timeout: 15_000 });
  try {
    for (const [args, english, chinese] of [
      [["status"], /Service is not running/, /服务未运行/],
      [["stop"], /Service is not running/, /服务未运行/],
      [["skills", "status", "--target", "custom", "--directory", join(directory, "skills")], /Not installed/, /尚未安装/],
      [["doctor"], /Installation diagnostics/, /安装诊断/],
    ] as const) {
      assert.match((await command("en", [...args])).stdout, english);
      const zh = (await command("zh-CN", [...args])).stdout;
      assert.match(zh, chinese); assert.doesNotMatch(zh, /"action"|"targetPath"|"running"|Translation unavailable/);
      assert.deepEqual(JSON.parse((await command("en", [...args], true)).stdout), JSON.parse((await command("zh-CN", [...args], true)).stdout));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("软件更新、启动、Skill修改及日志摘要翻译标签并保留原始路径和版本", () => {
  const updated = { currentVersion: "0.1.0", targetVersion: "0.2.0", updateAvailable: true, updated: true,
    installation: { kind: "local", root: "/workspace/install" }, backup: "/workspace/backup" };
  assert.match(humanOutput(updated, "en"), /Product update completed/);
  const chinese = humanOutput(updated, "zh-CN");
  assert.match(chinese, /程序更新完成/); assert.match(chinese, /当前版本: 0.1.0/); assert.match(chinese, /目标版本: 0.2.0/); assert.match(chinese, /\/workspace\/backup/);
  const started = { instance: { pid: 42, port: 16666, version: "0.1.0" }, url: "http://127.0.0.1:16666" };
  assert.match(humanOutput(started, "zh-CN"), /服务已就绪/); assert.match(humanOutput(started, "en"), /Service is ready/);
  const skill = { action: "status", status: "modified", targetPath: "/workspace/skills/agent-manor", version: "0.1.0", conflicts: ["SKILL.md"] };
  assert.match(humanOutput(skill, "zh-CN"), /有本地修改/); assert.match(humanOutput(skill, "en"), /Locally modified/);
});

test("真实运行服务包含indexMaintenance时，CLI仍显示服务状态、准备状态和日志位置", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-running-human-"));
  const cli = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
  const hook = fileURLToPath(import.meta.resolve("tsx/esm"));
  const service = await startService({ home, port: 0, startupRefresh: false, roots: isolatedHistoryRoots() });
  try {
    const status = await apiRequest<{ indexMaintenance?: unknown }>(service.instance, "/status?summary=true");
    assert.ok(status.indexMaintenance);
    for (const [language, running, preparation, log] of [["en", /Service is running/, /Data preparation: Skipped/, /Log:/], ["zh-CN", /服务正在运行/, /数据准备: 已跳过/, /日志:/]] as const) {
      const result = await run(process.execPath, ["--import", hook, cli, "--home", home, "--lang", language, "status"], { cwd: tmpdir(), timeout: 15_000 });
      assert.match(result.stdout, running); assert.match(result.stdout, preparation); assert.match(result.stdout, log);
      assert.ok(result.stdout.includes(String(service.instance.port)));
      assert.doesNotMatch(result.stdout, /"indexMaintenance"|"repositories"|"messageDescriptor"/);
    }
  } finally { await service.close(); await rm(home, { recursive: true, force: true }); }
});
