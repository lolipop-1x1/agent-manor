import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildUsageReport } from "../src/usage/analytics.ts";
import { usageDimensionKey } from "../src/usage/dimensions.ts";
import type { PricingStatus, UsageSource } from "../src/usage-contracts.ts";
import { overviewModelOptions } from "../web/features/overview/model.ts";
import { overviewPanels, type OverviewPanel, type OverviewPanelResult, type OverviewResourceRow, type OverviewSnapshot } from "../src/overview-contracts.ts";
import { investigationDetail, visibleInvestigation, type InvestigationResult } from "../web/features/overview/investigation-model.ts";
import { loadOverviewPanels, loadOverviewPanel, loadOverviewInvestigation, requiredOverviewPanels, selectOverviewDimension, visibleOverviewDistribution, sameOverviewSnapshot, visibleOverviewBatch, replaceOverviewPanel, OverviewSnapshotMismatch, type OverviewPanelBatch } from "../web/features/overview/loading.ts";

const snapshot: OverviewSnapshot = { version: "index-a", priceVersion: "prices-a", timezone: "UTC", query: { window: "365", from: "2025-01-01", to: "2025-12-31", anchorDay: "2025-12-31", clients: ["codex"], models: ["example-model"] }, range: { from: "2025-01-01", to: "2025-12-31", today: "2025-12-31", includesToday: true, all: false, comparison: null, recent: null } };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function harness() {
  const paths: string[] = [];
  const gates = new Map<OverviewPanel, ReturnType<typeof deferred<OverviewPanelResult>>>();
  for (const panel of requiredOverviewPanels("project")) gates.set(panel, deferred<OverviewPanelResult>());
  const transport = async <T>(path: string): Promise<T> => { paths.push(path); if (path.startsWith("/overview/snapshot")) return snapshot as T; const panel = new URL(`http://example.invalid${path}`).searchParams.get("panel") as OverviewPanel; return gates.get(panel)!.promise as Promise<T>; };
  const resolve = (panel: OverviewPanel, fixed = snapshot, data: OverviewPanelResult["data"] = {}) => gates.get(panel)!.resolve({ panel, snapshot: fixed, data: panel === "distribution" ? { distribution: [], ...data } : data, dimension: panel === "distribution" ? "project" : undefined });
  return { paths, gates, transport, resolve };
}

test("首次快照后必需分区并发，核心先呈现而慢区无需阻塞", async () => {
  const h = harness(), signal = new AbortController().signal;
  let visible: OverviewPanelBatch | null = null;
  const update = (next: OverviewPanelBatch) => { visible = visibleOverviewBatch(visible, next); };
  const run = loadOverviewPanels({}, "first", h.transport, signal, update, update);
  await flush();
  assert.equal(h.paths.length, 8);
  for (const path of h.paths.slice(1)) { const params = new URL(`http://example.invalid${path}`).searchParams; assert.equal(params.get("version"), "index-a"); assert.equal(params.get("priceVersion"), "prices-a"); assert.equal(params.get("anchorDay"), "2025-12-31"); assert.equal(params.get("models"), '["example-model"]'); }
  h.resolve("core"); await flush();
  assert.equal(visible!.complete, false); assert.ok(visible!.panels.core); assert.equal(visible!.panels.resources, undefined);
  for (const panel of requiredOverviewPanels("project").filter(value => value !== "core")) h.resolve(panel);
  const complete = await run;
  assert.equal(complete.complete, true); assert.equal(Object.keys(complete.panels).length, 7);
});

test("已有完整批次保留旧布局，下一份必需分区齐备才整体替换", async () => {
  const previous: OverviewPanelBatch = { key: "old", snapshot, panels: {}, distributions: {}, dimension: "project", complete: true };
  let visible: OverviewPanelBatch = previous;
  const h = harness(), update = (next: OverviewPanelBatch) => { visible = visibleOverviewBatch(visible, next); };
  const run = loadOverviewPanels({}, "next", h.transport, new AbortController().signal, update, update);
  await flush(); h.resolve("core"); h.resolve("usage"); await flush();
  assert.equal(visible, previous);
  for (const panel of requiredOverviewPanels("project").filter(value => value !== "core" && value !== "usage")) h.resolve(panel);
  update(await run); assert.equal(visible.key, "next"); assert.equal(visible.complete, true);
});

test("快速切换取消前一代，迟到响应不再发布分区或覆盖结果", async () => {
  const h = harness(), controller = new AbortController(); const delivered: OverviewPanelBatch[] = [];
  const run = loadOverviewPanels({}, "old-model", h.transport, controller.signal, value => delivered.push(value), value => delivered.push(value));
  await flush(); controller.abort();
  for (const panel of requiredOverviewPanels("project")) h.resolve(panel);
  await assert.rejects(run, { name: "AbortError" }); assert.equal(delivered.length, 1); assert.equal(Object.keys(delivered[0]!.panels).length, 0);
});

