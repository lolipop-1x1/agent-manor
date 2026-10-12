import assert from "node:assert/strict";
import test from "node:test";
import type { OverviewEvent, OverviewInsight, OverviewQuery, OverviewReport, OverviewResourceRow, OverviewSource } from "../src/overview-contracts.js";
import type { SessionSummary, SessionUsage } from "../src/session-contracts.js";
import type { PricingView } from "../src/usage/pricing.js";
import { buildOverviewReport, resultCounts } from "../src/overview/analytics.js";
import { generateOverviewInsights } from "../src/overview/insights.js";
import { buildOverviewEvidence } from "../src/overview/evidence.js";
import { decomposeUsage, selectFeaturedInsights } from "../src/overview/insight-math.js";
import { modelTransitions, projectMonths } from "../src/overview/details.js";

const pricing: PricingView = { status: { version: "prices-test", source: "bundled", sourceUrl: "https://example.invalid/prices",
  refreshing: false, currency: "USD", configuration: { overrides: [], mappings: [] }, prices: [] },
  estimate(usage, client) {
    const freshInputTokens = usage.inputTokens !== undefined && usage.cachedInputTokens !== undefined
      && (usage.cacheWriteTokens !== undefined || client === "codex")
      ? usage.inputTokens - usage.cachedInputTokens - (usage.cacheWriteTokens ?? 0) : undefined;
    return { amount: usage.inputTokens !== undefined && usage.outputTokens !== undefined
      ? (usage.inputTokens + usage.outputTokens) / 1_000_000 : null,
      coverage: usage.inputTokens !== undefined && usage.outputTokens !== undefined ? "complete" : "missing", freshInputTokens };
  } };
const now = new Date("2026-03-01T12:00:00Z");
const query: OverviewQuery = { window: "custom", from: "2026-02-01", to: "2026-02-28", timezone: "UTC" };
const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({ id, client: "codex", clientSessionId: id,
  title: "合成会话", titleOrigin: "recorded", messageCount: 1, turnCount: 1, models: [], gaps: [], project: "/workspace/project-a", ...extra });
const usage = (id: string, extra: Partial<SessionUsage> = {}): SessionUsage => ({ id, model: "model-a", inputTokens: 80, outputTokens: 20,
  cachedInputTokens: 10, cacheWriteTokens: 0, occurredAt: "2026-02-10T12:00:00Z", ...extra });
const event = (id: string, sessionId: string, extra: Partial<OverviewEvent> = {}): OverviewEvent => ({ id, sessionId, ordinal: 1,
  turnId: `${sessionId}:turn:1`, kind: "user", occurredAt: "2026-02-10T12:00:00Z", ...extra });
const source = (sessions: SessionSummary[] = [session("main")]): OverviewSource => ({ version: "index-test", sessions,
  events: sessions.map(item => event(`user-${item.id}`, item.id)), requests: [], resources: [], gaps: [] });
