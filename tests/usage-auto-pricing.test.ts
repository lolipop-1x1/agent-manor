import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionUsage } from "../src/session-contracts.js";
import { createPricingEstimator, PricingService } from "../src/usage/pricing.js";
import { historicalPriceSourceUrl } from "../src/usage/historical-prices.js";

const date = "2026-10-11T00:00:00.000Z";
const request = (fields: Partial<SessionUsage> = {}): SessionUsage => ({ id: "synthetic-request", model: "gpt-synthetic-7",
  inputTokens: 100, outputTokens: 10, cachedInputTokens: 20, cacheWriteTokens: 5, occurredAt: date, ...fields });
function workspace(t: { after(fn: () => void): void }): string {
  const home = mkdtempSync(join(tmpdir(), "usage-auto-price-"));
  t.after(() => rmSync(home, { recursive: true, force: true })); return home;
}

test("任意命名空间、免费标记和套餐渠道优先采用同模型官方 API 单价", async t => {
  const catalog = {
    openai: { models: { "gpt-synthetic-7": { cost: { input: 2, output: 5, cache_read: 0.1, cache_write: 1 } } } },
    "reseller-token-plan": { models: { "gpt-synthetic-7": { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } } },
    openrouter: { models: { "openai/gpt-synthetic-7": { cost: { input: 20, output: 50, cache_read: 1, cache_write: 10 } } } },
  };
  const pricing = new PricingService(workspace(t), { fetch: async () => new Response(JSON.stringify(catalog)), now: () => new Date(date) });
  await pricing.refresh();
  for (const model of ["arbitrary-route/GPT-synthetic-7:free", "another-route/gpt-synthetic-7", "gpt-synthetic-7-free"]) {
    const usage = request({ model, provider: "reseller-token-plan" }), cost = pricing.estimate(usage);
    assert.equal(cost.amount, 0.000207);
    assert.equal(cost.priceProvider, "openai"); assert.equal(cost.priceModel, "gpt-synthetic-7");
    assert.equal(cost.priceMatchBasis, "official"); assert.equal(cost.coverage, "complete");
    assert.equal(usage.model, model); assert.equal(usage.provider, "reseller-token-plan");
  }
  assert.deepEqual(pricing.status().configuration, { overrides: [], mappings: [] });
});

