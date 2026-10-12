import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { defaultOverviewRoute, incomingOverviewRoute, overviewAddress, overviewCalendarDate, overviewQuery, overviewRange, readOverviewRoute, streakRange, validOverviewRange, overviewCostState } from "../web/features/overview/model.ts";
import { formatDate } from "../src/i18n/format.ts";
import { readUsageRoute, usageQuery } from "../web/features/usage/model.ts";
import { translate } from "../src/i18n/index.ts";
test("总览本地日历日期按显示语言格式化，保留日期和月份", () => {
  const day = overviewCalendarDate("2026-01-01");
  assert.equal(day.getFullYear(), 2026); assert.equal(day.getMonth(), 0); assert.equal(day.getDate(), 1);
  assert.equal(formatDate("en", day), "Jan 1, 2026"); assert.equal(formatDate("zh-CN", day), "2026年1月1日");
  assert.equal(formatDate("en", day, { year: "numeric", month: "short" }), "Jan 2026");
  assert.equal(overviewCalendarDate("0004-02-29").getFullYear(), 4);
  assert.equal(overviewCalendarDate("0004-02-29").getDate(), 29);
});

test("总览默认覆盖含今天的365个本地日期，跨年不截断", () => {
  const range = overviewRange(defaultOverviewRoute(), new Date(2025, 0, 7, 12));
  assert.deepEqual(range, { from: "2024-01-09", to: "2025-01-07" });
  assert.deepEqual(overviewRange({ ...defaultOverviewRoute(), window: "year" }, new Date(2025, 4, 5)), { from: "2025-01-01", to: "2025-05-05" });
  assert.deepEqual(overviewRange({ ...defaultOverviewRoute(), window: "all" }), {});
});

test("总览地址保留筛选和局部视图，格式错误不污染查询", () => {
  const route = { ...defaultOverviewRoute(), window: "custom" as const, from: "2025-01-01", to: "2025-03-01", clients: ["codex"], projects: ["/example/project"], models: ["example-model"], activity: "tokens" as const, interval: "month" as const };
  assert.deepEqual(readOverviewRoute(overviewAddress(route)), route);
  const invalid = readOverviewRoute('#overview?window=wrong&clients=bad&projects=%5B2%5D&from=2025-02-30&metric=invalid');
  assert.equal(invalid.window, "365"); assert.equal(invalid.from, undefined); assert.equal(invalid.clients, undefined); assert.equal(invalid.metric, "tokens");
  assert.equal(validOverviewRange({ ...route, from: "2025-04-01" }), false);
  assert.equal("anchorDay" in readOverviewRoute("#overview?anchorDay=2025-01-01"), false);
});

test("局部显示选项不改变后端统计范围，模型只作为独立用量条件传入", () => {
  const route = { ...defaultOverviewRoute(), models: ["example-model"] };
  const now = new Date(2025, 0, 7);
  const first = overviewQuery(route, "index-a", "prices-a", now);
  assert.deepEqual(overviewQuery({ ...route, activity: "tools", metric: "requests", interval: "month", distribution: "tool", process: "timing", combinationUnit: "turn" }, "index-a", "prices-a", now), first);
  assert.deepEqual(first.models, ["example-model"]);
});

test("连续活跃只还原真实连续日期，今天宽限与历史末日分别处理", () => {
  const days = [{ day: "2025-01-01", sessions: 1 }, { day: "2025-01-02", sessions: 1 }, { day: "2025-01-03", sessions: 1 }, { day: "2025-01-04", sessions: 0 }];
  assert.deepEqual(streakRange(days, { from: "2025-01-01", to: "2025-01-04", includesToday: true }), { from: "2025-01-01", to: "2025-01-03" });
  assert.deepEqual(streakRange(days, { from: "2025-01-04", to: "2025-01-04", includesToday: true }), { from: "2025-01-04", to: "2025-01-04" });
  assert.deepEqual(streakRange(days, { from: "2025-01-01", to: "2025-01-04", includesToday: false }), { from: "2025-01-04", to: "2025-01-04" });
  assert.deepEqual(streakRange([{ day: "2025-01-01", sessions: 1 }, { day: "2025-01-05", sessions: 1 }], { from: "2025-01-01", to: "2025-01-05", includesToday: false }, true), { from: "2025-01-05", to: "2025-01-05" });
});