function analyze(input: OverviewSource, filters: OverviewQuery = query, change?: (report: OverviewReport) => void) {
  const report = buildOverviewReport(input, filters, pricing, now);
  change?.(report);
  return generateOverviewInsights(input, filters, pricing, report);
}
function usageChangeSource(): OverviewSource {
  const input = source();
  input.requests = [
    ...Array.from({ length: 20 }, (_, index) => ({ sessionId: "main", ordinal: index + 1,
      usage: usage(`previous-${index}`, { occurredAt: "2026-01-15T12:00:00Z" }) })),
    ...Array.from({ length: 40 }, (_, index) => ({ sessionId: "main", ordinal: index + 21,
      usage: usage(`current-${index}`, { inputTokens: 130 }) })),
  ];
  return input;
}
function resource(id: string, extra: Partial<OverviewResourceRow> = {}): OverviewResourceRow {
  return { id, kind: "skill", name: id, uses: 25, sessions: 5, explicitCalls: 25, successfulReads: 0, activeWeeks: 4,
    firstDay: "2026-02-01", lastDay: "2026-02-25", averagePerSession: 5, clients: [], projects: [], tools: [], days: [],
    results: resultCounts(Array(25).fill("success")), ...extra };
}
test("核心用量变化保持对称贡献、完整子集和缺失数量", () => {
  assert.deepEqual(decomposeUsage(20, 2000, 40, 6000), { previousMean: 100, currentMean: 150, countContribution: 2500, meanContribution: 1500 });
  const input = usageChangeSource(); input.requests.push({ sessionId: "main", ordinal: 61, usage: usage("partial", { outputTokens: undefined }) });
  const insight = analyze(input).insights.find(item => item.rule === "01")!;
  assert.equal(insight.current, 6000); assert.equal(insight.previous, 2000); assert.equal(insight.values?.countContribution, 2500);
  assert.equal(insight.values?.meanContribution, 1500); assert.equal(insight.missing, 1); assert.equal(insight.sample, 40);
  assert.equal(insight.period.from, "2026-02-01"); assert.equal(insight.previousPeriod?.to, "2026-01-31");
});
test("零基数、小样本及小幅波动不生成变化也不补满五条", () => {
  const input = source(); input.requests = [{ sessionId: "main", ordinal: 1, usage: usage("single") }];
  assert.deepEqual(analyze(input).insights, []);
  const stable = usageChangeSource(); stable.requests = stable.requests.slice(0, 40).map((row, index) => ({ ...row,
    usage: { ...row.usage, inputTokens: index < 20 ? 80 : 81 } }));
  assert.equal(analyze(stable).insights.some(row => row.rule === "01"), false);
});
test("大量片段、组合和后续调用不再生成洞察", () => {
  const input = source();
  input.requests = Array.from({ length: 3000 }, (_, index) => ({ sessionId: "main", ordinal: index,
    usage: usage(`request-${index}`, { inputTokens: index + 100, model: index % 2 ? "model-a" : "model-b" }) }));
  input.events.push(...Array.from({ length: 1000 }, (_, index) => event(`call-${index}`, "main", {
    ordinal: index + 2, kind: "tool_call", tool: "synthetic-tool", status: index % 2 ? "success" : "failure" })));
  const result = analyze(input);
  assert.ok(result.insights.length <= 5); assert.deepEqual(result.insights, result.featuredInsights);
  assert.ok(result.insights.every(row => !["02", "10", "12", "14", "15", "16"].includes(row.rule)));
  assert.deepEqual(result.projectMonths, []); assert.deepEqual(result.modelTransitions, []);
});
test("资源偏好需要多个会话及长期实际使用，未知名称不进入核心", () => {
  assert.equal(analyze(source(), query, report => { report.resources.skills = [resource("short", { activeWeeks: 3 }), resource("small", { sessions: 4 }),
    resource("unknown", { nameDescriptor: { key: "sessions.resource.nameUnrecorded" } })]; }).insights.length, 0);
  const result = analyze(source(), query, report => { report.resources.skills = [resource("established")]; });
  assert.equal(result.insights.length, 1); assert.equal(result.insights[0]?.object, "established");
  assert.equal(result.insights[0]?.evidence.resourceId, "established");
});
test("确凿过程问题需要已知结果和覆盖，小失败仍可在调查中查看", () => {
  const input = source();
  input.events.push(event("failed", "main", { kind: "tool_call", tool: "synthetic-tool", status: "failure" }));
  assert.equal(analyze(input).insights.length, 0);
  input.events.push(...Array.from({ length: 19 }, (_, index) => event(`known-${index}`, "main", { ordinal: index + 2,
    kind: "tool_call", tool: "synthetic-tool", status: index < 2 ? "failure" : "success" })));
  const insight = analyze(input).insights[0]!; assert.equal(insight.rule, "11"); assert.equal(insight.current, 3);
  assert.equal(buildOverviewEvidence(input, query, insight.evidence, pricing, now).total, 3);
  input.events.push(...Array.from({ length: 10 }, (_, index) => event(`unknown-${index}`, "main", { ordinal: index + 30,
    kind: "tool_call", tool: "synthetic-tool", status: "unknown" })));
  assert.equal(analyze(input).insights.length, 0);
});
test("项目和模型变化选择显著占比变化，保留精确调查维度", () => {
  const input = source([session("a", { project: "/synthetic/a" }), session("b", { project: "/synthetic/b" })]);
  input.requests = ["previous", "current"].flatMap((period, index) => Array.from({ length: 100 }, (_, ordinal) => ({
    sessionId: ordinal < (index ? 70 : 30) ? "a" : "b", ordinal: index * 100 + ordinal,
    usage: usage(`${period}-${ordinal}`, { model: ordinal < (index ? 70 : 30) ? "model-a" : "model-b",
      occurredAt: index ? "2026-02-10T12:00:00Z" : "2026-01-10T12:00:00Z" }) })));
  const rows = analyze(input).insights;
  assert.equal(rows.filter(row => row.rule === "07").length, 1); assert.equal(rows.filter(row => row.rule === "08").length, 1);
  assert.equal(rows.find(row => row.rule === "07")?.evidence.project, "/synthetic/a");
  assert.equal(rows.find(row => row.rule === "08")?.evidence.model, "model-a");
});
test("保留名称的项目和模型变化使用查询身份回查原始请求", () => {
  for (const name of ["unknown", "literal:project-a"]) {
    const input = source([session("a", { project: name }), session("b", { project: "zz-synthetic" })]);
    input.requests = ["previous", "current"].flatMap((period, index) => Array.from({ length: 100 }, (_, ordinal) => ({
      sessionId: ordinal < (index ? 70 : 30) ? "a" : "b", ordinal: index * 100 + ordinal,
      usage: usage(`${period}-${ordinal}`, { model: ordinal < (index ? 70 : 30) ? name : "model-b",
        occurredAt: index ? "2026-02-10T12:00:00Z" : "2026-01-10T12:00:00Z" }) })));
    const rows = analyze(input).insights.filter(row => row.rule === "07" || row.rule === "08");
    assert.equal(rows.length, 2);
    for (const insight of rows) {
      assert.equal(insight.object, name);
      assert.equal(insight.rule === "07" ? insight.evidence.project : insight.evidence.model, `literal:${name}`);
      assert.equal(buildOverviewEvidence(input, query, insight.evidence, pricing, now).total, 70);
    }
  }
});
test("月份调查按需保持全局活跃会话，模型只影响请求和Token", () => {
  const input = source([session("a"), session("b")]);
  input.requests = [{ sessionId: "a", ordinal: 1, usage: usage("a", { model: "model-a" }) }, { sessionId: "b", ordinal: 1, usage: usage("b", { model: "model-b" }) }];
  const report = buildOverviewReport(input, { ...query, models: ["model-a"] }, pricing, now), rows = projectMonths(input, report);
  assert.equal(rows.length, 1); assert.equal(rows[0]?.sessions, 2); assert.equal(rows[0]?.requests, 1); assert.equal(rows[0]?.tokens, 100);
});
test("模型路径不桥接未知模型、日期及重复顺序", () => {
  const input = source(); input.requests = [usage("a", { model: "model-a" }), usage("unknown", { model: undefined }), usage("b", { model: "model-b" })]
    .map((usage, ordinal) => ({ sessionId: "main", ordinal, usage }));
  const report = buildOverviewReport(input, query, pricing, now);
  assert.deepEqual(modelTransitions(input, report), []);
  input.requests.splice(1, 1); assert.equal(modelTransitions(input, report)[0]?.count, 1);
  input.requests[1]!.ordinal = 0; assert.deepEqual(modelTransitions(input, report), []);
});
test("重点选取仍有界，无候选时返回空列表", () => {
  const row = (id: string, type: OverviewInsight["type"]): OverviewInsight => ({ id, type, rule: "01", descriptor: { key: "synthetic" },
    current: 1, sample: 20, missing: 0, period: { from: "2026-02-01", to: "2026-02-28" }, evidence: { kind: "requests" } });
  assert.equal(selectFeaturedInsights(Array.from({ length: 50 }, (_, index) => row(String(index), ["feature", "change", "investigation"][index % 3] as OverviewInsight["type"]))).length, 5);
  assert.deepEqual(selectFeaturedInsights([]), []);
});
