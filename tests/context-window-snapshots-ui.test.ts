import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionProfile } from "../src/session-contracts.ts";
import { formatDateTime, translate, type Language } from "../src/i18n/index.ts";
import { SessionUsageSummary, sessionHasRequestUsage, sessionUsageCoverage } from "../web/features/sessions/SessionUsageSummary.tsx";

type Snapshot = NonNullable<SessionProfile["contextSnapshots"]>[number];
const snapshot = (id: string, fields: Partial<Snapshot> = {}): Snapshot => ({
  id, sessionId: "synthetic-root", usedTokens: 1000, capacityTokens: 4000,
  systemPromptTokens: 100, messageTokens: 800, skillTokens: 0, toolTokens: 100, ...fields,
});
const profile = (fields: Partial<SessionProfile> = {}): SessionProfile => ({
  version: "synthetic-version", scope: "self", sessionIds: ["synthetic-root"], missingChildren: 0, messageCount: 1, turnCount: 1, models: [],
  usage: { requests: 0, inputTokens: null, outputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, reasoningOutputTokens: null,
    cacheReadRatio: null, peakInputTokens: null, peakContextTokens: null, inputRecordedRequests: 0, cacheRecordedRequests: 0 },
  estimate: { method: "Synthetic estimate", total: 12, byKind: [] }, tools: [], resources: [], compressions: 0, children: [], steps: [], gaps: [], ...fields,
});
const markup = (value: SessionProfile, language: Language = "en", expanded = true) => renderToStaticMarkup(createElement(SessionUsageSummary, {
  profile: value, language, expanded, onFocusStep: () => {}, help: createElement("button", { "aria-label": translate(language, "sessions.profile.statsHelp") }, "?"),
  cost: createElement("div", { className: "session-cost" }, "—"),
}));
const metric = (html: string, label: string) => [...html.matchAll(/<div(?: [^>]*)?><strong>(.*?)<\/strong><span>(.*?)<\/span><\/div>/g)]
  .find(row => row[2] === label)?.[1];

test("空画像不渲染用量，只有上下文时共享输入输出保留未知", () => {
  assert.equal(markup(profile()), "");
  const html = markup(profile({ contextSnapshots: [snapshot("only-context")] }));
  assert.equal(metric(html, "Total input tokens"), "—");
  assert.equal(metric(html, "Output tokens"), "—");
  assert.equal(metric(html, "Latest recorded tokens"), "1,000");
  assert.ok(html.includes('aria-label="Token usage"'));
  assert.ok(!html.includes('aria-label="Context window occupancy"'));
  assert.ok(!html.includes("Request usage"));
  assert.ok(!html.includes("0 usage entries"));
  assert.equal((html.match(/class="session-profile-section"/g) ?? []).length, 1);
});

test("仅请求与请求加上下文使用相同摘要且不会互相填补或重复峰值", () => {
  const request = profile();
  request.usage = { ...request.usage, requests: 2, inputTokens: 1200, outputTokens: 30, cachedInputTokens: 100,
    peakInputTokens: 900, peakContextTokens: 950, inputRecordedRequests: 2, cacheRecordedRequests: 2 };
  request.peakInputRequest = { id: "synthetic-request", sessionId: "synthetic-root", messageId: "synthetic-message" };
  const onlyRequest = markup(request);
  assert.equal(metric(onlyRequest, "Total input tokens"), "1,200");
  assert.equal(metric(onlyRequest, "Output tokens"), "30");
  assert.equal(metric(onlyRequest, "Peak context tokens"), "950");
  assert.ok(onlyRequest.includes('class="session-stat-link session-peak-link"'));
  for (const label of ["Latest recorded tokens", "Window capacity (tokens)", "Window occupancy", "Peak recorded tokens"]) {
    assert.equal(metric(onlyRequest, label), "—");
  }
  assert.ok(!onlyRequest.includes("<details"));
  const combined = markup({ ...request, contextSnapshots: [snapshot("combined", { usedTokens: 950 })] });
  assert.equal(metric(combined, "Total input tokens"), "1,200");
  assert.equal(metric(combined, "Output tokens"), "30");
  assert.equal(metric(combined, "Peak recorded tokens"), "950");
  assert.equal(metric(combined, "Peak context tokens"), undefined);
  assert.equal((combined.match(/aria-label="Token usage"/g) ?? []).length, 1);
  assert.ok(combined.includes('<div class="session-usage-grid">'));
  assert.ok(!combined.includes('class="session-usage-grid compact"'));
  const labels = ["Total input tokens", "Output tokens", "Latest recorded tokens", "Window capacity (tokens)", "Window occupancy", "Peak recorded tokens"];
  for (const html of [onlyRequest, combined]) {
    const firstGrid = html.slice(html.indexOf('<div class="session-usage-grid">'), html.indexOf('<div class="session-cost">'));
    const visibleLabels = [...firstGrid.matchAll(/<span>(.*?)<\/span>/g)].slice(0, labels.length).map(match => match[1]);
    assert.deepEqual(visibleLabels, labels);
  }
});

