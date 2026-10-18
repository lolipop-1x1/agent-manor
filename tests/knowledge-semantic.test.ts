import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import type { KnowledgeDetail, KnowledgeIndexPreview, KnowledgeIndexStatus, KnowledgeList, KnowledgeSettings } from "../src/knowledge-contracts.js";
import type { SemanticSettings, SemanticStatus } from "../src/semantic-contracts.js";
import { apiRequest, delay } from "../src/service/runtime.js";
import { approve, independent, knowledgeDraft, knowledgeFixture, requestError, waitCalls, waitIndex } from "./helpers/knowledge-fixture.js";
import { KnowledgeSemantic } from "../src/knowledge/semantic.js";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { defaultSemanticConfig } from "../src/semantic/config.js";

test("知识语义索引显式构建，待审与已审分别过滤，原文读写与关键词无需模型", async () => knowledgeFixture(async fixture => {
  const { agent, calls } = fixture;
  const first = await agent<KnowledgeDetail>("/entries", "POST", knowledgeDraft()); await approve(fixture, first);
  const pending = await agent<KnowledgeDetail>("/entries", "POST", knowledgeDraft({ title: "待审数据库连接经验", body: "限制重试次数，记录失败原因。", tags: ["数据库"] }));
  await independent(fixture); assert.equal(calls.length, 0);
  assert.equal((await agent<KnowledgeIndexStatus>("/index/status")).status, "needs_build");
  await assert.rejects(agent("/search", "POST", { mode: "semantic", q: "配置" }), requestError("ANALYSIS_NOT_READY"));
  const preview = await agent<KnowledgeIndexPreview>("/index/preview", "POST", {});
  assert.equal(preview.reviewed, 1); assert.equal(preview.pending, 1); assert.equal(calls.length, 0);
  await agent("/index/build", "POST", { previewId: preview.id }); await waitIndex(fixture);
  assert.equal(calls.length, 2); assert(calls.every(call => call.path.endsWith("/embeddings") && call.authorization === "Bearer synthetic-embedding-secret"));
  assert.equal((await agent<KnowledgeList>("/search", "POST", { mode: "semantic", q: "相关经验" })).items[0]?.id, first.id);
  assert.equal((await agent<KnowledgeList>("/search", "POST", { mode: "semantic", q: "相关经验", review: "pending" })).items[0]?.id, pending.id);
  assert.equal((await agent<KnowledgeList>("/search", "POST", { mode: "semantic", q: "相关经验", review: "all" })).total, 2);
  const before = calls.length;
  assert.equal((await agent<KnowledgeList>("/search", "POST", { mode: "keyword", q: "配置" })).total, 1);
  assert.equal((await agent<KnowledgeDetail>(`/entries/${first.id}`)).revision.body, first.revision.body);
  const disabled = await agent<KnowledgeSettings>("/settings"); disabled.config.embedding.mode = "off"; disabled.config.generation.url = ""; disabled.config.generation.model = "";
  await agent("/settings", "PUT", { config: disabled.config });
  assert.equal((await agent<KnowledgeList>("/entries")).total, 1); assert.equal((await agent<KnowledgeIndexStatus>("/index/status")).status, "off");
  const direct = await agent<KnowledgeDetail>("/entries", "POST", knowledgeDraft({ title: "离线直接保存" })); assert.equal(direct.revision.review, "pending");
  assert.equal(calls.length, before);
}));

test("任务候选语义召回无需正式索引，关闭时不调用，短文本按编码配置缓存", async () => knowledgeFixture(async fixture => {
  const settings = await independent(fixture), store = new KnowledgeStore(join(fixture.home, "knowledge", "knowledge.sqlite"));
  const semantic = new KnowledgeSemantic(fixture.home, store, { settings: async () => settings, key: async () => "synthetic-embedding-secret" }, { settings: async () => ({ config: defaultSemanticConfig(), hasKey: false, fingerprint: "synthetic" }), key: async () => undefined });
  try {
    const candidate = knowledgeDraft(), other = knowledgeDraft({ title: "另一种说法", body: "在请求使用时读取当前配置。" });
    assert.equal(await semantic.compareCandidates(candidate, [other], { ...settings.config, embedding: { ...settings.config.embedding, mode: "off" } }), undefined);
    assert.equal(fixture.calls.length, 0);
    const scores = await semantic.compareCandidates(candidate, [other], settings.config); assert.equal(scores?.length, 1); assert.ok(scores![0]! > 0.99);
    assert.equal(fixture.calls.length, 1); assert.equal((await semantic.status()).status, "needs_build");
    await semantic.compareCandidates(candidate, [other], settings.config); assert.equal(fixture.calls.length, 1);
    const changed = structuredClone(settings.config); changed.embedding.connection.model = "synthetic-new-model";
    await semantic.compareCandidates(candidate, [other], changed); assert.equal(fixture.calls.length, 2);
    assert.equal(store.list({ review: "all" }).total, 0);
  } finally { await semantic.close(); store.close(); }
}));

