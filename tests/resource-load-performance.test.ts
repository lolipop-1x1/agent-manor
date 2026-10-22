import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resourceFixture } from "../scripts/resource-fixture.mjs";
import { ResourceManager } from "../src/resources/management.js";
import { ResourceService } from "../src/resources/service.js";
import { ResourceUsageManager } from "../src/resources/usage-manager.js";
import { ResourceUsageCache } from "../src/resources/usage-cache.js";
import { resourceHistoryIdentity, resourceUsageDetail, resourceUsageEvidence } from "../src/resources/usage.js";
import { parseSessionSource } from "../src/sessions/parser.js";
import { SessionStore } from "../src/sessions/store.js";
import Database from "better-sqlite3";
import { serviceLogPath } from "../src/service/logging.js";

async function fixture(run: (service: ResourceService, library: SessionStore, manager: ResourceManager,
  context: Awaited<ReturnType<typeof resourceFixture>>, publish: () => void) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-resource-load-"));
  const context = await resourceFixture(directory, 4);
  const library = new SessionStore(join(context.home, "index.sqlite"));
  const manager = new ResourceManager(context.home);
  try {
    const pending = library.createRevision(context.source, "synthetic-fingerprint");
    const summary = await parseSessionSource({ client: "codex", path: context.source }, pending.sink);
    pending.flush(); library.finishRevision(pending.revision, summary);
    const publish = () => { library.publish(library.createJob().id,
      [{ path: context.source, revision: pending.revision, fingerprint: "synthetic-fingerprint" }], []); };
    publish();
    const service = new ResourceService(library, manager, { userHome: context.userHome }, () => [context.project]);
    await run(service, library, manager, context, publish);
  } finally { manager.close(); library.close(); await rm(directory, { recursive: true, force: true }); }
}