test("已记录零值保留，缺失容量与分项不补零也不计算比例", () => {
  const zero = markup(profile({ contextSnapshots: [snapshot("zero", { usedTokens: 0, systemPromptTokens: 0, messageTokens: 0, skillTokens: 0, toolTokens: 0 })] }));
  assert.equal(metric(zero, "Latest recorded tokens"), "0");
  assert.equal(metric(zero, "Window occupancy"), "0%");
  assert.equal(metric(zero, "Skill tokens"), "0");
  const partial = markup(profile({ contextSnapshots: [snapshot("partial", { capacityTokens: undefined, systemPromptTokens: undefined,
    messageTokens: undefined, skillTokens: undefined, toolTokens: undefined })] }));
  assert.equal(metric(partial, "Latest recorded tokens"), "1,000");
  assert.equal(metric(partial, "Window capacity (tokens)"), "—");
  assert.equal(metric(partial, "Window occupancy"), "—");
  for (const label of ["System prompt tokens", "Message tokens", "Skill tokens", "Tool tokens"]) assert.equal(metric(partial, label), "—");
  const zeroCapacity = markup(profile({ contextSnapshots: [snapshot("zero-capacity", { capacityTokens: 0 })] }));
  assert.equal(metric(zeroCapacity, "Window capacity (tokens)"), "0");
  assert.equal(metric(zeroCapacity, "Window occupancy"), "—");
  assert.ok(!partial.includes("NaN"));
  assert.ok(!zeroCapacity.includes("∞"));
});

test("最新和峰值的容量及比例来自各自同一快照，不借用其他时间容量", () => {
  const html = markup(profile({ contextSnapshots: [
    snapshot("larger", { occurredAt: "2026-01-01T00:00:00Z", usedTokens: 9000, capacityTokens: 20000, messageTokens: 8800 }),
    snapshot("latest", { occurredAt: "2026-01-02T00:00:00Z", usedTokens: 2000, capacityTokens: undefined, messageTokens: 1800 }),
    snapshot("older", { occurredAt: "2025-12-30T00:00:00Z", usedTokens: 1000 }),
  ] }));
  assert.equal(metric(html, "Latest recorded tokens"), "2,000");
  assert.equal(metric(html, "Window capacity (tokens)"), "—");
  assert.equal(metric(html, "Window occupancy"), "—");
  assert.equal(metric(html, "Peak recorded tokens"), "9,000");
  assert.ok(html.includes('title="9,000 / 20,000 (45%)"'));
  assert.equal(metric(html, "Message tokens"), "1,800");
  assert.ok(!html.includes("12,000"));
  assert.equal((html.match(/<tbody><tr>|<\/tr><tr>/g) ?? []).length, 3);
  assert.ok(html.includes("<td>9,000</td><td>20,000</td><td>45%</td>"));
});

test("时间缺失按来源顺序兜底，不覆盖有明确时间的最近记录", () => {
  const missing = markup(profile({ contextSnapshots: [snapshot("one"), snapshot("two", { usedTokens: 1200 })] }));
  assert.equal(metric(missing, "Latest recorded tokens"), "1,200");
  assert.ok(missing.includes("Time not recorded"));
  const dated = markup(profile({ contextSnapshots: [snapshot("dated", { occurredAt: "2026-01-02T00:00:00Z", usedTokens: 1500 }), snapshot("missing", { usedTokens: 1200 })] }));
  assert.equal(metric(dated, "Latest recorded tokens"), "1,500");
});