test("一个区域失败不取消其他首次分区，完整刷新仍不能混入部分结果", async () => {
  const h = harness(), delivered: OverviewPanelBatch[] = [], errors: OverviewPanel[] = [];
  const run = loadOverviewPanels({}, "partial", h.transport, new AbortController().signal, () => {}, value => delivered.push(value), panel => errors.push(panel));
  await flush(); h.gates.get("repositories")!.reject(new Error("synthetic panel failure")); h.resolve("core"); await flush();
  assert.ok(delivered.at(-1)!.panels.core);
  for (const panel of requiredOverviewPanels("project").filter(value => value !== "core" && value !== "repositories")) h.resolve(panel);
  await assert.rejects(run, /synthetic panel failure/); assert.deepEqual(errors, ["repositories"]); assert.equal(delivered.at(-1)!.complete, false);
});

test("同索引但价格、日期或局部模型不同的分区也不能混入快照", async () => {
  assert.ok(sameOverviewSnapshot(snapshot, { ...snapshot, query: { models: ["example-model"], clients: ["codex"], anchorDay: "2025-12-31", to: "2025-12-31", from: "2025-01-01", window: "365" } }));
  for (const changed of [{ ...snapshot, priceVersion: "prices-b" }, { ...snapshot, query: { ...snapshot.query, anchorDay: "2026-01-01" } }, { ...snapshot, query: { ...snapshot.query, models: ["other-model"] } }]) assert.equal(sameOverviewSnapshot(snapshot, changed), false);
  const h = harness(); const run = loadOverviewPanels({}, "mismatch", h.transport, new AbortController().signal, () => {}, () => {});
  await flush(); for (const panel of requiredOverviewPanels("project")) h.resolve(panel, panel === "usage" ? { ...snapshot, priceVersion: "prices-b" } : snapshot);
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
  assert.deepEqual(investigationDetail({ view: "observations", title: "" }, controls), { view: "observations", page: 3, pageSize: 50 });
});

test("核心变化洞察的新文案在中英文使用同一参数和保留原始对象名称", async () => {
  const { translate } = await import("../src/i18n/index.ts");
  const params = { name: "example-model", current: 30, previous: 20 };
  assert.equal(translate("zh-CN", "overview.insight.modelShareChange", params), "example-model：请求占比从 20% 变为 30%。");
  assert.equal(translate("en", "overview.insight.projectShareChange", params), "example-model: request share changed from 20% to 30%.");
  assert.equal(translate("en", "overview.insight.resourceChange", params), "example-model: using sessions changed from 20 to 30.");
});

test("失败分区独立恢复保留其余已完成结果，过期重试不修改新的快照", () => {
  const partial: OverviewPanelBatch = { key: "first", snapshot, complete: false, distributions: { project: { panel: "distribution", dimension: "project", snapshot, data: { distribution: [] } } }, dimension: "project", panels: Object.fromEntries(requiredOverviewPanels("project").filter(panel => panel !== "repositories").map(panel => [panel, { panel, snapshot, data: {} }])) };
  const result: OverviewPanelResult = { panel: "repositories", snapshot, data: { repositories: [] } };
  const complete = replaceOverviewPanel(partial, snapshot, result)!;
  assert.equal(complete.complete, true); assert.equal(complete.panels.core, partial.panels.core); assert.deepEqual(complete.panels.repositories?.data.repositories, []);
  const newer = { ...partial, snapshot: { ...snapshot, version: "index-b" } };
  assert.equal(replaceOverviewPanel(newer, snapshot, result), newer);
});


test("调查等待和失败时保留同一份标题、维度、排序、页码和行，成功后共同替换", () => {
  const oldControls = { page: 3, pageSize: 20, rankTab: "ranking", transitionKind: "all", resourceSort: "uses", resourceDimension: "project" as const };
  const oldSelection = { view: "ranking" as const, title: "Projects", dimension: "project" as const, metric: "cost" as const };
  const oldQuery = investigationDetail(oldSelection, oldControls)!;
  const previous: InvestigationResult = { key: "old", selection: oldSelection, controls: oldControls, result: { snapshot, query: oldQuery, rows: [{ key: "/example/project-a", name: "project-a", count: 20, sessions: 3, estimatedCost: 12, costCoverage: "partial" }], total: 70, page: 3, pageSize: 20 } };
  const nextSelection = { view: "ranking" as const, title: "Models", dimension: "model" as const, metric: "tokens" as const };
  const nextControls = { ...oldControls, page: 1, pageSize: 50 };
  const nextQuery = investigationDetail(nextSelection, nextControls)!;
  const waiting = visibleInvestigation(previous, nextSelection, nextControls, "next");
  assert.equal(waiting.selection.title, "Projects");
  assert.equal(waiting.controls.page, 3);
  assert.equal(waiting.controls.pageSize, 20);
  assert.equal(waiting.controls.rankTab, "ranking");
  assert.equal(waiting.result, previous.result);
  assert.equal(waiting.key === "next", false);
  // 失败后只重试请求，不修改用于显示的旧结果或待请求条件。
  assert.equal(visibleInvestigation(previous, nextSelection, nextControls, "next"), waiting);
  assert.deepEqual(investigationDetail(nextSelection, nextControls), nextQuery);
  const next: InvestigationResult = { key: "next", selection: nextSelection, controls: nextControls, result: { snapshot, query: nextQuery, rows: [{ key: "example-model", name: "example-model", count: 4, sessions: 2, tokens: 80 }], total: 1, page: 1, pageSize: 50 } };
  const ready = visibleInvestigation(next, nextSelection, nextControls, "next");
  assert.equal(ready.selection.title, "Models");
  assert.equal(ready.controls.pageSize, 50);
  assert.equal(ready.key, "next");
  assert.equal(ready.result, next.result);
});

