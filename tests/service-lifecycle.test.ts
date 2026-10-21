import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { startService } from "../src/server.js";
import type { ServiceInstance, StatusResponse } from "../src/contracts.js";
import { acquireLock, apiRequest, connectService, DEFAULT_SERVICE_PORT, readServiceLogs, serviceStatus, SERVICE_PROTOCOL_VERSION, startBackground, stopService, waitForPreparation, writeInstance } from "../src/service/runtime.js";
import { serviceLog, serviceLogPath } from "../src/service/logging.js";
import { VERSION } from "../src/version.js";
import { isolatedHistoryRoots, isolatedHistoryEnvironment } from "./helpers/history-roots.js";
import { UsageManager } from "../src/usage/manager.js";
import { WorkerManager } from "../src/index/worker-manager.js";
import { IndexTaskManager } from "../src/index/task-manager.js";
import { AnalysisStore } from "../src/index/store.js";
import { SessionStore } from "../src/sessions/store.js";
import { OverviewManager } from "../src/overview/manager.js";

test("status 和日志读取在未运行时保持纯读，不创建数据目录", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-readonly-")), home = join(directory, "absent");
  try {
    assert.equal((await serviceStatus(home)).state, "stopped");
    assert.deepEqual(await readServiceLogs(home), { path: serviceLogPath(home), text: "" });
    assert.deepEqual(await stopService(home), { stopped: false });
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("默认端口占用后顺延，显式端口占用失败，状态包含协议且停止等待清理完成", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-ports-"));
  const blocker = createServer((_request, reply) => reply.end("synthetic other service"));
  let ownsBlocker = false;
  try {
    try { await new Promise<void>((resolve, reject) => { blocker.once("error", reject); blocker.listen(DEFAULT_SERVICE_PORT, "127.0.0.1", resolve); }); ownsBlocker = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error; }
    const service = await startService({ home: join(directory, "data"), roots: isolatedHistoryRoots(), startupRefresh: false });
    try {
      assert.ok(service.instance.port > DEFAULT_SERVICE_PORT && service.instance.port < DEFAULT_SERVICE_PORT + 100);
      const status = await serviceStatus(join(directory, "data"));
      assert.equal(status.running, true);
      assert.equal(status.status?.protocolVersion, SERVICE_PROTOCOL_VERSION);
      assert.equal(status.status?.preparation?.state, "skipped");
      assert.equal((await connectService(true, join(directory, "data")))?.id, service.instance.id);
      await assert.rejects(startService({ home: join(directory, "conflict"), port: service.instance.port, roots: isolatedHistoryRoots(), startupRefresh: false }), { code: "EADDRINUSE" });
      assert.equal((await serviceStatus(join(directory, "data"))).instance?.id, service.instance.id);
      assert.equal((await stopService(join(directory, "data"))).stopped, true);
      assert.equal((await serviceStatus(join(directory, "data"))).running, false);
      await assert.rejects(readFile(join(directory, "data", "service.json")), { code: "ENOENT" });
    } finally { await service.close(); }
  } finally {
    if (ownsBlocker) await new Promise<void>(resolve => blocker.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("启动先发布 HTTP，再准备绑定版本的历史、用量和默认总览，超时不停止后台", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-readiness-"));
  const service = await startService({ home, port: 0, roots: isolatedHistoryRoots() });
  try {
    const status = await apiRequest<StatusResponse>(service.instance, "/status?summary=true");
    assert.ok(["pending", "running"].includes(status.preparation!.state));
    await assert.rejects(waitForPreparation(service.instance, 0), { code: "WAIT_TIMEOUT" });
    await assert.rejects(stopService(home, { allowBusy: false }), { code: "SERVICE_BUSY" });
    assert.equal((await serviceStatus(home)).running, true);
    const prepared = await waitForPreparation(service.instance, 20_000);
    assert.equal(prepared.preparation?.state, "ready");
    assert.equal(prepared.preparation?.phase, "complete");
    assert.equal(prepared.preparation?.jobIds.length, 1);
    assert.ok(prepared.preparation?.sourceVersion);
    const list = await apiRequest<{ version: string; total: number }>(service.instance, "/sessions");
    assert.equal(list.version, prepared.preparation?.sourceVersion);
    assert.equal(list.total, 0);
    assert.match((await readServiceLogs(home)).text, /preparation.ready/);
  } finally { await service.close(); await rm(home, { recursive: true, force: true }); }
});

test("首次准备覆盖默认总览全部面板与周复盘，完成标记在结果就绪后持久化", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-complete-startup-"));
  const panel = OverviewManager.prototype.panel, review = OverviewManager.prototype.review;
  const calls: string[] = [];
  OverviewManager.prototype.panel = async function(query, name, dimension) {
    calls.push(`${name}:${dimension ?? ""}`);
    return panel.call(this, query, name, dimension);
  };
  OverviewManager.prototype.review = async function(query) { calls.push("review"); return review.call(this, query); };
  const service = await startService({ home, port: 0, roots: isolatedHistoryRoots() });
  try {
    const prepared = await waitForPreparation(service.instance, 30_000);
    for (const name of ["core:", "usage:", "resources:", "process:", "repositories:", "facets:", "distribution:project", "review"]) {
      assert.ok(calls.includes(name), `默认首屏缺少 ${name}`);
    }
    assert.equal(prepared.preparation?.jobIds.length, 1, "空目录只导入历史，不创建仓库任务");
    assert.equal(prepared.preparation?.initial, true);
    const marker = JSON.parse(await readFile(join(home, "startup-prepared.json"), "utf8"));
    assert.equal(marker.sourceVersion, prepared.preparation?.sourceVersion);
    await service.close();
    const next = await startService({ home, port: 0, roots: isolatedHistoryRoots() });
    try { assert.equal((await apiRequest<StatusResponse>(next.instance, "/status?summary=true")).preparation?.initial, false); }
    finally { await next.close(); }
  } finally {
    OverviewManager.prototype.panel = panel; OverviewManager.prototype.review = review;
    await service.close(); await rm(home, { recursive: true, force: true });
  }
});

test("数据准备失败仍保留已发布历史和 HTTP，不把失败标成完成", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-preparation-failure-"));
  const original = UsageManager.prototype.prepare;
  UsageManager.prototype.prepare = async () => { throw new Error("synthetic preparation failure"); };
  const service = await startService({ home, port: 0, roots: isolatedHistoryRoots() });
  try {
    await assert.rejects(waitForPreparation(service.instance, 20_000), { code: "PREPARATION_FAILED" });
    const status = await apiRequest<StatusResponse>(service.instance, "/status?summary=true");
    assert.equal(status.preparation?.state, "failed");
    assert.equal(status.preparation?.initial, true);
    assert.equal(JSON.parse(await readFile(join(home, "startup-prepared.json"), "utf8")).state, "pending");
    assert.equal((await apiRequest<{ total: number }>(service.instance, "/sessions")).total, 0);
    assert.equal((await serviceStatus(home)).running, true);
  } finally { UsageManager.prototype.prepare = original; await service.close(); await rm(home, { recursive: true, force: true }); }
});

test("旧目录已有历史但没有初始化标记时快速复用，显式等待仍等待后台准备", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-existing-startup-"));
  const index = new AnalysisStore(join(home, "index.sqlite")), sessions = new SessionStore(index.dbPath);
  const version = sessions.publish(sessions.createJob().id, [], []);
  sessions.close(); index.close();
  const original = IndexTaskManager.prototype.refreshSessions;
  IndexTaskManager.prototype.refreshSessions = async function() { return (this as unknown as { sessions: SessionStore }).sessions.createJob(); };
  const service = await startService({ home, port: 0, roots: isolatedHistoryRoots() });
  try {
    const status = await apiRequest<StatusResponse>(service.instance, "/status?summary=true&response=summary");
    assert.equal(status.preparation?.initial, false);
    assert.equal(status.sessions?.version, version);
    assert.equal((await startBackground(home, { waitData: "initial", timeoutMs: 0 })).id, service.instance.id);
    await assert.rejects(startBackground(home, { waitData: true, timeoutMs: 0 }), { code: "WAIT_TIMEOUT" });
  } finally { IndexTaskManager.prototype.refreshSessions = original; await service.close(); await rm(home, { recursive: true, force: true }); }
});

test("首次历史已发布但缓存失败后，重启仍等待完整准备", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-pending-startup-"));
  const original = UsageManager.prototype.prepare;
  UsageManager.prototype.prepare = async () => { throw new Error("synthetic preparation failure"); };
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  try {
    service = await startService({ home, port: 0, roots: isolatedHistoryRoots() });
    await assert.rejects(waitForPreparation(service.instance, 20_000), { code: "PREPARATION_FAILED" });
    assert.ok((await apiRequest<StatusResponse>(service.instance, "/status?summary=true")).sessions?.version);
    await service.close();
    service = await startService({ home, port: 0, roots: isolatedHistoryRoots() });
    assert.equal((await apiRequest<StatusResponse>(service.instance, "/status?summary=true")).preparation?.initial, true);
  } finally { UsageManager.prototype.prepare = original; await service?.close(); await rm(home, { recursive: true, force: true }); }
});

