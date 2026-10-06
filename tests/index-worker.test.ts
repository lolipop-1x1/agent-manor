import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { AnalysisStore, WorkerManager } from "../src/index/index.js";
import { refreshRepository } from "../src/index/refresh.js";

const git = promisify(execFile);

test("大量无 cwd 外部返回不占满 Worker 堆，相关范围和未关联来源完整保留", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-worker-memory-test-"));
  const repository = join(directory, "repo");
  const history = join(directory, "history");
  try {
    await mkdir(repository);
    await mkdir(history);
    await git("git", ["init", "-q", repository]);
    await writeFile(join(repository, "a.ts"), "alpha\n");
    for (let index = 0; index < 25; index++) {
      const sessionId = `synthetic-${index}`;
      const filePath = index === 24 ? join(repository, "a.ts") : "/synthetic/unrelated/a.ts";
      const content = index === 24 ? "alpha\n" : "x".repeat(500_000);
      const records = [
        { type: "config", sessionId },
        { type: "message", sessionId, uuid: "request", role: "assistant", content: [{ type: "tool_use", id: "read", name: "read", input: { file_path: filePath } }] },
        { type: "message", sessionId, uuid: "result", role: "tool", content: [{ type: "tool-result", toolCallId: "read", toolName: "read", result: {
          llmContent: JSON.stringify({ type: "text", filePath, content, totalLines: index === 24 ? 2 : 1, offset: 1, limit: 2, actualLinesRead: index === 24 ? 2 : 1 }),
          returnDisplay: "Read 1 line.", truncated: false,
        } }] },
      ];
      await writeFile(join(history, `${sessionId}.jsonl`), records.map(record => JSON.stringify(record) + "\n").join(""));
    }
    const helper = new URL("./fixtures/worker-memory.ts", import.meta.url).pathname;
    const result = await git(process.execPath, ["--max-old-space-size=96", "--import", "tsx", helper, repository, history, directory], { timeout: 30_000 });
    assert.match(result.stdout, /首次分析与增量刷新通过/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Worker 异常后保留旧版与失败任务，下一次刷新重新创建 Worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-worker-retry-test-"));
  const repositoryPath = join(directory, "repo");
  await mkdir(repositoryPath);
  await git("git", ["init", "-q", repositoryPath]);
  await writeFile(join(repositoryPath, "a.ts"), "alpha\n");
  const store = new AnalysisStore(join(directory, "index.sqlite"));
  const repository = await store.registerRepository(repositoryPath);
  const roots = { codex: [], claude: [], codeflicker: [], "codeflicker-desktop": [], dsh: [], pi: [], workbuddy: [], opencode: [], zcode: [], codebuddy: [], qoder: [] };
  const initial = store.createJob(repository.id);
  await refreshRepository(store, initial.id, roots);
  const version = store.getRepository(repository.id).version;
  const marker = join(directory, "failed-once");
  const script = join(directory, "worker.mjs");
  const workerUrl = new URL("../src/worker.ts", import.meta.url).href;
  await writeFile(script, `import { existsSync, writeFileSync } from 'node:fs';
if (!existsSync(${JSON.stringify(marker)})) {
  writeFileSync(${JSON.stringify(marker)}, 'failed');
  throw new Error('synthetic Worker memory failure');
}
const { register } = await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))});
register();
await import(${JSON.stringify(workerUrl)});
`);
  const manager = new WorkerManager(store, { roots, workerUrl: new URL(`file://${script}`) });
  try {
    const first = manager.refresh(repository.id);
    const queued = manager.refresh(repository.id);
    assert.equal((await manager.waitForJob(first.id)).status, "failed");
    assert.equal((await manager.waitForJob(queued.id)).status, "failed");
    assert.equal(store.getSnapshot(repository.id).version, version);
    assert.equal(store.getSnapshot(repository.id).repository.stale, true);
    const retry = await manager.waitForJob(manager.refresh(repository.id).id);
    assert.equal(retry.status, "completed", retry.error);
    assert.notEqual(retry.version, version);
    assert.equal(store.getJob(first.id).status, "failed");
  } finally {
    await manager.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("源码入口长期Worker串行跨仓库刷新，查询仍绑定已发布版", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-worker-test-"));
  const store = new AnalysisStore(join(directory, "index.sqlite"));
  const manager = new WorkerManager(store, { roots: { codex: [], claude: [], codeflicker: [], "codeflicker-desktop": [], dsh: [], pi: [], workbuddy: [], opencode: [], zcode: [], codebuddy: [], qoder: [] } });
  try {
    const repositories = [];
    for (const name of ["first", "second"]) {
      const path = join(directory, name);
      await mkdir(path);
      await git("git", ["init", "-q", path]);
      await writeFile(join(path, "a.ts"), "alpha\n");
      repositories.push(await store.registerRepository(path));
    }
    const first = manager.refresh(repositories[0]!.id);
    const second = manager.refresh(repositories[1]!.id);
    const firstResult = await manager.waitForJob(first.id);
    const secondResult = await manager.waitForJob(second.id);
    assert.equal(firstResult.status, "completed", firstResult.error);
    assert.equal(secondResult.status, "completed", secondResult.error);
    assert.ok(secondResult.startedAt! >= firstResult.finishedAt!);
    const previous = store.getSnapshot(repositories[0]!.id);
    await writeFile(join(repositories[0]!.path, "a.ts"), "new\nalpha\n");
    const third = manager.refresh(repositories[0]!.id);
    assert.equal(store.getSnapshot(repositories[0]!.id).version, previous.version);
    const thirdResult = await manager.waitForJob(third.id);
    assert.equal(thirdResult.status, "completed", thirdResult.error);
    assert.notEqual(thirdResult.version, previous.version);
    assert.equal(store.getSnapshot(repositories[0]!.id, previous.version).baseline.files[0]!.content, "alpha\n");
    const clear = await manager.waitForJob(manager.clearCache(repositories[0]!.id).id);
    assert.equal(clear.status, "completed", clear.error);
  } finally {
    await manager.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("构造恢复遗留任务，停止等待刷新标失败且旧完整结果仍可查询", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-worker-stop-test-"));
  const path = join(directory, "repo");
  await mkdir(path);
  await git("git", ["init", "-q", path]);
  await writeFile(join(path, "a.ts"), "alpha\n");
  const store = new AnalysisStore(join(directory, "index.sqlite"));
  const repository = await store.registerRepository(path);
  const abandoned = store.createJob(repository.id);
  store.updateJob(abandoned.id, { status: "running" });
  const manager = new WorkerManager(store, { roots: { codex: [], claude: [], codeflicker: [], "codeflicker-desktop": [], dsh: [], pi: [], workbuddy: [], opencode: [], zcode: [], codebuddy: [], qoder: [] } });
  try {
    assert.equal(store.getJob(abandoned.id).status, "failed");
    assert.equal(store.getRepository(repository.id).stale, true);
    assert.equal((await manager.waitForJob(manager.refresh(repository.id).id)).status, "completed");
    const version = store.getRepository(repository.id).version;
    const queued = manager.refresh(repository.id);
    const waiting = manager.waitForJob(queued.id);
    await manager.close();
    assert.equal((await waiting).status, "failed");
    assert.equal(store.getRepository(repository.id).version, version);
    assert.equal(store.getSnapshot(repository.id).repository.stale, true);
    assert.throws(() => manager.refresh(repository.id), /已关闭/);
  } finally {
    await manager.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
