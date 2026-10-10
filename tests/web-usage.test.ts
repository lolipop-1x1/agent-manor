import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageTotals } from "../src/usage-contracts.ts";
import { composition, compositionIsPartial, defaultRoute, metricValue, readUsageRoute, usageAddress, usageParameters, usageQuery } from "../web/features/usage/model.ts";
import { translate } from "../src/i18n/index.ts";

const totals = (): UsageTotals => ({ requests: 1, sessions: 1, tokens: 250, inputTokens: 200, outputTokens: 50, freshInputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 20, reasoningTokens: 30, estimatedCost: .0003, cacheReadRatio: .4, completeTokenRequests: 1, partialTokenRequests: 0, missingTokenRequests: 0, pricedRequests: 1, partiallyPricedRequests: 0, unpricedRequests: 0, missingTimeRequests: 0 });

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
  for (const key of ["window", "chart", "selectedSession", "requestPage", "timeFrom", "timeTo"]) assert.equal(params.has(key), false);
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
  const keys = ["title", "group.model", "interval.hour", "metric.cost", "composition.cacheRead", "filter.relationship", "filter.minTokens", "reason.tier_unknown", "pricing.manual", "pricing.restore", "tokens.input"];
  for (const language of ["zh-CN", "en"] as const) for (const key of keys) assert.notEqual(translate(language, `usage.${key}`), translate(language, "common.translationUnavailable"));
});
