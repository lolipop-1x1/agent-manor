import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ServiceInstance } from "../../../src/contracts.js";
import { VERSION } from "../../../src/version.js";
import { createProgram } from "../src/program.js";
import { serviceStatus, startBackground, stopService, verifiedInstance } from "../../../src/service/runtime.js";

test("status完整模式保留旧字段，默认只返回状态摘要，stop继续保留停止标记", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-cli-lifecycle-compat-"));
  let instance: ServiceInstance;
  const payload = () => ({ instance, version: VERSION, protocolVersion: 1,
    repositories: [{ id: "synthetic-repository", name: "Synthetic" }], jobs: [{ id: "synthetic-complete-job", status: "completed" }],
    preparation: { state: "ready", stage: "complete" }, activeTasks: [] });
  let stops = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url?.split("?")[0] === "/api/v1/status") response.end(JSON.stringify(payload()));
    else if (request.url === "/api/v1/stop") {
      stops++; await rm(join(home, "service.json")); response.end(JSON.stringify({ stopping: true }));
    } else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  instance = { id: "synthetic-lifecycle-compat-service", pid: process.pid, host: "127.0.0.1", port: address.port,
    startedAt: new Date().toISOString(), version: VERSION, protocolVersion: 1 };
  await writeFile(join(home, "service.json"), JSON.stringify(instance));
  const oldWrite = process.stdout.write; let output = "";
  process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stdout.write;
  const execute = async (...args: string[]) => {
    output = ""; await createProgram("en").parseAsync(["--home", home, "--json", ...args], { from: "user" }); return JSON.parse(output);
  };
  try {
    const status = await execute("status", "--full");
    for (const [key, value] of Object.entries(payload())) assert.deepEqual(status[key], value, `原有字段 ${key} 仍须位于顶层`);
    assert.equal(status.running, true); assert.equal(status.state, "running"); assert.deepEqual(status.status, payload());
    const summary = await execute("status");
    assert.equal(summary.running, true); assert.equal(summary.status.repositoryCount, 1); assert.equal(summary.status.jobCount, 1);
    assert.equal(summary.repositories, undefined); assert.equal(summary.status.repositories, undefined); assert.equal(summary.status.jobs, undefined);
    const started = await execute("start");
    assert.equal(started.version, VERSION); assert.equal(started.instance.id, instance.id);
    const stopped = await execute("stop");
    assert.equal(stopped.stopping, true); assert.equal(stopped.running, false); assert.equal(stopped.stopped, true);
    assert.equal(stopped.instance.id, instance.id); assert.equal(stops, 1);
    assert.deepEqual(await execute("stop"), { stopping: false, running: false, stopped: false });
    const inactive = await execute("status"); assert.equal(inactive.running, false); assert.equal(inactive.state, "stopped");
    assert.equal(stops, 1, "未运行的stop不得再次调用后端");
  } finally { process.stdout.write = oldWrite; await new Promise<void>(done => server.close(() => done())); await rm(home, { recursive: true, force: true }); }
});

test("实例握手、复用、准备等待和停止只读取必要状态，公开完整查询保持兼容", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-cli-lifecycle-handshake-"));
  let instance: ServiceInstance;
  const statusRequests: URL[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/v1/status") {
      statusRequests.push(url);
      const base = { instance, version: VERSION, protocolVersion: 1, preparation: { state: "ready" }, activeTasks: [] };
      response.end(JSON.stringify(url.searchParams.get("response") === "summary" ? { ...base, repositoryCount: 1, jobCount: 1 }
        : { ...base, repositories: [{ id: "synthetic-repository" }], jobs: [{ id: "synthetic-job" }] }));
    } else {
      await rm(join(home, "service.json")); response.end(JSON.stringify({ stopping: true }));
    }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  instance = { id: "synthetic-lifecycle-handshake-service", pid: process.pid, host: "127.0.0.1", port: address.port,
    startedAt: new Date().toISOString(), version: VERSION, protocolVersion: 1 };
  await writeFile(join(home, "service.json"), JSON.stringify(instance));
  try {
    const full = await serviceStatus(home);
    assert.equal(full.status?.repositories.length, 1); assert.equal(statusRequests[0]!.searchParams.has("response"), false);
    statusRequests.length = 0;
    assert.equal((await verifiedInstance(home))?.id, instance.id);
    assert.equal((await startBackground(home, { port: 0, waitData: true, timeoutMs: 1000 })).id, instance.id);
    assert.equal((await stopService(home)).stopped, true);
    assert.ok(statusRequests.length >= 4);
    assert.ok(statusRequests.every(url => url.searchParams.get("response") === "summary"), "内部生命周期不能重复读取完整仓库和任务");
  } finally { await new Promise<void>(done => server.close(() => done())); await rm(home, { recursive: true, force: true }); }
});
