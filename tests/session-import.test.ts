import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { SessionImportPool } from "../src/sessions/import-pool.js";
import { refreshSessions } from "../src/sessions/refresh.js";
import { SessionStore } from "../src/sessions/store.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

const encode = (value: unknown) => JSON.stringify(value) + "\n";
const user = (id: string, text: string) => ({ type: "response_item", payload: { type: "message", id, role: "user", content: [{ type: "input_text", text }] } });
const source = (id: string) => encode({ type: "session_meta", payload: { id, cwd: "/workspace/example" } })
  + Array.from({ length: 4 }, (_, index) => encode(user(`message-${index}`, `事务和锁 ${index} HELLO😀`))).join("");
const refresh = async (store: SessionStore, root: string, concurrency: number, clear = false) => {
  const job = store.createJob();
  await refreshSessions(store, job.id, isolatedHistoryRoots({ codex: root }), clear, { concurrency });
  return store.getJob(job.id);
};
async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-session-import-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function contents(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    return [
      db.prepare("SELECT r.path,m.id,m.ordinal,m.record_line,m.turn_id,m.kind,m.text,m.json FROM session_messages m JOIN session_revisions r ON r.id=m.revision ORDER BY r.path,m.id").all(),
      db.prepare("SELECT r.path,u.id,u.json FROM session_usage u JOIN session_revisions r ON r.id=u.revision ORDER BY r.path,u.id").all(),
      db.prepare("SELECT path,fingerprint,json FROM session_revisions ORDER BY path").all(),
    ];
  } finally { db.close(); }
}

test("并行导入与串行正文、元数据和搜索一致，增量复用及改写仍生效", async () => temporary(async directory => {
  const root = join(directory, "sources"); await mkdir(root);
  for (let index = 0; index < 9; index += 1) await writeFile(join(root, `${index}.jsonl`), source(`session-${index}`));
  const serial = new SessionStore(join(directory, "serial.sqlite")), parallel = new SessionStore(join(directory, "parallel.sqlite"));
  try {
    await refresh(serial, root, 1); await refresh(parallel, root, 2);
    assert.deepEqual(contents(parallel.dbPath), contents(serial.dbPath));
    const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === "version" ? undefined : item));
    for (const q of ["锁", "事务", "HELLO", "😀"]) assert.deepEqual(normalize(parallel.groupedSearch({ q })), normalize(serial.groupedSearch({ q })));
    assert.equal(parallel.importCheckpoints().length, 0);
    const quick = await refresh(parallel, root, 2);
    assert.equal(quick.counts?.quickReused, 9);
    assert.equal(quick.counts?.parsed, 0);
    await writeFile(join(root, "0.jsonl"), source("session-0").replaceAll("事务和锁", "改写正文"));
    const changed = await refresh(parallel, root, 2);
    assert.equal(changed.counts?.parsed, 1);
    assert.equal(parallel.groupedSearch({ q: "改写" }).total, 1);
    assert.equal(parallel.groupedSearch({ q: "事务" }).total, 8);
  } finally { serial.close(); parallel.close(); }
}));

