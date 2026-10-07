import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clientIds } from "../src/clients.js";
import type { ResourceAssociationEntry, ResourceHistoryIdentity } from "../src/resource-contracts.js";
import type { ResourceInventoryEntry } from "../src/resource-inventory-contracts.js";
import type { SessionMessage, SessionSourceMeta } from "../src/session-contracts.js";
import { StoreError } from "../src/index/store.js";
import { parseSessionSource } from "../src/sessions/parser.js";
import { SessionStore } from "../src/sessions/store.js";
import { associateResourceHistory, emptyResourceUsageStats, listResourceUsage, localResourceUsage, resourceHistoryIdentity, resourceUsageDetail, resourceUsageEvidence } from "../src/resources/usage.js";

const occurredAt = "2026-01-02T12:00:00Z";
async function fixture(run: (store: SessionStore, directory: string) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "manor-resource-usage-"));
  const store = new SessionStore(join(directory, "index.sqlite"));
  try { await run(store, directory); }
  finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

function meta(id: string, extra: Partial<SessionSourceMeta> = {}): SessionSourceMeta {
  return { id, client: "codex", clientSessionId: id, title: "人工合成资源会话", titleOrigin: "recorded",
    path: `/synthetic/history/${id}.jsonl`, sourceId: `synthetic:${id}`, messageCount: 0, turnCount: 0,
    project: "/synthetic/project", models: [], gaps: [], ...extra };
}

function message(sessionId: string, ordinal: number, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { id: `message-${ordinal}`, sessionId, ordinal, recordLine: ordinal + 1, turnId: "turn-1", kind: "tool_call",
    callId: `call-${ordinal}`, text: "人工合成正文，不应进入资源结果", occurredAt, status: "unknown", ...extra };
}

function source(store: SessionStore, summary: SessionSourceMeta, messages: SessionMessage[]) {
  const pending = store.createRevision(summary.path, "synthetic-fingerprint");
  for (const value of messages) pending.sink.message(value);
  pending.flush(); store.finishRevision(pending.revision, summary);
  return { path: summary.path, revision: pending.revision, fingerprint: "synthetic-fingerprint" };
}

test("Skill 调用和成功读取分列，同会话合并，稳定消息及来源副本不重复计数", async () => fixture(store => {
  const skill = { kind: "skill_call", name: "guide" } as const;
  const path = "/synthetic/skills/guide/SKILL.md";
  const first = source(store, meta("first"), [
    message("first", 0, { resource: skill, filePaths: [path] }),
    message("first", 1, { kind: "tool_result", callId: "call-0", status: "success", durationMs: 40, resource: skill }),
    message("first", 2, { resource: { kind: "skill_read", name: "guide" }, filePaths: [path], status: "success", durationMs: 10 }),
    message("first", 2, { resource: { kind: "skill_read", name: "guide" }, filePaths: [path], status: "success", durationMs: 10 }),
    message("first", 3, { resource: { kind: "skill_read", name: "failed-read" }, status: "failure" }),
    message("first", 4, { resource: { kind: "skill_read", name: "unknown-read" } }),
    message("first", 5, { kind: "assistant", resource: skill, text: "Skill guide mcp__demo__lookup 仅提及" }),
    message("first", 6, { tool: "functions.exec", text: "await tools.mcp__demo__lookup(); Skill guide" }),
  ]);
  const duplicate = source(store, meta("first", { path: "/synthetic/archive/first.jsonl" }), [message("first", 0, { resource: skill, filePaths: [path] })]);
  const second = source(store, meta("second"), [message("second", 0, { resource: skill, filePaths: [path], status: "failure", currentBranch: false })]);
  const fork = source(store, meta("fork", { parentSessionId: "first", relationship: "fork" }), [message("fork", 0, { resource: skill, filePaths: [path], copied: true })]);
  store.publish(store.createJob().id, [first, duplicate, second, fork], []);
  const result = listResourceUsage(store, { kind: "skill" });
  assert.equal(result.total, 1);
  assert.equal(result.stats.events, 3);
  assert.equal(result.stats.sessions, 2);
  assert.equal(result.stats.explicitCalls, 2);
  assert.equal(result.stats.successfulReads, 1);
  assert.deepEqual(result.stats.results, { success: 1, failure: 1, unknown: 0, recorded: 2, successRate: 0.5 });
  assert.deepEqual(result.stats.duration, { samples: 2, totalMs: 50, averageMs: 25 });
  const evidence = resourceUsageEvidence(store, result.resources[0]!.identity.id, { pageSize: 1 });
  assert.equal(evidence.total, 3);
  assert.equal(evidence.events[0]?.resultMessageId, "message-1");
  assert.equal(evidence.events[0]?.pairing, "unique");
  assert.equal(evidence.events[0]?.source.fingerprint, "synthetic-fingerprint");
  assert.ok(!JSON.stringify(result).includes("人工合成正文"));
  assert.ok(!JSON.stringify(evidence).includes("人工合成正文"));
  assert.ok(!("text" in evidence.events[0]!));
}));