test("后台索引失败保留服务端诊断标识与原始错误，状态读取不丢失翻译依据", async () => knowledgeFixture(async fixture => {
  const { agent } = fixture; await agent("/entries", "POST", knowledgeDraft());
  const settings = await independent(fixture); settings.config.embedding.connection.dimensions = 2; await agent("/settings", "PUT", { config: settings.config });
  const preview = await agent<KnowledgeIndexPreview>("/index/preview", "POST", {}); await agent("/index/build", "POST", { previewId: preview.id });
  let status: KnowledgeIndexStatus | undefined;
  for (let index = 0; index < 100; index++) { status = await agent<KnowledgeIndexStatus>("/index/status"); if (status.status === "failed") break; await delay(20); }
  assert.equal(status?.status, "failed"); assert.equal(status?.errorDescriptor?.key, "sessions.semantic.errors.vector"); assert.ok(status?.error?.length);
}));

test("知识复用会话连接无需先构建会话索引，切模型停止使用旧向量并要求显式重建", async () => knowledgeFixture(async fixture => {
  const { service, agent, calls, modelUrl } = fixture, created = await agent<KnowledgeDetail>("/entries", "POST", knowledgeDraft()); await approve(fixture, created);
  const session = await apiRequest<SemanticSettings>(service.instance, "/semantic/settings");
  Object.assign(session.config.connection, { url: modelUrl, model: "synthetic-shared-model", dimensions: 3 });
  await apiRequest(service.instance, "/semantic/settings", "PUT", { config: session.config, apiKey: "synthetic-shared-secret" });
  const settings = await agent<KnowledgeSettings>("/settings"); settings.config.embedding.mode = "reuse";
  await agent("/settings", "PUT", { config: settings.config }); assert.equal(calls.length, 0);
  assert.equal((await apiRequest<SemanticStatus>(service.instance, "/semantic/status")).ready, false);
  const preview = await agent<KnowledgeIndexPreview>("/index/preview", "POST", {}); await agent("/index/build", "POST", { previewId: preview.id }); await waitIndex(fixture);
  assert.equal(calls[0]?.model, "synthetic-shared-model"); assert.equal(calls[0]?.authorization, "Bearer synthetic-shared-secret");
  assert.equal((await apiRequest<SemanticStatus>(service.instance, "/semantic/status")).ready, false);
  assert.equal((await agent<KnowledgeList>("/search", "POST", { mode: "semantic", q: "配置旧值" })).total, 1);
  session.config.connection.model = "synthetic-new-model"; await apiRequest(service.instance, "/semantic/settings", "PUT", { config: session.config });
  const before = calls.length; assert.equal((await agent<KnowledgeIndexStatus>("/index/status")).status, "needs_build");
  await assert.rejects(agent("/search", "POST", { mode: "semantic", q: "配置旧值" }), requestError("ANALYSIS_NOT_READY")); assert.equal(calls.length, before);
  assert.equal((await agent<KnowledgeList>("/entries?q=配置")).total, 1);
  const next = await agent<KnowledgeIndexPreview>("/index/preview", "POST", {}); await agent("/index/build", "POST", { previewId: next.id }); await waitIndex(fixture);
  assert.equal(calls.at(-1)?.model, "synthetic-new-model");
}));

test("向量命中不能绕过废弃、过期和当前修订；请求期间发生管理修改同样核验", async () => knowledgeFixture(async fixture => {
  const { agent, web, calls } = fixture;
  const first = await agent<KnowledgeDetail>("/entries", "POST", knowledgeDraft()); await approve(fixture, first);
  const second = await agent<KnowledgeDetail>("/entries", "POST", knowledgeDraft({ title: "连接排查", body: "核对端点后限制重试。" })); await approve(fixture, second);
  await independent(fixture);
  let preview = await agent<KnowledgeIndexPreview>("/index/preview", "POST", {}); await agent("/index/build", "POST", { previewId: preview.id }); await waitIndex(fixture);
  const query = () => agent<KnowledgeList>("/search", "POST", { mode: "semantic", q: "可用方法" });
  const expectedCall = calls.length + 1, pending = query(); await waitCalls(fixture, expectedCall);
  await web(`/entries/${first.id}/availability`, { availability: "deprecated" });
  const result = await pending; assert.deepEqual(result.items.map(item => item.id), [second.id]);
  const changed = await agent<KnowledgeDetail>(`/entries/${second.id}/revisions`, "POST", { ...knowledgeDraft({ title: "过期的连接排查", body: "旧环境专用", validUntil: "2000-01-01" }), baseRevisionId: second.latestRevisionId }); await approve(fixture, changed);
  assert.equal((await query()).total, 0);
  assert.equal((await agent<KnowledgeList>("/entries?availability=expired")).items[0]?.revision.id, changed.revision.id);
  await web(`/entries/${first.id}/availability`, { availability: "active" });
  const next = await agent<KnowledgeDetail>(`/entries/${first.id}/revisions`, "POST", { ...knowledgeDraft({ body: "未经编码的新正文" }), baseRevisionId: first.latestRevisionId });
  assert.equal((await query()).items[0]?.revision.id, first.revision.id, "待审不替代发布向量");
  await approve(fixture, next); assert.equal((await query()).total, 0, "旧向量不能冒充新发布修订");
  preview = await agent<KnowledgeIndexPreview>("/index/preview", "POST", {}); await agent("/index/build", "POST", { previewId: preview.id }); await waitIndex(fixture);
  assert.equal((await query()).items[0]?.revision.id, next.revision.id);
}, { delayMs: 80 }));

