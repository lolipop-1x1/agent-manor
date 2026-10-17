import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionProfile } from "../src/session-contracts.ts";
import { formatDateTime, translate, type Language } from "../src/i18n/index.ts";
import { ContextWindowSnapshots } from "../web/features/sessions/ContextWindowSnapshots.tsx";

type Snapshot = NonNullable<SessionProfile["contextSnapshots"]>[number];
const snapshot = (id: string, fields: Partial<Snapshot> = {}): Snapshot => ({
  id, sessionId: "synthetic-root", usedTokens: 1000, capacityTokens: 4000,
  systemPromptTokens: 100, messageTokens: 800, skillTokens: 0, toolTokens: 100, ...fields,
});
const markup = (snapshots: Snapshot[], language: Language = "en") => renderToStaticMarkup(createElement(ContextWindowSnapshots, {
  snapshots, rootSessionId: "synthetic-root", language, help: createElement("button", { "aria-label": translate(language, "sessions.contextWindow.help") }, "?"),
}));
const metric = (html: string, label: string) => [...html.matchAll(/<div(?: [^>]*)?><strong>(.*?)<\/strong><span>(.*?)<\/span><\/div>/g)]
  .find(row => row[2] === label)?.[1];

test("上下文快照不存在时不渲染空区域，已记录零值正常显示", () => {
  assert.equal(markup([]), "");
  const html = markup([snapshot("zero", { usedTokens: 0, systemPromptTokens: 0, messageTokens: 0, skillTokens: 0, toolTokens: 0 })]);
  assert.equal(metric(html, "Latest recorded tokens"), "0");
  assert.equal(metric(html, "Window occupancy"), "0%");
  assert.equal(metric(html, "Skill tokens"), "0");
  assert.ok(!html.includes("Native cumulative reports"));
  assert.ok(!html.includes("Cost"));
});

test("最新记录按时间选择，最高占用的容量和比例始终来自同一条快照", () => {
  const html = markup([
    snapshot("larger", { occurredAt: "2026-01-01T00:00:00Z", usedTokens: 9000, capacityTokens: 20000, messageTokens: 8800 }),
    snapshot("latest", { occurredAt: "2026-01-02T00:00:00Z", usedTokens: 2000, capacityTokens: 4000, messageTokens: 1800 }),
    snapshot("older", { occurredAt: "2025-12-30T00:00:00Z", usedTokens: 1000 }),
  ]);
  assert.equal(metric(html, "Latest recorded tokens"), "2,000");
  assert.equal(metric(html, "Window capacity (tokens)"), "4,000");
  assert.equal(metric(html, "Window occupancy"), "50%");
  assert.equal(metric(html, "Peak recorded tokens"), "9,000");
  assert.ok(html.includes('title="9,000 / 20,000 (45%)"'));
  assert.ok(html.includes('<div class="session-usage-grid">'));
  assert.ok(!html.includes('class="session-usage-grid compact"'));
  assert.equal(metric(html, "Message tokens"), "1,800");
  assert.ok(!html.includes("12,000"));
  assert.equal((html.match(/<tbody><tr>|<\/tr><tr>/g) ?? []).length, 3);
  assert.ok(html.includes("<td>9,000</td><td>20,000</td><td>45%</td>"));
});

test("时间缺失按来源顺序兜底，不覆盖有明确时间的最近记录", () => {
  const missing = markup([snapshot("one"), snapshot("two", { usedTokens: 1200 })]);
  assert.equal(metric(missing, "Latest recorded tokens"), "1,200");
  assert.ok(missing.includes("Time not recorded"));
  const dated = markup([snapshot("dated", { occurredAt: "2026-01-02T00:00:00Z", usedTokens: 1500 }), snapshot("missing", { usedTokens: 1200 })]);
  assert.equal(metric(dated, "Latest recorded tokens"), "1,500");
});

test("中英文显示快照时间和子会话范围，快照表保留每条记录的四个分项", () => {
  const snapshots = [snapshot("root", { occurredAt: "2026-01-02T00:00:00Z" }),
    snapshot("child", { sessionId: "synthetic-child", occurredAt: "2026-01-03T00:00:00Z", usedTokens: 1100, skillTokens: 100 })];
  for (const language of ["en", "zh-CN"] as const) {
    const html = markup(snapshots, language);
    assert.ok(html.includes(translate(language, "sessions.contextWindow.title")));
    assert.ok(html.includes(translate(language, "sessions.contextWindow.child", { number: "1" })));
    assert.ok(html.includes(translate(language, "sessions.profile.self")));
    assert.ok(html.includes(formatDateTime(language, snapshots[1]!.occurredAt!)));
    assert.ok(html.includes(translate(language, "sessions.contextWindow.snapshots", { count: 2 })));
    assert.ok(!html.includes("synthetic-child"));
    assert.equal((html.match(/<td>/g) ?? []).length, 18);
  }
});
