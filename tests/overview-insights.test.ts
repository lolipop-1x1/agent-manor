import assert from "node:assert/strict";
import test from "node:test";
import type { OverviewEvent, OverviewInsight, OverviewQuery, OverviewReport, OverviewResourceRow, OverviewSource } from "../src/overview-contracts.js";
import type { SessionSummary, SessionUsage } from "../src/session-contracts.js";
import type { PricingView } from "../src/usage/pricing.js";
import { buildOverviewReport, resultCounts } from "../src/overview/analytics.js";
import { generateOverviewInsights } from "../src/overview/insights.js";
import { buildOverviewEvidence } from "../src/overview/evidence.js";
import { decomposeUsage, selectFeaturedInsights } from "../src/overview/insight-math.js";
import en from "../src/i18n/locales/en/overview-insights.js";
import zh from "../src/i18n/locales/zh-CN/overview-insights.js";

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
  return generateOverviewInsights(input, filters, pricing, report, now);
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

test("用量变化采用对称贡献，完整子集分母与缺失分项保留", () => {
  assert.deepEqual(decomposeUsage(20, 2000, 40, 6000), { previousMean: 100, currentMean: 150, countContribution: 2500, meanContribution: 1500 });
  const input = usageChangeSource();
  input.requests.push({ sessionId: "main", ordinal: 61, usage: usage("partial", { outputTokens: undefined }) });
  const insight = analyze(input).insights.find(item => item.rule === "01")!;
  assert.equal(insight.current, 6000); assert.equal(insight.previous, 2000);
  assert.equal(insight.values?.countContribution, 2500); assert.equal(insight.values?.meanContribution, 1500);
  assert.equal(insight.missing, 1); assert.equal(insight.sample, 40);
  assert.deepEqual(insight.previousPeriod, { from: "2026-01-04", to: "2026-01-31" });
});

test("零基数和小样本不补造变化百分比或凑足重点", () => {
  assert.equal(decomposeUsage(0, 0, 5, 500), null);
  const input = source();
  input.requests = [{ sessionId: "main", ordinal: 1, usage: usage("single") }];
  const result = analyze(input);
  assert.equal(result.insights.some(item => item.rule === "01"), false);
  assert.equal(result.insights.some(item => item.rule === "02" && item.type === "feature"), false);
  assert.equal(result.featuredInsights.length, 1);
  assert.equal(result.featuredInsights[0]?.descriptor.key, "overview.insight.peak");
});

test("完整自身用量会话与父子身份分别参与集中度", () => {
  const input = source(Array.from({ length: 11 }, (_, index) => session(`s-${index}`, index ? { relationship: "child", parentSessionId: "s-0" } : {})));
  input.requests = input.sessions.map((item, index) => ({ sessionId: item.id, ordinal: 1, usage: usage(`request-${index}`, { inputTokens: 80 + index * 10 }) }));
  input.requests.push({ sessionId: "s-10", ordinal: 2, usage: usage("partial", { inputTokens: undefined }) });
  const insight = analyze(input).insights.find(item => item.descriptor.key === "overview.insight.concentration")!;
  assert.equal(insight.sample, 10); assert.equal(insight.missing, 1);
  assert.equal(insight.values?.tokens, 1450);
  assert.equal(insight.evidence.kind, "sessions");
});

test("资源频度不能替代使用广度，小于五个会话不生成偏好", () => {
  const result = analyze(source(), query, report => {
    report.resources.skills = [resource("narrow", { uses: 200, sessions: 3 }), resource("broad", { uses: 50, sessions: 25, averagePerSession: 2 })];
  });
  const resources = result.insights.filter(item => item.rule === "03");
  assert.equal(resources.length, 1); assert.equal(resources[0]?.object, "broad");
  assert.equal(resources[0]?.values?.uses, 50);
});