test("知识编码暂停中断请求，恢复保留已完成向量且不要求重新提交正文", async () => knowledgeFixture(async fixture => {
  const { agent, calls } = fixture;
  for (let index = 0; index < 8; index++) {
    const created = await agent<KnowledgeDetail>("/entries", "POST", knowledgeDraft({ title: `合成方法 ${index}`, body: `第 ${index} 项方法的独立正文。` })); await approve(fixture, created);
  }
  await independent(fixture); const preview = await agent<KnowledgeIndexPreview>("/index/preview", "POST", {});
  await agent("/index/build", "POST", { previewId: preview.id }); await waitCalls(fixture, 1);
  const paused = await agent<KnowledgeIndexStatus>("/index/pause", "POST", {}); assert.equal(paused.status, "paused"); assert.ok(paused.completed < preview.total);
  assert.equal((await agent<KnowledgeList>("/entries")).total, 8);
  await agent("/index/resume", "POST", {}); const ready = await waitIndex(fixture); assert.equal(ready.completed, ready.total);
  assert.equal((await agent<KnowledgeList>("/search", "POST", { mode: "semantic", q: "可复用方法" })).total, 8);
  assert(calls.every(call => call.path.endsWith("/embeddings")));
}, { delayMs: 70 }));

test("同一知识的发布与待审修订都可编码，检索状态和拒绝结果由权威修订决定", async () => knowledgeFixture(async fixture => {
  const { agent, web } = fixture;
  const current = await agent<KnowledgeDetail>("/entries", "POST", knowledgeDraft()); await approve(fixture, current);
  const pending = await agent<KnowledgeDetail>(`/entries/${current.id}/revisions`, "POST", { ...knowledgeDraft({ body: "等待审阅的补充步骤", tags: ["补充"] }), baseRevisionId: current.latestRevisionId });
  await independent(fixture);
  const preview = await agent<KnowledgeIndexPreview>("/index/preview", "POST", {}); assert.equal(preview.reviewed, 1); assert.equal(preview.pending, 1);
  await agent("/index/build", "POST", { previewId: preview.id }); await waitIndex(fixture);
  const search = (review: "pending" | "reviewed" | "all", extra = {}) => agent<KnowledgeList>("/search", "POST", { mode: "semantic", q: "相关方法", review, ...extra });
  assert.equal((await search("reviewed")).items[0]?.revision.id, current.revision.id);
  assert.equal((await search("pending")).items[0]?.revision.id, pending.revision.id);
  assert.equal((await search("all")).total, 1); assert.equal((await search("all")).items[0]?.revision.id, pending.revision.id);
  assert.equal((await search("pending", { project: "/projects/other" })).total, 0);
  assert.equal((await search("pending", { tag: "配置" })).total, 0, "候选不能借用旧版标签满足过滤");
  assert.equal((await search("pending", { tag: "补充", client: "codex" })).total, 1);
  await web(`/entries/${current.id}/reviews`, { revisionId: pending.revision.id, baseRevisionId: pending.revision.id, action: "reject" });
  assert.equal((await search("pending")).total, 0); assert.equal((await search("reviewed")).items[0]?.revision.id, current.revision.id);
}));

test("已编码且已审的知识自然过期后立即退出默认语义结果，历史正文仍可读取", async () => knowledgeFixture(async fixture => {
  const { agent } = fixture, expiry = Date.now() + 1500;
  const created = await agent<KnowledgeDetail>("/entries", "POST", knowledgeDraft({ validUntil: new Date(expiry).toISOString() })); await approve(fixture, created);
  await independent(fixture); const preview = await agent<KnowledgeIndexPreview>("/index/preview", "POST", {});
  await agent("/index/build", "POST", { previewId: preview.id }); await waitIndex(fixture);
  assert.equal((await agent<KnowledgeList>("/search", "POST", { mode: "semantic", q: "配置方法" })).total, 1);
  await delay(Math.max(0, expiry - Date.now()) + 20);
  assert.equal((await agent<KnowledgeList>("/search", "POST", { mode: "semantic", q: "配置方法" })).total, 0);
  assert.equal((await agent<KnowledgeList>("/search", "POST", { mode: "semantic", q: "配置方法", availability: "expired" })).items[0]?.id, created.id);
  assert.equal((await agent<{ body: string }>(`/entries/${created.id}/revisions/${created.revision.id}`)).body, created.revision.body);
}));