test("MCP 按服务器聚合并下钻工具，失败计使用，成功率和耗时使用有效样本", async () => fixture(store => {
  const resource = (name: string) => ({ kind: "mcp", server: "demo", name } as const);
  const first = source(store, meta("first"), [
    message("first", 0, { resource: resource("lookup"), tool: "mcp__demo__lookup" }),
    message("first", 1, { kind: "tool_result", callId: "call-0", status: "success", durationMs: 12 }),
    message("first", 2, { resource: resource("search"), tool: "mcp__demo__search" }),
    message("first", 3, { kind: "tool_result", callId: "missing-call", status: "success", resource: resource("orphan") }),
  ]);
  const second = source(store, meta("second"), [message("second", 0, { resource: resource("lookup"), tool: "mcp__demo__lookup", status: "failure", durationMs: 0 })]);
  store.publish(store.createJob().id, [first, second], []);
  const result = listResourceUsage(store, { kind: "mcp" });
  assert.equal(result.total, 1);
  assert.equal(result.resources[0]?.identity.name, "demo");
  assert.equal(result.stats.mcpCalls, 3);
  assert.equal(result.stats.sessions, 2);
  assert.deepEqual(result.stats.results, { success: 1, failure: 1, unknown: 1, recorded: 2, successRate: 0.5 });
  assert.deepEqual(result.stats.duration, { samples: 2, totalMs: 12, averageMs: 6 });
  const id = result.resources[0]!.identity.id;
  const detail = resourceUsageDetail(store, id);
  assert.deepEqual(detail.tools.map(tool => [tool.name, tool.stats.mcpCalls]), [["lookup", 2], ["search", 1]]);
  assert.equal(detail.trend.reduce((count, day) => count + day.stats.events, 0), 3);
  assert.equal(detail.projects[0]?.stats.events, 3);
  assert.equal(resourceUsageEvidence(store, id, { tool: "lookup" }).total, 2);
  assert.equal(resourceUsageEvidence(store, id, { tool: "mcp__demo__lookup" }).total, 2);
}));

