import assert from "node:assert/strict";
import test from "node:test";
import { overviewPanels, type OverviewPanel, type OverviewPanelResult, type OverviewResourceRow, type OverviewTimingGroup, type OverviewSnapshot } from "../src/overview-contracts.ts";
import { investigationDetail } from "../web/features/overview/investigation-model.ts";
import { loadOverviewPanels, sameOverviewSnapshot, visibleOverviewBatch, replaceOverviewPanel, OverviewSnapshotMismatch, type OverviewPanelBatch } from "../web/features/overview/loading.ts";

const snapshot: OverviewSnapshot = { version: "index-a", priceVersion: "prices-a", timezone: "UTC", query: { window: "365", from: "2025-01-01", to: "2025-12-31", anchorDay: "2025-12-31", clients: ["codex"], models: ["example-model"] }, range: { from: "2025-01-01", to: "2025-12-31", today: "2025-12-31", includesToday: true, all: false, comparison: null, recent: null } };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function harness() {
  const paths: string[] = [];
  const gates = new Map<OverviewPanel, ReturnType<typeof deferred<OverviewPanelResult>>>();
  for (const panel of overviewPanels) gates.set(panel, deferred<OverviewPanelResult>());
  const transport = async <T>(path: string): Promise<T> => { paths.push(path); if (path.startsWith("/overview/snapshot")) return snapshot as T; const panel = new URL(`http://example.invalid${path}`).searchParams.get("panel") as OverviewPanel; return gates.get(panel)!.promise as Promise<T>; };
  const resolve = (panel: OverviewPanel, fixed = snapshot) => gates.get(panel)!.resolve({ panel, snapshot: fixed, data: {} });
  return { paths, gates, transport, resolve };
}

test("首次快照后六区并发，核心先呈现而慢区无需阻塞", async () => {
  const h = harness(), signal = new AbortController().signal;
  let visible: OverviewPanelBatch | null = null;
  const update = (next: OverviewPanelBatch) => { visible = visibleOverviewBatch(visible, next); };
  const run = loadOverviewPanels({}, "first", h.transport, signal, update, update);
  await flush();
  assert.equal(h.paths.length, 7);
  for (const path of h.paths.slice(1)) { const params = new URL(`http://example.invalid${path}`).searchParams; assert.equal(params.get("version"), "index-a"); assert.equal(params.get("priceVersion"), "prices-a"); assert.equal(params.get("anchorDay"), "2025-12-31"); assert.equal(params.get("models"), '["example-model"]'); }
  h.resolve("core"); await flush();
  assert.equal(visible!.complete, false); assert.ok(visible!.panels.core); assert.equal(visible!.panels.resources, undefined);
  for (const panel of overviewPanels.filter(value => value !== "core")) h.resolve(panel);
  const complete = await run;
  assert.equal(complete.complete, true); assert.equal(Object.keys(complete.panels).length, 6);
});

test("已有完整批次保留旧布局，下一份六区齐备才整体替换", async () => {
  const previous: OverviewPanelBatch = { key: "old", snapshot, panels: {}, complete: true };
  let visible: OverviewPanelBatch = previous;
  const h = harness(), update = (next: OverviewPanelBatch) => { visible = visibleOverviewBatch(visible, next); };
  const run = loadOverviewPanels({}, "next", h.transport, new AbortController().signal, update, update);
  await flush(); h.resolve("core"); h.resolve("usage"); await flush();
  assert.equal(visible, previous);
  for (const panel of overviewPanels.filter(value => value !== "core" && value !== "usage")) h.resolve(panel);
  update(await run); assert.equal(visible.key, "next"); assert.equal(visible.complete, true);
});

test("快速切换取消前一代，迟到响应不再发布分区或覆盖结果", async () => {
  const h = harness(), controller = new AbortController(); const delivered: OverviewPanelBatch[] = [];
  const run = loadOverviewPanels({}, "old-model", h.transport, controller.signal, value => delivered.push(value), value => delivered.push(value));
  await flush(); controller.abort();
  for (const panel of overviewPanels) h.resolve(panel);
  await assert.rejects(run, { name: "AbortError" }); assert.equal(delivered.length, 1); assert.equal(Object.keys(delivered[0]!.panels).length, 0);
});

test("一个区域失败不取消其他首次分区，完整刷新仍不能混入部分结果", async () => {
  const h = harness(), delivered: OverviewPanelBatch[] = [], errors: OverviewPanel[] = [];
  const run = loadOverviewPanels({}, "partial", h.transport, new AbortController().signal, () => {}, value => delivered.push(value), panel => errors.push(panel));
  await flush(); h.gates.get("repositories")!.reject(new Error("synthetic panel failure")); h.resolve("core"); await flush();
  assert.ok(delivered.at(-1)!.panels.core);
  for (const panel of overviewPanels.filter(value => value !== "core" && value !== "repositories")) h.resolve(panel);
  await assert.rejects(run, /synthetic panel failure/); assert.deepEqual(errors, ["repositories"]); assert.equal(delivered.at(-1)!.complete, false);
});

