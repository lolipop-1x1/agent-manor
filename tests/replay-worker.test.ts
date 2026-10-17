import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import test from "node:test";
import Fastify from "fastify";
import type { AnalysisSnapshot } from "../src/contracts.js";
import type { ReplayResult, ReplaySessionsResult } from "../src/replay-contracts.js";
import { scanRepository } from "../src/analysis/baseline.js";
import { AnalysisStore, StoreError } from "../src/index/store.js";
import { ReplayManager } from "../src/replay/manager.js";
import { ReplayService } from "../src/replay/service.js";
import { registerReplayRoutes } from "../src/service/replay-routes.js";
import { SessionStore } from "../src/sessions/store.js";

const run = promisify(execFile);
const time = "2026-01-01T00:00:01.000Z";
async function fixture(body: (context: { analysis: AnalysisStore; sessions: SessionStore; manager: ReplayManager;
  snapshot: AnalysisSnapshot; sessionVersion: string; publishMap(version: string): void; publishSessions(title: string): string }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-replay-worker-"));
  const repositoryPath = join(directory, "repo");
  await mkdir(repositoryPath);
  await run("git", ["init", "-q", repositoryPath]);
  await writeFile(join(repositoryPath, "a.ts"), "export const a = 1;\n");
  const analysis = new AnalysisStore(join(directory, "index.sqlite"));
  const sessions = new SessionStore(analysis.dbPath);
  const manager = new ReplayManager(analysis, sessions, 1);
  try {
    const repository = await analysis.registerRepository(repositoryPath);
    const baseline = await scanRepository(repositoryPath);
    const snapshot: AnalysisSnapshot = { repository, baseline, version: "map-v1", createdAt: time, sources: [], mappings: [], gaps: [],
      events: [{ id: "activity", client: "codex", sessionId: "native-single", tool: "read", kind: "read", status: "success", path: "a.ts",
        occurredAt: time, fragments: [], sources: [{ sourceId: "synthetic", path: "/workspace/replay.jsonl", recordLine: 1, hash: "synthetic" }] }] };
    const publishMap = (version: string) => {
      const job = analysis.createJob(repository.id);
      analysis.updateJob(job.id, { status: "running" });
      analysis.publish({ snapshot: { ...snapshot, version }, sources: { version, sources: [], unassociated: [], gaps: [] },
        parsed: [], mappings: [], stats: { sourcesParsed: 0, parsedRecords: 0, mappingsComputed: 0, mappingsReused: 0 }, clearCache: false, jobId: job.id });
    };
    const publishSessions = (title: string) => {
      const pending = sessions.createRevision("/workspace/replay.jsonl", title);
      pending.sink.message({ id: "message", sessionId: "single", ordinal: 1, recordLine: 1, turnId: "turn", kind: "tool_call", tool: "read", callId: "read", text: "合成读取", occurredAt: time });
      pending.flush();
      sessions.finishRevision(pending.revision, { id: "single", client: "codex", clientSessionId: "native-single", path: "/workspace/replay.jsonl",
        sourceId: "synthetic", title, titleOrigin: "recorded", messageCount: 1, turnCount: 1, models: [], gaps: [] });
      return sessions.publish(sessions.createJob().id, [{ path: "/workspace/replay.jsonl", revision: pending.revision, fingerprint: title }], []);
    };
    publishMap(snapshot.version);
    const sessionVersion = publishSessions("初始合成标题");
    await body({ analysis, sessions, manager, snapshot, sessionVersion, publishMap, publishSessions });
  } finally { await manager.close(); sessions.close(); analysis.close(); await rm(directory, { recursive: true, force: true }); }
}

interface InternalManager { createWorker(): Worker; observe(worker: Worker): void; worker?: Worker; nextId: number; queue: unknown[] }
function controlled(manager: ReplayManager, dbPath: string, fault = false) {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  let notify!: () => void;
  const blocked = new Promise<void>(resolve => { notify = resolve; });
  const internal = manager as unknown as InternalManager;
  internal.createWorker = () => {
    // 仅在测试线程内阻塞真实投影入口，确保健康检查恰好与同步读取重叠。
    const worker = new Worker(`import('tsx/esm/api').then(async ({register}) => {
      register();
      const {parentPort,workerData}=await import('node:worker_threads');
      const {AnalysisStore}=await import(${JSON.stringify(new URL("../src/index/store.ts", import.meta.url).href)});
      const original=AnalysisStore.prototype.getReplaySnapshot;
      AnalysisStore.prototype.getReplaySnapshot=function(...args) {
        parentPort.postMessage({test:'blocked'});
        Atomics.wait(new Int32Array(workerData.gate),0,0);
        if (workerData.fault) throw new Error('合成内部故障');
        return original.apply(this,args);
      };
      await import(${JSON.stringify(new URL("../src/replay/worker.ts", import.meta.url).href)});
    });`, { eval: true, workerData: { dbPath, gate: gate.buffer, fault } });
    worker.on("message", message => { if (message.test === "blocked") notify(); });
    internal.observe(worker);
    return worker;
  };
  return { blocked, state: internal, release: () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); } };
}

