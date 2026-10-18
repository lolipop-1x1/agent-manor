import { test } from "node:test";
import assert from "node:assert/strict";
import type { KnowledgeDetail, KnowledgeSource } from "../src/knowledge-contracts.js";
import { knowledgeTypes } from "../src/knowledge-contracts.js";
import { i18n, translate, translateMessageOrOriginal } from "../src/i18n/index.js";
import { editableDraft, emptyDraft, knowledgeCollectionAddress, knowledgeCollectionQuery, knowledgeListWidth, knowledgeNavigationWidth, knowledgeSourceGroups, knowledgeTypeKey, readKnowledgeAddress, restoreKnowledgeFocus, sourceAddress } from "../web/features/knowledge/knowledge-model.js";
import { knowledgeLimitations } from "../src/knowledge/diagnostics.js";

test("来源回查只允许已核验消息，并保留消息、轮次、分支和当前可用版本", () => {
  const source: KnowledgeSource = { kind: "extraction", sessionId: "codex:example&session", messageId: "message/1", turnPosition: 8, branch: "branch/a", sourceVersion: "old", currentVersion: "current", status: "available" };
  const address = new URL(sourceAddress(source)!, "https://example.invalid");
  const params = new URLSearchParams(address.hash.split("?")[1]);
  assert.equal(params.get("id"), source.sessionId); assert.equal(params.get("version"), "current"); assert.equal(params.get("message"), "message/1"); assert.equal(params.get("turn"), "8"); assert.equal(params.get("branch"), "branch/a");
  assert.equal(sourceAddress({ ...source, status: "changed" }), undefined); assert.equal(sourceAddress({ ...source, status: "missing" }), undefined); assert.equal(sourceAddress({ ...source, status: undefined }), undefined);
});

test("会话沉淀链接保留轮次边界，非法位置不会变成有效范围", () => {
  const result = readKnowledgeAddress("#knowledge?page=tasks&sessionId=codex%3Asynthetic&turnStart=2&turnEnd=4&branch=branch%2Fa");
  assert.equal(result.page, "new"); assert.deepEqual(result.scope?.sessionIds, ["codex:synthetic"]); assert.equal(result.scope?.turnStart, 2); assert.equal(result.scope?.turnEnd, 4); assert.equal(result.scope?.branch, "branch/a");
  assert.equal(readKnowledgeAddress("#knowledge?page=unknown&sessionId=test&turnStart=-2&turnEnd=oops").scope?.turnStart, undefined);
  assert.equal(readKnowledgeAddress("#knowledge?page=unknown").page, "library");
});

test("新建不需要模型；编辑保留待审快照的来源和语言但不提交服务端状态", () => {
  assert.equal(emptyDraft("en").language, "en"); assert.deepEqual(emptyDraft("en").sources, [{ kind: "manual" }]);
  const published = { ...emptyDraft("en"), title: "Published", body: "old", id: "r1", knowledgeId: "k1", version: 1, review: "reviewed", createdAt: "2026-01-01" };
  const pending = { ...published, title: "Pending", body: "new", id: "r2", version: 2, review: "pending", baseRevisionId: "r1", sources: [{ kind: "agent", excerpt: "evidence" }] };
  const draft = editableDraft({ revision: published, pendingRevision: pending } as KnowledgeDetail);
  assert.equal(draft.body, "new"); assert.equal(draft.language, "en"); assert.deepEqual(draft.sources, pending.sources); assert.equal("id" in draft, false); assert.equal("review" in draft, false); assert.equal("baseRevisionId" in draft, false);
});

test("未声明类型保持未分类，编辑不会把未分类快照改写为事实", () => {
  const revision = { title: "Unclassified submission", body: "Submitted content", scope: { kind: "global" }, id: "synthetic-revision", knowledgeId: "synthetic-knowledge", version: 1, review: "pending", createdAt: "2026-01-01" };
  assert.equal(editableDraft({ revision } as KnowledgeDetail).type, undefined); assert.equal(knowledgeTypeKey(), "knowledge.type.unclassified");
  assert.equal(translate("zh-CN", knowledgeTypeKey()), "未分类"); assert.equal(translate("en", knowledgeTypeKey()), "Unclassified"); assert.equal(knowledgeTypeKey("fact"), "knowledge.type.fact");
});

