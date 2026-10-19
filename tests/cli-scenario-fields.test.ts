import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { coreResponse } from "../src/service/core-response.js";
import { summaryRequestPath, summarizeResponse } from "../packages/cli/src/output/summary.js";
import { startService } from "../src/server.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

test("活动列表和文件详情不重复原始调用正文，单事件证据保持完整", () => {
  const event = { id: "event-1", client: "codex", sessionId: "session-1", tool: "read", kind: "read", status: "unknown", path: "src/example.ts",
    input: { text: "input".repeat(50_000) }, output: "output".repeat(50_000), fragments: [{ content: "code".repeat(50_000) }],
    sources: [{ sourceId: "source-1", path: "/workspace/history", hash: "hash", recordLine: 1 }],
    mapping: { exactRanges: [], nearRanges: [], unknownReason: "Synthetic uncertainty" } };
  const value = { version: "v1", events: [event], total: 1, page: 1, pageSize: 20 };
  const small = coreResponse("/repositories/repo/events", "GET", value) as any;
  assert.equal(small.events[0].id, event.id); assert.equal(small.events[0].status, "unknown");
  assert.equal(small.events[0].sourceCount, 1); assert.equal(small.events[0].input, undefined);
  assert.equal(small.events[0].output, undefined); assert.equal(small.events[0].fragments, undefined);
  assert.ok(JSON.stringify(small).length < 1000);
  assert.deepEqual(coreResponse("/repositories/repo/events", "GET", small), small);
  const file = coreResponse("/repositories/repo/file", "GET", { ...value, content: "Current code", contentHash: "current", contentStale: true,
    file: { hash: "baseline", readNearRanges: [{ start: 1, end: 2 }] } }) as any;
  assert.equal(file.content, "Current code"); assert.equal(file.contentStale, true); assert.equal(file.file.hash, "baseline");
  assert.deepEqual(file.events[0].mapping, event.mapping); assert.equal(file.events[0].output, undefined);
  const evidence = { version: "v1", event, records: [{ raw: "original" }], unavailable: [] };
  assert.equal(coreResponse("/repositories/repo/evidence/event-1", "GET", evidence), evidence);
});

test("覆盖列表去掉内部目录、逐文件哈希与诊断正文，覆盖分母和行区间仍可核对", () => {
  const value = { repository: { id: "repo", path: "/workspace/example", commonDir: "/workspace/example/.git" }, version: "v1", baselineHash: "baseline",
    summary: { lineCount: 25 }, files: [{ path: "src/example.ts", hash: "file-hash", lineCount: 25, readExactRanges: [{ start: 1, end: 2 }] }],
    gaps: [{ kind: "source_missing", message: "Verbose diagnosis" }] };
  for (const name of ["coverage", "unobserved", "hotspots"]) {
    const small = coreResponse(`/repositories/repo/${name}`, "GET", value) as any;
    assert.equal(small.repository.commonDir, undefined); assert.equal(small.files[0].hash, undefined);
    assert.deepEqual(small.files[0].readExactRanges, value.files[0]!.readExactRanges);
    assert.equal(small.summary.lineCount, 25); assert.equal(small.baselineHash, "baseline");
    assert.equal(small.gapCount, 1); assert.equal(small.gaps, undefined);
    assert.deepEqual(coreResponse(`/repositories/repo/${name}`, "GET", small), small);
  }
});