async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "异步条件应在限定时间内完成");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("真实回放 Worker 同步读取期间 HTTP 健康检查保持响应，断开请求移除排队订阅", { timeout: 15000 }, () => fixture(async ({ analysis, sessions, manager, snapshot }) => {
  const control = controlled(manager, analysis.dbPath);
  assert.equal(control.state.worker, undefined, "空闲管理器不应预先启动线程");
  analysis.getReplaySnapshot = () => { throw new Error("主线程不得执行回放投影"); };
  analysis.getCoverageSnapshot = () => { throw new Error("主线程不得执行覆盖投影"); };
  analysis.getSnapshot = () => { throw new Error("主线程不得执行正文加载"); };
  sessions.replayDirectory = () => { throw new Error("主线程不得执行会话投影"); };
  const app = Fastify();
  app.addHook("onClose", () => manager.close());
  app.get("/health", () => ({ ready: true }));
  registerReplayRoutes(app, manager);
  const origin = await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `${origin}/api/v1/repositories/${snapshot.repository.id}/replay`;
  try {
    const replay = fetch(`${base}/sessions`).then(response => response.json()) as Promise<ReplaySessionsResult>;
    await control.blocked;
    const started = performance.now();
    assert.deepEqual(await (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).json(), { ready: true });
    assert.ok(performance.now() - started < 1000, "同步工作线程不应阻塞健康请求");
    const cancellation = new AbortController();
    const waiting = fetch(`${base}?sessionId=single`, { signal: cancellation.signal });
    const rejected = assert.rejects(waiting, { name: "AbortError" });
    await waitUntil(() => control.state.queue.length === 1);
    cancellation.abort();
    await rejected;
    await waitUntil(() => control.state.queue.length === 0);
    control.release();
    assert.equal((await replay).sessions[0]!.eventCount, 1);
  } finally { control.release(); await app.close(); }
}));

test("回放合并同条件订阅，队列有界，取消一方或全部排队订阅后继续执行", { timeout: 15000 }, () => fixture(async ({ analysis, manager, snapshot }) => {
  const control = controlled(manager, analysis.dbPath);
  const query = { repositoryId: snapshot.repository.id };
  const first = new AbortController();
  const one = manager.execute("sessions", query, first.signal);
  const rejectedOne = assert.rejects(one, { name: "AbortError" });
  const two = manager.execute("sessions", query);
  assert.equal(control.state.nextId, 1, "同条件只执行一个作业");
  await control.blocked;
  const waiting = new AbortController();
  const queued = manager.execute("replay", { ...query, sessionId: "single" }, waiting.signal);
  const rejectedQueued = assert.rejects(queued, { name: "AbortError" });
  await assert.rejects(manager.execute("evidence", { ...query, sessionId: "single", eventId: "activity" }),
    error => error instanceof StoreError && error.code === "ANALYSIS_NOT_READY" && error.messageDescriptor?.key === "replay.busy");
  first.abort(); waiting.abort();
  await Promise.all([rejectedOne, rejectedQueued]);
  assert.equal(control.state.queue.length, 0);
  const replacement = manager.execute("replay", { ...query, sessionId: "single" });
  control.release();
  assert.equal((await two as ReplaySessionsResult).sessions.length, 1);
  assert.equal((await replacement as ReplayResult).totalActivities, 1);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(manager.execute("sessions", query, cancelled.signal), { name: "AbortError" });
}));

