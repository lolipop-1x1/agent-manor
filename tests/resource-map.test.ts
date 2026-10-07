import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { resourceFixture } from "../scripts/resource-fixture.mjs";
import type { ResourceMapNode, ResourceMapResult } from "../src/resource-service-contracts.js";
import type { ResourceUsageQuery } from "../src/resource-contracts.js";
import type { SessionMessage, SessionSourceMeta } from "../src/session-contracts.js";
import { SessionStore } from "../src/sessions/store.js";
import { ResourceManager } from "../src/resources/management.js";
import { ResourceService } from "../src/resources/service.js";
import { resourceMapQuery } from "../src/service/resource-input.js";
import { registerResourceRoutes } from "../src/service/resource-routes.js";
import { layoutResourceMap, locateResourceMapCamera, panResourceMapCamera, resizeResourceMapCamera,
  resourceMapProjectRect, resourceMapScreenRect, resourceMapTileAt, zoomResourceMapCamera } from "../web/resource-map-layout.js";
import { clipRect, projectRect } from "../web/map-viewport.js";

const recordedAt = "2026-01-02T12:00:00Z";
async function fixture(run: (context: Awaited<ReturnType<typeof resourceFixture>>, store: SessionStore,
  manager: ResourceManager, service: ResourceService) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-resource-map-"));
  const context = await resourceFixture(directory, 205);
  const store = new SessionStore(join(context.home, "sessions.sqlite"));
  const manager = new ResourceManager(context.home);
  const service = new ResourceService(store, manager, { userHome: context.userHome }, () => [context.project]);
  try { await run(context, store, manager, service); }
  finally { store.close(); manager.close(); await rm(directory, { recursive: true, force: true }); }
}

function source(store: SessionStore, id: string, resources: { kind: "skill_call" | "skill_read" | "mcp"; name: string;
  server?: string; occurredAt?: string | null }[], client: SessionSourceMeta["client"] = "codex") {
  const path = `/synthetic/history/${id}.jsonl`;
  const pending = store.createRevision(path, `synthetic-${id}`);
  for (const [ordinal, resource] of resources.entries()) {
    const { occurredAt, ...identity } = resource;
    const message: SessionMessage = { id: `${id}:message:${ordinal}`, sessionId: id, ordinal, recordLine: ordinal + 1,
      turnId: "turn-1", kind: "tool_call", callId: `${id}:call:${ordinal}`, text: "人工合成内容不进入地图",
      status: "success", occurredAt: occurredAt === null ? undefined : occurredAt ?? recordedAt, resource: identity };
    pending.sink.message(message);
  }
  pending.flush();
  store.finishRevision(pending.revision, { id, client, clientSessionId: id, sourceId: `synthetic:${id}`, path,
    title: "人工合成地图会话", titleOrigin: "recorded", models: [], messageCount: resources.length, turnCount: 1, gaps: [] });
  return { path, revision: pending.revision, fingerprint: `synthetic-${id}` };
}

test("完整地图超出二百条，API 不受页码限制且所有节点来自同一发布版本", async () => fixture(async (_context, store, _manager, service) => {
  const resources = Array.from({ length: 205 }, (_, index) => ({ kind: "skill_call" as const, name: `map-skill-${index}` }));
  const version = store.publish(store.createJob().id, [source(store, "map-many", resources)], []);
  const app = Fastify(); registerResourceRoutes(app, service);
  try {
    const list = await service.overview({ candidate: "used", pageSize: 200 });
    assert.equal(list.resources.length, 200);
    assert.equal(list.total, 205);
    const response = await app.inject({ method: "GET", url: "/api/v1/resources/map?candidate=used&page=999&pageSize=1&sort=name&order=desc" });
    assert.equal(response.statusCode, 200);
    const result = response.json<ResourceMapResult>();
    assert.equal(result.version, version); assert.equal(result.complete, true);
    assert.equal(result.positive.length, 205); assert.equal(result.total, 205); assert.equal(result.totalValue, 205);
    assert.ok(result.positive.every(node => node.value === 1 && node.share === 1 / 205));
    assert.equal(new Set(result.positive.map(node => node.id)).size, 205);
    const text = JSON.stringify(result);
    for (const secret of ["synthetic-secret", "synthetic-json-secret", "example-command", "人工合成内容不进入地图"]) assert.ok(!text.includes(secret));
    assert.ok(!("stats" in result.positive[0]!));
  } finally { await app.close(); }
}));