test("资源后续使用仅成熟可用窗口进入分母，各未完成状态独立", () => {
  const result = analyze(source(), query, report => {
    report.resources.observations = Array.from({ length: 10 }, (_, index) => ({ resourceId: `r-${index}`, kind: "skill", name: `r-${index}`,
      firstDay: "2026-01-01", window: { from: "2026-01-02", to: "2026-01-31" }, firstEventId: `event-${index}`, subsequentDays: index < 4 ? 1 : 0,
      state: index < 6 ? "mature" : index < 8 ? "observing" : index === 8 ? "outside_range" : "insufficient_coverage",
      reused: index < 6 ? index < 4 : null }));
  });
  const insight = result.insights.find(item => item.rule === "04")!;
  assert.equal(insight.sample, 6); assert.equal(insight.current, 4); assert.equal(insight.missing, 4);
  assert.equal(insight.values?.ratio, 4 / 6); assert.equal(insight.values?.observing, 2);
  assert.equal(insight.values?.outsideRange, 1); assert.equal(insight.values?.insufficientCoverage, 1);
});

test("委派未知和分叉不混入分母，活动洞察不受局部模型筛选影响", () => {
  const input = source();
  const change = (report: OverviewReport) => { report.delegation = { eligibleMainSessions: 10, withChildActivity: 4,
    unknownMainSessions: 3, forkSessions: 2, unknownRelationshipSessions: 1, childRequests: 20, assignedRequests: 40,
    childTokens: 2000, assignedTokens: 4000 }; };
  const baseline = analyze(input, query, change).insights.find(item => item.metric === "delegated_activity")!;
  const filtered = analyze(input, { ...query, models: ["model-b"] }, change).insights.find(item => item.metric === "delegated_activity")!;
  assert.deepEqual(baseline, filtered);
  assert.equal(baseline.sample, 10); assert.equal(baseline.missing, 3);
  assert.equal(baseline.values?.ratio, .4);
});

test("缓存读取与新输入保留缓存写入，客户端和模型不混组", () => {
  const input = usageChangeSource();
  for (const request of input.requests) request.usage = { ...request.usage, cachedInputTokens: request.usage.id.startsWith("previous") ? 20 : 65,
    cacheWriteTokens: 10 };
  const insight = analyze(input).insights.find(item => item.rule === "06")!;
  assert.equal(insight.values?.currentFresh, 2200); assert.equal(insight.values?.previousFresh, 1000);
  assert.equal(insight.values?.currentCacheWrite, 400); assert.equal(insight.values?.previousCacheWrite, 200);
  assert.equal(insight.current, 50); assert.equal(insight.previous, 25);
});

test("缓存字段缺失和不一致不能作为零进入比较", () => {
  const input = usageChangeSource();
  for (const request of input.requests) if (request.usage.id.startsWith("previous")) request.usage.cachedInputTokens = undefined;
  assert.equal(analyze(input).insights.some(item => item.rule === "06"), false);
});

test("项目变化按各自指标与相同范围，未知项目不变成真实项目", () => {
  const input = usageChangeSource();
  const insights = analyze(input).insights.filter(item => item.rule === "07");
  assert.equal(insights.find(item => item.metric === "project_requests")?.current, 40);
  assert.equal(insights.find(item => item.metric === "project_complete_tokens")?.current, 6000);
  input.sessions[0]!.project = undefined;
  assert.equal(analyze(input).insights.some(item => item.rule === "07"), false);
});

test("未知模型与缺时间请求不桥接模型切换，子会话不串入主会话", () => {
  const input = source(Array.from({ length: 10 }, (_, index) => session(`s-${index}`)));
  input.requests = input.sessions.flatMap(item => [
    { sessionId: item.id, ordinal: 1, usage: usage(`${item.id}-a`) },
    { sessionId: item.id, ordinal: 2, usage: usage(`${item.id}-unknown`, { model: undefined }) },
    { sessionId: item.id, ordinal: 3, usage: usage(`${item.id}-b`, { model: "model-b" }) },
  ]);
  assert.equal(analyze(input).insights.some(item => item.metric === "session_model_switch"), false);
  for (const request of input.requests) if (request.ordinal === 2) request.usage.model = "model-a";
  const switchInsight = analyze(input).insights.find(item => item.metric === "session_model_switch")!;
  assert.equal(switchInsight.current, 10); assert.equal(switchInsight.values?.switches, 10);
  assert.equal(analyze(input, { ...query, models: ["model-a"] }).insights.find(item => item.metric === "session_model_switch")?.current, 0);
  for (const request of input.requests) if (request.ordinal === 2) request.usage.occurredAt = undefined;
  assert.equal(analyze(input).insights.some(item => item.metric === "session_model_switch"), false);
});

