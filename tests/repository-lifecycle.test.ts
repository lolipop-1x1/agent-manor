import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Worker } from "node:worker_threads";
import test from "node:test";
import Database from "better-sqlite3";
import { AnalysisStore, JobCancelledError, StoreError } from "../src/index/store.js";
import type { PublishInput } from "../src/index/store.js";
import { WorkerManager } from "../src/index/worker-manager.js";
import { refreshRepository } from "../src/index/refresh.js";
import { SessionStore } from "../src/sessions/store.js";
import { refreshSessions } from "../src/sessions/refresh.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

const git = promisify(execFile);
const repositoryTables = ["manual_associations", "jobs", "versions", "source_cache", "mapping_cache", "tracked_sources", "payload_parts"];

async function fixture(run: (context: { directory: string; store: AnalysisStore; sessions: SessionStore; first: string; second: string; history: string }) => Promise<void>): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-repository-lifecycle-")));
  const first = join(directory, "first");
  const second = join(directory, "second");
  const history = join(directory, "history");
  for (const path of [first, second, history]) await mkdir(path);
  for (const path of [first, second]) {
    await git("git", ["init", "-q", path]);
    await writeFile(join(path, "a.ts"), "alpha\nbeta\n");
  }
  await writeFile(join(history, "synthetic.jsonl"), [
    { type: "session_meta", payload: { id: "synthetic-lifecycle", cwd: first } },
    { type: "response_item", payload: { type: "message", id: "user", role: "user", content: [{ type: "input_text", text: "人工合成问题" }] } },
    { type: "response_item", payload: { type: "function_call", name: "shell_command", call_id: "read", arguments: JSON.stringify({ command: "cat a.ts", workdir: first }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "read", output: "Exit code: 0\nOutput:\nalpha\nbeta\n" } },
  ].map(record => `${JSON.stringify(record)}\n`).join(""));
  const store = new AnalysisStore(join(directory, "index.sqlite"));
  const sessions = new SessionStore(store.dbPath);
  try { await run({ directory, store, sessions, first, second, history }); }
  finally { sessions.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
}

const tableRows = (database: Database.Database, table: string, repositoryId?: string) => database.prepare(repositoryId
  ? `SELECT * FROM ${table} WHERE repository_id=?` : `SELECT * FROM ${table}`).all(...(repositoryId ? [repositoryId] : []))
  .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
const publishInput = (store: AnalysisStore, repositoryId: string, jobId: string, version: string): PublishInput => ({
  snapshot: { ...store.getSnapshot(repositoryId), version }, sources: { ...store.listSources(repositoryId), version },
  parsed: store.getParsedSources(repositoryId), mappings: [],
  stats: { sourcesParsed: 0, parsedRecords: 0, mappingsComputed: 0, mappingsReused: 0 }, clearCache: true, jobId,
});

test("登记复用 Git 根路径，重复登记不新建，worktree 保持独立身份", async () => fixture(async ({ directory, store, first }) => {
  const created = await store.registerRepositoryResult(first);
  assert.equal(created.created, true);
  const subdirectory = join(first, "subdirectory");
  await mkdir(subdirectory);
  const reused = await store.registerRepositoryResult(subdirectory);
  assert.equal(reused.created, false);
  assert.equal(reused.repository.id, created.repository.id);
  assert.equal(reused.repository.path, first);
  await git("git", ["-C", first, "add", "a.ts"]);
  await git("git", ["-C", first, "-c", "user.name=synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "fixture"]);
  const worktree = join(directory, "worktree");
  await git("git", ["-C", first, "worktree", "add", "-qb", "synthetic-worktree", worktree]);
  const independent = await store.registerRepositoryResult(worktree);
  assert.equal(independent.created, true);
  assert.notEqual(independent.repository.id, created.repository.id);
  assert.equal(independent.repository.commonDir, created.repository.commonDir);
  await assert.rejects(store.registerRepositoryResult(directory), /git/i);
}));

test("删除清理所有专属表，保留其他仓库和全局会话，末尾失败完整回滚", async () => fixture(async ({ store, sessions, first, second, history }) => {
  const target = await store.registerRepository(first);
  const other = await store.registerRepository(second);
  const roots = isolatedHistoryRoots({ codex: history });
  await refreshRepository(store, store.createJob(target.id).id, roots);
  store.associateSource(target.id, store.listSources(target.id).sources[0]!.sourceId);
  await refreshRepository(store, store.createJob(target.id).id, roots, true);
  await refreshRepository(store, store.createJob(other.id).id, roots);
  await refreshSessions(sessions, sessions.createJob().id, roots);
  assert.ok(sessions.list().total > 0);
  const pending = store.createJob(target.id);
  const database = new Database(store.dbPath);
  try {
    const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_fts%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
    const before = new Map(tables.map(table => [table, tableRows(database, table)]));
    for (const table of repositoryTables) assert.ok(tableRows(database, table, target.id).length > 0, table);
    database.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON repositories BEGIN SELECT RAISE(ABORT,'synthetic delete failure'); END");
    assert.throws(() => store.deleteRepository(target.id), /synthetic delete failure/);
    for (const table of tables) assert.deepEqual(tableRows(database, table), before.get(table), `回滚 ${table}`);
    assert.equal(store.getJob(pending.id).status, "queued");
    database.exec("DROP TRIGGER reject_delete");
    const otherRows = new Map(repositoryTables.map(table => [table, tableRows(database, table, other.id)]));
    const removed = store.deleteRepository(target.id);
    assert.ok(removed.some(job => job.id === pending.id));
    for (const table of repositoryTables) {
      assert.equal(tableRows(database, table, target.id).length, 0, table);
      assert.deepEqual(tableRows(database, table, other.id), otherRows.get(table), `保留 ${table}`);
    }
    for (const table of tables.filter(table => table.startsWith("session_"))) assert.deepEqual(tableRows(database, table), before.get(table), `保留 ${table}`);
    assert.throws(() => store.getRepository(target.id), error => error instanceof StoreError && error.code === "REPOSITORY_NOT_FOUND");
    assert.throws(() => store.getJob(pending.id), error => error instanceof StoreError && error.code === "JOB_NOT_FOUND");
    assert.equal(await readFile(join(first, "a.ts"), "utf8"), "alpha\nbeta\n");
    assert.ok((await readFile(join(history, "synthetic.jsonl"), "utf8")).includes("人工合成问题"));
    assert.equal(store.getSnapshot(other.id).baseline.files.length, 1);
  } finally { database.close(); }
}));

test("发布事务拒绝失效和错配任务，发布先提交与删除先提交都不会恢复旧结果", async () => fixture(async ({ store, first, second, history }) => {
  const target = await store.registerRepository(first);
  const other = await store.registerRepository(second);
  await refreshRepository(store, store.createJob(target.id).id, isolatedHistoryRoots({ codex: history }));
  const queued = store.createJob(target.id);
  const input = publishInput(store, target.id, queued.id, "synthetic-next");
  assert.throws(() => store.publish(input), JobCancelledError);
  const mismatch = store.createJob(other.id);
  store.updateJob(mismatch.id, { status: "running" });
  assert.throws(() => store.publish({ ...input, jobId: mismatch.id }), JobCancelledError);
  store.updateJob(queued.id, { status: "running" });
  const otherConnection = new AnalysisStore(store.dbPath);
  try {
    otherConnection.publish(input);
    assert.equal(store.getRepository(target.id).version, input.snapshot.version);
    store.deleteRepository(target.id);
    const registered = await store.registerRepositoryResult(first);
    assert.equal(registered.created, true);
    assert.equal(registered.repository.id, target.id);
    const current = store.createJob(target.id);
    assert.throws(() => otherConnection.publish({ ...input, snapshot: { ...input.snapshot, version: "synthetic-late" } }), JobCancelledError);
    assert.equal(store.getRepository(target.id).version, undefined);
    assert.equal(store.findJob(queued.id), undefined);
    assert.equal(store.failJob(queued.id, "迟到的旧失败"), undefined);
    assert.equal(store.getJob(current.id).status, "queued");
    await refreshRepository(store, current.id, isolatedHistoryRoots({ codex: history }));
    assert.equal(store.getJob(current.id).status, "completed");
    assert.notEqual(store.getRepository(target.id).version, input.snapshot.version);
    assert.equal(store.getManualAssociations(target.id).size, 0);
  } finally { otherConnection.close(); }
}));

/** 测试 Worker 在真实更新或发布边界暂停，主线程通过共享原子变量放行。 */
async function controlledManager(store: AnalysisStore, sessions: SessionStore, directory: string, history: string, boundary: "running" | "publish" | "published") {
  const script = join(directory, `controlled-${boundary}.mjs`);
  const storeUrl = new URL("../src/index/store.ts", import.meta.url).href;
  const workerUrl = new URL("../src/worker.ts", import.meta.url).href;
  await writeFile(script, `import { parentPort } from 'node:worker_threads';
const control = await new Promise(resolve => parentPort.once('message', resolve));
const { register } = await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))});
register();
const { AnalysisStore } = await import(${JSON.stringify(storeUrl)});
const signal = new Int32Array(control.signal);
let paused = false;
function pause(jobId) {
  if (paused) return;
  paused = true;
  parentPort.postMessage({ testBarrier: jobId });
  if (Atomics.wait(signal, 0, 0, 10000) === 'timed-out') throw new Error('synthetic barrier timeout');
}
const originalUpdate = AnalysisStore.prototype.updateJob;
AnalysisStore.prototype.updateJob = function(id, changes) {
  const result = originalUpdate.call(this, id, changes);
  if (${JSON.stringify(boundary)} === 'running' && changes.status === 'running') pause(id);
  return result;
};
const originalPublish = AnalysisStore.prototype.publish;
AnalysisStore.prototype.publish = function(input) {
  if (${JSON.stringify(boundary)} === 'publish') pause(input.jobId);
  const result = originalPublish.call(this, input);
  if (${JSON.stringify(boundary)} === 'published') pause(input.jobId);
  return result;
};
await import(${JSON.stringify(workerUrl)});
parentPort.postMessage({ testReady: true });
`);
  const manager = new WorkerManager(store, { roots: isolatedHistoryRoots({ codex: history }), workerUrl: new URL(`file://${script}`) }, sessions);
  const worker = (manager as unknown as { worker: Worker }).worker;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const ready = once(worker, "message");
  worker.postMessage({ signal: signal.buffer });
  assert.deepEqual((await ready)[0], { testReady: true });
  return { manager, worker, release: () => { Atomics.store(signal, 0, 1); Atomics.notify(signal, 0); } };
}

for (const boundary of ["running", "publish", "published"] as const) {
  test(`可控 ${boundary} 边界：取消运行与排队旧任务，立即重登，其他地图和会话继续`, { timeout: 15_000 }, async () => fixture(async ({ directory, store, sessions, first, second, history }) => {
    const target = await store.registerRepository(first);
    const other = await store.registerRepository(second);
    const control = await controlledManager(store, sessions, directory, history, boundary);
    const { manager } = control;
    try {
      const paused = once(control.worker, "message");
      const running = manager.refresh(target.id);
      const waitingRunning = manager.waitForJob(running.id);
      const queued = manager.refresh(target.id);
      const waitingQueued = manager.waitForJob(queued.id);
      const remaining = manager.refresh(other.id);
      const waitingRemaining = manager.waitForJob(remaining.id);
      const sessionJob = manager.refreshSessions();
      assert.deepEqual((await paused)[0], { testBarrier: running.id });
      assert.equal(store.getJob(running.id).status, boundary === "published" ? "completed" : "running");
      assert.equal(store.getJob(queued.id).status, "queued");
      manager.deleteRepository(target.id);
      assert.equal((await waitingRunning).status, "cancelled");
      assert.equal((await waitingQueued).status, "cancelled");
      assert.equal((await manager.waitForJob(running.id)).status, "cancelled");
      assert.equal(store.findJob(running.id), undefined);
      assert.equal(store.findJob(queued.id), undefined);
      const registered = await store.registerRepositoryResult(first);
      assert.equal(registered.created, true);
      assert.equal(registered.repository.id, target.id);
      const newJob = manager.refresh(registered.repository.id);
      const waitingNew = manager.waitForJob(newJob.id);
      assert.notEqual(newJob.id, running.id);
      control.release();
      assert.equal((await waitingRemaining).status, "completed");
      assert.equal((await waitingNew).status, "completed");
      assert.equal(sessions.getJob(sessionJob.id).status, "complete");
      assert.equal(sessions.list().total, 1);
      assert.equal(store.findJob(running.id), undefined);
      assert.equal(store.findJob(queued.id), undefined);
      assert.ok(store.listJobs().every(job => job.status === "completed"));
      assert.equal(store.getSnapshot(target.id).baseline.files.length, 1);
      assert.equal(store.getSnapshot(other.id).baseline.files.length, 1);
      assert.equal(manager.autoRefreshRepository(target.id, Date.now(), 60_000), undefined);
    } finally { control.release(); await manager.close(); }
  }));
}

test("删除事务失败不取消运行任务，Worker 仍能完成原任务", { timeout: 15_000 }, async () => fixture(async ({ directory, store, sessions, first, history }) => {
  const target = await store.registerRepository(first);
  const control = await controlledManager(store, sessions, directory, history, "running");
  const database = new Database(store.dbPath);
  try {
    const paused = once(control.worker, "message");
    const job = control.manager.refresh(target.id);
    const waiting = control.manager.waitForJob(job.id);
    await paused;
    database.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON repositories BEGIN SELECT RAISE(ABORT,'synthetic delete failure'); END");
    assert.throws(() => control.manager.deleteRepository(target.id), /synthetic delete failure/);
    assert.equal(store.getJob(job.id).status, "running");
    assert.deepEqual(control.manager.autoRefreshRepository(target.id), store.getJob(job.id));
    database.exec("DROP TRIGGER reject_delete");
    control.release();
    assert.equal((await waiting).status, "completed");
    assert.equal(store.getJob(job.id).status, "completed");
  } finally { control.release(); await control.manager.close(); database.close(); }
}));
