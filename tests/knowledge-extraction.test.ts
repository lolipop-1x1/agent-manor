import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KnowledgeConversation, KnowledgeExtractionScope, KnowledgeInputMessage, KnowledgeJob, KnowledgeSourceReader, KnowledgeTarget } from "../src/knowledge-contracts.js";
import { defaultKnowledgeConfig, KnowledgeConfigStore, KnowledgeModelError, validateKnowledgeConfig } from "../src/knowledge/config.js";
import { fitsRequest, type ChatMessage } from "../src/knowledge/generation.js";
import { KnowledgeManager } from "../src/knowledge/manager.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

interface Request { messages: ChatMessage[]; max_tokens: number; model: string; reasoning_effort?: string }
interface RecordData { reference: string; messageId: string; text: string; target: boolean }
interface Payload { evidence?: RecordData[]; segment?: number; segments?: number; earlier?: Candidate; later?: Candidate; incoming?: Candidate; existing?: { id: string; language?: string; title: string; body: string }[] }
interface Candidate { topic: string; title: string; body: string; type: string; tags: string[]; references: string[]; targetKnowledgeId?: string }
const noValue = { disposition: "no_value", candidates: [], carry: [], needsMessageIds: [], limitations: [] };
function material(request: Request): Payload { return JSON.parse(request.messages[1]!.content.split("<source_material>\n")[1]!.split("\n</source_material>")[0]!); }
function knowledge(candidate: Candidate) { return { ...noValue, disposition: "knowledge", candidates: [candidate] }; }
function candidate(references: string[], body = "Read the dynamic value on each request; verify an update is visible without a restart."): Candidate { return { topic: "dynamic-configuration", title: "Dynamic configuration", body, type: "procedure", tags: ["configuration"], references }; }
function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function messages(count = 6): KnowledgeInputMessage[] {
  return Array.from({ length: count * 2 }, (_unused, index) => {
    const text = index % 2 === 0 ? `Question ${index}: inspect dynamic configuration.` : `Answer ${index}: read the value on each request.`;
    return { id: `message-${index}`, sessionId: "synthetic-session", ordinal: index + 1, recordLine: index + 1, turnId: `turn-${Math.floor(index / 2) + 1}`, turnPosition: Math.floor(index / 2) + 1, kind: index % 2 === 0 ? "user" : "assistant", text, hash: hash(text), target: true };
  });
}
function reader(records: KnowledgeInputMessage[]): KnowledgeSourceReader & { records: KnowledgeInputMessage[] } {
  return {
    records,
    async plan(scope) {
      const selected = this.records.filter(message => (scope.turnStart === undefined || message.turnPosition >= scope.turnStart) && (scope.turnEnd === undefined || message.turnPosition <= scope.turnEnd));
      if (!selected.length) return [];
      return [{ sessionId: "synthetic-session", title: "Synthetic dynamic configuration task", client: "codex", project: "/workspace/demo", version: "version-1", branch: "current", updatedAt: "2026-01-01T00:00:00Z", messageIds: selected.map(message => message.id), hashes: selected.map(message => message.hash), turnCount: new Set(selected.map(message => message.turnId)).size, inputTokens: selected.reduce((sum, message) => sum + Buffer.byteLength(message.text), 0), contextTokens: 0, limitations: [] }];
    },
    async read(target) {
      for (const [index, id] of target.messageIds.entries()) if (!this.records.some(message => message.id === id && message.hash === target.hashes[index])) throw new Error("source changed");
      const ids = new Set(target.messageIds), end = Math.max(...this.records.filter(message => ids.has(message.id)).map(message => message.ordinal));
      const conversation: KnowledgeConversation = { session: { id: "synthetic-session", client: "codex", clientSessionId: "synthetic-native", title: target.title, titleOrigin: "recorded", project: "/workspace/demo", messageCount: this.records.length, turnCount: new Set(this.records.map(message => message.turnId)).size, models: ["synthetic"], gaps: [] }, version: target.version, branch: target.branch, messages: this.records.filter(message => message.ordinal <= end).map(message => ({ ...message, target: ids.has(message.id) })), limitations: [] };
      return conversation;
    },
    async verify(source) { return { ...source, status: "available" }; },
  };
}
async function settle(manager: KnowledgeManager, id: string): Promise<KnowledgeJob> {
  for (let attempt = 0; attempt < 600; attempt++) { const job = await manager.job(id); if (!["queued", "running"].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("task timeout");
}
function scope(extra: Partial<KnowledgeExtractionScope> = {}): KnowledgeExtractionScope { return { ...defaultKnowledgeConfig().automatic.scope, timeRange: "all", ...extra }; }
async function fixture(run: (context: { manager: KnowledgeManager; store: KnowledgeStore; source: ReturnType<typeof reader>; requests: Request[]; headers: (string | undefined)[]; directory: string; setHandler: (handler: (request: Request, response: ServerResponse) => unknown | Promise<unknown>) => void; reopen: () => Promise<KnowledgeManager> }) => Promise<void>, records = messages()) {
  const directory = await mkdtemp(join(tmpdir(), "manor-knowledge-extraction-")), store = new KnowledgeStore(join(directory, "knowledge", "knowledge.sqlite")), source = reader(records), requests: Request[] = [], headers: (string | undefined)[] = [];
  let handler: (request: Request, response: ServerResponse) => unknown | Promise<unknown> = () => noValue;
  const server = createServer(async (request, response) => {
    try {
      const body: Buffer[] = []; for await (const item of request) body.push(item); const data = JSON.parse(Buffer.concat(body).toString()) as Request;
      requests.push(data); headers.push(request.headers.authorization);
      const result = await handler(data, response); if (response.writableEnded) return;
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    } catch (cause) { response.statusCode = 500; response.end(String(cause)); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  let manager = new KnowledgeManager(directory, store, source);
  const settings = defaultKnowledgeConfig("en"); settings.generation.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`; settings.generation.model = "synthetic-generation"; settings.generation.retries = 0;
  await manager.saveSettings({ config: settings });
  try { await run({ manager, store, source, requests, headers, directory, setHandler: value => { handler = value; }, reopen: async () => { await manager.close(); manager = new KnowledgeManager(directory, store, source); return manager; } }); }
  finally { await manager.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(directory, { recursive: true, force: true }); }
}

test("知识模型配置独立保存语言、凭据不回传且权限为0600", async () => fixture(async ({ manager, directory }) => {
  const initial = await manager.settings("zh-CN"); assert.equal(initial.config.outputLanguage, "en");
  await manager.saveSettings({ config: initial.config, generationKey: "synthetic-secret", embeddingKey: "synthetic-vector-secret" });
  const settings = await manager.settings(); assert.equal(settings.hasGenerationKey, true); assert.equal(JSON.stringify(settings).includes("synthetic-secret"), false);
  assert.equal((await stat(join(directory, "knowledge", "credentials.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, "knowledge", "config.json"))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(directory, "knowledge", "config.json"), "utf8")).includes("synthetic-secret"), false);
  const broken = structuredClone(initial.config); broken.generation.dailyBudget = 1;
  assert.throws(() => validateKnowledgeConfig(broken), (cause: unknown) => cause instanceof KnowledgeModelError && cause.code === "config_invalid");
}));

test("首次输出语言独立持久化，配置保存不使旧覆盖失效且旧预览不能误用新配置", async () => fixture(async ({ manager, directory }) => {
  const isolated = new KnowledgeConfigStore(join(directory, "isolated"));
  assert.equal((await isolated.read()).config.outputLanguage, "zh-CN"); await assert.rejects(readFile(join(directory, "isolated", "knowledge", "config.json")), { code: "ENOENT" });
  assert.equal((await isolated.read("en")).config.outputLanguage, "en"); assert.equal((await isolated.read("zh-CN")).config.outputLanguage, "en");
  const preview = await manager.preview(scope()); const settings = (await manager.settings()).config; settings.extractionPrompt += " Changed requirement."; settings.outputLanguage = "zh-CN"; await manager.saveSettings({ config: settings });
  await assert.rejects(manager.start(preview.id), (cause: unknown) => cause instanceof KnowledgeModelError && cause.code === "preview_stale");
  const fresh = await manager.preview(scope()); assert.equal((await settle(manager, (await manager.start(fresh.id)).id)).status, "complete");
  settings.outputLanguage = "en"; settings.generation.model = "different-synthetic-model"; await manager.saveSettings({ config: settings }); assert.equal((await manager.preview(scope())).pendingMessages, 0);
  assert.equal((await manager.preview(scope({ force: true }))).pendingMessages, 12);
}));

test("reasoning_effort仅在明确配置时发送，试抽取用量不混入并行连接测试", async () => fixture(async ({ manager, requests, setHandler }) => {
  setHandler(request => request.messages[0]!.content.includes('"ok":true') ? { ok: true } : noValue);
  await manager.test(); assert.equal(Object.hasOwn(requests[0]!, "reasoning_effort"), false);
  const config = (await manager.settings()).config; config.generation.reasoningEffort = "none"; await manager.saveSettings({ config });
  const [, result] = await Promise.all([manager.test(), manager.tryExtract(scope({ turnStart: 1, turnEnd: 1 }))]);
  assert.equal(result.usage.requests, 1); assert.equal(result.usage.inputTokens, 100); assert.equal(result.usage.outputTokens, 20);
  assert.equal(result.usage.actualInputTokens, 100); assert.equal(result.usage.estimatedInputTokens, 0); assert.equal(result.usage.byPurpose?.try.actualRequests, 1); assert.equal(result.usage.byPurpose?.test.requests, 0);
  assert.ok(requests.slice(1).every(request => request.reasoning_effort === "none"));
}));

test("无usage响应保留估算依据，有usage响应单独统计实测并按用途聚合", async () => fixture(async ({ manager, setHandler }) => {
  setHandler((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] })); });
  await manager.test(); const estimated = (await manager.status()).usage;
  assert.equal(estimated.actualRequests, 0); assert.equal(estimated.actualInputTokens, 0); assert.equal(estimated.actualOutputTokens, 0); assert.ok(estimated.estimatedInputTokens! > 0); assert.equal(estimated.estimatedOutputTokens, 4);
  assert.equal(estimated.byPurpose?.test.requests, 1); assert.equal(estimated.byPurpose?.test.actualRequests, 0); assert.equal(estimated.estimatedCost, null);
  setHandler(() => ({ ok: true })); await manager.test(); const measured = (await manager.status()).usage;
  assert.equal(measured.actualRequests, 1); assert.equal(measured.actualInputTokens, 100); assert.equal(measured.actualOutputTokens, 20); assert.equal(measured.estimatedInputTokens, estimated.estimatedInputTokens); assert.equal(measured.estimatedOutputTokens, 4);
  assert.equal(measured.inputTokens, measured.estimatedInputTokens! + measured.actualInputTokens!); assert.equal(measured.outputTokens, measured.estimatedOutputTokens! + measured.actualOutputTokens!); assert.equal(measured.byPurpose?.test.requests, 2); assert.equal(measured.byPurpose?.extract.requests, 0);
}));

test("选定晚期轮次的零产出仅覆盖实际消息，早期缺口与内容改写仍待处理", async () => fixture(async ({ manager, source }) => {
  const preview = await manager.preview(scope({ turnStart: 5, turnEnd: 6 })); assert.equal(preview.pendingMessages, 4);
  const job = await settle(manager, (await manager.start(preview.id, "synthetic-idempotency")).id); assert.equal(job.status, "complete"); assert.equal(job.createdEntries, 0); assert.ok(job.noValue > 0);
  assert.equal((await manager.start(preview.id, "synthetic-idempotency")).id, job.id);
  const all = await manager.preview(scope()); assert.equal(all.pendingMessages, 8); assert.equal(all.skippedMessages, 4);
  assert.equal((await manager.preview(scope({ force: true }))).pendingMessages, 12);
  source.records[10] = { ...source.records[10]!, text: "Corrected source", hash: hash("Corrected source") };
  assert.equal((await manager.preview(scope())).pendingMessages, 9);
}));

test("需要上下文、无效引用、服务失败不推进覆盖；显式重试不会重复成功结果", async () => fixture(async ({ manager, setHandler, store }) => {
  setHandler(() => ({ ...noValue, disposition: "needs_context" }));
  const preview = await manager.preview(scope()); const id = (await manager.start(preview.id)).id;
  assert.equal((await settle(manager, id)).needsContext, 1); assert.equal((await manager.preview(scope())).pendingMessages, 12);
  setHandler(() => knowledge(candidate(["invented-reference"]))); await manager.action(id, "retry");
  const invalid = await settle(manager, id); assert.equal(invalid.status, "failed"); assert.match(invalid.error!, /引用/); assert.equal(store.list({ review: "all" }).total, 0);
  // 重试会复用成功的片段检查点；上下文不足检查点应重新执行，而非永久记住无法产出。
  setHandler(request => { const payload = material(request) as Payload; return knowledge(candidate(payload.evidence?.filter(item => item.target).slice(0, 1).map(item => item.reference) ?? ["e0"])); });
  await manager.action(id, "retry"); const retried = await settle(manager, id);
  assert.equal(retried.status, "complete"); assert.equal(store.list({ review: "all" }).total, 1);
  assert.equal((await manager.preview(scope())).pendingMessages, 0);
}));

test("超长单轮完整分段，所有请求计入结构预算，后续纠正归并为一个待审知识", async () => {
  const records = messages(1); records[0] = { ...records[0]!, text: "Initial attempt: cache once. " + "中间工具输出和证据".repeat(700), hash: "long-input" };
  records[1] = { ...records[1]!, text: "FINAL CORRECTION: caching once failed; read dynamically and verify without restart.", hash: "final-correction" };
  await fixture(async ({ manager, requests, setHandler, store }) => {
    const settings = (await manager.settings()).config; settings.generation.contextTokens = 8192; settings.generation.outputTokens = 512; await manager.saveSettings({ config: settings });
    const seen: string[] = [];
    setHandler(request => {
      assert.equal(fitsRequest(settings, request.messages), true);
      const payload = material(request) as Payload;
      if (payload.later) return { ...knowledge(candidate([...new Set([...(payload.earlier?.references ?? []), ...payload.later.references])].slice(-8), payload.later.body)), relation: "correction" };
      const evidence = payload.evidence?.filter(item => item.target) ?? []; seen.push(...evidence.map(item => item.text));
      return knowledge(candidate(evidence.map(item => item.reference), evidence.some(item => item.text.includes("FINAL CORRECTION")) ? "Read dynamically; the earlier cache attempt failed. Verified without restart." : "Initial cache attempt remains unverified."));
    });
    const job = await settle(manager, (await manager.start((await manager.preview(scope())).id)).id);
    assert.equal(job.status, "complete", job.error); assert.ok(job.totalChunks > 2); assert.equal(job.completedChunks, job.totalChunks); assert.equal(job.createdEntries, 1);
    assert.equal(seen.join(""), records.map(message => message.text).join(""));
    const entry = store.list({ review: "pending" }).items[0]!; assert.match(entry.revision.body, /earlier cache attempt failed/); assert.equal(entry.revision.review, "pending"); assert.ok(requests.length > job.totalChunks);
  }, records);
});

test("已有已审知识的后续纠正产生待审修订并沿用原语言", async () => fixture(async ({ manager, store, setHandler }) => {
  const old = store.create({ title: "Dynamic configuration", body: "启动时只读取一次配置。", type: "procedure", tags: ["configuration"], scope: { kind: "project", project: "/workspace/demo" }, language: "zh-CN" });
  store.review(old.id, { action: "approve", revisionId: old.latestRevisionId });
  setHandler(request => {
    const payload = material(request) as Payload;
    if (payload.existing?.length) { assert.match(request.messages[0]!.content, /English/); assert.equal(payload.existing[0]!.language, "zh-CN"); return { ...knowledge({ ...candidate(payload.incoming!.references, "每次请求动态读取配置，并验证更新立即生效。"), targetKnowledgeId: payload.existing[0]!.id }), relation: "correction" }; }
    return knowledge(candidate(payload.evidence!.filter(item => item.target).slice(-8).map(item => item.reference)));
  });
  const job = await settle(manager, (await manager.start((await manager.preview(scope())).id)).id); assert.equal(job.status, "complete", job.error); assert.equal(job.updatedEntries, 1); assert.equal(job.createdEntries, 0);
  const detail = store.get(old.id, { review: "all", availability: "all" }); assert.equal(detail.revision.language, "zh-CN"); assert.equal(detail.publishedRevisionId, old.latestRevisionId);
  assert.equal(store.get(old.id).revision.body, "启动时只读取一次配置。"); assert.equal(detail.latestRevisionId !== old.latestRevisionId, true);
  const usage = (await manager.status()).usage; assert.equal(usage.byPurpose?.extract.requests, 1); assert.equal(usage.byPurpose?.merge.requests, 1); assert.equal(usage.actualRequests, 2);
}));

test("相关旧知识的语言不覆盖新条目任务语言，只有明确更新目标才沿用旧语言", async () => fixture(async ({ manager, store, setHandler }) => {
  const old = store.create({ title: "Dynamic configuration", body: "先前的中文知识。", type: "procedure", tags: ["configuration"], scope: { kind: "project", project: "/workspace/demo" }, language: "zh-CN", subject: "project" });
  setHandler(request => {
    const payload = material(request);
    if (payload.existing?.length) {
      assert.match(request.messages[0]!.content, /English \(en\)/); assert.match(request.messages[1]!.content, /New knowledge output language is English/);
      return knowledge({ ...candidate(payload.incoming!.references), title: "A distinct configuration method" });
    }
    return knowledge(candidate(payload.evidence!.filter(item => item.target).slice(-1).map(item => item.reference)));
  });
  const job = await settle(manager, (await manager.start((await manager.preview(scope())).id)).id); assert.equal(job.status, "complete", job.error); assert.equal(job.createdEntries, 1); assert.equal(job.updatedEntries, 0);
  const created = store.list({ review: "pending" }).items.find(item => item.id !== old.id)!; assert.equal(created.revision.language, "en"); assert.equal(store.revisions(old.id).length, 1);
}));

test("事项解决、时效及其他内容元数据变化不能被正文判重丢弃", async () => {
  const changes = [{ resolved: true }, { validUntil: "2099-12-31" }, { applicability: "Apply only to dynamically loaded configuration." }, { summary: "A durable summary." }, { subject: "personal" as const }, { occurredAt: "2026-01-01" }];
  for (const change of changes) await fixture(async ({ manager, store, setHandler }) => {
    const original = candidate([]), type = "resolved" in change ? "open_question" : "procedure";
    const old = store.create({ title: original.title, body: original.body, type, tags: original.tags, subject: "project", language: "en", scope: { kind: "project", project: "/workspace/demo" } });
    setHandler(request => {
      const payload = material(request), references = payload.incoming?.references ?? payload.evidence!.filter(item => item.target).slice(-1).map(item => item.reference);
      return { ...knowledge({ ...candidate(references), type, ...change, ...(payload.existing ? { targetKnowledgeId: old.id } : {}) }), ...(payload.existing ? { relation: "complement" } : {}) };
    });
    const job = await settle(manager, (await manager.start((await manager.preview(scope())).id)).id); assert.equal(job.status, "complete", job.error); assert.equal(job.updatedEntries, 1, JSON.stringify(change)); assert.equal(job.duplicates, 0); assert.equal(store.revisions(old.id).length, 2);
    const pending = store.get(old.id, { review: "all", availability: "all" }).revision;
    for (const [key, value] of Object.entries(change)) assert.equal(pending[key as keyof typeof pending], value);
  });
});

test("仅来源不同不制造内容修订，完整可容纳的多轮会话只抽取一次", async () => {
  const records = messages(2).map((message, index) => { const text = `Coherent requirement ${index}. `.repeat(65); return { ...message, text, hash: hash(text) }; });
  await fixture(async ({ manager, store, requests, setHandler }) => {
    const config = (await manager.settings()).config; config.generation.contextTokens = 16_384; config.generation.outputTokens = 512; await manager.saveSettings({ config });
    const reference = candidate([]), old = store.create({ title: reference.title, body: reference.body, type: "procedure", tags: reference.tags, scope: { kind: "project", project: "/workspace/demo" }, language: "en", subject: "project" });
    setHandler(request => {
      const payload = material(request); assert.equal(payload.segment, 1); assert.equal(payload.segments, 1); assert.equal(payload.evidence!.map(item => item.text).join(""), records.map(item => item.text).join(""));
      return knowledge(candidate(payload.evidence!.slice(-1).map(item => item.reference)));
    });
    const job = await settle(manager, (await manager.start((await manager.preview(scope())).id)).id); assert.equal(job.status, "complete", job.error); assert.equal(job.totalChunks, 1); assert.equal(requests.length, 1); assert.equal(job.duplicates, 1); assert.equal(store.revisions(old.id).length, 1);
  }, records);
});

test("增量可通过旧知识定位早期消息并补读原文，试抽取不入库不推进覆盖", async () => fixture(async ({ manager, store, setHandler }) => {
  const old = store.create({ title: "Earlier decision", body: "Earlier configuration decision remains uncertain.", scope: { kind: "project", project: "/workspace/demo" }, sources: [{ kind: "extraction", sessionId: "synthetic-session", messageId: "message-0", hash: hash("Question 0: inspect dynamic configuration."), turnPosition: 1 }] });
  let reread = false;
  setHandler(request => {
    const payload = material(request) as Payload & { priorKnowledge?: unknown[]; supplemental?: RecordData[] };
    if (payload.existing) return { ...knowledge({ ...candidate(payload.incoming!.references), targetKnowledgeId: old.id }), relation: "correction" };
    assert.ok(payload.priorKnowledge?.length);
    if (!payload.supplemental) return { ...noValue, disposition: "needs_context", needsMessageIds: ["message-0"] };
    reread = true; assert.equal(payload.supplemental[0]!.messageId, "message-0"); assert.match(payload.supplemental[0]!.text, /Question 0/);
    return knowledge(candidate(payload.evidence!.filter(item => item.target).slice(-1).map(item => item.reference)));
  });
  const result = await manager.tryExtract(scope({ turnStart: 5, turnEnd: 6 })); assert.equal(result.disposition, "knowledge"); assert.equal(reread, true); assert.equal(store.list({ review: "all" }).total, 1); assert.equal(store.revisions(old.id).length, 1);
  assert.equal((await manager.preview(scope())).pendingMessages, 12);
}));

test("候选与覆盖原子提交，保存中断回滚整个会话并允许幂等重试", async () => fixture(async ({ manager, setHandler, store }) => {
  setHandler(request => {
    const payload = material(request) as Payload, reference = payload.evidence!.find(item => item.target)!.reference;
    return { ...knowledge(candidate([reference])), candidates: [candidate([reference]), { ...candidate([reference], "A distinct verified method."), topic: "distinct-topic", title: "Distinct method", tags: ["distinct"] }] };
  });
  const originalCreate = store.create.bind(store); let count = 0;
  store.create = (...args) => { count++; if (count === 2) throw new Error("synthetic write failure"); return originalCreate(...args); };
  const id = (await manager.start((await manager.preview(scope())).id)).id; assert.equal((await settle(manager, id)).status, "failed"); assert.equal(store.list({ review: "all" }).total, 0); assert.equal((await manager.preview(scope())).pendingMessages, 12);
  store.create = originalCreate; await manager.action(id, "retry"); assert.equal((await settle(manager, id)).status, "complete"); assert.equal(store.list({ review: "all" }).total, 2); assert.equal((await manager.preview(scope())).pendingMessages, 0);
}));

test("来源预览后改写会阻止启动，提示词超预算不会发送请求", async () => fixture(async ({ manager, source, requests }) => {
  const preview = await manager.preview(scope()); source.records[0] = { ...source.records[0]!, text: "Changed source", hash: "changed-source" };
  await assert.rejects(manager.start(preview.id), (cause: unknown) => cause instanceof KnowledgeModelError && cause.code === "source_changed");
  assert.equal(requests.length, 0);
  const config = (await manager.settings()).config; config.generation.contextTokens = 4096; config.generation.outputTokens = 512; config.extractionPrompt = "Large custom extraction requirement. ".repeat(400); await manager.saveSettings({ config });
  await assert.rejects(manager.preview(scope()), (cause: unknown) => cause instanceof KnowledgeModelError && cause.code === "input_too_long"); assert.equal(requests.length, 0);
  config.extractionPrompt = defaultKnowledgeConfig().extractionPrompt; config.generation.contextTokens = 32768; await manager.saveSettings({ config }); assert.equal((await manager.preview(scope())).pendingMessages, 12);
}));

test("超时和非JSON响应不重试成知识，失败不覆盖来源", async () => fixture(async ({ manager, setHandler, requests }) => {
  const config = (await manager.settings()).config; config.generation.timeoutMs = 100; config.generation.retries = 1; await manager.saveSettings({ config });
  setHandler(async () => { await new Promise(resolve => setTimeout(resolve, 180)); return noValue; });
  const id = (await manager.start((await manager.preview(scope())).id)).id, failed = await settle(manager, id); assert.equal(failed.status, "failed"); assert.match(failed.error!, /超时/); assert.equal(requests.length, 2); assert.equal((await manager.preview(scope())).pendingMessages, 12);
  setHandler((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content: "```json\n{}\n```" } }] })); });
  await manager.action(id, "retry"); const invalid = await settle(manager, id); assert.equal(invalid.status, "failed"); assert.match(invalid.error!, /JSON/); assert.equal(requests.length, 3);
}));

test("429有限重试、请求单并发且每日预算在发送前阻断", async () => fixture(async ({ manager, setHandler, requests }) => {
  const config = (await manager.settings()).config; config.generation.retries = 1; config.generation.inputPricePerMillion = 1; config.generation.outputPricePerMillion = 1;
  await manager.saveSettings({ config }); let active = 0, maximum = 0, count = 0;
  setHandler(async (request, response) => {
    active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 15)); active--; count++;
    if (count === 1) { response.statusCode = 429; response.setHeader("retry-after", "0"); response.end("synthetic rate limit"); return; }
    return request.messages[0]!.content.includes('"ok":true') ? { ok: true } : noValue;
  });
  await Promise.all([manager.test(), manager.tryExtract(scope({ turnStart: 1, turnEnd: 1 }))]); assert.equal(maximum, 1); assert.equal(requests.length, 3);
  config.generation.dailyBudget = 0; await manager.saveSettings({ config });
  await assert.rejects(manager.test(), (cause: unknown) => cause instanceof KnowledgeModelError && cause.code === "budget_exceeded"); assert.equal(requests.length, 3);
  const job = await settle(manager, (await manager.start((await manager.preview(scope())).id)).id); assert.equal(job.status, "budget_stopped");
}));

test("后台增量默认关闭，定时检查仅处理已知静默会话，未知时间与失败不会假装完成", async () => fixture(async ({ manager, source, store, requests, setHandler }) => {
  const tick = () => (manager as unknown as { automatic(): Promise<void> }).automatic();
  const due = () => { const state = store.getState<{ automatic: { nextCheckAt?: string } }>("extraction.manager")!; state.automatic.nextCheckAt = "2020-01-01T00:00:00Z"; store.setState("extraction.manager", state); };
  assert.equal((await manager.status()).automatic.enabled, false); await tick(); assert.equal(requests.length, 0);
  const config = (await manager.settings()).config; config.automatic.enabled = true; config.automatic.scope = scope(); await manager.saveSettings({ config });
  const originalPlan = source.plan.bind(source); let time: string | undefined;
  source.plan = async input => (await originalPlan(input)).map(target => ({ ...target, updatedAt: time }));
  due(); await tick(); const unknown = await manager.status(); assert.equal(unknown.jobs.length, 0); assert.equal(unknown.automatic.errorDescriptor?.key, "knowledge.errors.quiet_time_unknown");
  time = new Date().toISOString(); due(); await tick(); assert.equal((await manager.status()).jobs.length, 0);
  time = "2020-01-01T00:00:00Z"; due(); await tick(); let status = await manager.status(); assert.equal(status.jobs.length, 1); assert.equal((await settle(manager, status.jobs[0]!.id)).status, "complete");
  const count = requests.length; due(); await tick(); assert.equal(requests.length, count); assert.equal((await manager.preview(scope())).pendingMessages, 0);
  source.records[0] = { ...source.records[0]!, text: "Additional correction", hash: "additional-correction" }; setHandler(() => ({ ...noValue, disposition: "needs_context" }));
  due(); await tick(); status = await manager.status(); const failed = await settle(manager, status.jobs[0]!.id); assert.equal(failed.status, "failed"); assert.equal((await manager.preview(scope())).pendingMessages, 1);
  const afterFailure = requests.length; due(); await tick(); assert.equal(requests.length, afterFailure); assert.equal((await manager.status()).jobs.length, 2);
}));

test("同会话多个分支独立提交与恢复，会话总数与完成数不伪装成分支数量", async () => fixture(async ({ manager, source }) => {
  const plan = source.plan.bind(source), read = source.read.bind(source); let rightReads = 0, fail = true;
  source.plan = async input => (await plan(input)).flatMap(target => [{ ...target, branch: "left" }, { ...target, branch: "right" }]);
  source.read = async target => { if (target.branch === "right") { rightReads++; if (rightReads > 2 && fail) throw new Error("synthetic branch unavailable"); } return read(target); };
  const preview = await manager.preview(scope({ branch: "all" })); assert.equal(preview.targets.length, 2); assert.equal(preview.sessionCount, 1);
  const id = (await manager.start(preview.id)).id, partial = await settle(manager, id); assert.equal(partial.status, "partial"); assert.equal(partial.totalSessions, 1); assert.equal(partial.completedSessions, 0);
  fail = false; await manager.action(id, "retry"); const done = await settle(manager, id); assert.equal(done.status, "complete"); assert.equal(done.completedSessions, 1); assert.equal(done.totalSessions, 1); assert.equal((await manager.preview(scope({ branch: "all" }))).pendingMessages, 0);
}));

test("启动后固定提示词、输出语言和凭据；暂停重启从安全检查点恢复", async () => {
  const records = messages(1); records[0] = { ...records[0]!, text: "Bounded chunk. ".repeat(1200), hash: "bounded-long" };
  await fixture(async ({ manager: first, setHandler, headers, reopen, store }) => {
    let manager = first; const config = (await manager.settings()).config; config.generation.contextTokens = 8192; config.generation.outputTokens = 512; config.extractionPrompt += " FROZEN-PROMPT";
    await manager.saveSettings({ config, generationKey: "old-synthetic-key" });
    let release!: () => void; let secondStarted!: () => void; const second = new Promise<void>(resolve => { secondStarted = resolve; }); let count = 0;
    setHandler(async () => { count++; if (count === 2) { secondStarted(); await new Promise<void>(resolve => { release = resolve; }); } return noValue; });
    const preview = await manager.preview(scope()), id = (await manager.start(preview.id)).id; await second;
    const changed = structuredClone(config); changed.outputLanguage = "zh-CN"; changed.extractionPrompt = "NEW-PROMPT"; await manager.saveSettings({ config: changed, generationKey: "new-synthetic-key" });
    await manager.action(id, "pause"); release(); manager = await reopen(); const paused = await manager.job(id); assert.equal(paused.status, "paused"); assert.equal(paused.completedChunks, 1); assert.deepEqual(await manager.previewById(preview.id), JSON.parse(JSON.stringify(preview)));
    setHandler(request => { assert.match(request.messages[0]!.content, /FROZEN-PROMPT/); assert.match(request.messages[0]!.content, /English/); return noValue; });
    await manager.action(id, "resume"); const done = await settle(manager, id); assert.equal(done.status, "complete", done.error); assert.equal(done.outputLanguage, "en"); assert.ok(headers.every(value => value === "Bearer old-synthetic-key"));
    assert.equal(store.list({ review: "all" }).total, 0); assert.equal((await manager.preview(scope())).pendingMessages, 0);
  }, records);
});


test("富媒体预览只计算文本，计划分片与执行一致，来源哈希和覆盖不受投影影响", async () => {
  const encoded = "a".repeat(2_000_000), raw = JSON.stringify([{ type: "input_text", text: "Exit code: 1. Keep the failed test as evidence." }, { type: "input_image", image_url: `data:image/png;base64,${encoded}` }]);
  const records = messages(1); records.splice(1, 0, { ...records[1]!, id: "synthetic-media", ordinal: 1.5, kind: "tool_result", text: raw, hash: hash(raw) });
  await fixture(async ({ manager, source, requests }) => {
    const preview = await manager.preview(scope()); assert.equal(preview.plannedChunks, 1); assert.equal(preview.omittedMedia, 1); assert.ok(preview.sourceBytes! > 2_000_000); assert.ok(preview.textBytes! < 1000); assert.ok(preview.estimatedTokens < 5000); assert.equal(preview.estimatedOutputTokens, 2048);
    const job = await settle(manager, (await manager.start(preview.id)).id); assert.equal(job.status, "complete"); assert.equal(job.totalChunks, preview.plannedChunks); assert.equal(requests.length, 1);
    assert.equal(requests[0]!.messages.some(message => message.content.includes(encoded)), false); assert.ok(requests[0]!.messages[1]!.content.includes("Keep the failed test")); assert.ok(preview.limitationDetails?.some(detail => detail.messageDescriptor?.key === "knowledge.limitation.mediaOmitted"));
    assert.equal(source.records[1]!.text, raw); assert.equal(source.records[1]!.hash, hash(raw)); assert.equal((await manager.preview(scope())).pendingMessages, 0);
  }, records);
});

test("大量JSON转义和Unicode按最终请求预算切分，预览与任务片数相同且正文不丢失", async () => {
  const text = '\\"\n中文🙂'.repeat(5000), records = messages(1); records[1] = { ...records[1]!, text, hash: hash(text) };
  await fixture(async ({ manager, requests }) => {
    const config = (await manager.settings()).config; config.generation.contextTokens = 12_000; config.generation.outputTokens = 512; await manager.saveSettings({ config });
    const preview = await manager.preview(scope()); assert.ok(preview.plannedChunks! > 1);
    const job = await settle(manager, (await manager.start(preview.id)).id); assert.equal(job.status, "complete"); assert.equal(job.totalChunks, preview.plannedChunks); assert.equal(requests.length, preview.plannedChunks);
    assert.ok(requests.every(request => fitsRequest(config, request.messages)));
    const fragments = requests.flatMap(request => material(request).evidence ?? []).filter(item => item.messageId === records[1]!.id).map(item => item.text); assert.equal(fragments.join(""), text); assert.ok(fragments.every(fragment => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(fragment)));
  }, records);
});


test("旧输入方案的暂停任务要求新建预览，不能继续发送旧分片", async () => fixture(async ({ manager, store, setHandler, requests }) => {
  setHandler(async () => { await new Promise(resolve => setTimeout(resolve, 100)); return noValue; });
  const preview = await manager.preview(scope()), job = await manager.start(preview.id); await manager.action(job.id, "pause");
  const record = store.getState<{ preview: { fingerprint: string } }>(`extraction.job:${job.id}`)!; record.preview.fingerprint = "synthetic-old-input-recipe"; store.setState(`extraction.job:${job.id}`, record);
  const before = requests.length; await assert.rejects(manager.action(job.id, "resume"), (cause: unknown) => cause instanceof KnowledgeModelError && cause.code === "preview_stale");
  assert.equal((await manager.job(job.id)).status, "paused"); assert.equal(requests.length, before);
}));

test("同一轮中的非目标工具记录不进入分片和候选证据", async () => {
  const records = messages(1), excluded = "EXCLUDED-COPIED-TOOL-OUTPUT ".repeat(2000);
  records.splice(1, 0, { ...records[1]!, id: "copied-tool", ordinal: 1.5, kind: "tool_result", copied: true, text: excluded, hash: hash(excluded) });
  await fixture(async ({ manager, source, requests }) => {
    const original = source.plan.bind(source);
    source.plan = async scope => (await original(scope)).map(target => {
      const indexes = target.messageIds.flatMap((id, index) => id === "copied-tool" ? [] : [index]);
      return { ...target, messageIds: indexes.map(index => target.messageIds[index]!), hashes: indexes.map(index => target.hashes[index]!) };
    });
    for (const contextTokens of [32768, 12000]) {
      if (contextTokens === 12000) { source.records[2]!.text = "Long target text. ".repeat(2000); source.records[2]!.hash = hash(source.records[2]!.text); }
      const before = requests.length, config = (await manager.settings()).config; config.generation.contextTokens = contextTokens; await manager.saveSettings({ config });
      const preview = await manager.preview(scope({ force: true })); assert.equal(preview.plannedChunks! > 1, contextTokens === 12000); assert.equal(preview.pendingMessages, 2);
      const done = await settle(manager, (await manager.start(preview.id)).id); assert.equal(done.status, "complete");
      const sent = requests.slice(before), evidence = sent.flatMap(request => material(request).evidence!); assert.deepEqual([...new Set(evidence.map(item => item.messageId))], ["message-0", "message-1"]);
      assert.equal(sent.some(request => request.messages.some(message => message.content.includes("EXCLUDED-COPIED-TOOL-OUTPUT"))), false);
    }
  }, records);
});
