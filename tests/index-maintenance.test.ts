import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { compactIndexAtStartup, activeIndexMaintenance, reclaimIndexBatch } from "../src/index/maintenance.js";
import { AnalysisStore } from "../src/index/store.js";
import { SessionStore } from "../src/sessions/store.js";
import { acquireLock, apiRequest } from "../src/service/runtime.js";
import { startService } from "../src/server.js";
import type { StatusResponse } from "../src/contracts.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";
import { DiagnosticError } from "../src/i18n/diagnostics.js";

async function fixture(run: (home: string, path: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "manor-maintenance-"));
  const path = join(home, "index.sqlite");
  const maps = new AnalysisStore(path);
  maps.close();
  const sessions = new SessionStore(path);
  const pending = sessions.createRevision("/workspace/history/synthetic.jsonl", "same-source");
  for (let ordinal = 1; ordinal <= 8; ordinal++) pending.sink.message({ id: `synthetic-${ordinal}`, sessionId: "synthetic", ordinal,
    recordLine: ordinal + 1, turnId: "turn-one", kind: ordinal % 2 ? "user" : "assistant", text: `中文防小偷正文 ${ordinal}`, final: ordinal % 2 ? undefined : "recorded" });
  pending.flush();
  sessions.finishRevision(pending.revision, { id: "synthetic", client: "codex", clientSessionId: "synthetic", sourceId: "codex:synthetic",
    path: "/workspace/history/synthetic.jsonl", title: "人工合成会话", titleOrigin: "recorded", messageCount: 8, turnCount: 1, models: [], gaps: [] });
  sessions.publish(sessions.createJob().id, [{ path: "/workspace/history/synthetic.jsonl", revision: pending.revision, fingerprint: "same-source" }], []);
  sessions.close();
  const database = new Database(path);
  database.exec("DELETE FROM session_messages WHERE message_key IN (2,5); CREATE TABLE unused_payload(id INTEGER PRIMARY KEY, bytes BLOB); INSERT INTO unused_payload(bytes) VALUES(zeroblob(4194304)); DELETE FROM unused_payload;");
  database.close();
  const release = await acquireLock(home, "service.lock");
  try { await run(home, path); }
  finally { await release(); await rm(home, { recursive: true, force: true }); }
}

function rows(path: string) {
  const database = new Database(path, { readonly: true });
  try {
    return { messages: database.prepare("SELECT * FROM session_messages ORDER BY message_key").all(),
      hits: database.prepare("SELECT m.message_key,m.text FROM session_character_search f JOIN session_messages m ON m.message_key=f.rowid WHERE session_character_search MATCH ? ORDER BY m.message_key").all("b9632x5c0f AND b5c0fx5077") };
  } finally { database.close(); }
}

test("真实 VACUUM 保留行号空洞、完整正文、FTS 中文结果和其他持久文件", async () => fixture(async (home, path) => {
  await writeFile(join(home, "preferences.json"), '{"language":"en"}');
  await writeFile(join(home, "resources.sqlite"), "isolated-management-marker");
  await mkdir(join(home, "resource-vault"));
  await writeFile(join(home, "resource-vault", "material"), "isolated-recovery-marker");
  const before = rows(path);
  assert.deepEqual(before.hits.map(value => (value as { message_key: number }).message_key), [1, 3, 4, 6, 7, 8]);
  const response = await compactIndexAtStartup(home, { now: Date.parse("2026-01-03T00:00:00Z"), decision: () => "compact" });
  assert.equal(response.status, "completed", response.details);
  assert.ok(response.afterBytes! < response.beforeBytes!);
  assert.deepEqual(rows(path), before);
  assert.deepEqual(JSON.parse(await readFile(join(home, "index-maintenance.json"), "utf8")), { completedAt: "2026-01-03T00:00:00.000Z" });
  assert.equal(await activeIndexMaintenance(home), false);
  assert.equal(await readFile(join(home, "preferences.json"), "utf8"), '{"language":"en"}');
  assert.equal(await readFile(join(home, "resources.sqlite"), "utf8"), "isolated-management-marker");
  assert.equal(await readFile(join(home, "resource-vault", "material"), "utf8"), "isolated-recovery-marker");
  const second = await compactIndexAtStartup(home);
  assert.equal(second.reason, "threshold");
  assert.ok(!(await readdir(home)).some(name => name.includes(".bak") || name.endsWith(".tmp") || name.endsWith("-active.json")));
}));

test("分批回收保留非连续消息键、正文和中文 FTS 结果", async () => fixture(async (_home, path) => {
  const before = rows(path);
  for (let count = 0; count < 50; count++) {
    const response = reclaimIndexBatch(path);
    assert.notEqual(response.status, "failed", response.details);
    if (response.reason === "threshold") break;
  }
  assert.deepEqual(rows(path), before);
}));

