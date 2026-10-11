import assert from "node:assert/strict";
import test from "node:test";
import { priceRowState, selectPriceRows, type PriceRow } from "../web/features/usage/pricing-list.ts";

const priced = (model: string, input: number): PriceRow => ({ model, provider: "fixture", price: { provider: "fixture", model, input, output: input * 2, source: "network" }, manual: false, recorded: true });

test("价格状态筛选区分自动、手动和未匹配，失效映射仍留在未匹配", () => {
  const rows: PriceRow[] = [priced("automatic", 0), { ...priced("mapped", 1), mapped: true }, { ...priced("custom", 2), manual: true },
    { model: "missing", provider: "", manual: false, recorded: true }, { model: "stale", provider: "", manual: false, recorded: true, mapped: true },
    { ...priced("catalog-only", 3), recorded: false }];
  assert.deepEqual(selectPriceRows(rows, "unmatched", null).map(row => row.model), ["missing", "stale"]);
  assert.deepEqual(selectPriceRows(rows, "automatic", null).map(row => row.model), ["automatic"]);
  assert.deepEqual(selectPriceRows(rows, "mapping", null).map(row => row.model), ["mapped"]);
  assert.deepEqual(selectPriceRows(rows, "manual", null).map(row => row.model), ["custom"]);
  assert.equal(selectPriceRows(rows, "all", null).length, rows.length);
  assert.equal(priceRowState(rows[5]!), undefined);
});

test("价格数值排序覆盖完整结果，零价有效，缺失单价双向置后，不改原列表", () => {
  const rows: PriceRow[] = [{ model: "missing", provider: "", manual: false, recorded: true }, ...Array.from({ length: 25 }, (_, index) => priced(`model-${index}`, 24 - index))];
  const ascending = selectPriceRows(rows, "all", { key: "input", direction: "asc" });
  assert.equal(ascending[0]!.price!.input, 0);
  assert.equal(ascending[20]!.price!.input, 20);
  assert.equal(ascending.at(-1)!.model, "missing");
  const descending = selectPriceRows(rows, "all", { key: "input", direction: "desc" });
  assert.equal(descending[0]!.price!.input, 24);
  assert.equal(descending.at(-1)!.model, "missing");
  assert.equal(rows[0]!.model, "missing");
  assert.deepEqual(selectPriceRows(rows, "all", { key: "cacheRead", direction: "desc" }).map(row => row.model), [...rows].sort((a, b) => a.model.localeCompare(b.model)).map(row => row.model));
});

test("模型名称和计价目标排序可反向，筛选先于排序", () => {
  const rows: PriceRow[] = [priced("zebra", 3), { ...priced("atlas", 1), mapped: true }, priced("beta", 0)];
  for (const key of ["model", "effective"] as const) {
    assert.deepEqual(selectPriceRows(rows, "all", { key, direction: "asc" }).map(row => row.model), ["atlas", "beta", "zebra"]);
    assert.deepEqual(selectPriceRows(rows, "all", { key, direction: "desc" }).map(row => row.model), ["zebra", "beta", "atlas"]);
  }
  assert.deepEqual(selectPriceRows(rows, "automatic", { key: "output", direction: "desc" }).map(row => row.model), ["zebra", "beta"]);
});
