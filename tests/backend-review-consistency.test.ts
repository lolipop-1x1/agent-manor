import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { AnalysisSnapshot, HistorySource, Repository } from "../src/contracts.js";
import { filterHistoricalEvents } from "../src/analysis/coverage.js";
import { AnalysisStore } from "../src/index/store.js";
import { startService } from "../src/server.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

function snapshot(repository: Repository, version: string): AnalysisSnapshot {
  const source: HistorySource = { sourceId: "codex:synthetic", client: "codex", format: "codex-jsonl", path: "/workspace/history/synthetic.jsonl",
    hash: "synthetic", sessionId: "synthetic", eventCount: 1, completeBytes: 1 };
  return { repository, version, baseline: { repository, hash: "synthetic", createdAt: "2026-01-01T00:00:00Z", git: { dirty: false }, files: [], excluded: [] },
    sources: [source], events: [], mappings: [], gaps: [{ kind: "range_unknown", message: "synthetic gap" }], createdAt: "2026-01-01T00:00:00Z" };
}

async function fixture(body: (store: AnalysisStore, repository: Repository) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-backend-consistency-"));
  const store = new AnalysisStore(join(directory, "index.sqlite"));
  const database = new Database(store.dbPath);
  const repository: Repository = { id: "synthetic", path: "/workspace/synthetic", commonDir: "/workspace/synthetic/.git", name: "synthetic", stale: false };
  database.prepare("INSERT INTO repositories(id,json,stale) VALUES(?,?,0)").run(repository.id, JSON.stringify(repository));
  database.close();
  try { await body(store, repository); }
  finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

function publish(store: AnalysisStore, repository: Repository, version: string) {
  const current = snapshot(repository, version), job = store.createJob(repository.id);
  store.updateJob(job.id, { status: "running" });
  store.publish({ snapshot: current, sources: { version, sources: current.sources, unassociated: [], gaps: current.gaps }, parsed: [], mappings: [],
    stats: { sourcesParsed: 0, parsedRecords: 0, mappingsComputed: 0, mappingsReused: 0 }, clearCache: false, jobId: job.id });
}

test("来源与缺口在版本淘汰交错时仍属于同一完整读快照", () => fixture(async (writer, repository) => {
  publish(writer, repository, "v1"); publish(writer, repository, "v2");
  const reader = new AnalysisStore(writer.dbPath, { readonly: true });
  const internal = reader as unknown as { readPayload(...args: unknown[]): unknown };
  try {
    const expected = reader.listSources(repository.id, "v1"), original = internal.readPayload.bind(reader);
    let published = false;
    internal.readPayload = (...args) => {
      if (!published && args[2] === "sources") { published = true; publish(writer, repository, "v3"); }
      return original(...args);
    };
    assert.deepEqual(reader.listSources(repository.id, "v1"), expected);
    assert.throws(() => writer.listSources(repository.id, "v1"), { code: "VERSION_NOT_FOUND" });
    assert.equal(writer.listSources(repository.id, "v3").sources.length, 1);
  } finally { reader.close(); }
}));

test("三万条删除文件历史筛选不会逐事件扫描全部路径", context => {
  const repository: Repository = { id: "synthetic", path: "/workspace/synthetic", commonDir: "/workspace/synthetic/.git", name: "synthetic", stale: false };
  const current = snapshot(repository, "large");
  current.events = Array.from({ length: 30000 }, (_, index) => ({ id: `event-${index}`, client: "codex", sessionId: "synthetic", tool: "read", kind: "read", status: "success",
    cwd: repository.path, path: `src/deleted-${index}.ts`, fragments: [], sources: [] }));
  const started = performance.now(), result = filterHistoricalEvents(current);
  const elapsed = performance.now() - started;
  assert.equal(result.length, current.events.length);
  context.diagnostic(`三万条删除文件历史筛选 ${Math.round(elapsed)} ms`);
  assert.ok(elapsed < 5000, "该规模应使用路径索引，不能执行九亿次路径匹配");
});

test("作业窄查询、分页和保留只影响过期终态，引用和在途记录保持可读", () => fixture(async (store, repository) => {
  publish(store, repository, "retained-version");
  const versionJob = store.listJobs()[0]!;
  const database = new Database(store.dbPath);
  const insert = database.prepare("INSERT INTO jobs(id,repository_id,json) VALUES(?,?,?)");
  database.transaction(() => {
    for (let index = 0; index < 2300; index++) {
      const id = `old-${index}`;
      insert.run(id, repository.id, JSON.stringify({ id, repositoryId: repository.id, status: "failed", phase: "synthetic", progress: 1 }));
    }
  })();
  database.close();
  const queued = store.createJob(repository.id), running = store.createJob(repository.id);
  store.updateJob(running.id, { status: "running" });
  assert.deepEqual(new Set(store.listActiveJobs().map(job => job.id)), new Set([queued.id, running.id]));
  const page = store.jobPage(2, 5, repository.id);
  assert.equal(page.total, 2303); assert.equal(page.jobs.length, 5); assert.equal(page.jobs[0]!.id, "old-2296");
  assert.equal(store.pruneJobs(["old-0"], 100), 100);
  while (store.pruneJobs(["old-0"]) === 1000) { /* 分批清理到保留边界。 */ }
  assert.equal(store.statusCounts().jobCount, 1004);
  assert.equal(store.getJob("old-0").status, "failed");
  assert.equal(store.getJob(versionJob.id).version, "retained-version");
  assert.equal(store.getJob(queued.id).status, "queued");
  assert.equal(store.getJob(running.id).status, "running");
  assert.throws(() => store.getJob("old-1"), { code: "JOB_NOT_FOUND" });
  assert.equal(store.pruneJobs(), 1);
  assert.throws(() => store.getJob("old-0"), { code: "JOB_NOT_FOUND" });
  const latest = new AnalysisStore(store.dbPath, { readonly: true });
  try { assert.equal(latest.listActiveJobs().length, 2); assert.equal(latest.jobPage(1, 10).jobs.length, 10); }
  finally { latest.close(); }
}));

test("旧结构已存作业在重开后获得活动查询索引且保留 JSON 契约", () => fixture(async (store, repository) => {
  const job = store.createJob(repository.id), database = new Database(store.dbPath);
  database.exec("DROP INDEX jobs_status; DROP INDEX jobs_terminal_repository; DROP INDEX jobs_completed_version");
  database.close();
  const reopened = new AnalysisStore(store.dbPath);
  try { assert.deepEqual(reopened.getJob(job.id), job); assert.deepEqual(reopened.listActiveJobs().map(row => row.id), [job.id]); }
  finally { reopened.close(); }
}));

test("目录后代的类别与目录交集不混入同名前缀路径", () => {
  const repository: Repository = { id: "synthetic", path: "/workspace/synthetic", commonDir: "/workspace/synthetic/.git", name: "synthetic", stale: false };
  const current = snapshot(repository, "prefix");
  current.baseline.files = [
    { path: "src/a.ts", category: "source", hash: "a", content: "", lineCount: 0 },
    { path: "src/docs/guide.md", category: "docs", hash: "b", content: "", lineCount: 0 },
    { path: "src-other/other.ts", category: "source", hash: "c", content: "", lineCount: 0 },
  ];
  current.events = ["src", "src/docs", "src-other"].map(path => ({ id: path, client: "codex", sessionId: "synthetic", tool: "search", kind: "search", status: "success", path, fragments: [], sources: [] }));
  assert.deepEqual(filterHistoricalEvents(current, { categories: ["source"], directory: "src/docs" }), []);
  assert.deepEqual(filterHistoricalEvents(current, { categories: ["docs"], directory: "src/docs" }).map(row => row.id), ["src", "src/docs"]);
  assert.deepEqual(filterHistoricalEvents(current, { categories: ["source"], directory: "src" }).map(row => row.id), ["src"]);
  assert.deepEqual(filterHistoricalEvents(current, { categories: ["source"], directory: "src-other" }).map(row => row.id), ["src-other"]);
});

test("精简 HTTP 状态不读取完整历史作业，历史列表提供独立分页", context => fixture(async (store, repository) => {
  const service = await startService({ home: dirname(store.dbPath), port: 0, startupRefresh: false, roots: isolatedHistoryRoots(), noUpdateCheck: true });
  const get = (url: string) => service.app.inject({ method: "GET", url, headers: { host: `127.0.0.1:${service.instance.port}` } });
  try {
    const job = store.createJob(repository.id);
    for (let index = 0; index < 60; index++) {
      const completed = store.createJob(repository.id);
      store.updateJob(completed.id, { status: "completed", progress: 1 });
    }
    context.mock.method(AnalysisStore.prototype, "listJobs", () => { throw new Error("完整历史读取不应进入精简状态路径"); });
    const response = await get("/api/v1/status?response=summary");
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().jobCount, 61);
    assert.deepEqual(response.json().activeTasks.filter((row: { kind: string }) => row.kind === "repository"), [{ id: job.id, kind: "repository", status: "queued" }]);
    const history = await get("/api/v1/jobs?page=2&pageSize=7");
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().total, 61); assert.equal(history.json().jobs.length, 7); assert.equal(history.json().page, 2);
    assert.equal((await get("/api/v1/jobs?pageSize=0")).statusCode, 400);
  } finally { await service.close(); }
}));
