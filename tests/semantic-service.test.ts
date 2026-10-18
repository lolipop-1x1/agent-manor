import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AnalysisStore } from "../src/index/store.js";
import { SessionStore } from "../src/sessions/store.js";
import { startService } from "../src/server.js";
import { apiRequest, delay, RequestError } from "../src/service/runtime.js";
import type { SemanticPreview, SemanticSettings, SemanticStatus, SemanticSearchResult } from "../src/semantic-contracts.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";
import { SemanticConfigStore } from "../src/semantic/config.js";
import { managementDigest } from "../src/service/management.js";

async function fixture(run: (context: { service: Awaited<ReturnType<typeof startService>>; calls: string[][]; home: string }) => Promise<void>, options: { text?: string; maxInputChars?: number; modelDelayMs?: number; model?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "manor-semantic-http-"));
  const index = new AnalysisStore(join(home, "index.sqlite")); index.close();
  const sessions = new SessionStore(join(home, "index.sqlite"));
  const revisions = ["first", "copy"].map(id => {
    const path = `/workspace/history/${id}.jsonl`, revision = sessions.createRevision(path, id);
    revision.sink.message({ id: `${id}:user`, sessionId: id, ordinal: 0, recordLine: 1, turnId: `${id}:turn:1`, kind: "user", text: options.text ?? "怎样解决连接超时？" });
    revision.sink.message({ id: `${id}:assistant`, sessionId: id, ordinal: 1, recordLine: 2, turnId: `${id}:turn:1`, kind: "assistant", text: "设置超时并限制重试次数。" });
    revision.flush();
    sessions.finishRevision(revision.revision, { id, client: "codex", clientSessionId: id, title: id, titleOrigin: "recorded", path, sourceId: id,
      messageCount: 2, turnCount: 1, models: ["example"], gaps: [], updatedAt: "2026-01-01T00:00:00Z" });
    return { path, revision: revision.revision, fingerprint: id };
  });
  sessions.publish(sessions.createJob().id, revisions, []); sessions.close();
  const calls: string[][] = [];
  const embedding = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: string[] };
    calls.push(body.input);
    await delay(options.modelDelayMs ?? 15);
    if (options.maxInputChars && body.input.some(text => Array.from(text).length > options.maxInputChars!)) {
      response.writeHead(400, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: { code: "context_length_exceeded", message: "example-private-input" } })); return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: body.input.map((_, i) => ({ index: i, embedding: [1, 0.5, 0.25] })), usage: { prompt_tokens: 12 } }));
  });
  await new Promise<void>(resolve => embedding.listen(0, "127.0.0.1", resolve));
  const address = embedding.address(); assert(address && typeof address !== "string");
  const service = await startService({ home, startupRefresh: false, roots: isolatedHistoryRoots({}), staticRoot: join(home, "absent"), resourceInventory: { userHome: join(home, "isolated"), environment: {} } });
  try {
    const settings = await apiRequest<SemanticSettings>(service.instance, "/semantic/settings");
    Object.assign(settings.config.connection, { url: `http://127.0.0.1:${address.port}/v1`, model: options.model ?? "example" });
    const tested = await apiRequest<{ dimensions: number }>(service.instance, "/semantic/test", "POST", { connection: settings.config.connection });
    settings.config.connection.dimensions = tested.dimensions;
    settings.config.scope.timeRange = "all";
    await apiRequest(service.instance, "/semantic/settings", "PUT", { config: settings.config, apiKey: "example-local-key" });
    await run({ service, calls, home });
  } finally { await service.close(); embedding.closeAllConnections(); await new Promise<void>(resolve => embedding.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
}

async function complete(service: Awaited<ReturnType<typeof startService>>): Promise<SemanticStatus> {
  for (let i = 0; i < 200; i++) {
    const status = await apiRequest<SemanticStatus>(service.instance, "/semantic/status");
    if (status.job?.status === "failed") assert.fail(status.job.error);
    if (status.job?.status === "complete") return status;
    await delay(20);
  }
  throw new Error("Semantic build timed out");
}

test("模型自动适配贯穿测试、正文构建和查询，保存连接不编码历史", async () => fixture(async ({ service, calls }) => {
  const settings = await apiRequest<SemanticSettings>(service.instance, "/semantic/settings");
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], ["query: Local connection test."]);
  assert.equal(settings.config.connection.documentPrefix, "passage: "); assert.equal(settings.config.connection.queryPrefix, "query: ");
  const preview = await apiRequest<SemanticPreview>(service.instance, "/semantic/preview", "POST", {});
  await apiRequest(service.instance, "/semantic/build", "POST", { previewId: preview.id });
  await complete(service);
  assert(calls[1]?.every(text => text.startsWith("passage: ")));
  await apiRequest(service.instance, "/semantic/search", "POST", { q: "连接问题", scope: settings.config.scope });
  assert.deepEqual(calls[2], ["query: 连接问题"]);
}, { model: "intfloat/multilingual-e5-small" }));