test("调查跨视图下钻保留完整旧面，首次打开和无需请求的分类不复用旧行", () => {
  const controls = { page: 1, pageSize: 20, rankTab: "ranking", transitionKind: "all", resourceSort: "uses", resourceDimension: "project" as const };
  const firstSelection = { view: "ranking" as const, title: "Tools", dimension: "tool" as const };
  const previous: InvestigationResult = { key: "ranking", selection: firstSelection, controls, result: { snapshot, query: investigationDetail(firstSelection, controls)!, rows: [], total: 0, page: 1, pageSize: 20 } };
  const next = { view: "evidence" as const, title: "Tool records", evidence: { kind: "tools" as const, toolId: "example-tool" } };
  const waiting = visibleInvestigation(previous, next, controls, "evidence");
  assert.equal(waiting.selection.view, "ranking");
  assert.equal(waiting.result, previous.result);
  const first = visibleInvestigation(null, next, controls, "evidence");
  assert.equal(first.selection?.view, "evidence");
  assert.equal(first.result, null);
  const categories = visibleInvestigation(previous, firstSelection, { ...controls, rankTab: "categories" }, "");
  assert.equal(categories.controls.rankTab, "categories");
  assert.equal(categories.result, null);
});


const testPricing: PricingStatus = { version: snapshot.priceVersion, source: "bundled", refreshing: false, currency: "USD", sourceUrl: "https://example.invalid/prices", configuration: { overrides: [], mappings: [] }, prices: [] };
const usageQuery = { timezone: snapshot.timezone, from: snapshot.range.from, to: snapshot.range.to };
const emptyUsage = buildUsageReport({ version: snapshot.version, sessions: [], requests: [] }, usageQuery, testPricing, () => ({ amount: null, coverage: "missing" }));
const modelNames = [undefined, "unknown", "literal:model-a", "example-model"];
const sourceWithModels: UsageSource = { version: snapshot.version, sessions: [{ id: "session-models", client: "codex", clientSessionId: "session-models", title: "Synthetic model identities", titleOrigin: "recorded", models: modelNames.filter((model): model is string => model !== undefined), messageCount: 4, turnCount: 1, gaps: [], startedAt: "2025-12-30T00:00:00Z" }],
  requests: modelNames.map((model, index) => ({ sessionId: "session-models", usage: { id: `request-${index}`, model, inputTokens: 100, outputTokens: 10, occurredAt: "2025-12-30T12:00:00Z" } })) };
const usageWithModels = buildUsageReport(sourceWithModels, { ...usageQuery, models: snapshot.query.models }, testPricing, () => ({ amount: null, coverage: "missing" }));
const expectedOptions = [{ value: "example-model", label: "example-model" }, { value: "literal:literal:model-a", label: "literal:model-a" }, { value: "literal:unknown", label: "unknown" }, { value: "unknown", label: "未知" }];
const emptyResources = { skills: [], mcp: [], observations: [], combinations: { sessions: [], turns: [] }, missingTimeEvents: 0, missingTurnEvents: 0 };

