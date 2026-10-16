import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "../src/clients.js";
import type { ResourceHistoryIdentity, ResourceUsageCoverage, ResourceUsageResult, ResourceUsageRow, ResourceUsageStats } from "../src/resource-contracts.js";
import type { ResourceInventoryEntry, ResourceInventorySnapshot } from "../src/resource-inventory-contracts.js";
import type { ResourceLocalRow, ResourceOverviewQuery } from "../src/resource-service-contracts.js";
import { buildResourceOverview, buildSkillOverview } from "../src/resources/overview.js";
import { emptyResourceUsageStats, resourceOverviewIdentity, resourceUsageIdentity } from "../src/resources/usage.js";

const now = Date.parse("2026-10-01T00:00:00Z");
const options = { observedAt: "2026-10-01T00:00:00Z", partial: false, now };

function stats(extra: Partial<ResourceUsageStats> = {}): ResourceUsageStats {
  return { ...emptyResourceUsageStats(), ...extra };
}

function historyRow(name: string, extra: Partial<ResourceUsageRow> = {}): ResourceUsageRow {
  const origin: ResourceHistoryIdentity = { id: `history:${name}`, kind: "skill", name, client: "codex" };
  return { identity: resourceUsageIdentity(origin), stats: stats({ events: 3, sessions: 2, explicitCalls: 2,
    successfulReads: 1, lastUsedAt: "2026-01-01T00:00:00Z" }), clients: ["codex"], favorite: false,
    association: { state: "unassociated", entryIds: [], reason: "missing_path" }, ...extra };
}

function history(resources: ResourceUsageRow[] = [], coverage: Partial<ResourceUsageCoverage> = {}): ResourceUsageResult {
  return { version: "synthetic-version", resources, total: resources.length, page: 1, pageSize: 50,
    stats: stats({ events: 37, sessions: 7 }), timeZone: "UTC", trend: [], clients: [], projects: [],
    coverage: { sessionCount: 7, clients: ["codex", "claude", "pi"], missingTimeEvents: 0, unassociatedEvents: 0,
      partial: false, gaps: [], uncertainClients: [], unscopedGaps: false, ...coverage } };
}

function entry(bodyId: string, client: Client = "codex", extra: Partial<ResourceInventoryEntry> = {}): ResourceInventoryEntry {
  return { id: `entry:${bodyId}:${client}`, bodyId, sourceId: `source:${client}`, kind: "skill", name: bodyId,
    client, scope: "user", entryPath: `/synthetic/${client}/skills/${bodyId}`, targetPath: `/synthetic/bodies/${bodyId}`,
    entryType: "directory", readState: "present", nativeState: "enabled", sourceFormat: "skill-directory",
    observedAt: options.observedAt, protected: false, locator: { type: "skill" },
    capabilities: { inventory: true, associate: true, disable: false, standby: true, restore: true, trash: true, purge: true }, ...extra };
}

function local(name: string, id = name, extra: Partial<ResourceLocalRow> = {}): ResourceLocalRow {
  const resourceEntry = entry(id, "codex", { name });
  return { body: { id, kind: "skill", name, entryIds: [resourceEntry.id], targetPath: resourceEntry.targetPath },
    entries: [resourceEntry], firstSeenAt: "2025-01-01T00:00:00Z", favorite: false, protected: false,
    usage: emptyResourceUsageStats(), historyIds: [], observation: "recorded", partial: false, usageUnassociated: false, missingTimeEvents: 0, candidates: [], ...extra };
}

function overview(resources: ResourceUsageRow[], localRows: ResourceLocalRow[] = [], query: ResourceOverviewQuery = {}) {
  return buildSkillOverview(history(resources), localRows, query, options);
}

