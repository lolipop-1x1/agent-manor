import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PricingService } from "../src/usage/pricing.js";
import { createPriceMatcher } from "../src/usage/price-resolution.js";
import { parsePriceCatalog, parseStoredPriceSnapshot, priceContentVersion } from "../src/usage/price-catalog.js";
import type { ModelPrice } from "../src/usage-contracts.js";

test("新模型系列依据目录标准身份采用官方 API 价格，套餐零价不改变基准", async t => {
  const home = mkdtempSync(join(tmpdir(), "canonical-pricing-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const catalog = {
    "synthetic-origin": { models: { "nebula-77-preview": { canonical_model_id: "synthetic-origin/nebula-77-preview", cost: { input: 1, output: 3, cache_read: 0.1, cache_write: 1 } } } },
    "synthetic-plan": { models: { "nebula-77-preview": { canonical_model_id: "synthetic-origin/nebula-77-preview", cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } } },
  };
  const pricing = new PricingService(home, { fetch: async () => Response.json(catalog), now: () => new Date("2026-10-11T00:00:00Z") });
  await pricing.refresh();
  const usage = { id: "synthetic-request", model: "arbitrary-channel/nebula-77-preview", provider: "synthetic-plan", inputTokens: 100, outputTokens: 10, cachedInputTokens: 20, cacheWriteTokens: 5 };
  const cost = pricing.estimate(usage);
  assert.equal(cost.priceProvider, "synthetic-origin");
  assert.equal(cost.priceModel, "nebula-77-preview");
  assert.equal(cost.priceMatchBasis, "official");
  assert.equal(cost.amount, 0.000112);
  assert.equal(cost.coverage, "complete");
  const restarted = new PricingService(home);
  assert.equal(restarted.estimate(usage).amount, 0.000112);
  assert.equal(restarted.status().prices.find(price => price.provider === "synthetic-origin")?.canonicalModelId, "synthetic-origin/nebula-77-preview");
});

test("标准身份冲突保留未知，明确身份和用户配置可消除歧义", () => {
  const prices: ModelPrice[] = [
    { provider: "alpha", model: "shared-77", canonicalModelId: "alpha/shared-77", input: 1, output: 2, source: "network" },
    { provider: "beta", model: "shared-77", canonicalModelId: "beta/shared-77", input: 8, output: 9, source: "network" },
  ];
  const match = createPriceMatcher(prices, { overrides: [], mappings: [] });
  assert.equal(match("channel/shared-77").price, undefined);
  assert.equal(match("channel/shared-77").reason, "identity_conflict");
  assert.equal(match("channel/shared-77").candidates.length, 2);
  assert.equal(match("alpha/shared-77").price?.input, 1);
  assert.equal(match("shared-77", "beta").price?.input, 8);
  const explicit = createPriceMatcher([...prices, { provider: "gamma", model: "shared-77", input: 4, output: 5, source: "network" }], { overrides: [], mappings: [] });
  assert.equal(explicit("shared-77", "gamma").price?.input, 4);
  assert.equal(explicit("shared-77", "gamma").reason, undefined);
  assert.equal(explicit("gamma/shared-77").price?.input, 4);
  assert.equal(explicit("channel/shared-77", "gamma").price?.input, 4);
  assert.equal(explicit("channel/shared-78", "gamma").price, undefined);
  assert.equal(explicit("channel/shared-77").reason, "identity_conflict");
  const configured = createPriceMatcher(prices, { overrides: [{ model: "channel/shared-77", input: 0, output: 0 }], mappings: [{ model: "channel/shared-77", targetProvider: "beta", targetModel: "shared-77" }] });
  assert.equal(configured("channel/shared-77").price?.input, 0);
  assert.equal(configured("channel/shared-77").price?.source, "manual");
});

test("身份明确而官方缺价与身份未知分别诊断，手动失效目标不自动换价", () => {
  const prices: ModelPrice[] = [{ provider: "reseller", model: "nebula-77-preview", canonicalModelId: "origin/nebula-77-preview", input: 1, output: 2, source: "network" }];
  const match = createPriceMatcher(prices, { overrides: [], mappings: [] });
  assert.equal(match("channel/nebula-77-preview").reason, "api_price_missing");
  assert.equal(match("opaque-deployment").reason, "model_unknown");
  assert.equal(match("channel/nebula-78-preview").price, undefined);
  assert.equal(match("channel/nebula-77").price, undefined);
  const manual = createPriceMatcher(prices, { overrides: [], mappings: [{ model: "nebula-77-preview", targetProvider: "missing", targetModel: "missing" }] });
  assert.equal(manual("nebula-77-preview").reason, "mapping_missing");
  assert.equal(manual("nebula-77-preview").price, undefined);
});

test("标准身份允许同版本目录基准兜底，不需要预设模型系列前缀", () => {
  const match = createPriceMatcher([{ provider: "openrouter", model: "origin/nebula-77-preview", canonicalModelId: "origin/nebula-77-preview", input: 3, output: 4, source: "network" }], { overrides: [], mappings: [] });
  assert.equal(match("channel/NEBULA_77_PREVIEW").price?.model, "origin/nebula-77-preview");
  assert.equal(match("channel/NEBULA_77_PREVIEW").price?.matchBasis, "catalog");
  assert.equal(match("channel/nebula-77-pro").price, undefined);
});

test("标准身份聚合多个收费变体时不串价，也不使已有精确官方价失效", () => {
  const prices: ModelPrice[] = [
    { provider: "openai", model: "gpt-synthetic-77", canonicalModelId: "openai/gpt-synthetic-77", input: 1, output: 2, source: "network" },
    { provider: "openrouter", model: "openai/gpt-synthetic-77", canonicalModelId: "openai/gpt-synthetic-77", input: 1, output: 2, source: "network" },
    { provider: "openrouter", model: "openai/gpt-synthetic-77-pro", canonicalModelId: "openai/gpt-synthetic-77", input: 10, output: 20, source: "network" },
    { provider: "origin", model: "nebula-77-vision", canonicalModelId: "origin/nebula-77-preview", input: 8, output: 9, source: "network" },
    { provider: "openrouter", model: "origin/nebula-77-preview", canonicalModelId: "origin/nebula-77-preview", input: 3, output: 4, source: "network" },
  ];
  const match = createPriceMatcher(prices, { overrides: [], mappings: [] });
  assert.equal(match("channel/gpt-synthetic-77").price?.provider, "openai");
  assert.equal(match("channel/gpt-synthetic-77-pro").price?.input, 10);
  assert.equal(match("channel/nebula-77-preview").price?.provider, "openrouter");
  assert.equal(match("channel/nebula-77-preview").price?.input, 3);
});

test("模型身份进入内容版本，损坏身份不覆盖缓存", () => {
  const data = { origin: { models: { "nebula-77-preview": { canonical_model_id: "origin/nebula-77-preview", cost: { input: 1, output: 2 } } } } };
  const snapshot = parsePriceCatalog(data, "2026-10-11T00:00:00Z");
  assert.equal(parseStoredPriceSnapshot(snapshot).prices[0]?.canonicalModelId, "origin/nebula-77-preview");
  assert.notEqual(snapshot.version, priceContentVersion(snapshot.prices.map(({ canonicalModelId: _identity, ...price }) => price)));
  assert.throws(() => parseStoredPriceSnapshot({ ...snapshot, prices: [{ ...snapshot.prices[0], canonicalModelId: "/missing" }] }));
  assert.throws(() => parsePriceCatalog({ origin: { models: { invalid: { canonical_model_id: "missing", cost: { input: 1, output: 2 } } } } }, "2026-10-11T00:00:00Z"));
});

test("官方 API 兜底具有明确来源，套餐精确映射和用户价格仍优先", async t => {
  const home = mkdtempSync(join(tmpdir(), "official-api-baseline-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const pricing = new PricingService(home);
  const usage = { id: "synthetic-request", model: "hy3", provider: "tencent-token-plan", inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
  const baseline = pricing.estimate(usage);
  assert.equal(baseline.priceProvider, "tencent"); assert.equal(baseline.amount, 0.132);
  assert.equal(baseline.priceBasis, "current_snapshot");
  assert.equal(baseline.price?.sourceUrl, "https://intl.cloud.tencent.com/zh/document/product/1300/78937");
  assert.equal(pricing.estimate({ ...usage, model: "hy4-preview" }).amount, 0.834);
  assert.equal(pricing.estimate({ ...usage, model: "route/gpt-5-codex" }).amount, 1.25);
  pricing.configure({ overrides: [], mappings: [{ model: "hy3", targetProvider: "tencent-token-plan", targetModel: "hy3" }] });
  assert.equal(pricing.estimate(usage).amount, 0);
  pricing.configure({ overrides: [{ model: "hy3", input: 7, output: 8 }], mappings: [] });
  assert.equal(pricing.estimate(usage).amount, 7);
});
