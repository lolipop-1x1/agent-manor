import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import test from "node:test";
import type { ServiceInstance } from "../src/contracts.js";
import { delay } from "../src/service/runtime.js";

test("HTTP 的索引写入等待外部锁时，状态和已发布结果仍能读取；失败命令不阻断后续写入", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-http-lock-"));
  const home = join(directory, "data"), history = join(directory, "history"), repo = join(directory, "repo");
  await mkdir(history); await mkdir(repo);
  execFileSync("git", ["init", "-q", repo]);
  await writeFile(join(repo, "sample.ts"), "export const sample = true;\n");
  execFileSync("git", ["-C", repo, "add", "sample.ts"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Example", "-c", "user.email=example@example.invalid", "commit", "-qm", "initial"]);
  await writeFile(join(history, "example.jsonl"), [
    { type: "session_meta", payload: { id: "synthetic-lock-session", cwd: repo } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "检查示例文件" }] } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const child = fork(fileURLToPath(new URL("./helpers/http-lock-service.ts", import.meta.url)), [home, history], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, AGENT_MANOR_NO_UPDATE_CHECK: "1" },
  });
  let diagnostics = "", database: Database.Database | undefined;
  child.stderr!.on("data", chunk => { diagnostics += chunk; });
  try {
    const instance = await new Promise<ServiceInstance>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`服务启动超时: ${diagnostics}`)), 20_000);
      child.once("message", value => { clearTimeout(timer); resolve(value.ready); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(diagnostics)); });
    });
    const base = `http://127.0.0.1:${instance.port}/api/v1`;
    const request = async (path: string, method = "GET", body?: unknown, timeout = 10_000) => {
      const response = await fetch(base + path, { method, signal: AbortSignal.timeout(timeout), headers: {
        "x-agent-manor-instance": instance.id, ...(body !== undefined ? { "content-type": "application/json" } : {}),
      }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };
    const waitJob = async (id: string) => {
      for (let count = 0; count < 200; count++) {
        const { body } = await request(`/jobs/${id}`);
        if (["complete", "completed", "failed"].includes(body.job.status)) { assert.notEqual(body.job.status, "failed", JSON.stringify(body)); return; }
        await delay(20);
      }
      assert.fail("合成任务没有完成");
    };
    database = new Database(join(home, "index.sqlite"));
    const locked = async (path: string, method: string, body?: unknown) => {
      database!.exec("BEGIN IMMEDIATE");
      let settled = false;
      const write = request(path, method, body).finally(() => { settled = true; });
      try {
        await delay(100);
        // 持锁进程与服务完全独立；读取必须在释放锁之前完成。
        assert.equal((await request("/status?summary=true&response=summary", "GET", undefined, 2000)).status, 200);
        assert.equal((await request("/repositories", "GET", undefined, 2000)).status, 200);
        assert.equal(settled, false, `${path} 应等待写入提交`);
      } finally { database!.exec("ROLLBACK"); }
      const response = await write;
      assert.equal(response.status, 200, JSON.stringify(response.body));
      if (response.body.job) await waitJob(response.body.job.id);
      return response.body;
    };
    const registered = await locked("/repositories", "POST", { path: repo });
    const id = registered.repository.id;
    assert.deepEqual(Object.keys((await request("/repositories", "POST", { path: repo })).body), ["repository"]);
    const sources = (await request(`/repositories/${id}/sources`)).body;
    const sourceId = sources.sources[0]?.sourceId ?? sources.unassociated[0]?.sourceId;
    assert.ok(sourceId);
    await locked(`/repositories/${id}/associations`, "POST", { sourceId });
    await locked(`/repositories/${id}/refresh`, "POST", {});
    await locked(`/repositories/${id}/cache`, "DELETE");
    await locked("/sessions/refresh", "POST", {});
    await locked("/sessions/cache", "DELETE");
    database.exec("BEGIN IMMEDIATE");
    try {
      const timedOut = request("/sessions/refresh", "POST", {});
      await delay(100);
      assert.equal((await request("/status?summary=true&response=summary", "GET", undefined, 2000)).status, 200);
      assert.equal((await timedOut).status, 500, "写锁超时应回传错误，不假装任务已创建");
    } finally { database.exec("ROLLBACK"); }
    const recovered = await request("/sessions/refresh", "POST", {});
    assert.equal(recovered.status, 200); await waitJob(recovered.body.job.id);
    assert.equal((await request(`/repositories/${id}/associations`, "POST", { sourceId: "missing" })).status, 404);
    assert.equal((await request(`/repositories/${id}/refresh`, "POST", {})).status, 200, "失败不污染写队列");
    await locked(`/repositories/${id}`, "DELETE");
    assert.equal((await request(`/repositories/${id}/refresh`, "POST", {})).status, 404);
    assert.equal((await request("/sessions?response=summary")).body.total, 1, "删仓库保留全局会话");
  } finally {
    if (database?.inTransaction) database.exec("ROLLBACK");
    database?.close();
    const exited = once(child, "exit");
    if (child.connected) child.send("close");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited; clearTimeout(timer);
    await rm(directory, { recursive: true, force: true });
  }
});