test("本地位置独立表达存在、未发现及不可读，不改写名称级历史统计", () => {
  const present = local("guide");
  const inventory: ResourceInventorySnapshot = { observedAt: options.observedAt, entries: present.entries, bodies: [present.body], gaps: [], sources: [{
    id: "source:codex", client: "codex", kind: "skill", scope: "user", path: "/synthetic/skills", format: "skill-directory", origin: "standard", readState: "ok", observedAt: options.observedAt, verified: true,
  }] };
  const recorded = history([historyRow("guide"), historyRow("retired")]);
  const result = buildResourceOverview(recorded, [present], {}, { ...options, inventory });
  assert.equal(result.resources.find(row => row.identity.name === "guide")!.localSummary?.presence, "present");
  assert.equal(result.resources.find(row => row.identity.name === "retired")!.localSummary?.presence, "missing");
  assert.strictEqual(result.resources.find(row => row.identity.name === "retired")!.stats, recorded.resources[1]!.stats);
  inventory.sources[0]!.readState = "unreadable";
  assert.equal(buildResourceOverview(recorded, [present], { presence: "unknown" }, { ...options, inventory }).total, 0,
    "其他来源的读取缺口不能改变这条资源的本地状态");
  present.entries[0]!.readState = "unreadable";
  const unreadable = buildResourceOverview(recorded, [present], { presence: "unknown" }, { ...options, inventory });
  assert.deepEqual(unreadable.resources.map(row => row.identity.name), ["guide"]);
  assert.equal(unreadable.resources[0]!.stats?.events, 3);
});

test("位置项目按文件归属筛选，不将用户文件的项目生效范围算作项目位置", () => {
  const scopes = [{ scope: "user" as const }, { scope: "project" as const, project: "/synthetic/project" }];
  const shared = local("guide", "shared", { entries: [entry("shared", "codex", { selectionScopes: scopes }), entry("shared", "pi", { entryPath: "/synthetic/codex/skills/shared", scope: "project", project: "/synthetic/project", selectionScopes: scopes })] });
  const project = local("guide", "project", { entries: [entry("project", "codex", { scope: "project", project: "/synthetic/project" })] });
  const other = local("other");
  const recorded = history([historyRow("guide", { stats: stats({ events: 11, sessions: 7 }) }), historyRow("retired")]);
  const global = buildResourceOverview(recorded, [shared, other], { scope: "user" }, options).resources.find(row => row.identity.name === "guide")!;
  assert.deepEqual(global.localSummary, { presence: "present", locations: 1, scopes: ["user"] });
  assert.equal(buildResourceOverview(recorded, [shared], { scope: "project" }, options).total, 0);
  const result = buildResourceOverview(recorded, [shared, project, other], { scope: "project", locationProject: "/synthetic/project" }, options);
  assert.equal(result.total, 1);
  assert.equal(result.resources[0]!.identity.name, "guide");
  assert.deepEqual(result.resources[0]!.localSummary, { presence: "present", locations: 1, scopes: ["project"] });
  assert.equal(result.resources[0]!.stats?.events, 11);
  assert.equal(result.resources[0]!.stats?.sessions, 7);
});

test("同名跨 Agent 多本体与共享入口合并一行，历史事件和会话不累加本地统计", () => {
  const recorded = historyRow("guide", { clients: ["codex", "claude"], stats: stats({ events: 9, sessions: 3,
    explicitCalls: 4, successfulReads: 5, lastUsedAt: "2026-09-28T00:00:00Z" }) });
  const first = local("guide", "body-a", { entries: [entry("body-a", "codex", { name: "guide" }),
    entry("body-a", "claude", { name: "guide", entryType: "symlink" })], usage: stats({ events: 9, sessions: 3 }) });
  const second = local("guide", "body-b", { entries: [entry("body-b", "pi", { name: "guide" })], usage: stats({ events: 6, sessions: 3 }) });
  const input = history([recorded]);
  const result = buildSkillOverview(input, [first, second], {}, options);
  assert.equal(result.total, 1);
  assert.strictEqual(result.resources[0]!.stats, recorded.stats);
  assert.equal(result.resources[0]!.stats?.sessions, 3);
  assert.deepEqual(result.resources[0]!.clients, ["claude", "codex", "pi"]);
  assert.deepEqual(result.resources[0]!.localBodyIds, ["body-a", "body-b"]);
  assert.equal(result.resources[0]!.hasHistory, true);
  assert.equal(result.resources[0]!.identity.grouping, "skill");
  assert.strictEqual(result.stats, input.stats);
  assert.strictEqual(result.coverage, input.coverage);
});

