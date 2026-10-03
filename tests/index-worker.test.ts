import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { AnalysisStore, WorkerManager } from "../src/index/index.js";

const git = promisify(execFile);

test("源码入口长期Worker串行跨仓库刷新，查询仍绑定已发布版", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-worker-test-"));
  const store = new AnalysisStore(join(directory, "index.sqlite"));
  const manager = new WorkerManager(store, { roots: { codex: [], claude: [] } });
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
  const manager = new WorkerManager(store, { roots: { codex: [], claude: [] } });
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
