import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeError, KnowledgeStore } from "../src/knowledge/store.js";
import type { KnowledgeDraft } from "../src/knowledge-contracts.js";
import Database from "better-sqlite3";

const sample = (changes: Partial<KnowledgeDraft> = {}): KnowledgeDraft => ({
  title: "动态配置缓存排查", body: "遇到配置更新但客户端读取旧值时，先核对读取链路和静态快照。", type: "procedure",
  scope: { kind: "project", project: "/projects/atlas" }, language: "zh-CN", subject: "project", tags: ["配置", "缓存"],
  sources: [{ kind: "extraction", client: "codex", sessionId: "synthetic-session", sourceVersion: "input-v1", branch: "main", messageId: "synthetic-message", excerpt: "移除静态快照后，动态切换验证通过。", taskId: "synthetic-job" }],
  ...changes,
});
function fixture(t: test.TestContext): { store: KnowledgeStore; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "manor-knowledge-")), path = join(directory, "knowledge", "knowledge.sqlite"), store = new KnowledgeStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, path };
}
function error(code: KnowledgeError["code"]): (error: unknown) => boolean {
  return value => value instanceof KnowledgeError && value.code === code;
}
const management = { review: "all", availability: "all" } as const;

test("日期筛选按本机完整日期处理，夏令时日与带时区时间戳保留边界", t => {
  const { store, path } = fixture(t), database = new Database(path), timezone = process.env.TZ;
  try {
    const entry = store.create(sample()); store.review(entry.id, { revisionId: entry.revision.id, action: "approve" });
    for (const [zone, day, start, end] of [
      ["Asia/Shanghai", "2026-12-31", "2026-12-30T16:00:00Z", "2026-12-31T16:00:00Z"],
      ["America/New_York", "2026-03-08", "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
      ["America/New_York", "2026-11-01", "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"],
    ]) {
      process.env.TZ = zone;
      for (const [time, expected] of [[Date.parse(start!) - 1, 0], [Date.parse(start!), 1], [Date.parse(end!) - 1, 1], [Date.parse(end!), 0]] as const) {
        database.prepare("UPDATE knowledge_entries SET updated_at=? WHERE id=?").run(new Date(time).toISOString(), entry.id);
        assert.equal(store.list({ from: day, to: day }).total, expected, `${zone} ${time}`);
      }
    }
    database.prepare("UPDATE knowledge_entries SET updated_at=? WHERE id=?").run("2026-10-22T02:00:00.000Z", entry.id);
    assert.equal(store.list({ from: "2026-10-22T02:00:00Z", to: "2026-10-22T02:00:00Z" }).total, 1);
    assert.equal(store.list({ from: "2026-10-22T02:00:00.001Z" }).total, 0);
  } finally { database.close(); if (timezone === undefined) delete process.env.TZ; else process.env.TZ = timezone; }
});

test("关键词片段解释适用条件、标签与来源命中，正文命中仍保留上下文", t => {
  const { store } = fixture(t), created = store.create(sample({ applicability: "ApplicabilityNeedle", tags: ["TagNeedle"], sources: [{ kind: "agent", excerpt: "SourceNeedle" }] }));
  store.review(created.id, { revisionId: created.revision.id, action: "approve" });
  for (const [q, field] of [["ApplicabilityNeedle", "applicability"], ["TagNeedle", "tags"], ["SourceNeedle", "source"], ["静态快照", "body"]]) {
    const result = store.list({ q }); assert.equal(result.total, 1); assert.ok(result.items[0]!.snippet!.includes(q!)); assert.equal(result.items[0]!.snippetField, field);
  }
  const combined = store.list({ q: "动态配置缓存排查 静态快照" }).items[0]!.snippet!;
  assert.ok(combined.includes("动态配置缓存排查") && combined.includes("静态快照"), "保留标题、摘要及正文的联合命中上下文");
});

test("新建永远待审，默认查询和读取不泄露候选，发布后修订仍保留旧有效内容", t => {
  const { store } = fixture(t), created = store.create(sample());
  assert.equal(created.revision.review, "pending"); assert.equal(store.list().total, 0);
  assert.throws(() => store.get(created.id), error("NOT_FOUND"));
  const approved = store.review(created.id, { revisionId: created.revision.id, action: "approve" });
  assert.equal(approved.publishedRevisionId, created.revision.id);
  const next = store.revise(created.id, { ...sample({ body: "新的待审流程，不应暴露给默认使用者。" }), baseRevisionId: created.latestRevisionId });
  const current = store.get(created.id);
  assert.equal(current.revision.body, created.revision.body); assert.equal(current.pendingRevision, undefined);
  assert.equal(current.revisions.length, 1); assert.equal(current.audit.some(row => row.revisionId === next.revision.id), false);
  assert.equal(store.list().items[0]?.pendingRevision, undefined);
  assert.equal(store.list({ review: "pending" }).items[0]?.revision.id, next.revision.id);
  const all = store.get(created.id, management);
  assert.equal(all.revision.id, next.revision.id); assert.equal(all.publishedRevisionId, created.revision.id); assert.equal(all.revisions.length, 2);
  assert.equal(store.list({ q: "新的待审" }).total, 0); assert.equal(store.list({ q: "新的待审", review: "pending" }).total, 1);
  store.review(created.id, { revisionId: next.revision.id, baseRevisionId: next.revision.id, action: "approve" });
  assert.equal(store.get(created.id).revision.id, next.revision.id);
  assert.equal(store.get(created.id, { ...management, revisionId: created.revision.id }).revision.body, created.revision.body);
});

test("相同幂等键返回原修订，不同载荷或操作冲突，重复提交不制造版本", t => {
  const { store } = fixture(t), created = store.create(sample(), "write-one");
  const reordered = { scope: created.revision.scope, ...sample() };
  assert.equal(store.create(reordered, "write-one").id, created.id);
  assert.throws(() => store.create(sample({ body: "不同载荷" }), "write-one"), error("CONFLICT"));
  const input = { ...sample({ title: "修订" }), baseRevisionId: created.latestRevisionId };
  assert.throws(() => store.revise(created.id, input, "write-one"), error("CONFLICT"));
  const revised = store.revise(created.id, input, "write-two");
  assert.equal(store.revise(created.id, input, "write-two").revision.id, revised.revision.id);
  assert.throws(() => store.revise(created.id, { ...input, title: "另一修订" }, "write-two"), error("CONFLICT"));
  assert.equal(store.revisions(created.id).length, 2);
});

test("两个连接提交同一基础只允许一个胜出，旧建议和错误基础不能发布", t => {
  const { store, path } = fixture(t), second = new KnowledgeStore(path); t.after(() => second.close());
  const created = store.create(sample()), next = store.revise(created.id, { ...sample({ body: "第二版" }), baseRevisionId: created.revision.id });
  assert.throws(() => second.revise(created.id, { ...sample({ body: "并发版本" }), baseRevisionId: created.revision.id }), error("CONFLICT"));
  assert.throws(() => second.review(created.id, { revisionId: created.revision.id, action: "approve" }), error("CONFLICT"));
  assert.throws(() => second.review(created.id, { revisionId: next.revision.id, baseRevisionId: created.revision.id, action: "approve" }), error("CONFLICT"));
  second.review(created.id, { revisionId: next.revision.id, action: "approve" });
  assert.throws(() => store.review(created.id, { revisionId: next.revision.id, action: "reject" }), error("CONFLICT"));
  assert.equal(store.revisions(created.id).length, 2); assert.equal(store.get(created.id).revision.body, "第二版");
});

test("拒绝保留有效版本，恢复产生待审快照且不重新启用废弃知识", t => {
  const { store } = fixture(t), created = store.create(sample());
  store.review(created.id, { revisionId: created.revision.id, action: "approve" });
  const next = store.revise(created.id, { ...sample({ body: "被拒的修改" }), baseRevisionId: created.revision.id });
  store.review(created.id, { revisionId: next.revision.id, action: "reject", reason: "证据不足" });
  assert.equal(store.get(created.id).revision.id, created.revision.id);
  assert.equal(store.list({ review: "rejected" }).items[0]?.revision.id, next.revision.id);
  store.setAvailability(created.id, { availability: "deprecated", reason: "环境已变更" });
  assert.equal(store.list().total, 0);
  const restored = store.restore(created.id, created.revision.id, next.revision.id, "restore-one");
  assert.equal(restored.revision.review, "pending"); assert.equal(restored.revision.version, 3); assert.equal(restored.availability, "deprecated");
  assert.equal(restored.revision.body, created.revision.body); assert.notEqual(restored.revision.id, created.revision.id);
  assert.equal(store.restore(created.id, created.revision.id, next.revision.id, "restore-one").revision.id, restored.revision.id);
  store.review(created.id, { revisionId: restored.revision.id, action: "approve" });
  assert.equal(store.list().total, 0); assert.equal(store.list({ availability: "deprecated" }).total, 1);
  store.setAvailability(created.id, { availability: "active" }); assert.equal(store.list().total, 1);
  assert.equal(store.get(created.id).revision.id, restored.revision.id);
});

test("过期、替代与已解决独立于审阅状态，显式历史筛选可读", t => {
  const { store } = fixture(t);
  for (const content of [sample({ title: "过期", validUntil: "2000-01-01" }), sample({ title: "已解决", type: "open_question", resolved: true }), sample({ title: "替代" })]) {
    const created = store.create(content); store.review(created.id, { revisionId: created.revision.id, action: "approve" });
    if (content.title === "替代") store.setAvailability(created.id, { availability: "superseded" });
    assert.throws(() => store.get(created.id), error("NOT_FOUND"));
  }
  assert.equal(store.list().total, 0);
  for (const availability of ["expired", "resolved", "superseded"] as const) assert.equal(store.list({ availability }).total, 1);
  assert.equal(store.list({ availability: "all" }).total, 3);
});

test("关键词覆盖中文短词、标签及证据，多个筛选仅作用于匹配修订", t => {
  const { store } = fixture(t), first = store.create(sample()); store.review(first.id, { revisionId: first.revision.id, action: "approve" });
  const second = store.create(sample({ title: "Review preference", body: "Use English in review reports.", scope: { kind: "global" }, subject: "personal", language: "en", tags: ["review"], sources: [{ kind: "agent", client: "claude" }] }));
  store.review(second.id, { revisionId: second.revision.id, action: "approve" });
  for (const q of ["配置", "缓存", "动态切换验证", "静态 快照"]) assert.equal(store.list({ q }).items[0]?.id, first.id);
  assert.equal(store.list({ q: "REPORTS" }).items[0]?.id, second.id);
  assert.equal(store.list({ q: "%" }).total, 0); assert.equal(store.list({ q: "_" }).total, 0);
  assert.equal(store.list({ project: "/projects/atlas", client: "codex", tag: "配置", type: "procedure", taskId: "synthetic-job", view: "project" }).total, 1);
  assert.equal(store.list({ project: "/projects/other" }).total, 0);
  assert.equal(store.list({ client: "claude", tag: "配置" }).total, 0);
  assert.equal(store.list({ view: "personal" }).items[0]?.id, second.id);
  assert.equal(store.list({ view: "general" }).total, 0);
  assert.deepEqual(store.facets(), { projects: ["/projects/atlas"], clients: ["claude", "codex"], tags: ["review", "缓存", "配置"] });
  assert.equal(store.list({ page: 2, pageSize: 1 }).items.length, 1); assert.equal(store.list({ pageSize: 1 }).total, 2);
  assert.equal(store.list({ from: "2100-01-01" }).total, 0); assert.equal(store.list({ to: "2000-01-01" }).total, 0);
});

test("严格验证不允许自报审阅，拒绝无效元数据和查询；调用者改动不篡改已保存快照", t => {
  const { store } = fixture(t);
  for (const bad of [
    { review: "reviewed" }, { publishedRevisionId: "self-published" }, { scope: { kind: "global", project: "/projects/atlas" } },
    { title: " " }, { body: "" }, { type: "invented" }, { tags: [1] }, { scope: { kind: "project" } },
    { sources: [{ kind: "extraction", turnPosition: -1 }] }, { validUntil: "2026-02-30" }, { validUntil: "later" },
    { resolved: true }, { language: "auto" }, { sources: [{ kind: "agent", review: "reviewed" }] }, { validUntil: "2026-01-01T24:00:00Z" },
  ]) assert.throws(() => store.create({ ...sample(), ...bad } as KnowledgeDraft), error("INVALID_INPUT"));
  const input = sample(), created = store.create(input); input.sources![0]!.excerpt = "调用者改动"; input.tags!.push("后来添加");
  const saved = store.get(created.id, management);
  assert.equal(saved.revision.sources?.[0]?.excerpt, "移除静态快照后，动态切换验证通过。"); assert.deepEqual(saved.revision.tags, ["配置", "缓存"]);
  assert.throws(() => store.list({ review: "untrusted" } as never), error("INVALID_INPUT"));
  assert.throws(() => store.list({ pageSize: 201 }), error("INVALID_INPUT"));
  assert.throws(() => store.list({ from: "2026-01-02", to: "2026-01-01" }), error("INVALID_INPUT"));
});

test("事务将知识、任务结果和覆盖一致提交，异常时全部回滚，重启保留证据与状态", t => {
  const { store, path } = fixture(t);
  assert.throws(() => store.transaction(() => {
    store.create(sample(), "rolled-back"); store.setState("job:result", { result: "synthetic-result" }); throw new Error("synthetic failure");
  }), /synthetic failure/);
  assert.equal(store.list(management).total, 0); assert.equal(store.getState("job:result"), undefined);
  const created = store.transaction(() => {
    const result = store.create(sample(), "rolled-back"); store.setState("job:result", { id: result.id }); store.setState("coverage:input", ["synthetic-message"]); return result;
  });
  assert.equal(statSync(path).mode & 0o777, 0o600); store.close();
  const reopened = new KnowledgeStore(path); t.after(() => reopened.close());
  assert.deepEqual(reopened.getState("job:result"), { id: created.id });
  assert.equal(reopened.get(created.id, management).revision.sources?.[0]?.excerpt, sample().sources?.[0]?.excerpt);
  assert.equal(reopened.create(sample(), "rolled-back").id, created.id);
  assert.throws(() => reopened.setState("bad", undefined), error("INVALID_INPUT"));
  assert.throws(() => reopened.setState("large", "x".repeat(8_388_609)), error("INVALID_INPUT"));
});

test("全文索引可重建，不影响权威快照、修订审阅或来源证据", t => {
  const { store, path } = fixture(t), created = store.create(sample({ body: 'Literal AND "quoted" check with a-b punctuation.' }));
  store.review(created.id, { revisionId: created.revision.id, action: "approve" });
  assert.equal(store.list({ q: '"quoted"' }).total, 1); assert.equal(store.list({ q: "AND" }).total, 1); assert.equal(store.list({ q: "a-b" }).total, 1);
  store.close();
  const raw = new Database(path); raw.exec("DROP TRIGGER knowledge_search_insert; DROP TABLE knowledge_search"); raw.close();
  const reopened = new KnowledgeStore(path); t.after(() => reopened.close());
  assert.equal(reopened.list({ q: '"quoted"' }).items[0]?.id, created.id);
  assert.equal(reopened.get(created.id).revision.sources?.[0]?.sourceVersion, "input-v1");
});

test("适用条件进入长词FTS和短词回退，存量派生文本升级保留所有权威快照", t => {
  const { store, path } = fixture(t), created = store.create(sample({ applicability: "UniqueApplicabilityNeedle 灰度" }));
  store.review(created.id, { revisionId: created.latestRevisionId, action: "approve" });
  assert.equal(store.list({ q: "UniqueApplicabilityNeedle" }).total, 1); assert.equal(store.list({ q: "灰度" }).total, 1);
  const snapshot = store.get(created.id); store.close();
  const legacy = new Database(path); legacy.prepare("UPDATE knowledge_revisions SET search=?").run("legacy derived text without applicability"); legacy.prepare("INSERT INTO knowledge_search(knowledge_search) VALUES('rebuild')").run(); legacy.pragma("user_version=1"); legacy.close();
  const reopened = new KnowledgeStore(path); t.after(() => reopened.close());
  assert.equal(reopened.list({ q: "UniqueApplicabilityNeedle" }).items[0]?.id, created.id); assert.equal(reopened.list({ q: "灰度" }).items[0]?.id, created.id);
  assert.deepEqual(reopened.get(created.id), snapshot); assert.equal(reopened.revisions(created.id).length, 1);
});

test("来源限制的标识与原文一同快照保存，不通过原文推断翻译", t => {
  const { store } = fixture(t), sources = [{ kind: "extraction" as const, limitation: "Synthetic raw diagnostic", limitationDetails: [{ message: "Synthetic raw diagnostic", messageDescriptor: { key: "knowledge.limitation.compressedOnly" } }] }];
  const created = store.create(sample({ sources })); assert.deepEqual(created.revision.sources, sources);
  assert.throws(() => store.create(sample({ sources: [{ ...sources[0]!, limitationDetails: [{ message: "invalid", messageDescriptor: { key: "synthetic", params: { count: Infinity } } }] }] })), error("INVALID_INPUT"));
});

test("任务状态清理实际释放配额、遵循事务回滚且不触及持久知识与证据", t => {
  const { store, path } = fixture(t), created = store.create(sample());
  const raw = new Database(path);
  try {
    const insert = raw.prepare("INSERT INTO knowledge_state(key,json,bytes) VALUES(?,'null',4)");
    raw.transaction(() => { for (let index = 0; index < 10_000; index++) insert.run(`synthetic-state-${index}`); })();
  } finally { raw.close(); }
  assert.throws(() => store.setState("synthetic-new-job", { result: "done" }), error("INVALID_INPUT"));
  store.deleteState("synthetic-state-0"); assert.equal(store.getState("synthetic-state-0"), undefined);
  store.setState("synthetic-new-job", { result: "done" });
  assert.deepEqual(store.getState("synthetic-new-job"), { result: "done" });
  assert.throws(() => store.transaction(() => { store.deleteState("synthetic-new-job"); throw new Error("synthetic cleanup failure"); }), /synthetic cleanup failure/);
  assert.deepEqual(store.getState("synthetic-new-job"), { result: "done" });
  store.deleteState("synthetic-new-job"); store.deleteState("synthetic-new-job");
  assert.equal(store.getState("synthetic-new-job"), undefined);
  assert.equal(store.get(created.id, management).revision.sources?.[0]?.excerpt, sample().sources?.[0]?.excerpt);
});