test("完整名称区分不同 Skill，未知名称保留历史来源和本地本体身份", () => {
  const first = historyRow("未记录名称", { identity: { id: "history:unknown-a", kind: "skill", name: "未记录名称", client: "codex", grouping: "source" } });
  const second = historyRow("未记录名称", { identity: { id: "history:unknown-b", kind: "skill", name: "未记录名称", client: "claude", grouping: "source" } });
  const result = overview([first, second, historyRow("vendor-a/guide"), historyRow("vendor-b/guide")],
    [local("未记录名称", "body-unknown-a"), local("未记录名称", "body-unknown-b")]);
  assert.equal(result.total, 6);
  assert.deepEqual(result.resources.filter(row => row.identity.name === "未记录名称").map(row => row.identity.id).sort(),
    ["body-unknown-a", "body-unknown-b", "history:unknown-a", "history:unknown-b"]);
});

test("本地新发现立即参与未发现使用，未知保留且不沿用本地事件统计", () => {
  const locals = [local("known-zero"), local("unknown", "unknown", { observation: "unknown", usage: null }),
    local("new", "new", { firstSeenAt: "2026-09-30T00:00:00Z", observation: "insufficient", usage: null }),
    local("uncovered", "uncovered", { entries: [entry("uncovered", "qoder")] }),
    local("no-history-used", "no-history-used", { usage: stats({ events: 3, sessions: 2 }) })];
  const result = overview([], locals);
  const byName = new Map(result.resources.map(row => [row.identity.name, row]));
  assert.equal(byName.get("known-zero")!.observation, "unused");
  assert.deepEqual(byName.get("known-zero")!.stats, emptyResourceUsageStats());
  assert.equal(byName.get("unknown")!.observation, "unknown");
  assert.equal(byName.get("unknown")!.stats, null);
  assert.equal(byName.get("new")!.observation, "unused");
  assert.equal(byName.get("new")!.stats?.events, 0);
  assert.equal(byName.get("uncovered")!.observation, "unused");
  assert.equal(byName.get("no-history-used")!.observation, "unused");
  assert.equal(result.counts.used, 0);
  assert.equal(result.counts.unused, 4);
  assert.equal(result.counts.review, 0);
  const missingHistory = buildSkillOverview(null, [local("guide")], {}, { ...options, partial: true });
  assert.equal(missingHistory.resources[0]!.observation, "unknown");
  assert.equal(missingHistory.resources[0]!.stats, null);
  assert.equal(missingHistory.stats, null);
  assert.equal(missingHistory.coverage, null);
  assert.equal(missingHistory.partial, true);
});

test("同名本体读取未知保留状态，新发现时间不阻断分类", () => {
  const result = overview([], [local("guide", "old-body"), local("guide", "unknown-body", { observation: "unknown" }),
    local("recent", "old-recent-body"), local("recent", "new-recent-body", { firstSeenAt: "2026-09-29T00:00:00Z" })]);
  assert.equal(result.resources.find(row => row.identity.name === "guide")!.observation, "unknown");
  assert.equal(result.resources.find(row => row.identity.name === "recent")!.observation, "unused");
  assert.equal(result.resources.find(row => row.identity.name === "guide")!.stats, null);
  assert.equal(result.counts.review, 0);
});

