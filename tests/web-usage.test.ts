import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageTimeBucket, UsageTotals } from "../src/usage-contracts.ts";
import { composition, compositionIsPartial, defaultRoute, incomingUsageRoute, metricValue, readUsageRoute, speedSelectionToSync, usageAddress, usageParameters, usageQuery, usageDailyMetrics } from "../web/features/usage/model.ts";
import { translate } from "../src/i18n/index.ts";
import { speedComparisonModel, speedLineModel, speedSeriesStyles } from "../web/features/usage/speed-model.ts";
import type { UsageSpeedBucket, UsageSpeedGroup, UsageSpeedReport } from "../src/usage-contracts.ts";

const totals = (): UsageTotals => ({ requests: 1, sessions: 1, tokens: 250, inputTokens: 200, outputTokens: 50, freshInputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 20, reasoningTokens: 30, estimatedCost: .0003, cacheReadRatio: .4, cacheReadRatioRequests: 1, completeTokenRequests: 1, partialTokenRequests: 0, missingTokenRequests: 0, pricedRequests: 1, partiallyPricedRequests: 0, unpricedRequests: 0, missingTimeRequests: 0 });

test("用量默认范围按本机日历含今天连续30天，不修改传入时间", () => {
  const now = new Date(2026, 9, 11, 12, 30);
  const before = now.getTime();
  const query = usageQuery(defaultRoute(), "index-1", "prices-1", now);
  assert.equal(query.from, "2026-09-12"); assert.equal(query.to, "2026-10-11");
  assert.equal(query.version, "index-1"); assert.equal(query.priceVersion, "prices-1");
  assert.equal(now.getTime(), before);
  assert.deepEqual(usageQuery({ ...defaultRoute(), window: "yesterday" }, "i", "p", now).from, "2026-10-10");
  const all = usageQuery({ ...defaultRoute(), window: "all", from: "2000-01-01" }, "i", "p", now);
  assert.equal(all.from, undefined); assert.equal(all.to, undefined);
});

test("多选地址保留路径、逗号、中文与排除，不把数组转换成逗号分隔", () => {
  const route = { ...defaultRoute(), projects: ["/workspace/a,b/项目", "/workspace/a?x=1"], excludeModels: ["unknown", "model/+&"], minTokens: 0, selectedSession: "synthetic-session", requestPage: 3 };
  const restored = readUsageRoute(usageAddress(route));
  assert.deepEqual(restored.projects, route.projects); assert.deepEqual(restored.excludeModels, route.excludeModels);
  assert.equal(restored.minTokens, 0); assert.equal(restored.requestPage, 3);
  const query = usageQuery(restored, "i", "p");
  const params = new URLSearchParams(usageParameters(query));
  assert.deepEqual(JSON.parse(params.get("projects")!), route.projects);
  for (const key of ["window", "chart", "attribution", "selectedSession", "requestPage", "timeFrom", "timeTo"]) assert.equal(params.has(key), false);
});

test("地址校验不接受无效日期、非有限数值、负范围和同项包含排除", () => {
  const params = new URLSearchParams({ window: "custom", from: "2026-02-30", to: "2026-02-28", minTokens: "Infinity", maxCost: "-1", page: "1.5", pageSize: "900", clients: '["codex","claude","codex"]', excludeClients: '["claude"]', models: '{"wrong":1}' });
  const route = readUsageRoute(`#usage?${params}`);
  assert.equal(route.from, undefined); assert.equal(route.to, "2026-02-28");
  assert.equal(route.minTokens, undefined); assert.equal(route.maxCost, undefined); assert.equal(route.page, 1); assert.equal(route.pageSize, 20);
  assert.deepEqual(route.clients, ["codex"]); assert.equal(route.models, undefined);
});