test("同索引但价格、日期或局部模型不同的分区也不能混入快照", async () => {
  assert.ok(sameOverviewSnapshot(snapshot, { ...snapshot, query: { models: ["example-model"], clients: ["codex"], anchorDay: "2025-12-31", to: "2025-12-31", from: "2025-01-01", window: "365" } }));
  for (const changed of [{ ...snapshot, priceVersion: "prices-b" }, { ...snapshot, query: { ...snapshot.query, anchorDay: "2026-01-01" } }, { ...snapshot, query: { ...snapshot.query, models: ["other-model"] } }]) assert.equal(sameOverviewSnapshot(snapshot, changed), false);
  const h = harness(); const run = loadOverviewPanels({}, "mismatch", h.transport, new AbortController().signal, () => {}, () => {});
  await flush(); for (const panel of overviewPanels) h.resolve(panel, panel === "usage" ? { ...snapshot, priceVersion: "prices-b" } : snapshot);
  await assert.rejects(run, OverviewSnapshotMismatch);
});

test("调查每个视图传递服务端分页、资源分布与完整排序，首页截取数据不参与分页", () => {
  const controls = { page: 3, pageSize: 50, rankTab: "ranking", transitionKind: "switch", resourceSort: "sessions", resourceDimension: "tool" as const };
  assert.deepEqual(investigationDetail({ view: "resources", title: "", kind: "skill" }, controls), { view: "resources", kind: "skill", sort: "sessions", page: 3, pageSize: 50 });
  assert.deepEqual(investigationDetail({ view: "ranking", title: "", dimension: "project", metric: "cost" }, controls), { view: "ranking", dimension: "project", transition: "switch", sort: "cost", page: 3, pageSize: 50 });
  assert.equal(investigationDetail({ view: "ranking", title: "", dimension: "tool" }, controls)!.sort, "count");
  assert.equal(investigationDetail({ view: "ranking", title: "", dimension: "model" }, { ...controls, rankTab: "transitions" })!.view, "transitions");
  assert.equal(investigationDetail({ view: "ranking", title: "", dimension: "project" }, { ...controls, rankTab: "months" })!.view, "months");
  assert.equal(investigationDetail({ view: "ranking", title: "", dimension: "tool" }, { ...controls, rankTab: "categories" }), null);
  assert.deepEqual(investigationDetail({ view: "combinations", title: "", unit: "turn" }, controls), { view: "combinations", unit: "turn", page: 3, pageSize: 50 });
  const resource: OverviewResourceRow = { id: "resource-a", kind: "mcp", name: "example-server", uses: 20, sessions: 4, explicitCalls: 0, successfulReads: 0, activeWeeks: 3, firstDay: null, lastDay: null, averagePerSession: 5, clients: [], projects: [], tools: [], days: [], results: { calls: 20, success: 18, failure: 1, unknown: 1, known: 19, failureRate: 1 / 19, coverage: 19 / 20 } };
  assert.deepEqual(investigationDetail({ view: "resource", title: "", resource }, controls), { view: "resource", resourceId: "resource-a", dimension: "tool", page: 3, pageSize: 50 });
  const timing: OverviewTimingGroup = { id: "timing-a", client: "codex", model: "example-model", window: "response", basis: "recorded", method: "example", samples: 4, duration: { medianMs: 100, p90Ms: 200, maxMs: 300, averageMs: 150 }, speed: { samples: 0, median: null, p90: null, average: null }, longest: [] };
  assert.deepEqual(investigationDetail({ view: "timing", title: "", timing }, controls), { view: "timing", timingGroup: "timing-a", page: 3, pageSize: 50 });
  assert.deepEqual(investigationDetail({ view: "observations", title: "" }, controls), { view: "observations", page: 3, pageSize: 50 });
  assert.deepEqual(investigationDetail({ view: "timings", title: "" }, controls), { view: "timings", page: 3, pageSize: 50 });
});

test("核心变化洞察的新文案在中英文使用同一参数和保留原始对象名称", async () => {
  const { translate } = await import("../src/i18n/index.ts");
  const params = { name: "example-model", current: 30, previous: 20 };
  assert.equal(translate("zh-CN", "overview.insight.modelShareChange", params), "example-model：请求占比从 20% 变为 30%。");
  assert.equal(translate("en", "overview.insight.projectShareChange", params), "example-model: request share changed from 20% to 30%.");
  assert.equal(translate("en", "overview.insight.resourceChange", params), "example-model: using sessions changed from 20 to 30.");
});

test("失败分区独立恢复保留其余已完成结果，过期重试不修改新的快照", () => {
  const partial: OverviewPanelBatch = { key: "first", snapshot, complete: false, panels: Object.fromEntries(overviewPanels.filter(panel => panel !== "repositories").map(panel => [panel, { panel, snapshot, data: {} }])) };
  const result: OverviewPanelResult = { panel: "repositories", snapshot, data: { repositories: [] } };
  const complete = replaceOverviewPanel(partial, snapshot, result)!;
  assert.equal(complete.complete, true); assert.equal(complete.panels.core, partial.panels.core); assert.deepEqual(complete.panels.repositories?.data.repositories, []);
  const newer = { ...partial, snapshot: { ...snapshot, version: "index-b" } };
  assert.equal(replaceOverviewPanel(newer, snapshot, result), newer);
});