test("大小写、分隔符和 Claude 名称顺序可匹配，日期与功能变体不丢失", async t => {
  const catalog = {
    anthropic: { models: { "claude-sonnet-77-6": { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } },
    minimax: { models: { "MiniMax-M77.5": { cost: { input: 0.3, output: 1.2, cache_read: 0.03, cache_write: 0.375 } } } },
    openrouter: { models: { "deepseek/deepseek-v77-flash-0731": { cost: { input: 0.02, output: 0.6, cache_read: 0.01, cache_write: 0.02 } } } },
  };
  const pricing = new PricingService(workspace(t), { fetch: async () => Response.json(catalog), now: () => new Date(date) });
  await pricing.refresh();
  for (const model of ["gateway/claude-77.6-sonnet", "other/CLAUDE_SONNET_77_6"]) {
    const cost = pricing.estimate(request({ model }));
    assert.equal(cost.priceProvider, "anthropic"); assert.equal(cost.priceModel, "claude-sonnet-77-6");
    assert.equal(cost.priceMatchBasis, "official"); assert.equal(cost.amount, 0.00039975);
  }
  assert.equal(pricing.estimate(request({ model: "route/minimax-m77-5" })).priceModel, "MiniMax-M77.5");
  const dated = pricing.estimate(request({ model: "route/deepseek-v77-flash-0731" }));
  assert.equal(dated.priceProvider, "openrouter"); assert.equal(dated.priceModel, "deepseek/deepseek-v77-flash-0731");
  assert.equal(dated.priceMatchBasis, "catalog"); assert.equal(dated.amount, 0.0000078);
  for (const model of ["route/claude-77.7-sonnet", "route/claude-77.6-sonnet-thinking", "route/deepseek-v77-flash-0801", "route/minimax-m77-5-highspeed"]) {
    assert.equal(pricing.estimate(request({ model })).amount, null, model);
  }
});

test("自动匹配不写入配置，手动映射与任意单价优先并可恢复自动", async t => {
  const catalog = {
    openai: { models: { "gpt-synthetic-7": { cost: { input: 2, output: 5, cache_read: 0.1, cache_write: 1 } } } },
    alternate: { models: { "user-target": { cost: { input: 4, output: 10, cache_read: 0.2, cache_write: 2 } } } },
  };
  const pricing = new PricingService(workspace(t), { fetch: async () => Response.json(catalog), now: () => new Date(date) });
  await pricing.refresh();
  const usage = request({ model: "plan/gpt-synthetic-7", provider: "token-plan" }), original = pricing.version();
  pricing.configure({ overrides: [], mappings: [{ model: usage.model!, targetProvider: "alternate", targetModel: "user-target" }] });
  assert.equal(pricing.estimate(usage).amount, 0.000414); assert.notEqual(pricing.version(), original);
  pricing.configure({ ...pricing.status().configuration, overrides: [{ model: usage.model!, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }] });
  assert.equal(pricing.estimate(usage).amount, 0); assert.equal(pricing.estimate(usage).priceBasis, "manual");
  await pricing.refresh(true); assert.equal(pricing.estimate(usage).amount, 0);
  pricing.configure({ overrides: [], mappings: [] });
  assert.equal(pricing.estimate(usage).amount, 0.000207); assert.equal(pricing.version(), original);
  const missing = request({ ...usage, cacheWriteTokens: undefined });
  const partial = pricing.estimate(missing, "codeflicker");
  assert.equal(partial.coverage, "partial"); assert.equal(partial.reason, "tokens_missing");
  assert.equal(missing.cacheWriteTokens, undefined);
  assert.equal(createPricingEstimator(pricing.status())(usage).price, undefined);
  assert.equal(createPricingEstimator(pricing.status())(usage).priceModel, "gpt-synthetic-7");
});

test("自动匹配按请求时间选择原厂历史价格，官方零单价仍优先于付费转售", async t => {
  const catalog = {
    openai: { models: { "gpt-synthetic-7": { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } } },
    reseller: { models: { "gpt-synthetic-7": { cost: { input: 9, output: 18, cache_read: 1, cache_write: 9 } } } },
  };
  const history = [{ id: "openai", models: [{ id: "gpt-synthetic-7", prices: [
    { constraint: { start_date: "2026-01-01" }, prices: { input_mtok: 1, output_mtok: 2, cache_read_mtok: 0.1, cache_write_mtok: 1 } },
    { constraint: { start_date: "2026-06-01" }, prices: { input_mtok: 2, output_mtok: 4, cache_read_mtok: 0.1, cache_write_mtok: 1 } },
  ] }] }];
  const pricing = new PricingService(workspace(t), { fetch: async url => Response.json(url === historicalPriceSourceUrl ? history : catalog), now: () => new Date(date) });
  await pricing.refresh();
  const usage = request({ model: "reseller/gpt-synthetic-7", provider: "reseller" });
  assert.equal(pricing.estimate({ ...usage, occurredAt: "2026-05-31T23:59:59.999Z" }).amount, 0.000102);
  const latest = pricing.estimate({ ...usage, occurredAt: "2026-06-01T00:00:00.000Z" });
  assert.equal(latest.amount, 0.000197); assert.equal(latest.priceBasis, "historical"); assert.equal(latest.priceMatchBasis, "official");
  const snapshot = pricing.estimate({ ...usage, occurredAt: undefined });
  assert.equal(snapshot.amount, 0); assert.equal(snapshot.priceProvider, "openai"); assert.equal(snapshot.coverage, "complete");
});

test("同一官方服务商的标准化名称仍有多个候选时保留未匹配", async t => {
  const catalog = { openai: { models: {
    "gpt-synthetic-7.1": { cost: { input: 1, output: 2 } },
    "gpt-synthetic-7_1": { cost: { input: 8, output: 9 } },
  } } };
  const pricing = new PricingService(workspace(t), { fetch: async () => Response.json(catalog), now: () => new Date(date) });
  await pricing.refresh();
  assert.equal(pricing.estimate(request({ model: "route/GPT-SYNTHETIC-7-1" })).amount, null);
  assert.equal(pricing.estimate(request({ model: "route/gpt-synthetic-7.1" })).price?.input, 1);
});

test("Claude 名称顺序转换保留日期及功能后缀，只采用同一变体", async t => {
  const catalog = { anthropic: { models: {
    "claude-sonnet-77-6-20261001-thinking": { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
  } } };
  const pricing = new PricingService(workspace(t), { fetch: async () => Response.json(catalog), now: () => new Date(date) });
  await pricing.refresh();
  const cost = pricing.estimate(request({ model: "gateway/Claude-77.6-Sonnet-20261001-thinking" }));
  assert.equal(cost.priceModel, "claude-sonnet-77-6-20261001-thinking");
  assert.equal(cost.amount, 0.00039975);
  assert.equal(pricing.estimate(request({ model: "gateway/claude-77.6-sonnet-20261002-thinking" })).amount, null);
  assert.equal(pricing.estimate(request({ model: "gateway/claude-77.6-sonnet-20261001" })).amount, null);
});

test("自动目录中有免费和普通同名条目时采用普通 API 基准，手动免费映射仍有效", async t => {
  const catalog = { openai: { models: {
    "gpt-synthetic-7": { cost: { input: 2, output: 5, cache_read: 0.1, cache_write: 1 } },
    "gpt-synthetic-7:free": { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
  } } };
  const pricing = new PricingService(workspace(t), { fetch: async () => Response.json(catalog), now: () => new Date(date) });
  await pricing.refresh();
  const usage = request({ model: "gpt-synthetic-7:free" });
  assert.equal(pricing.estimate(usage).amount, 0.000207);
  pricing.configure({ overrides: [], mappings: [{ model: usage.model!, targetModel: usage.model!, targetProvider: "openai" }] });
  assert.equal(pricing.estimate(usage).amount, 0);
});