test("抽取预览保持整体范围和预算，默认目标展示有界且完整清单可显式读取", () => {
  const targets = Array.from({ length: 1000 }, (_, index) => ({ sessionId: `session-${index}`, title: `Title ${index}`, client: "codex", version: "v1", branch: "main",
    turnCount: 2, inputTokens: 40, contextTokens: 10, messageIds: ["one", "two"], hashes: ["a", "b"],
    limitations: ["Synthetic limitation"], limitationDetails: [{ message: "Repeated detail" }] }));
  const preview = { id: "preview-1", fingerprint: "fp", createdAt: "now", scope: { timeRange: "all", sessionIds: targets.map(row => row.sessionId) },
    sessionCount: 1000, turnCount: 2000, estimatedTokens: 50_000, estimatedCost: null, pendingMessages: 2000, targets,
    limitations: ["Synthetic limitation"], limitationDetails: [{ message: "Top-level detail" }] };
  for (const path of ["/knowledge/extractions/preview", "/knowledge/extractions/previews/preview-1"]) {
    const small = summarizeResponse(path, "POST", preview) as any;
    assert.equal(small.estimatedTokens, 50_000); assert.equal(small.sessionCount, 1000); assert.equal(small.estimatedCost, null);
    assert.equal(small.scope.sessionIds, undefined); assert.equal(small.scope.selectedSessionCount, 1000);
    assert.equal(small.targetCount, 1000); assert.equal(small.targets.length, 20); assert.equal(small.targetsTruncated, true);
    assert.equal(small.targets[0].messageCount, 2); assert.equal(small.targets[0].messageIds, undefined);
    assert.equal(small.targets[0].limitations, undefined); assert.deepEqual(small.limitations, preview.limitations);
    assert.deepEqual(small.limitationDetails, preview.limitationDetails);
    assert.ok(JSON.stringify(small).length < 10_000);
    assert.deepEqual(summarizeResponse(path, "POST", small), small);
    assert.match(summaryRequestPath(path, false, "POST"), /response=summary/);
    assert.equal(summaryRequestPath(path, true, "POST"), path);
  }
  assert.equal(preview.targets.length, 1000); assert.equal(preview.scope.sessionIds.length, 1000);
});

test("用量报告保留趋势、未知和计价依据，价格刷新不回显整份配置", () => {
  const report = { version: "v1", priceVersion: "p1", timezone: "UTC", totals: { cost: null, requests: 2 }, buckets: [{ key: "day", cost: null }],
    days: [{ key: "day", cost: null }], groups: [{ key: "example", cost: null }], facets: { models: ["model"] }, sessions: [], undated: { requests: 1 } };
  const small = summarizeResponse("/usage", "GET", report) as any;
  assert.equal(small.days, undefined); assert.equal(small.facets, undefined); assert.equal(small.totals.cost, null);
  assert.deepEqual(small.buckets, report.buckets); assert.deepEqual(small.groups, report.groups); assert.deepEqual(small.undated, report.undated);
  const refreshed = summarizeResponse("/usage/pricing/refresh", "POST", { version: "p1", source: "cache", refreshing: false, error: "Synthetic refresh failure",
    priceCount: 12, configuration: { mappings: Array(500).fill({ model: "example" }), overrides: [] } }) as any;
  assert.equal(refreshed.configuration, undefined); assert.equal(refreshed.mappingCount, 500); assert.equal(refreshed.priceCount, 12);
  assert.equal(refreshed.error, "Synthetic refresh failure");
  assert.deepEqual(summarizeResponse("/usage/pricing/refresh", "POST", refreshed), refreshed);
});

test("轮次目录仅预览问题，时间线默认有界并尊重显式粒度", () => {
  const question = "中文😀".repeat(1000);
  const small = summarizeResponse("/sessions/one/turns", "GET", { version: "v1", total: 1, turns: [{ id: "turn-1", position: 1, question }] }) as any;
  assert.equal(Array.from(small.turns[0].question).length, 240); assert.equal(small.turns[0].questionTruncated, true);
  assert.equal(small.turns[0].position, 1);
  assert.deepEqual(summarizeResponse("/sessions/one/turns", "GET", small), small);
  assert.match(summaryRequestPath("/sessions/one/timeline", false), /maxEvents=200/);
  assert.match(summaryRequestPath("/sessions/one/timeline?maxEvents=30", false), /maxEvents=30/);
  assert.equal(summaryRequestPath("/sessions/one/timeline", true), "/sessions/one/timeline");
  assert.match(summaryRequestPath("/repositories/repo/events", false), /pageSize=20/);
});

test("资源地图只保留所选指标与管理状态，apply保留实际失败及影响范围", () => {
  const node = { id: "resource-1", name: "Example", value: null, share: null, partial: true, observation: "unknown", favorite: true, protected: true,
    favoriteIds: ["alias-1"], localFavoriteIds: ["body-1"], metrics: { calls: 0 }, localBodyIds: ["body-1"], missingTimeEvents: 2 };
  const small = coreResponse("/resources/map", "GET", { version: "v1", metric: "calls", complete: true, partial: true, positive: [], zero: [node], review: [],
    coverage: { partial: true, gaps: [{ message: "Verbose detail" }] } }) as any;
  assert.equal(small.zero[0].value, null); assert.equal(small.zero[0].observation, "unknown"); assert.equal(small.zero[0].missingTimeEvents, 2);
  assert.equal(small.zero[0].favoriteIds, undefined); assert.equal(small.zero[0].metrics, undefined); assert.equal(small.coverage.gapCount, 1);
  assert.deepEqual(coreResponse("/resources/map", "GET", small), small);
  const webSummary = coreResponse("/resources/map", "GET", { ...small, coverage: { partial: true } }) as any;
  assert.equal(webSummary.coverage.gapCount, undefined, "已有 Web 摘要未提供计数时，不得推断为没有缺口");
  const operation = { id: "operation-1", status: "partial", target: "file", localState: "partial", details: [{ key: "synthetic.diagnostic" }],
    affectedEntries: [{ id: "entry-1", name: "Example" }], link: { state: "unknown" } };
  assert.deepEqual(coreResponse("/resources/apply", "POST", operation), operation);
});

