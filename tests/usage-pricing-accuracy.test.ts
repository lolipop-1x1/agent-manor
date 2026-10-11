import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionUsage } from "../src/session-contracts.js";
import { createPricingEstimator, PricingService } from "../src/usage/pricing.js";
import { parseHistoricalPriceCatalog, parseStoredHistoricalPriceSnapshot } from "../src/usage/historical-prices.js";
import { parsePriceCatalog, priceSourceUrl } from "../src/usage/price-catalog.js";

const date = "2026-10-11T00:00:00.000Z";
const catalog = {
  alpha: { models: { "shared-model": { cost: { input: 2, output: 4 } } } },
  beta: { models: { "shared-model": { cost: { input: 8, output: 16 } } } },
};
const response = (value: unknown) => new Response(JSON.stringify(value));
const historyUrl = "https://raw.githubusercontent.com/pydantic/genai-prices/main/prices/data.json";
const history = (input = 6) => [{ id: "alpha", models: [{ id: "shared-model", prices: [
  { prices: { input_mtok: 3, output_mtok: 9 } },
  { constraint: { start_date: "2026-06-01" }, prices: { input_mtok: input, output_mtok: 12 } },
] }] }];
const request = (fields: Partial<SessionUsage> = {}): SessionUsage => ({ id: "synthetic-request", model: "shared-model",
  inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheWriteTokens: 0, occurredAt: date, ...fields });
function workspace(t: { after(fn: () => void): void }): string {
  const home = mkdtempSync(join(tmpdir(), "usage-price-accuracy-"));
  t.after(() => rmSync(home, { recursive: true, force: true })); return home;
}

test("请求已记录服务商时，同名模型精确选择该服务商，未知服务商不能借用其他价格", async t => {
  const service = new PricingService(workspace(t), { fetch: async () => response(catalog), now: () => new Date(date) });
  await service.refresh();
  assert.equal(service.estimate(request({ provider: "alpha" })).amount, 240 / 1_000_000);
  assert.equal(service.estimate(request({ provider: "beta" })).amount, 960 / 1_000_000);
  assert.equal(service.estimate(request({ provider: "missing-provider" })).amount, null);
  assert.equal(service.estimate(request({ provider: undefined })).reason, "price_missing");
});

test("同模型服务商覆盖可共存，全局覆盖最高，网络更新与重启保留作用范围", async t => {
  const home = workspace(t), service = new PricingService(home, { fetch: async () => response(catalog), now: () => new Date(date) });
  await service.refresh();
  service.configure({ overrides: [{ model: "shared-model", provider: "alpha", input: 3, output: 6 },
    { model: "shared-model", provider: "beta", input: 9, output: 18 }], mappings: [] });
  assert.equal(service.estimate(request({ provider: "alpha" })).amount, 360 / 1_000_000);
  assert.equal(service.estimate(request({ provider: "beta" })).amount, 1080 / 1_000_000);
  assert.equal(service.estimate(request()).amount, null);
  service.configure({ overrides: [...service.status().configuration.overrides, { model: "shared-model", input: 0, output: 0 }],
    mappings: [{ model: "shared-model", targetProvider: "missing-provider", targetModel: "missing-model" }] });
  await service.refresh(true);
  for (const provider of ["alpha", "beta", "missing-provider", undefined]) {
    const cost = service.estimate(request({ provider })); assert.equal(cost.amount, 0); assert.equal(cost.priceBasis, "manual");
  }
  assert.equal(new PricingService(home).estimate(request({ provider: "beta" })).amount, 0);
  assert.throws(() => service.configure({ overrides: [{ model: "shared-model", provider: "alpha", input: 1, output: 1 },
    { model: "shared-model", provider: "alpha", input: 2, output: 2 }], mappings: [] }), { code: "INVALID_INPUT" });
  assert.equal(JSON.parse(readFileSync(join(home, "usage-pricing.json"), "utf8")).overrides.length, 3);
});