test("小时下钻保留ISO半开区间，日期控件的日历值不改变查询边界", () => {
  const route = readUsageRoute(usageAddress({ ...defaultRoute(), window: "custom", from: "2026-10-11", to: "2026-10-11", timeFrom: "2026-10-11T00:00:00Z", timeTo: "2026-10-11T01:00:00Z" }));
  const query = usageQuery(route, "i", "p");
  assert.equal(query.from, "2026-10-11T00:00:00Z"); assert.equal(query.to, "2026-10-11T01:00:00Z");
  const reversed = readUsageRoute("#usage?window=custom&timeFrom=2026-10-11T01%3A00%3A00Z&timeTo=2026-10-11T00%3A00%3A00Z");
  assert.equal(reversed.timeFrom, undefined);
});

test("组成只绘制互斥桶，推理输出与缓存输入不重复堆叠", () => {
  const complete = totals();
  assert.deepEqual(composition(complete).map(item => item.value), [100, 80, 20, 50]);
  assert.equal(compositionIsPartial(complete), false);
  assert.equal(compositionIsPartial({ ...complete, freshInputTokens: 60 }), true);
  assert.equal(compositionIsPartial({ ...complete, cacheWriteTokens: null }), true);
  assert.equal(metricValue({ ...complete, estimatedCost: null }, "cost"), null);
  assert.equal(metricValue({ ...complete, tokens: 0 }, "tokens"), 0);
});

test("动态图表与筛选标识在中英文目录中完整，产品不展示稳定标识", () => {
  const keys = ["title", "group.model", "interval.hour", "metric.cost", "composition.cacheRead", "filter.relationship", "filter.minTokens", "reason.tier_unknown", "pricing.manual", "pricing.restore", "pricing.editMap", "pricing.match.official", "pricing.match.catalog", "tokens.input"];
  for (const language of ["zh-CN", "en"] as const) for (const key of keys) assert.notEqual(translate(language, `usage.${key}`), translate(language, "common.translationUnavailable"));
});

test("用量会话、无时间请求和档位数量采用英语复数及中文格式", () => {
  assert.equal(translate("en", "usage.coverage.noUsage", { count: 1 }), "1 session has no recorded usage");
  assert.equal(translate("en", "usage.coverage.noUsage", { count: 2 }), "2 sessions have no recorded usage");
  assert.equal(translate("en", "usage.coverage.undated", { count: 1, tokens: "120", cost: "$0.10" }), "Date unknown: 1 request · 120 tokens · $0.10");
  assert.equal(translate("en", "usage.coverage.undated", { count: 2, tokens: "240", cost: "$0.20" }), "Date unknown: 2 requests · 240 tokens · $0.20");
  assert.equal(translate("en", "usage.pricing.tiers", { count: 1 }), "1 context tier");
  assert.equal(translate("en", "usage.pricing.tiers", { count: 2 }), "2 context tiers");
  assert.equal(translate("zh-CN", "usage.coverage.noUsage", { count: 1 }), "1 个会话未记录用量");
  assert.equal(translate("zh-CN", "usage.coverage.cache", { count: 1, requests: 3 }), "缓存比例覆盖：1 / 3 条请求");
  assert.equal(translate("en", "usage.pricing.contextThreshold", { count: 20000 }), "Applies from 20,000 input tokens");
});

const bucket = (key: string): UsageTimeBucket => ({ key, totals: totals(), groups: [] });
test("默认地址为30天及矩形归因，显式选择仍可恢复且视图不参与统计查询", () => {
  assert.equal(readUsageRoute("#usage").window, "30");
  assert.equal(readUsageRoute("#usage").attribution, "treemap");
  const route = readUsageRoute("#usage?window=today&attribution=bar");
  assert.equal(route.window, "today"); assert.equal(route.attribution, "bar");
  assert.equal("attribution" in usageQuery(route, "i", "p"), false);
});