test("已有连接沿用原编码规则，更新策略和测试不切换索引", async () => fixture(async ({ service, calls, home }) => {
  const settings = await apiRequest<SemanticSettings>(service.instance, "/semantic/settings");
  Object.assign(settings.config.connection, { documentPrefix: "old-document: ", queryPrefix: "old-query: " });
  const legacy = await new SemanticConfigStore(home).save({ config: settings.config });
  const preview = await apiRequest<SemanticPreview>(service.instance, "/semantic/preview", "POST", {});
  await apiRequest(service.instance, "/semantic/build", "POST", { previewId: preview.id }); await complete(service);
  assert(calls[1]?.every(text => text.startsWith("old-document: ")));
  const current = await apiRequest<SemanticSettings>(service.instance, "/semantic/settings");
  current.config.strategy.concurrency = 2;
  Object.assign(current.config.connection, { documentPrefix: "", queryPrefix: "" });
  const saved = await apiRequest<SemanticSettings>(service.instance, "/semantic/settings", "PUT", { config: current.config });
  assert.equal(saved.fingerprint, legacy.fingerprint); assert.equal(saved.config.connection.queryPrefix, "old-query: ");
  assert.equal((await apiRequest<SemanticStatus>(service.instance, "/semantic/status")).ready, true);
  await apiRequest(service.instance, "/semantic/test", "POST", { connection: settings.config.connection });
  assert.deepEqual(calls[2], ["old-query: Local connection test."]);
  await apiRequest(service.instance, "/semantic/search", "POST", { q: "兼容查询", scope: settings.config.scope });
  assert.deepEqual(calls[3], ["old-query: 兼容查询"]);
}, { model: "qwen3-embedding:0.6b" }));

