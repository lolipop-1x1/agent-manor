import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import type { ServiceInstance } from "../../../src/contracts.js";
import { VERSION } from "../../../src/version.js";
import { isolatedHistoryEnvironment } from "../../../tests/helpers/history-roots.js";
import { createProgram } from "../src/program.js";
import { manageSkill } from "../src/skills/manager.js";
import { managementConfirmation } from "../src/api/management.js";

const executeFile = promisify(execFile);
const cli = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
const hook = fileURLToPath(import.meta.resolve("tsx/esm"));
async function execute(home: string, args: string[]) {
  try {
    return { code: 0, ...await executeFile(process.execPath, ["--import", hook, cli, ...args], {
      cwd: tmpdir(), timeout: 15_000, env: isolatedHistoryEnvironment(home, { AGENT_MANOR_HOME: home, AGENT_MANOR_LANG: "en", AGENT_MANOR_PORT: "0" }),
    }) };
  } catch (error) {
    const value = error as { code: number; stdout: string; stderr: string };
    return { code: value.code, stdout: value.stdout, stderr: value.stderr };
  }
}

test("启动和重启先校验端口，非法参数不会触碰已有实例", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-cli-invalid-port-"));
  let instance: ServiceInstance;
  let stops = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url?.split("?")[0] === "/api/v1/status") response.end(JSON.stringify({ instance, version: VERSION, protocolVersion: 1, activeTasks: [] }));
    else { stops++; response.statusCode = 400; response.end(JSON.stringify({ error: { code: "FORBIDDEN", message: "Synthetic stop blocked" } })); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  instance = { id: "synthetic-cli-parameter-service", pid: process.pid, host: "127.0.0.1", port: address.port,
    startedAt: new Date().toISOString(), version: VERSION, protocolVersion: 1 };
  await writeFile(join(home, "service.json"), JSON.stringify(instance));
  try {
    for (const action of ["start", "restart"]) for (const port of ["abc", "-1", "65536", "1.5", ""]) {
      await assert.rejects(createProgram("en").parseAsync(["--home", home, action, "--port", port], { from: "user" }), { code: "INVALID_INPUT" });
      assert.equal(stops, 0, `${action} ${port} 不得调用停止接口`);
      assert.deepEqual(JSON.parse(await readFile(join(home, "service.json"), "utf8")), instance);
    }
    for (const action of ["start", "restart"]) {
      await assert.rejects(createProgram("en").parseAsync(["--home", home, action, "--timeout", "0"], { from: "user" }), { code: "INVALID_INPUT" });
      assert.equal(stops, 0, "等待参数同样必须先校验");
    }
  } finally { await new Promise<void>(done => server.close(() => done())); await rm(home, { recursive: true, force: true }); }
});

test("ready 的非法等待时间不得启动后台", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-cli-invalid-ready-"));
  try {
    const result = await execute(home, ["ready", "--timeout", "0", "--json"]);
    assert.equal(result.code, 1); assert.equal(JSON.parse(result.stderr).error.code, "INVALID_INPUT");
    const status = await execute(home, ["status", "--json"]);
    assert.equal(JSON.parse(status.stdout).running, false);
  } finally { await execute(home, ["stop", "--wait", "--json"]); await rm(home, { recursive: true, force: true }); }
});