test("用量下钻保留总览的索引和价格版本", () => {
  const route = readUsageRoute("#usage?window=custom&from=2025-01-01&to=2025-01-05&version=index-old&priceVersion=prices-old");
  const query = usageQuery(route, "index-new", "prices-new");
  assert.equal(query.version, "index-old"); assert.equal(query.priceVersion, "prices-old");
});

test("总览动态文案使用真实参数并支持中英文", () => {
  assert.equal(translate("zh-CN", "overview.timing.durationValue", { value: "3.2" }), "3.2 秒");
  assert.equal(translate("en", "overview.timing.durationValue", { value: "3.2" }), "3.2 s");
  assert.ok(translate("en", "overview.help.versions", { version: "index-a", priceVersion: "price-b", timezone: "UTC" }).includes("index-a"));
});

test("隐藏总览页激活先采纳外部筛选，内部模型修改不被旧地址覆盖", () => {
  const old = defaultOverviewRoute(), previous = overviewAddress(old);
  const target = overviewAddress({ ...old, window: "custom", from: "2026-01-01", to: "2026-01-02", clients: ["codex"] });
  const adopted = incomingOverviewRoute(target, previous, old)!;
  assert.equal(adopted.from, "2026-01-01"); assert.deepEqual(adopted.clients, ["codex"]);
  assert.equal(incomingOverviewRoute(target, target, { ...adopted, models: ["model-a"] }), null);
  assert.equal(incomingOverviewRoute(target, previous, adopted), null);
});


test("费用展示保留小计与未知，完整零费用不会被误认为缺失", () => {
  assert.deepEqual(overviewCostState(12, "partial"), { amount: 12, label: "overview.metric.costSubtotal", partial: true });
  assert.deepEqual(overviewCostState(0, "complete"), { amount: 0, label: "overview.metric.cost", partial: false });
  assert.deepEqual(overviewCostState(0, "partial"), { amount: 0, label: "overview.metric.costSubtotal", partial: true });
  assert.deepEqual(overviewCostState(0, "missing"), { amount: null, label: "usage.chart.unpriced", partial: false });
  assert.deepEqual(overviewCostState(null), { amount: null, label: "usage.chart.unpriced", partial: false });
  assert.equal(translate("zh-CN", overviewCostState(12, "partial").label), "估算费用小计");
  assert.equal(translate("en", overviewCostState(null).label), "Unpriced");
});


test("费用状态使用共享可操作帮助与短提示，排行不把帮助按钮嵌入调查按钮", () => {
  const cost = readFileSync(new URL("../web/features/overview/CostAmount.tsx", import.meta.url), "utf8");
  const overview = readFileSync(new URL("../web/features/overview/Overview.tsx", import.meta.url), "utf8");
  const investigation = readFileSync(new URL("../web/features/overview/Investigation.tsx", import.meta.url), "utf8");
  assert.match(cost, /<HelpPopover label=\{label\} container=\{container\}/);
  assert.match(cost, /trigger=\{<Tooltip.Trigger asChild><button[^>]*type="button"[^>]*aria-label=\{label\}/);
  assert.match(cost, /<Tooltip.Content[^>]*>\{label\}<\/Tooltip.Content>/);
  assert.doesNotMatch(cost, /title=\{/);
  for (const button of overview.matchAll(/<button\b[\s\S]*?<\/button>/g)) assert.doesNotMatch(button[0], /<CostAmount/);
  assert.match(overview, /<div className="overview-rank-row"[^>]*role="group"/);
  assert.match(overview, /<CostAmount[^>]*onInspect=\{investigate\}/);
  assert.match(investigation, /<CostAmount[^>]*container=\{container\}/);
});

test("原事件与未确认成员关联的独立请求使用不同React键，公开证据id保持原值", () => {
  const source = readFileSync(new URL("../web/features/overview/Investigation.tsx", import.meta.url), "utf8");
  assert.match(source, /records.rows.map\(row => <tr key=\{JSON.stringify\(\[row.id, row.requestId \?\? null, row.messageId \?\? null\]\)\}/);
  const event = { id: "session-a:event-a", messageId: "event-a", requestId: undefined };
  const request = { id: "session-a:event-a", messageId: "event-a", requestId: "request-a" };
  const key = (row: typeof request | typeof event) => JSON.stringify([row.id, row.requestId ?? null, row.messageId ?? null]);
  assert.notEqual(key(event), key(request));
  assert.equal(event.id, request.id);
});
