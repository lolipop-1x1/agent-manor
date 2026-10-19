import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { startService } from "../src/server.js";
import { apiRequest, delay } from "../src/service/runtime.js";
import { AnalysisStore } from "../src/index/store.js";
import { WorkerManager } from "../src/index/worker-manager.js";
import { SessionStore } from "../src/sessions/store.js";
import type { SessionIndexStatus, SessionJob, SessionListResult } from "../src/session-contracts.js";
import { sessionFixture, encodeSession } from "../scripts/session-fixture.mjs";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

const execute = promisify(execFile);
async function fixture(directory: string) {
  const roots = isolatedHistoryRoots({ codex: join(directory, "codex"), claude: join(directory, "claude") });
  const records = sessionFixture(join(directory, "project"));
  for (const client of ["codex", "claude"] as const) {
    await mkdir(roots[client]);
    await writeFile(join(roots[client], "demo.jsonl"), encodeSession(records[client]));
  }
  return roots;
}

test("HTTP 与 CLI 支持范围和完整校验，未传参数兼容全部快速检查", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-refresh-api-"));
  const home = join(directory, "data");
  const roots = await fixture(directory);
  const service = await startService({ home, roots, startupRefresh: false });
  async function wait(job: SessionJob): Promise<SessionJob> {
    for (let count = 0; count < 600 && ["queued", "running"].includes(job.status); count++) {
      await delay(20);
      job = (await apiRequest<{ job: SessionJob }>(service.instance, `/jobs/${job.id}`)).job;
    }
    assert.equal(job.status, "complete", job.error);
    return job;
  }
  try {
    for (const body of [null, [], { client: "unknown" }, { mode: "other" }, { mode: null }, { client: 1 }, { from: "2026-01-01" }, { client: "all" }]) {
      await assert.rejects(apiRequest(service.instance, "/sessions/refresh", "POST", body), { code: "INVALID_INPUT" });
    }
    const initial = await wait((await apiRequest<{ job: SessionJob }>(service.instance, "/sessions/refresh", "POST")).job);
    assert.equal(initial.mode, "quick");
    assert.equal(initial.client, undefined);
    assert.deepEqual(initial.sourceCounts, [{ client: "codex", count: 1 }, { client: "claude", count: 1 }]);
    assert.equal(initial.discovery, undefined);
    assert.equal(initial.activeSources, undefined);
    const before = await apiRequest<SessionListResult>(service.instance, "/sessions");
    const status = await apiRequest<SessionIndexStatus>(service.instance, "/sessions/status");
    const claudeBefore = status.clientChecks?.find(check => check.client === "claude");
    assert.ok(claudeBefore);
    const full = await wait((await apiRequest<{ job: SessionJob }>(service.instance, "/sessions/refresh", "POST", { client: "codex", mode: "full" })).job);
    assert.equal(full.client, "codex");
    assert.equal(full.mode, "full");
    assert.equal(full.counts?.discovered, 1);
    assert.equal(full.counts?.quickReused, 0);
    assert.equal(full.counts?.verifiedReused, 1);
    assert.equal(full.counts?.parsed, 0);
    const after = await apiRequest<SessionListResult>(service.instance, "/sessions");
    assert.deepEqual(after.sessions, before.sessions);
    const afterStatus = await apiRequest<SessionIndexStatus>(service.instance, "/sessions/status");
    assert.deepEqual(afterStatus.clientChecks?.find(check => check.client === "claude"), claudeBefore);
    assert.equal(afterStatus.clientChecks?.find(check => check.client === "codex")?.mode, "full");
    const command = await execute(process.execPath, ["--import", "tsx", "src/cli.ts", "--home", home,
      "sessions", "refresh", "--client", "claude", "--mode", "full", "--wait", "--json"], { timeout: 20_000 });
    const cli = JSON.parse(command.stdout) as { job: SessionJob };
    assert.equal(cli.job.status, "complete");
    assert.equal(cli.job.client, "claude");
    assert.equal(cli.job.mode, "full");
    assert.equal(cli.job.counts?.verifiedReused, 1);
    assert.equal(cli.job.counts?.parsed, 0);
    await assert.rejects(apiRequest(service.instance, "/sessions/cache", "DELETE", { client: "claude" }), { code: "INVALID_INPUT" });
    const rebuilt = await wait((await apiRequest<{ job: SessionJob }>(service.instance, "/sessions/cache", "DELETE")).job);
    assert.equal(rebuilt.client, undefined);
    assert.equal(rebuilt.mode, "full");
    assert.equal(rebuilt.counts?.parsed, 2);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("请求用量规则升级使旧事实失效，局部刷新仍复用范围外客户端", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-usage-rule-"));
  const roots = await fixture(directory);
  const index = new AnalysisStore(join(directory, "index.sqlite"));
  const sessions = new SessionStore(index.dbPath);
  const manager = new WorkerManager(index, { roots }, sessions);
  const database = new Database(index.dbPath);
  async function wait(id: string) {
    for (let count = 0; count < 600 && ["queued", "running"].includes(sessions.getJob(id).status); count++) await delay(20);
    assert.equal(sessions.getJob(id).status, "complete", sessions.getJob(id).error);
  }
  try {
    await wait(manager.refreshSessions().id);
    const old = sessions.usageFactSessions().sessions.find(item => item.session.client === "codex")!;
    const count = (revision: string) => (database.prepare("SELECT count(*) AS count FROM session_usage_facts WHERE revision=?").get(revision) as { count: number }).count;
    const originalCount = count(old.revision);
    assert.ok(originalCount > 0);
    database.prepare("UPDATE session_revisions SET fingerprint=replace(fingerprint, ':request-usage-v2', ''),metadata_fingerprint='previous-rule' WHERE id=?").run(old.revision);
    database.prepare(`INSERT INTO session_usage_facts (revision,id,ordinal,time_ms,occurred_at,model,provider,
      input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,context_tokens,eligible)
      SELECT revision,id || ':duplicate',ordinal+1,time_ms,occurred_at,model,provider,
      input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,context_tokens,eligible
      FROM session_usage_facts WHERE revision=? LIMIT 1`).run(old.revision);
    assert.equal(count(old.revision), originalCount + 1);
    const refresh = manager.refreshSessions(false, { client: "codex", mode: "quick" });
    await wait(refresh.id);
    assert.equal(sessions.getJob(refresh.id).counts?.parsed, 1);
    const current = sessions.usageFactSessions().sessions.find(item => item.session.client === "codex")!;
    assert.notEqual(current.revision, old.revision);
    assert.equal(count(current.revision), originalCount);
    const all = manager.refreshSessions();
    await wait(all.id);
    assert.equal(sessions.getJob(all.id).counts?.parsed, 0);
    assert.equal(sessions.getJob(all.id).counts?.quickReused, 2);
  } finally {
    database.close(); await manager.close(); sessions.close(); index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("共享上下文快照规则升级重建旧 Codex 来源，范围外修订和请求用量不变", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-context-rule-"));
  const roots = await fixture(directory);
  await appendFile(join(roots.codex, "demo.jsonl"), JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: 100, output_tokens: 20 }, last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
  } } }) + "\n");
  const index = new AnalysisStore(join(directory, "index.sqlite"));
  const sessions = new SessionStore(index.dbPath);
  const manager = new WorkerManager(index, { roots }, sessions);
  const database = new Database(index.dbPath);
  async function wait(id: string) {
    for (let count = 0; count < 600 && ["queued", "running"].includes(sessions.getJob(id).status); count++) await delay(20);
    assert.equal(sessions.getJob(id).status, "complete", sessions.getJob(id).error);
  }
  try {
    await wait(manager.refreshSessions().id);
    const before = sessions.usageFactSessions().sessions;
    const old = before.find(item => item.session.client === "codex")!;
    const outside = before.find(item => item.session.client === "claude")!;
    const requests = sessions.profile(old.session.id).usage.requests;
    database.prepare("UPDATE session_revisions SET fingerprint=replace(fingerprint, ':active-context-v3', ':active-context-v1'),metadata_fingerprint='old-context-rule',json=json_remove(json,'$.contextSnapshots') WHERE id=?").run(old.revision);
    const job = manager.refreshSessions(false, { client: "codex", mode: "quick" });
    await wait(job.id);
    assert.equal(sessions.getJob(job.id).counts?.parsed, 1);
    const current = sessions.usageFactSessions().sessions;
    assert.notEqual(current.find(item => item.session.client === "codex")?.revision, old.revision);
    assert.equal(current.find(item => item.session.client === "claude")?.revision, outside.revision);
    const profile = sessions.profile(old.session.id);
    assert.deepEqual(profile.contextSnapshots?.map(snapshot => snapshot.usedTokens), [120]);
    assert.equal(profile.usage.requests, requests);
  } finally {
    database.close(); await manager.close(); sessions.close(); index.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("单队列仅复用相同范围和方式，连续局部任务保留最新已发布数据", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-refresh-queue-"));
  const roots = await fixture(directory);
  const index = new AnalysisStore(join(directory, "index.sqlite"));
  const sessions = new SessionStore(index.dbPath);
  const manager = new WorkerManager(index, { roots }, sessions);
  try {
    const first = manager.refreshSessions(false, { client: "codex" });
    const duplicate = manager.refreshSessions(false, { client: "codex", mode: "quick" });
    assert.equal(duplicate.id, first.id);
    const full = manager.refreshSessions(false, { client: "codex", mode: "full" });
    const second = manager.refreshSessions(false, { client: "claude", mode: "quick" });
    const all = manager.refreshSessions();
    assert.equal(new Set([first.id, full.id, second.id, all.id]).size, 4);
    for (let count = 0; count < 600 && sessions.getJob(all.id).status !== "complete"; count++) {
      for (const job of [first, full, second, all]) assert.notEqual(sessions.getJob(job.id).status, "failed", sessions.getJob(job.id).error);
      await delay(20);
    }
    for (const job of [first, full, second, all]) assert.equal(sessions.getJob(job.id).status, "complete");
    assert.equal(sessions.list().total, 2);
    assert.equal(sessions.getJob(full.id).counts?.verifiedReused, 1);
    assert.equal(sessions.getJob(second.id).counts?.parsed, 1);
    assert.equal(sessions.getJob(all.id).counts?.quickReused, 2);
    assert.ok(sessions.status().clientChecks?.every(check => check.mode === "quick"));
  } finally {
    await manager.close();
    sessions.close();
    index.close();
    await rm(directory, { recursive: true, force: true });
  }
});