test("磁盘不足、探测错误和维护竞争不改变正文或成功时间", async () => fixture(async (home, path) => {
  const before = rows(path);
  const options = { decision: () => "compact" as const };
  assert.equal((await compactIndexAtStartup(home, { ...options, availableBytes: async () => 0 })).reason, "insufficientSpace");
  assert.equal((await compactIndexAtStartup(home, { ...options, availableBytes: async () => { throw new Error("synthetic disk probe failed"); } })).status, "failed");
  const other = new Database(path);
  other.exec("BEGIN IMMEDIATE");
  try { assert.equal((await compactIndexAtStartup(home, options)).reason, "busy"); }
  finally { other.exec("ROLLBACK"); other.close(); }
  const reader = new Database(path, { readonly: true });
  reader.exec("BEGIN");
  reader.prepare("SELECT text FROM session_messages LIMIT 1").get();
  try { assert.equal((await compactIndexAtStartup(home, options)).reason, "busy"); }
  finally { reader.exec("ROLLBACK"); reader.close(); }
  assert.deepEqual(rows(path), before);
  await assert.rejects(readFile(join(home, "index-maintenance.json")), { code: "ENOENT" });
  assert.equal(await activeIndexMaintenance(home), false);
}));

test("未知旧结构只报告跳过，不整理或迁移", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-maintenance-old-"));
  const database = new Database(join(home, "index.sqlite"));
  database.pragma("user_version = 3");
  database.exec("CREATE TABLE original(value TEXT); INSERT INTO original VALUES('original')");
  database.close();
  try {
    assert.equal((await compactIndexAtStartup(home, { decision: () => "compact" })).reason, "unsupportedSchema");
    const previous = new Database(join(home, "index.sqlite"), { readonly: true });
    assert.equal(previous.pragma("user_version", { simple: true }), 3);
    assert.deepEqual(previous.prepare("SELECT * FROM original").all(), [{ value: "original" }]);
    previous.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("新安装和重复启动报告启动检查，查询与刷新不运行整理", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-maintenance-service-"));
  try {
    const first = await startService({ home, roots: isolatedHistoryRoots(), startupRefresh: false });
    try {
      const initial = await apiRequest<StatusResponse>(first.instance, "/status");
      assert.equal(initial.indexMaintenance?.reason, "noDatabase");
      assert.deepEqual((await apiRequest<StatusResponse>(first.instance, "/status")).indexMaintenance, initial.indexMaintenance);
    } finally { await first.close(); }
    const second = await startService({ home, roots: isolatedHistoryRoots(), startupRefresh: false });
    try { assert.equal((await apiRequest<StatusResponse>(second.instance, "/status")).indexMaintenance?.reason, "threshold"); }
    finally { await second.close(); }
    await assert.rejects(readFile(join(home, "index-maintenance.json")), { code: "ENOENT" });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("维护等待信号只接受持生命周期锁的活 PID，同名伪造信号不能延长启动", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-maintenance-activity-"));
  const release = await acquireLock(home, "service.lock");
  try {
    const owner = JSON.parse(await readFile(join(home, "service.lock", "owner.json"), "utf8"));
    await writeFile(join(home, "index-maintenance-active.json"), JSON.stringify({ ...owner, startedAt: "2026-01-01T00:00:00Z" }));
    assert.equal(await activeIndexMaintenance(home, process.pid), true);
    assert.equal(await activeIndexMaintenance(home, process.pid + 1), false);
    await writeFile(join(home, "index-maintenance-active.json"), JSON.stringify({ ...owner, nonce: "unrelated", startedAt: "2026-01-01T00:00:00Z" }));
    assert.equal(await activeIndexMaintenance(home), false);
  } finally { await release(); await rm(home, { recursive: true, force: true }); }
});

test("维护信号消失后启动锁恢复有界等待", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-maintenance-wait-"));
  const releaseService = await acquireLock(home, "service.lock");
  const releaseStartup = await acquireLock(home, "startup.lock");
  try {
    const owner = JSON.parse(await readFile(join(home, "service.lock", "owner.json"), "utf8"));
    await writeFile(join(home, "index-maintenance-active.json"), JSON.stringify({ ...owner, startedAt: "2026-01-01T00:00:00Z" }));
    const started = Date.now();
    const clear = setTimeout(() => { void rm(join(home, "index-maintenance-active.json")); }, 180);
    try { await assert.rejects(acquireLock(home, "startup.lock", 10), /另一个服务实例/); }
    finally { clearTimeout(clear); }
    assert.ok(Date.now() - started >= 180);
    assert.ok(Date.now() - started < 2_000);
  } finally { await releaseStartup(); await releaseService(); await rm(home, { recursive: true, force: true }); }
});

test("整理前补齐已记录的未完成 FTS，避免把缺失搜索词项记为成功", async () => fixture(async (home, path) => {
  const database = new Database(path);
  database.exec("DELETE FROM session_character_search WHERE rowid=6; UPDATE session_character_search_state SET cursor=0,complete=0 WHERE id=1");
  database.close();
  const response = await compactIndexAtStartup(home, { decision: () => "compact" });
  assert.equal(response.status, "completed", response.details);
  assert.deepEqual(rows(path).hits.map(value => (value as { message_key: number }).message_key), [1, 3, 4, 6, 7, 8]);
}));

test("声称完整但缺失 FTS 文档的索引阻止正常启动，不吞成环境跳过", async () => fixture(async (home, path) => {
  const database = new Database(path);
  database.exec("DELETE FROM session_character_search WHERE rowid=6");
  database.close();
  const before = rows(path);
  await assert.rejects(compactIndexAtStartup(home, { decision: () => "compact" }), error =>
    error instanceof DiagnosticError && error.messageDescriptor?.key === "diagnostics.index.maintenance.invalidIndex"
      && error.message.includes("FTS document keys"));
  assert.deepEqual(rows(path), before);
  assert.equal(await activeIndexMaintenance(home), false);
  await assert.rejects(readFile(join(home, "index-maintenance.json")), { code: "ENOENT" });
}));

test("外键关联校验失败阻止正常启动，失败不清空或整理数据", async () => fixture(async (home, path) => {
  const database = new Database(path);
  database.pragma("foreign_keys = OFF");
  database.exec("UPDATE session_messages SET revision='missing-synthetic-revision' WHERE message_key=1");
  database.close();
  const before = rows(path);
  await assert.rejects(compactIndexAtStartup(home, { decision: () => "compact" }), error =>
    error instanceof DiagnosticError && error.messageDescriptor?.key === "diagnostics.index.maintenance.invalidIndex"
      && error.message.includes("SQLite integrity check"));
  assert.deepEqual(rows(path), before);
  await assert.rejects(readFile(join(home, "index-maintenance.json")), { code: "ENOENT" });
}));

test("VACUUM 中断后 SQLite 保留有效正文和搜索，不记录成功", async () => fixture(async (home, path) => {
  const before = rows(path);
  const database = new Database(path);
  // 保留正文工作量，使子进程在真实 VACUUM 阶段有足够的中断窗口。
  database.exec("INSERT INTO unused_payload(bytes) VALUES(zeroblob(33554432))");
  database.close();
  await rm(join(home, "service.lock"), { recursive: true });
  const maintenanceUrl = new URL("../src/index/maintenance.ts", import.meta.url).href;
  const runtimeUrl = new URL("../src/service/runtime.ts", import.meta.url).href;
  const script = `const { compactIndexAtStartup } = await import(${JSON.stringify(maintenanceUrl)}); const { acquireLock } = await import(${JSON.stringify(runtimeUrl)}); const release = await acquireLock(${JSON.stringify(home)}, 'service.lock'); try { await compactIndexAtStartup(${JSON.stringify(home)}, { decision: () => 'compact' }); } finally { await release(); }`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  child.stderr.on("data", value => { errors += String(value); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  let interrupted = false;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const activity = JSON.parse(await readFile(join(home, "index-maintenance-active.json"), "utf8"));
      if (activity.phase === "compacting") { interrupted = child.kill("SIGKILL"); break; }
    } catch { /* 子进程正在建立维护信号。 */ }
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  if (!interrupted) child.kill("SIGKILL");
  const outcome = await exited;
  assert.equal(interrupted, true, errors || "未进入真实 VACUUM 阶段");
  assert.equal(outcome.signal, "SIGKILL");
  assert.deepEqual(rows(path), before);
  const check = new Database(path);
  assert.equal(check.pragma("quick_check", { simple: true }), "ok");
  check.close();
  await assert.rejects(readFile(join(home, "index-maintenance.json")), { code: "ENOENT" });
  assert.equal(await activeIndexMaintenance(home), false);
}));


test("字符索引未完成时整理补齐，声称完整但缺文档时阻止整理", async () => fixture(async (home, path) => {
  const database = new Database(path);
  try { database.exec("DELETE FROM session_character_search WHERE rowid=6; UPDATE session_character_search_state SET cursor=0,complete=0"); }
  finally { database.close(); }
  assert.equal((await compactIndexAtStartup(home, { decision: () => "compact" })).status, "completed");
  const check = new Database(path);
  try {
    assert.equal(check.prepare("SELECT COUNT(*) count FROM session_character_search WHERE session_character_search MATCH ?").get("u4e2d")?.count, 6);
    check.exec("DELETE FROM session_character_search WHERE rowid=6");
  } finally { check.close(); }
  await assert.rejects(compactIndexAtStartup(home, { decision: () => "compact" }), error =>
    error instanceof DiagnosticError && error.message.includes("FTS document keys"));
}));