test("日均包含空白日期但不补造费用，峰值同额取最早日期，活跃按请求记录", () => {
  const days = [bucket("2026-01-01"), bucket("2026-01-02"), bucket("2026-01-03")];
  days[0]!.totals.estimatedCost = null;
  days[1]!.totals.estimatedCost = 6;
  days[2]!.totals.estimatedCost = 6;
  const result = usageDailyMetrics(days);
  assert.equal(result.averageCost, 4); assert.equal(result.peak?.key, "2026-01-02"); assert.equal(result.activeDays, 3);
  assert.deepEqual(usageDailyMetrics([]), { averageCost: null, peak: undefined, activeDays: 0 });
  assert.equal(usageDailyMetrics([days[0]!]).averageCost, null);
  days[0]!.totals.estimatedCost = 0;
  assert.equal(usageDailyMetrics([days[0]!]).averageCost, 0);
  assert.equal(usageDailyMetrics([days[0]!]).peak?.totals.estimatedCost, 0);
  days[0]!.totals.requests = 0;
  assert.equal(usageDailyMetrics([days[0]!]).activeDays, 0);
});

test("隐藏用量页激活先采纳总览传入地址，内部筛选修改才写回地址", () => {
  const old = defaultRoute(), oldAddress = usageAddress(old);
  const target = usageAddress({ ...old, window: "custom", from: "2026-10-12", to: "2026-10-12",
    clients: ["codex"], projects: ["/workspace/project-a"], version: "synthetic-index", priceVersion: "synthetic-prices" });
  const adopted = incomingUsageRoute(target, oldAddress, old)!;
  const query = usageQuery(adopted, "synthetic-current-index", "synthetic-current-prices");
  assert.equal(query.from, "2026-10-12"); assert.equal(query.to, "2026-10-12");
  assert.deepEqual(query.clients, ["codex"]); assert.deepEqual(query.projects, ["/workspace/project-a"]);
  assert.equal(query.version, "synthetic-index"); assert.equal(query.priceVersion, "synthetic-prices");
  assert.equal(incomingUsageRoute(target, target, { ...adopted, metric: "cost" }), null);
  assert.equal(incomingUsageRoute(target, oldAddress, adopted), null);
});

test("速度是独立的时间图地址状态，不改变全局指标、柱线偏好与会话分页", () => {
  const route = { ...defaultRoute(), metric: "cost" as const, chart: "bar" as const, trendMetric: "speed" as const,
    speedGroup: 'synthetic/model+group?窗口=output', page: 3, sort: "requests" as const, attribution: "bar" as const };
  const restored = readUsageRoute(usageAddress(route));
  assert.equal(restored.trendMetric, "speed"); assert.deepEqual(restored.speedGroups, [route.speedGroup]);
  assert.equal(restored.speedGroup, undefined);
  assert.equal(restored.metric, "cost"); assert.equal(restored.chart, "bar");
  assert.equal(restored.page, 3); assert.equal(restored.sort, "requests"); assert.equal(restored.attribution, "bar");
  const query = usageQuery(restored, "i", "p");
  assert.equal(query.includeSpeed, true); assert.deepEqual(query.speedGroups, [route.speedGroup]);
  assert.equal("speedGroup" in query, false);
  assert.equal(query.metric, "cost"); assert.equal("trendMetric" in query, false);
  const ordinary = usageQuery({ ...restored, trendMetric: undefined }, "i", "p");
  assert.equal("includeSpeed" in ordinary, false); assert.equal("speedGroup" in ordinary, false); assert.equal("speedGroups" in ordinary, false);
  assert.equal(ordinary.metric, "cost"); assert.equal(ordinary.page, 3);
  assert.equal(readUsageRoute("#usage?trendMetric=unknown&includeSpeed=true").trendMetric, undefined);
});

