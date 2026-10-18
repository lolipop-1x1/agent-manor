import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import test from "node:test";
import Fastify from "fastify";
import type { AnalysisSnapshot, CoverageResult } from "../src/contracts.js";
import { scanRepository } from "../src/analysis/baseline.js";
import { buildCoverage } from "../src/analysis/coverage.js";
import { MapQueryManager } from "../src/analysis/query-manager.js";
import { MapQueryService } from "../src/analysis/query-service.js";
import { AnalysisStore, StoreError } from "../src/index/store.js";
import { SessionStore } from "../src/sessions/store.js";
import { registerMapQueryRoutes } from "../src/service/map-query-routes.js";

const run = promisify(execFile);
async function fixture(body: (context: { analysis: AnalysisStore; sessions: SessionStore; manager: MapQueryManager;
  snapshot: AnalysisSnapshot; publish(version: string): void }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-map-query-"));
  const repositoryPath = join(directory, "repo");
  await mkdir(repositoryPath);
  await run("git", ["init", "-q", repositoryPath]);
  await writeFile(join(repositoryPath, "a.ts"), "alpha\n");
  const analysis = new AnalysisStore(join(directory, "index.sqlite"));
  const sessions = new SessionStore(analysis.dbPath);
  const manager = new MapQueryManager(analysis, 1);
  try {
    const repository = await analysis.registerRepository(repositoryPath);
    const snapshot: AnalysisSnapshot = { repository, baseline: await scanRepository(repositoryPath), version: "map-v1",
      createdAt: "2026-01-01T00:00:00Z", sources: [], mappings: [], gaps: [], events: [
        { id: "read", client: "codex", sessionId: "synthetic", tool: "read", kind: "read", status: "success", path: "a.ts",
          input: { path: "a.ts" }, output: "alpha\n", fragments: [], sources: [] },
      ] };
    const publish = (version: string) => {
      const job = analysis.createJob(repository.id);
      analysis.updateJob(job.id, { status: "running" });
      analysis.publish({ snapshot: { ...snapshot, version }, sources: { version, sources: [], unassociated: [], gaps: [] },
        parsed: [], mappings: [], stats: { sourcesParsed: 0, parsedRecords: 0, mappingsComputed: 0, mappingsReused: 0 }, clearCache: false, jobId: job.id });
    };
    publish(snapshot.version);
    await body({ analysis, sessions, manager, snapshot, publish });
  } finally { await manager.close(); sessions.close(); analysis.close(); await rm(directory, { recursive: true, force: true }); }
}

interface InternalManager { createWorker(): Worker; observe(worker: Worker): void; worker?: Worker; nextId: number; queue: unknown[] }
function controlled(manager: MapQueryManager, dbPath: string) {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  let notify!: () => void;
  const blocked = new Promise<void>(resolve => { notify = resolve; });
  const state = manager as unknown as InternalManager;
  state.createWorker = () => {
    // 在真实线程的覆盖投影入口等待，健康请求必须能在释放查询之前完成。
    const worker = new Worker(`import('tsx/esm/api').then(async ({register}) => {
      register();
      const {parentPort,workerData}=await import('node:worker_threads');
      const {AnalysisStore}=await import(${JSON.stringify(new URL("../src/index/store.ts", import.meta.url).href)});
      const original=AnalysisStore.prototype.getCoverageSnapshot;
      AnalysisStore.prototype.getCoverageSnapshot=function(...args) {
        parentPort.postMessage({test:'blocked'});
        Atomics.wait(new Int32Array(workerData.gate),0,0);
        return original.apply(this,args);
      };
      await import(${JSON.stringify(new URL("../src/analysis/query-worker.ts", import.meta.url).href)});
    });`, { eval: true, workerData: { dbPath, gate: gate.buffer } });
    worker.on("message", message => { if (message.test === "blocked") notify(); });
    state.observe(worker);
    return worker;
  };
  return { blocked, state, release: () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); } };
}

test("地图 Worker 读取被阻塞时其他 HTTP 请求可响应，同条件合并且取消不累积排队", { timeout: 15000 }, () => fixture(async ({ analysis, manager, snapshot }) => {
  const control = controlled(manager, analysis.dbPath);
  const app = Fastify({ forceCloseConnections: true });
  app.get("/health", () => ({ ready: true }));
  registerMapQueryRoutes(app, manager);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const query = { repositoryId: snapshot.repository.id };
  try {
    const active = fetch(`${origin}/api/v1/repositories/${query.repositoryId}/coverage`).then(response => response.json());
    await control.blocked;
    assert.deepEqual(await (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).json(), { ready: true });
    const duplicate = manager.execute("coverage", query);
    assert.equal(control.state.nextId, 1);
    const cancellation = new AbortController();
    const queued = manager.execute("sessions", query, cancellation.signal);
    const rejected = assert.rejects(queued, { name: "AbortError" });
    await assert.rejects(manager.execute("events", query), error => error instanceof StoreError && error.code === "ANALYSIS_NOT_READY");
    cancellation.abort(); await rejected;
    assert.equal(control.state.queue.length, 0);
    control.release();
    assert.equal((await active).files.length, 1);
    assert.equal((await duplicate as CoverageResult).files.length, 1);
  } finally { control.release(); await app.close(); }
}));

