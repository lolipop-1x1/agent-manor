import assert from "node:assert/strict";
import { test } from "node:test";
import { historicalPriceSourceUrl, parseHistoricalPriceCatalog, parseStoredHistoricalPriceSnapshot } from "../src/usage/historical-prices.js";
import { priceContentVersion } from "../src/usage/price-catalog.js";

const fetchedAt = "2026-10-11T00:00:00.000Z";
const catalog = (prices: unknown) => [{ id: "example", models: [{ id: "example-model", prices }] }];
const plain = { input_mtok: 1, output_mtok: 4, cache_read_mtok: 0.1 };

test("备用目录的普通单价对象保留当前快照依据，不虚构历史生效日期", () => {
  const snapshot = parseHistoricalPriceCatalog(catalog(plain), fetchedAt);
  assert.equal(snapshot.prices.length, 1);
  assert.deepEqual(snapshot.prices[0], { provider: "example", model: "example-model", input: 1, output: 4, cacheRead: 0.1,
    source: "network", fetchedAt, sourceUrl: historicalPriceSourceUrl, priceBasis: "current_snapshot" });
});

test("仅输入计费的嵌入模型和空价格不阻断文本模型的快照导入", () => {
  const snapshot = parseHistoricalPriceCatalog([{ id: "example", models: [
    { id: "embedding", prices: { input_mtok: 0.1 } },
    { id: "empty", prices: {} },
    { id: "embedding-history", prices: [{ prices: { input_mtok: 0.1 } }, { constraint: { start_date: "2026-06-01" }, prices: { input_mtok: 0.2 } }] },
    { id: "text", prices: plain },
  ] }], fetchedAt);
  assert.deepEqual(snapshot.prices.map(price => price.model), ["text"]);
});

test("无日期数组中的唯一价格可作当前快照，多条无日期价格不猜选取顺序", () => {
  const snapshot = parseHistoricalPriceCatalog(catalog([{ prices: plain }]), fetchedAt);
  assert.equal(snapshot.prices[0]?.priceBasis, "current_snapshot");
  assert.equal(snapshot.prices[0]?.effectiveFrom, undefined);
  assert.equal(snapshot.prices[0]?.effectiveTo, undefined);
  assert.throws(() => parseHistoricalPriceCatalog(catalog([{ prices: plain }, { prices: { ...plain, input_mtok: 2 } }]), fetchedAt));
});

test("日期序列保留开始包含与结束排他的历史区间，不把首个无日期基准改成当前快照", () => {
  const snapshot = parseHistoricalPriceCatalog(catalog([{ prices: plain },
    { constraint: { start_date: "2026-06-01" }, prices: { input_mtok: 2, output_mtok: 8 } }]), fetchedAt);
  assert.equal(snapshot.prices.length, 2);
  assert.ok(snapshot.prices.every(price => price.priceBasis === "historical"));
  assert.equal(snapshot.prices[0]?.effectiveFrom, undefined);
  assert.equal(snapshot.prices[0]?.effectiveTo, "2026-06-01T00:00:00.000Z");
  assert.equal(snapshot.prices[1]?.effectiveFrom, "2026-06-01T00:00:00.000Z");
  assert.equal(snapshot.prices[1]?.effectiveTo, undefined);
});

test("当前快照与旧历史缓存混合保存后重读保持内容版本、抓取时间和价格依据", () => {
  const snapshot = parseHistoricalPriceCatalog([{ id: "example", models: [
    { id: "plain", prices: plain },
    { id: "dated", prices: [{ prices: plain }, { constraint: { start_date: "2026-06-01" }, prices: { input_mtok: 2, output_mtok: 8 } }] },
  ] }], fetchedAt);
  assert.equal(snapshot.prices.length, 3);
  const loaded = parseStoredHistoricalPriceSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.equal(loaded.version, snapshot.version);
  assert.equal(loaded.fetchedAt, fetchedAt);
  assert.deepEqual(loaded.prices, snapshot.prices.map(price => ({ ...price, source: "cache" })));
  const old = parseHistoricalPriceCatalog(catalog([{ prices: plain },
    { constraint: { start_date: "2026-06-01" }, prices: { input_mtok: 2, output_mtok: 8 } }]), fetchedAt);
  assert.equal(parseStoredHistoricalPriceSnapshot(old).version, old.version);
});

test("当前快照跨档分项继承前档价格，重读保持严格大于原始阈值的边界", () => {
  const snapshot = parseHistoricalPriceCatalog(catalog({
    input_mtok: { base: 1, tiers: [{ start: 100, price: 2 }] },
    output_mtok: { base: 4, tiers: [{ start: 200, price: 8 }] }, cache_read_mtok: 0.1,
  }), fetchedAt);
  assert.deepEqual(snapshot.prices[0]?.tiers, [{ context: 101, input: 2 }, { context: 201, input: 2, output: 8 }]);
  assert.equal(snapshot.prices[0]?.priceBasis, "current_snapshot");
  assert.deepEqual(parseStoredHistoricalPriceSnapshot(snapshot).prices[0]?.tiers, snapshot.prices[0]?.tiers);
});

test("复杂约束不能被无约束价格掩盖并作为当前快照导入", () => {
  for (const constraint of [{ request_type: "batch" }, { start_time: "09:00:00Z" }, { start_date: "2026-06-01", region: "example" }]) {
    assert.equal(parseHistoricalPriceCatalog(catalog([{ prices: plain }, { constraint, prices: plain }]), fetchedAt).prices.length, 0);
    assert.equal(parseHistoricalPriceCatalog(catalog({ ...plain, constraint }), fetchedAt).prices.length, 0);
  }
});

test("当前快照损坏的版本、日期和档位即使重算哈希也不能通过缓存校验", () => {
  const original = parseHistoricalPriceCatalog(catalog({ input_mtok: { base: 1, tiers: [{ start: 100, price: 2 }] }, output_mtok: 4 }), fetchedAt);
  for (const corrupt of [
    (snapshot: typeof original) => { snapshot.version = "invalid-version"; },
    (snapshot: typeof original) => { snapshot.prices[0]!.effectiveFrom = "2026-06-01T00:00:00.000Z"; },
    (snapshot: typeof original) => { snapshot.prices[0]!.effectiveTo = "2026-06-01T00:00:00.000Z"; },
    (snapshot: typeof original) => { snapshot.prices[0]!.fetchedAt = "invalid-date"; },
    (snapshot: typeof original) => { snapshot.prices[0]!.fetchedAt = "2026-10-12T00:00:00.000Z"; },
    (snapshot: typeof original) => { snapshot.prices[0]!.sourceUrl = "https://example.invalid/prices.json"; },
    (snapshot: typeof original) => { snapshot.prices[0]!.source = "manual"; },
    (snapshot: typeof original) => { snapshot.prices[0]!.tiers![0]!.context = 0; },
    (snapshot: typeof original) => { snapshot.prices[0]!.tiers!.push({ ...snapshot.prices[0]!.tiers![0]! }); },
    (snapshot: typeof original) => { snapshot.prices[0]!.tiers![0]!.input = -1; },
    (snapshot: typeof original) => { snapshot.prices[0]!.tiers![0]!.cacheRead = 1; },
  ]) {
    const snapshot = structuredClone(original); corrupt(snapshot);
    if (snapshot.version !== "invalid-version") snapshot.version = priceContentVersion(snapshot.prices);
    assert.throws(() => parseStoredHistoricalPriceSnapshot(snapshot));
  }
});