test("日期按事件时间筛选，保留缺失与无效时间，不用会话时间或结果时间补造", async () => fixture(store => {
  const resource = { kind: "skill_call", name: "guide" } as const;
  const revision = source(store, meta("dated", { startedAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-02T00:00:00Z" }), [
    message("dated", 0, { resource, occurredAt: "2026-01-02T13:00:00+01:00" }),
    message("dated", 1, { resource, occurredAt: "2026-02-01T12:00:00Z" }),
    message("dated", 2, { resource, occurredAt: undefined }),
    message("dated", 3, { resource, occurredAt: "invalid-time" }),
    message("dated", 4, { kind: "tool_result", callId: "call-2", status: "success", occurredAt }),
  ]);
  store.publish(store.createJob().id, [revision], []);
  const all = listResourceUsage(store, { kind: "skill" });
  assert.equal(all.stats.events, 4);
  assert.equal(all.stats.missingTimeEvents, 2);
  assert.equal(all.trend.reduce((count, day) => count + day.stats.events, 0) + all.stats.missingTimeEvents, all.stats.events);
  const query = { from: "2026-01-02T00:00:00Z", to: "2026-01-02T23:59:59Z" };
  const result = listResourceUsage(store, query);
  assert.equal(result.stats.events, 1);
  assert.equal(result.stats.missingTimeEvents, 2);
  assert.equal(result.stats.lastUsedAt, "2026-01-02T12:00:00.000Z");
  assert.equal(result.coverage.partial, true);
  const id = result.resources[0]!.identity.id;
  const evidence = resourceUsageEvidence(store, id, query);
  assert.equal(evidence.total, 1); assert.equal(evidence.missingTimeEvents, 2);
  assert.equal(resourceUsageDetail(store, id, query).resource.stats.events, evidence.total);
  assert.throws(() => listResourceUsage(store, { from: "invalid" }), StoreError);
  assert.throws(() => listResourceUsage(store, { from: "2026-02-01T00:00:00Z", to: "2026-01-01T00:00:00Z" }), StoreError);
}));

test("Skill 缺失名称保留来源，不用占位文案推断跨 Agent 的同一资源", async () => fixture(store => {
  const first = source(store, meta("unknown-first"), [message("unknown-first", 0, { resource: { kind: "skill_call", name: "未记录名称" }, filePaths: ["/synthetic/skills/one/SKILL.md"] })]);
  const second = source(store, meta("unknown-second", { client: "claude" }), [message("unknown-second", 0, { resource: { kind: "skill_call", name: "未记录名称" }, filePaths: ["/synthetic/skills/two/SKILL.md"] })]);
  store.publish(store.createJob().id, [first, second], []);
  const result = listResourceUsage(store, { kind: "skill" });
  assert.equal(result.total, 2);
  assert.equal(result.stats.events, 2);
  for (const row of result.resources) {
    assert.equal(row.identity.grouping, "source");
    assert.equal(row.stats.sessions, 1);
    assert.equal(resourceUsageDetail(store, row.identity.id).origins.length, 1);
    assert.equal(resourceUsageEvidence(store, row.identity.id).total, 1);
  }
}));

test("Skill 按名称跨路径、项目和 Agent 汇总；会话数取并集且筛选不改变分组标识", async () => fixture(store => {
  const revisions = clientIds.map((client, index) => source(store, meta(`agent-${index}`, { client, project: index === 0 ? undefined : "/synthetic/project" }), [
    message(`agent-${index}`, 0, { resource: { kind: "skill_call", name: "same-name" }, filePaths: ["/synthetic/skills/one/SKILL.md"] }),
    message(`agent-${index}`, 1, { resource: { kind: "skill_call", name: "same-name" }, filePaths: ["/synthetic/skills/two/SKILL.md"] }),
    message(`agent-${index}`, 2, { resource: { kind: "skill_call", name: "same-name" } }),
  ]));
  revisions.push(source(store, meta("other-project"), [message("other-project", 0, { resource: { kind: "skill_call", name: "same-name" }, filePaths: ["/synthetic/skills/one/SKILL.md"] })]));
  store.publish(store.createJob().id, revisions, []);
  const result = listResourceUsage(store);
  assert.equal(result.total, 1);
  assert.equal(result.stats.events, clientIds.length * 3 + 1);
  assert.equal(result.stats.sessions, clientIds.length + 1);
  assert.deepEqual([...result.coverage.clients].sort(), [...clientIds].sort());
  assert.ok(result.projects.some(project => project.value === null && project.stats.events === 3));
  assert.ok(result.resources.every(resource => resource.association.state === "unassociated"));
  const id = result.resources[0]!.identity.id;
  assert.equal(result.resources[0]!.identity.grouping, "skill");
  assert.equal(result.resources[0]!.identity.client, undefined);
  assert.equal(result.resources[0]!.identity.path, undefined);
  assert.equal(result.resources[0]!.stats.sessions, clientIds.length + 1);
  assert.deepEqual(result.resources[0]!.clients.sort(), [...clientIds].sort());
  const filtered = listResourceUsage(store, { client: "pi" });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.resources[0]!.identity.id, id);
  assert.equal(filtered.stats.events, 3);
  assert.equal(filtered.stats.sessions, 1);
  assert.equal(listResourceUsage(store, { project: "/synthetic/project", client: "codex" }).total, 1);
  assert.equal(listResourceUsage(store, { project: "none" }).stats.events, 3);
  assert.equal(listResourceUsage(store, { project: "none" }).stats.sessions, 1);
  assert.equal(listResourceUsage(store, { q: "two" }).stats.events, clientIds.length);
  const detail = resourceUsageDetail(store, id);
  assert.deepEqual(detail.resource.stats, result.resources[0]!.stats);
  assert.equal(detail.origins.length, clientIds.length * 3 + 1);
  assert.equal(detail.clients.length, clientIds.length);
  const evidence = resourceUsageEvidence(store, id, { pageSize: 200 });
  assert.equal(evidence.total, result.stats.events);
  assert.equal(resourceUsageEvidence(store, id, { client: "pi" }).total, 3);
  const oldId = resourceHistoryIdentity({ ...evidence.events[0]! }).id;
  const oldDetail = resourceUsageDetail(store, oldId);
  assert.equal(oldDetail.resource.identity.grouping, "source");
  assert.equal(oldDetail.origins.length, 1);
  assert.equal(resourceUsageEvidence(store, oldId).total, oldDetail.resource.stats.events);
}));