test("明确服务商优先于标准模型原厂基准，映射目标仍支持服务商覆盖", async t => {
  const service = new PricingService(workspace(t), { fetch: async () => response({ openai: { models: { "gpt-example": { cost: { input: 1, output: 2 } } } },
    reseller: { models: { "gpt-example": { cost: { input: 10, output: 20 } } } } }), now: () => new Date(date) });
  await service.refresh();
  assert.equal(service.estimate(request({ model: "gpt-example" })).price?.provider, "openai");
  assert.equal(service.estimate(request({ model: "gpt-example", provider: "reseller" })).price?.provider, "reseller");
  assert.equal(service.estimate(request({ model: "gpt-example", provider: "unknown" })).amount, null);
  service.configure({ overrides: [{ model: "gpt-example", provider: "reseller", input: 7, output: 14 }],
    mappings: [{ model: "shared-model", targetProvider: "reseller", targetModel: "gpt-example" }] });
  const cost = service.estimate(request()); assert.equal(cost.price?.provider, "reseller"); assert.equal(cost.price?.input, 7);
  assert.deepEqual(createPricingEstimator(service.status(), true)(request()), cost);
});

test("历史价按请求发生的UTC时间选择，生效边界含开始不含结束，缺时间回退明确快照估算", async t => {
  const service = new PricingService(workspace(t), { fetch: async url => response(url === historyUrl ? history() : catalog), now: () => new Date(date) });
  await service.refresh();
  const old = service.estimate(request({ provider: "alpha", occurredAt: "2026-06-01T07:59:59+08:00" }));
  assert.equal(old.amount, 390 / 1_000_000); assert.equal(old.priceBasis, "historical");
  assert.equal(old.priceEffectiveFrom, undefined); assert.equal(old.priceEffectiveTo, "2026-06-01T00:00:00.000Z");
  const current = service.estimate(request({ provider: "alpha", occurredAt: "2026-06-01T08:00:00+08:00" }));
  assert.equal(current.amount, 720 / 1_000_000); assert.equal(current.priceEffectiveFrom, "2026-06-01T00:00:00.000Z");
  assert.equal(current.priceProvider, "alpha"); assert.equal(current.priceSourceUrl, historyUrl);
  for (const occurredAt of [undefined, "invalid-date"]) {
    const cost = service.estimate(request({ provider: "alpha", occurredAt }));
    assert.equal(cost.amount, 240 / 1_000_000); assert.equal(cost.priceBasis, "current_snapshot");
  }
  const other = service.estimate(request({ provider: "beta" })); assert.equal(other.amount, 960 / 1_000_000);
  assert.equal(other.priceBasis, "current_snapshot");
  const { historicalPrices: _history, prices: _prices, configuration: _configuration, ...summary } = service.status();
  assert.deepEqual(service.summary(), summary);
  const full = createPricingEstimator(service.status(), true), light = createPricingEstimator(service.status());
  assert.deepEqual(full(request({ provider: "alpha" })), service.estimate(request({ provider: "alpha" })));
  const { price: _price, ...expected } = full(request({ provider: "alpha" })); assert.deepEqual(light(request({ provider: "alpha" })), expected);
});

test("历史价保留上下文分档，缺输入不猜档位；未支持约束不伪装历史价", async t => {
  const historical = [{ id: "alpha", models: [{ id: "shared-model", prices: [
    { prices: { input_mtok: { base: 1, tiers: [{ start: 100, price: 2 }] }, output_mtok: { base: 3, tiers: [{ start: 100, price: 6 }] } } },
    { constraint: { start_date: "2026-06-01" }, prices: { input_mtok: 4, output_mtok: 8 } },
  ] }] }];
  const service = new PricingService(workspace(t), { fetch: async url => response(url === historyUrl ? historical : catalog), now: () => new Date(date) });
  await service.refresh();
  const before = "2026-05-31T23:59:59Z";
  assert.equal(service.estimate(request({ provider: "alpha", inputTokens: 99, occurredAt: before })).amount, 129 / 1_000_000);
  assert.equal(service.estimate(request({ provider: "alpha", inputTokens: 100, occurredAt: before })).amount, 130 / 1_000_000);
  assert.equal(service.estimate(request({ provider: "alpha", inputTokens: 101, occurredAt: before })).amount, 262 / 1_000_000);
  const missing = service.estimate(request({ provider: "alpha", inputTokens: undefined, occurredAt: before }));
  assert.equal(missing.amount, null); assert.equal(missing.reason, "tier_unknown");
});

