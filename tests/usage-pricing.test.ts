import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionUsage } from "../src/session-contracts.js";
import type { PricingConfiguration } from "../src/usage-contracts.js";
import { bundledPriceSnapshot } from "../src/usage/bundled-prices.js";
import { parsePriceCatalog, priceContentVersion } from "../src/usage/price-catalog.js";
import { createPricingEstimator, PricingService } from "../src/usage/pricing.js";
import { createPriceResolver } from "../src/usage/price-resolution.js";

const date = "2026-10-11T00:00:00.000Z";
const fixture = (cost: Record<string, unknown> = { input: 2, output: 5, cache_read: 0.1, cache_write: 1 }) => ({
  "example-provider": { models: { "example-model": { name: "Example model", cost } } },
});
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const request = (fields: Partial<SessionUsage> = {}): SessionUsage => ({ id: "synthetic-request", model: "example-model", inputTokens: 100,
  outputTokens: 10, cachedInputTokens: 20, cacheWriteTokens: 5, ...fields });
const configuration = (model: string, input = 2, output = 5): PricingConfiguration => ({ overrides: [{ model, input, output, cacheRead: 0.1, cacheWrite: 1 }], mappings: [] });

function workspace(t: { after(fn: () => void): void }): string {
  const home = mkdtempSync(join(tmpdir(), "usage-pricing-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true })); return home;
}

test("后台固定快照估价与完整估价相同，精简结果不复制价格证据", async t => {
  const pricing = new PricingService(workspace(t), { fetch: async () => response(fixture()), now: () => new Date(date) });
  await pricing.refresh();
  pricing.configure({ overrides: [{ model: "custom-model", input: 1, output: 3, cacheRead: 0.2, cacheWrite: 2 }],
    mappings: [{ model: "alias", targetModel: "example-model", targetProvider: "example-provider" }] });
  const view = pricing.view(), full = createPricingEstimator(view.status, true), light = createPricingEstimator(view.status);
  for (const client of ["codex", "claude"]) for (const fields of [
    {}, { model: "custom-model" }, { model: "alias" }, { model: "missing" }, { model: undefined },
    { inputTokens: undefined }, { outputTokens: undefined }, { cacheWriteTokens: undefined }, { cachedInputTokens: undefined },
    { cachedInputTokens: 200 }, { inputTokens: 0, outputTokens: 0 },
  ]) {
    const usage = request(fields), expected = view.estimate(usage, client), { price: _price, ...withoutPrice } = expected;
    assert.deepEqual(full(usage, client), expected);
    assert.deepEqual(light(usage, client), withoutPrice);
  }
  assert.equal(pricing.version(), view.status.version);
  const { configuration: _configuration, prices: _prices, ...summary } = pricing.status();
  assert.deepEqual(pricing.summary(), summary);
});

test("随包价格包含完整公开目录、日期及可用的精确服务商标识", t => {
  const pricing = new PricingService(workspace(t));
  assert.equal(pricing.status().source, "bundled");
  assert.ok(bundledPriceSnapshot.prices.length > 5_000);
  assert.ok(Number.isFinite(Date.parse(bundledPriceSnapshot.fetchedAt!)));
  assert.equal(bundledPriceSnapshot.sourceUrl, "https://models.dev/api.json");
  const price = bundledPriceSnapshot.prices.find(item => item.provider === "openai" && item.model === "gpt-5.4")!;
  assert.ok(price);
  const result = pricing.estimate(request({ model: "openai/gpt-5.4", inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0 }));
  assert.equal(result.coverage, "complete"); assert.equal(result.price?.source, "bundled");
  assert.equal(result.amount, (price.input * 100 + price.output * 10) / 1_000_000);
});

test("任意模型手动价格优先于网络与映射，重启保留，删除覆盖恢复自动价格", async t => {
  const home = workspace(t); const pricing = new PricingService(home, { fetch: async () => response(fixture()), now: () => new Date(date) });
  await pricing.refresh();
  pricing.configure({ overrides: [{ model: "example-model", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
    mappings: [{ model: "example-model", targetModel: "gpt-5.4", targetProvider: "openai" }] });
  assert.equal(pricing.estimate(request()).amount, 0);
  assert.equal(pricing.estimate(request()).price?.source, "manual");
  await pricing.refresh(true);
  assert.equal(pricing.estimate(request()).amount, 0);
  const reopened = new PricingService(home);
  assert.equal(reopened.estimate(request()).amount, 0);
  assert.equal(statSync(join(home, "usage-pricing.json")).mode & 0o777, 0o600);
  reopened.configure({ overrides: [], mappings: [] });
  assert.equal(reopened.estimate(request()).amount, (75 * 2 + 20 * 0.1 + 5 * 1 + 10 * 5) / 1_000_000);
  reopened.configure(configuration("unknown-model", 17, 19));
  assert.equal(reopened.estimate(request({ model: "unknown-model" })).price?.source, "manual");
});

test("同名服务商不混价；用户映射与明确前缀匹配目标，原始模型名保持原文", async t => {
  const catalog = { ...fixture(), other: { models: { "example-model": { cost: { input: 50, output: 100, cache_read: 10, cache_write: 60 } } } } };
  const pricing = new PricingService(workspace(t), { fetch: async () => response(catalog), now: () => new Date(date) });
  await pricing.refresh();
  assert.equal(pricing.estimate(request()).reason, "price_missing");
  assert.equal(pricing.estimate(request()).freshInputTokens, 75);
  assert.equal(pricing.estimate(request({ model: "other/example-model" })).price?.provider, "other");
  pricing.configure({ overrides: [], mappings: [{ model: "example-model", targetModel: "example-model", targetProvider: "example-provider" }] });
  const usage = request(); const result = pricing.estimate(usage);
  assert.equal(result.price?.provider, "example-provider"); assert.equal(result.coverage, "complete");
  assert.equal(usage.model, "example-model");
  pricing.configure({ overrides: [{ model: "target-model", provider: "example-provider", input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }],
    mappings: [{ model: "example-model", targetModel: "target-model", targetProvider: "example-provider" }] });
  assert.equal(pricing.estimate(request()).price?.source, "manual");
  assert.equal(pricing.estimate(request()).amount, 110 / 1_000_000);
});

test("标准 OpenAI 模型以精确原厂价格估算，Codex 缓存分项正常计价", async t => {
  const names = ["gpt-example", "chatgpt-example", "codex-example", "o3-example"];
  const catalog = {
    openai: { models: Object.fromEntries(names.map(model => [model, { cost: { input: 2, output: 5, cache_read: 0.1 } }])) },
    reseller: { models: Object.fromEntries(names.map(model => [model, { cost: { input: 20, output: 50, cache_read: 1 } }])) },
  };
  const pricing = new PricingService(workspace(t), { fetch: async () => response(catalog), now: () => new Date(date) });
  await pricing.refresh();
  for (const model of names) {
    const usage = request({ model, cacheWriteTokens: undefined });
    const result = pricing.estimate(usage, "codex");
    assert.equal(result.price?.provider, "openai"); assert.equal(result.coverage, "complete");
    assert.equal(result.amount, (80 * 2 + 20 * 0.1 + 10 * 5) / 1_000_000);
    assert.equal(pricing.estimate({ ...usage, model: `reseller/${model}` }, "codex").price?.input, 20);
    assert.equal(pricing.estimate({ ...usage, model: `unknown/${model}` }, "codex").amount, null);
    assert.equal(usage.model, model);
  }
  const model = names[0]!;
  pricing.configure({ overrides: [], mappings: [{ model, targetModel: model, targetProvider: "reseller" }] });
  assert.equal(pricing.estimate(request({ model }), "codex").price?.provider, "reseller");
  pricing.configure({ ...pricing.status().configuration, overrides: [{ model, input: 7, output: 9, cacheRead: 0.3 }] });
  assert.equal(pricing.estimate(request({ model }), "codex").price?.source, "manual");
  assert.equal(pricing.estimate(request({ model }), "codex").price?.input, 7);
});

test("原厂基准不猜相似模型、其它系列或无法匹配的服务商", () => {
  const prices = parsePriceCatalog({
    openai: { models: { "gpt-example": { cost: { input: 2, output: 5 } }, "shared-example": { cost: { input: 2, output: 5 } } } },
    reseller: { models: { "gpt-absent": { cost: { input: 20, output: 50 } }, "shared-example": { cost: { input: 20, output: 50 } } } },
    other: { models: { "gpt-absent": { cost: { input: 10, output: 30 } }, "org/model": { cost: { input: 3, output: 8 } } } },
  }, date).prices;
  const resolve = createPriceResolver(prices, { overrides: [], mappings: [] });
  for (const model of ["shared-example", "gpt-absent", "gpt-example-preview", "unknown/gpt-example"]) assert.equal(resolve(model), undefined);
  assert.equal(resolve("reseller/gpt-absent")?.input, 20);
  assert.equal(resolve("org/model")?.provider, "other");
});

test("解析口径升级改变价格版本，避免复用旧的未定价持久汇总", t => {
  const home = workspace(t), pricing = new PricingService(home), status = pricing.status();
  const legacy = createHash("sha256").update(JSON.stringify({ prices: priceContentVersion(status.prices), mappings: status.configuration.mappings })).digest("hex").slice(0, 24);
  assert.notEqual(status.version, legacy);
  assert.equal(new PricingService(home).version(), status.version);
  assert.throws(() => pricing.view(legacy), { code: "VERSION_NOT_FOUND" });
});

test("网络更新逐模型保留旧缓存与随包兜底，并记录各自日期", async t => {
  let now = new Date(date); let catalog: unknown = fixture();
  const home = workspace(t); const pricing = new PricingService(home, { fetch: async () => response(catalog), now: () => now });
  await pricing.refresh();
  now = new Date(now.getTime() + 25 * 60 * 60 * 1000);
  catalog = { "new-provider": { models: { "new-model": { cost: { input: 7, output: 11 } } } } };
  await pricing.refresh();
  const cached = pricing.estimate(request());
  assert.equal(cached.price?.source, "cache"); assert.equal(cached.price?.fetchedAt, date);
  assert.equal(pricing.estimate(request({ model: "new-model", cachedInputTokens: 0, cacheWriteTokens: 0 })).price?.source, "network");
  assert.equal(pricing.estimate(request({ model: "openai/gpt-5.4", cachedInputTokens: 0, cacheWriteTokens: 0 })).price?.source, "bundled");
  const reopened = new PricingService(home);
  assert.equal(reopened.status().source, "cache"); assert.equal(reopened.estimate(request()).price?.fetchedAt, date);
});

test("网络地址固定、不携带历史，24小时复用且并发刷新合并", async t => {
  let calls = 0; let now = new Date(date);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const fetcher: typeof fetch = async (url, options) => {
    calls += 1; assert.equal(url, "https://models.dev/api.json"); assert.equal(options?.method, undefined); assert.equal(options?.body, undefined);
    assert.equal(options?.credentials, "omit"); assert.equal(options?.redirect, "error");
    assert.deepEqual(options?.headers, { Accept: "application/json" }); await gate; return response(fixture());
  };
  const home = workspace(t); const pricing = new PricingService(home, { fetch: fetcher, now: () => now });
  const first = pricing.refresh(); const second = pricing.refresh(true);
  assert.equal(first, second); assert.equal(pricing.status().refreshing, true); release(); await first;
  await pricing.refresh(); assert.equal(calls, 1);
  const reopened = new PricingService(home, { fetch: fetcher, now: () => now });
  await reopened.refresh(); assert.equal(calls, 1);
  now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await reopened.refresh(); assert.equal(calls, 2);
  await reopened.refresh(true); assert.equal(calls, 3);
});

test("HTTP失败、空目录、损坏JSON及无效单价不覆盖成功缓存", async t => {
  let next: () => Response = () => response(fixture());
  const home = workspace(t); const pricing = new PricingService(home, { fetch: async () => next(), now: () => new Date(date) });
  await pricing.refresh(); const valid = readFileSync(join(home, "usage-price-cache.json"), "utf8"); const version = pricing.status().version;
  for (const [produce, reason] of [
    [() => new Response("failure", { status: 503 }), "fetch"],
    [() => response({}), "invalidCatalog"],
    [() => new Response("{invalid"), "invalidCatalog"],
    [() => response(fixture({ input: -1, output: 5 })), "invalidCatalog"],
  ] as const) {
    next = produce; const status = await pricing.refresh(true);
    assert.equal(status.errorDescriptor?.key, `diagnostics.usage.pricing.${reason}`);
    assert.equal(status.version, version); assert.equal(status.source, "cache");
    assert.equal(readFileSync(join(home, "usage-price-cache.json"), "utf8"), valid);
    assert.equal(pricing.estimate(request()).coverage, "complete");
  }
});

test("固定价格视图跨手动配置及网络更新保持原始版本和单价", async t => {
  const pricing = new PricingService(workspace(t), { fetch: async () => response(fixture()), now: () => new Date(date) });
  await pricing.refresh(); const original = pricing.view(); const amount = original.estimate(request()).amount;
  pricing.configure(configuration("example-model", 20, 50));
  assert.notEqual(original.status.version, pricing.status().version);
  assert.equal(original.estimate(request()).amount, amount);
  assert.equal(pricing.view(original.status.version).estimate(request()).amount, amount);
  const status = pricing.status(); status.configuration.overrides[0]!.input = 999; status.prices.length = 0;
  assert.equal(pricing.estimate(request()).price?.input, 20);
  assert.throws(() => pricing.view("unknown-version"), { code: "VERSION_NOT_FOUND", messageDescriptor: { key: "diagnostics.usage.pricing.versionMissing" } });
});

test("档位从指定输入阈值开始；缺输入不依赖输出或错误的context字段猜档位", async t => {
  const pricing = new PricingService(workspace(t), { fetch: async () => response(fixture({ input: 2, output: 5, cache_read: 0.1,
    tiers: [{ tier: { type: "context", size: 100 }, input: 4, output: 10, cache_read: 0.2 }] })), now: () => new Date(date) });
  await pricing.refresh();
  assert.equal(pricing.estimate(request({ inputTokens: 99, cachedInputTokens: 0, cacheWriteTokens: 0 })).appliedContextThreshold, 0);
  assert.equal(pricing.estimate(request({ inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0 })).appliedContextThreshold, 100);
  assert.equal(pricing.estimate(request({ inputTokens: 99, cachedInputTokens: 0, cacheWriteTokens: 0, contextTokens: 999 })).price?.input, 2);
  assert.equal(pricing.estimate(request({ inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, contextTokens: 1 })).amount, 500 / 1_000_000);
  const unknown = pricing.estimate(request({ inputTokens: undefined, contextTokens: 999 }));
  assert.equal(unknown.coverage, "missing"); assert.equal(unknown.amount, null); assert.equal(unknown.reason, "tier_unknown");
});

test("缺缓存分项保留partial及可靠小计，Codex不适用缓存写入与未知价格仍保留普通输入", t => {
  const pricing = new PricingService(workspace(t)); pricing.configure(configuration("example-model"));
  const partial = pricing.estimate(request({ cacheWriteTokens: undefined }), "codeflicker");
  assert.equal(partial.freshInputTokens, undefined); assert.equal(partial.coverage, "partial");
  assert.ok(Math.abs(partial.amount! - 52 / 1_000_000) < 1e-12);
  const complete = pricing.estimate(request({ cacheWriteTokens: undefined }), "codex");
  assert.equal(complete.freshInputTokens, 80); assert.equal(complete.coverage, "complete");
  assert.equal(pricing.estimate(request({ model: "not-priced" })).freshInputTokens, 75);
  assert.equal(pricing.estimate(request({ model: undefined })).reason, "model_missing");
});

test("确认零值不要求缓存单价，非零缺缓存价与缺用量均不伪造完整零费用", t => {
  const pricing = new PricingService(workspace(t)); pricing.configure({ overrides: [{ model: "example-model", input: 2, output: 5 }], mappings: [] });
  const zero = pricing.estimate(request({ inputTokens: 0, outputTokens: 0, cachedInputTokens: undefined, cacheWriteTokens: undefined }));
  assert.equal(zero.amount, 0); assert.equal(zero.coverage, "complete");
  const partial = pricing.estimate(request()); assert.equal(partial.coverage, "partial");
  assert.equal(partial.amount, 200 / 1_000_000);
  assert.equal(partial.reason, "price_missing");
  const missing = pricing.estimate(request({ inputTokens: undefined, outputTokens: undefined, cachedInputTokens: undefined, cacheWriteTokens: undefined }));
  assert.equal(missing.amount, null); assert.equal(missing.coverage, "missing");
  assert.equal(missing.reason, "tokens_missing");
  const contradiction = pricing.estimate(request({ inputTokens: 10, cachedInputTokens: 20, cacheWriteTokens: 0 }));
  assert.equal(contradiction.reason, "semantics_unknown"); assert.equal(contradiction.amount, 50 / 1_000_000);
});

test("推理独立单价只作用于已知推理分项；音频无分项时显示计价限制", t => {
  const pricing = new PricingService(workspace(t));
  pricing.configure({ overrides: [{ model: "example-model", input: 2, output: 5, reasoning: 8, cacheRead: 0.1, cacheWrite: 1 }], mappings: [] });
  const result = pricing.estimate(request({ reasoningOutputTokens: 4 }));
  assert.equal(result.amount, 219 / 1_000_000); assert.equal(result.coverage, "complete");
  assert.equal(pricing.estimate(request()).coverage, "partial");
  pricing.configure({ overrides: [{ model: "example-model", input: 2, output: 5, inputAudio: 10, cacheRead: 0.1, cacheWrite: 1 }], mappings: [] });
  const audio = pricing.estimate(request()); assert.equal(audio.amount, 50 / 1_000_000); assert.equal(audio.reason, "semantics_unknown");
});

test("非法配置拒绝并保持有效设置，损坏本地文件有明确状态且不阻止兜底", t => {
  const home = workspace(t); const pricing = new PricingService(home); pricing.configure(configuration("example-model"));
  const version = pricing.status().version;
  assert.throws(() => pricing.configure(configuration("example-model", -1)), { code: "INVALID_INPUT" });
  assert.throws(() => pricing.configure({ ...configuration("example-model"), overrides: [...configuration("example-model").overrides, ...configuration("example-model").overrides] }), { code: "INVALID_INPUT" });
  assert.equal(pricing.status().version, version);
  writeFileSync(join(home, "usage-pricing.json"), "broken");
  const broken = new PricingService(home);
  assert.equal(broken.status().errorDescriptor?.key, "diagnostics.usage.pricing.invalidConfiguration");
  assert.equal(broken.status().source, "bundled");
});

test("关闭价格服务会取消悬挂刷新，晚到响应不写入缓存", async t => {
  let resolve!: (value: Response) => void; let signal: AbortSignal | undefined;
  const home = workspace(t);
  const pricing = new PricingService(home, { fetch: async (_url, options) => { signal = options?.signal ?? undefined; return new Promise<Response>(release => { resolve = release; }); }, now: () => new Date(date) });
  const refresh = pricing.refresh(); pricing.close();
  await refresh; assert.equal(signal?.aborted, true); assert.equal(pricing.status().refreshing, false);
  resolve(response(fixture())); await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => readFileSync(join(home, "usage-price-cache.json")), { code: "ENOENT" });
  assert.throws(() => pricing.configure(configuration("example-model")), { messageDescriptor: { key: "diagnostics.usage.pricing.closed" } });
});

test("目录保留多档上下文、音频和推理价格；重复档位拒绝", () => {
  const parsed = parsePriceCatalog(fixture({ input: 1, output: 2, input_audio: 5, output_audio: 10, reasoning: 3,
    tiers: [{ tier: { type: "context", size: 20 }, input: 4 }, { tier: { type: "context", size: 10 }, input: 2 }] }), date);
  assert.equal(parsed.prices[0]?.inputAudio, 5); assert.equal(parsed.prices[0]?.outputAudio, 10); assert.equal(parsed.prices[0]?.reasoning, 3);
  assert.deepEqual(parsed.prices[0]?.tiers?.map(tier => tier.context), [10, 20]);
  assert.throws(() => parsePriceCatalog(fixture({ input: 1, output: 2, tiers: [
    { tier: { type: "context", size: 10 }, input: 2 }, { tier: { type: "context", size: 10 }, input: 4 },
  ] }), date));
});

test("目录与请求共享有效模型解析，映射原模型显示目标价格且任意覆盖优先", async t => {
  const pricing = new PricingService(workspace(t), { fetch: async () => response(fixture()), now: () => new Date(date) });
  await pricing.refresh();
  pricing.configure({ overrides: [], mappings: [{ model: "original-model", targetProvider: "example-provider", targetModel: "example-model" }] });
  let status = pricing.status();
  let resolve = createPriceResolver(status.prices, status.configuration);
  assert.equal(resolve("original-model")?.model, "example-model");
  assert.deepEqual(resolve("original-model"), pricing.estimate(request({ model: "original-model" })).price);
  pricing.configure({ ...status.configuration, overrides: [{ model: "original-model", input: 17, output: 19 }] });
  status = pricing.status(); resolve = createPriceResolver(status.prices, status.configuration);
  assert.equal(resolve("original-model")?.source, "manual"); assert.equal(resolve("original-model")?.input, 17);
  await pricing.refresh(true); status = pricing.status();
  assert.equal(createPriceResolver(status.prices, status.configuration)("original-model")?.input, 17);
  pricing.configure({ overrides: [], mappings: [{ model: "original-model", targetProvider: "missing-provider", targetModel: "example-model" }] });
  status = pricing.status();
  assert.equal(createPriceResolver(status.prices, status.configuration)("original-model"), undefined);
});
