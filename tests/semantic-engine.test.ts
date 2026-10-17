import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { SessionMessage, SessionSourceMeta } from "../src/session-contracts.js";
import type { SemanticConfig } from "../src/semantic-contracts.js";
import { AnalysisStore } from "../src/index/store.js";
import { SessionStore } from "../src/sessions/store.js";
import { defaultSemanticConfig, encodingFingerprint } from "../src/semantic/config.js";
import { buildDocuments } from "../src/semantic/documents.js";
import { estimateEmbeddingTokens } from "../src/semantic/scheduler.js";
import { SemanticEngine } from "../src/semantic/engine.js";

function config(): SemanticConfig {
  const value = defaultSemanticConfig();
  value.enabled = true; value.connection.url = "http://example.invalid/v1"; value.connection.model = "synthetic"; value.connection.dimensions = 2;
  value.scope.timeRange = "all"; value.scope.relationship = "all"; value.scope.executionMode = "all";
  return value;
}
function meta(id: string, extra: Partial<SessionSourceMeta> = {}): SessionSourceMeta {
  return { id, client: "codex", clientSessionId: id, title: `人工合成 ${id}`, titleOrigin: "recorded", path: `/workspace/history/${id}.jsonl`, sourceId: id,
    messageCount: 2, turnCount: 1, models: ["synthetic"], gaps: [], startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", ...extra };
}
function message(sessionId: string, ordinal: number, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { id: `${sessionId}-${ordinal}`, sessionId, ordinal, recordLine: ordinal + 1, turnId: "turn-1", kind: ordinal === 1 ? "user" : "assistant", text: ordinal === 1 ? "如何找到历史会话？" : "按内容搜索。", ...extra };
}
function source(store: SessionStore, summary: SessionSourceMeta, records?: SessionMessage[]) {
  const pending = store.createRevision(summary.path, Math.random().toString());
  for (const record of records ?? [message(summary.id, 1), message(summary.id, 2)]) pending.sink.message(record);
  pending.flush(); store.finishRevision(pending.revision, summary);
  return { path: summary.path, revision: pending.revision, fingerprint: "synthetic" };
}
async function fixture(run: (store: SessionStore, engine: SemanticEngine, reopen: () => SemanticEngine, semanticPath: string) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "manor-semantic-engine-")), path = join(directory, "index.sqlite"), semantic = join(directory, "semantic", "vectors.sqlite");
  const index = new AnalysisStore(path); index.close();
  const store = new SessionStore(path); let engine = new SemanticEngine(path, semantic);
  try { run(store, engine, () => { engine.close(); engine = new SemanticEngine(path, semantic); return engine; }, semantic); }
  finally { engine.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
}
function complete(engine: SemanticEngine, id: string): void {
  let batch = engine.batch(id, 8, 8192);
  while (batch.length) { engine.saveVectors(id, batch.map(input => ({ key: input.key, values: [1, 0] }))); batch = engine.batch(id, 8, 8192); }
  engine.publish(id);
}

test("缺少分支目录时仍按消息当前分支过滤，旧位置无需重新编码", async () => fixture((store, engine, reopen, semanticPath) => {
  const records = [message("branch-flags", 1, { text: "当前分支正文", currentBranch: true }), message("branch-flags", 2, { text: "旁支正文", currentBranch: false })];
  store.publish(store.createJob().id, [source(store, meta("branch-flags"), records)], []);
  const settings = config(), fingerprint = encodingFingerprint(settings);
  const docs = [...buildDocuments(records, meta("branch-flags"), settings, fingerprint)];
  assert.equal(docs.length, 2, "同轮但当前分支标记不同的消息不能拼接");
  complete(engine, engine.preview(settings).id);
  const query = { q: "内容", scope: { ...settings.scope, branch: "current" as const } };
  assert.deepEqual(engine.search([1, 0], query, fingerprint).groups[0]?.hits.map(hit => hit.messageId), ["branch-flags-1"]);
  const db = new Database(semanticPath); db.prepare("UPDATE semantic_positions SET json=json_remove(json,'$.currentBranch')").run(); db.close();
  const restored = reopen();
  assert.deepEqual(restored.search([1, 0], query, fingerprint).groups[0]?.hits.map(hit => hit.messageId), ["branch-flags-1"]);
  assert.equal(restored.search([1, 0], { ...query, scope: settings.scope }, fingerprint).groups[0]?.hits.length, 2);
  assert.equal(restored.preview(settings).pendingInputs, 0);
}));

