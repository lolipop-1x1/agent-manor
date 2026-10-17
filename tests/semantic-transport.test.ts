import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SemanticSettings } from "../src/semantic-contracts.js";
import { defaultSemanticConfig, encodingFingerprint, normalizeEmbeddingUrl, SemanticConfigStore, validateSemanticConfig } from "../src/semantic/config.js";
import { embeddings } from "../src/semantic/embedding.js";
import { semanticErrorDescriptor } from "../src/semantic/messages.js";
import { isMessageDescriptorKnown, translateMessage } from "../src/i18n/index.js";
import { EmbeddingScheduler, estimateEmbeddingTokens } from "../src/semantic/scheduler.js";

async function home(): Promise<string> { return mkdtemp(join(tmpdir(), "manor-semantic-transport-")); }
async function server(handler: (request: IncomingMessage, response: ServerResponse, body: { input: string[]; model: string; dimensions?: number }) => void | Promise<void>): Promise<{ url: string; close: () => Promise<void> }> {
  const service = createServer(async (request, response) => {
    try { const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); await handler(request, response, JSON.parse(Buffer.concat(chunks).toString())); }
    catch { response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
  const address = service.address(); assert(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}/v1`, close: async () => { service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())); } };
}
function answer(response: ServerResponse, texts: string[], tokens?: number): void {
  response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: texts.map((_, index) => ({ index, embedding: [1, index + 1, 0.25] })), ...(tokens === undefined ? {} : { usage: { prompt_tokens: tokens } }) }));
}
function settings(url: string): SemanticSettings { const config = defaultSemanticConfig(); config.connection.url = url; config.connection.model = "example-embedding"; return { config, hasKey: false, fingerprint: encodingFingerprint(config) }; }
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const code = (expected: string) => (error: unknown): boolean => error instanceof Error && "code" in error && error.code === expected;

test("语义设置默认关闭，凭据独立保存且可读取、替换和清除", async t => {
  const directory = await home(); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SemanticConfigStore(directory), initial = await store.read();
  assert.equal(initial.config.enabled, false); assert.equal(initial.config.scope.timeRange, "unset"); assert.equal(initial.hasKey, false);
  const saved = await store.save({ config: initial.config, apiKey: "example-test-key" }); assert(saved.hasKey);
  assert.equal(await store.key(), "example-test-key");
  assert(!(await readFile(join(directory, "semantic/config.json"), "utf8")).includes("example-test-key"));
  assert(!JSON.stringify(await store.read()).includes("example-test-key"));
  if (process.platform !== "win32") { assert.equal((await stat(join(directory, "semantic"))).mode & 0o777, 0o700); for (const name of ["config.json", "credentials.json"]) assert.equal((await stat(join(directory, "semantic", name))).mode & 0o777, 0o600); }
  await store.save({ config: initial.config }); assert.equal(await store.key(), "example-test-key");
  await store.save({ config: initial.config, apiKey: "example-replacement" }); assert.equal(await store.key(), "example-replacement");
  await store.save({ config: initial.config, apiKey: null }); assert.equal(await store.key(), undefined); assert.equal((await store.read()).hasKey, false);
});

test("保存设置拒绝非法限额、筛选与凭据，内容复用指纹只包含编码条件", async () => {
  const original = defaultSemanticConfig(), initial = encodingFingerprint(original);
  const operational = structuredClone(original); operational.enabled = false; operational.scope.projects = ["/example/project"]; operational.strategy.timeoutMs = 1234; operational.strategy.pricePerMillion = 2; operational.strategy.dailyBudget = 3;
  assert.equal(encodingFingerprint(operational), initial);
  for (const mutation of [(value: typeof original) => { value.connection.model = "different"; }, (value: typeof original) => { value.connection.documentPrefix = "document: "; }, (value: typeof original) => { value.connection.queryPrefix = "query: "; }, (value: typeof original) => { value.connection.dimensions = 3; }, (value: typeof original) => { value.strategy.chunkChars = 1400; }]) { const updated = structuredClone(original); mutation(updated); assert.notEqual(encodingFingerprint(updated), initial); }
  for (const mutation of [(value: typeof original) => { value.strategy.concurrency = 0; }, (value: typeof original) => { value.strategy.overlapChars = value.strategy.chunkChars; }, (value: typeof original) => { value.strategy.dailyBudget = 2; }, (value: typeof original) => { value.scope.minTurns = 4; value.scope.maxTurns = 1; }, (value: typeof original) => { value.connection.url = "file:///example"; }]) { const invalid = structuredClone(original); mutation(invalid); assert.throws(() => validateSemanticConfig(invalid), code("semantic_config_invalid")); }
  assert.equal(normalizeEmbeddingUrl("https://example.invalid"), "https://example.invalid/v1/embeddings");
  assert.equal(normalizeEmbeddingUrl("https://example.invalid/v1/"), "https://example.invalid/v1/embeddings");
  assert.equal(normalizeEmbeddingUrl("https://example.invalid/custom/embeddings/"), "https://example.invalid/custom/embeddings");
});

test("兼容接口规范地址、发送批次、按 index 归位并读取整批用量", async t => {
  const endpoint = await server((request, response, body) => {
    assert.equal(request.url, "/v1/embeddings"); assert.equal(request.headers.authorization, "Bearer example-key"); assert.deepEqual(body, { model: "example-embedding", input: ["甲", "乙"], dimensions: 3 });
    response.end(JSON.stringify({ data: [{ index: 1, embedding: [0, 1, 0] }, { index: 0, embedding: [1, 0, 0] }], usage: { prompt_tokens: 8 } }));
  }); t.after(endpoint.close);
  const connection = settings(endpoint.url).config.connection; connection.dimensions = 3;
  const result = await embeddings(connection, "example-key", ["甲", "乙"]);
  assert.deepEqual(result, { vectors: [[1, 0, 0], [0, 1, 0]], dimensions: 3, tokens: 8 });
});

test("拒绝缺失、重复 index、零向量、超出 float32 范围及维度不匹配的响应", async t => {
  let payload: unknown;
  const endpoint = await server((_, response) => { response.end(JSON.stringify(payload)); }); t.after(endpoint.close);
  const connection = settings(endpoint.url).config.connection;
  for (const data of [[], [{ index: 1, embedding: [1, 0] }], [{ index: 0, embedding: [0, 0] }], [{ index: 0, embedding: [1e200, 1] }], [{ embedding: [1, 0] }]]) { payload = { data }; await assert.rejects(embeddings(connection, undefined, ["one"]), code("semantic_embedding_invalid")); }
  payload = { data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }] }; await assert.rejects(embeddings(connection, undefined, ["one", "two"]), code("semantic_embedding_invalid"));
  payload = { data: [{ index: 0, embedding: [1, 0] }, { index: 1, embedding: [0, 1, 1] }] }; await assert.rejects(embeddings(connection, undefined, ["one", "two"]), code("semantic_embedding_invalid"));
  payload = { data: [{ index: 0, embedding: [1, 0] }] }; await assert.rejects(embeddings({ ...connection, dimensions: 3 }, undefined, ["one"]), code("semantic_embedding_invalid"));
});

test("服务错误不会包含 Key 或服务响应正文，取消和超时有稳定错误", async t => {
  const endpoint = await server((_, response) => { response.writeHead(401); response.end("example-secret-request-body"); }); t.after(endpoint.close);
  await assert.rejects(embeddings(settings(endpoint.url).config.connection, "example-secret-key", ["example-private-history"]), error => { assert(error instanceof Error); assert(!error.message.includes("secret")); assert(!error.message.includes("history")); return code("semantic_auth")(error); });
  const hung = await server(() => undefined); t.after(hung.close);
  await assert.rejects(embeddings(settings(hung.url).config.connection, undefined, ["input"], { timeoutMs: 10 }), code("semantic_timeout"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(embeddings(settings(hung.url).config.connection, undefined, ["input"], { signal: controller.signal }), code("semantic_aborted"));
});

test("查询优先于待执行构建，已发请求正常收尾，用量按用途和实际值记录", async t => {
  const directory = await home(), first = deferred(), release = deferred(), order: string[] = [];
  t.after(() => rm(directory, { recursive: true, force: true }));
  const endpoint = await server(async (_, response, body) => { order.push(body.input[0]!); if (order.length === 1) { first.resolve(); await release.promise; } answer(response, body.input, 5); }); t.after(endpoint.close);
  const config = settings(endpoint.url), scheduler = new EmbeddingScheduler(directory, async () => config, async () => undefined); t.after(() => scheduler.close());
  const one = scheduler.execute(["first"], "build"); await first.promise;
  const two = scheduler.execute(["second"], "build"), query = scheduler.execute(["query"], "query");
  await new Promise(resolve => setImmediate(resolve)); release.resolve();
  await Promise.all([one, two, query]); assert.deepEqual(order, ["first", "query", "second"]);
  const usage = await scheduler.usage(); assert.equal(usage.requests, 3); assert.equal(usage.actualRequests, 3); assert.equal(usage.actualTokens, 15); assert.equal(usage.estimatedTokens, 0); assert.equal(usage.estimatedCost, null); assert.equal(usage.byPurpose.build.requests, 2); assert.equal(usage.byPurpose.query.tokens, 5);
});

test("并发请求原子预留预算，失败保守计量且重启不重置当日消费", async t => {
  const directory = await home(), received = deferred(), release = deferred(); t.after(() => rm(directory, { recursive: true, force: true }));
  let requests = 0;
  const endpoint = await server(async (_, response, body) => { requests++; received.resolve(); await release.promise; response.writeHead(500); response.end(); }); t.after(endpoint.close);
  const config = settings(endpoint.url), estimate = estimateEmbeddingTokens(["input"]);
  Object.assign(config.config.strategy, { concurrency: 2, retries: 0, pricePerMillion: 1_000_000, dailyBudget: estimate });
  const scheduler = new EmbeddingScheduler(directory, async () => config, async () => undefined); t.after(() => scheduler.close());
  const first = scheduler.execute(["input"], "build"); const firstRejected = assert.rejects(first, code("semantic_service")); await received.promise;
  await assert.rejects(scheduler.execute(["input"], "query"), code("semantic_budget_exceeded")); release.resolve(); await firstRejected;
  assert.equal(requests, 1); assert.equal((await scheduler.usage()).estimatedTokens, estimate); assert.equal((await scheduler.usage()).estimatedCost, estimate); await scheduler.close();
  const restarted = new EmbeddingScheduler(directory, async () => config, async () => undefined); t.after(() => restarted.close());
  assert.equal((await restarted.usage()).requests, 1); await assert.rejects(restarted.execute(["input"], "query"), code("semantic_budget_exceeded"));
});

test("临时连接测试共用用量和预算，重试逐次计量，鉴权失败不重试", async t => {
  const directory = await home(); t.after(() => rm(directory, { recursive: true, force: true }));
  let count = 0;
  const endpoint = await server((request, response, body) => { count++; assert.equal(request.headers.authorization, "Bearer example-draft-key"); if (count === 1) { response.writeHead(429, { "retry-after": "0" }); response.end(); } else answer(response, body.input, 3); }); t.after(endpoint.close);
  const blank = settings(""), draft = settings(endpoint.url); draft.config.strategy.retries = 1; draft.config.strategy.pricePerMillion = 2;
  const scheduler = new EmbeddingScheduler(directory, async () => blank, async () => { throw new Error("不应读取持久凭据"); }); t.after(() => scheduler.close());
  await scheduler.execute(["test"], "test", undefined, { settings: draft, apiKey: "example-draft-key" });
  const usage = await scheduler.usage(); assert.equal(count, 2); assert.equal(usage.requests, 2); assert.equal(usage.byPurpose.test.requests, 2); assert.equal(usage.actualRequests, 1); assert.equal(usage.actualTokens, 3); assert.equal(usage.estimatedTokens, estimateEmbeddingTokens(["test"]));
  let authCalls = 0; const auth = await server((_, response) => { authCalls++; response.writeHead(403); response.end(); }); t.after(auth.close);
  draft.config.connection.url = auth.url; await assert.rejects(scheduler.execute(["test"], "test", undefined, { settings: draft }), code("semantic_auth")); assert.equal(authCalls, 1);
});

test("RPM 等待中的查询可以取消，超出 TPM 的单次输入不发送，关闭会拒绝排队请求", async t => {
  const directory = await home(); t.after(() => rm(directory, { recursive: true, force: true }));
  let count = 0; const endpoint = await server((_, response, body) => { count++; answer(response, body.input); }); t.after(endpoint.close);
  const config = settings(endpoint.url); config.config.strategy.requestsPerMinute = 1;
  const scheduler = new EmbeddingScheduler(directory, async () => config, async () => undefined); t.after(() => scheduler.close());
  await scheduler.execute(["one"], "query");
  const controller = new AbortController(), waiting = scheduler.execute(["two"], "query", controller.signal), cancelled = assert.rejects(waiting, code("semantic_aborted"));
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await cancelled; assert.equal(count, 1);
  config.config.strategy.tokensPerMinute = 1;
  await assert.rejects(scheduler.execute(["long"], "build"), code("semantic_rate_limit_input"));
  config.config.strategy.tokensPerMinute = 0;
  const queued = scheduler.execute(["three"], "query"), rejected = assert.rejects(queued, code("semantic_closed")); await new Promise(resolve => setImmediate(resolve)); await scheduler.close(); await rejected;
  await assert.rejects(scheduler.execute(["later"], "query"), code("semantic_closed")); assert.equal(count, 1);
});

test("先测试后设置单价和预算时，只为预算回估未计价用量，展示费用仍未知", async t => {
  const directory = await home(); t.after(() => rm(directory, { recursive: true, force: true }));
  let count = 0;
  const endpoint = await server((_, response, body) => { count++; answer(response, body.input, 5); }); t.after(endpoint.close);
  const config = settings(endpoint.url), scheduler = new EmbeddingScheduler(directory, async () => config, async () => undefined); t.after(() => scheduler.close());
  await scheduler.execute(["test"], "test"); assert.equal((await scheduler.usage()).estimatedCost, null);
  config.config.strategy.pricePerMillion = 1_000_000; config.config.strategy.dailyBudget = 5 + estimateEmbeddingTokens(["query"]);
  await scheduler.execute(["query"], "query");
  const usage = await scheduler.usage(); assert.equal(usage.estimatedCost, null); assert.equal(usage.actualTokens, 10); assert.equal(usage.byPurpose.query.cost, 5);
  await assert.rejects(scheduler.execute(["a significantly longer query"], "query"), code("semantic_budget_exceeded")); assert.equal(count, 2);
});

test("并发调度不绕过 RPM 预留，不在请求前已经取消时计费", async t => {
  const directory = await home(), received = deferred(), release = deferred(); t.after(() => rm(directory, { recursive: true, force: true }));
  let count = 0; const endpoint = await server(async (_, response, body) => { count++; received.resolve(); await release.promise; answer(response, body.input); }); t.after(endpoint.close);
  const config = settings(endpoint.url); config.config.strategy.concurrency = 3; config.config.strategy.requestsPerMinute = 1;
  const scheduler = new EmbeddingScheduler(directory, async () => config, async () => undefined); t.after(() => scheduler.close());
  const controller = new AbortController();
  const first = scheduler.execute(["one"], "build"); await received.promise;
  const second = scheduler.execute(["two"], "query", controller.signal), cancelled = assert.rejects(second, code("semantic_aborted"));
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await cancelled; release.resolve(); await first;
  assert.equal(count, 1); assert.equal((await scheduler.usage()).requests, 1);
});

test("暂停构建仅取消排队的正文，已发响应保存，主动查询继续", async t => {
  const directory = await home(), received = deferred(), release = deferred(); t.after(() => rm(directory, { recursive: true, force: true }));
  const order: string[] = [];
  const endpoint = await server(async (_, response, body) => { order.push(body.input[0]!); if (order.length === 1) { received.resolve(); await release.promise; } answer(response, body.input, 4); }); t.after(endpoint.close);
  const config = settings(endpoint.url), scheduler = new EmbeddingScheduler(directory, async () => config, async () => undefined); t.after(() => scheduler.close());
  const active = scheduler.execute(["active"], "build"); await received.promise;
  const queued = scheduler.execute(["queued"], "build"), rejected = assert.rejects(queued, code("semantic_aborted"));
  const query = scheduler.execute(["query"], "query"); await new Promise(resolve => setImmediate(resolve));
  scheduler.cancelQueued("build"); await rejected; release.resolve(); await Promise.all([active, query]);
  assert.deepEqual(order, ["active", "query"]); assert.equal((await scheduler.usage()).requests, 2);
});

test("取消预算预留前的正文不发请求，取消已发失败请求后不再安排重试", async t => {
  const directory = await home(), keyRequested = deferred(), keyReleased = deferred(); t.after(() => rm(directory, { recursive: true, force: true }));
  let requests = 0; const received = deferred(), release = deferred();
  const endpoint = await server(async (_, response) => { requests++; received.resolve(); await release.promise; response.writeHead(503); response.end(); }); t.after(endpoint.close);
  const config = settings(endpoint.url), scheduler = new EmbeddingScheduler(directory, async () => config, async () => { keyRequested.resolve(); await keyReleased.promise; return undefined; }); t.after(() => scheduler.close());
  const before = scheduler.execute(["before"], "build"), beforeRejected = assert.rejects(before, code("semantic_aborted")); await keyRequested.promise;
  scheduler.cancelQueued("build"); keyReleased.resolve(); await beforeRejected; assert.equal(requests, 0); assert.equal((await scheduler.usage()).requests, 0);
  const issued = scheduler.execute(["issued"], "build"), issuedRejected = assert.rejects(issued, code("semantic_aborted")); await received.promise;
  scheduler.cancelQueued("build"); release.resolve(); await issuedRejected; assert.equal(requests, 1); assert.equal((await scheduler.usage()).requests, 1);
});

test("等待退避和 RPM 的队列项可按用途或整体取消", async t => {
  const directory = await home(), failed = deferred(); t.after(() => rm(directory, { recursive: true, force: true }));
  let requests = 0;
  const endpoint = await server((_, response) => { requests++; response.writeHead(429, { "retry-after": "60" }); response.end(); failed.resolve(); }); t.after(endpoint.close);
  const config = settings(endpoint.url), scheduler = new EmbeddingScheduler(directory, async () => config, async () => undefined); t.after(() => scheduler.close());
  const build = scheduler.execute(["build"], "build"), buildRejected = assert.rejects(build, code("semantic_aborted")); await failed.promise;
  await new Promise(resolve => setTimeout(resolve, 10)); scheduler.cancelQueued("build"); await buildRejected;
  config.config.strategy.requestsPerMinute = 1;
  const query = scheduler.execute(["query"], "query"), queryRejected = assert.rejects(query, code("semantic_aborted")); await new Promise(resolve => setImmediate(resolve)); scheduler.cancelQueued(); await queryRejected;
  assert.equal(requests, 1); assert.equal((await scheduler.usage()).requests, 1);
});

test("排队后降低每日预算，尚未发出的请求采用新预算，连接身份保持捕获值", async t => {
  const directory = await home(), received = deferred(), release = deferred(); t.after(() => rm(directory, { recursive: true, force: true }));
  let requests = 0;
  const endpoint = await server(async (_, response, body) => { requests++; if (requests === 1) { received.resolve(); await release.promise; } answer(response, body.input, 5); }); t.after(endpoint.close);
  const config = settings(endpoint.url); config.config.strategy.pricePerMillion = 1_000_000; config.config.strategy.dailyBudget = 100;
  const scheduler = new EmbeddingScheduler(directory, async () => config, async () => undefined); t.after(() => scheduler.close());
  const active = scheduler.execute(["active"], "build"); await received.promise;
  const queued = scheduler.execute(["queued"], "query"), rejected = assert.rejects(queued, code("semantic_budget_exceeded"));
  await new Promise(resolve => setImmediate(resolve)); config.config.strategy.dailyBudget = 5; release.resolve();
  await active; await rejected; assert.equal(requests, 1); assert.equal((await scheduler.usage()).requests, 1);
});

test("凭据读取期间修改调用策略也生效，override 不覆盖最新预算", async t => {
  const directory = await home(), keyRequested = deferred(), keyReleased = deferred(); t.after(() => rm(directory, { recursive: true, force: true }));
  let requests = 0; const endpoint = await server((_, response, body) => { requests++; answer(response, body.input); }); t.after(endpoint.close);
  const current = settings(endpoint.url); current.config.strategy.pricePerMillion = 1_000_000; current.config.strategy.dailyBudget = 100;
  const scheduler = new EmbeddingScheduler(directory, async () => current, async () => { keyRequested.resolve(); await keyReleased.promise; return undefined; }); t.after(() => scheduler.close());
  const queued = scheduler.execute(["pending"], "query"), rejected = assert.rejects(queued, code("semantic_budget_exceeded")); await keyRequested.promise;
  current.config.strategy.dailyBudget = 0; keyReleased.resolve(); await rejected;
  const draft = settings(endpoint.url); draft.config.strategy.dailyBudget = undefined;
  await assert.rejects(scheduler.execute(["test"], "test", undefined, { settings: draft }), code("semantic_budget_exceeded")); assert.equal(requests, 0); assert.equal((await scheduler.usage()).requests, 0);
});

test("更新调度策略不改变已排队请求的模型连接身份", async t => {
  const directory = await home(), received = deferred(), release = deferred(); t.after(() => rm(directory, { recursive: true, force: true }));
  const originalModels: string[] = []; let otherCalls = 0;
  const original = await server(async (_, response, body) => { originalModels.push(body.model); if (originalModels.length === 1) { received.resolve(); await release.promise; } answer(response, body.input); }); t.after(original.close);
  const other = await server((_, response, body) => { otherCalls++; answer(response, body.input); }); t.after(other.close);
  const config = settings(original.url), scheduler = new EmbeddingScheduler(directory, async () => config, async () => undefined); t.after(() => scheduler.close());
  const active = scheduler.execute(["active"], "build"); await received.promise;
  const queued = scheduler.execute(["queued"], "query"); await new Promise(resolve => setImmediate(resolve));
  config.config.connection.url = other.url; config.config.connection.model = "other-model"; config.config.strategy.timeoutMs = 10_000;
  release.resolve(); await Promise.all([active, queued]); assert.equal(otherCalls, 0); assert.deepEqual(originalModels, ["example-embedding", "example-embedding"]);
});

test("可靠的 HTTP 400 上下文错误触发缩块，其他 400 不猜测正文且不泄露", async t => {
  let errorCode = "context_length_exceeded";
  const endpoint = await server((_, response) => { response.writeHead(400); response.end(JSON.stringify({ error: { code: errorCode, message: "example-private-history" } })); }); t.after(endpoint.close);
  const connection = settings(endpoint.url).config.connection;
  await assert.rejects(embeddings(connection, undefined, ["input"]), error => { assert(error instanceof Error); assert(!error.message.includes("private")); return code("semantic_input_too_long")(error); });
  errorCode = "invalid_model"; await assert.rejects(embeddings(connection, undefined, ["input"]), code("semantic_request_invalid"));
});


test("已知产品错误在两种语言中有稳定描述，原始诊断独立保留", () => {
  for (const code of ["semantic_budget_exceeded", "semantic_persistence_failed", "semantic_auth", "semantic_network", "semantic_config_invalid", "semantic_embedding_invalid", "PREVIEW_STALE", "INDEX_CHANGED"]) {
    const descriptor = semanticErrorDescriptor(code); assert(descriptor); assert.equal(isMessageDescriptorKnown(descriptor), true);
    assert.notEqual(translateMessage("en", descriptor), translateMessage("zh-CN", descriptor));
  }
  assert.equal(semanticErrorDescriptor("old-unknown-error"), undefined);
});