test("相关缺口只标记对应 Agent 部分记录，分类保留已找到的记录", () => {
  const recorded = [historyRow("codex-used"), historyRow("claude-used", { clients: ["claude"] })];
  const locals = [local("codex-zero"), local("claude-zero", "claude-zero", { entries: [entry("claude-zero", "claude")] })];
  const input = history(recorded, { partial: true, uncertainClients: ["codex"] });
  const scoped = buildSkillOverview(input, locals, {}, { ...options, partial: true });
  assert.deepEqual(scoped.resources.find(row => row.identity.name === "codex-used")!.candidates, ["used", "low", "old"]);
  assert.equal(scoped.resources.find(row => row.identity.name === "codex-used")!.partial, true);
  assert.equal(scoped.resources.find(row => row.identity.name === "claude-used")!.partial, false);
  assert.ok(scoped.resources.find(row => row.identity.name === "claude-used")!.candidates.includes("low"));
  assert.ok(scoped.resources.find(row => row.identity.name === "claude-used")!.candidates.includes("old"));
  assert.equal(scoped.resources.find(row => row.identity.name === "codex-zero")!.observation, "unused");
  assert.equal(scoped.resources.find(row => row.identity.name === "claude-zero")!.observation, "unused");
  for (const coverage of [{ partial: true, unscopedGaps: true },
    { partial: true, uncertainClients: undefined, unscopedGaps: undefined },
    { gaps: [{ kind: "source_unavailable", message: "人工合成缺口" }], uncertainClients: undefined, unscopedGaps: undefined }] as Partial<ResourceUsageCoverage>[]) {
    const result = buildSkillOverview(history(recorded, coverage), locals, {}, options);
    assert.equal(result.counts.low, 2);
    assert.equal(result.counts.old, 2);
    assert.equal(result.counts.unused, 2);
  }
});

test("缺失日期只保留缺失状态，已知最近时间和正会话仍可分类", () => {
  const input = history([historyRow("missing-time", { stats: stats({ events: 1, sessions: 1, missingTimeEvents: 1,
    lastUsedAt: "2025-01-01T00:00:00Z" }) }), historyRow("complete"),
  historyRow("undated-only", { stats: stats({ missingTimeEvents: 2 }) })], { partial: true, missingTimeEvents: 3 });
  const result = buildSkillOverview(input, [local("undated-only")], {}, options);
  assert.deepEqual(result.resources.find(row => row.identity.name === "missing-time")!.candidates, ["used", "low", "old"]);
  assert.equal(result.resources.find(row => row.identity.name === "undated-only")!.observation, "unknown");
  assert.equal(result.resources.find(row => row.identity.name === "undated-only")!.stats, null);
  assert.equal(result.counts.low, 2);
  assert.equal(result.counts.old, 2);
  assert.equal(result.counts.unused, 0);
});

test("名称和历史别名收藏控制总览星标，本体和入口收藏独立保护并计入收藏候选", () => {
  const named = local("named", "named-body");
  const legacy = local("legacy", "legacy-body", { historyIds: ["history:legacy-origin"] });
  const body = local("body-favorite", "favorite-body");
  const entryFavorite = local("entry-favorite", "entry-body");
  const flagged = local("flagged", "flagged-body", { favorite: true });
  const protectedLocal = local("plugin", "plugin-body", { protected: true });
  const favorites = new Set([resourceUsageIdentity({ id: "unused", kind: "skill", name: "named", client: "codex" }).id,
    "history:legacy-origin", "favorite-body", entryFavorite.entries[0]!.id]);
  const result = buildSkillOverview(history([historyRow("history-favorite", { favorite: true }), historyRow("plugin")]),
    [named, legacy, body, entryFavorite, flagged, protectedLocal], {}, { ...options, favorites });
  assert.deepEqual(result.resources.filter(row => row.favorite).map(row => row.identity.name).sort(), ["history-favorite", "legacy", "named"]);
  assert.equal(result.counts.favorite, 6);
  assert.equal(result.counts.unused, 5);
  assert.equal(result.counts.low, 2);
  assert.equal(result.counts.old, 2);
  assert.ok(result.resources.every(row => row.protected));
  const collected = buildSkillOverview(history([historyRow("history-favorite", { favorite: true }), historyRow("plugin")]),
    [named, legacy, body, entryFavorite, flagged, protectedLocal], { candidate: "favorite" }, { ...options, favorites });
  assert.equal(collected.total, 6);
  assert.equal(collected.resources.find(row => row.identity.name === "body-favorite")!.favorite, false);
});