test("合并排行保留逐来源关联，部分未关联不冒充同一个本地安装，收藏不裁掉同名使用", async () => fixture(store => {
  const messages = [
    message("mixed-origins", 0, { resource: { kind: "skill_call", name: "guide" }, filePaths: ["/synthetic/skills/guide/SKILL.md"] }),
    message("mixed-origins", 1, { resource: { kind: "skill_call", name: "guide" }, filePaths: ["/synthetic/other/guide/SKILL.md"] }),
    message("mixed-origins", 2, { resource: { kind: "skill_read", name: "guide" }, status: "success" }),
  ];
  store.publish(store.createJob().id, [source(store, meta("mixed-origins"), messages)], []);
  const entries: ResourceAssociationEntry[] = [{ id: "synthetic-entry", kind: "skill", name: "guide", client: "codex",
    scope: "user", entryPath: "/synthetic/skills/guide", targetPath: "/synthetic/skills/guide" }];
  const result = listResourceUsage(store, {}, entries);
  const row = result.resources[0]!;
  assert.equal(row.stats.sessions, 1);
  assert.equal(row.stats.events, 3);
  assert.equal(row.association.state, "partial");
  assert.deepEqual(row.association.entryIds, ["synthetic-entry"]);
  assert.equal(result.coverage.unassociatedEvents, 2);
  const detail = resourceUsageDetail(store, row.identity.id, {}, entries);
  assert.equal(detail.origins.length, 3);
  assert.equal(detail.coverage.unassociatedEvents, 2);
  const oldFavorite = resourceHistoryIdentity(resourceUsageEvidence(store, row.identity.id).events[0]!).id;
  const favorites = new Set([oldFavorite]);
  const selected = listResourceUsage(store, { favorite: true }, entries, favorites);
  assert.equal(selected.total, 1);
  assert.equal(selected.resources[0]!.favorite, true);
  assert.equal(selected.stats.events, 3);
  assert.equal(selected.stats.sessions, 1);
  assert.equal(resourceUsageDetail(store, row.identity.id, {}, entries, favorites).resource.favorite, true);
  const local = localResourceUsage(store, {}, entries.map(entry => ({ ...entry, bodyId: "synthetic-body" } as ResourceInventoryEntry))).bodies.get("synthetic-body")!;
  assert.equal(local.stats.events, 1);
  assert.equal(local.historyIds.length, 1);
  assert.notEqual(local.historyIds[0], row.identity.id);
  assert.equal(resourceUsageDetail(store, local.historyIds[0]!).resource.identity.grouping, "source");
  assert.equal(resourceUsageEvidence(store, local.historyIds[0]!).total, 1);
}));

