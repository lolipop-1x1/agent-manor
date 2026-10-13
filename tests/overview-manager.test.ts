import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { OverviewManager } from "../src/overview/manager.js";
import { SessionStore } from "../src/sessions/store.js";
import { PricingService } from "../src/usage/pricing.js";

test("后台跨午夜缓存沿用报告日期，显式新报告重新计算完整日期", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-overview-clock-")), store = new SessionStore(join(directory, "index.sqlite"));
  const id = "synthetic-session", path = "/synthetic/history/clock.jsonl", revision = store.createRevision(path, "synthetic");
  for (const [index, day] of ["2026-02-28", "2026-03-01"].entries()) {
    const messageId = `synthetic-message-${index}`;
    revision.sink.message({ id: messageId, sessionId: id, ordinal: index, recordLine: index + 1, turnId: "synthetic-turn",
      kind: "assistant", text: "合成正文", occurredAt: `${day}T12:00:00Z` });
    revision.sink.usage({ id: `synthetic-request-${index}`, messageId, model: "synthetic-model", inputTokens: 100, outputTokens: 20, occurredAt: `${day}T12:00:00Z` });
  }
  revision.flush(); store.finishRevision(revision.revision, { id, client: "codex", clientSessionId: id, path, sourceId: "synthetic-source",
    project: "/synthetic/project", title: "合成日期会话", titleOrigin: "recorded", messageCount: 2, turnCount: 1, models: ["synthetic-model"], gaps: [] });
  store.publish(store.createJob().id, [{ path, revision: revision.revision, fingerprint: "synthetic" }], []);
  let now = new Date("2026-03-01T12:00:00Z");
  const prices = new PricingService(directory), manager = new OverviewManager(store, prices, () => [], () => now);
  try {
    const query = { window: "365" as const, timezone: "UTC", clients: ["codex"], projects: ["/synthetic/project"], models: ["synthetic-model"] };
    const report = await manager.report(query);
    const dispatched = (manager as unknown as { nextId: number }).nextId;
    assert.deepEqual(await manager.report(report.query), report);
    assert.equal((manager as unknown as { nextId: number }).nextId, dispatched);
    await manager.report({ ...report.query, models: ["synthetic-other-model"] });
    const filteredDispatches = (manager as unknown as { nextId: number }).nextId;
    assert.deepEqual(await manager.report(report.query), report);
    assert.equal((manager as unknown as { nextId: number }).nextId, filteredDispatches);
    now = new Date("2026-03-02T12:00:00Z");
    assert.equal(report.query.anchorDay, "2026-03-01");
    assert.deepEqual((await manager.report(report.query)).range, report.range);
    assert.deepEqual((await manager.evidence(report.query, { kind: "requests", period: "current", scope: "usage" })).rows.map(row => row.requestId), ["synthetic-request-0"]);
    assert.equal((await manager.evidence(report.query, { kind: "requests", period: "recent", scope: "usage" })).total, 1);
    const updated = await manager.report(query);
    assert.equal(updated.query.anchorDay, "2026-03-02");
    assert.equal((await manager.evidence(updated.query, { kind: "requests", period: "current", scope: "usage" })).total, 2);
  } finally { await manager.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("核心分区重启复用持久结果，模型身份重绑定且已淘汰版本先拒绝", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-overview-panels-")), store = new SessionStore(join(directory, "index.sqlite"));
  const id = "synthetic-main", path = "/synthetic/main.jsonl", revision = store.createRevision(path, "synthetic");
  revision.sink.message({ id: "synthetic-user", sessionId: id, ordinal: 0, recordLine: 1, turnId: "synthetic-turn", kind: "user", text: "合成正文", occurredAt: "2026-03-01T12:00:00Z" });
  revision.sink.message({ id: "synthetic-tool", sessionId: id, ordinal: 1, recordLine: 2, turnId: "synthetic-turn", kind: "tool_call",
    tool: "synthetic-tool", status: "unknown", text: "合成工具", occurredAt: "2026-03-01T12:00:00Z" });
  revision.sink.usage({ id: "synthetic-request", messageId: "synthetic-user", inputTokens: 100, outputTokens: 20, model: "synthetic-model", occurredAt: "2026-03-01T12:00:00Z" });
  revision.flush(); store.finishRevision(revision.revision, { id, path, sourceId: "synthetic-source", client: "codex", clientSessionId: id,
    title: "合成会话", titleOrigin: "recorded", models: ["synthetic-model"], messageCount: 1, turnCount: 1, gaps: [] });
  const version = store.publish(store.createJob().id, [{ path, revision: revision.revision, fingerprint: "synthetic" }], []);
  const prices = new PricingService(directory), clock = () => new Date("2026-03-01T12:00:00Z");
  const first = new OverviewManager(store, prices, () => [], clock);
  const internal = first as unknown as { dispatch(type: string, ...parameters: unknown[]): Promise<unknown> };
  const dispatch = internal.dispatch.bind(first), dispatchedTypes: string[] = [];
  const processCalls: boolean[] = [];
  internal.dispatch = (type, ...parameters) => {
    dispatchedTypes.push(type);
    if ((parameters[2] as { panel?: string } | undefined)?.panel === "process") processCalls.push(Boolean((parameters[3] as { globalProcess?: unknown })?.globalProcess));
    return dispatch(type, ...parameters);
  };
  const query = { window: "365" as const, timezone: "UTC", version };
  let restarted: OverviewManager | undefined;
  try {
    const [core, duplicate] = await Promise.all([first.panel(query, "core"), first.panel(query, "core"),
      first.panel(query, "resources"), first.panel(query, "process")]);
    assert.deepEqual(core, duplicate); assert.equal(core.data.summary!.requests, 1);
    assert.equal(dispatchedTypes.filter(type => type === "prepare").length, 1);
    const globalProcess = await first.panel(query, "process"), localProcess = await first.panel({ ...query, models: ["synthetic-other"] }, "process");
    assert.deepEqual(localProcess.data.process!.tools, globalProcess.data.process!.tools);
    assert.equal(globalProcess.data.process!.missingTimingRequests, 1); assert.equal(localProcess.data.process!.missingTimingRequests, 0);
    assert.deepEqual(processCalls, [false, true], "局部计时计数复用已缓存全局过程，不重扫工具排行");
    await first.panel({ ...query, window: "30", models: ["synthetic-other"] }, "core");
    assert.equal(dispatchedTypes.filter(type => type === "prepare").length, 1);
    await first.panel({ ...query, timezone: "America/New_York" }, "core");
    assert.equal(dispatchedTypes.filter(type => type === "prepare").length, 2);
    await delay(2100);
    assert.equal((first as unknown as { workers: Map<string, unknown> }).workers.size, 0);
    assert.equal((await first.panel({ ...query, window: "7" }, "core")).data.summary!.requests, 1);
    assert.equal(dispatchedTypes.filter(type => type === "prepare").length, 2, "闲置 Worker 重建后复用已落盘事实");
    assert.equal((await first.panel({ ...query, timezone: "Europe/London", window: "7" }, "core")).data.summary!.requests, 1);
    assert.equal(dispatchedTypes.filter(type => type === "prepare").length, 3, "重建后的核心通道仍能准备新时区");
    await first.close(); restarted = new OverviewManager(store, prices, () => [], clock);
    assert.deepEqual(await restarted.panel(query, "core"), core);
    assert.equal((restarted as unknown as { nextId: number }).nextId, 0);
    const explicit = await restarted.panel({ ...query, from: core.snapshot.range.from, to: core.snapshot.range.to }, "core");
    assert.deepEqual(explicit.data, core.data);
    assert.equal(explicit.snapshot.query.from, core.snapshot.range.from);
    assert.equal(explicit.snapshot.query.to, core.snapshot.range.to);
    assert.equal((restarted as unknown as { nextId: number }).nextId, 0, "默认日期与同范围显式日期复用持久结果");
    const model = await restarted.panel({ ...query, models: ["synthetic-other"] }, "core");
    assert.deepEqual(model.data.summary, core.data.summary); assert.deepEqual(model.snapshot.query.models, ["synthetic-other"]);
    assert.equal((restarted as unknown as { nextId: number }).nextId, 0);
    await assert.rejects(restarted.panel({ ...query, version: "synthetic-missing" }, "core"), { code: "VERSION_NOT_FOUND" });
    await assert.rejects(restarted.panel({ ...query, priceVersion: "synthetic-missing" }, "core"), { code: "VERSION_NOT_FOUND" });
  } finally { await first.close(); await restarted?.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("过程分析通道被占用时，轻量用量、当前维度和候选通道仍独立完成", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-overview-lanes-")), store = new SessionStore(join(directory, "index.sqlite"));
  const path = "/synthetic/history/lanes.jsonl", revision = store.createRevision(path, "synthetic");
  revision.sink.message({ id: "message-lane", sessionId: "session-lane", ordinal: 0, recordLine: 1, turnId: "turn-lane", kind: "assistant", text: "合成正文", occurredAt: "2026-03-01T12:00:00Z" });
  revision.sink.usage({ id: "request-lane", messageId: "message-lane", model: "model-lane", inputTokens: 100, outputTokens: 20, occurredAt: "2026-03-01T12:00:00Z" });
  revision.flush(); store.finishRevision(revision.revision, { id: "session-lane", client: "codex", clientSessionId: "session-lane", path, sourceId: "source-lane",
    project: "/synthetic/project", title: "合成通道会话", titleOrigin: "recorded", messageCount: 1, turnCount: 1, models: ["model-lane"], gaps: [] });
  const version = store.publish(store.createJob().id, [{ path, revision: revision.revision, fingerprint: "synthetic" }], []);
  const manager = new OverviewManager(store, new PricingService(directory), () => [], () => new Date("2026-03-01T12:00:00Z"));
  const internal = manager as unknown as { dispatch(type: string, ...parameters: unknown[]): Promise<unknown>; workers: Map<string, import("node:worker_threads").Worker> };
  const dispatch = internal.dispatch.bind(manager), calls: { type: string; lane: string; panel?: string }[] = [];
  const workerSamples = new Map<string, { threadId: number; memoryLimit?: number }>();
  let release!: () => void, started!: () => void, analysisBlocked = false, processComplete = false;
  const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
  internal.dispatch = (type, ...parameters) => {
    const lane = parameters[1] as string, panel = (parameters[2] as { panel?: string } | undefined)?.panel;
    calls.push({ type, lane, panel });
    if (lane === "analysis" && panel === "process") { analysisBlocked = true; started(); }
    // 模拟过程 Worker 的同步查询占用整个 analysis 通道，其他通道使用真实 Worker。
    const run = () => {
      const result = dispatch(type, ...parameters);
      const worker = internal.workers.get(lane);
      // 在请求运行时取证；完成后的空闲回收不应让通道独立性测试依赖调度速度。
      if (worker) workerSamples.set(lane, { threadId: worker.threadId, memoryLimit: worker.resourceLimits.maxOldGenerationSizeMb });
      return result;
    };
    return lane === "analysis" && analysisBlocked ? held.then(run) : run();
  };
  const query = { version, window: "365" as const, timezone: "UTC" }, deadline = new AbortController();
  let process: ReturnType<OverviewManager["panel"]> | undefined, light: Promise<unknown> | undefined;
  try {
    await manager.panel(query, "resources");
    process = manager.panel(query, "process").then(result => { processComplete = true; return result; });
    await entered;
    light = Promise.all([manager.panel(query, "usage"), manager.panel(query, "distribution", "project"), manager.panel(query, "facets")]);
    const results = await Promise.race([light, delay(5000, undefined, { signal: deadline.signal }).then(() => { throw new Error("轻量分区仍被过程通道阻塞"); })]) as Awaited<ReturnType<OverviewManager["panel"]>>[];
    assert.equal(processComplete, false, "过程gate尚未释放，轻量分区已成功");
    assert.equal(results[0]!.data.usage!.totals.requests, 1); assert.equal(results[1]!.data.distribution![0]!.key, "/synthetic/project");
    assert.deepEqual(results[2]!.data.facets!.models, ["model-lane"]);
    assert.deepEqual(calls.filter(call => ["usage", "distribution", "facets"].includes(call.panel ?? "")).map(call => call.lane), ["usage", "usage", "usage"]);
    assert.deepEqual(calls.filter(call => call.type === "prepare").map(call => call.lane), ["core"], "事实仍只通过核心通道准备一次");
    assert.equal(calls.find(call => call.panel === "resources")!.lane, "analysis");
    assert.equal(calls.find(call => call.panel === "process")!.lane, "analysis");
    const usageWorker = workerSamples.get("usage")!, analysisWorker = workerSamples.get("analysis")!;
    assert.notEqual(usageWorker.threadId, analysisWorker.threadId); assert.equal(usageWorker.memoryLimit, 512);
    release(); assert.equal((await process).data.process!.tools.length, 0);
  } finally {
    deadline.abort(); release(); await process?.catch(() => undefined); await light?.catch(() => undefined);
    await manager.close(); store.close(); await rm(directory, { recursive: true, force: true });
  }
});