test("搜索匹配完整名称、本地路径及历史路径，计数先于状态和收藏过滤", () => {
  const recorded = [historyRow("guide-used", { paths: ["/synthetic/archive/search-marker/SKILL.md"] }), historyRow("other")];
  const locals = [local("guide-zero"), local("local-path", "search-marker-local"),
    local("guide-review", "review-body", { observation: "unknown", usage: null }), local("guide-favorite", "favorite-body", { favorite: true })];
  const all = overview(recorded, locals, { q: "guide" });
  assert.deepEqual(all.counts, { all: 4, used: 1, unused: 2, low: 1, old: 1, review: 0, favorite: 1 });
  const filtered = overview(recorded, locals, { q: "guide", candidate: "used" });
  assert.equal(filtered.total, 1);
  assert.deepEqual(filtered.counts, all.counts);
  const favorites = overview(recorded, locals, { q: "guide", favorite: true });
  assert.equal(favorites.total, 1);
  assert.deepEqual(favorites.counts, all.counts);
  const path = overview(recorded, locals, { q: " SEARCH-MARKER " });
  assert.deepEqual(path.resources.map(row => row.identity.name).sort(), ["guide-used", "local-path"]);
});

test("数字和最近使用升降序都把未知放最后，名称排序服从方向且保留稳定次序", () => {
  const recorded = [historyRow("beta", { stats: stats({ events: 4, sessions: 4, explicitCalls: 1, successfulReads: 3, lastUsedAt: "2026-09-20T00:00:00Z" }) }),
    historyRow("alpha", { stats: stats({ events: 2, sessions: 1, explicitCalls: 2, successfulReads: 0, lastUsedAt: "2026-09-01T00:00:00Z" }) })];
  const locals = [local("zulu-zero"), local("aardvark-unknown", "unknown", { observation: "unknown", usage: null })];
  const names = (query: ResourceOverviewQuery) => overview(recorded, locals, query).resources.map(row => row.identity.name);
  assert.deepEqual(names({ sort: "sessions", order: "asc" }), ["zulu-zero", "alpha", "beta", "aardvark-unknown"]);
  assert.deepEqual(names({ sort: "sessions", order: "desc" }), ["beta", "alpha", "zulu-zero", "aardvark-unknown"]);
  assert.deepEqual(names({ sort: "calls", order: "desc" }), ["alpha", "beta", "zulu-zero", "aardvark-unknown"]);
  assert.deepEqual(names({ sort: "uses", order: "desc" }), ["beta", "alpha", "zulu-zero", "aardvark-unknown"]);
  assert.deepEqual(names({ sort: "uses", order: "asc" }), ["zulu-zero", "alpha", "beta", "aardvark-unknown"]);
  assert.deepEqual(names({ sort: "reads", order: "asc" }), ["alpha", "zulu-zero", "beta", "aardvark-unknown"]);
  assert.deepEqual(names({ sort: "recent", order: "asc" }), ["alpha", "beta", "aardvark-unknown", "zulu-zero"]);
  assert.deepEqual(names({ sort: "recent", order: "desc" }), ["beta", "alpha", "aardvark-unknown", "zulu-zero"]);
  assert.deepEqual(names({ sort: "name", order: "desc" }), ["zulu-zero", "beta", "alpha", "aardvark-unknown"]);
});