test("顺序未知或ordinal重复的会话不补造请求相邻关系", () => {
  const input = source(Array.from({ length: 10 }, (_, index) => session(`s-${index}`)));
  input.requests = input.sessions.flatMap(item => [
    { sessionId: item.id, ordinal: 1, usage: usage(`${item.id}-a`) },
    { sessionId: item.id, ordinal: undefined, usage: usage(`${item.id}-b`, { model: "model-b" }) },
  ]);
  assert.equal(analyze(input).insights.some(item => item.metric === "session_model_switch"), false);
  input.requests.forEach(request => { request.ordinal = 1; });
  assert.equal(analyze(input).insights.some(item => item.metric === "session_model_switch"), false);
});

test("MCP仅依赖实际观测工具，组合保留会话和真实轮次分母", () => {
  const result = analyze(source(), query, report => {
    report.resources.mcp = [resource("server-id", { kind: "mcp", name: "server-a", uses: 30, sessions: 10,
      tools: [{ key: "tool-a", name: "tool-a", count: 20, sessions: 8 }, { key: "tool-b", name: "tool-b", count: 10, sessions: 5 }] })];
    report.resources.combinations.sessions = [{ id: "pair-session", resources: ["skill-a", "server-id"], names: ["skill-a", "server-a"], unit: "session", count: 3, sessions: 3 }];
    report.resources.combinations.turns = [{ id: "pair-turn", resources: ["skill-a", "server-id"], names: ["skill-a", "server-a"], unit: "turn", count: 9, sessions: 3 }];
  });
  const mcp = result.insights.find(item => item.metric === "mcp_tools")!;
  assert.equal(mcp.current, 2); assert.equal(mcp.sample, 30);
  const pairs = result.insights.filter(item => item.rule === "10");
  assert.equal(pairs.length, 2); assert.deepEqual(pairs.map(item => item.sample), [3, 3]);
  assert.deepEqual(pairs.map(item => item.current), [3, 9]);
});

test("单条明确失败可以调查，低结果覆盖不输出失败率重点", () => {
  const input = source(); input.events.push(event("call", "main", { ordinal: 2, kind: "tool_call", tool: "read_file", callId: "call-1", status: "failure" }));
  const insight = analyze(input).insights.find(item => item.rule === "11")!;
  assert.equal(insight.descriptor.key, "overview.insight.singleFailure");
  assert.equal(insight.values?.failureRate, null); assert.equal(insight.current, 1);
  assert.equal(insight.evidence.status, "failure");
});

test("同轮次失败后续保持独立调用，不重复引用共同后续、不声称任务恢复", () => {
  const result = analyze(source(), query, report => {
    report.process.failureSequences = [{ sessionId: "main", turnId: "main:turn:1", tool: "read_file", failures: ["failure-a", "failure-b"],
      calls: [{ messageId: "later-a", ordinal: 3, status: "failure" }, { messageId: "later-b", resultMessageId: "result-b", ordinal: 4, status: "success" }], truncated: true }];
  });
  const insight = result.insights.find(item => item.rule === "12")!;
  assert.equal(insight.current, 2); assert.equal(insight.sample, 2); assert.equal(insight.values?.success, 1);
  assert.equal(insight.values?.truncated, true); assert.equal(insight.evidence.turnId, "main:turn:1");
});

test("跨日续用使用真实日期集合，而不是摘要时间铺满日期", () => {
  const input = source(Array.from({ length: 10 }, (_, index) => session(`s-${index}`, { startedAt: "2026-02-01T00:00:00Z", updatedAt: "2026-02-28T00:00:00Z" })));
  input.events.push(event("second-day", "s-0", { ordinal: 2, occurredAt: "2026-02-15T12:00:00Z" }));
  const insight = analyze(input).insights.find(item => item.rule === "13")!;
  assert.equal(insight.current, 1); assert.equal(insight.sample, 10); assert.equal(insight.values?.ratio, .1);
});