test("首次反向完成顺序：资源和用量先到时立即保留真实分区，概况最后再接入", async () => {
  const h = harness();
  let visible: OverviewPanelBatch | null = null;
  const update = (next: OverviewPanelBatch) => { visible = visibleOverviewBatch(visible, next); };
  const run = loadOverviewPanels({}, "reverse-first", h.transport, new AbortController().signal, update, update);
  await flush(); h.resolve("resources", snapshot, { resources: emptyResources }); await flush();
  assert.equal(visible!.panels.resources!.data.resources, emptyResources);
  assert.equal(visible!.panels.core, undefined);
  h.resolve("usage", snapshot, { usage: usageWithModels }); await flush();
  assert.equal(visible!.panels.usage!.data.usage, usageWithModels);
  assert.equal(visible!.panels.core, undefined);
  assert.equal(visible!.panels.resources!.data.resources, emptyResources);
  assert.deepEqual(overviewModelOptions(undefined, visible!.panels.usage!.data.usage!.facets.models, "未知"), expectedOptions);
  assert.ok(expectedOptions.some(option => option.value === snapshot.query.models![0]));
  for (const panel of ["repositories", "process", "facets", "distribution"] as const) h.resolve(panel);
  await flush(); assert.equal(visible!.complete, false);
  h.resolve("core", snapshot, { facets: { clients: ["codex"], projects: [], models: ["global-model", "example-model"] } });
  update(await run); assert.equal(visible!.complete, true);
  assert.deepEqual(overviewModelOptions(visible!.panels.core!.data.facets!.models, visible!.panels.usage!.data.usage!.facets.models, "未知"), [{ value: "global-model", label: "global-model" }, ...expectedOptions]);
});

