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
import type { SessionIndexSummary, SessionJob } from "../src/session-contracts.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

const execute = promisify(execFile);

test("会话手动请求合并且范围不被改写；地图仍按独立周期触发", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-auto-"));
  const history = join(directory, "history"); await mkdir(history);
  await writeFile(join(history, "session.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "auto-fixture" } }) + "\n");
  const index = new AnalysisStore(join(directory, "index.sqlite"));
  const library = new SessionStore(index.dbPath);
  const manager = new WorkerManager(index, { roots: isolatedHistoryRoots({ codex: history }) }, library);
  try {
    const now = Date.now();
    const first = manager.refreshSessions();
    assert.equal(first.client, undefined);
    assert.equal(first.mode, "quick");
    assert.equal(manager.refreshSessions().id, first.id);
    for (let count = 0; count < 300 && library.getJob(first.id).status !== "complete"; count++) {
      assert.notEqual(library.getJob(first.id).status, "failed"); await delay(20);
    }
    assert.equal(library.getJob(first.id).status, "complete");
    await delay(30);
    const second = manager.refreshSessions();
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
    assert.equal(manager.autoRefreshRepository(repository.id, now + 5_000, 0), undefined);
    assert.equal(manager.autoRefreshRepository(repository.id, now + 4_999, 5_000), undefined);
    const short = manager.autoRefreshRepository(repository.id, now + 5_000, 5_000)!;
    assert.notEqual(short.id, map.id);
    await manager.waitForJob(short.id);
  } finally { await manager.close(); library.close(); index.close(); await rm(directory, { recursive: true, force: true }); }
});

test("HTTP 旧自动接口只观察后台任务，策略默认关闭且关闭后仍可手动同步", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-auto-http-"));
  const service = await startService({ home: directory, roots: isolatedHistoryRoots(), startupRefresh: false });
  try {
    await assert.rejects(apiRequest(service.instance, "/sessions/auto-refresh", "POST", { client: "codex" }), { code: "INVALID_INPUT" });
    assert.deepEqual(await apiRequest(service.instance, "/sessions/auto-refresh", "POST", {}), { job: null, status: "skipped", reason: "disabled" });
    await apiRequest(service.instance, "/preferences", "PUT", { sessionsAutoRefreshInterval: 5000 });
    let status: SessionIndexSummary | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      status = await apiRequest<SessionIndexSummary>(service.instance, "/sessions/status?summary=true");
      if (status.autoSync?.job || status.autoSync?.lastSuccessAt) break;
      await delay(20);
    }
    assert.equal(status?.autoSync?.intervalMs, 5_000);
    assert.ok(status?.autoSync?.job || status?.autoSync?.lastSuccessAt);
    const first = await apiRequest<{ job?: SessionJob }>(service.instance, "/sessions/auto-refresh", "POST");
    const second = await apiRequest<{ job?: SessionJob }>(service.instance, "/sessions/auto-refresh", "POST", {});
    assert.ok(!first.job || first.job.id === status.autoSync?.job?.id);
    assert.ok(!second.job || second.job.id === first.job?.id);
    await apiRequest(service.instance, "/preferences", "PUT", { sessionsAutoRefreshInterval: 0 });
    assert.deepEqual(await apiRequest(service.instance, "/sessions/auto-refresh", "POST", {}), { job: null, status: "skipped", reason: "disabled" });
    // 关闭自动策略不终止已提交的全局检查；完成后局部手动请求应照常执行。
    for (let attempt = 0; attempt < 200; attempt++) {
      const current = await apiRequest<SessionIndexSummary>(service.instance, "/sessions/status?summary=true");
      assert.notEqual(current.job?.status, "failed");
      if (current.job?.status === "complete") break;
      await delay(20);
    }
    const manual = await apiRequest<{ job: SessionJob }>(service.instance, "/sessions/refresh", "POST", { client: "pi" });
    assert.equal(manual.job.client, "pi");
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});


test("会话库与代码地图的持久刷新开关互不影响，手动地图任务保持可用", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-auto-independent-"));
  const repo = join(directory, "repo"); await mkdir(repo);
  await execute("git", ["init", "-q", repo]); await writeFile(join(repo, "a.ts"), "export const a = 1;\n");
  const service = await startService({ home: join(directory, "data"), roots: isolatedHistoryRoots(), startupRefresh: false });
  try {
    const registration = await apiRequest<{ repository: { id: string }; job: { id: string } }>(service.instance, "/repositories", "POST", { path: repo });
    const mapRoute = `/repositories/${registration.repository.id}`;
    await apiRequest(service.instance, "/preferences", "PUT", { sessionsAutoRefreshInterval: 5_000 });
    assert.deepEqual(await apiRequest(service.instance, `${mapRoute}/auto-refresh`, "POST", {}), { job: null, status: "skipped", reason: "disabled" });
    assert.equal((await apiRequest<SessionIndexSummary>(service.instance, "/sessions/status?summary=true")).autoSync?.intervalMs, 5_000);
    await apiRequest(service.instance, "/preferences", "PUT", { sessionsAutoRefreshInterval: 0, mapAutoRefreshInterval: 5_000 });
    assert.deepEqual(await apiRequest(service.instance, "/sessions/auto-refresh", "POST", {}), { job: null, status: "skipped", reason: "disabled" });
    // 登记仓库也会记入检查时间；等待最短间隔后，地图独立创建新任务。
    await delay(5_010);
    const map = await apiRequest<{ job?: { id: string } }>(service.instance, `${mapRoute}/auto-refresh`, "POST", {});
    assert.ok(map.job); assert.notEqual(map.job.id, registration.job.id);
    await apiRequest(service.instance, "/preferences", "PUT", { mapAutoRefreshInterval: 0 });
    assert.deepEqual(await apiRequest(service.instance, `${mapRoute}/auto-refresh`, "POST", {}), { job: null, status: "skipped", reason: "disabled" });
    assert.ok((await apiRequest<{ job: unknown }>(service.instance, `${mapRoute}/refresh`, "POST", {})).job);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