test("速度多选地址保留空选、去重与特殊字符，新数组优先于旧单选", () => {
  const route = { ...defaultRoute(), trendMetric: "speed" as const, speedGroups: ["model-a/+", "模型,b"] };
  assert.deepEqual(readUsageRoute(usageAddress(route)).speedGroups, route.speedGroups);
  const emptyAddress = usageAddress({ ...route, speedGroups: [] });
  assert.equal(new URLSearchParams(emptyAddress.split("?")[1]).get("speedGroups"), "[]");
  assert.deepEqual(readUsageRoute(emptyAddress).speedGroups, []);
  const query = usageQuery({ ...route, speedGroups: [], speedGroup: "legacy" }, "i", "p");
  assert.deepEqual(query.speedGroups, []); assert.equal(query.speedGroup, undefined);
  assert.equal(new URLSearchParams(usageParameters(query)).get("speedGroups"), "[]");
  assert.deepEqual(readUsageRoute('#usage?speedGroups=["a","a","b"]&speedGroup=legacy').speedGroups, ["a", "b"]);
  assert.deepEqual(readUsageRoute("#usage?speedGroups=[]&speedGroup=legacy").speedGroups, []);
  assert.deepEqual(readUsageRoute("#usage?speedGroups=bad&speedGroup=legacy").speedGroups, ["legacy"]);
  assert.equal(readUsageRoute("#usage?speedGroups=[2]").speedGroups, undefined);
  assert.equal(readUsageRoute("#usage").speedGroups, undefined);
  const ordinary = usageQuery({ ...route, trendMetric: undefined }, "i", "p");
  assert.equal("speedGroups" in ordinary, false);
});

test("空数据范围不把默认或原非空选择误存为显式清空，返回有数据范围仍可恢复", () => {
  assert.equal(speedSelectionToSync(undefined, []), undefined);
  assert.equal(speedSelectionToSync(["a"], []), undefined);
  assert.equal(speedSelectionToSync([], []), undefined);
  assert.equal(speedSelectionToSync([], ["a"]), undefined);
  assert.equal(speedSelectionToSync(["a"], ["a"]), undefined);
  assert.deepEqual(speedSelectionToSync(undefined, ["a", "b", "c"]), ["a", "b", "c"]);
  assert.deepEqual(speedSelectionToSync(["old", "a"], ["a"]), ["a"]);
  assert.deepEqual(speedSelectionToSync(["old"], ["a", "b", "c"]), ["a", "b", "c"]);
});

test("速度图保留缺样本日期的位置并断线，孤立点可见且不把未知补为零", () => {
  const points = (values: (number | null)[]): UsageSpeedBucket[] => values.map((tokensPerSecond, index) => ({
    key: `2026-10-${String(index + 1).padStart(2, "0")}`, tokensPerSecond, requests: 1,
    eligibleRequests: tokensPerSecond === null ? 0 : 1, outputTokens: tokensPerSecond === null ? null : 400,
    durationMs: tokensPerSecond === null ? null : 2000,
  }));
  const result = speedLineModel(points([null, 20, 40, null, 50, null]));
  assert.deepEqual(result.segments, [[{ index: 1, value: 20 }, { index: 2, value: 40 }], [{ index: 4, value: 50 }]]);
  assert.equal(result.points.length, 3); assert.equal(result.lastEligibleIndex, 4); assert.equal(result.maximum, 50);
  assert.deepEqual(speedLineModel(points([null, null])), { segments: [], points: [], maximum: 1, lastEligibleIndex: -1 });
  assert.deepEqual(speedLineModel(points([0])).points, [{ index: 0, value: 0 }]);
  assert.equal(speedLineModel(points([null, 12, null])).segments[0]!.length, 1);
});