test("首次核心失败不抹去已成功的资源和用量，也不伪造概况数值", async () => {
  const h = harness();
  let visible: OverviewPanelBatch | null = null;
  const errors: OverviewPanel[] = [];
  const update = (next: OverviewPanelBatch) => { visible = visibleOverviewBatch(visible, next); };
  const run = loadOverviewPanels({}, "core-failed", h.transport, new AbortController().signal, update, update, panel => errors.push(panel));
  await flush(); h.resolve("resources", snapshot, { resources: emptyResources }); h.resolve("usage", snapshot, { usage: usageWithModels });
  h.gates.get("core")!.reject(new Error("synthetic core failure"));
  for (const panel of ["repositories", "process", "facets", "distribution"] as const) h.resolve(panel);
  await assert.rejects(run, /synthetic core failure/);
  assert.equal(visible!.panels.core, undefined);
  assert.equal(visible!.panels.resources!.data.resources, emptyResources);
  assert.equal(visible!.panels.usage!.data.usage, usageWithModels);
  assert.equal(visible!.complete, false); assert.deepEqual(errors, ["core"]);
  assert.deepEqual(overviewModelOptions(undefined, visible!.panels.usage!.data.usage!.facets.models, "未知"), expectedOptions);
  assert.ok(expectedOptions.some(option => option.value === snapshot.query.models![0]));
  const source = readFileSync(new URL("../web/features/overview/Overview.tsx", import.meta.url), "utf8");
  assert.match(source, /const report = batch \?/);
  assert.doesNotMatch(source, /const report = batch\?\.panels\.core/);
  assert.match(source, /as OverviewViewReport/);
  assert.match(source, /overviewModelOptions\(report\?\.facets\?\.models, report\?\.usage\?\.facets.models, t\("overview.unknown"\)\)/);
  assert.match(source, /options=\{\[\{ value: "__all__", label: t\("overview.all"\) \}, \.\.\.modelOptions\]\}/);
  assert.match(source, /\{report.resources \? resourceTable/);
  assert.match(source, /\{report.usage \? <section/);
  assert.match(source, /\{summary && activity \? <div className="overview-metrics"/);
});

test("已有完整结果遇到反向完成或核心失败时，仍保留旧完整批次而不混入新资源", async () => {
  const previous: OverviewPanelBatch = { key: "old-complete", snapshot, panels: {}, distributions: {}, dimension: "project", complete: true };
  let visible = previous;
  const h = harness(), update = (next: OverviewPanelBatch) => { visible = visibleOverviewBatch(visible, next); };
  const run = loadOverviewPanels({}, "next-incomplete", h.transport, new AbortController().signal, update, update);
  await flush(); h.resolve("resources", snapshot, { resources: emptyResources }); h.resolve("usage", snapshot, { usage: emptyUsage }); await flush();
  assert.equal(visible, previous);
  h.gates.get("core")!.reject(new Error("synthetic core failure"));
  for (const panel of ["repositories", "process", "facets", "distribution"] as const) h.resolve(panel);
  await assert.rejects(run, /synthetic core failure/); assert.equal(visible, previous);
});


test("两种模型来源只编码一次，真实用量facet保留缺失、原名unknown和literal前缀的回选身份", () => {
  assert.deepEqual(usageWithModels.facets.models, expectedOptions.map(option => option.value));
  const options = overviewModelOptions(undefined, usageWithModels.facets.models, "未知");
  assert.deepEqual(options, expectedOptions);
  assert.equal(overviewModelOptions(undefined, usageWithModels.facets.models, "Unknown").find(option => option.value === "unknown")!.label, "Unknown");
  assert.equal(overviewModelOptions(undefined, usageWithModels.facets.models, "Unknown").find(option => option.value === "literal:unknown")!.label, "unknown");
  for (const option of options) {
    const selected = buildUsageReport(sourceWithModels, { ...usageQuery, groupBy: "model", models: [option.value] }, testPricing, () => ({ amount: null, coverage: "missing" }));
    assert.equal(selected.totals.requests, 1);
    assert.deepEqual(selected.groups.map(group => group.key), [option.value]);
  }
  assert.deepEqual(overviewModelOptions(["unknown", "literal:model-a"], usageWithModels.facets.models, "未知"), [{ value: usageDimensionKey("unknown"), label: "unknown" }, { value: usageDimensionKey("literal:model-a"), label: "literal:model-a" }, { value: "example-model", label: "example-model" }, { value: "unknown", label: "未知" }]);
  assert.deepEqual(overviewModelOptions([], usageWithModels.facets.models, "未知"), expectedOptions);
});

const rankRow = (key: string) => ({ key, name: key, count: 3, sessions: 1, requests: 3, tokens: 120, estimatedCost: 0.2, costCoverage: "complete" as const });
const distributionResult = (dimension: "project" | "client" | "model", fixed = snapshot): OverviewPanelResult => ({ snapshot: fixed, panel: "distribution", dimension, data: { distribution: [rankRow(`${dimension}-example`)] } });
const completeBatch = (fixed = snapshot): OverviewPanelBatch => ({ key: "ready", snapshot: fixed, dimension: "project", complete: true, distributions: { project: distributionResult("project", fixed) }, panels: Object.fromEntries(requiredOverviewPanels("project").map(panel => [panel, panel === "distribution" ? distributionResult("project", fixed) : { snapshot: fixed, panel, data: {} }])) });

test("默认批次只包含当前维度和独立候选，工具模式省略额外分布且不请求委派", async () => {
  const h = harness();
  const run = loadOverviewPanels({}, "tool", h.transport, new AbortController().signal, () => {}, () => {}, undefined, () => "tool");
  await flush();
  const panels = h.paths.slice(1).map(path => new URL(`http://example.invalid${path}`).searchParams.get("panel"));
  assert.deepEqual(panels, [...overviewPanels.filter(panel => panel !== "insights"), "facets"]); assert.equal(h.paths.length, 7);
  for (const panel of requiredOverviewPanels("tool")) h.resolve(panel);
  assert.equal((await run).dimension, "tool");
  assert.equal(h.paths.some(path => path.includes("delegation")), false);
});

test("维度切换只补一个同快照请求，回选缓存复用且不会再读六分区或快照", async () => {
  let batch = completeBatch(); const core = batch.panels.core; const paths: string[] = [];
  const transport = async <T>(path: string): Promise<T> => { paths.push(path); return distributionResult("client") as T; };
  const initial = visibleOverviewDistribution(null, batch, "project")!;
  assert.equal(visibleOverviewDistribution(initial, batch, "client"), initial);
  const result = await loadOverviewPanel(snapshot, "distribution", transport, new AbortController().signal, "client");
  batch = replaceOverviewPanel(batch, snapshot, result)!;
  assert.equal(batch.panels.core, core);
  assert.equal(visibleOverviewDistribution(initial, batch, "client")!.dimension, "client");
  assert.equal(visibleOverviewDistribution(null, batch, "project")!.dimension, "project");
  assert.equal(paths.length, 1);
  const params = new URL(`http://example.invalid${paths[0]}`).searchParams;
  assert.equal(params.get("panel"), "distribution"); assert.equal(params.get("dimension"), "client");
  assert.equal(params.get("version"), snapshot.version); assert.equal(params.get("priceVersion"), snapshot.priceVersion);
  assert.equal(params.get("models"), JSON.stringify(snapshot.query.models));
});

test("快速切换分布取消前一次请求，迟到响应与错误不能覆盖新选择", async () => {
  const clientGate = deferred<OverviewPanelResult>(), modelGate = deferred<OverviewPanelResult>();
  const first = new AbortController(), second = new AbortController(); let batch = completeBatch();
  const transport = async <T>(path: string): Promise<T> => new URL(`http://example.invalid${path}`).searchParams.get("dimension") === "client" ? clientGate.promise as Promise<T> : modelGate.promise as Promise<T>;
  const old = loadOverviewPanel(snapshot, "distribution", transport, first.signal, "client").then(result => { batch = replaceOverviewPanel(batch, snapshot, result)!; });
  first.abort();
  const next = loadOverviewPanel(snapshot, "distribution", transport, second.signal, "model").then(result => { batch = replaceOverviewPanel(batch, snapshot, result)!; });
  modelGate.resolve(distributionResult("model")); await next;
  clientGate.resolve(distributionResult("client")); await assert.rejects(old, { name: "AbortError" });
  assert.equal(batch.distributions.client, undefined); assert.equal(visibleOverviewDistribution(null, batch, "model")!.rows[0]!.key, "model-example");
});

test("分布错误保留旧排名，显式重试成功后恢复新维度且不修改其他区域", async () => {
  let batch = completeBatch(); const core = batch.panels.core;
  const previous = visibleOverviewDistribution(null, batch, "project")!; let calls = 0;
  const transport = async <T>(): Promise<T> => { if (++calls === 1) throw new Error("Synthetic distribution failure"); return distributionResult("model") as T; };
  await assert.rejects(loadOverviewPanel(snapshot, "distribution", transport, new AbortController().signal, "model"), /Synthetic distribution failure/);
  assert.equal(visibleOverviewDistribution(previous, batch, "model"), previous); assert.equal(batch.distributions.model, undefined);
  batch = replaceOverviewPanel(batch, snapshot, await loadOverviewPanel(snapshot, "distribution", transport, new AbortController().signal, "model"))!;
  assert.equal(calls, 2); assert.equal(batch.panels.core, core); assert.equal(batch.complete, true);
  assert.equal(visibleOverviewDistribution(previous, batch, "model")!.dimension, "model");
});

test("全局更新期间改变维度只补新快照分布，所有必需区域齐备才替换旧完整结果", async () => {
  const h = harness(), clientGate = deferred<OverviewPanelResult>(); let dimension: "project" | "client" = "project";
  const previous = completeBatch({ ...snapshot, version: "index-old" }); let visible = previous;
  const transport = async <T>(path: string): Promise<T> => {
    if (new URL(`http://example.invalid${path}`).searchParams.get("dimension") === "client") { h.paths.push(path); return clientGate.promise as Promise<T>; }
    return h.transport<T>(path);
  };
  const update = (next: OverviewPanelBatch) => { visible = visibleOverviewBatch(visible, next); };
  const run = loadOverviewPanels({}, "refresh", transport, new AbortController().signal, update, update, undefined, () => dimension);
  await flush(); dimension = "client";
  for (const panel of requiredOverviewPanels("project")) h.resolve(panel);
  await flush(); assert.equal(visible, previous); assert.equal(h.paths.length, 9);
  const extra = new URL(`http://example.invalid${h.paths.at(-1)}`).searchParams;
  assert.equal(extra.get("version"), snapshot.version); assert.equal(extra.get("dimension"), "client");
  clientGate.resolve(distributionResult("client")); update(await run);
  assert.equal(visible.key, "refresh"); assert.equal(visible.dimension, "client"); assert.equal(visible.complete, true);
  assert.equal(visible.distributions.project, undefined); assert.equal(visible.distributions.client?.snapshot.version, snapshot.version);
  assert.equal(replaceOverviewPanel(visible, previous.snapshot, distributionResult("model", previous.snapshot)), visible);
  assert.equal(visibleOverviewDistribution(visibleOverviewDistribution(null, previous, "project"), visible, "model"), null);
});

test("全局更新时旧维度失败不阻断已改选工具，当前必需结果仍可原子发布", async () => {
  const h = harness(); let dimension: "project" | "tool" = "project"; const errors: OverviewPanel[] = [];
  const run = loadOverviewPanels({}, "switch-tool", h.transport, new AbortController().signal, () => {}, () => {}, panel => errors.push(panel), () => dimension);
  await flush(); dimension = "tool";
  for (const panel of requiredOverviewPanels("tool")) h.resolve(panel);
  h.gates.get("distribution")!.reject(new Error("Unused dimension failure"));
  const batch = await run; assert.equal(batch.dimension, "tool"); assert.equal(batch.complete, true); assert.deepEqual(errors, []);
});

const delegation = { eligibleMainSessions: 2, withChildActivity: 1, unknownMainSessions: 0, forkSessions: 0, unknownRelationshipSessions: 0, childRequests: 3, assignedRequests: 2, childTokens: 200, assignedTokens: 120 };
const evidencePage = { version: snapshot.version, priceVersion: snapshot.priceVersion, timezone: snapshot.timezone, query: { kind: "delegation" as const }, rows: [], total: 0, page: 1, pageSize: 20 };
const delegationPanel: OverviewPanelResult = { panel: "delegation", snapshot, data: { delegation } };

test("委派分摊仅在委派证据打开时请求，同快照分页和回选复用详细分摊", async () => {
  const paths: string[] = [];
  const transport = async <T>(path: string): Promise<T> => { paths.push(path); return (path.startsWith("/overview/panel") ? delegationPanel : evidencePage) as T; };
  await loadOverviewInvestigation(snapshot, { evidence: { kind: "sessions" } }, transport, new AbortController().signal);
  assert.equal(paths.length, 1); assert.ok(paths[0]!.startsWith("/overview/evidence"));
  const loaded = await loadOverviewInvestigation(snapshot, { evidence: { kind: "delegation" } }, transport, new AbortController().signal);
  assert.equal(paths.length, 3); assert.equal(loaded.delegation!.data.delegation, delegation);
  await loadOverviewInvestigation(snapshot, { evidence: { kind: "delegation", page: 2 } }, transport, new AbortController().signal, loaded.delegation);
  assert.equal(paths.length, 4); assert.equal(paths.filter(path => path.startsWith("/overview/panel")).length, 1);
  for (const path of paths) { const params = new URL(`http://example.invalid${path}`).searchParams; assert.equal(params.get("version"), snapshot.version); assert.equal(params.get("priceVersion"), snapshot.priceVersion); }
});

test("委派证据与分摊等待共同成功，错误和快照不符都不发布混合调查", async () => {
  const panelGate = deferred<OverviewPanelResult>(), evidenceGate = deferred<typeof evidencePage>(); let completed = false;
  const transport = async <T>(path: string): Promise<T> => path.startsWith("/overview/panel") ? panelGate.promise as Promise<T> : evidenceGate.promise as Promise<T>;
  const run = loadOverviewInvestigation(snapshot, { evidence: { kind: "delegation" } }, transport, new AbortController().signal).then(result => { completed = true; return result; });
  evidenceGate.resolve(evidencePage); await flush(); assert.equal(completed, false);
  panelGate.resolve(delegationPanel); assert.equal((await run).delegation, delegationPanel);
  await assert.rejects(loadOverviewInvestigation(snapshot, { evidence: { kind: "delegation" } }, async <T>(path: string): Promise<T> => (path.startsWith("/overview/panel") ? { ...delegationPanel, snapshot: { ...snapshot, priceVersion: "prices-new" } } : evidencePage) as T, new AbortController().signal), OverviewSnapshotMismatch);
  let calls = 0;
  const retryTransport = async <T>(path: string): Promise<T> => { if (path.startsWith("/overview/panel") && ++calls === 1) throw new Error("Synthetic delegation failure"); return (path.startsWith("/overview/panel") ? delegationPanel : evidencePage) as T; };
  await assert.rejects(loadOverviewInvestigation(snapshot, { evidence: { kind: "delegation" } }, retryTransport, new AbortController().signal), /Synthetic delegation failure/);
  assert.equal((await loadOverviewInvestigation(snapshot, { evidence: { kind: "delegation" } }, retryTransport, new AbortController().signal)).delegation, delegationPanel);
  assert.equal(calls, 2);
});

test("委派分摊缓存不跨模型或日期快照复用，关闭取消时迟到结果不发布", async () => {
  const changed = { ...snapshot, query: { ...snapshot.query, models: ["other-model"] } }; const gate = deferred<OverviewPanelResult>(); const controller = new AbortController(); let panelCalls = 0;
  const transport = async <T>(path: string): Promise<T> => { if (path.startsWith("/overview/panel")) { panelCalls += 1; return gate.promise as Promise<T>; } return evidencePage as T; };
  const run = loadOverviewInvestigation(changed, { evidence: { kind: "delegation" } }, transport, controller.signal, delegationPanel);
  assert.equal(panelCalls, 1); controller.abort(); gate.resolve({ ...delegationPanel, snapshot: changed });
  await assert.rejects(run, { name: "AbortError" });
});

test("委派用量的四个明细字段补齐中英文，概要仍从轻量主子信息显示", async () => {
  const { translate } = await import("../src/i18n/index.ts");
  for (const language of ["en", "zh-CN"] as const) for (const field of ["childRequests", "assignedRequests", "childTokens", "assignedTokens"]) assert.notEqual(translate(language, `overview.delegation.${field}`), `overview.delegation.${field}`);
  const source = readFileSync(new URL("../web/features/overview/Overview.tsx", import.meta.url), "utf8");
  assert.match(source, /report.delegationSummary\?\.withChildActivity/); assert.doesNotMatch(source, /report.delegation\?\.withChildActivity/);
  assert.match(source, /inert=\{distributionPending \|\| distributionLoading\}/);
});


test("首次分布失败后改选当前维度，补读和工具切换按当前必需数据恢复完整性", () => {
  const partial = { ...completeBatch(), complete: false, distributions: {} };
  const client = selectOverviewDimension(partial, "client");
  assert.equal(client.complete, false);
  assert.equal(replaceOverviewPanel(client, snapshot, distributionResult("client"))!.complete, true);
  assert.equal(selectOverviewDimension(partial, "tool").complete, true);
});

test("分布响应必须符合请求维度，不能将其他维度排名伪装成当前选择", async () => {
  await assert.rejects(loadOverviewPanel(snapshot, "distribution", async <T>(): Promise<T> => distributionResult("project") as T, new AbortController().signal, "model"), OverviewSnapshotMismatch);
});

function dimensionSelection(initial: "project" | "model" | "client" | "tool" = "project") {
  let dimension = initial; const listeners = new Set<() => void>();
  return { current: () => dimension, select: (next: typeof dimension) => { dimension = next; for (const listener of listeners) listener(); }, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}

for (const mode of ["first", "refresh"] as const) test(`${mode}：项目请求未返回时立即补读模型，当前必需结果成功即可完成`, async () => {
  const h = harness(), modelGate = deferred<OverviewPanelResult>(), controller = new AbortController(), selection = dimensionSelection();
  let projectSignal: AbortSignal | undefined, completed = false;
  const previous = mode === "refresh" ? completeBatch({ ...snapshot, version: "index-old" }) : null;
  let visible: OverviewPanelBatch | null = previous;
  const delivered: OverviewPanelBatch[] = [];
  const update = (next: OverviewPanelBatch) => { delivered.push(next); visible = visibleOverviewBatch(visible, next); };
  const transport = async <T>(path: string, signal: AbortSignal): Promise<T> => {
    const params = new URL(`http://example.invalid${path}`).searchParams;
    if (params.get("dimension") === "project") projectSignal = signal;
    if (params.get("dimension") === "model") { h.paths.push(path); return modelGate.promise as Promise<T>; }
    return h.transport<T>(path);
  };
  const run = loadOverviewPanels({}, mode, transport, controller.signal, update, update, undefined, selection.current, selection.subscribe).then(result => { completed = true; update(result); return result; });
  try {
    await flush();
    for (const panel of requiredOverviewPanels("tool")) h.resolve(panel);
    await flush(); selection.select("model"); await flush();
    assert.equal(h.paths.filter(path => path.includes("dimension=model")).length, 1, "选择通知立刻请求新维度，不等待项目响应");
    assert.equal(projectSignal!.aborted, true);
    assert.equal(completed, false); if (previous) assert.equal(visible, previous);
    modelGate.resolve(distributionResult("model")); await flush();
    assert.equal(completed, true, "模型和基础分区齐备后完成，未释放项目gate");
    assert.equal(visible!.complete, true); assert.equal(visible!.dimension, "model");
    const published = delivered.length;
    h.resolve("distribution"); await flush(); assert.equal(delivered.length, published, "项目迟到不再发布分区");
    selection.select("client"); await flush(); assert.equal(h.paths.filter(path => path.includes("dimension=client")).length, 0, "已完成批次取消维度监听");
  } finally { controller.abort(); for (const panel of requiredOverviewPanels("project")) h.resolve(panel); modelGate.resolve(distributionResult("model")); await run.catch(() => undefined); }
});

for (const mode of ["first", "refresh"] as const) test(`${mode}：切换工具立即完成已就绪基础批次，不等待未返回项目分布`, async () => {
  const h = harness(), controller = new AbortController(), selection = dimensionSelection(); let completed = false;
  const run = loadOverviewPanels({}, mode, h.transport, controller.signal, () => {}, () => {}, undefined, selection.current, selection.subscribe).then(result => { completed = true; return result; });
  try {
    await flush(); for (const panel of requiredOverviewPanels("tool")) h.resolve(panel);
    await flush(); selection.select("tool"); await flush();
    assert.equal(completed, true, "工具使用process，项目未返回不阻断当前批次");
    const result = await run; assert.equal(result.dimension, "tool"); assert.equal(result.complete, true);
    assert.equal(result.distributions.project, undefined); assert.equal(h.paths.length, 8);
  } finally { controller.abort(); h.resolve("distribution"); await run.catch(() => undefined); }
});

test("基础区加载期间完成的维度可以回选缓存，废弃请求失败不污染当前选择", async () => {
  const h = harness(), modelGate = deferred<OverviewPanelResult>(), controller = new AbortController(), selection = dimensionSelection(), errors: OverviewPanel[] = [];
  let modelSignal: AbortSignal | undefined;
  const transport = async <T>(path: string, signal: AbortSignal): Promise<T> => {
    if (new URL(`http://example.invalid${path}`).searchParams.get("dimension") === "model") { modelSignal = signal; h.paths.push(path); return modelGate.promise as Promise<T>; }
    return h.transport<T>(path);
  };
  const run = loadOverviewPanels({}, "cache-in-flight", transport, controller.signal, () => {}, () => {}, panel => errors.push(panel), selection.current, selection.subscribe);
  try {
    await flush(); h.resolve("distribution"); await flush();
    selection.select("model"); await flush(); assert.equal(h.paths.length, 9);
    selection.select("project"); await flush(); assert.equal(modelSignal!.aborted, true); assert.equal(h.paths.length, 9);
    modelGate.reject(new Error("Unused model failure")); await flush(); assert.deepEqual(errors, []);
    for (const panel of requiredOverviewPanels("tool")) h.resolve(panel);
    const result = await run; assert.equal(result.dimension, "project"); assert.equal(result.distributions.model, undefined); assert.equal(result.complete, true);
  } finally { controller.abort(); for (const panel of requiredOverviewPanels("project")) h.resolve(panel); modelGate.resolve(distributionResult("model")); await run.catch(() => undefined); }
});