test("历史尚未首次发布时状态与筛选候选可读取", async () => fixture((_store, engine) => {
  assert.equal(engine.stats(encodingFingerprint(config())).ready, false);
  assert.deepEqual(engine.facets(), { clients: [], projects: [], models: [] });
  assert.throws(() => engine.preview(config()), { code: "NOT_READY" });
}));

test("完整输入去重保留独立来源，计划可恢复且完成前不可搜索", async () => fixture((store, initial, reopen) => {
  const first = source(store, meta("first"));
  const copy = source(store, meta("copy", { client: "claude", project: "/workspace/project-b" }), [message("copy", 1, { copied: true }), message("copy", 2, { copied: true })]);
  store.publish(store.createJob().id, [first, copy], []);
  const settings = config(), fingerprint = encodingFingerprint(settings), preview = initial.preview(settings);
  assert.equal(preview.sessionCount, 2); assert.equal(preview.positionCount, 2); assert.equal(preview.uniqueInputs, 1); assert.equal(preview.pendingInputs, 1);
  assert.equal(initial.stats(fingerprint).ready, false);
  assert.throws(() => initial.publish(preview.id), { code: "NOT_READY" });
  const batch = initial.batch(preview.id, 8, 8192); assert.equal(batch.length, 1);
  initial.saveVectors(preview.id, batch.map(input => ({ key: input.key, values: [1, 0] })));
  const engine = reopen();
  assert.deepEqual(engine.progress(preview.id), { totalInputs: 1, completedInputs: 1, reusedInputs: 0 });
  assert.equal(engine.batch(preview.id, 8, 8192).length, 0);
  engine.publish(preview.id);
  const results = engine.search([1, 0], { q: "历史", scope: settings.scope }, fingerprint);
  assert.equal(results.groups.length, 2); assert.equal(results.total, 2); assert.equal(results.coveredSessions, 2);
  assert.notEqual(results.groups[0]!.hits[0]!.messageId, results.groups[1]!.hits[0]!.messageId);
  const narrowed = engine.search([1, 0], { q: "历史", scope: { ...settings.scope, clients: ["claude"], projects: ["/workspace/project-b"] } }, fingerprint);
  assert.deepEqual(narrowed.groups.map(group => group.session.id), ["copy"]);
  assert.deepEqual(engine.facets(), { clients: ["claude", "codex"], projects: ["/workspace/project-b"], models: ["synthetic"] });
  const next = engine.preview(settings); assert.equal(next.pendingInputs, 0); assert.equal(next.reusedInputs, 1); engine.publish(next.id);
  assert.equal(engine.stats(fingerprint).uniqueVectors, 1);
}));

test("缩小维护范围保留有效覆盖，来源变更或删除立即排除旧位置", async () => fixture((store, engine) => {
  const first = source(store, meta("first", { project: "/workspace/a" })), second = source(store, meta("second", { project: "/workspace/b" }));
  store.publish(store.createJob().id, [first, second], []);
  const settings = config(), fingerprint = encodingFingerprint(settings);
  complete(engine, engine.preview(settings).id);
  settings.scope.projects = ["/workspace/a"];
  complete(engine, engine.preview(settings).id);
  assert.equal(engine.stats(fingerprint).indexedSessions, 2);
  const changed = source(store, meta("first", { project: "/workspace/a" }), [message("first", 1, { text: "正文已变化" })]);
  store.publish(store.createJob().id, [changed, second], []);
  assert.equal(engine.stats(fingerprint).indexedSessions, 1);
  assert.deepEqual(engine.search([1, 0], { q: "内容", scope: { ...settings.scope, projects: [] } }, fingerprint).groups.map(group => group.session.id), ["second"]);
  store.publish(store.createJob().id, [changed], []);
  assert.equal(engine.search([1, 0], { q: "内容", scope: { ...settings.scope, projects: [] } }, fingerprint).groups.length, 0);
  complete(engine, engine.preview(settings).id);
  assert.equal(engine.stats(fingerprint).indexedSessions, 1);
}));