test("速度分组、窗口和计时方法具备中英文说明，估算与原生格式保留不同依据", () => {
  const keys = ["metric.speed", "speed.group", "speed.compare", "speed.emptySelection", "speed.selectInterval", "speed.intervalDetails", "speed.noData",
    ...["response", "generation"].map(window => `speed.window.${window}`),
    ...["recorded", "estimated"].map(basis => `speed.basis.${basis}`)];
  const methods = ["codex_event_boundary", "claude_message_boundary", "codeflicker_message_boundary", "codeflicker_desktop_mirror", "dsh_stream_window", "pi_message_boundary", "zcode_request_span", "opencode_message_span", "codebuddy_single_request_turn", "workbuddy_message_boundary", "qoder_message_boundary"];
  for (const language of ["zh-CN", "en"] as const) {
    for (const key of keys) assert.notEqual(translate(language, `usage.${key}`), translate(language, "common.translationUnavailable"));
    for (const method of methods) assert.notEqual(translate(language, `sessions.speed.method.${method}`), translate(language, "common.translationUnavailable"));
    assert.equal(translate(language, "usage.speed.value", { approx: "≈ ", value: "24.5" }), "≈ 24.5 tok/s");
    assert.equal(translate(language, "usage.speed.value", { approx: "", value: "24.5" }), "24.5 tok/s");
  }
  assert.equal(translate("en", "usage.speed.undated", { count: 1 }), "1 request has no reliable date and is excluded from the curve.");
  assert.equal(translate("en", "usage.speed.undated", { count: 2 }), "2 requests have no reliable date and are excluded from the curve.");
  assert.equal(translate("en", "common.picker.selected", { label: "Compare models", count: 1 }), "Compare models · 1 selected");
  assert.equal(translate("zh-CN", "common.picker.selected", { label: "对比模型", count: 3 }), "对比模型 · 已选 3 项");
});