test("语义HTTP完整闭环：显式构建、重复正文复用、查询缓存、暂停查询、凭据与CLI接口一致", async () => fixture(async ({ service, calls }) => {
  assert.equal(calls.length, 1);
  const initial = await apiRequest<SemanticStatus>(service.instance, "/semantic/status");
  assert.equal(initial.ready, false); assert.equal(initial.enabled, false);
  const settings = await apiRequest<SemanticSettings>(service.instance, "/semantic/settings");
  assert.equal(settings.hasKey, true); assert(!JSON.stringify(settings).includes("example-local-key"));
  await assert.rejects(apiRequest(service.instance, "/semantic/key"), (error: unknown) => error instanceof RequestError && error.code === "FORBIDDEN");
  const operation = { method: "GET", path: "/semantic/key" };
  const grant = await apiRequest<{ token: string }>(service.instance, "/management/authorizations", "POST", { ...operation, confirmation: managementDigest(operation) });
  const key = await apiRequest<{ apiKey: string }>(service.instance, "/semantic/key", "GET", undefined, { "x-agent-manor-management": grant.token }); assert.equal(key.apiKey, "example-local-key");
  const preview = await apiRequest<SemanticPreview>(service.instance, "/semantic/preview", "POST", {});
  assert.equal(preview.sessionCount, 2); assert.equal(preview.uniqueInputs, 1); assert.equal(calls.length, 1);
  await apiRequest(service.instance, "/semantic/build", "POST", { previewId: preview.id });
  const built = await complete(service);
  assert.equal(built.ready, true); assert.equal(built.indexedSessions, 2); assert.equal(built.uniqueVectors, 1);
  assert.equal(calls.length, 2);
  const scope = { ...settings.config.scope, timeRange: "all" };
  const first = await apiRequest<SemanticSearchResult>(service.instance, "/semantic/search", "POST", { q: "处理网络连接问题", scope });
  assert.equal(first.total, 2); assert.equal(calls.length, 3);
  await apiRequest(service.instance, "/semantic/search", "POST", { q: "处理网络连接问题", scope, cacheOnly: true, sort: "updated" });
  assert.equal(calls.length, 3);
  const sharedParams = new URLSearchParams({ mode: "semantic", q: "处理网络连接问题", scope: JSON.stringify({ ...scope, models: ["missing-model"] }) });
  const shared = await apiRequest<SemanticSearchResult>(service.instance, `/sessions/search/groups?${sharedParams}`);
  assert.equal(shared.total, 0); assert.equal(calls.length, 3, "统一 GET 接口应用共同范围并复用查询编码");
  await apiRequest(service.instance, "/semantic/action", "POST", { action: "pause" });
  await apiRequest(service.instance, "/semantic/search", "POST", { q: "暂停后仍可主动搜索", scope });
  assert.equal(calls.length, 4);
  await assert.rejects(apiRequest(service.instance, "/semantic/search", "POST", { q: "不在缓存里的筛选", scope, cacheOnly: true }), (error: unknown) => error instanceof RequestError && error.code === "ANALYSIS_NOT_READY");
  assert.equal(calls.length, 4);
  const cli = await apiRequest<SemanticSearchResult & { hits: unknown[] }>(service.instance, "/sessions/search?q=处理网络连接问题&mode=semantic");
  assert.equal(cli.mode, "semantic"); assert.equal(cli.total, 2); assert.equal(cli.hits.length, 2);
  const repeated = await apiRequest<SemanticPreview>(service.instance, "/semantic/preview", "POST", {});
  assert.equal(repeated.pendingInputs, 0); assert.equal(repeated.reusedInputs, 1);
  await apiRequest(service.instance, "/semantic/build", "POST", { previewId: repeated.id });
  await complete(service); assert.equal(calls.length, 4);
  await apiRequest(service.instance, "/semantic/action", "POST", { action: "disable" });
  assert.equal((await apiRequest<SemanticStatus>(service.instance, "/semantic/status")).ready, false);
  await apiRequest(service.instance, "/semantic/action", "POST", { action: "enable" });
  assert.equal((await apiRequest<SemanticStatus>(service.instance, "/semantic/status")).ready, true);
  await apiRequest(service.instance, "/semantic/action", "POST", { action: "clear" });
  const cleared = await apiRequest<SemanticStatus>(service.instance, "/semantic/status");
  assert.equal(cleared.ready, false); assert.equal(cleared.indexedPositions, 0);
  assert.equal((await apiRequest<SemanticSettings>(service.instance, "/semantic/settings")).hasKey, true);
}));


test("HTTP 400 上下文过长会缩小输入并完成构建，不原样重试整批", async () => fixture(async ({ service, calls }) => {
  const preview = await apiRequest<SemanticPreview>(service.instance, "/semantic/preview", "POST", {});
  await apiRequest(service.instance, "/semantic/build", "POST", { previewId: preview.id });
  const completed = await complete(service);
  assert.equal(completed.ready, true); assert.ok(completed.job!.totalInputs > preview.uniqueInputs);
  const long = calls.filter(batch => batch.some(text => Array.from(text).length > 300)); assert.equal(long.length, 1);
  assert.ok(calls.some(batch => batch.length > 1 && batch.every(text => Array.from(text).length <= 300)));
}, { text: "测试正文".repeat(100), maxInputChars: 300 }));

test("状态写盘失败保留内存错误且服务关闭仍收尾 Worker", async () => fixture(async ({ service, home }) => {
  const preview = await apiRequest<SemanticPreview>(service.instance, "/semantic/preview", "POST", {});
  await apiRequest(service.instance, "/semantic/build", "POST", { previewId: preview.id });
  const state = join(home, "semantic", "state.json"); await rm(state); await mkdir(state);
  let failed: SemanticStatus | undefined;
  for (let i = 0; i < 100; i++) {
    failed = await apiRequest<SemanticStatus>(service.instance, "/semantic/status");
    if (failed.job?.errorCode === "semantic_persistence_failed") break;
    await delay(20);
  }
  assert.equal(failed?.job?.status, "failed"); assert.equal(failed?.job?.errorCode, "semantic_persistence_failed");
  assert.equal(failed?.job?.errorDescriptor?.key, "sessions.semantic.errors.persistence");
  await service.close();
}, { modelDelayMs: 150 }));