test("分页默认二十条并夹紧页码和容量，空结果回到第一页", () => {
  const locals = Array.from({ length: 45 }, (_, index) => local(`guide-${String(index).padStart(2, "0")}`));
  const result = overview([], locals, { sort: "name", page: 99 });
  assert.equal(result.page, 3);
  assert.equal(result.pageSize, 20);
  assert.equal(result.total, 45);
  assert.equal(result.resources.length, 5);
  assert.equal(result.resources[0]!.identity.name, "guide-40");
  assert.equal(result.counts.all, 45);
  const capacity = overview([], locals, { page: -2, pageSize: 999 });
  assert.equal(capacity.page, 1);
  assert.equal(capacity.pageSize, 200);
  const empty = overview([], [], { page: 4, pageSize: 50 });
  assert.equal(empty.page, 1);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.resources, []);
});

test("内部详情可获取超过二百条的完整聚合行，普通列表仍保持分页上限", () => {
  const locals = Array.from({ length: 205 }, (_, index) => local(`guide-${index}`));
  const complete = buildSkillOverview(history(), locals, { page: 99, pageSize: 1 }, { ...options, unpaginated: true });
  assert.equal(complete.page, 1);
  assert.equal(complete.pageSize, 205);
  assert.equal(complete.resources.length, 205);
  assert.equal(overview([], locals, { pageSize: 999 }).resources.length, 200);
});

test("仅使用调用方提供的 Agent 与日期范围，不再次裁剪聚合统计或共享本体", () => {
  const recorded = historyRow("guide", { clients: ["claude"], stats: stats({ events: 2, sessions: 1, explicitCalls: 1, successfulReads: 1 }) });
  const shared = local("guide", "shared-body", { entries: [entry("shared-body", "claude", { name: "guide" })] });
  const result = overview([recorded], [shared], { client: "claude", from: "2026-09-01", to: "2026-10-01" });
  assert.strictEqual(result.resources[0]!.stats, recorded.stats);
  assert.deepEqual(result.resources[0]!.clients, ["claude"]);
  assert.deepEqual(result.resources[0]!.localBodyIds, ["shared-body"]);
  assert.equal(result.total, 1);
});

test("低频和长期未用使用已使用事件与可调整阈值，历史独有继续保留", () => {
  const result = overview([historyRow("history-only"), historyRow("frequent", { stats: stats({ events: 8, sessions: 5,
    lastUsedAt: "2026-09-20T00:00:00Z" }) })], [], { lowSessions: 5, inactiveDays: 10 });
  assert.equal(result.counts.used, 2);
  assert.equal(result.counts.low, 2);
  assert.equal(result.counts.old, 2);
  assert.deepEqual(result.thresholds, { lowSessions: 5, inactiveDays: 10 });
  assert.deepEqual(result.resources.find(row => row.identity.name === "history-only")!.localBodyIds, []);
  assert.equal(result.resources.find(row => row.identity.name === "history-only")!.hasHistory, true);
});

function mcpHistory(name: string, extra: Partial<ResourceUsageRow> = {}): ResourceUsageRow {
  return historyRow(name, { identity: resourceOverviewIdentity({ id: `mcp-origin:${name}`, kind: "mcp", name, server: name, client: "codex" }),
    stats: stats({ events: 3, sessions: 2, mcpCalls: 3, lastUsedAt: "2026-01-01T00:00:00Z" }), ...extra });
}

function mcpLocal(name: string, id = name, extra: Partial<ResourceLocalRow> = {}): ResourceLocalRow {
  const row = local(name, id);
  return { ...row, body: { ...row.body, kind: "mcp" }, entries: row.entries.map(entry => ({ ...entry, kind: "mcp", server: name,
    sourceFormat: "json", locator: { type: "mcp", configPath: entry.entryPath, format: "json", keyPath: ["mcpServers"] } })), ...extra };
}