test("速度多曲线共用日期轴与最大值，每组缺口及孤立点独立保留", () => {
  const group = (key: string): UsageSpeedGroup => ({ key, client: "synthetic", model: key, window: "response", basis: "estimated", method: "codex_event_boundary",
    requests: 3, eligibleRequests: 2, outputTokens: 800, durationMs: 4000, tokensPerSecond: 200 });
  const bucket = (key: string, value: number | null): UsageSpeedBucket => ({ key, requests: 1, eligibleRequests: value === null ? 0 : 1,
    outputTokens: value === null ? null : 400, durationMs: value === null ? null : 2000, tokensPerSecond: value });
  const speed: UsageSpeedReport = { groups: [group("b"), group("a"), group("c")], selectedGroups: ["a", "b"], selectedGroup: "a", buckets: [],
    requests: 4, eligibleRequests: 3, missingTimeRequests: 0, series: [
      { group: "a", buckets: [bucket("2026-10-01", 20), bucket("2026-10-03", 40)] },
      { group: "b", buckets: [bucket("2026-10-02", 80), bucket("2026-10-04", null)] },
    ] };
  const result = speedComparisonModel(speed);
  assert.deepEqual(result.dates, ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
  assert.deepEqual(result.series[0]!.model.segments, [[{ index: 0, value: 20 }], [{ index: 2, value: 40 }]]);
  assert.deepEqual(result.series[1]!.model.points, [{ index: 1, value: 80 }]);
  assert.equal(result.maximum, 80); assert.equal(result.lastEligibleIndex, 2);
  assert.equal(result.series[0]!.buckets.get("2026-10-02"), undefined);
  const single = speedComparisonModel({ ...speed, selectedGroups: ["b"], series: [speed.series[1]!] });
  assert.equal(single.series[0]!.color, result.series[1]!.color);
  assert.equal(single.series[0]!.dash, result.series[1]!.dash);
  const empty = speedComparisonModel({ ...speed, selectedGroups: [], series: [] });
  assert.deepEqual(empty.series, []); assert.deepEqual(empty.dates, []); assert.equal(empty.lastEligibleIndex, -1);
});

test("速度曲线色阶不随选择顺序变化，超过六组通过线型区分", () => {
  const keys = ["g", "f", "e", "d", "c", "b", "a"];
  const first = speedSeriesStyles(keys), reordered = speedSeriesStyles([...keys].reverse());
  assert.deepEqual([...first], [...reordered]);
  assert.equal(new Set([...first.values()].slice(0, 6).map(style => style.color)).size, 6);
  assert.equal(first.get("a")!.color, first.get("g")!.color);
  assert.notEqual(first.get("a")!.dash, first.get("g")!.dash);
});

test("稀疏选择第1与25组不会同色同型，默认全选几十组仍可区分且颜色不重排", () => {
  const keys = Array.from({ length: 72 }, (_, index) => `group-${String(index).padStart(2, "0")}`);
  const sparse = speedSeriesStyles(keys, [keys[0]!, keys[24]!]);
  assert.equal(sparse.get(keys[0]!)!.color, sparse.get(keys[24]!)!.color);
  assert.notEqual(sparse.get(keys[0]!)!.dash, sparse.get(keys[24]!)!.dash);
  const all = speedSeriesStyles(keys);
  assert.equal(new Set([...all.values()].map(style => `${style.color}/${style.dash ?? "solid"}`)).size, keys.length);
  for (const key of keys) assert.equal(all.get(key)!.color, sparse.get(key)!.color);
  const reordered = speedSeriesStyles(keys, [keys[24]!, keys[0]!]);
  assert.deepEqual(reordered.get(keys[0]!), sparse.get(keys[0]!));
  assert.deepEqual(reordered.get(keys[24]!), sparse.get(keys[24]!));
});

test("157与500组全选不会循环重复色型，线段及间隔保持短长度", () => {
  for (const count of [157, 500]) {
    const keys = Array.from({ length: count }, (_, index) => `group-${String(index).padStart(3, "0")}`);
    const styles = speedSeriesStyles(keys);
    assert.equal(new Set([...styles.values()].map(style => `${style.color}/${style.dash ?? "solid"}`)).size, count);
    assert.equal(styles.get("group-006")!.color, styles.get("group-156")!.color);
    assert.notEqual(styles.get("group-006")!.dash, styles.get("group-156")!.dash);
    const lengths = [...styles.values()].flatMap(style => style.dash?.split(" ").map(Number) ?? []);
    assert.ok(lengths.every(value => value > 0 && value <= 11));
  }
});

test("正偏移时区夏令时回拨按真实时刻排列小时桶，不颠倒两个当地02点", () => {
  const ordered = ["2026-10-25T01:00:00+02:00", "2026-10-25T02:00:00+02:00", "2026-10-25T02:00:00+01:00", "2026-10-25T03:00:00+01:00"];
  const buckets: UsageSpeedBucket[] = ordered.map((key, index) => ({ key, requests: 1, eligibleRequests: 1, outputTokens: 400, durationMs: 2000, tokensPerSecond: 20 + index }));
  const group: UsageSpeedGroup = { key: "synthetic", client: "synthetic", model: "model-a", window: "response", basis: "estimated", method: "codex_event_boundary", requests: 4, eligibleRequests: 4, outputTokens: 1600, durationMs: 8000, tokensPerSecond: 200 };
  const speed: UsageSpeedReport = { groups: [group], selectedGroups: [group.key], selectedGroup: group.key, buckets,
    requests: 4, eligibleRequests: 4, missingTimeRequests: 0, series: [{ group: group.key, buckets: [...buckets].reverse() }] };
  const result = speedComparisonModel(speed);
  assert.deepEqual(result.dates, ordered);
  assert.deepEqual(result.series[0]!.model.points.map(point => point.value), [20, 21, 22, 23]);
  assert.equal(Date.parse(result.dates[2]!) - Date.parse(result.dates[1]!), 3600000);
  const dates = ["2026-11-01", "2026-10-01", "2026-10-26"];
  const calendar = speedComparisonModel({ ...speed, series: [{ group: group.key, buckets: dates.map((key, index) => ({ ...buckets[index]!, key })) }] });
  assert.deepEqual(calendar.dates, ["2026-10-01", "2026-10-26", "2026-11-01"]);
});
