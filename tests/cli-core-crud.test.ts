import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startService } from "../src/server.js";
import { coreResponse } from "../src/service/core-response.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";
import { summaryRequestPath, summarizeResponse } from "../packages/cli/src/output/summary.js";

test("知识 CRUD 的实际 HTTP 核心字段与全量字段独立，当前正文和错误语义保留", async t => {
  const directory = await mkdtemp(join(tmpdir(), "manor-core-crud-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = await startService({ home: join(directory, "data"), startupRefresh: false, roots: isolatedHistoryRoots(),
    resourceInventory: { userHome: join(directory, "user"), environment: {} }, usagePricing: { fetch: async () => new Response("offline", { status: 503 }) } });
  t.after(() => service.close());
  const api = async (path: string, method = "GET", body?: unknown, status = 200) => {
    const response = await fetch(`http://127.0.0.1:${service.instance.port}/api/v1${path}`, { method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    assert.equal(response.status, status, await response.clone().text());
    return response.json() as Promise<any>;
  };
  const draft = { title: "Synthetic knowledge", body: "Current body", summary: "summary", scope: { kind: "global" },
    sources: [{ kind: "manual", excerpt: "Synthetic evidence" }] };
  const created = await api("/knowledge/entries?response=summary", "POST", draft);
  assert.equal(created.revision.review, "pending"); assert.equal(created.revision.body, undefined);
  const path = `/knowledge/entries/${created.id}`;
  const full = await api(`${path}?review=all`);
  assert.equal(full.revisions.length, 1); assert.equal(full.revision.sources[0].excerpt, "Synthetic evidence");
  const compact = await api(`${path}?review=all&response=summary`);
  assert.equal(compact.revision.body, draft.body); assert.equal(compact.revision.sourceCount, 1);
  assert.equal(compact.revisions, undefined); assert.equal(compact.audit, undefined);
  assert.equal(compact.revision.sources[0].kind, "manual"); assert.equal(compact.revision.sources[0].excerpt, undefined);
  assert.deepEqual(summarizeResponse(path, "GET", compact), compact, "后台与 CLI 重复投影应保持相同字段");
  const changed = await api(`${path}/revisions?response=summary`, "POST", { ...draft, body: "Updated body", baseRevisionId: created.latestRevisionId });
  assert.equal(changed.revision.body, undefined); assert.notEqual(changed.latestRevisionId, created.latestRevisionId);
  const history = await api(`${path}/revisions?response=summary`);
  assert.equal(history.revisions.length, 2); assert.ok(history.revisions.every((revision: any) => revision.body === undefined && revision.sources === undefined));
  const original = await api(`${path}/revisions/${created.latestRevisionId}?response=summary`);
  assert.equal(original.body, draft.body); assert.equal(original.sourceCount, 1);
  const list = await api("/knowledge/entries?review=all&response=summary&pageSize=1");
  assert.equal(list.total, 1); assert.equal(list.items[0].revision.body, undefined); assert.equal(list.items[0].revision.summary, undefined);
  const fullList = await api("/knowledge/entries?review=all&pageSize=1");
  assert.equal(fullList.items[0].revision.body, "Updated body");
  const search = await api("/knowledge/search?response=summary", "POST", { q: "Synthetic", review: "all" });
  assert.equal(search.items[0].revision.body, undefined);
  const resourceStatus = await api("/resources/status?response=summary");
  assert.deepEqual(Object.keys(resourceStatus).sort(), ["observedAt", "sourceCount", "gapCount", "manualSourceCount"].sort());
  assert.ok("sources" in await api("/resources/status"));
  await api(`${path}?response=invalid`, "GET", undefined, 400);
  await api("/knowledge/entries?response=invalid", "POST", { ...draft, title: "Must not be written" }, 400);
  assert.equal((await api("/knowledge/entries?review=all&response=summary")).total, 1, "非法投影参数必须在写入前拒绝");
  const missing = await api("/knowledge/entries/not-found?response=summary", "GET", undefined, 404);
  assert.ok(missing.error, "错误不得按成功对象投影");
});

test("资源及仓库列表只选定位和状态，入口明细与未来字段不会混入核心字段", () => {
  const local = { version: "v1", total: 1, page: 1, pageSize: 20, observedAt: "now", partial: true,
    rows: [{ body: { id: "body-1", name: "Synthetic Skill", kind: "skill", entryIds: ["entry-1"], contentFingerprint: "raw" },
      entries: [{ id: "entry-1", locator: { controlPath: "/workspace/control" } }], historyIds: ["h1"], favorite: true,
      protected: true, partial: true, usage: { sessions: 3 }, futureMetadata: "opaque" }], thresholds: { inactiveDays: 30 } };
  const small = coreResponse("/resources/local", "GET", local) as any;
  assert.deepEqual(Object.keys(small.rows[0]).sort(), ["body", "entryCount", "favorite", "partial", "protected", "usage"].sort());
  assert.deepEqual(small.rows[0].body, { id: "body-1", name: "Synthetic Skill", kind: "skill" });
  assert.equal(small.rows[0].entryCount, 1); assert.equal(small.rows[0].protected, true);
  assert.deepEqual(coreResponse("/resources/local", "GET", small), small);
  const repositories = [{ id: "repo", name: "Example", path: "/workspace/example", commonDir: "/workspace/example/.git", version: "v1", stale: false }];
  assert.deepEqual(summarizeResponse("/repositories", "GET", repositories), [{ id: "repo", name: "Example", path: "/workspace/example", version: "v1", stale: false }]);
  const waited = coreResponse("/repositories", "POST", { repository: repositories[0], job: { id: "job", status: "queued" }, id: "job", status: "complete", phase: "complete", progress: 1 }) as any;
  assert.equal(waited.job.status, "complete", "登记等待后的最终任务状态不能被旧响应覆盖");
  for (const path of ["/knowledge/entries", "/knowledge/search", "/resources/local", "/resources/status", "/repositories"]) {
    assert.match(summaryRequestPath(path, false), /response=summary/);
    assert.equal(summaryRequestPath(path, true), path);
  }
  const preview = { affectedEntries: [{ id: "entry", locator: "exact" }], requiresConfirmation: true };
  assert.equal(coreResponse("/resources/preview", "POST", preview), preview, "操作授权预览保持完整");
});

test("知识正文保留回查会话所需的来源锚点及状态，省略原文摘录和哈希", () => {
  const source = { kind: "extraction", taskId: "task-1", client: "codex", sessionId: "session-1", messageId: "message-1", sourceVersion: "v1",
    currentVersion: "v2", turnPosition: 3, status: "changed", limitation: "Synthetic changed source", excerpt: "large evidence", hash: "raw-hash",
    limitationDetails: [{ message: "Verbose diagnostic" }] };
  const revision = { id: "r1", knowledgeId: "k1", version: 1, title: "Synthetic knowledge", body: "Body", sources: [source] };
  const result = coreResponse("/knowledge/entries/k1", "GET", { id: "k1", latestRevisionId: "r1", revision }) as any;
  const { excerpt: _excerpt, hash: _hash, limitationDetails: _details, ...anchor } = source;
  assert.deepEqual(result.revision.sources, [anchor]);
  assert.equal(result.revision.sources[0].limitationDetails, undefined);
  assert.equal(result.revision.changedSourceCount, 1);
  assert.deepEqual(coreResponse("/knowledge/entries/k1", "GET", result), result);
  const version = coreResponse("/knowledge/entries/k1/revisions/r1", "GET", revision) as any;
  assert.deepEqual(version.sources, [anchor]);
  assert.equal(version.body, "Body");
  assert.deepEqual(coreResponse("/knowledge/entries/k1/revisions/r1", "GET", version), version);
});
