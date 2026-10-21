import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import Database from "better-sqlite3";
import { AnalysisStore } from "../src/index/store.js";
import { WorkerManager } from "../src/index/worker-manager.js";
import { SessionStore } from "../src/sessions/store.js";
import { SessionAutoSyncScheduler } from "../src/service/session-auto-sync.js";
import { delay } from "../src/service/runtime.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await delay(10);
  assert.ok(check(), "等待隔离任务状态超时");
}
async function fixture(failure: "maps" | "sessions" | undefined, run: (value: {
  manager: WorkerManager; store: AnalysisStore; sessions: SessionStore; repositoryId: string; release(): Promise<void>; crash(): Promise<void>; crashReady(): boolean;
}) => Promise<void>, gateFailure = false) {
  const directory = await mkdtemp(join(tmpdir(), "manor-task-isolation-"));
  const path = join(directory, "repo"), release = join(directory, "release"), marker = join(directory, "failed-once");
  await mkdir(path); await promisify(execFile)("git", ["init", "-q", path]);
  const crash = join(directory, "crash"), crashReady = join(directory, "crash-ready");
  if (!gateFailure) await writeFile(crash, "ready");
  const script = join(directory, "worker.mjs");
  await writeFile(script, `import { parentPort, workerData } from 'node:worker_threads';
import { existsSync, writeFileSync } from 'node:fs';
const { register } = await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))}); register();
const { AnalysisStore } = await import(${JSON.stringify(new URL("../src/index/store.ts", import.meta.url).href)});
const { SessionStore } = await import(${JSON.stringify(new URL("../src/sessions/store.ts", import.meta.url).href)});
const { refreshSessions } = await import(${JSON.stringify(new URL("../src/sessions/refresh.ts", import.meta.url).href)});
const store = new AnalysisStore(workerData.dbPath), sessions = new SessionStore(workerData.dbPath);
let queue = Promise.resolve();
parentPort.on('message', message => {
  if (!['refresh', 'sessions'].includes(message.type)) return;
  queue = queue.then(async () => {
    const kind = message.type === 'refresh' ? 'maps' : 'sessions';
    if (kind === ${JSON.stringify(failure)} && !existsSync(${JSON.stringify(marker)})) {
      writeFileSync(${JSON.stringify(crashReady)}, 'ready');
      while (!existsSync(${JSON.stringify(crash)})) await new Promise(resolve => setTimeout(resolve, 5));
      writeFileSync(${JSON.stringify(marker)}, 'failed'); throw new Error('synthetic isolated Worker failure');
    }
    if (message.type === 'sessions') await refreshSessions(sessions, message.jobId, workerData.roots);
    else {
      store.updateJob(message.jobId, {status:'running'});
      while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 5));
      store.updateJob(message.jobId, {status:'completed', progress:1, finishedAt:new Date().toISOString()});
    }
    parentPort.postMessage({jobId:message.jobId});
  });
});`);
  const store = new AnalysisStore(join(directory, "index.sqlite")), sessions = new SessionStore(store.dbPath);
  const repository = await store.registerRepository(path);
  const manager = new WorkerManager(store, { roots: isolatedHistoryRoots(), workerUrl: pathToFileURL(script), sessionWorkerUrl: pathToFileURL(script) }, sessions);
  try { await run({ manager, store, sessions, repositoryId: repository.id, release: () => writeFile(release, "ready"), crash: () => writeFile(crash, "ready"), crashReady: () => existsSync(crashReady) }); }
  finally { await writeFile(crash, "ready"); await writeFile(release, "ready"); await manager.close(); sessions.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
}

test("地图队列被阻塞时会话同步仍能完成，地图保持自己的顺序", async () => fixture(undefined, async ({ manager, store, sessions, repositoryId, release }) => {
  const map = manager.refresh(repositoryId);
  await until(() => store.getJob(map.id).status === "running");
  const history = manager.refreshSessions();
  await until(() => sessions.getJob(history.id).status === "complete");
  assert.equal(store.getJob(map.id).status, "running");
  await release(); assert.equal((await manager.waitForJob(map.id)).status, "completed");
}));

for (const failure of ["maps", "sessions"] as const) test(`${failure} Worker 崩溃只影响本类任务，另一类完成且可以单独重试`, async () => fixture(failure, async ({ manager, store, sessions, repositoryId, release }) => {
  const map = manager.refresh(repositoryId), history = manager.refreshSessions();
  if (failure === "maps") {
    assert.equal((await manager.waitForJob(map.id)).status, "failed");
    await until(() => sessions.getJob(history.id).status === "complete");
    await release(); assert.equal((await manager.waitForJob(manager.refresh(repositoryId).id)).status, "completed");
  } else {
    await until(() => sessions.getJob(history.id).status === "failed");
    assert.notEqual(store.getJob(map.id).status, "failed");
    await release(); assert.equal((await manager.waitForJob(map.id)).status, "completed");
    const retry = manager.refreshSessions(); await until(() => sessions.getJob(retry.id).status === "complete");
  }
}));

test("地图忙碌不延后后台自动会话同步", async () => fixture(undefined, async ({ manager, store, sessions, repositoryId }) => {
  const map = manager.refresh(repositoryId);
  await until(() => store.getJob(map.id).status === "running");
  const sync = new SessionAutoSyncScheduler(manager, sessions.globalCheckState());
  try { sync.updateInterval(5000); assert.equal(manager.activeSessionJobs().length, 1); }
  finally { sync.close(); }
}));

test("Worker 崩溃结算遇写锁时等待重试，不让结算异常终止另一类任务", async () => fixture("maps", async ({ manager, store, sessions, repositoryId, crash, crashReady }) => {
  // 将测试连接改为立即报锁冲突，明确覆盖失败结算路径而不冻结测试驱动。
  (store as unknown as { database: Database.Database }).database.pragma("busy_timeout = 0");
  const map = manager.refresh(repositoryId), history = manager.refreshSessions();
  await until(crashReady);
  const blocker = new Database(store.dbPath);
  blocker.exec("BEGIN IMMEDIATE");
  const timer = setTimeout(() => blocker.exec("ROLLBACK"), 800);
  await crash();
  try {
    await until(() => store.getJob(map.id).status === "failed");
    await until(() => sessions.getJob(history.id).status === "complete");
    assert.match(store.getJob(map.id).error!, /synthetic isolated Worker failure/);
  } finally { clearTimeout(timer); if (blocker.inTransaction) blocker.exec("ROLLBACK"); blocker.close(); }
}, true));
