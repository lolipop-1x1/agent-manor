import assert from "node:assert/strict";
import test from "node:test";
import type { KnowledgeDetail, KnowledgeIndexPreview, KnowledgeIndexStatus, KnowledgeList } from "../src/knowledge-contracts.js";
import { apiRequest, delay } from "../src/service/runtime.js";
import { join } from "node:path";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { KnowledgeSemantic } from "../src/knowledge/semantic.js";
import { defaultSemanticConfig } from "../src/semantic/config.js";
import { approve, independent, knowledgeDraft, knowledgeFixture, waitCalls, waitIndex } from "./helpers/knowledge-fixture.js";

test("同一知识预览并发启动只接受一个任务，编码与进度不重复", async () => knowledgeFixture(async fixture => {
  await fixture.agent("/entries", "POST", knowledgeDraft());
  await independent(fixture);
  const preview = await fixture.agent<KnowledgeIndexPreview>("/index/preview", "POST", {});
  const starts = await Promise.allSettled(Array.from({ length: 3 }, () => fixture.agent("/index/build", "POST", { previewId: preview.id })));
  assert.equal(starts.filter(result => result.status === "fulfilled").length, 1);
  const ready = await waitIndex(fixture);
  assert.equal(ready.completed, preview.total);
  assert.equal(ready.total, preview.total);
  assert.equal(fixture.calls.length, preview.total);
}, { delayMs: 90 }));

test("知识索引暂停后的并发恢复与立即暂停不会留下旧执行者", async () => knowledgeFixture(async fixture => {
  for (let index = 0; index < 5; index++) await fixture.agent("/entries", "POST", knowledgeDraft({ title: `独立方法 ${index}` }));
  await independent(fixture);
  const preview = await fixture.agent<KnowledgeIndexPreview>("/index/preview", "POST", {});
  await fixture.agent("/index/build", "POST", { previewId: preview.id });
  await waitCalls(fixture, 1);
  assert.equal((await fixture.agent<KnowledgeIndexStatus>("/index/pause", "POST", {})).status, "paused");
  const resumed = await Promise.allSettled(Array.from({ length: 3 }, () => fixture.agent("/index/resume", "POST", {})));
  assert.equal(resumed.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await fixture.agent<KnowledgeIndexStatus>("/index/pause", "POST", {})).status, "paused");
  const calls = fixture.calls.length;
  await delay(180);
  assert.equal(fixture.calls.length, calls, "暂停返回后旧执行者不再发出新请求");
  assert.equal((await fixture.agent<KnowledgeIndexStatus>("/index/status")).status, "paused");
  await fixture.agent("/index/resume", "POST", {});
  const ready = await waitIndex(fixture);
  assert.equal(ready.completed, ready.total);
}, { delayMs: 90 }));

test("知识维护复用未变修订，新增内容自动编码且不阻塞其他 API", async () => knowledgeFixture(async fixture => {
  const first = await fixture.agent<KnowledgeDetail>("/entries", "POST", knowledgeDraft());
  await approve(fixture, first);
  await independent(fixture);
  const preview = await fixture.agent<KnowledgeIndexPreview>("/index/preview", "POST", {});
  await fixture.agent("/index/build", "POST", { previewId: preview.id });
  await waitIndex(fixture);
  const calls = fixture.calls.length;
  await delay(5100);
  assert.equal(fixture.calls.length, calls, "无变化维护不产生编码调用");
  const created = await fixture.agent<KnowledgeDetail>("/entries", "POST", knowledgeDraft({ title: "新增独立知识", body: "仅针对新增修订维护向量。" }));
  await approve(fixture, created);
  for (let attempt = 0; attempt < 140 && fixture.calls.length === calls; attempt++) {
    await apiRequest(fixture.service.instance, "/status?response=summary");
    await delay(50);
  }
  assert.equal(fixture.calls.length, calls + 1);
  const ready = await waitIndex(fixture);
  assert.equal(ready.completed, ready.total);
  const result = await fixture.agent<KnowledgeList>("/search", "POST", { mode: "semantic", q: "独立知识" });
  assert.deepEqual(new Set(result.items.map(entry => entry.id)), new Set([first.id, created.id]));
}));

test("已构建知识索引重启后自动补齐停机期间新增修订", async () => knowledgeFixture(async fixture => {
  await fixture.agent("/entries", "POST", knowledgeDraft());
  const settings = await independent(fixture);
  const preview = await fixture.agent<KnowledgeIndexPreview>("/index/preview", "POST", {});
  await fixture.agent("/index/build", "POST", { previewId: preview.id });
  await waitIndex(fixture);
  await fixture.service.close();
  const store = new KnowledgeStore(join(fixture.home, "knowledge", "knowledge.sqlite"));
  const created = store.create(knowledgeDraft({ title: "停机期间的新知识" }));
  const calls = fixture.calls.length;
  const semantic = new KnowledgeSemantic(fixture.home, store, { settings: async () => settings, key: async () => "synthetic-embedding-secret" },
    { settings: async () => ({ config: defaultSemanticConfig(), hasKey: false, fingerprint: "synthetic" }), key: async () => undefined });
  try {
    for (let attempt = 0; attempt < 140 && fixture.calls.length === calls; attempt++) await delay(50);
    assert.equal(fixture.calls.length, calls + 1);
    for (let attempt = 0; attempt < 100 && (await semantic.status()).status !== "ready"; attempt++) await delay(20);
    const found = await semantic.search({ q: "新增知识", review: "pending" });
    assert.ok(found.items.some(entry => entry.id === created.id));
  } finally { await semantic.close(); store.close(); }
}));
