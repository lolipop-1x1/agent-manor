import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AnalysisStore } from "../src/index/store.js";
import { SessionStore } from "../src/sessions/store.js";
import { compactIndexAtStartup, reclaimIndexBatch } from "../src/index/maintenance.js";
import { acquireLock } from "../src/service/runtime.js";

async function fixture(run: (home: string, path: string, database: Database.Database) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "manor-reclaim-"));
  const path = join(home, "index.sqlite");
  const index = new AnalysisStore(path); index.close();
  const library = new SessionStore(path); library.close();
  const database = new Database(path);
  const release = await acquireLock(home, "service.lock");
  try { await run(home, path, database); }
  finally { if (database.open) database.close(); await release(); await rm(home, { recursive: true, force: true }); }
}

test("新索引启用增量回收，短批次释放整页且保留有效数据与键", async () => fixture(async (_home, path, database) => {
  assert.equal(database.pragma("auto_vacuum", { simple: true }), 2);
  database.exec("CREATE TABLE samples(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO samples VALUES(7,'保留的内容'); CREATE TABLE released(body BLOB); INSERT INTO released VALUES(zeroblob(4194304)); DELETE FROM released;");
  const original = database.prepare("SELECT * FROM samples").all();
  const free = database.pragma("freelist_count", { simple: true }) as number;
  assert.ok(free > 256);
  const first = reclaimIndexBatch(path, 32);
  assert.equal(first.status, "completed", first.details);
  const after = database.pragma("freelist_count", { simple: true }) as number;
  assert.ok(free - after > 0 && free - after <= 32, `${free} -> ${after}`);
  for (let count = 0; count < 50 && database.pragma("freelist_count", { simple: true }); count++) reclaimIndexBatch(path);
  assert.equal(database.pragma("freelist_count", { simple: true }), 0);
  assert.deepEqual(database.prepare("SELECT * FROM samples").all(), original);
  assert.equal(database.pragma("quick_check", { simple: true }), "ok");
}));

test("写锁竞争安全跳过，读事务不会被回收中断且释放后可继续归还文件", async () => fixture(async (_home, path, database) => {
  database.exec("CREATE TABLE samples(id INTEGER PRIMARY KEY,body BLOB); INSERT INTO samples VALUES(1,zeroblob(2097152));");
  const reader = new Database(path, { readonly: true });
  reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM samples").get();
  database.exec("DELETE FROM samples;");
  const free = database.pragma("freelist_count", { simple: true });
  database.exec("BEGIN IMMEDIATE");
  try {
    assert.equal(reclaimIndexBatch(path).reason, "busy");
    assert.equal(database.pragma("freelist_count", { simple: true }), free);
  } finally { database.exec("ROLLBACK"); }
  assert.equal(reclaimIndexBatch(path).status, "completed");
  assert.deepEqual(reader.prepare("SELECT count(*) AS count FROM samples").get(), { count: 1 });
  reader.exec("COMMIT"); reader.close();
  for (let count = 0; count < 30 && database.pragma("freelist_count", { simple: true }); count++) reclaimIndexBatch(path);
  reclaimIndexBatch(path);
  assert.equal(database.pragma("freelist_count", { simple: true }), 0);
  assert.equal((await stat(`${path}-wal`)).size, 0);
}));

test("旧 NONE 库运行期间不迁移，启动受控转换保留全部逻辑行", async () => fixture(async (home, path, database) => {
  database.pragma("auto_vacuum = NONE"); database.exec("VACUUM");
  database.exec("CREATE TABLE samples(id INTEGER PRIMARY KEY,body TEXT); INSERT INTO samples VALUES(19,'保留的内容');");
  assert.equal(reclaimIndexBatch(path).reason, "unsupportedSchema");
  // 受控转换在普通连接打开前执行。
  database.close();
  const response = await compactIndexAtStartup(home);
  assert.equal(response.status, "completed", response.details);
  const reopened = new Database(path);
  try {
    assert.equal(reopened.pragma("auto_vacuum", { simple: true }), 2);
    assert.deepEqual(reopened.prepare("SELECT * FROM samples").all(), [{ id: 19, body: "保留的内容" }]);
  } finally { reopened.close(); }
}));
