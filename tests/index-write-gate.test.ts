import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import test from "node:test";
import { coordinateIndexWrites, releaseIndexWrite, withIndexWriteAsync } from "../src/index/write-gate.js";
import { delay } from "../src/service/runtime.js";

for (const crash of [false, true]) test(`长写事务期间其他写者交接、只读查询继续，持有者${crash ? "退出后可恢复" : "正常提交"}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-write-gate-")), path = join(directory, "index.sqlite");
  const gate = new SharedArrayBuffer(4), release = new SharedArrayBuffer(4);
  const reader = new Database(path);
  reader.pragma("journal_mode=WAL"); reader.exec("CREATE TABLE example(value INTEGER)");
  const worker = new Worker(`
const {parentPort,workerData}=require('node:worker_threads');
(async()=>{
 const {register}=await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))}); register();
 const {coordinateIndexWrites}=await import(${JSON.stringify(new URL("../src/index/write-gate.ts", import.meta.url).href)});
 const {default:Database}=await import(${JSON.stringify(import.meta.resolve("better-sqlite3"))});
 const db=new Database(workerData.path); db.pragma('busy_timeout=0'); coordinateIndexWrites(db,workerData.gate);
 const write=db.transaction(()=>{
   db.prepare('INSERT INTO example VALUES(1)').run(); parentPort.postMessage('held');
   Atomics.wait(new Int32Array(workerData.release),0,0);
 });
 parentPort.on('message',()=>{write();parentPort.postMessage('committed');}); parentPort.postMessage('ready');
})();`, { eval: true, workerData: { path, gate, release } });
  const workerOwner = worker.threadId + 1;
  try {
    await once(worker, "message");
    const held = once(worker, "message"); worker.postMessage("hold"); await held;
    coordinateIndexWrites(reader, gate);
    reader.pragma("busy_timeout=0");
    assert.equal(reader.transaction(() => reader.prepare("SELECT count(*) AS n FROM example").get()).deferred().n, 0, "只读快照继续看到完整旧事务");
    let finished = false;
    const pending = withIndexWriteAsync(gate, () => {
      const tx = reader.transaction(() => {
        reader.prepare("INSERT INTO example VALUES(2)").run();
        assert.equal(reader.prepare("SELECT count(*) AS n FROM example").get().n, crash ? 1 : 2);
      });
      tx(); finished = true;
    });
    await delay(50); assert.equal(finished, false);
    if (crash) { await worker.terminate(); releaseIndexWrite(gate, workerOwner); }
    else { const committed = once(worker, "message"); Atomics.store(new Int32Array(release), 0, 1); Atomics.notify(new Int32Array(release), 0); await committed; }
    await pending;
    assert.equal(Atomics.load(new Int32Array(gate), 0), 0);
    assert.deepEqual(reader.prepare("SELECT value FROM example ORDER BY value").all(), crash ? [{ value: 2 }] : [{ value: 1 }, { value: 2 }]);
    assert.deepEqual(reader.prepare("INSERT INTO example VALUES(3) RETURNING value").get(), { value: 3 });
    assert.deepEqual([...reader.prepare("INSERT INTO example VALUES(4) RETURNING value").iterate()], [{ value: 4 }]);
    assert.throws(() => reader.transaction(() => { reader.prepare("INSERT INTO example VALUES(5)").run(); throw new Error("synthetic rollback"); })(), /synthetic rollback/);
    assert.equal(Atomics.load(new Int32Array(gate), 0), 0);
    assert.equal(reader.prepare("SELECT count(*) AS n FROM example WHERE value=5").get().n, 0);
  } finally { await worker.terminate(); releaseIndexWrite(gate, workerOwner); reader.close(); await rm(directory, { recursive: true, force: true }); }
});