test("输入走势按模型片段分开，不跨模型变化推断压缩节省", () => {
  const input = source();
  input.requests = [
    { sessionId: "main", ordinal: 1, usage: usage("a", { inputTokens: 100 }) },
    { sessionId: "main", ordinal: 3, usage: usage("b", { inputTokens: 300 }) },
    { sessionId: "main", ordinal: 4, usage: usage("c", { model: "model-b", inputTokens: 50 }) },
    { sessionId: "main", ordinal: 5, usage: usage("d", { model: "model-b", inputTokens: 80 }) },
  ];
  input.events.push(event("compression", "main", { ordinal: 2, kind: "compression" }));
  const segments = analyze(input).insights.filter(item => item.metric === "input_sequence");
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map(item => [item.previous, item.current]).sort((a, b) => a[0]! - b[0]!), [[50, 80], [100, 300]]);
  assert.equal(segments.find(item => item.previous === 100)?.values?.compressions, 1);
});

test("仓库比较使用完整日期comparison值，不用含当天的selected热点", () => {
  const result = analyze(source(), query, report => {
    report.repositories = [{ repository: { id: "repository-test", path: "/workspace/project-a", commonDir: "/workspace/project-a/.git", name: "sample-project" },
      state: "ready", version: "repo-version", baselineHash: "baseline-test", hotspots: [{ path: "src/example.ts", read: 999, edit: 0, failure: 0,
        comparison: { read: 10, edit: 0, failure: 0 }, previous: { read: 5, edit: 0, failure: 0 } }], gapCount: 0 }];
  });
  const insight = result.insights.find(item => item.rule === "15")!;
  assert.equal(insight.current, 10); assert.equal(insight.previous, 5);
  assert.equal(insight.values?.repositoryVersion, "repo-version"); assert.equal(insight.values?.path, "src/example.ts");
  assert.equal(insight.values?.currentTo, "2026-02-28");
});

test("统计覆盖比较保留两期计数，无时间记录提供专门证据筛选", () => {
  const input = usageChangeSource();
  input.requests.forEach(request => { if (request.usage.id.startsWith("previous")) request.usage.outputTokens = undefined; });
  input.requests.push({ sessionId: "main", ordinal: 99, usage: usage("undated", { occurredAt: undefined }) });
  const insights = analyze(input).insights;
  const coverage = insights.find(item => item.metric === "coverage_tokens")!;
  assert.equal(coverage.current, 1); assert.equal(coverage.previous, 0);
  assert.equal(coverage.values?.previousKnown, 0); assert.equal(coverage.values?.previousTotal, 20);
  const undated = insights.find(item => item.metric === "undated_records")!;
  assert.equal(undated.evidence.undated, true);
  assert.equal(undated.current, 1);
});

test("工具结果覆盖使用唯一配对后的结果，不把未标调用状态当缺失", () => {
  const input = source();
  for (let index = 0; index < 20; index++) {
    input.events.push(event(`prior-call-${index}`, "main", { ordinal: index * 2 + 2, kind: "tool_call", tool: "read_file", callId: `prior-${index}`,
      occurredAt: "2026-01-15T12:00:00Z" }));
    input.events.push(event(`current-call-${index}`, "main", { ordinal: index * 2 + 100, kind: "tool_call", tool: "read_file", callId: `current-${index}` }));
    input.events.push(event(`current-result-${index}`, "main", { ordinal: index * 2 + 101, kind: "tool_result", callId: `current-${index}`, status: "success" }));
  }
  const insight = analyze(input).insights.find(item => item.metric === "coverage_tools")!;
  assert.equal(insight.current, 1); assert.equal(insight.previous, 0);
});

test("计时区间、依据和方法分组，少输出请求仍可进入时长分布", () => {
  const input = source();
  input.requests = Array.from({ length: 40 }, (_, index) => ({ sessionId: "main", ordinal: index + 1,
    usage: usage(`timed-${index}`, { outputTokens: 10, timing: { basis: index < 20 ? "recorded" : "estimated", window: index < 20 ? "response" : "generation",
      method: "codex_event_boundary", completion: "explicit", durationMs: 2000, start: { recordLine: 1, occurredAt: "2026-02-10T12:00:00Z" },
      end: { recordLine: 2, occurredAt: "2026-02-10T12:00:02Z" } } }) }));
  const distributions = analyze(input).insights.filter(item => item.metric === "timing_distribution");
  assert.equal(distributions.length, 2); assert.deepEqual(distributions.map(item => item.sample), [20, 20]);
  assert.deepEqual(new Set(distributions.map(item => item.values?.window)), new Set(["response", "generation"]));
  assert.deepEqual(distributions.map(item => item.values?.speedSamples), [0, 0]);
});

