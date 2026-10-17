import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionSearchScope, SessionSourceMeta } from "../src/session-contracts.js";
import { AnalysisStore } from "../src/index/store.js";
import { SessionStore } from "../src/sessions/store.js";
import { startService } from "../src/server.js";
import { apiRequest, RequestError } from "../src/service/runtime.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";
import type { SessionGroupedSearchResult, SessionListResult } from "../src/session-contracts.js";
import { validateSearchScope } from "../src/sessions/search-scope.js";
import { sessionQuery } from "../src/service/session-input.js";
import { readSessionSearchScope, writeSessionSearchFilters } from "../web/features/sessions/session-address.js";
import { searchScopeExtraCount, searchScopeInvalid, semanticQueryScope, sharedSessionSearchScope } from "../web/features/sessions/semantic-ui-model.js";

async function fixture(run: (store: SessionStore, home: string) => void | Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "manor-search-scope-")), path = join(home, "index.sqlite");
  new AnalysisStore(path).close(); const store = new SessionStore(path);
  try {
    const sources = [
      { id: "alpha", client: "codex", project: "/workspace/alpha", models: ["model-a"], title: "First decision", messages: 3 },
      { id: "beta", client: "claude", project: "/workspace/beta", models: ["model-b"], title: "Second decision", executionMode: "quiet", messages: 1 },
      { id: "child", client: "codex", project: "/workspace/alpha", models: ["model-a"], title: "Child decision", relationship: "child", parentSessionId: "alpha", messages: 1 },
      { id: "fork", client: "codex", project: "/workspace/alpha", models: ["model-b"], title: "Fork decision", relationship: "fork", parentSessionId: "alpha", messages: 2 },
      { id: "orphan", client: "claude", models: ["model-c"], title: "Other decision", messages: 2 },
    ] as const;
    const revisions = sources.map(item => {
      const path = `/workspace/history/${item.id}.jsonl`, revision = store.createRevision(path, item.id);
      for (let i = 0; i < item.messages; i++) revision.sink.message({ id: `${item.id}-${i}`, sessionId: item.id, ordinal: i, recordLine: i + 1,
        turnId: `${item.id}-turn-${i}`, kind: "user", text: i === item.messages - 1 ? "共同关键词 旁支文本" : "共同关键词 当前文本", currentBranch: i !== item.messages - 1 });
      revision.flush();
      store.finishRevision(revision.revision, { ...item, models: [...item.models], clientSessionId: item.id, path, sourceId: item.id,
        messageCount: item.messages, turnCount: item.messages, updatedAt: "2026-01-15T00:00:00Z", startedAt: "2026-01-10T00:00:00Z", gaps: [] } as SessionSourceMeta);
      return { path, revision: revision.revision, fingerprint: item.id };
    });
    store.publish(store.createJob().id, revisions, []); await run(store, home);
  } finally { store.close(); await rm(home, { recursive: true, force: true }); }
}

test("共同范围的多选、元数据与数量条件同时约束列表和关键词查询", async () => fixture(store => {
  const check = (partial: Partial<SessionSearchScope>, expected: string[]) => {
    const scope = validateSearchScope({ relationship: "all", executionMode: "all", ...partial });
    const list = store.list({ scope }).sessions.map(session => session.id).sort();
    const hits = [...new Set(store.search({ q: "共同关键词", scope }).hits.map(hit => hit.session.id))].sort();
    assert.deepEqual(list, expected); assert.deepEqual(hits, expected);
  };
  check({ clients: ["claude"], projects: ["none", "/workspace/beta"] }, ["beta", "orphan"]);
  check({ clients: ["codex", "claude"], models: ["model-a"], minMessages: 2, maxMessages: 3, minTurns: 2, maxTurns: 3, title: "FIRST" }, ["alpha"]);
  check({ relationship: "children" }, ["child"]);
  check({ relationship: "forks" }, ["fork"]);
  check({ relationship: "unknown", executionMode: "unknown" }, ["alpha", "orphan"]);
  check({ relationship: "exclude_children", executionMode: "exclude_quiet" }, ["alpha", "fork", "orphan"]);
  check({ from: "2026-01-11T12:00:00+08:00", to: "2026-01-14T00:00:00Z" }, ["alpha", "beta", "child", "fork", "orphan"]);
}));

