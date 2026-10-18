import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { AnalysisStore } from "../src/index/store.js";
import { SessionStore } from "../src/sessions/store.js";
import { UsageManager } from "../src/usage/manager.js";
import { PricingService } from "../src/usage/pricing.js";

test("关闭启动中的用量Worker先等待原生数据库初始化握手", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-usage-shutdown-"));
  const path = join(home, "index.sqlite");
  new AnalysisStore(path).close();
  const sessions = new SessionStore(path), pricing = new PricingService(home, { fetch: async () => new Response("offline", { status: 503 }) });
  const revision = sessions.createRevision("/synthetic/session.jsonl", "fixture");
  revision.sink.message({ id: "m1", sessionId: "s1", ordinal: 1, recordLine: 1, turnId: "t1", kind: "user", text: "Synthetic startup." });
  revision.flush();
  sessions.finishRevision(revision.revision, { id: "s1", client: "codex", clientSessionId: "fixture", sourceId: "source", path: "/synthetic/session.jsonl",
    title: "Synthetic", titleOrigin: "recorded", models: [], gaps: [], messageCount: 1, turnCount: 1 });
  sessions.publish(sessions.createJob().id, [{ path: "/synthetic/session.jsonl", revision: revision.revision, fingerprint: "fixture" }], []);
  const manager = new UsageManager(sessions, pricing, join(home, "usage.sqlite"));
  manager.start();
  const worker = (manager as unknown as { worker: Worker }).worker;
  assert.ok(worker);
  const terminate = worker.terminate.bind(worker);
  let ready = false;
  const initialized = new Promise<void>(resolve => worker.once("message", () => resolve()));
  worker.on("message", message => { if (message.type === "ready") ready = true; });
  worker.terminate = () => {
    assert.equal(ready, true, "不能在SQLite原生模块初始化过程中强制终止线程");
    return terminate();
  };
  try {
    await manager.close();
    assert.equal(ready, true);
  } finally {
    // 旧实现的红测试也等待首个数据库消息后清理，避免测试本身中断原生加载。
    await initialized;
    await terminate();
    pricing.close(); sessions.close();
    await rm(home, { recursive: true, force: true });
  }
});
