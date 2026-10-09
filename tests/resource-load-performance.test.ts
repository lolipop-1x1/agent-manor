import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resourceFixture } from "../scripts/resource-fixture.mjs";
import { ResourceManager } from "../src/resources/management.js";
import { ResourceService } from "../src/resources/service.js";
import { parseSessionSource } from "../src/sessions/parser.js";
import { SessionStore } from "../src/sessions/store.js";

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
  await service.status();
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
  await service.overview({ kind: "skill", lowSessions: 9 });
  assert.equal(reads, 7);
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
  for (let index = 1; index <= 12; index++) await service.overview({ kind: "mcp", lowSessions: index });
  const before = reads;
  await service.overview({ kind: "mcp" });
  assert.equal(reads, before + 1, "被淘汰的范围重新查询，不无限保留历史范围");
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
