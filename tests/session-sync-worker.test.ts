import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { AnalysisStore } from "../src/index/store.js";
import { WorkerManager } from "../src/index/worker-manager.js";
import { SessionStore } from "../src/sessions/store.js";
import { SessionAutoSyncScheduler } from "../src/service/session-auto-sync.js";
import { delay } from "../src/service/runtime.js";
import { preferencesPath, subscribePreferences, updatePreferences } from "../src/service/preferences.js";
import type { SessionJob } from "../src/session-contracts.js";

async function controlledWorker(holdNotice = false) {
  const directory = await mkdtemp(join(tmpdir(), "manor-sync-worker-"));
  const script = join(directory, "worker.mjs");
  const release = join(directory, "release");
  const notice = join(directory, "notice");
  await writeFile(script, `import { parentPort, workerData } from 'node:worker_threads';
import { existsSync } from 'node:fs';
const { register } = await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))});
register();
const { SessionStore } = await import(${JSON.stringify(new URL("../src/sessions/store.ts", import.meta.url).href)});
const store = new SessionStore(workerData.dbPath);
let queue = Promise.resolve();
parentPort.on('message', message => {
  if (message.type !== 'sessions') return;
  queue = queue.then(async () => {
    store.updateJob(message.jobId, { status: 'running' });
    while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 5));
    store.updateJob(message.jobId, { status: 'complete', phase: 'complete', progress: 1, finishedAt: new Date().toISOString() });
    while (${JSON.stringify(holdNotice)} && !existsSync(${JSON.stringify(notice)})) await new Promise(resolve => setTimeout(resolve, 5));
    parentPort.postMessage({ jobId: message.jobId });
  });
});
`);
  const store = new AnalysisStore(join(directory, "index.sqlite"));
  const library = new SessionStore(store.dbPath);
  const worker = new WorkerManager(store, { workerUrl: pathToFileURL(script) }, library);
  return { directory, library, worker, release: () => writeFile(release, "ready"), notify: () => writeFile(notice, "ready"), close: async () => {
    await worker.close(); library.close(); store.close(); await rm(directory, { recursive: true, force: true });
  } };
}

async function waitForComplete(library: SessionStore, job: SessionJob) {
  for (let count = 0; count < 500 && library.getJob(job.id).status !== "complete"; count++) {
    assert.notEqual(library.getJob(job.id).status, "failed"); await delay(10);
  }
  assert.equal(library.getJob(job.id).status, "complete");
}

test("真实 Worker 范围与强度复用，局部和快速不吞全局、完整校验或清缓存", async () => {
  const fixture = await controlledWorker();
  const { worker, library } = fixture;
  const changes: SessionJob[] = [];
  const unsubscribe = worker.subscribeChanges(jobs => { changes.push(...jobs); });
  try {
    assert.equal(worker.autoRefreshSessions(), undefined);
    const local = worker.refreshSessions(false, { client: "codex" });
    assert.equal(worker.autoRefreshSessions(), undefined, "旧自动入口不能把局部任务当作全局");
    const global = worker.refreshSessions();
    assert.notEqual(global.id, local.id);
    assert.equal(worker.autoRefreshSessions()?.id, global.id);
    assert.equal(worker.refreshSessions(false, { client: "claude" }).id, global.id);
    const full = worker.refreshSessions(false, { client: "claude", mode: "full" });
    assert.notEqual(full.id, global.id);
    const clear = worker.refreshSessions(true);
    assert.notEqual(clear.id, full.id); assert.equal(clear.mode, "full"); assert.equal(clear.client, undefined);
    assert.equal(worker.refreshSessions(false, { mode: "full" }).id, clear.id);
    assert.equal(worker.refreshSessions(true).id, clear.id);
    assert.equal(worker.activeSessionJobs().length, 4);
    assert.equal(worker.busy, true);
    await fixture.release(); await waitForComplete(library, clear); await delay(20);
    assert.equal(worker.busy, false);
    assert.equal(changes.filter(job => job.status === "queued").length, 4);
    assert.equal(changes.filter(job => job.status === "complete").length, 4);
    assert.equal(worker.autoRefreshSessions(Date.now() + 1_000_000), undefined, "观察已完成任务不触发下一轮");
  } finally { unsubscribe(); await fixture.close(); }
});