test("仅有明确生效日期的历史条目不覆盖日期之前，免费与未定价分别保留", async t => {
  const historical = [{ id: "alpha", models: [{ id: "shared-model", prices: [
    { constraint: { start_date: "2026-06-01" }, prices: { input_mtok: 0, output_mtok: 0 } },
  ] }, { id: "only-history", prices: [
    { constraint: { start_date: "2026-06-01" }, prices: { input_mtok: 5, output_mtok: 10 } },
  ] }, { id: "unconstrained-model", prices: { input_mtok: 0, output_mtok: 0 } }] }];
  const service = new PricingService(workspace(t), { fetch: async url => response(url === historyUrl ? historical : catalog), now: () => new Date(date) });
  await service.refresh();
  const old = service.estimate(request({ provider: "alpha", occurredAt: "2026-05-31T00:00:00Z" }));
  assert.equal(old.priceBasis, "current_snapshot"); assert.equal(old.amount, 240 / 1_000_000);
  const free = service.estimate(request({ provider: "alpha" })); assert.equal(free.priceBasis, "historical"); assert.equal(free.amount, 0);
  assert.equal(service.estimate(request({ model: "only-history", provider: "alpha" })).amount, 600 / 1_000_000);
  assert.equal(service.estimate(request({ model: "only-history", provider: "alpha", occurredAt: undefined })).amount, null);
  assert.equal(service.estimate(request({ model: "unconstrained-model", provider: "alpha" })).reason, "price_missing");
  service.configure({ overrides: [{ model: "shared-model", provider: "alpha", input: 7, output: 14 }], mappings: [] });
  assert.equal(service.estimate(request({ provider: "alpha" })).priceBasis, "manual");
});

test("历史刷新失败保留成功缓存，独立目录仍更新，价格变化使新版本失效而旧视图固定", async t => {
  const home = workspace(t); let nextHistory: unknown = history(); let nextCatalog: unknown = catalog;
  const service = new PricingService(home, { fetch: async url => response(url === historyUrl ? nextHistory : nextCatalog), now: () => new Date(date) });
  await service.refresh(); const view = service.view(), version = view.status.version;
  const saved = readFileSync(join(home, "usage-price-history-cache.json"), "utf8");
  nextHistory = {}; nextCatalog = { alpha: { models: { "shared-model": { cost: { input: 20, output: 40 } } } } };
  await service.refresh(true);
  assert.equal(readFileSync(join(home, "usage-price-history-cache.json"), "utf8"), saved);
  assert.equal(service.status().history?.errorDescriptor?.key, "diagnostics.usage.pricing.invalidCatalog");
  assert.equal(service.estimate(request({ provider: "alpha" })).amount, 720 / 1_000_000);
  assert.equal(service.estimate(request({ provider: "alpha", occurredAt: undefined })).amount, 2400 / 1_000_000);
  nextHistory = history(9); await service.refresh(true);
  assert.equal(service.estimate(request({ provider: "alpha" })).amount, 1020 / 1_000_000);
  assert.notEqual(service.version(), version); assert.equal(view.estimate(request({ provider: "alpha" })).amount, 720 / 1_000_000);
  assert.equal(new PricingService(home).estimate(request({ provider: "alpha" })).amount, 1020 / 1_000_000);
  assert.equal(service.status().history?.error, undefined);
});