test("MCP 总览复用完整名称汇总、计数与本地注册身份，默认调用排序且统计不相加", () => {
  const recorded = mcpHistory("vendor/demo", { clients: ["codex", "claude"] });
  const first = mcpLocal("vendor/demo", "mcp-a", { usage: stats({ events: 9, sessions: 9, mcpCalls: 9 }) });
  const second = mcpLocal("vendor/demo", "mcp-b", { entries: mcpLocal("vendor/demo", "mcp-b").entries.map(entry => ({ ...entry, client: "claude" })) });
  const input = history([recorded, mcpHistory("other/demo", { stats: stats({ events: 9, sessions: 1, mcpCalls: 9 }) })]);
  const result = buildResourceOverview(input, [first, second, mcpLocal("zero"), mcpLocal("new", "new", { observation: "insufficient" }),
    mcpLocal("unknown", "unknown", { observation: "unknown", usage: null }), mcpLocal("protected", "protected", { protected: true })], { kind: "mcp" }, options);
  assert.equal(result.total, 6);
  assert.equal(result.resources[0]!.identity.name, "other/demo");
  const row = result.resources.find(row => row.identity.name === "vendor/demo")!;
  assert.strictEqual(row.stats, recorded.stats);
  assert.equal(row.stats!.sessions, 2);
  assert.deepEqual(row.localBodyIds, ["mcp-a", "mcp-b"]);
  assert.deepEqual(row.clients, ["claude", "codex"]);
  assert.equal(result.counts.used, 2);
  assert.equal(result.counts.unused, 3);
  assert.equal(result.counts.review, 0);
  assert.equal(result.resources.find(row => row.identity.name === "unknown")!.stats, null);
  assert.equal(result.resources.find(row => row.identity.name === "new")!.stats?.events, 0);
  const ascending = buildResourceOverview(input, [first, second, mcpLocal("zero"), mcpLocal("unknown", "unknown", { observation: "unknown" })],
    { kind: "mcp", order: "asc" }, options);
  assert.equal(ascending.resources[0]!.identity.name, "zero");
  assert.equal(ascending.resources.at(-1)!.identity.name, "unknown");
});

test("MCP 缺失名称保持不同历史来源及本地注册，收藏与注册保护独立", () => {
  const first = mcpHistory("未记录服务器", { identity: { id: "resource:mcp-source:a", kind: "mcp", name: "未记录服务器", grouping: "source" } });
  const second = mcpHistory("未记录服务器", { identity: { id: "resource:mcp-source:b", kind: "mcp", name: "未记录服务器", grouping: "source" } });
  const shared = mcpLocal("demo", "shared-mcp", { favorite: true });
  const named = mcpLocal("named", "named-mcp");
  const result = buildResourceOverview(history([first, second]), [mcpLocal("未记录服务器", "unknown-mcp-a"), mcpLocal("未记录服务器", "unknown-mcp-b"), shared, named],
    { kind: "mcp" }, { ...options, favorites: new Set([resourceOverviewIdentity({ id: "unused", kind: "mcp", name: "named", client: "codex" }).id]) });
  assert.equal(result.total, 6);
  assert.equal(new Set(result.resources.filter(row => row.identity.name === "未记录服务器").map(row => row.identity.id)).size, 4);
  assert.equal(result.resources.find(row => row.identity.name === "demo")!.favorite, false);
  assert.equal(result.resources.find(row => row.identity.name === "demo")!.protected, true);
  assert.equal(result.resources.find(row => row.identity.name === "named")!.favorite, true);
  assert.equal(result.counts.favorite, 2);
  assert.ok(result.resources.find(row => row.identity.name === "named")!.candidates.includes("unused"));
});