test("共同筛选通过 HTTP 与搜索 Worker 生效，不依赖语义模型配置", async () => fixture(async (_store, home) => {
  const service = await startService({ home, startupRefresh: false, roots: isolatedHistoryRoots({}), resourceInventory: { userHome: join(home, "isolated"), environment: {} } });
  try {
    const scope = validateSearchScope({ models: ["model-a"], relationship: "all", minMessages: 2 });
    const params = new URLSearchParams({ scope: JSON.stringify(scope) });
    const list = await apiRequest<SessionListResult>(service.instance, `/sessions?${params}`); assert.deepEqual(list.sessions.map(session => session.id), ["alpha"]);
    params.set("q", "共同关键词");
    const grouped = await apiRequest<SessionGroupedSearchResult>(service.instance, `/sessions/search/groups?${params}`); assert.equal(grouped.total, 1); assert.equal(grouped.groups[0]?.session.id, "alpha");
    params.set("scope", JSON.stringify({ minTurns: -1 }));
    await assert.rejects(apiRequest(service.instance, `/sessions?${params}`), error => error instanceof RequestError && error.code === "INVALID_INPUT");
    const facets = await apiRequest<{ models: string[] }>(service.instance, "/sessions/facets"); assert.deepEqual(facets.models, ["model-a", "model-b", "model-c"]);
  } finally { await service.close(); }
}));

test("当前分支筛选只检查当前消息，不让旁支命中混入", async () => fixture(store => {
  const scope = validateSearchScope({ relationship: "all", executionMode: "all", branch: "current" });
  assert.equal(store.search({ q: "旁支文本", scope }).total, 0);
  assert.equal(store.list({ q: "旁支文本", scope }).total, 0);
  assert.equal(store.search({ q: "当前文本", scope }).hits.length, 4);
  assert.equal(store.search({ q: "旁支文本" }).hits.length, 5, "旧调用不隐式缩小范围");
  assert.equal(store.searchFacets().models.length, 3);
  assert.equal(store.list({ client: "claude", scope: { ...scope, clients: ["codex"] } }).total, 3, "完整共同范围优先于旧单值条件");
}));

test("HTTP 范围解析校验枚举、数组、日期和数量，同时兼容旧参数", () => {
  const scope = sharedSessionSearchScope(semanticQueryScope());
  assert.deepEqual(sessionQuery({ scope: JSON.stringify(scope) }).scope, scope);
  assert.equal(sessionQuery({ client: "codex", includeSubagents: "true", executionMode: "all" }).scope, undefined);
  const projects = Array.from({ length: 80 }, (_, index) => `/workspace/${"long-project-path-".repeat(4)}${index}`);
  assert.deepEqual(sessionQuery({ scope: JSON.stringify({ projects }) }).scope?.projects, projects, "多选范围不受普通文本 4096 字符上限限制");
  for (const value of ["invalid", "[]", JSON.stringify({ clients: ["unknown"] }), JSON.stringify({ models: [1] }), JSON.stringify({ from: "invalid" }), JSON.stringify({ relationship: "invalid" }), JSON.stringify({ minTurns: -1 }), JSON.stringify({ minMessages: 3, maxMessages: 2 })]) {
    assert.throws(() => sessionQuery({ scope: value }), error => error instanceof Error && "code" in error && error.code === "INVALID_INPUT");
  }
});

test("共同筛选书签保留多选和特殊字符，旧单选书签可以恢复", () => {
  const scope = { ...semanticQueryScope(), clients: ["codex", "claude"] as const, projects: ["/workspace/a,b", "/workspace/中文"], models: ["example/model,a"], minTurns: 2, title: "50%_", branch: "current" as const };
  const mutable = { ...scope, clients: [...scope.clients] }, params = new URLSearchParams();
  writeSessionSearchFilters(params, mutable, "查询", true);
  assert.deepEqual(sharedSessionSearchScope(readSessionSearchScope(`#sessions?${params}`)), sharedSessionSearchScope(mutable));
  assert.deepEqual(readSessionSearchScope("#sessions?client=codex&subagents=true&execution=all").clients, ["codex"]);
  assert.equal(readSessionSearchScope("#sessions?client=codex&subagents=true&execution=all").relationship, "all");
});

test("共同筛选的计数、非法范围与维护窗口彼此独立", () => {
  const scope = semanticQueryScope(); assert.equal(searchScopeExtraCount(scope), 0); assert.equal(searchScopeInvalid(scope), false);
  scope.models = ["example"]; scope.minMessages = 3; scope.maxMessages = 2;
  assert.equal(searchScopeExtraCount(scope), 3); assert.equal(searchScopeInvalid(scope), true);
  scope.maxMessages = 3; scope.timeRange = "recent"; scope.recentDays = 7;
  assert.equal(searchScopeInvalid(scope), false); assert(!("timeRange" in sharedSessionSearchScope(scope)));
});