test("清理窗口外位置不破坏窗口内共享向量，不兼容模型不可混用", async () => fixture((store, engine) => {
  const first = source(store, meta("old")), second = source(store, meta("new", { startedAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-02T00:00:00Z" }));
  store.publish(store.createJob().id, [first, second], []);
  const settings = config(), fingerprint = encodingFingerprint(settings);
  complete(engine, engine.preview(settings).id);
  settings.scope.from = "2026-02-01T00:00:00Z";
  complete(engine, engine.preview(settings).id);
  assert.equal(engine.stats(fingerprint).indexedPositions, 2);
  settings.strategy.cleanOutsideWindow = true;
  complete(engine, engine.preview(settings).id);
  assert.equal(engine.stats(fingerprint).indexedPositions, 1); assert.equal(engine.stats(fingerprint).uniqueVectors, 1);
  settings.connection.model = "another";
  assert.equal(engine.stats(encodingFingerprint(settings)).ready, false);
  const next = engine.preview(settings);
  assert.equal(next.pendingInputs, 1);
  assert.throws(() => engine.saveVectors(next.id, [{ key: engine.batch(next.id, 1, 8192)[0]!.key, values: [1, 0, 0] }]), { code: "INDEX_CHANGED" });
  engine.clear(); assert.equal(engine.stats(fingerprint).ready, false);
}));

test("预览历史版本变化时拒绝发布，已保存编码可在新计划复用", async () => fixture((store, engine) => {
  const first = source(store, meta("first")); store.publish(store.createJob().id, [first], []);
  const settings = config(), preview = engine.preview(settings), batch = engine.batch(preview.id, 8, 8192);
  engine.saveVectors(preview.id, batch.map(input => ({ key: input.key, values: [1, 0] })));
  const second = source(store, meta("second"));
  store.publish(store.createJob().id, [first, second], []);
  assert.throws(() => engine.publish(preview.id), { code: "PREVIEW_STALE" });
  const next = engine.preview(settings); assert.equal(next.pendingInputs, 0); complete(engine, next.id);
}));

test("输入过长只拆当前计划，副本共用小块且重启后定位与进度正确", async () => fixture((store, initial, reopen) => {
  const records = (id: string) => [message(id, 1, { text: "问题".repeat(90) }), message(id, 2, { text: "回答".repeat(120) })];
  const first = source(store, meta("first"), records("first"));
  const copy = source(store, meta("copy"), records("copy").map(record => ({ ...record, copied: true })));
  store.publish(store.createJob().id, [first, copy], []);
  const settings = config(); settings.connection.documentPrefix = "document: ";
  const fingerprint = encodingFingerprint(settings), preview = initial.preview(settings);
  const original = initial.batch(preview.id, 8, 8192); assert.equal(original.length, 1);
  assert.equal(initial.splitInput(preview.id, original[0]!.key), true);
  assert.deepEqual(initial.progress(preview.id), { totalInputs: 2, completedInputs: 0, reusedInputs: 0 });
  const engine = reopen(), batch = engine.batch(preview.id, 8, 8192);
  assert.equal(batch.length, 2);
  assert.ok(batch.every(input => input.text.startsWith("document: ") && input.text.length < original[0]!.text.length));
  complete(engine, preview.id);
  const results = engine.search([1, 0], { q: "内容", scope: settings.scope }, fingerprint);
  assert.equal(results.groups.length, 2); assert.equal(engine.stats(fingerprint).uniqueVectors, 2);
  assert.ok(results.groups.every(group => group.hits.some(hit => hit.messageId === `${group.session.id}-2`)));
  assert.equal(engine.splitInput(preview.id, batch[0]!.key), false);
  const next = engine.preview(settings);
  assert.equal(next.uniqueInputs, 2); assert.equal(next.pendingInputs, 0); assert.equal(next.reusedInputs, 2);
}));

test("替换预览淘汰旧计划而保留已完成向量，最小输入不再细分", async () => fixture((store, engine) => {
  const first = source(store, meta("first")); store.publish(store.createJob().id, [first], []);
  const settings = config(), previous = engine.preview(settings), batch = engine.batch(previous.id, 8, 8192);
  assert.equal(engine.splitInput(previous.id, batch[0]!.key), false);
  engine.saveVectors(previous.id, batch.map(input => ({ key: input.key, values: [1, 0] })));
  const next = engine.preview(settings);
  assert.equal(next.pendingInputs, 0); assert.equal(next.reusedInputs, 1);
  assert.throws(() => engine.progress(previous.id), { code: "PREVIEW_STALE" });
  complete(engine, next.id);
}));

test("批次预算包含首项，自动拆分大输入且无法满足的最小输入明确失败", async () => fixture((store, engine) => {
  const first = source(store, meta("first"), [message("first", 1, { text: "文本".repeat(300) })]); store.publish(store.createJob().id, [first], []);
  const preview = engine.preview(config());
  let batch = engine.batch(preview.id, 8, 120);
  assert.ok(batch.reduce((total, input) => total + input.estimatedTokens, 0) <= 120);
  while (batch.length) {
    engine.saveVectors(preview.id, batch.map(input => ({ key: input.key, values: [1, 0] })));
    batch = engine.batch(preview.id, 8, 120);
    assert.ok(batch.reduce((total, input) => total + input.estimatedTokens, 0) <= 120);
  }
  assert.ok(engine.progress(preview.id).totalInputs > 1); engine.publish(preview.id);
  const next = config(); next.connection.model = "another";
  assert.throws(() => engine.batch(engine.preview(next).id, 8, 1), { code: "INVALID_INPUT" });
}));

test("范围筛选先于候选截断，相关性与时间排序共用候选上限", async () => fixture((store, engine) => {
  const sources = Array.from({ length: 205 }, (_, index) => source(store, meta(`common-${index}`)));
  sources.push(source(store, meta("target", { client: "claude", title: "唯一目标", executionMode: "quiet", relationship: "child", models: ["target-model"] }), [message("target", 1, { text: "目标独有正文" })]));
  store.publish(store.createJob().id, sources, []);
  const settings = config(), fingerprint = encodingFingerprint(settings); complete(engine, engine.preview(settings).id);
  const all = engine.search([1, 0], { q: "目标", scope: settings.scope, pageSize: 100 }, fingerprint);
  assert.equal(all.total, 200); assert.equal(all.limited, true); assert.equal(all.coveredSessions, 206);
  assert.equal(engine.search([1, 0], { q: "目标", scope: settings.scope, pageSize: 200 }, fingerprint).groups.length, 200);
  const scope = { ...settings.scope, clients: ["claude" as const], relationship: "children" as const, executionMode: "quiet" as const, models: ["target-model"], title: "目标", minMessages: 1 };
  assert.deepEqual(engine.search([1, 0], { q: "目标", scope, sort: "updated" }, fingerprint).groups.map(group => group.session.id), ["target"]);
}));

test("轮次和分支不混合，过滤注入与思考，Unicode切块保留空白和代码", () => {
  const settings = config(); settings.strategy.chunkChars = 128; settings.strategy.overlapChars = 12;
  const summary = meta("tree", { branches: [{ id: "a", label: "a", current: true }, { id: "b", label: "b", current: false }] });
  const records = [message("tree", 1, { text: "共同提问" }), message("tree", 2, { text: "A分支回复", branchIds: ["a"] }),
    message("tree", 3, { text: "B分支回复", branchIds: ["b"] }), message("tree", 4, { text: "不能入索引", contextSource: "environment" }),
    message("tree", 5, { text: "不能入索引", kind: "thinking" }), message("tree", 6, { text: "🙂".repeat(300) + "\n```\n  preserve  spaces\n```", turnId: "turn-2", branchIds: ["a"] })];
  const documents = [...buildDocuments(records, summary, settings, encodingFingerprint(settings))];
  assert.ok(documents.length > 3);
  assert.ok(documents.every(document => !document.text.includes("不能入索引")));
  assert.ok(documents.every(document => !(document.text.includes("A分支回复") && document.text.includes("B分支回复"))));
  assert.ok(documents.every(document => !document.text.includes("\uFFFD")));
  assert.ok(documents.some(document => document.text.includes("  preserve  spaces")));
  assert.ok(documents.every(document => Array.from(document.text).length <= 128));
});

test("无项目哨兵同时匹配 NULL 和空项目，混合项目按或筛选", async () => fixture((store, engine) => {
  const none = source(store, meta("none")), project = source(store, meta("project", { project: "/workspace/a" }));
  store.publish(store.createJob().id, [none, project], []);
  const settings = config(), fingerprint = encodingFingerprint(settings);
  assert.equal(engine.preview({ ...settings, scope: { ...settings.scope, projects: ["none"] } }).sessionCount, 1);
  complete(engine, engine.preview(settings).id);
  for (const sentinel of ["none", ""]) assert.deepEqual(engine.search([1, 0], { q: "内容", scope: { ...settings.scope, projects: [sentinel] } }, fingerprint).groups.map(group => group.session.id), ["none"]);
  assert.equal(engine.search([1, 0], { q: "内容", scope: { ...settings.scope, projects: ["none", "/workspace/a"] } }, fingerprint).total, 2);
}));

test("追加新轮次保留未变片段并更新原文定位，编辑和删除引用消息立即失效", async () => fixture((store, engine) => {
  const first = source(store, meta("first")); store.publish(store.createJob().id, [first], []);
  const settings = config(), fingerprint = encodingFingerprint(settings); complete(engine, engine.preview(settings).id);
  const original = [message("first", 1, { turnId: "turn-77" }), message("first", 2, { turnId: "turn-77" })];
  const appended = source(store, meta("first", { messageCount: 3, turnCount: 2 }), [...original, message("first", 3, { kind: "user", text: "新增的下一轮", turnId: "turn-78" })]);
  store.publish(store.createJob().id, [appended], []);
  assert.equal(engine.stats(fingerprint).indexedPositions, 1);
  const kept = engine.search([1, 0], { q: "内容", scope: settings.scope }, fingerprint);
  assert.equal(kept.version, store.currentVersion()); assert.equal(kept.total, 1); assert.equal(kept.groups[0]!.hits[0]!.turnId, "turn-77");
  const edited = source(store, meta("first"), [original[0]!, { ...original[1]!, text: "修改了原来回答" }]);
  store.publish(store.createJob().id, [edited], []);
  assert.equal(engine.stats(fingerprint).indexedPositions, 0); assert.equal(engine.search([1, 0], { q: "内容", scope: settings.scope }, fingerprint).total, 0);
  complete(engine, engine.preview(settings).id);
  const deleted = source(store, meta("first"), [original[0]!]); store.publish(store.createJob().id, [deleted], []);
  assert.equal(engine.stats(fingerprint).indexedPositions, 0);
}));

test("正文相同但消息移出原分支时只撤销该分支位置", async () => fixture((store, engine) => {
  const summary = meta("tree", { branches: [{ id: "a", label: "A", current: true }, { id: "b", label: "B", current: false }] });
  const records = [message("tree", 1, { text: "共同提问" }), message("tree", 2, { text: "分支 A 回复", branchIds: ["a"] }), message("tree", 3, { text: "分支 B 回复", branchIds: ["b"] })];
  const first = source(store, summary, records); store.publish(store.createJob().id, [first], []);
  const settings = config(), fingerprint = encodingFingerprint(settings); complete(engine, engine.preview(settings).id);
  assert.equal(engine.stats(fingerprint).indexedPositions, 2);
  const moved = source(store, summary, records.map(record => record.id === "tree-2" ? { ...record, branchIds: ["b"] } : record));
  store.publish(store.createJob().id, [moved], []);
  assert.equal(engine.stats(fingerprint).indexedPositions, 1);
  const current = engine.search([1, 0], { q: "内容", scope: { ...settings.scope, branch: "current" } }, fingerprint); assert.equal(current.total, 0);
}));


test("构建预览、批次和模型预留共用完整输入估算", async () => fixture((store, engine) => {
  const first = source(store, meta("tokens"), [message("tokens", 1, { text: "a".repeat(700) + "汉字".repeat(100) })]); store.publish(store.createJob().id, [first], []);
  const settings = config(); settings.strategy.pricePerMillion = 1; settings.connection.documentPrefix = "prefix: ";
  const preview = engine.preview(settings), batch = engine.batch(preview.id, 8, 8192);
  const estimate = estimateEmbeddingTokens(batch.map(input => input.text));
  assert.equal(preview.estimatedTokens, estimate); assert.equal(batch.reduce((total, input) => total + input.estimatedTokens, 0), estimate);
  assert.equal(preview.estimatedCost, estimate / 1_000_000);
}));

test("同轮消息重编号可保留，轮次拆分、归属未知或相对顺序反转立即撤销", async () => {
  for (const change of ["split", "unknown", "reverse"] as const) await fixture((store, engine) => {
    const original = [message("first", 1), message("first", 2)];
    const first = source(store, meta("first"), original); store.publish(store.createJob().id, [first], []);
    const settings = config(), fingerprint = encodingFingerprint(settings); complete(engine, engine.preview(settings).id);
    let records = original.map(record => ({ ...record, turnId: "turn-77" }));
    const renumbered = source(store, meta("first"), records); store.publish(store.createJob().id, [renumbered], []);
    assert.equal(engine.stats(fingerprint).indexedPositions, 1);
    if (change === "split") records = records.map((record, index) => ({ ...record, turnId: index ? "turn-78" : "turn-77" }));
    else if (change === "unknown") records = records.map(record => ({ ...record, turnId: "unknown" }));
    else records = records.map((record, index) => ({ ...record, ordinal: 2 - index }));
    const changed = source(store, meta("first"), records); store.publish(store.createJob().id, [changed], []);
    assert.equal(engine.stats(fingerprint).indexedPositions, 0, change);
    assert.equal(engine.search([1, 0], { q: "内容", scope: settings.scope }, fingerprint).total, 0, change);
  });
});