test("嵌套确认取消返回父操作按钮，外层关闭返回发起按钮，失效按钮使用稳定后备", () => {
  const focused: string[] = [];
  const element = (name: string, options: { connected?: boolean; visible?: boolean; disabled?: boolean } = {}) => ({ isConnected: options.connected ?? true, getClientRects: () => options.visible === false ? [] : [{}], matches: () => options.disabled ?? false, focus: () => { focused.push(name); } }) as unknown as HTMLElement;
  const opener = element("new-entry"), nestedOpener = element("save-and-publish"), fallback = element("knowledge-workspace");
  restoreKnowledgeFocus([nestedOpener, opener, fallback]); restoreKnowledgeFocus([opener, fallback]);
  restoreKnowledgeFocus([element("removed", { connected: false }), element("hidden", { visible: false }), element("disabled", { disabled: true }), fallback]);
  assert.deepEqual(focused, ["save-and-publish", "new-entry", "knowledge-workspace"]);
});

test("限制与失败诊断根据显式标识翻译，中英文都保留原始详情数据", () => {
  for (const language of ["en", "zh-CN"] as const) {
    assert.equal(translateMessageOrOriginal(language, { key: "knowledge.limitation.compressionSummary" }, "compression_summary"), translate(language, "knowledge.limitation.compressionSummary"));
    assert.equal(translateMessageOrOriginal(language, undefined, "compression_summary"), "compression_summary");
    assert.equal(translateMessageOrOriginal(language, { key: "knowledge.errors.index_failed" }, "Synthetic underlying failure"), translate(language, "knowledge.errors.index_failed"));
  }
  const raw = knowledgeLimitations(["compression_summary", "Synthetic external failure"]);
  assert.ok(raw.every(item => item.messageDescriptor === undefined), "不根据既有文本猜测来源限制含义");
  const known = knowledgeLimitations(["Synthetic source text"], [{ message: "Synthetic source text", messageDescriptor: { key: "knowledge.limitation.compressedOnly" } }]); assert.equal(known.length, 1); assert.equal(known[0]!.messageDescriptor?.key, "knowledge.limitation.compressedOnly");
});

test("知识动态类型、状态和服务诊断具备中英文文案", () => {
  const errors = ["config_invalid", "config_unreadable", "credentials_unreadable", "connection_required", "input_too_long", "cancelled", "stopped", "budget_exceeded", "timeout", "network", "rate_limited", "auth", "service", "request_invalid", "response_invalid", "output_truncated", "preview_stale", "busy", "source_changed", "context_required", "task_not_found", "automatic_failed", "persistence_failed", "index_required", "index_changed", "management_required", "invalid_input", "not_found", "conflict", "scope_required", "quiet_time_unknown"];
  const keys = [...knowledgeTypes.map(type => `knowledge.type.${type}`), "knowledge.type.unclassified", "knowledge.errors.index_failed", ...["compressedOnly", "compressionSummary", "missingTime", "oldEvidenceUnavailable"].map(key => `knowledge.limitation.${key}`), ...errors.map(code => `knowledge.errors.${code}`), ...["active", "deprecated", "expired", "superseded", "resolved"].map(state => `knowledge.availability.${state}`), ...["queued", "running", "paused", "complete", "partial", "failed", "budget_stopped"].map(state => `knowledge.status.${state}`)];
  for (const language of ["en", "zh-CN"] as const) for (const key of keys) { assert.ok(i18n.exists(key, { lng: language }), key); assert.notEqual(translate(language, key), translate(language, "common.translationUnavailable")); }
});


