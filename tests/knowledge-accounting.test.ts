import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KnowledgeConfig, KnowledgeJob, KnowledgeRequestEvent, KnowledgeSourceReader } from "../src/knowledge-contracts.js";
import { defaultKnowledgeConfig, KnowledgeModelError, validateKnowledgeConfig } from "../src/knowledge/config.js";
import { emptyKnowledgeUsage, KnowledgeGenerationScheduler } from "../src/knowledge/generation.js";
import { KnowledgeManager } from "../src/knowledge/manager.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

const noValue = { disposition: "no_value", candidates: [], carry: [], needsMessageIds: [], limitations: [] };
const messages = [{ role: "user" as const, content: "Small synthetic request." }];
function reply(response: ServerResponse, usage?: unknown, content = JSON.stringify(noValue)): void { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage })); }
async function fixture(run: (context: { config: KnowledgeConfig; store: KnowledgeStore; directory: string; scheduler: KnowledgeGenerationScheduler; setHandler: (handler: (response: ServerResponse, request: number) => void) => void; requests: () => number }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "manor-knowledge-accounting-")), store = new KnowledgeStore(join(directory, "knowledge.sqlite")), scheduler = new KnowledgeGenerationScheduler(store);
  let handler = (response: ServerResponse, _request: number) => reply(response, { prompt_tokens: 100, completion_tokens: 10 }), requests = 0;
  const server = createServer(async (request, response) => { for await (const _chunk of request) { /* 消费合成请求。 */ } handler(response, ++requests); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = defaultKnowledgeConfig("en"); Object.assign(config.generation, { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, model: "synthetic-model", retries: 0, outputTokens: 256, inputPricePerMillion: 2, cachedInputPricePerMillion: 0.2, outputPricePerMillion: 4 });
  try { await run({ config, store, directory, scheduler, setHandler: value => { handler = value; }, requests: () => requests }); }
  finally { await scheduler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(directory, { recursive: true, force: true }); }
}
const source: KnowledgeSourceReader = {
  async plan() { return [{ sessionId: "session-synthetic", title: "Synthetic task title", client: "codex", version: "v1", branch: "current", messageIds: ["message-synthetic"], hashes: ["synthetic-hash"], turnCount: 1, inputTokens: 10, contextTokens: 0, limitations: [] }]; },
  async read(target) { return { session: { id: target.sessionId, client: "codex", clientSessionId: "synthetic-native", title: target.title, titleOrigin: "recorded", messageCount: 1, turnCount: 1, models: [], gaps: [] }, version: target.version, branch: target.branch, messages: [{ id: "message-synthetic", sessionId: target.sessionId, ordinal: 1, recordLine: 1, turnId: "turn-1", turnPosition: 1, kind: "user", text: "Remember a stable configuration preference.", hash: "synthetic-hash", target: true }], limitations: [] }; },
  async verify(value) { return value; },
};
async function finished(manager: KnowledgeManager, id: string): Promise<KnowledgeJob> { for (let attempt = 0; attempt < 300; attempt++) { const job = await manager.job(id); if (!["queued", "running"].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("synthetic job timeout"); }

test("DeepSeek和OpenAI缓存明细按用途计量，无明细保持未知", async () => fixture(async ({ scheduler, config, setHandler }) => {
  const meter = emptyKnowledgeUsage(), events: KnowledgeRequestEvent[] = [];
  setHandler(response => reply(response, { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30 }));
  await scheduler.execute(config, messages, undefined, undefined, meter, "reread", event => { events.push(event); });
  assert.equal(meter.cachedInputTokens, 70); assert.equal(meter.uncachedInputTokens, 30); assert.equal(meter.cacheDetailedRequests, 1); assert.equal(meter.byPurpose?.reread.actualRequests, 1);
  assert.ok(Math.abs(meter.estimatedCost! - 0.000114) < 1e-10); assert.deepEqual(events.map(event => event.kind), ["before", "reserved", "settled"]);
  setHandler(response => reply(response, { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } }));
  await scheduler.execute(config, messages, undefined, undefined, meter, "merge");
  assert.equal(meter.cachedInputTokens, 90); assert.equal(meter.uncachedInputTokens, 110); assert.equal(meter.cacheDetailedRequests, 2);
  const unknown = emptyKnowledgeUsage(); setHandler(response => reply(response, { prompt_tokens: 100, completion_tokens: 10 })); await scheduler.execute(config, messages, undefined, undefined, unknown);
  assert.equal(unknown.cachedInputTokens, undefined); assert.equal(unknown.cacheDetailedRequests, undefined); assert.equal(unknown.actualRequests, 1);
}));

test("失败重试分别保留预留、事件和实际用量，错误事件不含服务商响应", async () => fixture(async ({ scheduler, config, setHandler, requests }) => {
  config.generation.retries = 1; const meter = emptyKnowledgeUsage(), events: KnowledgeRequestEvent[] = [];
  setHandler((response, index) => { if (index === 1) { response.statusCode = 503; response.end("synthetic-private-provider-body"); } else reply(response, { prompt_tokens: 100, completion_tokens: 10 }); });
  await scheduler.execute(config, messages, "synthetic-secret", undefined, meter, "extract", event => { events.push(event); });
  assert.equal(requests(), 2); assert.equal(meter.requests, 2); assert.equal(meter.actualRequests, 1); assert.ok(meter.estimatedInputTokens! > 0); assert.equal(meter.actualInputTokens, 100);
  assert.deepEqual(events.map(event => event.kind), ["before", "reserved", "failed", "before", "reserved", "settled"]);
  assert.equal(new Set(events.filter(event => event.kind === "reserved").map(event => event.requestId)).size, 2); assert.equal(events.at(-1)?.attempt, 2);
  assert.equal(JSON.stringify(events).includes("synthetic-private-provider-body"), false); assert.equal(JSON.stringify(events).includes("synthetic-secret"), false);
}));

test("模型输出无效仍保留已报告用量与缓存计费", async () => fixture(async ({ scheduler, config, setHandler }) => {
  const meter = emptyKnowledgeUsage(), events: KnowledgeRequestEvent[] = [];
  setHandler(response => reply(response, { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } }, "not valid JSON"));
  await assert.rejects(scheduler.execute(config, messages, undefined, undefined, meter, "extract", event => { events.push(event); }), (cause: unknown) => cause instanceof KnowledgeModelError && cause.code === "response_invalid");
  assert.equal(meter.actualRequests, 1); assert.equal(meter.cachedInputTokens, 0); assert.equal(meter.uncachedInputTokens, 100); assert.equal(meter.estimatedInputTokens, 0); assert.deepEqual(events.map(event => event.kind), ["before", "reserved", "settled", "failed"]);
}));

test("任务快照、独立用量和事件重开后保留，旧任务不伪造记录", async () => fixture(async ({ config, store, directory }) => {
  let manager = new KnowledgeManager(directory, store, source); await manager.saveSettings({ config });
  try {
    const preview = await manager.preview({ ...config.automatic.scope, timeRange: "all" }), job = await finished(manager, (await manager.start(preview.id)).id);
    assert.equal(job.status, "complete"); assert.equal(job.title, "Synthetic task title"); assert.equal(job.model?.model, "synthetic-model"); assert.equal(job.usage?.actualRequests, 1); assert.equal(job.usage?.byPurpose?.extract.actualRequests, 1);
    assert.ok(job.events?.some(event => event.kind === "request" && event.requestState === "settled")); assert.equal(job.events?.at(-1)?.kind, "completed");
    const summary = (await manager.status()).jobs.find(value => value.id === job.id)!; assert.equal(summary.events, undefined); assert.equal(summary.usage?.actualRequests, 1); assert.ok((await manager.job(job.id)).events!.length > 0);
    const testConfig = structuredClone(config); testConfig.generation.model = "new-synthetic-model"; await manager.saveSettings({ config: testConfig }); await manager.close(); manager = new KnowledgeManager(directory, store, source);
    const reopened = await manager.job(job.id); assert.deepEqual(reopened.usage, job.usage); assert.deepEqual(reopened.events, job.events); assert.equal(reopened.model?.model, "synthetic-model");
    const record = store.getState<{ job: KnowledgeJob; preview: { targets: unknown[] } }>(`extraction.job:${job.id}`)!; delete record.job.usage; delete record.job.events; delete record.job.model; delete record.job.title; store.setState(`extraction.job:${job.id}`, record);
    const legacy = await manager.job(job.id); assert.equal(legacy.usage, undefined); assert.equal(legacy.events, undefined); assert.equal(legacy.model, undefined); assert.equal(legacy.title, "Synthetic task title");
    assert.equal((await manager.status()).jobs.find(value => value.id === job.id)?.title, "Synthetic task title");
    assert.equal(store.getState<{ job: KnowledgeJob }>(`extraction.job:${job.id}`)!.job.title, undefined);
    record.preview.targets.push(structuredClone(record.preview.targets[0])); record.job.title = "Synthetic task title"; record.job.totalSessions = 2; store.setState(`extraction.job:${job.id}`, record);
    assert.equal((await manager.job(job.id)).title, undefined); assert.equal((await manager.status()).jobs.find(value => value.id === job.id)?.title, undefined);
    record.preview.targets.pop(); record.job.totalSessions = 1;
    record.job.status = "paused"; record.job.events = Array.from({ length: 400 }, (_value, index) => ({ id: `synthetic-event-${index}`, at: job.createdAt, kind: "progress" })); store.setState(`extraction.job:${job.id}`, record);
    await manager.action(job.id, "resume"); const bounded = await finished(manager, job.id); assert.equal(bounded.events?.length, 400); assert.ok(bounded.droppedEvents! > 0); assert.equal(bounded.events?.at(-1)?.kind, "completed");
  } finally { await manager.close(); }
}));

test("任务输入预算在发送前生效，未定价费用预算不能通过配置", async () => fixture(async ({ config, store, directory, requests }) => {
  const unpriced = structuredClone(config); delete unpriced.generation.inputPricePerMillion; unpriced.generation.taskBudget = 1;
  assert.throws(() => validateKnowledgeConfig(unpriced), (cause: unknown) => cause instanceof KnowledgeModelError && cause.code === "config_invalid");
  config.generation.taskInputTokenBudget = 1; const manager = new KnowledgeManager(directory, store, source); await manager.saveSettings({ config });
  try { const job = await finished(manager, (await manager.start((await manager.preview({ ...config.automatic.scope, timeRange: "all" })).id)).id); assert.equal(job.status, "budget_stopped"); assert.equal(job.errorDescriptor?.key, "knowledge.errors.task_token_budget_exceeded"); assert.equal(requests(), 0); assert.equal(job.usage?.requests, 0); assert.ok(job.events?.some(event => event.kind === "error")); }
  finally { await manager.close(); }
}));

test("单任务重试预算保留失败请求，重开后重试仍不能绕过", async () => fixture(async ({ config, store, directory, setHandler, requests }) => {
  let manager = new KnowledgeManager(directory, store, source); await manager.saveSettings({ config });
  try {
    const baseline = await finished(manager, (await manager.start((await manager.preview({ ...config.automatic.scope, timeRange: "all" })).id)).id);
    const upper = baseline.events!.find(event => event.requestState === "reserved")!.measurement!.inputTokenUpperBound!;
    config.generation.retries = 1; config.generation.taskInputTokenBudget = Math.floor(upper * 1.5); await manager.saveSettings({ config });
    setHandler(response => { response.statusCode = 503; response.end("temporary failure"); });
    const job = await finished(manager, (await manager.start((await manager.preview({ ...config.automatic.scope, timeRange: "all", force: true })).id)).id);
    assert.equal(job.status, "budget_stopped"); assert.equal(job.usage?.requests, 1); assert.equal(requests(), 2); assert.ok(job.usage!.estimatedInputTokens! > 0); assert.equal(job.usage?.actualRequests, 0);
    assert.equal(job.events?.filter(event => event.requestState === "failed").length, 1);
    await manager.close(); manager = new KnowledgeManager(directory, store, source); await manager.action(job.id, "retry");
    assert.equal((await finished(manager, job.id)).status, "budget_stopped"); assert.equal(requests(), 2);
  } finally { await manager.close(); }
}));