test("未支持的日内或未知约束整模型回退当前快照，不选择无约束平价伪装历史完整覆盖", async t => {
  for (const constraint of [{ start_time: "00:30:00Z", end_time: "16:30:00Z" }, { request_type: "batch" }]) {
    const historical = [{ id: "alpha", models: [{ id: "shared-model", prices: [
      { prices: { input_mtok: 0, output_mtok: 0 } }, { constraint, prices: { input_mtok: 10, output_mtok: 20 } },
    ] }] }];
    const service = new PricingService(workspace(t), { fetch: async url => response(url === historyUrl ? historical : catalog), now: () => new Date(date) });
    await service.refresh(); const cost = service.estimate(request({ provider: "alpha" }));
    assert.equal(cost.amount, 240 / 1_000_000); assert.equal(cost.priceBasis, "current_snapshot");
  }
});

test("无效历史日期、逆序价格和损坏缓存均不能参与历史估价", t => {
  for (const start_date of ["2026-02-30", "invalid-date", "2026-06-01T12:00:00Z"]) {
    assert.throws(() => parseHistoricalPriceCatalog([{ id: "alpha", models: [{ id: "shared-model", prices: [
      { constraint: { start_date }, prices: { input_mtok: 1, output_mtok: 2 } },
    ] }] }], date));
  }
  assert.throws(() => parseHistoricalPriceCatalog([{ id: "alpha", models: [{ id: "shared-model", prices: [
    { constraint: { start_date: "2026-06-01" }, prices: { input_mtok: 1, output_mtok: 2 } },
    { constraint: { start_date: "2026-05-01" }, prices: { input_mtok: 3, output_mtok: 4 } },
  ] }] }], date));
  const snapshot = parseHistoricalPriceCatalog(history(), date);
  assert.equal(parseStoredHistoricalPriceSnapshot(snapshot).version, snapshot.version);
  snapshot.prices[0]!.effectiveTo = "2026-07-01T00:00:00.000Z";
  assert.throws(() => parseStoredHistoricalPriceSnapshot(snapshot));
  const home = workspace(t); writeFileSync(join(home, "usage-price-history-cache.json"), "broken");
  const service = new PricingService(home);
  assert.equal(service.status().history?.errorDescriptor?.key, "diagnostics.usage.pricing.invalidCatalog");
  assert.equal(service.status().history?.source, undefined);
  assert.equal(service.estimate(request({ model: "openai/gpt-5.4" })).priceBasis, "current_snapshot");
});

test("历史HTTP失败不改成功版本，当前目录失败不阻止历史独立更新", async t => {
  const home = workspace(t); let failHistory = false, failCurrent = false;
  const service = new PricingService(home, { fetch: async url => {
    if (url === historyUrl) return failHistory ? new Response("failure", { status: 503 }) : response(history());
    return failCurrent ? new Response("failure", { status: 503 }) : response(catalog);
  }, now: () => new Date(date) });
  await service.refresh(); const version = service.version(), saved = readFileSync(join(home, "usage-price-history-cache.json"), "utf8");
  failHistory = true; await service.refresh(true);
  assert.equal(service.version(), version); assert.equal(readFileSync(join(home, "usage-price-history-cache.json"), "utf8"), saved);
  assert.equal(service.status().history?.errorDescriptor?.key, "diagnostics.usage.pricing.fetch");
  failHistory = false; failCurrent = true; await service.refresh(true);
  assert.equal(service.status().errorDescriptor?.key, "diagnostics.usage.pricing.fetch"); assert.equal(service.status().history?.error, undefined);
  assert.equal(service.status().history?.source, "network"); assert.equal(service.estimate(request({ provider: "alpha" })).priceBasis, "historical");
});

test("升级已有新鲜当前缓存但没有历史缓存时首次检查仍下载历史，失败后的本次进程检查限频", async t => {
  for (const failHistory of [false, true]) {
    const home = workspace(t); writeFileSync(join(home, "usage-price-cache.json"), JSON.stringify(parsePriceCatalog(catalog, date)));
    const calls: string[] = [];
    const service = new PricingService(home, { fetch: async url => {
      calls.push(String(url));
      if (url === historyUrl) return failHistory ? new Response("failure", { status: 503 }) : response(history());
      return response(catalog);
    }, now: () => new Date(date) });
    await service.refresh();
    assert.deepEqual(calls.sort(), [historyUrl, priceSourceUrl].sort());
    assert.equal(service.status().history?.source, failHistory ? undefined : "network");
    assert.equal(service.estimate(request({ provider: "alpha" })).priceBasis, failHistory ? "current_snapshot" : "historical");
    await service.refresh(); await service.refresh(); assert.equal(calls.length, 2);
  }
});