test("完整日期对比排除today，近期窗口只在范围覆盖且含今天时生成", () => {
  const input = usageChangeSource();
  input.requests.push({ sessionId: "main", ordinal: 99, usage: usage("today-peak", { occurredAt: "2026-03-01T12:00:00Z", inputTokens: 100000 }) });
  const result = analyze(input, { window: "custom", from: "2026-02-01", to: "2026-03-01", timezone: "UTC" });
  const usageChange = result.insights.find(item => item.rule === "01")!;
  assert.equal(usageChange.current, 6000); assert.equal(usageChange.period.to, "2026-02-28");
  assert.equal(usageChange.previousPeriod?.from, "2026-01-04");
  assert.equal(usageChange.descriptor.key, "overview.insight.usage");
  assert.equal(result.insights.some(item => item.metric === "recent_complete_tokens"), false);
});

test("重点轮流覆盖三类，异单位变化不共享分数，小样本不补满五条", () => {
  const row = (id: string, type: OverviewInsight["type"]): OverviewInsight => ({ id, rule: "01", type, descriptor: { key: "overview.insight.peak", params: { tokens: 1 } },
    current: 1, sample: 1, missing: 0, period: { from: "2026-02-01", to: "2026-02-28" }, evidence: { kind: "requests" } });
  assert.deepEqual(selectFeaturedInsights([row("f-1", "feature"), row("f-2", "feature"), row("c-1", "change"), row("i-1", "investigation")])
    .map(item => item.id), ["f-1", "c-1", "i-1", "f-2"]);
  assert.equal(selectFeaturedInsights([]).length, 0);
  assert.equal(selectFeaturedInsights(Array.from({ length: 12 }, (_, index) => row(`f-${index}`, "feature"))).length, 5);
});

test("双语目录键和插值参数一致，生成描述均有可显示文案", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    const parameters = (message: string) => [...message.matchAll(/\{\{\s*([\w]+)[^}]*\}\}/g)].map(match => match[1]).sort();
    assert.deepEqual(parameters(en[key]), parameters(zh[key]), key);
  }
  for (const insight of analyze(usageChangeSource()).insights) {
    assert.ok(insight.descriptor.key in en, insight.descriptor.key);
    const message = en[insight.descriptor.key as keyof typeof en];
    for (const match of message.matchAll(/\{\{\s*([\w]+)[^}]*\}\}/g)) assert.ok(match[1]! in insight.descriptor.params!, insight.descriptor.key);
  }
});

test("完整月份项目聚合独立于会话分页，模型筛选仅改变请求和Token", () => {
  const input = usageChangeSource();
  input.sessions.push(session("second", { project: "/workspace/project-b" }), session("missing-project", { project: undefined }));
  input.events.push(event("second-user", "second"), event("missing-project-user", "missing-project"));
  input.requests.push({ sessionId: "second", ordinal: 1, usage: usage("different-model", { model: "model-b" }) });
  const result = analyze(input, { ...query, models: ["model-a"] }, report => { report.usage.sessions = []; });
  const first = result.projectMonths.find(row => row.project === "/workspace/project-a")!;
  assert.equal(first.month, "2026-02"); assert.equal(first.requests, 40); assert.equal(first.tokens, 6000);
  assert.equal(first.sessions, 1); assert.equal(first.completeTokenRequests, 40);
  const second = result.projectMonths.find(row => row.project === "/workspace/project-b")!;
  assert.equal(second.sessions, 1); assert.equal(second.requests, 0); assert.equal(second.tokens, null);
  assert.equal(result.projectMonths.find(row => row.project === null)?.sessions, 1);
});