test("概览与用量共用摘要，四分项和快照只在用量展开明细中呈现", () => {
  const value = profile({ contextSnapshots: [snapshot("details")] });
  const overview = markup(value, "en", false);
  assert.equal(metric(overview, "Latest recorded tokens"), "1,000");
  assert.ok(!overview.includes("<details"));
  assert.equal(metric(overview, "Message tokens"), undefined);
  const expanded = markup(value);
  const details = expanded.slice(expanded.indexOf('<details class="session-stat-details">'));
  assert.ok(details.includes("Message tokens"));
  assert.ok(details.includes("<table>"));
});

test("中英文显示统一标题、快照时间与子会话范围，明细保留四个分项", () => {
  const snapshots = [snapshot("root", { occurredAt: "2026-01-02T00:00:00Z" }),
    snapshot("child", { sessionId: "synthetic-child", occurredAt: "2026-01-03T00:00:00Z", usedTokens: 1100, skillTokens: 100 })];
  for (const language of ["en", "zh-CN"] as const) {
    const html = markup(profile({ scope: "tree", sessionIds: ["synthetic-root", "synthetic-child"], contextSnapshots: snapshots }), language);
    assert.ok(html.includes(translate(language, "sessions.usage.summary")));
    assert.ok(html.includes(translate(language, "sessions.contextWindow.child", { number: "1" })));
    assert.ok(html.includes(translate(language, "sessions.profile.self")));
    assert.ok(html.includes(formatDateTime(language, snapshots[1]!.occurredAt!)));
    assert.ok(html.includes(translate(language, "sessions.contextWindow.snapshots", { count: 2 })));
    assert.ok(!html.includes("synthetic-child"));
    assert.equal((html.match(/<td>/g) ?? []).length, 18);
  }
});

test("共享摘要覆盖仍按各请求字段计数，空字段不会形成零覆盖小计", () => {
  const value = profile({ contextSnapshots: [snapshot("coverage")] });
  assert.equal(sessionHasRequestUsage(value), false);
  assert.deepEqual(sessionUsageCoverage(value, true), []);
  value.usage = { ...value.usage, requests: 3, inputTokens: 1000, peakInputTokens: 800, inputRecordedRequests: 2 };
  assert.equal(sessionHasRequestUsage(value), true);
  assert.deepEqual(sessionUsageCoverage(value, true), [{ count: 2, total: 3, labels: ["sessions.profile.totalInput", "sessions.profile.maxInput"] }]);
  const html = markup(value);
  assert.equal(metric(html, "Total input tokens subtotal"), "1,000");
  assert.equal(metric(html, "Output tokens"), "—");
});

test("部分快照与混合来源不能遮蔽独立请求上下文峰值", () => {
  const value = profile();
  value.usage = { ...value.usage, requests: 2, inputTokens: 700, outputTokens: 20, peakContextTokens: 500 };
  const partial = markup({ ...value, contextSnapshots: [snapshot("partial-context", { usedTokens: 100, capacityTokens: 1000 })] });
  assert.equal(metric(partial, "Peak context tokens"), "500");
  assert.equal(metric(partial, "Peak recorded tokens"), "100");
  assert.ok(partial.includes('title="100 / 1,000 (10%)"'));
  assert.equal(metric(partial, "Total input tokens subtotal"), "700");
  assert.equal(metric(partial, "Output tokens"), "20");
  const mixed = markup({ ...value, scope: "tree", sessionIds: ["synthetic-root", "synthetic-child"], contextSnapshots: [
    snapshot("root-context", { usedTokens: 500, capacityTokens: 1000 }),
    snapshot("child-context", { sessionId: "synthetic-child", usedTokens: 800, capacityTokens: 4000 }),
  ] });
  assert.equal(metric(mixed, "Peak context tokens"), "500");
  assert.equal(metric(mixed, "Peak recorded tokens"), "800");
  assert.ok(mixed.includes('title="800 / 4,000 (20%)"'));
  assert.ok(!mixed.includes("1,300"));
});