test("会话入口携带标题和总轮次，界面元信息不会变成后端标题过滤条件", () => {
  const result = readKnowledgeAddress("#knowledge?page=tasks&sessionId=synthetic-session&sessionTitle=Timestamp%20parser&totalTurns=20");
  assert.deepEqual(result.selection, { id: "synthetic-session", title: "Timestamp parser", totalTurns: 20 });
  assert.equal(result.scope?.title, ""); assert.equal(result.scope?.turnStart, undefined); assert.equal(result.scope?.turnEnd, undefined);
});


test("新建、任务列表和任务深链分离，旧会话入口继续预填新建", () => {
  assert.equal(readKnowledgeAddress("#knowledge?page=new").page, "new");
  const list = readKnowledgeAddress("#knowledge?page=tasks");
  assert.equal(list.page, "tasks"); assert.equal(list.taskId, undefined); assert.equal(list.scope, undefined);
  const detail = readKnowledgeAddress("#knowledge?page=tasks&taskId=synthetic-task");
  assert.equal(detail.page, "tasks"); assert.equal(detail.taskId, "synthetic-task");
  assert.equal(readKnowledgeAddress("#knowledge?page=new&sessionId=synthetic-session").page, "new");
  assert.equal(readKnowledgeAddress("#knowledge?page=tasks&sessionId=synthetic-session").page, "new");
});

test("侧栏切换清理视图自带条件，保留用户手动筛选且回到第一页", () => {
  const pending = { view: "project" as const, project: "/synthetic/atlas", review: "pending" as const, availability: "all" as const, taskId: "synthetic-task", q: "configuration", client: "codex", type: "procedure" as const, page: 4, pageSize: 50 };
  for (const collection of ["all", "personal", "project", "general"] as const) {
    const next = knowledgeCollectionQuery(pending, collection);
    assert.equal(next.project, undefined); assert.equal(next.review, "reviewed"); assert.equal(next.availability, "active"); assert.equal(next.taskId, undefined); assert.equal(next.page, 1);
    assert.equal(next.view, collection); assert.equal(next.q, pending.q); assert.equal(next.client, pending.client); assert.equal(next.type, pending.type); assert.equal(next.pageSize, 50);
  }
  const project = knowledgeCollectionQuery(pending, "project", "/synthetic/another"); assert.equal(project.project, "/synthetic/another"); assert.equal(project.review, "reviewed");
  const review = knowledgeCollectionQuery(project, "review"); assert.equal(review.project, undefined); assert.equal(review.view, "all"); assert.equal(review.taskId, undefined); assert.equal(review.review, "pending"); assert.equal(review.availability, "all");
});

test("菜单与返回地址完整保留查询，显式全库地址不继承旧项目和任务", () => {
  const query = { view: "project" as const, project: "/synthetic/project with spaces", client: "codex", review: "all" as const, availability: "deprecated" as const, type: "procedure" as const, tag: "configuration", q: "a&b", from: "2026-10-01", to: "2026-10-19", page: 3, pageSize: 50 };
  assert.deepEqual(readKnowledgeAddress(knowledgeCollectionAddress("library", query)).query, { ...query, taskId: undefined });
  const next = readKnowledgeAddress(knowledgeCollectionAddress("library", knowledgeCollectionQuery({ ...query, taskId: "old-task" }, "all")));
  assert.equal(next.page, "library"); assert.equal(next.query.project, undefined); assert.equal(next.taskId, undefined); assert.equal(next.query.review, "reviewed");
  const review = readKnowledgeAddress("#knowledge?page=review&taskId=synthetic-task"); assert.equal(review.query.review, "pending"); assert.equal(review.query.availability, "all");
});

test("知识列表调宽保留正文最小空间，窄窗口不改写原宽度偏好", () => {
  assert.equal(knowledgeListWidth(1200, 500), 500);
  assert.equal(knowledgeListWidth(1000, 100), 315);
  assert.equal(knowledgeListWidth(1000, 900), 640);
  assert.equal(knowledgeListWidth(800, 500), 440);
  assert.equal(knowledgeListWidth(1200, 500), 500);
});