test("同名跨 Agent 合并会话并集，调用、成功读取分开，零调用不等于未使用", async () => fixture(async (_context, store, _manager, service) => {
  const first = source(store, "map-first", [{ kind: "skill_call", name: "shared-map" },
    { kind: "skill_read", name: "shared-map", occurredAt: "2026-09-30T00:00:00Z" }, { kind: "skill_read", name: "read-only-map" }]);
  const second = source(store, "map-second", [{ kind: "skill_call", name: "shared-map" }], "claude");
  store.publish(store.createJob().id, [first, second], []);
  const calls = await service.map({ q: "map" });
  const shared = calls.positive.find(node => node.name === "shared-map")!;
  assert.deepEqual(shared.metrics, { calls: 2, reads: 1, sessions: 2 });
  assert.deepEqual(shared.clients, ["claude", "codex"]);
  assert.equal(calls.zero.find(node => node.name === "read-only-map")!.observation, "used");
  assert.equal(calls.zero[0]!.metrics?.reads, 1);
  assert.equal(shared.lastUsedAt, "2026-09-30T00:00:00.000Z");
  const reads = await service.map({ q: "map", metric: "reads" });
  assert.equal(reads.positive.find(node => node.id === shared.id)!.lastUsedAt, shared.lastUsedAt);
  assert.equal(reads.totalValue, 2);
  const sessions = await service.map({ q: "map", metric: "sessions" });
  assert.equal(sessions.positive.find(node => node.id === shared.id)!.value, 2);
  const claude = await service.map({ q: "map", client: "claude", candidate: "used" });
  assert.equal(claude.total, 1); assert.equal(claude.positive[0]!.value, 1);
  const dated = await service.map({ q: "map", from: "2026-09-01T00:00:00Z" });
  assert.equal(dated.zero[0]!.name, "shared-map");
  assert.equal(dated.zero[0]!.metrics?.reads, 1);
}));

test("数值上限只过滤已知值，未知、观测不足和缺失时间继续可见，低频阈值独立", async () => fixture(async (_context, store, manager, service) => {
  store.publish(store.createJob().id, [source(store, "map-threshold", [
    { kind: "skill_call", name: "one-map" }, { kind: "skill_call", name: "many-map" },
    { kind: "skill_call", name: "many-map" }, { kind: "skill_call", name: "undated-map", occurredAt: null }])], []);
  await service.status();
  const old = manager.favorites(); assert.deepEqual(old, []);
  const all = await service.map({});
  assert.ok(all.review.length > 200);
  assert.ok(all.review.some(node => node.observation === "insufficient"));
  assert.ok(all.review.every(node => node.value === null && node.share === null && node.partial));
  const undated = all.positive.find(node => node.name === "undated-map")!;
  assert.equal(undated.lastUsedAt, null); assert.equal(undated.missingTimeEvents, 1); assert.equal(undated.partial, true);
  assert.equal(all.partial, true);
  const limited = await service.map({ maxValue: 1 });
  assert.equal(limited.positive.length, 2); assert.equal(limited.totalValue, 2);
  assert.equal(limited.review.length, all.review.length);
  assert.ok(limited.positive.every(node => node.share === 0.5));
  const zero = await service.map({ maxValue: 0 });
  assert.equal(zero.positive.length, 0); assert.equal(zero.totalValue, 0); assert.equal(zero.review.length, all.review.length);
  const low = await service.map({ q: "map", candidate: "low", maxValue: 1 });
  assert.deepEqual(low.positive.map(node => node.name), ["one-map"]);
  assert.equal((await service.map({ q: "map", candidate: "low" })).positive.length, 2);
}));

test("地图复用范围缓存而不重读事件，发布版本变化后更新，管理保护与本体身份保留", async () => fixture(async (_context, store, manager, service) => {
  const first = source(store, "map-cache-first", [{ kind: "skill_call", name: "guide" }]);
  const version = store.publish(store.createJob().id, [first], []);
  const original = store.resourceEvents.bind(store);
  const versions: (string | undefined)[] = [];
  store.resourceEvents = ((query: ResourceUsageQuery = {}, identity?: Parameters<SessionStore["resourceEvents"]>[1]) => {
    versions.push(query.version); return original(query, identity);
  }) as SessionStore["resourceEvents"];
  const firstMap = await service.map({ q: "guide" });
  assert.deepEqual(versions, [version, version]);
  const guide = firstMap.positive[0]!;
  assert.ok(guide.localBodyIds.length > 0);
  assert.equal(guide.hasHistory, true);
  await service.map({ q: "guide", metric: "reads", maxValue: 0 });
  await service.overview({ q: "guide", pageSize: 1, order: "asc" });
  assert.equal(versions.length, 2);
  manager.setFavorite(guide.id, true);
  const favorite = await service.map({ q: "guide" });
  assert.equal(favorite.positive[0]!.favorite, true); assert.equal(favorite.positive[0]!.protected, true);
  const second = source(store, "map-cache-second", [{ kind: "skill_call", name: "guide" }]);
  const next = store.publish(store.createJob().id, [first, second], []);
  const updated = await service.map({ q: "guide" });
  assert.equal(updated.version, next); assert.equal(updated.positive[0]!.value, 2);
}));