test("默认低频和长期阈值包含边界，零和无可确认日期不推断闲置", () => {
  const boundary = new Date(now - 90 * 86400_000).toISOString();
  const input = [historyRow("boundary", { stats: stats({ events: 2, sessions: 2, lastUsedAt: boundary }) }),
    historyRow("above-sessions", { stats: stats({ events: 3, sessions: 3, lastUsedAt: new Date(Date.parse(boundary) + 1).toISOString() }) }),
    historyRow("undated", { stats: stats({ events: 1, sessions: 1, missingTimeEvents: 1 }) }),
    historyRow("invalid-time", { stats: stats({ events: 1, sessions: 0, lastUsedAt: "invalid" }) })];
  const result = overview(input, [local("zero")]);
  assert.deepEqual(result.resources.find(row => row.identity.name === "boundary")!.candidates, ["used", "low", "old"]);
  assert.deepEqual(result.resources.find(row => row.identity.name === "above-sessions")!.candidates, ["used"]);
  assert.deepEqual(result.resources.find(row => row.identity.name === "undated")!.candidates, ["used", "low"]);
  assert.deepEqual(result.resources.find(row => row.identity.name === "invalid-time")!.candidates, ["used"]);
  assert.deepEqual(result.resources.find(row => row.identity.name === "zero")!.candidates, ["unused"]);
});

test("真正来源读取失败保留未知且只影响所属客户端，旧 review 查询兼容全部", () => {
  const locals = [local("failed-zero"), local("readable-zero", "readable-zero", { entries: [entry("readable-zero", "claude")] })];
  const input = history([historyRow("recorded")], { partial: true, unavailableClients: ["codex"], uncertainClients: ["codex"] });
  const result = buildResourceOverview(input, locals, { candidate: "review" }, options);
  assert.equal(result.total, 3);
  assert.equal(result.counts.review, 0);
  assert.equal(result.resources.find(row => row.identity.name === "failed-zero")!.stats, null);
  assert.equal(result.resources.find(row => row.identity.name === "failed-zero")!.observation, "unknown");
  assert.equal(result.resources.find(row => row.identity.name === "readable-zero")!.stats?.events, 0);
  assert.ok(result.resources.find(row => row.identity.name === "recorded")!.candidates.includes("low"));
  assert.equal(result.resources.find(row => row.identity.name === "recorded")!.partial, true);
});

test("Skill 描述复用本地来源，同名描述冲突时不择一，历史独有与 MCP 不补造描述", () => {
  const withDescription = (body: string, description: string) => local("guide", body, { entries: [entry(body, "codex", { name: "guide", description })] });
  const first = withDescription("body-a", "  An original skill description.  ");
  const same = withDescription("body-b", "An original skill description.");
  assert.equal(overview([historyRow("guide")], [first, same]).resources[0]!.description, "An original skill description.");
  const conflict = withDescription("body-c", "A different skill description.");
  assert.equal(overview([historyRow("guide")], [first, conflict]).resources[0]!.description, undefined);
  assert.equal(overview([historyRow("history-only")]).resources[0]!.description, undefined);
  const mcp = local("server", "mcp", { body: { ...first.body, id: "mcp", name: "server", kind: "mcp" },
    entries: [entry("mcp", "codex", { name: "server", kind: "mcp", description: "This is not Skill metadata." })] });
  assert.equal(buildResourceOverview(null, [mcp], { kind: "mcp" }, options).resources[0]!.description, undefined);
});


test("已有路径关联为历史别名补描述与本地详情，不改身份或重复使用统计", () => {
  const recorded = historyRow("plugin:guide", { favoriteIds: ["origin:guide"], association: { state: "partial", entryIds: [], reason: "partial_link" } });
  const body = local("guide", "body-guide", { historyIds: ["origin:guide"], entries: [entry("body-guide", "codex", { name: "guide", description: "Original guide description." })] });
  const result = overview([recorded], [body]);
  const alias = result.resources.find(row => row.identity.name === "plugin:guide")!;
  assert.equal(alias.identity.id, recorded.identity.id);
  assert.equal(alias.description, "Original guide description.");
  assert.deepEqual(alias.localBodyIds, ["body-guide"]);
  assert.strictEqual(alias.stats, recorded.stats);
  assert.equal(result.stats!.events, 37);
  const unlinked = overview([recorded], [{ ...body, historyIds: [] }]).resources.find(row => row.identity.name === "plugin:guide")!;
  assert.equal(unlinked.description, undefined);
  assert.deepEqual(unlinked.localBodyIds, []);
});