test("缺少全局参数值不能吞掉 JSON 标记，包括版本快捷入口", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-cli-missing-options-"));
  try {
    for (const args of [["status", "--home", "--json"], ["version", "--lang", "--json"], ["--version", "--home", "--json"]]) {
      const result = await execute(home, args);
      assert.equal(result.code, 1, args.join(" ")); assert.equal(result.stdout, "");
      assert.equal(JSON.parse(result.stderr).error.code, "commander.optionMissingArgument");
    }
    const version = await execute(home, ["--version", "--full", "--json"]);
    assert.equal(version.code, 0); assert.equal(JSON.parse(version.stdout).version, VERSION);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Skill 修改保护的 JSON 错误流只有一个 JSON 对象", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-cli-skill-json-"));
  const directory = join(home, "skills");
  try {
    const installed = await manageSkill("install", { target: "custom", directory });
    await writeFile(join(installed.targetPath, "SKILL.md"), "Synthetic user edit\n");
    for (const action of ["update", "remove"]) {
      const result = await execute(home, ["skills", action, "--directory", directory, "--json"]);
      assert.equal(result.code, 1); assert.equal(result.stdout, "");
      assert.equal(JSON.parse(result.stderr).error.code, "SKILL_MODIFIED");
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("三类暂停命令按暂停意图等待成功，普通查询仍报告暂停未完成", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-cli-pause-intent-"));
  let instance: ServiceInstance;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url?.split("?")[0] === "/api/v1/status") response.end(JSON.stringify({ instance, version: VERSION, protocolVersion: 1 }));
    else response.end(JSON.stringify({ id: "synthetic-paused-task", status: "paused" }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  instance = { id: "synthetic-cli-pause-service", pid: process.pid, host: "127.0.0.1", port: address.port,
    startedAt: new Date().toISOString(), version: VERSION, protocolVersion: 1 };
  await writeFile(join(home, "service.json"), JSON.stringify(instance));
  try {
    for (const args of [["knowledge", "index", "pause"], ["knowledge", "extraction", "pause", "synthetic-task"], ["semantic", "pause"]]) {
      const result = await execute(home, [...args, "--wait", "--json"]);
      assert.equal(result.code, 0, args.join(" ")); assert.equal(JSON.parse(result.stdout).status, "paused");
    }
    const query = await execute(home, ["knowledge", "extraction", "get", "synthetic-task", "--wait", "--json"]);
    assert.equal(query.code, 1); assert.equal(JSON.parse(query.stdout).status, "paused");
  } finally { await new Promise<void>(done => server.close(() => done())); await rm(home, { recursive: true, force: true }); }
});

test("自动刷新关闭时 wait 成功返回明确跳过，真实失败任务仍退出非零", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-cli-auto-refresh-skip-"));
  let instance: ServiceInstance;
  let failed = false;
  const skipped = { job: null, status: "skipped", reason: "disabled" };
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url?.split("?")[0] === "/api/v1/status") response.end(JSON.stringify({ instance, version: VERSION, protocolVersion: 1 }));
    else response.end(JSON.stringify(failed ? { job: { id: "synthetic-failed-refresh", status: "failed" } } : skipped));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  instance = { id: "synthetic-auto-refresh-service", pid: process.pid, host: "127.0.0.1", port: address.port,
    startedAt: new Date().toISOString(), version: VERSION, protocolVersion: 1 };
  await writeFile(join(home, "service.json"), JSON.stringify(instance));
  try {
    for (const args of [["sessions", "auto-refresh"], ["repositories", "auto-refresh", "synthetic-repository"]]) {
      const result = await execute(home, [...args, "--wait", "--json"]);
      assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), skipped);
    }
    failed = true;
    const result = await execute(home, ["sessions", "auto-refresh", "--wait", "--json"]);
    assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).job.status, "failed");
  } finally { await new Promise<void>(done => server.close(() => done())); await rm(home, { recursive: true, force: true }); }
});

test("JSON 管理命令即使具有终端也不交互，错误和完整精确授权摘要保持单对象", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-cli-management-json-"));
  const ttyHook = join(home, "terminal.mjs");
  await writeFile(ttyHook, "Object.defineProperty(process.stdin, 'isTTY', { value: true });\nObject.defineProperty(process.stderr, 'isTTY', { value: true });\n");
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", hook, "--import", ttyHook, cli, "--home", home, "--lang", "en", "semantic", "settings", "key", "--json"], {
        cwd: tmpdir(), env: isolatedHistoryEnvironment(home, { AGENT_MANOR_HOME: home }), stdio: "pipe",
      });
      let stdout = "", stderr = "", denied = false;
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Synthetic terminal command timed out")); }, 15_000);
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.on("data", chunk => { stderr += String(chunk); if (!denied && stderr.includes("> ")) { denied = true; child.stdin.end("synthetic-denied\n"); } });
      child.on("error", error => { clearTimeout(timeout); reject(error); });
      child.on("close", code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    });
    assert.equal(result.code, 1); assert.equal(result.stdout, "");
    const failure = JSON.parse(result.stderr).error;
    assert.equal(failure.code, "CONFIRMATION_REQUIRED");
    assert.deepEqual(failure.details, { method: "GET", path: "/semantic/key", body: null, confirmation: managementConfirmation("GET", "/semantic/key") });
  } finally { await rm(home, { recursive: true, force: true }); }
});
