import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ServiceInstance } from "../../../src/contracts.js";
import { VERSION } from "../../../src/version.js";
import { createProgram } from "../src/program.js";

test("status保留原有顶层JSON字段，stop保留原有标记并补充停止完成状态", async () => {
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
    const status = await execute("status");
    for (const [key, value] of Object.entries(payload())) assert.deepEqual(status[key], value, `原有字段 ${key} 仍须位于顶层`);
    assert.equal(status.running, true); assert.equal(status.state, "running"); assert.deepEqual(status.status, payload());
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