test("地图快照按完整版本复用，统计相同且只按需回读活动正文，淘汰后不能继续用缓存", () => fixture(async ({ analysis, sessions, snapshot, publish }) => {
  const service = new MapQueryService(analysis, sessions);
  const query = { repositoryId: snapshot.repository.id, version: snapshot.version };
  const full = analysis.getSnapshot(query.repositoryId, query.version);
  let reads = 0;
  const original = analysis.getCoverageSnapshot.bind(analysis);
  analysis.getCoverageSnapshot = (...args) => { reads++; return original(...args); };
  analysis.getSnapshot = () => { throw new Error("不得恢复整仓正文"); };
  assert.deepEqual(await service.execute("coverage", query), buildCoverage(full));
  await service.execute("sessions", query);
  const events = await service.execute("events", query) as { events: unknown[] };
  assert.deepEqual(events.events, full.events);
  assert.equal(reads, 1);
  publish("map-v2");
  assert.equal((await service.execute("coverage", query) as CoverageResult).stale, true);
  assert.equal(reads, 1);
  publish("map-v3");
  await assert.rejects(service.execute("coverage", query), error => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
}));

test("排队固定旧版本，后台发布后不混入新版本；线程退出拒绝订阅并可重建", { timeout: 15000 }, () => fixture(async ({ analysis, manager, snapshot, publish }) => {
  const control = controlled(manager, analysis.dbPath);
  const query = { repositoryId: snapshot.repository.id };
  const first = manager.execute("coverage", query);
  await control.blocked;
  const queued = manager.execute("hotspots", query);
  publish("map-v2");
  control.release();
  assert.equal((await first as CoverageResult).version, "map-v1");
  assert.equal((await queued as CoverageResult).version, "map-v1");
  assert.equal((await manager.execute("coverage", query) as CoverageResult).version, "map-v2");
  await control.state.worker!.terminate();
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(manager.execute("coverage", query, cancelled.signal), { name: "AbortError" });
  assert.equal((await manager.execute("coverage", query) as CoverageResult).files.length, 1);
  await manager.close();
  await assert.rejects(manager.execute("coverage", query), error => error instanceof StoreError && error.messageDescriptor?.key === "codeMap.error.queryStopped");
}));

test("排队版本被淘汰明确报错，不用新版本或缓存补齐旧结果", { timeout: 15000 }, () => fixture(async ({ analysis, manager, snapshot, publish }) => {
  const control = controlled(manager, analysis.dbPath);
  const query = { repositoryId: snapshot.repository.id };
  const first = manager.execute("coverage", query);
  const rejected = assert.rejects(first, error => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
  await control.blocked;
  const queued = manager.execute("sessions", query);
  const queueRejected = assert.rejects(queued, error => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
  publish("map-v2"); publish("map-v3");
  control.release();
  await Promise.all([rejected, queueRejected]);
  assert.equal((await manager.execute("coverage", query) as CoverageResult).version, "map-v3");
}));

test("大仓库文件下钻按活动索引匹配映射，不逐活动重扫整张映射表", { timeout: 15000 }, () => fixture(async ({ analysis, sessions, snapshot, publish }) => {
  const count = 30000;
  snapshot.baseline.files.push({ ...snapshot.baseline.files[0]!, path: "b.ts" });
  snapshot.events = Array.from({ length: count }, (_, index) => ({ ...snapshot.events[0]!, id: `event-${index}`, path: "b.ts" }));
  snapshot.mappings = snapshot.events.map((event, index) => ({ eventId: event.id, filePath: index === 0 ? "a.ts" : "b.ts", kind: "read",
    exactRanges: [{ start: 1, end: 1 }], nearRanges: [], ruleVersion: "synthetic" }));
  publish("large-map");
  const service = new MapQueryService(analysis, sessions);
  const query = { repositoryId: snapshot.repository.id, version: "large-map" };
  await service.execute("coverage", query);
  const started = performance.now();
  const result = await service.execute("file", { ...query, path: "a.ts" }) as { events: { id: string }[] };
  assert.deepEqual(result.events.map(event => event.id), ["event-0"]);
  assert.ok(performance.now() - started < 3000, "三万活动下钻应按索引查询，不能进行九亿次映射匹配");
}));
