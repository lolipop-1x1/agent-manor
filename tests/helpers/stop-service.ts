import Database from "better-sqlite3";
import { join } from "node:path";
import { startService } from "../../src/server.js";
import { UsageManager } from "../../src/usage/manager.js";
import { waitForPreparation } from "../../src/service/runtime.js";
import { isolatedHistoryRoots } from "./history-roots.js";

const [home, scenario] = process.argv.slice(2);
if (!home || !process.send) throw new Error("Synthetic stop fixture requires home and IPC");
if (scenario === "cleanup-hang") UsageManager.prototype.close = () => new Promise<void>(() => undefined);
const service = await startService({ home, port: 0, roots: isolatedHistoryRoots(), noUpdateCheck: true, exitOnStop: true });
const prepared = await waitForPreparation(service.instance, 30_000);
const database = new Database(join(home, "index.sqlite"));
database.exec("CREATE TABLE synthetic_stop_test(value INTEGER); INSERT INTO synthetic_stop_test VALUES(1)");
process.send({ instance: service.instance, version: prepared.preparation?.sourceVersion });
process.on("message", message => {
  if (message !== "block") return;
  // 在本测试专用库中留下未提交事务，再阻塞主线程；控制 Worker 必须仍能停止进程。
  database.exec("BEGIN IMMEDIATE; INSERT INTO synthetic_stop_test VALUES(2)");
  process.send!({ blocked: true }, () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });
});
