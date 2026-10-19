import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import test from "node:test";
import Database from "better-sqlite3";
import { AnalysisStore } from "../src/index/store.js";
import { SessionStore } from "../src/sessions/store.js";
import { SessionSearchManager } from "../src/sessions/search-manager.js";
import type { SessionSearchResult } from "../src/session-contracts.js";

async function fixture(run: (sessions: SessionStore, manager: SessionSearchManager) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-search-manager-"));
  const path = join(directory, "index.sqlite");
  const analysis = new AnalysisStore(path); analysis.close();
  const sessions = new SessionStore(path);
  const pending = sessions.createRevision("/workspace/search.jsonl", "synthetic");
  for (let ordinal = 0; ordinal < 1200; ordinal++) pending.sink.message({ id: `m-${ordinal}`, ordinal, sessionId: "search", recordLine: ordinal + 1,
    turnId: "turn", kind: "user", text: "事务测试 " + "abcdefgh0123456789".repeat(120) });
  pending.flush();
  sessions.finishRevision(pending.revision, { id: "search", client: "codex", clientSessionId: "search", path: "/workspace/search.jsonl", sourceId: "synthetic",
    title: "合成搜索", titleOrigin: "recorded", messageCount: 1200, turnCount: 1, models: [], gaps: [] });
  sessions.publish(sessions.createJob().id, [{ path: "/workspace/search.jsonl", revision: pending.revision, fingerprint: "synthetic" }], []);
  const manager = new SessionSearchManager(sessions, 1);
  try { await run(sessions, manager); }
  finally { await manager.close(); sessions.close(); await rm(directory, { recursive: true, force: true }); }
}

test("只读搜索 Worker 保留结果和旧版本，合并订阅、队列有界、取消后继续查询", () => fixture(async (sessions, manager) => {
  const version = sessions.currentVersion()!;
  const first = new AbortController(), second = new AbortController();
  const one = manager.execute("groups", { q: "事务" }, first.signal);
  const two = manager.execute("groups", { q: "事务" }, second.signal);
  const waiting = new AbortController();
  const queued = manager.execute("records", { q: "锁" }, waiting.signal);
  await assert.rejects(manager.execute("records", { q: "另" }), error => (error as { code: string }).code === "ANALYSIS_NOT_READY");
  first.abort(); waiting.abort();
  await assert.rejects(one, { name: "AbortError" });
  await assert.rejects(queued, { name: "AbortError" });
  assert.deepEqual(await two, sessions.groupedSearch({ q: "事务", version }));
  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(manager.execute("records", { q: "事务" }, canceled.signal), { name: "AbortError" });
  await assert.rejects(manager.execute("records", { q: "事务", version: "missing" }));
  sessions.publish(sessions.createJob().id, [], []);
  assert.deepEqual(await manager.execute("records", { q: "事务", version }), sessions.search({ q: "事务", version }));
  assert.equal((await manager.execute("records", { q: "事务" }) as SessionSearchResult).total, 0);
  await manager.close();
  await assert.rejects(manager.execute("records", { q: "事务" }));
}));

test("共享取消标志在 SQLite 步进期间被读取，查询退出后连接仍可用", () => fixture(async (sessions) => {
  const cancellation = new Int32Array(new SharedArrayBuffer(8));
  // 子线程只等待信号；主线程进入同步 SQL 后，它仍能独立设置取消位。
  const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
    const flag=new Int32Array(workerData);parentPort.postMessage('ready');
    Atomics.wait(flag,1,0);Atomics.store(flag,0,1);`, { eval: true, workerData: cancellation.buffer });
  try {
    await once(worker, "message");
    sessions.setSearchCancellation(cancellation);
    const database = new Database(sessions.dbPath);
    try { database.exec("UPDATE session_character_search_state SET complete=0"); }
    finally { database.close(); }
    // 在 SQL 真正进入检查点时唤醒另一线程，避免仅测试执行前取消。
    const internal = sessions as unknown as { database: Database.Database };
    let calls = 0;
    internal.database.function("search_test_checkpoint", () => {
      calls++;
      if (calls === 5) { Atomics.store(cancellation, 1, 1); Atomics.notify(cancellation, 1);
        const deadline = Date.now() + 2000;
        while (!Atomics.load(cancellation, 0)) { if (Date.now() > deadline) throw new Error("合成取消线程未响应"); } }
      return 1;
    });
    assert.throws(() => internal.database.prepare(`WITH RECURSIVE records(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM records WHERE n<1000000)
      SELECT SUM(n) FROM records WHERE search_test_checkpoint()=1 AND session_search_active()=1`).get(), /Search cancelled/);
    assert.equal(calls, 5);
    sessions.setSearchCancellation();
    assert.equal(sessions.search({ q: "事务" }).total, 1200);
  } finally { await worker.terminate(); }
}));

test("搜索线程意外停止后拒绝当前订阅并可重新创建，存在性不生成搜索结果", () => fixture(async (sessions, manager) => {
  const pending = manager.execute("records", { q: "事务" });
  const rejected = assert.rejects(pending);
  const internal = manager as unknown as { worker: Worker };
  await internal.worker.terminate();
  await rejected;
  assert.deepEqual(await manager.execute("records", { q: "事务" }), sessions.search({ q: "事务" }));
  sessions.search = () => { throw new Error("存在性不应生成记录结果"); };
  sessions.list = () => { throw new Error("存在性不应生成列表结果"); };
  assert.equal(sessions.matches("search", { q: "事务", page: 99 }).matches, true);
  assert.equal(sessions.matches("search", { page: 99 }).matches, true);
}));
