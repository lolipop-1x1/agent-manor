import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProgram } from "../src/program.js";
import { cliErrorOutput } from "../src/entry.js";
import { managementConfirmation } from "../src/api/management.js";
import { waitForTask } from "../src/api/tasks.js";
import { logDelta } from "../src/output/logs.js";
import type { ServiceInstance } from "../../../src/contracts.js";
import { VERSION } from "../../../src/version.js";

test("管理命令先展示具体修订与已发布正文，精确授权后才调用管理API", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-cli-management-"));
  let instance: ServiceInstance;
  let grants = 0, changes = 0;
  const requests: { path: string; body: unknown }[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    const path = new URL(request.url!, "http://127.0.0.1").pathname.replace("/api/v1", "");
    if (path === "/status") { response.end(JSON.stringify({ instance, version: VERSION, protocolVersion: 1 })); return; }
    const buffers: Buffer[] = []; for await (const buffer of request) buffers.push(buffer);
    const body = buffers.length ? JSON.parse(Buffer.concat(buffers).toString()) : undefined;
    requests.push({ path, body });
    if (path === "/knowledge/entries/one") {
      response.end(JSON.stringify({ id: "one", latestRevisionId: "r2", publishedRevisionId: "r1", revisions: [{ id: "r1", body: "previous" }, { id: "r2", body: "corrected", review: "pending" }] }));
    } else if (path === "/management/authorizations") { grants++; response.end(JSON.stringify({ token: "synthetic-one-use-token" })); }
    else {
      assert.equal(request.headers["x-agent-manor-management"], "synthetic-one-use-token");
      assert.equal(request.headers["sec-fetch-site"], undefined);
      changes++; response.end(JSON.stringify({ approved: true }));
    }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  instance = { id: "synthetic-management-service-identity", pid: process.pid, host: "127.0.0.1", port: address.port, startedAt: new Date().toISOString(), version: VERSION, protocolVersion: 1 };
  await writeFile(join(directory, "service.json"), JSON.stringify(instance));
  const oldWrite = process.stdout.write; let output = "";
  process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof process.stdout.write;
  const execute = (args: string[]) => createProgram("en").parseAsync(["--home", directory, "--json", ...args], { from: "user" });
  try {
    const args = ["knowledge", "review", "one", "r2", "approve"];
    const body = { revisionId: "r2", action: "approve", baseRevisionId: "r2" };
    const digest = managementConfirmation("POST", "/knowledge/entries/one/reviews", body);
    await assert.rejects(execute(args), error => {
      const result = JSON.parse(cliErrorOutput(error, "en", true));
      assert.equal(result.error.code, "CONFIRMATION_REQUIRED");
      assert.equal(result.error.details.confirmation, digest);
      assert.equal(result.error.details.preview.publishedRevision.body, "previous");
      assert.equal(result.error.details.preview.targetRevision.body, "corrected");
      assert.match(cliErrorOutput(error, "zh-CN", false), new RegExp(digest));
      return true;
    });
    assert.equal(grants, 0); assert.equal(changes, 0);
    await assert.rejects(execute([...args, "--authorize", "wrong-operation"]), { code: "CONFIRMATION_REQUIRED" });
    assert.equal(grants, 0);
    await assert.rejects(execute(["knowledge", "review", "one", "r1", "approve"]), { code: "CONTENT_STALE" });
    await assert.rejects(execute(["knowledge", "review", "one", "r2", "invalid"]), { code: "INVALID_INPUT" });
    await execute([...args, "--authorize", digest]);
    assert.deepEqual(JSON.parse(output), { approved: true });
    assert.equal(grants, 1); assert.equal(changes, 1);
    assert.deepEqual(requests.find(request => request.path === "/management/authorizations")!.body, { method: "POST", path: "/knowledge/entries/one/reviews", body, confirmation: digest });
    await assert.rejects(execute(["knowledge", "settings", "key", "generation"]), { code: "CONFIRMATION_REQUIRED" });
    assert.equal(grants, 1); assert.equal(changes, 1);
  } finally { process.stdout.write = oldWrite; await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); }
});

test("等待任务保留初始响应元信息并按最终成功、失败、暂停、预算和超时返回", async () => {
  let status = "completed", requests = 0;
  const server = createServer((request, response) => { requests++; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(request.url === "/api/v1/knowledge/index/status" ? { status } : { job: { id: "job1", status } })); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const instance: ServiceInstance = { id: "synthetic-job-service-identity", pid: process.pid, host: "127.0.0.1", port: address.port, startedAt: new Date().toISOString() };
  const exitCode = process.exitCode;
  try {
    const initial = { repository: { id: "repo1" }, job: { id: "job1", status: "queued" } };
    assert.deepEqual(await waitForTask(instance, initial, "1"), { ...initial, job: { id: "job1", status: "completed" } });
    for (status of ["failed", "paused", "budget_stopped", "partial"]) {
      process.exitCode = undefined;
      await waitForTask(instance, initial, "1");
      assert.equal(process.exitCode, 1, status);
    }
    status = "ready"; process.exitCode = undefined;
    assert.deepEqual(await waitForTask(instance, { status: "running" }, "1", "/knowledge/index/status"), { status: "ready" });
    assert.equal(process.exitCode, undefined, "知识索引 ready 是成功终态");
    await waitForTask(instance, initial, "1");
    assert.equal(process.exitCode, 1, "其他任务不能借用知识索引的成功终态");
    status = "running";
    await assert.rejects(waitForTask(instance, initial, "0.01"), { code: "WAIT_TIMEOUT" });
    assert.ok(requests >= 5);
    assert.deepEqual(await waitForTask(instance, { job: null }, "1"), { job: null });
  } finally { process.exitCode = exitCode; await new Promise<void>(done => server.close(() => done())); }
});

test("日志跟随仅返回新增内容，尾部窗口滑动和日志轮换明确区分", () => {
  assert.deepEqual(logDelta("one\ntwo", "one\ntwo\nthree"), { text: "\nthree", reset: false });
  assert.deepEqual(logDelta("one\ntwo", "two\nthree"), { text: "three", reset: false });
  assert.deepEqual(logDelta("one\ntwo", "new log"), { text: "new log", reset: true });
});