test("启动精简状态显示仓库完成数、当前任务和阶段进度，任务切换后清理旧信息", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-startup-map-progress-"));
  const index = new AnalysisStore(join(home, "index.sqlite"));
  for (const name of ["sample-alpha", "sample-beta", "sample-gamma"]) {
    const path = join(home, name);
    execFileSync("git", ["init", "--quiet", path]);
    await index.registerRepository(path);
  }
  const original = IndexTaskManager.prototype.refresh;
  const tasks: { store: AnalysisStore; id: string; name: string }[] = [];
  IndexTaskManager.prototype.refresh = async function(repositoryId: string) {
    const store = index, job = store.createJob(repositoryId);
    const position = tasks.length;
    store.updateJob(job.id, { status: position === 0 ? "completed" : position === 1 ? "running" : "queued",
      phase: position === 2 ? "等待分析" : "对应当前源码",
      phaseDescriptor: { key: position === 2 ? "diagnostics.index.store.m006" : "diagnostics.index.refresh.m006" },
      progress: position === 0 ? 1 : position === 1 ? 0.65 : 0 });
    tasks.push({ store, id: job.id, name: store.getRepository(repositoryId).name });
    return store.getJob(job.id);
  };
  const service = await startService({ home, port: 0, roots: isolatedHistoryRoots() });
  const progress = async (completed: number, expectedProgress?: number) => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const status = await apiRequest<StatusResponse>(service.instance, "/status?summary=true&response=summary");
      if (status.preparation?.phase === "maps" && status.preparation.completed === completed
        && (expectedProgress === undefined || status.preparation.repository?.progress === expectedProgress)) return status;
      if (Date.now() > deadline) { assert.fail("仓库准备状态未推进"); }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    let status = await progress(1);
    assert.equal(status.preparation?.total, 3);
    assert.equal(status.preparation?.repository?.name, tasks[1]!.name);
    assert.equal(status.preparation?.repository?.progress, 0.65);
    assert.equal(status.preparation?.repository?.phaseDescriptor?.key, "diagnostics.index.refresh.m006");
    assert.equal(status.jobs, undefined);
    assert.equal(JSON.stringify(status.preparation).includes(home), false);
    tasks[1]!.store.updateJob(tasks[1]!.id, { status: "completed", progress: 1 });
    status = await progress(2, 0);
    assert.equal(status.preparation?.repository?.name, tasks[2]!.name);
    assert.equal(status.preparation?.repository?.phaseDescriptor?.key, "diagnostics.index.store.m006");
    tasks[2]!.store.updateJob(tasks[2]!.id, { status: "running", phase: "发布完整结果", phaseDescriptor: { key: "diagnostics.index.refresh.m007" }, progress: 0.95 });
    status = await progress(2, 0.95);
    assert.equal(status.preparation?.repository?.name, tasks[2]!.name);
    assert.equal(status.preparation?.repository?.progress, 0.95);
    tasks[2]!.store.updateJob(tasks[2]!.id, { status: "completed", progress: 1 });
    assert.equal((await waitForPreparation(service.instance, 30_000)).preparation?.repository, undefined);
  } finally { IndexTaskManager.prototype.refresh = original; await service.close(); index.close(); await rm(home, { recursive: true, force: true }); }
});

