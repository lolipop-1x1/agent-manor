import assert from "node:assert/strict";
import test from "node:test";
import { trendAxis, trendBucketAt, trendBuckets, trendDateTicks, trendDisplay, trendLine, type TrendBucket } from "../web/features/overview/trend.ts";

const day = (key: string, tokens: number | null, requests = 1, estimatedCost: number | null = tokens === null ? null : tokens / 1e6) => ({ key, totals: { tokens, requests, estimatedCost } });

test("趋势按天保留零与未知，周月聚合保留实际区间边界", () => {
  const days = [day("2025-12-31", 10), day("2026-01-01", null), day("2026-01-02", 0, 0), day("2026-01-05", 20)];
  assert.deepEqual(trendBuckets(days, "day", "tokens").map(bucket => bucket.value), [10, null, 0, 20]);
  assert.deepEqual(trendBuckets(days, "week", "tokens"), [{ from: "2025-12-31", to: "2026-01-02", value: 10, partial: true }, { from: "2026-01-05", to: "2026-01-05", value: 20 }]);
  assert.deepEqual(trendBuckets(days, "month", "requests"), [{ from: "2025-12-31", to: "2025-12-31", value: 1 }, { from: "2026-01-01", to: "2026-01-05", value: 2 }]);
  assert.equal(trendBuckets([day("2026-01-01", null)], "month", "cost")[0]!.value, null);
});

test("部分记录的已知数值按小计展示，完整的真实零值不标为小计", () => {
  assert.equal(trendBuckets([{ ...day("2026-01-01", 10), totals: { tokens: 10, estimatedCost: .1, requests: 2, missingTokenRequests: 1, unpricedRequests: 1 } }], "day", "tokens")[0]!.partial, true);
  assert.equal(trendBuckets([day("2026-01-01", 0, 0, 0)], "day", "cost")[0]!.partial, undefined);
  assert.equal(trendBuckets([day("2026-01-01", null), day("2026-01-02", 20)], "month", "cost")[0]!.partial, true);
});

test("纵轴保留峰值、从零开始且请求刻度没有小数", () => {
  assert.deepEqual(trendAxis(23291, true), { max: 25000, ticks: [0, 5000, 10000, 15000, 20000, 25000] });
  for (const max of [0, 1, 3, 7, 16, 999]) {
    const axis = trendAxis(max, true);
    assert.equal(axis.ticks[0], 0); assert.ok(axis.max >= max); assert.ok(axis.ticks.every(Number.isInteger));
  }
  const cost = trendAxis(.003, false);
  assert.ok(cost.max >= .003 && cost.max < .01); assert.ok(cost.ticks[1]! > 0);
});

test("密集的每日数据用折线，周月及较疏每日仍用柱形", () => {
  assert.equal(trendDisplay("day", 365, 514), "line");
  assert.equal(trendDisplay("day", 30, 514), "bar");
  assert.equal(trendDisplay("day", 90, 240), "line");
  assert.equal(trendDisplay("week", 53, 240), "bar");
  assert.equal(trendDisplay("month", 12, 240), "bar");
});

test("横轴刻度按宽度稀疏展示，保留跨年范围的首尾", () => {
  const buckets = trendBuckets(Array.from({ length: 365 }, (_, index) => {
    const d = new Date(2025, 9, 13 + index, 12);
    return day(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, index);
  }), "day", "tokens");
  for (const width of [240, 514, 1000]) {
    const ticks = trendDateTicks(buckets, width);
    assert.equal(ticks[0], 0); assert.equal(ticks.at(-1), 364);
    assert.ok(ticks.length <= Math.max(2, Math.floor(width / 90)));
    assert.ok(ticks.every((value, index) => index === 0 || value > ticks[index - 1]!));
  }
  assert.ok(trendDateTicks(buckets, 514).length >= 4);
  assert.deepEqual(trendDateTicks([], 514), []);
  assert.deepEqual(trendDateTicks(buckets.slice(0, 1), 514), [0]);
});

test("边缘和区间内的定位不会漏掉首尾日期", () => {
  assert.equal(trendBucketAt(-1, 514, 365), 0);
  assert.equal(trendBucketAt(0, 514, 365), 0);
  assert.equal(trendBucketAt(257, 514, 365), 182);
  assert.equal(trendBucketAt(514, 514, 365), 364);
  assert.equal(trendBucketAt(600, 514, 365), 364);
});

test("未知日期断开折线，真实零值仍处于基线", () => {
  const buckets: TrendBucket[] = [10, 0, null, 20, 30].map((value, index) => ({ from: String(index), to: String(index), value }));
  const path = trendLine(buckets, index => index * 10, value => 100 - value);
  assert.equal(path, "M0,90L10,100M30,80L40,70");
  assert.equal(trendLine([{ from: "1", to: "1", value: null }], index => index, value => value), "");
});