test("主线程在入队前固定双版本，后台发布后排队作业仍回放保留的旧版本", { timeout: 15000 }, () => fixture(async ({ analysis, sessions, manager, snapshot, sessionVersion, publishMap, publishSessions }) => {
  const control = controlled(manager, analysis.dbPath);
  const query = { repositoryId: snapshot.repository.id };
  const first = manager.execute("sessions", query);
  await control.blocked;
  const queued = manager.execute("replay", { ...query, sessionId: "single" });
  publishMap("map-v2");
  const nextSessionVersion = publishSessions("更新合成标题");
  control.release();
  const options = await first as ReplaySessionsResult;
  const playback = await queued as ReplayResult;
  assert.equal(options.version, "map-v1");
  assert.equal(options.sessionVersion, sessionVersion);
  assert.equal(playback.version, "map-v1");
  assert.equal(playback.sessionVersion, sessionVersion);
  assert.equal(playback.tracks[0]!.title, "初始合成标题");
  assert.equal(playback.stale, true);
  const latest = await manager.execute("replay", { ...query, sessionId: "single" }) as ReplayResult;
  assert.equal(latest.version, "map-v2");
  assert.equal(latest.sessionVersion, nextSessionVersion);
  assert.deepEqual(latest, new ReplayService(analysis, sessions).replay(snapshot.repository.id, "single"));
}));

test("排队期间任一固定版本被淘汰都明确报错，不混入新分析或新会话", { timeout: 20000 }, async () => {
  for (const target of ["analysis", "sessions"] as const) await fixture(async ({ analysis, manager, snapshot, publishMap, publishSessions }) => {
    const control = controlled(manager, analysis.dbPath);
    const query = { repositoryId: snapshot.repository.id };
    const first = manager.execute("sessions", query);
    const firstRejected = assert.rejects(first, error => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
    await control.blocked;
    const queued = manager.execute("replay", { ...query, sessionId: "single" });
    const queueRejected = assert.rejects(queued, error => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
    if (target === "analysis") { publishMap("map-v2"); publishMap("map-v3"); }
    else { publishSessions("第二合成标题"); publishSessions("第三合成标题"); }
    control.release();
    await Promise.all([firstRejected, queueRejected]);
    assert.equal((await manager.execute("replay", { ...query, sessionId: "single" }) as ReplayResult).totalActivities, 1);
  });
});

test("后台错误保留诊断，线程意外停止后拒绝当前订阅并可重建，关闭拒绝全部订阅", { timeout: 15000 }, () => fixture(async ({ analysis, manager, snapshot }) => {
  const control = controlled(manager, analysis.dbPath);
  const query = { repositoryId: snapshot.repository.id };
  const active = manager.execute("sessions", query);
  const failed = assert.rejects(active, error => error instanceof StoreError && error.code === "INTERNAL_ERROR" && error.messageDescriptor?.key === "replay.stopped");
  await control.blocked;
  await control.state.worker!.terminate();
  await failed;
  control.release();
  await assert.rejects(manager.execute("replay", { ...query, sessionId: "missing" }), error => error instanceof StoreError
    && error.code === "SOURCE_NOT_FOUND" && error.messageDescriptor?.key === "diagnostics.sessions.store.m011");
  assert.equal((await manager.execute("sessions", query) as ReplaySessionsResult).sessions.length, 1);
  const closing = controlled(manager, analysis.dbPath);
  await control.state.worker!.terminate();
  await waitUntil(() => control.state.worker === undefined);
  const one = manager.execute("sessions", query);
  const oneRejected = assert.rejects(one, error => error instanceof StoreError && error.messageDescriptor?.key === "replay.stopped");
  await closing.blocked;
  const two = manager.execute("replay", { ...query, sessionId: "single" });
  const twoRejected = assert.rejects(two, error => error instanceof StoreError && error.messageDescriptor?.key === "replay.stopped");
  await manager.close();
  await Promise.all([oneRejected, twoRejected]);
  await assert.rejects(manager.execute("sessions", query), error => error instanceof StoreError && error.messageDescriptor?.key === "replay.stopped");
}));

test("未识别的回放内部故障使用统一服务诊断，不丢失原始错误", { timeout: 15000 }, () => fixture(async ({ analysis, manager, snapshot }) => {
  const control = controlled(manager, analysis.dbPath, true);
  const result = manager.execute("sessions", { repositoryId: snapshot.repository.id });
  const rejected = assert.rejects(result, error => error instanceof StoreError && error.code === "INTERNAL_ERROR"
    && error.messageDescriptor?.key === "diagnostics.server.m003" && error.message === "合成内部故障");
  await control.blocked;
  control.release();
  await rejected;
}));
