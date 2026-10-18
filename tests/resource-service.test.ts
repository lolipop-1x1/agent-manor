import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import { resourceFixture } from "../scripts/resource-fixture.mjs";
import { startService } from "../src/server.js";
import { apiRequest, delay } from "../src/service/runtime.js";
import { createProgram } from "../src/cli.js";
import type { ResourceLocalResult, ResourceMapResult, ResourceMapSummary, ResourceOverviewDetail, ResourceOverviewResult, ResourceOverviewSummary, ResourceStatus, ResourceStatusSummary } from "../src/resource-service-contracts.js";
import type { ResourceUsageDetail, ResourceUsageDetailSummary, ResourceUsageEvidenceResult, ResourceUsageResult } from "../src/resource-contracts.js";
import { resourceHistoryIdentity } from "../src/resources/usage.js";
import type { ResourceManagementOperation, ResourceManagementPreview } from "../src/resource-management-contracts.js";
import type { SessionIndexStatus, SessionIndexSummary, SessionJob } from "../src/session-contracts.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

const run = promisify(execFile);
async function fixture(callback: (context: Awaited<ReturnType<typeof resourceFixture>>, service: Awaited<ReturnType<typeof startService>>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-resource-http-"));
  const context = await resourceFixture(directory);
  await run("git", ["init", "-q", context.project]);
  const service = await startService({ home: context.home, roots: isolatedHistoryRoots({ codex: context.history }),
    resourceInventory: { userHome: context.userHome }, staticRoot: join(directory, "empty-web") });
  try {
    for (let attempt = 0; attempt < 400; attempt++) {
      const state = await apiRequest<SessionIndexStatus>(service.instance, "/sessions/status");
      if (state.job?.status === "failed") assert.fail(state.job.error);
      if (state.version) break;
      await delay(25);
    }
    await callback(context, service);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
}

test("资源 HTTP 使用全部历史、可回查事件，来源公开投影不含注册值", async () => fixture(async (context, service) => {
  const status = await apiRequest<ResourceStatus>(service.instance, "/resources/status");
  assert.ok(status.projects.includes(context.project));
  assert.ok(!JSON.stringify(status).includes("synthetic-secret"));
  const local = await apiRequest<ResourceLocalResult>(service.instance, "/resources/local?kind=skill&pageSize=1");
  assert.equal(local.rows.length, 1);
  assert.ok(local.total > 40);
  const all = await apiRequest<ResourceLocalResult>(service.instance, "/resources/local?kind=skill&pageSize=200");
  const guide = all.rows.find(row => row.body.name === "guide")!;
  assert.equal(guide.usage?.successfulReads, 1);
  assert.equal(guide.usage?.sessions, 1);
  const management = new Database(join(context.home, "resources.sqlite"));
  management.prepare("UPDATE resource_seen SET first_seen=?").run("2025-01-01T00:00:00Z");
  management.close();
  const unused = await apiRequest<ResourceLocalResult>(service.instance, "/resources/local?kind=skill&candidate=unused");
  assert.ok(unused.rows.length);
  assert.equal(unused.rows[0]!.observation, "recorded");
  assert.equal(unused.rows[0]!.usage?.sessions, 0);
  assert.equal(unused.rows[0]!.usage?.explicitCalls, 0);
  const usage = await apiRequest<ResourceUsageResult>(service.instance, "/resources/usage?kind=mcp");
  assert.equal(usage.stats.mcpCalls, 2);
  assert.equal(usage.resources[0]?.association.state, "unassociated");
  const id = usage.resources[0]!.identity.id;
  const detail = await apiRequest<{ tools: unknown[] }>(service.instance, `/resources/usage/${encodeURIComponent(id)}`);
  assert.equal(detail.tools.length, 2);
  const evidence = await apiRequest<{ total: number; events: { messageId: string }[] }>(service.instance, `/resources/usage/${encodeURIComponent(id)}/evidence?pageSize=1`);
  assert.equal(evidence.total, 2); assert.equal(evidence.events.length, 1); assert.ok(evidence.events[0]?.messageId);
  await apiRequest(service.instance, "/resources/favorites", "POST", { id, value: true });
  assert.equal((await apiRequest<ResourceUsageResult>(service.instance, "/resources/usage?favorite=true")).total, 1);
  await apiRequest(service.instance, "/resources/favorites", "POST", { id, value: false });
  assert.equal((await apiRequest<ResourceUsageResult>(service.instance, "/resources/usage?favorite=true")).total, 0);
  const skillUsage = await apiRequest<ResourceUsageResult>(service.instance, "/resources/usage?kind=skill");
  const historyId = skillUsage.resources.find(row => row.identity.name === "guide")!.identity.id;
  const skillEvidence = await apiRequest<ResourceUsageEvidenceResult>(service.instance, `/resources/usage/${encodeURIComponent(historyId)}/evidence`);
  const legacyId = resourceHistoryIdentity(skillEvidence.events[0]!).id;
  await apiRequest(service.instance, "/resources/favorites", "POST", { id: legacyId, value: true });
  const inherited = await apiRequest<ResourceUsageResult>(service.instance, "/resources/usage?kind=skill&favorite=true");
  assert.equal(inherited.resources.find(row => row.identity.id === historyId)!.favorite, true);
  await apiRequest(service.instance, "/resources/favorites", "POST", { id: guide.body.id, value: true });
  await apiRequest(service.instance, "/resources/favorites", "POST", { id: historyId, value: false });
  const favoritesAfter = await apiRequest<ResourceStatus>(service.instance, "/resources/status");
  assert.ok(!favoritesAfter.favoriteIds.includes(legacyId));
  assert.ok(favoritesAfter.favoriteIds.includes(guide.body.id));
  await apiRequest(service.instance, "/resources/favorites", "POST", { id: guide.body.id, value: false });
  await apiRequest(service.instance, "/resources/favorites", "POST", { id: historyId, value: true });
  const protectedPreview = await apiRequest<ResourceManagementPreview>(service.instance, "/resources/preview", "POST", { entryId: guide.entries[0]!.id, action: "standby" });
  assert.equal(protectedPreview.protected, true);
  await apiRequest(service.instance, "/resources/favorites", "POST", { id: historyId, value: false });
  const changedProtection = await apiRequest<ResourceManagementOperation>(service.instance, "/resources/apply", "POST", { previewId: protectedPreview.id, confirmed: true });
  assert.equal(changedProtection.status, "conflict");
  assert.ok(await readFile(join(context.guide, "SKILL.md")));
  for (const query of ["kind=unknown", "client=unknown", "candidate=unknown", "page=0", "favorite=maybe", "from=no", "lowSessions=0"]) {
    await assert.rejects(apiRequest(service.instance, `/resources/local?${query}`), { code: "INVALID_INPUT" });
  }
}));

test("页面摘要省略诊断正文，完整接口和按版本缺口仍可读取", async () => fixture(async (_context, service) => {
  const full = await apiRequest<ResourceStatus>(service.instance, "/resources/status");
  const summary = await apiRequest<ResourceStatusSummary>(service.instance, "/resources/status?summary=true");
  assert.deepEqual(summary.projects, full.projects);
  assert.deepEqual(summary.clientOptions, full.clientOptions);
  assert.deepEqual(summary.favoriteIds, full.favoriteIds);
  assert.equal(summary.observedAt, full.observedAt);
  assert.equal("sources" in summary, false);
  assert.equal("diagnostics" in summary, false);
  assert.equal(summary.sourceIssues.length, full.gaps.filter(gap => full.sources.some(source => source.id === gap.sourceId)).length);
  for (const kind of ["skill", "mcp"]) {
    const overview = await apiRequest<ResourceOverviewResult>(service.instance, `/resources/overview?kind=${kind}`);
    const compact = await apiRequest<ResourceOverviewSummary>(service.instance, `/resources/overview?kind=${kind}&summary=true`);
    const { gaps: _gaps, ...coverage } = overview.coverage!;
    assert.deepEqual(compact, { ...overview, coverage });
    const map = await apiRequest<ResourceMapResult>(service.instance, `/resources/map?kind=${kind}`);
    const compactMap = await apiRequest<ResourceMapSummary>(service.instance, `/resources/map?kind=${kind}&summary=true`);
    const { gaps: _mapGaps, ...mapCoverage } = map.coverage!;
    assert.deepEqual(compactMap, { ...map, coverage: mapCoverage });
    const row = overview.resources.find(resource => resource.hasHistory)!;
    const id = encodeURIComponent(row.identity.id);
    const fullDetail = await apiRequest<ResourceOverviewDetail>(service.instance, `/resources/overview/${id}?kind=${kind}`);
    const light = await apiRequest<ResourceOverviewDetail>(service.instance, `/resources/overview/${id}?kind=${kind}&section=overview`);
    assert.deepEqual(light, { ...fullDetail, history: null }, "轻量概览不执行或传输完整历史详情");
    assert.equal(light.version, fullDetail.history!.version);
    const detail = await apiRequest<ResourceUsageDetail>(service.instance, `/resources/usage/${id}?kind=${kind}&version=${light.version}`);
    const detailSummary = await apiRequest<ResourceUsageDetailSummary>(service.instance, `/resources/usage/${id}?kind=${kind}&version=${light.version}&summary=true`);
    const { gaps: detailGaps, ...detailCoverage } = detail.coverage;
    assert.deepEqual(detailSummary, { ...detail, coverage: { ...detailCoverage, gapCount: detailGaps.length } });
    assert.equal("gaps" in detailSummary.coverage, false);
  }
  const session = await apiRequest<SessionIndexStatus>(service.instance, "/sessions/status");
  const compactSession = await apiRequest<SessionIndexSummary>(service.instance, "/sessions/status?summary=true");
  const { gaps, ...sessionFields } = session;
  assert.deepEqual(compactSession, { ...sessionFields, gapCount: gaps.length });
  assert.deepEqual(await apiRequest(service.instance, `/sessions/gaps?version=${session.version}`), { version: session.version, gaps });
  await assert.rejects(apiRequest(service.instance, "/resources/status?summary=invalid"), /summary/);
  await assert.rejects(apiRequest(service.instance, "/resources/overview/resource:invalid?section=invalid"), { code: "INVALID_INPUT" });
}));

test("本地与总览的低频及长期未用阈值一致，包含时间边界", async testContext => fixture(async (_context, service) => {
  const initial = await apiRequest<ResourceLocalResult>(service.instance, "/resources/local?kind=skill&q=guide");
  const guide = initial.rows[0]!;
  testContext.mock.method(Date, "now", () => Date.parse(guide.usage!.lastUsedAt!) + 90 * 86400_000);
  for (const [query, expected] of [["", ["low", "old"]], ["&lowSessions=1&inactiveDays=91", ["low"]]] as const) {
    const local = await apiRequest<ResourceLocalResult>(service.instance, `/resources/local?kind=skill&q=guide${query}`);
    const overview = await apiRequest<ResourceOverviewResult>(service.instance, `/resources/overview?kind=skill&q=guide${query}`);
    assert.equal(local.total, 1);
    assert.equal(overview.total, 1);
    assert.deepEqual(local.rows[0]!.candidates, expected);
    assert.deepEqual(overview.resources[0]!.candidates.filter(candidate => candidate === "low" || candidate === "old"), expected);
    assert.deepEqual(local.thresholds, overview.thresholds);
    assert.deepEqual(local.rows[0]!.usage, guide.usage);
    assert.deepEqual(overview.resources[0]!.stats, guide.usage);
  }
}));

test("资源写入必须确认具体预览，管理状态不随历史缓存重建清除", async () => fixture(async (context, service) => {
  const local = await apiRequest<ResourceLocalResult>(service.instance, "/resources/local?kind=skill&pageSize=200");
  const guide = local.rows.find(row => row.body.name === "guide")!;
  const entry = guide.entries.find(entry => entry.client === "codex")!;
  const id = guide.body.id;
  await apiRequest(service.instance, "/resources/favorites", "POST", { id, value: true });
  const manual = join(context.directory, "manual"); await mkdir(manual);
  await apiRequest(service.instance, "/resources/sources", "POST", { path: manual, client: "codex", kind: "skill" });
  const preview = await apiRequest<ResourceManagementPreview>(service.instance, "/resources/preview", "POST", { entryId: entry.id, action: "standby" });
  await assert.rejects(apiRequest(service.instance, "/resources/apply", "POST", { previewId: preview.id, confirmed: false }), { code: "INVALID_INPUT" });
  const applied = await apiRequest<ResourceManagementOperation>(service.instance, "/resources/apply", "POST", { previewId: preview.id, confirmed: true });
  assert.equal(applied.status, "success"); assert.equal(applied.clientEffect, "unknown");
  await assert.rejects(readFile(join(context.guide, "SKILL.md")), { code: "ENOENT" });
  const { job } = await apiRequest<{ job: SessionJob }>(service.instance, "/sessions/cache", "DELETE");
  for (let attempt = 0; attempt < 400; attempt++) {
    const result = await apiRequest<{ job: SessionJob }>(service.instance, `/jobs/${job.id}`);
    if (result.job.status === "complete") break;
    assert.notEqual(result.job.status, "failed", result.job.error);
    await delay(25);
  }
  const status = await apiRequest<ResourceStatus>(service.instance, "/resources/status");
  assert.ok(status.favoriteIds.includes(id)); assert.equal(status.manualSources.length, 1);
  const archive = await apiRequest<{ archives: { operationId: string }[]; total: number }>(service.instance, "/resources/archives?state=standby");
  assert.equal(archive.total, 1);
  const restore = await apiRequest<ResourceManagementPreview>(service.instance, "/resources/preview", "POST", { operationId: applied.id, action: "restore" });
  const result = await apiRequest<ResourceManagementOperation>(service.instance, "/resources/apply", "POST", { previewId: restore.id, confirmed: true });
  assert.equal(result.status, "success"); assert.equal(await readFile(join(context.guide, "asset.txt"), "utf8"), "保留资源附件\n");
  const response = await fetch(`http://127.0.0.1:${service.instance.port}/api/v1/resources/favorites`, {
    method: "POST", headers: { Origin: "https://example.invalid", "Content-Type": "application/json" }, body: JSON.stringify({ id, value: false }),
  });
  assert.equal(response.status, 403);
}));

test("CLI 资源入口共用 API，执行操作保留显式确认参数", () => {
  const resources = createProgram().commands.find(command => command.name() === "resources")!;
  for (const name of ["status", "refresh", "overview", "usage", "local", "detail", "evidence", "favorite", "archives", "operations", "source-add", "source-remove", "preview", "apply"]) {
    assert.ok(resources.commands.some(command => command.name() === name), name);
  }
  const apply = resources.commands.find(command => command.name() === "apply")!;
  assert.ok(apply.options.find(option => option.long === "--confirm")?.mandatory);
});

test("Skill 总览新发现立即分类，快筛计数先于分页，读取未知不补零", async () => fixture(async (context, service) => {
  const first = await apiRequest<ResourceOverviewResult>(service.instance, "/resources/overview?pageSize=100");
  assert.ok(first.total > 40);
  assert.equal(first.counts.used, 1);
  assert.ok(first.counts.unused > 40);
  const recent = first.resources.find(row => row.identity.name === "sample-00")!;
  assert.equal(recent.stats?.events, 0);
  assert.equal(recent.observation, "unused");
  const unknown = first.resources.find(row => row.identity.name === "shared")!;
  assert.equal(unknown.observation, "unused");
  const management = new Database(join(context.home, "resources.sqlite"));
  management.prepare("UPDATE resource_seen SET first_seen=?").run("2025-01-01T00:00:00Z");
  management.close();
  await apiRequest(service.instance, "/resources/refresh", "POST", {});
  const all = await apiRequest<ResourceOverviewResult>(service.instance, "/resources/overview?pageSize=100");
  const zero = all.resources.find(row => row.identity.name === "sample-00")!;
  assert.equal(zero.observation, "unused");
  assert.equal(zero.stats?.sessions, 0);
  const ascending = await apiRequest<ResourceLocalResult>(service.instance, "/resources/local?kind=skill&sort=sessions&order=asc&pageSize=200");
  assert.equal(ascending.rows[0]!.usage?.sessions, 0);
  const lastKnown = ascending.rows.filter(row => row.usage).at(-1)!;
  assert.equal(lastKnown.body.name, "guide");
  assert.equal(ascending.rows.at(-1)!.usage, null);
  const namesDescending = await apiRequest<ResourceLocalResult>(service.instance, "/resources/local?kind=skill&sort=name&order=desc&pageSize=200");
  assert.deepEqual(namesDescending.rows.map(row => row.body.name), namesDescending.rows.map(row => row.body.name).sort((a, b) => b.localeCompare(a)));
  const used = await apiRequest<ResourceOverviewResult>(service.instance, "/resources/overview?candidate=used");
  assert.equal(used.total, 1);
  assert.deepEqual(used.counts, all.counts);
  const last = await apiRequest<ResourceOverviewResult>(service.instance, "/resources/overview?page=999&pageSize=20");
  assert.equal(last.page, Math.ceil(all.total / 20));
  assert.ok(last.resources.length > 0);
  const detail = await apiRequest<ResourceOverviewDetail>(service.instance, `/resources/overview/${zero.identity.id}`);
  assert.equal(detail.history, null);
  assert.equal(detail.local[0]!.body.id, zero.localBodyIds[0]);
  await apiRequest(service.instance, "/resources/favorites", "POST", { id: zero.identity.id, value: true });
  const favorite = await apiRequest<ResourceOverviewResult>(service.instance, "/resources/overview?candidate=favorite");
  assert.equal(favorite.total, 1);
  assert.equal(favorite.resources[0]!.identity.id, zero.identity.id);
  assert.equal(favorite.resources[0]!.protected, true);
  const unused = await apiRequest<ResourceOverviewResult>(service.instance, "/resources/overview?candidate=unused");
  assert.ok(unused.resources.some(row => row.identity.id === zero.identity.id));
  assert.equal(unused.total, all.counts.unused);
  const preview = await apiRequest<ResourceManagementPreview>(service.instance, "/resources/preview", "POST", { action: "standby", entryId: detail.local[0]!.entries[0]!.id });
  assert.equal(preview.protected, true);
  for (const query of ["candidate=broken", "kind=unknown", "order=random", "pageSize=0"]) await assert.rejects(apiRequest(service.instance, `/resources/overview?${query}`), { code: "INVALID_INPUT" });
}));

test("MCP HTTP 总览包含本地注册与完整历史，收藏不合并管理对象且旧来源可达", async () => fixture(async (context, service) => {
  const before = await apiRequest<ResourceUsageResult>(service.instance, "/resources/usage?kind=mcp");
  const all = await apiRequest<ResourceOverviewResult>(service.instance, "/resources/overview?kind=mcp&project=/ignored/scope");
  assert.equal(all.total, 3);
  assert.equal(all.counts.used, 1);
  assert.equal(all.counts.review, 0);
  const sample = all.resources[0]!;
  assert.equal(sample.identity.name, "sample");
  assert.equal(sample.identity.grouping, "mcp");
  assert.equal(sample.stats!.mcpCalls, 2);
  assert.equal(sample.stats!.sessions, 1);
  assert.equal(sample.localBodyIds.length, 1);
  const detail = await apiRequest<ResourceOverviewDetail>(service.instance, `/resources/overview/${sample.identity.id}?kind=mcp`);
  assert.equal(detail.local.length, 1);
  assert.equal(detail.history!.tools.length, 2);
  assert.equal(detail.history!.resource.stats.mcpCalls, 2);
  assert.equal(detail.history!.origins.length, 1);
  const evidence = await apiRequest<ResourceUsageEvidenceResult>(service.instance, `/resources/usage/${sample.identity.id}/evidence?kind=mcp&tool=lookup`);
  assert.equal(evidence.total, 1);
  const oldId = before.resources[0]!.identity.id;
  assert.notEqual(oldId, sample.identity.id);
  const oldDetail = await apiRequest<ResourceOverviewDetail>(service.instance, `/resources/overview/${oldId}?kind=mcp`);
  assert.equal(oldDetail.resource.identity.grouping, "source");
  assert.equal(oldDetail.history!.resource.stats.mcpCalls, 2);
  await apiRequest(service.instance, "/resources/favorites", "POST", { id: oldId, value: true });
  const inherited = await apiRequest<ResourceOverviewResult>(service.instance, "/resources/overview?kind=mcp&candidate=favorite");
  assert.equal(inherited.total, 1);
  assert.equal(inherited.resources[0]!.identity.id, sample.identity.id);
  assert.equal(inherited.resources[0]!.favorite, true);
  await apiRequest(service.instance, "/resources/favorites", "POST", { id: detail.local[0]!.body.id, value: true });
  await apiRequest(service.instance, "/resources/favorites", "POST", { id: sample.identity.id, value: false });
  const favorites = await apiRequest<ResourceStatus>(service.instance, "/resources/status");
  assert.ok(!favorites.favoriteIds.includes(oldId));
  assert.ok(favorites.favoriteIds.includes(detail.local[0]!.body.id));
  const independent = await apiRequest<ResourceOverviewDetail>(service.instance, `/resources/overview/${sample.identity.id}?kind=mcp`);
  assert.equal(independent.resource.favorite, false);
  assert.equal(independent.resource.protected, true);
  await apiRequest(service.instance, "/resources/favorites", "POST", { id: detail.local[0]!.body.id, value: false });
  await apiRequest(service.instance, "/resources/favorites", "POST", { id: sample.identity.id, value: true });
  const preview = await apiRequest<ResourceManagementPreview>(service.instance, "/resources/preview", "POST", {
    entryId: detail.local[0]!.entries[0]!.id, action: "standby" });
  assert.equal(preview.protected, true);
  await apiRequest(service.instance, "/resources/favorites", "POST", { id: sample.identity.id, value: false });
  assert.deepEqual(await apiRequest<ResourceUsageResult>(service.instance, "/resources/usage?kind=mcp"), before);
  const management = new Database(join(context.home, "resources.sqlite"));
  management.prepare("UPDATE resource_seen SET first_seen=?").run("2025-01-01T00:00:00Z");
  management.close();
  await apiRequest(service.instance, "/resources/refresh", "POST", {});
  const unused = await apiRequest<ResourceOverviewResult>(service.instance, "/resources/overview?kind=mcp&candidate=unused");
  assert.equal(unused.total, 2);
  assert.ok(unused.resources.every(row => row.stats?.mcpCalls === 0 && row.observation === "unused"));
  assert.equal((await apiRequest<ResourceOverviewDetail>(service.instance, `/resources/overview/${unused.resources[0]!.identity.id}?kind=mcp`)).history, null);
}));

test("同名历史未关联保留提示，已关联使用仍按最近记录分类", async () => fixture(async (context, service) => {
  await appendFile(context.source, JSON.stringify({ type: "response_item", timestamp: new Date().toISOString(),
    payload: { type: "function_call", name: "Skill", call_id: "unassociated-call", arguments: JSON.stringify({ skill: "guide" }) } }) + "\n");
  const { job } = await apiRequest<{ job: SessionJob }>(service.instance, "/sessions/refresh", "POST");
  for (let attempt = 0; attempt < 400; attempt++) {
    const result = await apiRequest<{ job: SessionJob }>(service.instance, `/jobs/${job.id}`);
    if (result.job.status === "complete") break;
    assert.notEqual(result.job.status, "failed", result.job.error);
    await delay(25);
  }
  const all = await apiRequest<ResourceLocalResult>(service.instance, "/resources/local?kind=skill&q=guide");
  assert.equal(all.rows[0]!.usage?.successfulReads, 1);
  assert.equal(all.rows[0]!.usageUnassociated, true);
  assert.equal(all.rows[0]!.partial, true);
  const old = await apiRequest<ResourceLocalResult>(service.instance, "/resources/local?kind=skill&q=guide&candidate=old&inactiveDays=1");
  assert.equal(old.total, 1);
}));

test("日期筛选中的无时间 Skill 记录保持未知，名称及旧来源详情都不返回假零", async () => fixture(async (context, service) => {
  await appendFile(context.source, JSON.stringify({ type: "response_item",
    payload: { type: "function_call", name: "Skill", call_id: "undated", arguments: JSON.stringify({ skill: "undated-guide" }) } }) + "\n");
  const { job } = await apiRequest<{ job: SessionJob }>(service.instance, "/sessions/refresh", "POST");
  for (let attempt = 0; attempt < 400; attempt++) {
    const result = await apiRequest<{ job: SessionJob }>(service.instance, `/jobs/${job.id}`);
    if (result.job.status === "complete") break;
    assert.notEqual(result.job.status, "failed", result.job.error);
    await delay(25);
  }
  const all = await apiRequest<ResourceOverviewResult>(service.instance, "/resources/overview?q=undated-guide&from=2090-01-01T00:00:00Z");
  const row = all.resources[0]!;
  assert.equal(row.observation, "unknown");
  assert.equal(row.stats, null);
  const evidence = await apiRequest<ResourceUsageEvidenceResult>(service.instance, `/resources/usage/${row.identity.id}/evidence`);
  const rawId = resourceHistoryIdentity(evidence.events[0]!).id;
  for (const id of [row.identity.id, rawId]) {
    const detail = await apiRequest<ResourceOverviewDetail>(service.instance, `/resources/overview/${id}?from=2090-01-01T00:00:00Z`);
    assert.equal(detail.resource.observation, "unknown");
    assert.equal(detail.resource.stats, null);
    assert.equal(detail.history!.resource.stats.missingTimeEvents, 1);
  }
}));

test("真实 CLI 通过同一服务查询、收藏、预览与确认，不另写本地业务逻辑", async () => fixture(async (context, service) => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const command = async (args: string[]) => JSON.parse((await run(process.execPath,
    ["--import", "tsx", cli, "--home", context.home, "--json", "resources", ...args], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout);
  const usage = await command(["usage", "--kind", "skill"]);
  assert.equal(usage.resources[0].stats.successfulReads, 1);
  assert.equal(usage.stats, undefined);
  assert.equal((await command(["usage", "--kind", "skill", "--full"])).stats.successfulReads, 1);
  const overview = await command(["overview", "--q", "guide", "--order", "asc"]);
  assert.equal(overview.total, 1);
  assert.equal(overview.resources[0].stats.successfulReads, 1);
  assert.equal((await command(["detail", overview.resources[0].identity.id, "--view", "overview"])).local.length, 1);
  const mcpOverview = await command(["overview", "--kind", "mcp", "--candidate", "used"]);
  assert.equal(mcpOverview.total, 1);
  assert.equal(mcpOverview.resources[0].stats.mcpCalls, 2);
  const mcpId = mcpOverview.resources[0].identity.id;
  assert.equal((await command(["detail", mcpId, "--view", "overview", "--kind", "mcp"])).history.tools.length, 2);
  assert.equal((await command(["evidence", mcpId, "--kind", "mcp", "--tool", "lookup"])).total, 1);
  const local = await command(["local", "--kind", "skill", "--q", "guide"]);
  assert.equal(local.total, 1);
  assert.equal(local.rows[0].entries, undefined);
  const entry = (await command(["detail", local.rows[0].body.id, "--view", "local"])).row.entries[0];
  await command(["favorite", local.rows[0].body.id]);
  assert.ok((await apiRequest<ResourceStatus>(service.instance, "/resources/status")).favoriteIds.includes(local.rows[0].body.id));
  const preview = await command(["preview", "standby", "--entry-id", entry.id]);
  await assert.rejects(run(process.execPath, ["--import", "tsx", cli, "--home", context.home, "resources", "apply", preview.id]),
    error => Boolean(error && typeof error === "object" && "stderr" in error && String(error.stderr).includes("--confirm")));
  assert.ok(await readFile(join(context.guide, "SKILL.md")));
  const result = await command(["apply", preview.id, "--confirm"]);
  assert.equal(result.status, "success");
  assert.equal((await command(["archives", "--state", "standby"])).total, 1);
}));

test("恢复中心 HTTP 合并后分页和搜索，兼容旧查询且还原后移出中心", async () => fixture(async (context, service) => {
  const local = await apiRequest<ResourceLocalResult>(service.instance, "/resources/local?kind=skill&pageSize=200");
  const entries = local.rows.flatMap(row => row.entries);
  const chosen = [
    { entry: entries.find(value => value.client === "codex" && value.entryPath === context.guide)!, action: "disable" },
    { entry: entries.find(value => value.client === "claude" && value.entryPath === context.link)!, action: "trash" },
    { entry: entries.find(value => value.client === "codex" && value.entryPath === join(context.userHome, ".codex", "skills", "sample-00"))!, action: "trash" },
  ];
  for (const value of chosen) {
    assert.ok(value.entry);
    const preview = await apiRequest<ResourceManagementPreview>(service.instance, "/resources/preview", "POST", { entryId: value.entry.id, action: value.action });
    const result = await apiRequest<ResourceManagementOperation>(service.instance, "/resources/apply", "POST", { previewId: preview.id, confirmed: true });
    assert.equal(result.status, "success");
  }
  type Page = { archives: import("../src/resource-management-contracts.js").ResourceManagementArchive[]; total: number; page: number };
  const first = await apiRequest<Page>(service.instance, "/resources/archives?state=recoverable&kind=skill&pageSize=1");
  const second = await apiRequest<Page>(service.instance, "/resources/archives?state=recoverable&kind=skill&pageSize=1&page=2");
  assert.equal(first.total, 3); assert.equal(first.archives.length, 1); assert.equal(second.total, 3);
  assert.notEqual(first.archives[0]!.id, second.archives[0]!.id);
  assert.ok(first.archives[0]!.createdAt >= second.archives[0]!.createdAt);
  assert.equal((await apiRequest<Page>(service.instance, "/resources/archives?state=disabled")).total, 1);
  assert.equal((await apiRequest<Page>(service.instance, "/resources/archives?state=trash")).total, 2);
  assert.equal((await apiRequest<Page>(service.instance, "/resources/archives?state=recoverable&kind=mcp")).total, 0);
  const match = await apiRequest<Page>(service.instance, "/resources/archives?state=recoverable&q=guide"); assert.equal(match.total, 1);
  const last = await apiRequest<Page>(service.instance, "/resources/archives?state=recoverable&pageSize=1&page=99"); assert.equal(last.page, 3);
  const preview = await apiRequest<ResourceManagementPreview>(service.instance, "/resources/preview", "POST", { operationId: match.archives[0]!.operationId, action: "restore" });
  assert.equal((await apiRequest<ResourceManagementOperation>(service.instance, "/resources/apply", "POST", { previewId: preview.id, confirmed: true })).status, "success");
  const after = await apiRequest<Page>(service.instance, "/resources/archives?state=recoverable"); assert.equal(after.total, 2);
  assert.ok(!after.archives.some(value => value.id === match.archives[0]!.id));
}));
