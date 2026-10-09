import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { AnalysisStore } from "../src/index/store.js";
import { WorkerManager } from "../src/index/worker-manager.js";
import { SessionStore } from "../src/sessions/store.js";
import { startService } from "../src/server.js";
import { apiRequest, delay } from "../src/service/runtime.js";
import type { SessionJob } from "../src/session-contracts.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

const execute = promisify(execFile);

test("自动任务跨标签页合并，完成后间隔内不重复；手动范围不被改写", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-auto-"));
  const history = join(directory, "history"); await mkdir(history);
  await writeFile(join(history, "session.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "auto-fixture" } }) + "\n");
  const index = new AnalysisStore(join(directory, "index.sqlite"));
  const library = new SessionStore(index.dbPath);
  const manager = new WorkerManager(index, { roots: isolatedHistoryRoots({ codex: history }) }, library);
  try {
    const now = Date.now();
    const first = manager.autoRefreshSessions(now)!;
    assert.equal(first.client, undefined);
    assert.equal(first.mode, "quick");
    assert.equal(manager.autoRefreshSessions(now + 10)?.id, first.id);
    for (let count = 0; count < 300 && library.getJob(first.id).status !== "complete"; count++) {
      assert.notEqual(library.getJob(first.id).status, "failed"); await delay(20);
    }
    assert.equal(library.getJob(first.id).status, "complete");
    // 完成消息可能尚在主线程事件队列中，等待被调度器消费。
    await delay(30);
    assert.equal(manager.autoRefreshSessions(now + 59_999), undefined);
    const second = manager.autoRefreshSessions(now + 60_000)!;
    assert.notEqual(second.id, first.id);
    const manual = manager.refreshSessions(false, { client: "claude", mode: "full" });
    assert.equal(manual.client, "claude"); assert.equal(manual.mode, "full");
    assert.notEqual(manual.id, second.id);
    const repoPath = join(directory, "repo"); await mkdir(repoPath);
    await execute("git", ["init", "-q", repoPath]);
    await writeFile(join(repoPath, "a.ts"), "export const a = 1;\n");
    const repository = await index.registerRepository(repoPath);
    const map = manager.autoRefreshRepository(repository.id, now)!;
    assert.equal(manager.autoRefreshRepository(repository.id, now + 10)?.id, map.id);
    await manager.waitForJob(map.id);
    assert.equal(index.getJob(map.id).status, "completed");
    assert.equal(manager.autoRefreshRepository(repository.id, now + 59_999), undefined);
  } finally { await manager.close(); library.close(); index.close(); await rm(directory, { recursive: true, force: true }); }
});

test("HTTP 自动刷新只接受空请求，既有未完成任务不会被多页重复入队", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-auto-http-"));
  const service = await startService({ home: directory, roots: isolatedHistoryRoots(), startupRefresh: false });
  try {
    await assert.rejects(apiRequest(service.instance, "/sessions/auto-refresh", "POST", { client: "codex" }), { code: "INVALID_INPUT" });
    const first = await apiRequest<{ job?: SessionJob }>(service.instance, "/sessions/auto-refresh", "POST");
    assert.ok(first.job);
    const second = await apiRequest<{ job?: SessionJob }>(service.instance, "/sessions/auto-refresh", "POST", {});
    assert.ok(!second.job || second.job.id === first.job.id);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