test("局部在途时必要自动补查留在 Worker 外，关闭撤销且手动全局任务保留", async () => {
  const fixture = await controlledWorker();
  const { worker, library } = fixture;
  const sync = new SessionAutoSyncScheduler(worker, library.globalCheckState());
  try {
    const local = worker.refreshSessions(false, { client: "claude" });
    sync.updateInterval(5_000);
    assert.equal(sync.status().state, "pending");
    assert.equal(worker.activeSessionJobs().length, 1);
    sync.updateInterval(0);
    const manual = worker.refreshSessions(false, { mode: "full" });
    assert.notEqual(manual.id, local.id);
    assert.equal(worker.activeSessionJobs().length, 2);
    await fixture.release(); await waitForComplete(library, manual); await delay(20);
    assert.equal(sync.status().state, "disabled");
    assert.equal(sync.status().lastSuccessAt, library.getJob(manual.id).finishedAt);
    assert.equal(worker.activeSessionJobs().length, 0);
  } finally { sync.close(); await fixture.close(); }
});

test("持久全局完成基准独立于版本和局部任务，失败计数在全局成功后清零", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-sync-state-"));
  const store = new AnalysisStore(join(directory, "index.sqlite"));
  const library = new SessionStore(store.dbPath);
  try {
    assert.deepEqual(library.globalCheckState(), { consecutiveFailures: 0, lastFinished: undefined, lastSuccessAt: undefined });
    const global = library.createJob();
    library.updateJob(global.id, { status: "complete", finishedAt: "2026-01-01T00:10:00Z", version: "unchanged-version" });
    const partial = library.createJob({ client: "claude" });
    library.updateJob(partial.id, { status: "complete", finishedAt: "2026-01-01T00:20:00Z" });
    const failed = library.createJob({ mode: "full" });
    library.failJob(failed.id, "synthetic failure");
    const state = library.globalCheckState();
    assert.equal(state.lastSuccessAt, "2026-01-01T00:10:00Z");
    assert.equal(state.lastFinished?.id, failed.id); assert.equal(state.consecutiveFailures, 1);
    const retry = library.createJob(); library.updateJob(retry.id, { status: "complete", finishedAt: "2026-01-01T00:30:00Z" });
    assert.equal(library.globalCheckState().consecutiveFailures, 0);
    assert.equal(library.globalCheckState().lastSuccessAt, "2026-01-01T00:30:00Z");
  } finally { library.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("偏好原子保存成功后串行通知同目录后台，保存失败不通知且取消订阅生效", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-sync-preferences-"));
  const observed: number[] = [];
  const unsubscribe = subscribePreferences(directory, preferences => { observed.push(preferences.sessionsAutoRefreshInterval); });
  try {
    await Promise.all([updatePreferences(directory, { sessionsAutoRefreshInterval: 5_000 }), updatePreferences(directory, { mapAutoRefreshInterval: 10_000 })]);
    assert.deepEqual(observed, [5_000, 5_000]);
    await rm(preferencesPath(directory)); await mkdir(preferencesPath(directory));
    await assert.rejects(updatePreferences(directory, { sessionsAutoRefreshInterval: 0 }));
    assert.deepEqual(observed, [5_000, 5_000]);
    await rm(preferencesPath(directory), { recursive: true });
    unsubscribe(); await updatePreferences(directory, { sessionsAutoRefreshInterval: 0 });
    assert.equal(observed.length, 2);
  } finally { unsubscribe(); await rm(directory, { recursive: true, force: true }); }
});

test("真实 Worker 已写完终态但未发送完成通知时，全局周期尚未完成结算", async () => {
  const fixture = await controlledWorker(true);
  const { worker, library } = fixture;
  const sync = new SessionAutoSyncScheduler(worker, library.globalCheckState());
  try {
    sync.updateInterval(5_000);
    const job = worker.activeSessionJobs()[0]!;
    await fixture.release(); await waitForComplete(library, job);
    assert.equal(library.getJob(job.id).status, "complete");
    assert.equal(worker.coveringSessionJob(), undefined);
    assert.equal(worker.busy, true);
    assert.equal(sync.status().lastSuccessAt, undefined);
    assert.equal(sync.status().nextRunAt, undefined);
    await fixture.notify();
    for (let count = 0; count < 500 && !sync.status().nextRunAt; count++) await delay(10);
    assert.equal(sync.status().lastSuccessAt, library.getJob(job.id).finishedAt);
    assert.equal(Date.parse(sync.status().nextRunAt!) - Date.parse(sync.status().lastSuccessAt!), 5_000);
  } finally { sync.close(); await fixture.close(); }
});
