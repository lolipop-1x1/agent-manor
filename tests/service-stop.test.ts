import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import Database from "better-sqlite3";
import type { ServiceInstance } from "../src/contracts.js";
import { SessionStore } from "../src/sessions/store.js";
import { startService } from "../src/server.js";
import { serviceStatus, stopService, writeInstance } from "../src/service/runtime.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

test("默认停止不再被正在进行的启动准备拦截，重复停止保持幂等", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-stop-busy-"));
  const service = await startService({ home, port: 0, roots: isolatedHistoryRoots(), noUpdateCheck: true });
  try {
    await assert.rejects(stopService(home, { wait: true, timeoutMs: 0 }), { code: "WAIT_TIMEOUT" });
    assert.equal((await serviceStatus(home)).running, true);
    assert.equal((await stopService(home)).stopped, true);
    assert.equal((await serviceStatus(home)).state, "stopped");
    assert.deepEqual(await stopService(home), { stopped: false });
  } finally { await service.close(); await rm(home, { recursive: true, force: true }); }
});

for (const scenario of ["normal", "control-unavailable", "blocked", "cleanup-hang"] as const) {
  test(`独立控制线程停止 ${scenario} 后台，保留提交结果并支持重启`, { timeout: 25_000 }, async context => {
    const home = await mkdtemp(join(tmpdir(), "manor-stop-process-"));
    const child = fork(fileURLToPath(new URL("./helpers/stop-service.ts", import.meta.url)), [home, scenario], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const exited = once(child, "exit");
    let diagnostics = "";
    child.stderr!.on("data", chunk => { diagnostics += String(chunk); });
    try {
      const [ready] = await Promise.race([once(child, "message"), exited.then(() => { throw new Error(diagnostics); })]);
      const { instance, version } = ready as { instance: ServiceInstance; version: string };
      assert.ok(instance.controlPort);
      const url = `http://127.0.0.1:${instance.controlPort}`;
      await writeInstance(home, { ...instance, id: "synthetic-foreign-instance-record" });
      await assert.rejects(stopService(home), { code: "SERVICE_IDENTITY_UNVERIFIED" });
      await writeInstance(home, instance);
      const forged = await fetch(`${url}/stop`, { method: "POST", headers: { "x-agent-manor-instance": "synthetic-wrong-instance" } });
      assert.equal(forged.status, 403);
      const browser = await fetch(`${url}/stop`, { method: "POST", headers: { "x-agent-manor-instance": instance.id, origin: "http://example.invalid" } });
      assert.equal(browser.status, 403);
      if (scenario === "blocked") {
        const blocked = once(child, "message"); child.send("block");
        assert.deepEqual((await blocked)[0], { blocked: true });
      }
      if (scenario === "control-unavailable") await writeInstance(home, { ...instance, controlPort: instance.port });
      child.disconnect();
      const started = performance.now();
      const results = await Promise.all([stopService(home), stopService(home)]);
      assert.ok(results.every(result => result.stopped));
      const elapsed = performance.now() - started;
      context.diagnostic(`停止 ${scenario}: ${Math.round(elapsed)} ms`);
      const [code, signal] = await exited;
      assert.ok(elapsed < 5000, `停止耗时 ${elapsed} ms`);
      if (scenario === "normal" || scenario === "control-unavailable") assert.equal(code, 0, diagnostics);
      else if (process.platform !== "win32") assert.equal(signal, "SIGKILL");
      assert.deepEqual(await stopService(home), { stopped: false });
      const database = new Database(join(home, "index.sqlite"));
      try {
        assert.equal(database.pragma("quick_check", { simple: true }), "ok");
        assert.deepEqual(database.prepare("SELECT value FROM synthetic_stop_test").all(), [{ value: 1 }]);
      } finally { database.close(); }
      const sessions = new SessionStore(join(home, "index.sqlite"));
      try { assert.equal(sessions.currentVersion(), version); } finally { sessions.close(); }
      const next = await startService({ home, port: 0, roots: isolatedHistoryRoots(), startupRefresh: false, noUpdateCheck: true });
      try { assert.equal((await serviceStatus(home)).instance?.id, next.instance.id); }
      finally { await next.close(); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      await rm(home, { recursive: true, force: true });
    }
  });
}