test("解析线程哈希对应固定字节前缀，写入失败、读取失败及关闭均可结束等待", async () => temporary(async directory => {
  const path = join(directory, "source.jsonl"), bytes = Buffer.from(source("pool-demo"));
  await writeFile(path, Buffer.concat([bytes, Buffer.from(encode(user("later", "新增内容")))]));
  const pool = new SessionImportPool(2), location = { client: "codex" as const, path };
  try {
    let count = 0;
    const parsed = await pool.parse(location, { byteLimit: bytes.length }, true, items => { count += items.filter(item => item.type === "message").length; });
    assert.equal(parsed.hash, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(count, 4);
    await assert.rejects(pool.parse(location, {}, true, () => { throw new Error("合成写入失败"); }), /合成写入失败/);
    await assert.rejects(pool.parse({ ...location, path: join(directory, "missing.jsonl") }, {}, false, () => {}), /ENOENT/);
    assert.equal((await pool.parse(location, {}, false, () => {})).meta.messageCount, 5);
    const crashPool = new SessionImportPool(1);
    try {
      const crashed = crashPool.parse(location, {}, false, () => {});
      const rejected = assert.rejects(crashed, /意外停止/);
      // 在任务开始读取前终止真实线程，验证退出事件会拒绝任务并允许重建线程。
      const slot = (crashPool as unknown as { slots: { worker: Worker }[] }).slots[0]!;
      await slot.worker.terminate(); await rejected;
      assert.equal((await crashPool.parse(location, {}, false, () => {})).meta.messageCount, 5);
    } finally { await crashPool.close(); }
    const active = pool.parse(location, {}, false, () => {}), queued = pool.parse(location, {}, false, () => {});
    const checks = [assert.rejects(active, /已关闭/), assert.rejects(queued, /已关闭/)];
    await pool.close(); await Promise.all(checks);
    await assert.rejects(pool.parse(location, {}, false, () => {}), /已关闭/);
  } finally { await pool.close(); }
}));

test("中断保留完成来源，重启校验复用检查点且发布前不可查询半成品", async () => temporary(async directory => {
  const root = join(directory, "sources"); await mkdir(root);
  for (let index = 0; index < 3; index += 1) await writeFile(join(root, `${index}.jsonl`), source(`resume-${index}`));
  const dbPath = join(directory, "index.sqlite");
  let store = new SessionStore(dbPath);
  try {
    const create = store.createRevision.bind(store);
    let started = 0;
    store.createRevision = (...args) => {
      if (++started === 2) throw new Error("合成进程中断");
      return create(...args);
    };
    await assert.rejects(refresh(store, root, 1), /合成进程中断/);
    assert.equal(store.currentVersion(), undefined);
    assert.equal(store.cachedRevisions().length, 0);
    const checkpoint = store.importCheckpoints()[0]!;
    assert.ok(checkpoint);
    const unfinished = store.createJob();
    store.updateJob(unfinished.id, { status: "running" });
    const partial = store.createRevision("/workspace/partial.jsonl", "pending");
    partial.sink.message({ id: "partial", sessionId: "partial", ordinal: 1, recordLine: 1, turnId: "turn", kind: "user", text: "未完成正文" });
    partial.flush();
    store.close(); store = new SessionStore(dbPath); store.recoverJobs();
    // 失败清理不会移除已经提交并通过前缀校验的来源。
    assert.equal(store.importCheckpoints()[0]?.revision, checkpoint.revision);
    assert.equal(store.getJob(unfinished.id).status, "failed");
    const resumed = await refresh(store, root, 2);
    assert.equal(resumed.counts?.quickReused, 1);
    assert.equal(resumed.counts?.parsed, 2);
    assert.equal(store.cachedRevisions().find(item => item.path === checkpoint.path)?.revision, checkpoint.revision);
    assert.equal(store.list().total, 3);
    assert.equal(store.importCheckpoints().length, 0);
  } finally { store.close(); }
}));

test("并行读取允许追加但拒绝前缀改写，失败保留完整前版且清除在途半成品", async () => temporary(async directory => {
  const root = join(directory, "sources"); await mkdir(root);
  const path = join(root, "source.jsonl"), original = source("active-demo");
  await writeFile(path, original);
  const store = new SessionStore(join(directory, "index.sqlite"));
  try {
    const apply = store.applyImportBatch.bind(store);
    let changed = false;
    store.applyImportBatch = (pending, items) => {
      apply(pending, items);
      if (!changed) { changed = true; appendFileSync(path, encode(user("append", "之后追加"))); }
    };
    await refresh(store, root, 2);
    const version = store.currentVersion();
    assert.equal(store.list().sessions[0]?.messageCount, 4);
    store.applyImportBatch = (pending, items) => {
      apply(pending, items);
      writeFileSync(path, original.replaceAll("事务和锁", "前缀改写"));
    };
    await assert.rejects(refresh(store, root, 2, true), /改写|截短/);
    assert.equal(store.currentVersion(), version);
    assert.equal(store.list().sessions[0]?.messageCount, 4);
    assert.equal(store.importCheckpoints().length, 0);
    const db = new Database(store.dbPath, { readonly: true });
    try { assert.equal((db.prepare("SELECT COUNT(*) count FROM session_revisions").get() as { count: number }).count, 1); }
    finally { db.close(); }
  } finally { store.close(); }
}));

test("检查点变化重新解析、删除回收，局部发布保留其他客户端检查点", async () => temporary(async directory => {
  const root = join(directory, "sources"); await mkdir(root);
  const first = join(root, "first.jsonl"), second = join(root, "second.jsonl");
  await writeFile(first, source("checkpoint-first")); await writeFile(second, source("checkpoint-second"));
  const store = new SessionStore(join(directory, "index.sqlite"));
  try {
    const publish = store.publish.bind(store);
    store.publish = () => { throw new Error("合成发布失败"); };
    await assert.rejects(refresh(store, root, 2), /合成发布失败/);
    const checkpoints = store.importCheckpoints();
    assert.equal(checkpoints.length, 2);
    const old = checkpoints.find(item => item.path === first)!;
    // 先检查另一个客户端，不丢失已完成来源；尚未发布的来源仍不可查询。
    store.publish = publish;
    const unrelated = store.createJob({ client: "claude" });
    await refreshSessions(store, unrelated.id, isolatedHistoryRoots({ codex: root }), false, { concurrency: 2 });
    assert.equal(store.importCheckpoints().length, 2);
    assert.equal(store.list().total, 0);
    await writeFile(first, source("checkpoint-first").replaceAll("事务和锁", "新的正文")); await rm(second);
    const checked = await refresh(store, root, 2);
    assert.equal(checked.counts?.parsed, 1);
    assert.equal(checked.counts?.quickReused, 0);
    assert.notEqual(store.cachedRevisions()[0]?.revision, old.revision);
    assert.equal(store.list().total, 1);
    assert.equal(store.groupedSearch({ q: "新的" }).total, 1);
    assert.equal(store.importCheckpoints().length, 0);
    const db = new Database(store.dbPath, { readonly: true });
    try { assert.equal((db.prepare("SELECT COUNT(*) count FROM session_revisions").get() as { count: number }).count, 1); }
    finally { db.close(); }
  } finally { store.close(); }
}));

test("首次批量导入只暂缓辅助索引，额外连接不抢建，发布后索引和画像可用", async () => temporary(async directory => {
  const root = join(directory, "sources"); await mkdir(root);
  await writeFile(join(root, "source.jsonl"), source("index-build-demo"));
  const store = new SessionStore(join(directory, "index.sqlite"));
  const inspector = new Database(store.dbPath, { readonly: true });
  try {
    const create = store.createRevision.bind(store);
    store.createRevision = (...args) => {
      assert.equal(inspector.prepare("SELECT 1 FROM sqlite_master WHERE name='session_message_order'").get(), undefined);
      assert.ok(inspector.prepare("SELECT 1 FROM sqlite_master WHERE name='session_character_search'").get());
      const other = new SessionStore(store.dbPath);
      try {
        assert.equal(inspector.prepare("SELECT 1 FROM sqlite_master WHERE name='session_message_order'").get(), undefined);
        assert.equal(other.currentVersion(), undefined);
      } finally { other.close(); }
      return create(...args);
    };
    await refresh(store, root, 2);
    assert.ok(inspector.prepare("SELECT 1 FROM sqlite_master WHERE name='session_message_order'").get());
    assert.ok(inspector.prepare("SELECT 1 FROM sqlite_master WHERE name='session_message_overview_projection_v2'").get());
    const id = store.list().sessions[0]!.id;
    assert.equal(store.profile(id).messageCount, 4);
    assert.equal(store.groupedSearch({ q: "锁" }).total, 1);
    store.createRevision = create;
    const version = store.currentVersion();
    store.beginInitialImport();
    assert.equal(store.currentVersion(), version);
    assert.ok(inspector.prepare("SELECT 1 FROM sqlite_master WHERE name='session_message_order'").get(), "已有完整版本不暂缓查询索引");
  } finally { inspector.close(); store.close(); }
}));

test("元信息变化后失败的检查点与已发布来源共存，恢复发现同一路径只处理一次", async () => temporary(async directory => {
  const root = join(directory, "sources"); await mkdir(root);
  const first = join(root, "first.jsonl"), second = join(root, "second.jsonl");
  await writeFile(first, source("metadata-first")); await writeFile(second, source("metadata-second"));
  const store = new SessionStore(join(directory, "index.sqlite"));
  try {
    await refresh(store, root, 2);
    const previous = store.currentVersion();
    const db = new Database(store.dbPath);
    try { db.prepare("UPDATE session_revisions SET metadata_fingerprint='previous-metadata' WHERE path=?").run(first); }
    finally { db.close(); }
    const publish = store.publish.bind(store);
    store.publish = () => { throw new Error("合成发布失败"); };
    await assert.rejects(refresh(store, root, 2), /合成发布失败/);
    const checkpoint = store.importCheckpoints()[0]!;
    assert.ok(checkpoint);
    assert.equal(store.currentVersion(), previous);
    assert.notEqual(store.cachedRevisions().find(item => item.path === first)?.revision, checkpoint.revision);
    store.publish = publish;
    const resumed = await refresh(store, root, 2);
    assert.equal(resumed.counts?.discovered, 2);
    assert.equal(resumed.counts?.quickReused, 2);
    assert.equal(resumed.counts?.parsed, 0);
    assert.equal(store.cachedRevisions().find(item => item.path === first)?.revision, checkpoint.revision);
    assert.equal(store.list().total, 2);
  } finally { store.close(); }
}));