test("HTTP默认偏好写入只回显本次有效变更，完整读取及非法参数写保护保留", async t => {
  const directory = await mkdtemp(join(tmpdir(), "manor-scenario-fields-"));
  const skillDirectory = join(directory, "user", ".claude", "skills", "atlas");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), "---\nname: atlas\ndescription: Synthetic scenario fixture\n---\n\nSynthetic Skill.\n");
  const service = await startService({ home: join(directory, "data"), startupRefresh: false, roots: isolatedHistoryRoots(),
    resourceInventory: { userHome: join(directory, "user"), environment: {} }, usagePricing: { fetch: async () => new Response("offline", { status: 503 }) } });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const api = async (path: string, body?: unknown, status = 200, method = body ? "PUT" : "GET") => {
    const response = await fetch(`http://127.0.0.1:${service.instance.port}/api/v1${path}`, { method, signal: AbortSignal.timeout(10_000),
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, status, await response.clone().text()); return response.json() as Promise<any>;
  };
  await api("/preferences", { language: "en", sessionsAutoRefreshInterval: 60000 });
  assert.deepEqual(await api("/preferences?response=summary", { language: "zh-CN" }), { saved: true, language: "zh-CN" });
  assert.equal((await api("/preferences")).sessionsAutoRefreshInterval, 60000);
  await api("/preferences?response=invalid", { language: "en" }, 400);
  assert.equal((await api("/preferences")).language, "zh-CN");
  const pricing = await api("/usage/pricing?response=summary");
  assert.ok(pricing.configuration, "显式读取配置仍保留完整可编辑值");
  const refreshed = await api("/usage/pricing/refresh?response=summary", undefined, 200, "POST");
  assert.equal(refreshed.configuration, undefined); assert.equal(refreshed.overrideCount, 0); assert.equal(refreshed.mappingCount, 0);
  assert.ok(refreshed.error, "刷新失败仍保留原始诊断");
  const webPricing = await api("/usage/pricing");
  assert.ok(webPricing.configuration); assert.ok(webPricing.prices.length > 0, "Web 原请求保留模型价格目录");
  await api("/sessions/refresh", {}, 200, "POST");
  const deadline = Date.now() + 10_000;
  while ((await api("/sessions/status")).job?.status !== "complete") {
    assert.ok(Date.now() < deadline, "合成索引必须完成发布");
    await new Promise(done => setTimeout(done, 20));
  }
  const webMap = await api("/resources/map?kind=skill"), webSummary = await api("/resources/map?kind=skill&summary=true");
  assert.ok(webMap.zero.length > 0);
  assert.ok("metrics" in webMap.zero[0]); assert.ok("localBodyIds" in webMap.zero[0]);
  assert.deepEqual(webSummary.zero, webMap.zero, "Web 的 summary=true 仍保留完整地图节点");
  const cliMap = await api("/resources/map?kind=skill&response=summary");
  assert.equal(cliMap.zero[0].id, webMap.zero[0].id); assert.equal(cliMap.zero[0].metrics, undefined);
  assert.equal(cliMap.zero[0].value, webMap.zero[0].value); assert.equal(cliMap.zero[0].observation, webMap.zero[0].observation);
  const settings = await api("/knowledge/settings");
  const scope = { ...settings.config.automatic.scope, timeRange: "all", sessionIds: ["synthetic-missing-session"] };
  const webPreview = await api("/knowledge/extractions/preview", { scope }, 200, "POST");
  assert.deepEqual(webPreview.scope.sessionIds, scope.sessionIds); assert.ok(Array.isArray(webPreview.targets));
  assert.deepEqual(await api(`/knowledge/extractions/previews/${webPreview.id}`), webPreview, "Web 保存的完整预览保持原契约");
});