test("一次地图查询的历史和本地聚合固定版本，不混入查询途中发布的新结果", async () => fixture(async (_context, store, _manager, service) => {
  const first = source(store, "map-version-first", [{ kind: "skill_call", name: "guide" }]);
  const version = store.publish(store.createJob().id, [first], []);
  await service.status();
  const original = store.resourceEvents.bind(store);
  const versions: (string | undefined)[] = [];
  let next: string | undefined;
  store.resourceEvents = ((query: ResourceUsageQuery = {}, identity?: Parameters<SessionStore["resourceEvents"]>[1]) => {
    versions.push(query.version);
    const stream = original(query, identity);
    if (versions.length === 1) queueMicrotask(() => {
      const second = source(store, "map-version-second", [{ kind: "skill_call", name: "guide" }]);
      next = store.publish(store.createJob().id, [first, second], []);
    });
    return stream;
  }) as SessionStore["resourceEvents"];
  const result = await service.map({ q: "guide" });
  assert.equal(result.version, version); assert.equal(result.positive[0]!.value, 1);
  assert.deepEqual(versions, [version, version]); assert.notEqual(next, version);
  const updated = await service.map({ q: "guide" });
  assert.equal(updated.version, next); assert.equal(updated.positive[0]!.value, 2);
}));

test("MCP 仅提供调用和会话面积，注册数不累加历史，上限严格校验且分页不限定地图", async () => fixture(async (_context, store, _manager, service) => {
  const events = Array.from({ length: 205 }, (_, index) => ({ kind: "mcp" as const, name: `map-server-${index}`, server: `map-server-${index}` }));
  events.push({ kind: "mcp", name: "sample", server: "sample" });
  store.publish(store.createJob().id, [source(store, "map-mcp", events)], []);
  const calls = await service.map({ kind: "mcp" });
  assert.equal(calls.positive.length, 206); assert.equal(calls.totalValue, 206);
  assert.equal(calls.positive.find(node => node.name === "sample")!.localBodyIds.length, 1);
  assert.equal((await service.map({ kind: "mcp", metric: "sessions" })).totalValue, 206);
  assert.deepEqual(resourceMapQuery({ metric: "calls", maxValue: "0", page: "bad", sort: "bad" }).maxValue, 0);
  for (const query of [{ metric: "unknown" }, { kind: "mcp", metric: "reads" }, { maxValue: "-1" },
    { maxValue: "1.5" }, { maxValue: "9007199254740992" }, { maxValue: "" }] as Record<string, unknown>[]) {
    assert.throws(() => resourceMapQuery(query), { code: "INVALID_INPUT" });
  }
  await assert.rejects(service.map({ kind: "mcp", metric: "reads" }), { code: "INVALID_INPUT" });
  await assert.rejects(service.map({ maxValue: -1 }), { code: "INVALID_INPUT" });
}));

function node(id: string, value: number | null): ResourceMapNode {
  return { id, name: id, value, share: null, metrics: null, lastUsedAt: null, missingTimeEvents: 0,
    clients: [], favorite: false, protected: false, observation: value === null ? "unknown" : "used",
    localBodyIds: [], hasHistory: true, partial: false };
}

test("原值线性布局严格一比十，零值和未知无伪造面积，顺序和屏幕间隔不改变逻辑面积", () => {
  const nodes = [node("one", 1), node("ten", 10), node("zero", 0), node("unknown", null)];
  const layout = layoutResourceMap(nodes);
  assert.equal(layout.tiles.length, 2);
  const one = layout.tiles.find(tile => tile.id === "one")!, ten = layout.tiles.find(tile => tile.id === "ten")!;
  const area = (tile: typeof one) => tile.width * tile.height;
  assert.ok(Math.abs(area(ten) / area(one) - 10) < 1e-12);
  assert.ok(Math.abs(area(one) / (layout.bounds.width * layout.bounds.height) - 1 / 11) < 1e-15);
  assert.deepEqual(layoutResourceMap([...nodes].reverse()), layout);
  const camera = { x: 0, y: 0, scale: 2 };
  const projected = projectRect(one, camera), screen = resourceMapScreenRect(one, camera);
  assert.equal(screen.width, projected.width - 1); assert.equal(screen.height, projected.height - 1);
  assert.equal(area(one), one.width * one.height);
  assert.deepEqual(layoutResourceMap([node("zero", 0), node("unknown", null)]).tiles, []);
});