test("重复调用标识或多份结果保持未知，copied 结果不能确认新的请求", async () => fixture(store => {
  const resource = { kind: "mcp", name: "lookup", server: "demo" } as const;
  const revision = source(store, meta("ambiguous"), [
    message("ambiguous", 0, { resource, callId: "reused" }),
    message("ambiguous", 1, { resource, callId: "reused" }),
    message("ambiguous", 2, { kind: "tool_result", callId: "reused", status: "success", durationMs: 9 }),
    message("ambiguous", 3, { resource }),
    message("ambiguous", 4, { kind: "tool_result", callId: "call-3", status: "success" }),
    message("ambiguous", 5, { kind: "tool_result", callId: "call-3", status: "failure" }),
    message("ambiguous", 6, { resource }),
    message("ambiguous", 7, { kind: "tool_result", callId: "call-6", status: "success", copied: true }),
  ]);
  store.publish(store.createJob().id, [revision], []);
  const result = listResourceUsage(store);
  assert.equal(result.stats.mcpCalls, 4);
  assert.deepEqual(result.stats.results, { success: 0, failure: 0, unknown: 4, recorded: 0, successRate: null });
  assert.deepEqual(result.stats.duration, { samples: 0, totalMs: null, averageMs: null });
  const evidence = resourceUsageEvidence(store, result.resources[0]!.identity.id);
  assert.deepEqual(evidence.events.map(event => event.pairing), ["ambiguous", "ambiguous", "ambiguous", "missing"]);
  assert.ok(evidence.events.every(event => event.resultMessageId === undefined));
}));

test("资源专用筛选不漏掉同标识的普通调用，结果配对保持歧义", async () => fixture(store => {
  const revision = source(store, meta("mixed"), [
    message("mixed", 0, { resource: { kind: "mcp", server: "demo", name: "lookup" }, callId: "shared-call" }),
    message("mixed", 1, { tool: "read_file", callId: "shared-call" }),
    message("mixed", 2, { kind: "tool_result", callId: "shared-call", status: "success", durationMs: 9 }),
  ]);
  store.publish(store.createJob().id, [revision], []);
  const result = listResourceUsage(store, { kind: "mcp" });
  assert.equal(result.stats.events, 1);
  assert.deepEqual(result.stats.results, { success: 0, failure: 0, unknown: 1, recorded: 0, successRate: null });
  assert.equal(result.stats.duration.samples, 0);
  const evidence = resourceUsageEvidence(store, result.resources[0]!.identity.id);
  assert.equal(evidence.events[0]?.pairing, "ambiguous");
  assert.equal(evidence.events[0]?.resultMessageId, undefined);
}));