test("模型路径完整返回小样本原值，但不强制形成重点比例", () => {
  const input = source([session("parent-a"), session("parent-b"),
    session("child-a", { relationship: "child", parentSessionId: "parent-a" }),
    session("child-b", { relationship: "child", parentSessionId: "parent-a" }),
    session("child-c", { relationship: "child", parentSessionId: "parent-b" })]);
  input.requests = input.sessions.map(item => ({ sessionId: item.id, ordinal: 1,
    usage: usage(`request-${item.id}`, { model: item.relationship === "child" ? "model-b" : "model-a" }) }));
  input.requests.push({ sessionId: "parent-a", ordinal: 2, usage: usage("switch-a", { model: "model-b" }) });
  const result = analyze(input);
  assert.equal(result.modelTransitions.find(row => row.kind === "switch")?.count, 1);
  const delegated = result.modelTransitions.find(row => row.kind === "delegation" && row.fromModel === "model-a")!;
  assert.equal(delegated.count, 3); assert.equal(delegated.sessions, 2);
  assert.equal(delegated.evidence.transition, "delegation"); assert.equal(delegated.evidence.modelFrom, "model-a");
  assert.equal(result.insights.some(item => item.metric === "delegated_model_pair"), false);
});

test("完整请求峰值与同模型输入片段有精确身份和顺序边界", () => {
  const input = source();
  input.requests = [
    { sessionId: "main", ordinal: 1, usage: usage("first", { inputTokens: 100 }) },
    { sessionId: "main", ordinal: 2, usage: usage("last", { inputTokens: 200 }) },
    { sessionId: "main", ordinal: 3, usage: usage("partial-big", { inputTokens: 50000, outputTokens: undefined }) },
    { sessionId: "main", ordinal: 4, usage: usage("unknown-break", { model: undefined }) },
    { sessionId: "main", ordinal: 5, usage: usage("after", { inputTokens: 80 }) },
  ];
  const result = analyze(input);
  assert.equal(result.insights.find(item => item.metric === "request_peak")?.evidence.requestId, "last");
  const segment = result.insights.find(item => item.metric === "input_sequence")!;
  assert.equal(segment.evidence.ordinalFrom, 1); assert.equal(segment.evidence.ordinalTo, 3);
  assert.equal(segment.values?.lastRequest, "partial-big");
});

test("失败率变化两期各自检查已知结果数和80%覆盖门槛", () => {
  const input = source();
  for (let index = 0; index < 20; index++) {
    input.events.push(event(`prior-${index}`, "main", { ordinal: index + 2, kind: "tool_call", tool: "read_file", status: "success",
      occurredAt: "2026-01-15T12:00:00Z" }));
    input.events.push(event(`current-${index}`, "main", { ordinal: index + 30, kind: "tool_call", tool: "read_file", status: index < 10 ? "failure" : "success" }));
  }
  const change = analyze(input).insights.find(item => item.metric === "known_failure_rate")!;
  assert.equal(change.current, .5); assert.equal(change.previous, 0); assert.equal(change.sample, 20);
  for (let index = 0; index < 6; index++) input.events.push(event(`unknown-${index}`, "main", { ordinal: index + 60, kind: "tool_call", tool: "read_file", status: "unknown" }));
  assert.equal(analyze(input).insights.some(item => item.metric === "known_failure_rate"), false);
});

test("近期三十天变化仅用窗口内完整日期，与完整年度变化单列", () => {
  const input = usageChangeSource();
  const result = analyze(input, { window: "365", timezone: "UTC" });
  const recent = result.insights.find(item => item.metric === "recent_complete_tokens")!;
  assert.equal(recent.current, 6000); assert.equal(recent.previous, 2000);
  assert.deepEqual(recent.period, { from: "2026-01-30", to: "2026-02-28" });
  assert.deepEqual(recent.previousPeriod, { from: "2025-12-31", to: "2026-01-29" });
  assert.equal(analyze(input, query).insights.some(item => item.metric === "recent_complete_tokens"), false);
});

test("同价费用比较只使用完整计价请求，并保留两期计价不足样本", () => {
  const input = usageChangeSource();
  input.requests.push({ sessionId: "main", ordinal: 99, usage: usage("unpriced-partial", { outputTokens: undefined }) });
  const cost = analyze(input).insights.find(item => item.metric === "fully_priced_estimate")!;
  assert.ok(Math.abs(cost.current! - .006) < 1e-10);
  assert.ok(Math.abs(cost.previous! - .002) < 1e-10);
  assert.equal(cost.sample, 40); assert.equal(cost.missing, 1); assert.equal(cost.values?.priceVersion, pricing.status.version);
});

