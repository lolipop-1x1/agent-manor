import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { KnowledgeConfig, KnowledgeDetail, KnowledgeList, KnowledgePreview, KnowledgeRevision, KnowledgeSettings } from "../src/knowledge-contracts.js";
import { approve, knowledgeDraft, knowledgeFixture, requestError } from "./helpers/knowledge-fixture.js";

test("HTTP 直接写入保持待审；Agent 实例不能发布或废弃，同源页面明确确认才发布", async () => knowledgeFixture(async fixture => {
  const { agent, web, service, calls } = fixture;
  const created = await agent<KnowledgeDetail>("/entries", "POST", { ...knowledgeDraft(), idempotencyKey: "synthetic-create-key" });
  assert.equal(created.revision.review, "pending"); assert.equal((await agent<KnowledgeList>("/entries")).total, 0);
  await assert.rejects(agent(`/entries/${created.id}`), requestError("SOURCE_NOT_FOUND"));
  await assert.rejects(agent(`/entries/${created.id}/reviews`, "POST", { revisionId: created.revision.id, action: "approve" }), requestError("FORBIDDEN"));
  await assert.rejects(agent(`/entries/${created.id}/availability`, "POST", { availability: "deprecated" }), requestError("FORBIDDEN"));
  const spoofed = await service.app.inject({ method: "POST", url: `/api/v1/knowledge/entries/${created.id}/reviews`, headers: { host: `127.0.0.1:${service.instance.port}`, "x-agent-manor-instance": service.instance.id, "sec-fetch-site": "same-origin" }, payload: { revisionId: created.revision.id, action: "approve" } });
  assert.equal(spoofed.statusCode, 403);
  const unconfirmed = await fetch(`http://127.0.0.1:${service.instance.port}/api/v1/knowledge/entries/${created.id}/reviews`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revisionId: created.revision.id, action: "approve" }) });
  assert.equal(unconfirmed.status, 403); await unconfirmed.json();
  const published = await approve(fixture, created); assert.equal(published.revision.review, "reviewed");
  assert.equal((await agent<KnowledgeList>("/entries")).items[0]?.revision.id, created.revision.id);
  const revised = await agent<KnowledgeDetail>(`/entries/${created.id}/revisions`, "POST", { ...knowledgeDraft({ body: "新的待审修改" }), baseRevisionId: created.latestRevisionId, idempotencyKey: "synthetic-revision-key" });
  const current = await agent<KnowledgeDetail>(`/entries/${created.id}`);
  assert.equal(current.revision.body, created.revision.body); assert.equal(current.pendingRevision, undefined); assert.equal(current.revisions.length, 1);
  assert.equal((await agent<KnowledgeList>("/entries?review=pending")).items[0]?.revision.id, revised.revision.id);
  const all = await agent<KnowledgeDetail>(`/entries/${created.id}?review=all&availability=all`); assert.equal(all.revisions.length, 2);
  await assert.rejects(agent(`/entries/${created.id}/revisions`, "POST", { ...knowledgeDraft({ body: "过时提交" }), baseRevisionId: created.latestRevisionId }), requestError("CONTENT_STALE"));
  await assert.rejects(web(`/entries/${created.id}/reviews`, { revisionId: created.revision.id, action: "approve" }), requestError("CONTENT_STALE"));
  const retry = await agent<KnowledgeDetail>(`/entries/${created.id}/revisions`, "POST", { ...knowledgeDraft({ body: "新的待审修改" }), baseRevisionId: created.latestRevisionId, idempotencyKey: "synthetic-revision-key" });
  assert.equal(retry.revision.id, revised.revision.id);
  await assert.rejects(agent("/entries", "POST", { ...knowledgeDraft({ body: "不同载荷" }), idempotencyKey: "synthetic-create-key" }), requestError("CONTENT_STALE"));
  await assert.rejects(agent(`/entries/${created.id}/revisions`, "POST", { ...knowledgeDraft({ body: "不同修订载荷" }), baseRevisionId: created.latestRevisionId, idempotencyKey: "synthetic-revision-key" }), requestError("CONTENT_STALE"));
  await approve(fixture, revised); assert.equal((await agent<KnowledgeDetail>(`/entries/${created.id}`)).revision.body, "新的待审修改");
  assert.equal(calls.length, 0, "直接保存、审阅、搜索、读取均无需模型");
}));