test("排行与证据分页不截断全部使用记录，页外统计及趋势仍覆盖全量", async () => fixture(store => {
  const count = 20_001;
  const messages = Array.from({ length: count }, (_, ordinal) => message("scale", ordinal, {
    resource: { kind: "mcp", name: ordinal % 2 ? "search" : "lookup", server: "scale-server" },
    tool: ordinal % 2 ? "mcp__scale-server__search" : "mcp__scale-server__lookup", status: "success",
  }));
  const revision = source(store, meta("scale"), messages);
  const others = source(store, meta("others"), Array.from({ length: 205 }, (_, ordinal) => message("others", ordinal, {
    resource: { kind: "skill_call", name: `skill-${String(ordinal).padStart(3, "0")}` },
  })));
  const version = store.publish(store.createJob().id, [revision, others], []);
  const result = listResourceUsage(store, { pageSize: 1 });
  assert.equal(result.version, version);
  assert.equal(result.resources.length, 1);
  assert.equal(result.total, 206);
  assert.equal(result.stats.events, count + 205);
  assert.equal(result.trend.reduce((total, day) => total + day.stats.events, 0), count + 205);
  const mcp = listResourceUsage(store, { kind: "mcp", pageSize: 1 }).resources[0]!;
  const last = resourceUsageEvidence(store, mcp.identity.id, { page: 101, pageSize: 200 });
  assert.equal(last.total, count);
  assert.equal(last.events.length, 1);
  assert.equal(last.events[0]?.ordinal, count - 1);
  assert.equal(resourceUsageDetail(store, mcp.identity.id).tools.reduce((total, tool) => total + tool.stats.events, 0), count);
  assert.equal(listResourceUsage(store, { kind: "skill", page: 2, pageSize: 200 }).resources.length, 5);
}));

test("关联当前入口需要路径与范围，名称相同及共享目标歧义不能证明安装身份", () => {
  const identity: ResourceHistoryIdentity = { id: "synthetic-resource", kind: "skill", name: "guide", client: "codex",
    project: "/synthetic/project", path: "/synthetic/skills/guide" };
  const entry: ResourceAssociationEntry = { id: "entry-one", kind: "skill", name: "guide", client: "codex", scope: "user",
    entryPath: "/synthetic/skills/guide/SKILL.md", targetPath: "/synthetic/shared/guide" };
  assert.deepEqual(associateResourceHistory(identity, [entry]), { state: "linked", entryIds: ["entry-one"], reason: "recorded_path" });
  assert.equal(associateResourceHistory({ ...identity, path: undefined }, [entry]).reason, "missing_path");
  assert.equal(associateResourceHistory(identity, [{ ...entry, entryPath: "/synthetic/other/guide" }]).state, "unassociated");
  assert.equal(associateResourceHistory(identity, [{ ...entry, client: "claude" }]).state, "unassociated");
  assert.equal(associateResourceHistory(identity, [{ ...entry, scope: "project", project: "/synthetic/other-project" }]).state, "unassociated");
  const shared = { ...identity, path: "/synthetic/shared/guide" };
  assert.deepEqual(associateResourceHistory(shared, [entry, { ...entry, id: "entry-two", entryPath: "/synthetic/other/guide" }]),
    { state: "ambiguous", entryIds: ["entry-one", "entry-two"], reason: "multiple_entries" });
});

test("共享目标的多个入口可保持入口歧义，但已确认本体用量不丢失或重复", async () => fixture(store => {
  const entries: ResourceInventoryEntry[] = ["one", "two"].map(id => ({ id, sourceId: id, bodyId: "shared-body", kind: "skill", name: "guide", client: "codex",
    scope: "user", entryPath: `/synthetic/links/${id}`, targetPath: "/synthetic/shared/guide", entryType: "symlink", readState: "present",
    nativeState: "unknown", sourceFormat: "skill-directory", observedAt: occurredAt, protected: false, locator: { type: "skill" },
    capabilities: { inventory: true, associate: true, disable: false, standby: false, restore: false, trash: false, purge: false } }));
  const revision = source(store, meta("shared"), [
    message("shared", 0, { resource: { kind: "skill_read", name: "guide" }, filePaths: ["/synthetic/shared/guide/SKILL.md"], status: "success" }),
    message("shared", 1, { resource: { kind: "skill_call", name: "guide" }, filePaths: ["/synthetic/links/one/SKILL.md"], status: "success" }),
  ]);
  store.publish(store.createJob().id, [revision], []);
  const usage = localResourceUsage(store, {}, entries);
  assert.equal(usage.bodies.get("shared-body")?.stats.successfulReads, 1);
  assert.equal(usage.bodies.get("shared-body")?.stats.explicitCalls, 1);
  assert.equal(usage.bodies.get("shared-body")?.stats.sessions, 1);
  const ambiguous = localResourceUsage(store, {}, [entries[0]!, { ...entries[1]!, bodyId: "different-body" }]);
  assert.equal(ambiguous.bodies.get("shared-body")?.stats.successfulReads, 0);
  assert.ok(ambiguous.uncertain.size);
}));