test("共享查询取消一个订阅者仍完成，全部取消的排队查询不调用模型", async () => fixture(async ({ service, calls }) => {
  const preview = await apiRequest<SemanticPreview>(service.instance, "/semantic/preview", "POST", {});
  await apiRequest(service.instance, "/semantic/build", "POST", { previewId: preview.id }); await complete(service);
  const settings = await apiRequest<SemanticSettings>(service.instance, "/semantic/settings");
  const search = (q: string, signal?: AbortSignal) => fetch(`http://127.0.0.1:${service.instance.port}/api/v1/semantic/search`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q, scope: settings.config.scope }), signal,
  });
  const one = new AbortController(), before = calls.length;
  const first = search("共享的新查询", one.signal), cancelled = assert.rejects(first, error => error instanceof Error && error.name === "AbortError");
  const second = search("共享的新查询"); await delay(40); one.abort(); await cancelled;
  const response = await second; assert.equal(response.status, 200); assert.equal((await response.json() as SemanticSearchResult).total, 2); assert.equal(calls.length - before, 1);
  settings.config.strategy.requestsPerMinute = 1; await apiRequest(service.instance, "/semantic/settings", "PUT", { config: settings.config });
  const two = new AbortController(), three = new AbortController();
  const abandonedOne = search("已放弃的排队查询", two.signal), abandonedTwo = search("已放弃的排队查询", three.signal);
  const rejectedOne = assert.rejects(abandonedOne, error => error instanceof Error && error.name === "AbortError"), rejectedTwo = assert.rejects(abandonedTwo, error => error instanceof Error && error.name === "AbortError");
  await delay(40); two.abort(); three.abort(); await Promise.all([rejectedOne, rejectedTwo]); await delay(20);
  settings.config.strategy.requestsPerMinute = 0; await apiRequest(service.instance, "/semantic/settings", "PUT", { config: settings.config });
  const next = await search("取消后新查询"); assert.equal(next.status, 200); await next.json();
  assert.equal(calls.length - before, 2); assert.equal(calls.some(batch => batch.includes("已放弃的排队查询")), false);
}, { modelDelayMs: 150 }));

test("首次状态保存失败不留下伪运行任务，不调用模型且恢复后可继续", async () => fixture(async ({ service, home, calls }) => {
  const preview = await apiRequest<SemanticPreview>(service.instance, "/semantic/preview", "POST", {});
  const state = join(home, "semantic", "state.json"); await rm(state); await mkdir(state);
  const before = calls.length;
  await assert.rejects(apiRequest(service.instance, "/semantic/build", "POST", { previewId: preview.id }), error => error instanceof RequestError && error.code === "ANALYSIS_NOT_READY");
  const failed = await apiRequest<SemanticStatus>(service.instance, "/semantic/status");
  assert.equal(failed.job?.status, "failed"); assert.equal(failed.job?.errorCode, "semantic_persistence_failed"); assert.equal(calls.length, before);
  await rm(state, { recursive: true });
  await apiRequest(service.instance, "/semantic/action", "POST", { action: "resume" });
  assert.equal((await complete(service)).ready, true); assert.equal(calls.length - before, 1);
}));

test("恢复时状态保存失败不留下伪运行任务，修复写盘后可再次恢复", async () => fixture(async ({ service, home, calls }) => {
  const settings = await apiRequest<SemanticSettings>(service.instance, "/semantic/settings");
  settings.config.strategy.requestsPerMinute = 1;
  await apiRequest(service.instance, "/semantic/settings", "PUT", { config: settings.config });
  const preview = await apiRequest<SemanticPreview>(service.instance, "/semantic/preview", "POST", {});
  await apiRequest(service.instance, "/semantic/build", "POST", { previewId: preview.id });
  const paused = await apiRequest<SemanticStatus>(service.instance, "/semantic/action", "POST", { action: "pause" }); assert.equal(paused.job?.status, "paused");
  const state = join(home, "semantic", "state.json"); await rm(state); await mkdir(state);
  const before = calls.length;
  await assert.rejects(apiRequest(service.instance, "/semantic/action", "POST", { action: "resume" }), error => error instanceof RequestError && error.code === "ANALYSIS_NOT_READY");
  const failed = await apiRequest<SemanticStatus>(service.instance, "/semantic/status");
  assert.equal(failed.job?.status, "failed"); assert.equal(failed.job?.errorCode, "semantic_persistence_failed"); assert.equal(calls.length, before);
  await rm(state, { recursive: true });
  const current = await apiRequest<SemanticSettings>(service.instance, "/semantic/settings"); current.config.strategy.requestsPerMinute = 0;
  await apiRequest(service.instance, "/semantic/settings", "PUT", { config: current.config });
  await apiRequest(service.instance, "/semantic/action", "POST", { action: "resume" }); assert.equal((await complete(service)).ready, true);
}));