test("未知资源不生成偏好或MCP种类，未知项目和工具保留覆盖", () => {
  const result = analyze(source(), query, report => {
    report.resources.skills = [resource("unknown-skill", { nameDescriptor: { key: "sessions.resource.nameUnrecorded" } }),
      resource("known-skill", { projects: [{ key: "unknown", name: "unknown", count: 25, sessions: 5 }] })];
    report.resources.mcp = [resource("unknown-server", { kind: "mcp", nameDescriptor: { key: "sessions.resource.nameUnrecorded" } }),
      resource("known-server", { kind: "mcp", uses: 30,
        tools: [{ key: "unknown", name: "unknown", count: 10, sessions: 5 }, { key: "literal:unknown", name: "literal:unknown", count: 20, sessions: 5 }] })];
  });
  assert.equal(result.insights.some(item => item.object === "unknown-skill" || item.object === "unknown-server"), false);
  assert.equal(result.insights.find(item => item.object === "known-skill")?.values?.projects, 0);
  const mcp = result.insights.find(item => item.metric === "mcp_tools")!;
  assert.equal(mcp.current, 1); assert.equal(mcp.sample, 20); assert.equal(mcp.missing, 10);
  assert.equal(result.insights.find(item => item.metric === "mcp_tool_share")?.descriptor.params?.tool, "unknown");
});

test("同名工具的失败洞察与后续过程绑定服务器身份", () => {
  const input = source();
  for (const server of ["server-a", "server-b"]) input.events.push(event(`failure-${server}`, "main", { ordinal: server === "server-a" ? 2 : 3,
    kind: "tool_call", tool: "search", status: "failure", resource: { kind: "mcp", name: server, server } }));
  const result = analyze(input, query, report => {
    report.process.failureSequences = ["server-a", "server-b"].map(server => ({ sessionId: "main", turnId: "main:turn:1", tool: "search", server,
      failures: [`failure-${server}`], calls: [{ messageId: `later-${server}`, ordinal: 4, status: "success" }], truncated: false }));
  });
  const failures = result.insights.filter(item => item.rule === "11");
  assert.equal(failures.length, 2);
  assert.deepEqual(new Set(failures.map(item => item.evidence.toolId)), new Set(['["search","server-a"]', '["search","server-b"]']));
  const followups = result.insights.filter(item => item.rule === "12");
  assert.equal(followups.length, 2);
  assert.deepEqual(new Set(followups.map(item => item.evidence.server)), new Set(["server-a", "server-b"]));
});

test("洞察到证据链保留完整模型变化、峰值身份与各MCP服务器", () => {
  const input = source([session("parent"), session("child", { relationship: "child", parentSessionId: "parent" })]);
  input.requests = [
    { sessionId: "parent", ordinal: 1, usage: usage("first") },
    { sessionId: "parent", ordinal: 2, usage: usage("changed", { model: "model-b", inputTokens: 200 }) },
    { sessionId: "child", ordinal: 1, usage: usage("child-model", { model: "model-b" }) },
    { sessionId: "parent", ordinal: 3, usage: usage("partial-big", { inputTokens: 50000, outputTokens: undefined }) },
  ];
  for (const server of ["server-a", "server-b"]) input.events.push(event(`failure-${server}`, "parent", { ordinal: server === "server-a" ? 10 : 11,
    kind: "tool_call", tool: "search", status: "failure", resource: { kind: "mcp", name: server, server } }));
  const result = analyze(input);
  const peak = result.insights.find(item => item.metric === "request_peak")!;
  assert.equal(buildOverviewEvidence(input, query, peak.evidence, pricing, now).rows[0]?.requestId, "changed");
  for (const transition of result.modelTransitions) {
    const evidence = buildOverviewEvidence(input, query, transition.evidence, pricing, now);
    assert.equal(evidence.total, transition.count);
    assert.ok(evidence.rows.every(row => transition.kind === "switch" ? row.values?.previousModel === transition.fromModel : row.relationship === "child"));
  }
  for (const insight of result.insights.filter(item => item.rule === "11")) {
    const evidence = buildOverviewEvidence(input, query, insight.evidence, pricing, now);
    assert.equal(evidence.total, 1); assert.equal(evidence.rows[0]?.values?.server, insight.evidence.server);
  }
});