test("共享本体趋势与客户端、项目分布取同一事件范围，会话取并集，未知时间不补入趋势", async () => fixture(store => {
  const entries: ResourceInventoryEntry[] = ["codex", "claude"].map((client, index) => ({
    id: `entry-${client}`, sourceId: `source-${client}`, bodyId: "shared-body", kind: "skill", name: "guide", client: client as "codex" | "claude",
    scope: "project", project: `/synthetic/project-${index}`, entryPath: `/synthetic/links/${client}`, targetPath: "/synthetic/shared/guide",
    entryType: "symlink", readState: "present", nativeState: "unknown", sourceFormat: "skill-directory", observedAt: occurredAt,
    protected: false, locator: { type: "skill" },
    capabilities: { inventory: true, associate: true, disable: false, standby: false, restore: false, trash: false, purge: false },
  }));
  const firstTime = new Date(2026, 0, 2, 12).toISOString();
  const secondTime = new Date(2026, 0, 3, 12).toISOString();
  const first = source(store, meta("first-client", { project: entries[0]!.project }), [
    message("first-client", 0, { resource: { kind: "skill_call", name: "guide" }, filePaths: ["/synthetic/links/codex/SKILL.md"], occurredAt: firstTime, status: "success" }),
    message("first-client", 1, { resource: { kind: "skill_read", name: "guide" }, filePaths: ["/synthetic/shared/guide/SKILL.md"], occurredAt: undefined, status: "success" }),
  ]);
  const second = source(store, meta("second-client", { client: "claude", project: entries[1]!.project }), [
    message("second-client", 0, { resource: { kind: "skill_call", name: "guide" }, filePaths: ["/synthetic/links/claude/SKILL.md"], occurredAt: secondTime, status: "unknown" }),
  ]);
  store.publish(store.createJob().id, [first, second], []);
  const usage = localResourceUsage(store, {}, entries);
  const body = usage.bodies.get("shared-body")!;
  assert.equal(usage.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(body.stats.events, 3);
  assert.equal(body.stats.sessions, 2);
  assert.equal(body.stats.missingTimeEvents, 1);
  assert.equal(body.stats.results.unknown, 1);
  assert.equal(body.stats.duration.totalMs, null);
  assert.deepEqual(body.trend.map(day => [day.date, day.stats.events, day.stats.sessions]), [["2026-01-02", 1, 1], ["2026-01-03", 1, 1]]);
  assert.equal(body.trend.reduce((count, day) => count + day.stats.events, 0) + body.stats.missingTimeEvents, body.stats.events);
  assert.deepEqual(body.clients.map(client => [client.value, client.stats.events, client.stats.sessions]), [["codex", 2, 1], ["claude", 1, 1]]);
  assert.deepEqual(body.projects.map(project => [project.value, project.stats.events, project.stats.sessions]), [["/synthetic/project-0", 2, 1], ["/synthetic/project-1", 1, 1]]);
  for (const distribution of [body.clients, body.projects]) {
    assert.equal(distribution.reduce((count, group) => count + group.stats.events, 0), body.stats.events);
  }
  const dated = localResourceUsage(store, { from: firstTime, to: secondTime }, entries).bodies.get("shared-body")!;
  assert.equal(dated.stats.events, 2);
  assert.equal(dated.stats.sessions, 2);
  assert.equal(dated.stats.missingTimeEvents, 1);
  assert.equal(dated.trend.reduce((count, day) => count + day.stats.events, 0), dated.stats.events);
  assert.equal(dated.clients.reduce((count, client) => count + client.stats.events, 0), dated.stats.events);
  assert.equal(dated.projects.reduce((count, project) => count + project.stats.events, 0), dated.stats.events);
  const selected = localResourceUsage(store, { client: "claude", project: entries[1]!.project }, entries).bodies.get("shared-body")!;
  assert.equal(selected.stats.events, 1);
  assert.deepEqual(selected.clients.map(client => client.value), ["claude"]);
  assert.deepEqual(selected.projects.map(project => project.value), ["/synthetic/project-1"]);
}));

test("无证据指标工厂返回独立的零计数，结果率和耗时保持未知", () => {
  const first = emptyResourceUsageStats();
  assert.equal(first.events, 0);
  assert.equal(first.sessions, 0);
  assert.equal(first.lastUsedAt, null);
  assert.equal(first.results.successRate, null);
  assert.equal(first.duration.totalMs, null);
  assert.equal(first.duration.averageMs, null);
  first.results.unknown += 1;
  assert.equal(emptyResourceUsageStats().results.unknown, 0);
});

test("真实解析器到索引保留成功 Skill 正文读取，文本提及和外层脚本代码不计调用", async () => fixture(async (store, directory) => {
  const path = join(directory, "synthetic.jsonl");
  const response = (payload: unknown) => ({ type: "response_item", timestamp: occurredAt, payload });
  const call = (id: string, name: string, input: unknown) => response({ type: "function_call", id: `request-${id}`, call_id: id, name, arguments: JSON.stringify(input) });
  const result = (id: string, output: unknown) => response({ type: "function_call_output", id: `result-${id}`, call_id: id, output: typeof output === "string" ? output : JSON.stringify(output) });
  const records = [
    { type: "session_meta", timestamp: occurredAt, payload: { id: "synthetic-parse", cwd: "/synthetic/project" } },
    response({ type: "message", id: "question", role: "user", content: [{ type: "input_text", text: "提及 guide 和 mcp__demo__lookup" }] }),
    call("read", "Read", { file_path: "/synthetic/skills/guide/SKILL.md" }), result("read", { success: true, content: "人工 Skill 指令" }),
    call("failed", "Read", { file_path: "/synthetic/skills/failed/SKILL.md" }), result("failed", { success: false, content: "错误" }),
    call("empty", "Read", { file_path: "/synthetic/skills/empty/SKILL.md" }), result("empty", ""),
    call("shell", "shell_command", { command: "cat /synthetic/skills/shell-guide/SKILL.md" }), result("shell", "Exit code: 0\nOutput:\n# 人工 Skill 指令\n"),
    call("wrapper", "functions.exec", { code: "await tools.mcp__demo__lookup(); await tools.Skill({skill:'guide'});" }), result("wrapper", "合成输出"),
    call("explicit", "Skill", { skill: "guide" }), result("explicit", { success: false }),
    call("mcp", "mcp__demo__lookup", {}), result("mcp", { success: true }),
  ];
  await writeFile(path, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const pending = store.createRevision(path, "synthetic-parser-fingerprint");
  const summary = await parseSessionSource({ client: "codex", path }, pending.sink);
  pending.flush(); store.finishRevision(pending.revision, summary);
  store.publish(store.createJob().id, [{ path, revision: pending.revision, fingerprint: "synthetic-parser-fingerprint" }], []);
  const usage = listResourceUsage(store);
  assert.equal(usage.stats.successfulReads, 2);
  assert.equal(usage.stats.explicitCalls, 1);
  assert.equal(usage.stats.mcpCalls, 1);
  assert.equal(usage.stats.events, 4);
  assert.ok(usage.resources.filter(resource => resource.stats.successfulReads).every(resource =>
    resourceUsageEvidence(store, resource.identity.id, { evidenceKind: "skill_read" }).events.every(event => event.path !== undefined)));
  assert.equal(usage.resources.find(resource => resource.stats.explicitCalls)?.association.reason, "missing_path");
}));