test("知识导航调宽独立约束，并为列表和正文保留空间", () => {
  assert.equal(knowledgeNavigationWidth(1536), 192);
  assert.equal(knowledgeNavigationWidth(1536, 100), 176);
  assert.equal(knowledgeNavigationWidth(1536, 500), 360);
  assert.equal(knowledgeNavigationWidth(1024, 360), 349);
  assert.equal(knowledgeNavigationWidth(1536, 360), 360);
});

test("来源按会话分支和输入版本分组，不丢弃相同内容的不同消息", () => {
  const base: KnowledgeSource = { kind: "extraction", client: "codex", sessionId: "synthetic-session", branch: "current", sourceVersion: "v1", excerpt: "Same evidence", status: "available" };
  const sources = [{ ...base, messageId: "m1" }, { ...base, messageId: "m2" }, { ...base, branch: "alternative", messageId: "m3" }, { ...base, sourceVersion: "v2", messageId: "m4" }, { ...base, sessionId: "another-session", messageId: "m5" }];
  const result = knowledgeSourceGroups(sources);
  assert.equal(result.groups.length, 4); assert.equal(result.groups[0]!.sources.length, 2);
  assert.deepEqual(result.groups.flatMap(group => group.sources.map(source => source.messageId)), ["m1", "m2", "m3", "m4", "m5"]);
  assert.deepEqual(result.groups[0]!.sources.map(sourceAddress), sources.slice(0, 2).map(sourceAddress));
});

test("重复常规说明折叠归集，冲突和未知原文继续作为重要限制保留", () => {
  const routine = { message: "Synthetic original diagnostic", messageDescriptor: { key: "knowledge.limitation.inputSummarized" } };
  const conflict = { message: "Conflicting source evidence", messageDescriptor: { key: "knowledge.limitation.topicConflict" } };
  const base: KnowledgeSource = { kind: "extraction", sessionId: "synthetic-session", limitationDetails: [routine, conflict] };
  const sources = [base, { ...base, messageId: "m2", limitationDetails: [{ ...routine, message: "Alternative original wording" }, conflict] }, { ...base, messageId: "m3", limitationDetails: undefined, limitation: "Unknown external diagnostic" }];
  const snapshot = structuredClone(sources), result = knowledgeSourceGroups(sources);
  assert.equal(result.notes.length, 1); assert.equal(result.groups[0]!.warnings.length, 2);
  assert.equal(result.groups[0]!.warnings[1]!.message, "Unknown external diagnostic");
  assert.deepEqual(sources, snapshot, "展示归集不能改写快照或原始诊断");
});

test("无会话身份的提交不混合来源，覆盖缺失和未读取媒体保持显式提示", () => {
  const sources: KnowledgeSource[] = [{ kind: "agent", taskId: "run-a", excerpt: "A" }, { kind: "agent", taskId: "run-b", excerpt: "B" }, { kind: "manual", excerpt: "C" }, { kind: "manual", excerpt: "D" }];
  assert.equal(knowledgeSourceGroups(sources).groups.length, 4);
  const limitations = ["missingTime", "mediaOmitted"].map(key => ({ message: `Synthetic ${key}`, messageDescriptor: { key: `knowledge.limitation.${key}` } }));
  const result = knowledgeSourceGroups([{ kind: "extraction", sessionId: "synthetic-session", limitationDetails: limitations }]);
  assert.equal(result.notes.length, 0); assert.deepEqual(result.groups[0]!.warnings, limitations);
});

test("任务事件、用途及输入优化诊断都具备中英文文案", () => {
  const keys = [...["queued", "started", "phase", "progress", "request", "error", "paused", "resumed", "retried", "completed"].map(kind => `knowledge.event.${kind}`), ...["extract", "merge", "reread", "try", "test"].map(purpose => `knowledge.purpose.${purpose}`), ...["inputSummarized", "rereadLimit", "topicConflict", "similarityUnavailable"].map(kind => `knowledge.limitation.${kind}`), "knowledge.errors.task_budget_exceeded", "knowledge.errors.task_token_budget_exceeded", "knowledge.betaDescription"];
  for (const language of ["en", "zh-CN"] as const) for (const key of keys) assert.ok(i18n.exists(key, { lng: language }), key);
});