test("历史缓存内容版本不一致时拒绝有效数值的损坏内容", () => {
  const snapshot = parseHistoricalPriceCatalog(history(), date);
  snapshot.prices[0]!.input = 999;
  assert.throws(() => parseStoredHistoricalPriceSnapshot(snapshot));
});

test("原生官方渠道只使用明确标记的API估算基准，订阅与未知渠道不借用API价格", async t => {
  const prices = { deepseek: { models: { "deepseek-example": { cost: { input: 2, output: 4 } } } },
    openai: { models: { "gpt-example": { cost: { input: 1, output: 2 } } } } };
  const service = new PricingService(workspace(t), { fetch: async () => response(prices), now: () => new Date(date) });
  await service.refresh();
  const usage = request({ model: "deepseek-example", provider: "deepseek-official" });
  const cost = service.estimate(usage);
  assert.equal(cost.amount, 240 / 1_000_000); assert.equal(cost.priceProvider, "deepseek");
  assert.equal(cost.apiBaselineForProvider, "deepseek-official"); assert.equal(usage.provider, "deepseek-official");
  assert.deepEqual(createPricingEstimator(service.status(), true)(usage), cost);
  assert.equal(createPricingEstimator(service.status())(usage).apiBaselineForProvider, "deepseek-official");
  assert.equal(service.estimate({ ...usage, model: "deepseek/deepseek-example" }).amount, cost.amount);
  assert.equal(service.estimate({ ...usage, model: "deepseek-official/deepseek-example" }).amount, cost.amount);
  assert.equal(service.estimate(request({ model: "gpt-example", provider: "openai-codex" })).amount, null);
  assert.equal(service.estimate(request({ model: "deepseek-example", provider: "custom-gateway" })).amount, null);
  assert.equal(service.estimate(request({ model: "missing-model", provider: "deepseek-official" })).amount, null);
  service.configure({ overrides: [{ model: "deepseek-example", provider: "deepseek-official", input: 3, output: 6 }], mappings: [] });
  assert.equal(service.estimate(usage).amount, 360 / 1_000_000);
  assert.equal(service.estimate(usage).apiBaselineForProvider, undefined);
  service.configure({ overrides: [{ model: "deepseek-example", input: 0, output: 0 }], mappings: [] });
  assert.equal(service.estimate(usage).amount, 0); assert.equal(service.estimate(usage).apiBaselineForProvider, undefined);
});

test("渠道自身的精确价格优先于原厂估算基准，原厂历史价格仍按请求日期选择", async t => {
  const prices = { deepseek: { models: { "deepseek-example": { cost: { input: 2, output: 4 } } } },
    "deepseek-official": { models: { "deepseek-example": { cost: { input: 9, output: 18 } } } } };
  const historical = [{ id: "deepseek", models: [{ id: "deepseek-example", prices: [
    { constraint: { start_date: "2026-06-01" }, prices: { input_mtok: 3, output_mtok: 6 } },
  ] }] }];
  const service = new PricingService(workspace(t), { fetch: async url => response(url === historyUrl ? historical : prices), now: () => new Date(date) });
  await service.refresh();
  const usage = request({ model: "deepseek-example", provider: "deepseek-official" });
  assert.equal(service.estimate(usage).amount, 1080 / 1_000_000);
  assert.equal(service.estimate(usage).apiBaselineForProvider, undefined);
  const fallback = new PricingService(workspace(t), { fetch: async url => response(url === historyUrl ? historical : { deepseek: prices.deepseek }), now: () => new Date(date) });
  await fallback.refresh();
  const cost = fallback.estimate(usage);
  assert.equal(cost.amount, 360 / 1_000_000); assert.equal(cost.priceBasis, "historical");
  assert.equal(cost.apiBaselineForProvider, "deepseek-official");
});