test("真实后台首次准备的长等待不占用启动锁，并发启动复用同一实例", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-startup-unlock-"));
  const before = { ...process.env };
  Object.assign(process.env, isolatedHistoryEnvironment(home));
  let observed = false;
  try {
    const first = startBackground(home, { port: 0, waitData: "initial", timeoutMs: 30_000, onProgress(status) {
      assert.equal(existsSync(join(home, "startup.lock")), false);
      if (status.preparation?.state === "running") observed = true;
    } });
    let instance: ServiceInstance | undefined;
    for (let attempt = 0; attempt < 200 && !instance; attempt += 1) {
      instance = (await serviceStatus(home, { summary: true })).instance;
      if (!instance) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(instance);
    const second = await startBackground(home, { waitData: "initial", timeoutMs: 30_000 });
    assert.equal((await first).id, second.id);
    assert.ok(observed);
  } finally {
    await stopService(home, { allowBusy: true }).catch(() => undefined);
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before); await rm(home, { recursive: true, force: true });
  }
});

test("地址上的其他进程、PID 复用和不同版本不会被误用或误停", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-identity-"));
  let response: unknown, stops = 0;
  const server = createServer((request, reply) => { if (request.url?.includes("stop")) stops++; reply.setHeader("content-type", "application/json"); reply.end(JSON.stringify(response)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const instance: ServiceInstance = { id: randomUUID(), pid: process.pid, host: "127.0.0.1", port: address.port, startedAt: new Date().toISOString() };
  try {
    await writeInstance(home, instance);
    response = { instance: { ...instance, id: randomUUID() }, version: VERSION, protocolVersion: SERVICE_PROTOCOL_VERSION };
    assert.equal((await serviceStatus(home)).state, "foreign");
    await assert.rejects(stopService(home), { code: "SERVICE_IDENTITY_UNVERIFIED" });
    await assert.rejects(connectService(true, home), { code: "SERVICE_IDENTITY_UNVERIFIED" });
    response = { instance, version: "synthetic-other-version", protocolVersion: SERVICE_PROTOCOL_VERSION, activeTasks: [] };
    await assert.rejects(connectService(true, home), { code: "SERVICE_VERSION_MISMATCH" });
    response = { instance, version: "synthetic-legacy-version", activeTasks: [] };
    await assert.rejects(stopService(home), { code: "SERVICE_VERSION_MISMATCH" });
    assert.equal(stops, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
});

test("生命周期日志轮换保留五份并限制权限，读取参数非法时拒绝", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-logs-"));
  try {
    for (let index = 0; index < 10; index++) serviceLog(home, "synthetic.stage", { index }, 100);
    const files = await readdir(join(home, "logs"));
    assert.equal(files.length, 5);
    assert.match((await readServiceLogs(home, { lines: 1 })).text, /"index":9/);
    if (process.platform !== "win32") assert.equal((await stat(serviceLogPath(home))).mode & 0o777, 0o600);
    await assert.rejects(readServiceLogs(home, { lines: -1 }), { code: "INVALID_INPUT" });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("更新锁阻止普通查询重新启动后台，状态和日志仍可纯读", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-updating-")), release = await acquireLock(home, "update.lock");
  try {
    await assert.rejects(connectService(true, home), { code: "SERVICE_BUSY" });
    await assert.rejects(startService({ home, roots: isolatedHistoryRoots(), startupRefresh: false }), { code: "SERVICE_BUSY" });
    assert.equal((await serviceStatus(home)).state, "stopped");
    assert.equal((await readServiceLogs(home)).text, "");
    assert.deepEqual(await readdir(home), ["update.lock"]);
  } finally { await release(); await rm(home, { recursive: true, force: true }); }
});

test("无任务 Worker 可以直接关闭，首次任务初始化中关闭会收束任务而不打断原生注册", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-worker-lazy-"));
  const index = new AnalysisStore(join(home, "index.sqlite")), sessions = new SessionStore(index.dbPath);
  try {
    const idle = new WorkerManager(index, { roots: isolatedHistoryRoots() }, sessions);
    await idle.close();
    assert.throws(() => idle.refreshSessions(), /不可用/);
    const manager = new WorkerManager(index, { roots: isolatedHistoryRoots() }, sessions);
    const job = manager.refreshSessions();
    await manager.close();
    assert.ok(["complete", "failed"].includes(sessions.getJob(job.id).status));
    assert.equal(manager.busy, false);
  } finally { sessions.close(); index.close(); await rm(home, { recursive: true, force: true }); }
});