test("巨大次数差仍保留每个微小正值的真实面积与定位几何，不使用最小权重", () => {
  for (const maximum of [1e12, Number.MAX_SAFE_INTEGER, 1e30]) {
    const nodes = [node("one", 1), node("two", 2), node("three", 3), node("large", maximum)];
    const layout = layoutResourceMap(nodes), total = maximum + 6;
    assert.equal(layout.tiles.length, 4);
    for (const tile of layout.tiles) {
      assert.ok(tile.width > 0 && tile.height > 0);
      const share = tile.width * tile.height / (layout.bounds.width * layout.bounds.height);
      assert.ok(Math.abs(share / (tile.node.value! / total) - 1) < 1e-12, `${maximum}:${tile.id}`);
      const located = locateResourceMapCamera(tile, { width: 800, height: 500 }, 0.2, layout.maxScale);
      const rect = resourceMapProjectRect(tile, located);
      assert.ok(Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.width > 0 && rect.height > 0);
      const visible = clipRect(resourceMapScreenRect(tile, located), { width: 800, height: 500 })!;
      assert.ok(visible.width >= 159 - 1e-8 && visible.height >= 127 - 1e-8, `${maximum}:${tile.id} 可读尺寸`);
      assert.equal(resourceMapTileAt(layout.tiles, located, { x: 400, y: 250 })?.id, tile.id);
    }
  }
});

test("微小色块局部相机保持中心缩放、像素拖动与视口变化，原面积不变", () => {
  const layout = layoutResourceMap([node("tiny", 1), node("huge", Number.MAX_SAFE_INTEGER)]);
  const tile = layout.tiles.find(value => value.id === "tiny")!;
  const initial = locateResourceMapCamera(tile, { width: 800, height: 500 }, 0.2, layout.maxScale);
  const before = resourceMapProjectRect(tile, initial);
  const zoomed = zoomResourceMapCamera(initial, 2, { x: 400, y: 250 }, 0.2, layout.maxScale);
  const after = resourceMapProjectRect(tile, zoomed);
  assert.ok(Math.abs(after.width / before.width - 2) < 1e-12);
  assert.ok(Math.abs(after.x + after.width / 2 - 400) < 1e-8);
  const panned = panResourceMapCamera(zoomed, { x: 30, y: -20 });
  const moved = resourceMapProjectRect(tile, panned);
  assert.ok(Math.abs(moved.x - after.x - 30) < 1e-8);
  assert.deepEqual(panned.origin, initial.origin); assert.deepEqual(panned.offset, initial.offset);
  const resized = resizeResourceMapCamera(panned, { width: 800, height: 500 }, { width: 1000, height: 600 });
  assert.equal(resized.x - panned.x, 100); assert.equal(resized.y - panned.y, 50);
  const safe = zoomResourceMapCamera(initial, 1e300, { x: 400, y: 250 }, 0.2, layout.maxScale);
  assert.equal(safe.scale, layout.maxScale);
  assert.equal(resourceMapTileAt(layout.tiles, panned, { x: 430, y: 230 })?.id, "tiny");
});

test("较大世界坐标处的小宽度使用独立中心偏移，定位不会把小块加成零宽", () => {
  const tile = { id: "edge", node: node("edge", 1), x: 1000, y: 650, width: 1e-20, height: 100 };
  assert.equal(tile.x + tile.width / 2, tile.x);
  const camera = locateResourceMapCamera(tile, { width: 800, height: 500 }, 0.2, 1e30);
  const screen = resourceMapScreenRect(tile, camera), visible = clipRect(screen, { width: 800, height: 500 })!;
  assert.ok(visible.width >= 159 - 1e-8); assert.ok(visible.height >= 127 - 1e-8);
  assert.ok(Math.abs(screen.x + screen.width / 2 - 400) < 1e-8);
  assert.equal(resourceMapTileAt([tile], camera, { x: 400, y: 250 })?.id, "edge");
});
