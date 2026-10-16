import assert from "node:assert/strict";
import test from "node:test";
import { resourceTrendIndexAt } from "../web/features/resources/resource-trend-model.js";

test("趋势按真实日期距离选择最近记录，稀疏日期不按数组等分", () => {
  const dates = ["2026-01-01", "2026-01-02", "2026-01-11"].map(Date.parse);
  assert.equal(resourceTrendIndexAt(dates, 0), 0);
  assert.equal(resourceTrendIndexAt(dates, .1), 1);
  assert.equal(resourceTrendIndexAt(dates, .5), 1);
  assert.equal(resourceTrendIndexAt(dates, .6), 2);
  assert.equal(resourceTrendIndexAt(dates, 1), 2);
});

test("趋势首尾和两个日期中点保持稳定，单日和空数据不产生无效点", () => {
  const dates = [Date.parse("2026-01-01"), Date.parse("2026-01-11")];
  assert.equal(resourceTrendIndexAt(dates, -1), 0);
  assert.equal(resourceTrendIndexAt(dates, 2), 1);
  assert.equal(resourceTrendIndexAt(dates, .5), 0);
  assert.equal(resourceTrendIndexAt([dates[0]!], .9), 0);
  assert.equal(resourceTrendIndexAt([], .5), undefined);
});