test("资源 Worker 查询失败保留操作诊断，客户端收到通用错误且后台可重试", async () => fixture(async (_service, library, _manager, context) => {
  const database = new Database(library.dbPath);
  const index = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='session_message_resource_event_v3'").get() as { sql: string };
  const manager = new ResourceUsageManager(library);
  try {
    database.exec("DROP INDEX session_message_resource_event_v3");
    await assert.rejects(manager.overview({ kind: "skill" }, []), error => error instanceof Error
      && error.message === "本地服务处理失败");
    const logs = (await readFile(serviceLogPath(context.home), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    const failed = logs.find(row => row.event === "resource.history.failed");
    assert.equal(failed.operation, "overview");
    assert.equal(failed.error.code, "SQLITE_ERROR");
    assert.ok(failed.error.stack.includes("at "));
    assert.equal(failed.query, undefined);
    database.exec(index.sql);
    assert.ok((await manager.overview({ kind: "skill" }, [])).history.total > 0);
  } finally { await manager.close(); database.close(); }
}));

test("总览只读取一次事件流，Skill／MCP 切换、分页和地图复用各自统计", async () => fixture(async (service, library, manager) => {
  let reads = 0, decorations = 0;
  const resourceEvents = library.resourceEvents.bind(library);
  library.resourceEvents = (...args) => { reads++; return resourceEvents(...args); };
  const decorate = manager.decorateInventory.bind(manager);
  manager.decorateInventory = (...args) => { decorations++; return decorate(...args); };
  const skill = await service.overview({ kind: "skill" });
  assert.equal(reads, 1, "总览与本地关联应共用一次历史读取");
  assert.equal(decorations, 1, "同一请求只装饰一次盘点");
  assert.equal(skill.stats?.successfulReads, 1);
  const mcp = await service.overview({ kind: "mcp" });
  assert.equal(reads, 2);
  assert.equal(mcp.stats?.mcpCalls, 2);
  const previousDecorations = decorations;
  assert.deepEqual(await service.overview({ kind: "skill" }), skill);
  assert.deepEqual(await service.overview({ kind: "mcp" }), mcp);
  await service.overview({ kind: "skill", page: 2, pageSize: 1, q: "guide", sort: "name", order: "asc" });
  await service.overview({ kind: "skill", presence: "present", scope: "user" });
  await service.map({ kind: "skill", presence: "missing" });
  const map = await service.map({ kind: "mcp", metric: "calls" });
  assert.equal(map.totalValue, 2);
  assert.equal(reads, 2, "阅读视野改变不能重读历史");
  assert.equal(decorations, previousDecorations, "缓存命中无需重新计算管理能力");
}));

test("连续状态读取共享盘点，收藏和主动刷新仍更新管理状态", async () => fixture(async (service, _library, manager) => {
  let decorations = 0;
  const decorate = manager.decorateInventory.bind(manager);
  manager.decorateInventory = (...args) => { decorations++; return decorate(...args); };
  const statuses = await Promise.all([service.status(), service.status(), service.status()]);
  assert.deepEqual(statuses[0], statuses[1]);
  const candidates = statuses[0]!.clientOptions;
  assert.ok(candidates.skill.usage.includes("codex"));
  assert.ok(candidates.mcp.usage.includes("codex"));
  assert.deepEqual(candidates.skill.disabled, []);
  assert.deepEqual(candidates.skill.trash, []);
  assert.deepEqual(candidates.skill.operations, []);
  const events = _library.resourceEvents;
  _library.resourceEvents = () => { throw new Error("客户端候选不能读取完整历史事件流"); };
  await service.status();
  _library.resourceEvents = events;
  assert.equal(decorations, 1, "读取缓存状态不能重复计算管理能力");
  const row = (await service.local({ kind: "skill" })).rows[0]!;
  service.setFavorite(row.body.id, true);
  assert.equal((await service.local({ kind: "skill" })).rows.find(value => value.body.id === row.body.id)?.entries[0]?.favorite, true);
  assert.equal(decorations, 1, "收藏只更新标记，不重新计算管理能力");
  const before = decorations;
  await service.refresh();
  await service.status();
  assert.equal(decorations, before + 1, "刷新只装饰一次新快照");
}));

test("盘点计算失败后可重试，失败刷新不替换原快照", async () => fixture(async (service, _library, manager) => {
  const decorate = manager.decorateInventory.bind(manager);
  let fail = true;
  manager.decorateInventory = (...args) => {
    if (fail) { fail = false; throw new Error("synthetic-decoration-failure"); }
    return decorate(...args);
  };
  await assert.rejects(service.status(), /synthetic-decoration-failure/);
  const previous = await service.status();
  fail = true;
  await assert.rejects(service.refresh(), /synthetic-decoration-failure/);
  assert.deepEqual(await service.status(), previous);
  assert.ok((await service.refresh()).sources.length);
}));

test("收藏、索引发布、资源刷新和统计范围变化不会返回旧聚合", async () => fixture(async (service, library, _manager, context, publish) => {
  let reads = 0;
  const original = library.resourceEvents.bind(library);
  library.resourceEvents = (...args) => { reads++; return original(...args); };
  const first = await service.overview({ kind: "skill" });
  const firstVersion = library.status().version;
  const guide = first.resources.find(row => row.identity.name === "guide")!;
  service.setFavorite(guide.identity.id, true);
  assert.equal((await service.overview({ kind: "skill" })).resources.find(row => row.identity.id === guide.identity.id)?.favorite, true);
  assert.equal(reads, 1, "收藏变化不重新聚合已有历史");
  const beforeNoOp = reads;
  publish();
  assert.equal(library.status().version, firstVersion, "无变化发布保留内容版本与缓存");
  await service.overview({ kind: "skill" });
  assert.equal(reads, beforeNoOp, "无变化检查不重新聚合历史");
  // 标题元信息确实变化，发布新修订后必须使资源聚合失效。
  const changed = library.createRevision(context.source, "synthetic-changed-fingerprint");
  const meta = await parseSessionSource({ client: "codex", path: context.source }, changed.sink);
  changed.flush(); library.finishRevision(changed.revision, { ...meta, title: "更新后的人工会话", titleOrigin: "recorded" });
  library.publish(library.createJob().id, [{ path: context.source, revision: changed.revision, fingerprint: "synthetic-changed-fingerprint" }], []);
  const published = await service.overview({ kind: "skill" });
  assert.notEqual(library.status().version, firstVersion);
  assert.equal(published.stats?.successfulReads, 1);
  await appendFile(join(context.guide, "SKILL.md"), "\n人工追加正文。\n");
  await service.refresh();
  await service.overview({ kind: "skill" });
  await service.overview({ kind: "skill", client: "claude" });
  const dated = await service.overview({ kind: "skill", from: "2090-01-01T00:00:00Z" });
  assert.equal(dated.stats?.successfulReads, 0);
  const reclassified = await service.overview({ kind: "skill", lowSessions: 9 });
  assert.deepEqual(reclassified.stats, published.stats);
  assert.equal(reads, 3, "盘点、阈值和日期只重新关联、分类，不重读同版元数据");
}));

test("收藏变化复用历史并同步别名、本地保护、地图与筛选计数", async () => fixture(async (service, library) => {
  const first = await service.overview({ kind: "skill" });
  const guide = first.resources.find(row => row.identity.name === "guide")!;
  const detail = await service.overviewDetail(guide.identity.id, { kind: "skill" });
  const legacy = await service.overviewDetail(detail.local[0]!.body.id, { kind: "skill" });
  assert.equal(legacy.resource.identity.id, guide.identity.id, "旧本体链接应进入名称详情");
  const outsideLocation = await service.overviewDetail(guide.identity.id, { kind: "skill", scope: "project", locationProject: "/synthetic/unregistered-project" });
  assert.equal(outsideLocation.local.length, 0);
  assert.deepEqual(outsideLocation.history?.resource.stats, detail.history?.resource.stats, "位置条件不应隐藏已选资源或裁剪其历史");
  const alias = detail.history!.origins[0]!.id;
  let reads = 0;
  const original = library.resourceEvents.bind(library);
  library.resourceEvents = (...args) => { reads++; return original(...args); };
  service.setFavorite(alias, true);
  const inherited = await service.overview({ kind: "skill", candidate: "favorite" });
  assert.equal(inherited.total, 1);
  assert.equal(inherited.counts.favorite, 1);
  assert.equal(inherited.resources[0]!.favorite, true);
  assert.deepEqual(inherited.resources[0]!.stats, guide.stats);
  assert.equal(reads, 0, "历史别名收藏不重新读取聚合事件");
  service.setFavorite(detail.local[0]!.body.id, true);
  service.setFavorite(guide.identity.id, false);
  const before = reads;
  const localOnly = await service.overview({ kind: "skill", candidate: "favorite" });
  assert.equal(localOnly.total, 1);
  assert.equal(localOnly.resources[0]!.favorite, false, "名称收藏与本地本体收藏独立");
  assert.equal(localOnly.resources[0]!.protected, true);
  const map = await service.map({ kind: "skill", metric: "uses" });
  assert.equal(map.positive.find(row => row.id === guide.identity.id)!.protected, true);
  service.setFavorite(detail.local[0]!.body.id, false);
  assert.equal((await service.overview({ kind: "skill", candidate: "favorite" })).total, 0);
  assert.equal((await service.overview({ kind: "skill" })).resources.find(row => row.identity.id === guide.identity.id)!.protected, false);
  assert.equal(reads, before, "本地收藏变化、地图和筛选只重新投影状态");
}));

test("相同范围并发共享聚合，失败后可重试且范围缓存数量有界", async () => fixture(async (service, library) => {
  let reads = 0, fail = true;
  const original = library.resourceEvents.bind(library);
  library.resourceEvents = (...args) => {
    reads++;
    if (fail) { fail = false; throw new Error("synthetic-query-failure"); }
    return original(...args);
  };
  await assert.rejects(service.overview({ kind: "mcp" }), /synthetic-query-failure/);
  const results = await Promise.all([service.overview({ kind: "mcp" }), service.overview({ kind: "mcp" })]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(reads, 2);
  for (let index = 1; index <= 12; index++) await service.overview({ kind: "mcp", from: `2026-01-${String(index).padStart(2, "0")}T00:00:00Z` });
  const before = reads;
  await service.overview({ kind: "mcp" });
  assert.equal(reads, before, "被淘汰的日期聚合仍可从有界元数据重算");
  for (let index = 0; index < 10; index++) await service.overview({ kind: "mcp", historyProject: `/synthetic/project-${index}` });
  const afterScopes = reads;
  await service.overview({ kind: "mcp" });
  assert.equal(reads, afterScopes + 1, "被淘汰的客户端／项目元数据重新读取，不无限驻留");
}));

test("新发现资源分类不依赖观测期限，复用历史聚合", async context => {
  let now = Date.parse("2026-01-09T00:00:00Z");
  context.mock.method(Date, "now", () => now);
  await fixture(async (service, library, manager) => {
    const observe = manager.observeInventory.bind(manager);
    manager.observeInventory = snapshot => observe({ ...snapshot, observedAt: "2026-01-03T00:00:00Z" });
    let reads = 0;
    const original = library.resourceEvents.bind(library);
    library.resourceEvents = (...args) => { reads++; return original(...args); };
    const row = async () => (await service.overview({ kind: "skill" })).resources.find(row => row.identity.name === "sample-00")!;
    assert.equal((await row()).observation, "unused");
    now += 2 * 86400_000;
    assert.equal((await row()).observation, "unused");
    assert.equal(reads, 1, "经过时间不重读已有历史范围");
  });
});

test("管理预览复用盘点与收藏历史，目标变化仍在执行前产生冲突", async () => fixture(async (service, library, manager, context) => {
  const guide = (await service.overview({ kind: "skill" })).resources.find(row => row.identity.name === "guide")!;
  service.setFavorite(guide.identity.id, true);
  const detail = await service.overviewDetail(guide.identity.id, { kind: "skill" });
  const entry = detail.local.flatMap(row => row.entries).find(entry => entry.client === "codex" && entry.entryPath === context.guide)!;
  const decorate = manager.decorateInventory.bind(manager); let scans = 0;
  manager.decorateInventory = (...args) => { scans++; return decorate(...args); };
  const events = library.resourceEvents.bind(library); let reads = 0;
  library.resourceEvents = (...args) => { reads++; return events(...args); };
  const preview = await service.preview({ entryId: entry.id, action: "trash" });
  assert.equal(preview.protected, true);
  assert.equal(scans, 0, "预览不重新盘点全部资源");
  assert.equal(reads, 0, "已有收藏关联不重复读取全部历史");
  await appendFile(join(context.guide, "asset.txt"), "预览后发生变化\n");
  assert.equal((await service.apply(preview.id, true)).status, "conflict");
  assert.ok(scans > 0, "执行前仍重新发现引用与保护状态");
}));

test("本地入口消失后只重算关联，历史事件聚合不随盘点失效", async () => fixture(async (service, library, _manager, context) => {
  let reads = 0; const original = library.resourceEvents.bind(library);
  library.resourceEvents = (...args) => { reads++; return original(...args); };
  const before = await service.overview({ kind: "skill" });
  const guide = before.resources.find(row => row.identity.name === "guide")!;
  assert.ok(guide.localBodyIds.length);
  await rm(context.guide, { recursive: true }); await service.refresh();
  const after = await service.overview({ kind: "skill" });
  const changed = after.resources.find(row => row.identity.id === guide.identity.id)!;
  assert.deepEqual(changed.stats, guide.stats);
  assert.equal(changed.localBodyIds.length, 0);
  assert.equal(reads, 1, "本地变更不能重读未变化的历史事件");
}));

test("只读资源 Worker 冷查询期间主线程继续调度，同条件合并且关闭拒绝新任务", async () => fixture(async (service, library) => {
  const inventory = (await service.local({ kind: "skill" })).rows.flatMap(row => row.entries);
  const manager = new ResourceUsageManager(library);
  try {
    let scheduled = false;
    const first = manager.overview({ kind: "skill" }, inventory);
    assert.equal(manager.overview({ kind: "skill" }, inventory), first);
    setImmediate(() => { scheduled = true; });
    const result = await first;
    assert.equal(scheduled, true);
    assert.equal(result.history.stats.successfulReads, 1);
    const mcp = await manager.overview({ kind: "mcp" }, inventory);
    assert.equal(mcp.history.stats.mcpCalls, 2);
  } finally { await manager.close(); }
  await assert.rejects(manager.overview({ kind: "skill" }, inventory), /资源统计后台已停止/);
}));

test("资源 Worker 关闭时拒绝尚未完成的读取，不遗留等待任务", async () => fixture(async (_service, library) => {
  const manager = new ResourceUsageManager(library);
  const pending = manager.overview({ kind: "skill" }, []);
  const rejected = assert.rejects(pending, /资源统计后台已停止/);
  await manager.close(); await rejected;
}));

test("日期范围、名称详情和证据共用有界事件元数据，统计与原查询逐项一致", async () => fixture(async (service, library) => {
  const entries = (await service.local({ kind: "skill" })).rows.flatMap(row => row.entries);
  const cache = new ResourceUsageCache(library);
  let reads = 0;
  const original = library.resourceEvents.bind(library);
  library.resourceEvents = (...args) => { reads++; return original(...args); };
  for (const kind of ["skill", "mcp"] as const) {
    const result = cache.read({ kind }, entries);
    const identity = result.history.resources[0]!.identity;
    const before = reads;
    const detail = await cache.detail(identity.id, { kind }, entries, identity);
    const evidence = await cache.evidence(identity.id, { kind }, identity);
    cache.read({ kind, from: "2090-01-01T00:00:00Z" }, entries);
    assert.equal(reads, before, "新日期、详情和证据不重复读取同版事件元数据");
    assert.deepEqual(detail, resourceUsageDetail(library, identity.id, { kind }, entries, new Set(), identity));
    assert.deepEqual(evidence, resourceUsageEvidence(library, identity.id, { kind }, identity));
    assert.equal(new Set(evidence.events.map(event => event.id)).size, evidence.total);
  }
}));

test("详情和证据通过只读 Worker 调度，摘要保留统计但不传输缺口正文", async () => fixture(async (service, library) => {
  const entries = (await service.local({ kind: "skill" })).rows.flatMap(row => row.entries);
  const manager = new ResourceUsageManager(library);
  try {
    for (const kind of ["skill", "mcp"] as const) {
      const identity = (await manager.overview({ kind }, entries)).history.resources[0]!.identity;
      let scheduled = false;
      const pending = manager.summary(identity.id, { kind }, entries, identity);
      setImmediate(() => { scheduled = true; });
      const summary = await pending;
      assert.equal(scheduled, true);
      const full = resourceUsageDetail(library, identity.id, { kind }, entries, new Set(), identity);
      const { gaps, ...coverage } = full.coverage;
      assert.deepEqual(summary, { ...full, coverage: { ...coverage, gapCount: gaps.length } });
      assert.equal("gaps" in summary.coverage, false);
      assert.deepEqual(await manager.evidence(identity.id, { kind }, identity), resourceUsageEvidence(library, identity.id, { kind }, identity));
    }
  } finally { await manager.close(); }
}));

test("旧来源身份与显式项目范围冲突时仍沿用原查询的空范围", async () => fixture(async (_service, library, _manager, context) => {
  const cache = new ResourceUsageCache(library);
  const event = [...library.resourceEvents({ kind: "skill" }).events][0]!;
  const identity = { ...resourceHistoryIdentity({ ...event, project: undefined }), grouping: "source" as const };
  const query = { kind: "skill" as const, project: context.project };
  const before = resourceUsageDetail(library, identity.id, query, [], new Set(), identity);
  assert.equal(before.coverage.sessionCount, 0);
  assert.deepEqual(await cache.detail(identity.id, query, [], identity), before);
  assert.deepEqual(await cache.evidence(identity.id, query, identity), resourceUsageEvidence(library, identity.id, query, identity));
}));