test("HTTP 废弃、恢复、过期和历史闭环：恢复重新待审，发布不会自动启用废弃知识", async () => knowledgeFixture(async fixture => {
  const { agent, web, calls } = fixture, created = await agent<KnowledgeDetail>("/entries", "POST", knowledgeDraft()); await approve(fixture, created);
  const next = await agent<KnowledgeDetail>(`/entries/${created.id}/revisions`, "POST", { ...knowledgeDraft({ body: "第二版正文" }), baseRevisionId: created.latestRevisionId }); await approve(fixture, next);
  await web(`/entries/${created.id}/availability`, { availability: "deprecated", reason: "合成环境已更改" });
  assert.equal((await agent<KnowledgeList>("/entries")).total, 0);
  assert.equal((await agent<KnowledgeList>("/entries?availability=deprecated")).total, 1);
  const restored = await agent<KnowledgeDetail>(`/entries/${created.id}/restore`, "POST", { revisionId: created.revision.id, baseRevisionId: next.revision.id, idempotencyKey: "synthetic-restore" });
  assert.equal(restored.revision.review, "pending"); assert.equal(restored.revision.version, 3); assert.equal(restored.revision.body, created.revision.body); assert.equal(restored.availability, "deprecated");
  await approve(fixture, restored); assert.equal((await agent<KnowledgeList>("/entries")).total, 0);
  await web(`/entries/${created.id}/availability`, { availability: "active" }); assert.equal((await agent<KnowledgeList>("/entries")).total, 1);
  const historical = await agent<KnowledgeRevision>(`/entries/${created.id}/revisions/${next.revision.id}`); assert.equal(historical.body, "第二版正文");
  const history = await agent<{ revisions: KnowledgeRevision[] }>(`/entries/${created.id}/revisions`); assert.deepEqual(history.revisions.map(item => item.version), [3, 2, 1]);
  const expired = await agent<KnowledgeDetail>("/entries", "POST", knowledgeDraft({ title: "旧环境知识", validUntil: "2000-01-01" })); await approve(fixture, expired);
  assert.equal((await agent<KnowledgeList>("/entries?availability=expired")).items[0]?.id, expired.id);
  await assert.rejects(agent(`/entries/${expired.id}`), requestError("SOURCE_NOT_FOUND"));
  assert.equal((await agent<KnowledgeRevision>(`/entries/${expired.id}/revisions/${expired.revision.id}`)).body, expired.revision.body);
  assert.equal(calls.length, 0);
}));

test("HTTP 设置脱敏、独立输出语言、默认与空范围校验，保存设置不调用模型", async () => knowledgeFixture(async ({ agent, calls, home, modelUrl }) => {
  const defaults = await agent<{ config: KnowledgeConfig }>("/settings/defaults?language=en");
  assert.equal(defaults.config.outputLanguage, "en"); assert.equal(defaults.config.automatic.enabled, false); assert.equal(defaults.config.embedding.mode, "off");
  const initial = await agent<KnowledgeSettings>("/settings?language=en"); assert.equal(initial.config.outputLanguage, "en");
  initial.config.generation.url = modelUrl; initial.config.generation.model = "synthetic-small-model";
  const saved = await agent<KnowledgeSettings>("/settings", "PUT", { config: initial.config, generationKey: "synthetic-generation-secret", embeddingKey: "synthetic-embedding-secret" });
  assert(saved.hasGenerationKey && saved.hasEmbeddingKey); assert(!JSON.stringify(saved).includes("synthetic-generation-secret")); assert(!JSON.stringify(saved).includes("synthetic-embedding-secret"));
  assert.equal((await agent<KnowledgeSettings>("/settings?language=zh-CN")).config.outputLanguage, "en");
  assert.equal((await stat(join(home, "knowledge", "credentials.json"))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(home, "knowledge", "config.json"), "utf8")).includes("synthetic-generation-secret"), false);
  assert.equal(calls.length, 0);
  await assert.rejects(agent("/extractions/preview", "POST", {}), requestError("INVALID_INPUT"));
  await assert.rejects(agent("/extractions/preview", "POST", { scope: {} }), requestError("INVALID_INPUT"));
  const empty = await agent<KnowledgePreview>("/extractions/preview", "POST", { scope: { ...saved.config.automatic.scope, timeRange: "all", sessionIds: ["synthetic-missing-session"] } });
  assert.equal(empty.sessionCount, 0); assert.equal(empty.pendingMessages, 0);
  await assert.rejects(agent("/entries?page=0"), requestError("INVALID_INPUT"));
  await assert.rejects(agent("/entries?review=unknown"), requestError("INVALID_INPUT"));
  await assert.rejects(agent("/search", "POST", { mode: "invented", q: "配置" }), requestError("INVALID_INPUT"));
  await assert.rejects(agent("/entries", "POST", { ...knowledgeDraft(), review: "reviewed" }), requestError("INVALID_INPUT"));
  assert.equal(calls.length, 0);
}));

test("已保存知识凭据只能由同源管理页面按需查看，普通设置继续脱敏且响应不可缓存", async () => knowledgeFixture(async ({ agent, web, service, modelUrl }) => {
  const initial = await agent<KnowledgeSettings>("/settings"); initial.config.generation.url = modelUrl; initial.config.generation.model = "synthetic-model";
  await agent("/settings", "PUT", { config: initial.config, generationKey: "synthetic-visible-key", embeddingKey: "synthetic-vector-key" });
  await assert.rejects(agent("/settings/key", "POST", { kind: "generation" }), requestError("FORBIDDEN"));
  const value = await web<{ key: string }>("/settings/key", { kind: "generation" }); assert.equal(value.key, "synthetic-visible-key");
  assert.equal((await web<{ key: string }>("/settings/key", { kind: "embedding" })).key, "synthetic-vector-key");
  await assert.rejects(web("/settings/key", { kind: "unknown" }), requestError("INVALID_INPUT"));
  const response = await service.app.inject({ method: "POST", url: "/api/v1/knowledge/settings/key", headers: { host: `127.0.0.1:${service.instance.port}`, "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${service.instance.port}` }, payload: { kind: "generation" } });
  assert.equal(response.statusCode, 200); assert.equal(response.headers["cache-control"], "no-store");
  const settings = await agent<KnowledgeSettings>("/settings"); assert.equal(JSON.stringify(settings).includes("synthetic-visible-key"), false);
}));
