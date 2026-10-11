import type { ModelPrice, ModelPriceRates, PriceSnapshot } from "../usage-contracts.js";
import { priceContentVersion, priceKey, validPriceIdentity, validPriceNumber } from "./price-catalog.js";

export const historicalPriceSourceUrl = "https://raw.githubusercontent.com/pydantic/genai-prices/main/prices/data.json";
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const fields = { input_mtok: "input", output_mtok: "output", cache_read_mtok: "cacheRead", cache_write_mtok: "cacheWrite",
  reasoning_mtok: "reasoning", input_audio_mtok: "inputAudio", output_audio_mtok: "outputAudio" } as const;
const invalid = (): never => { throw new Error("invalid_historical_price_catalog"); };
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

function effectiveDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid();
  const date = `${value}T00:00:00.000Z`;
  if (!instant(date) || new Date(date).toISOString() !== date) return invalid();
  return date;
}

/** 数据源按总输入跨档，对所有 Token 应用单价；历史阈值为严格大于 start。 */
function rates(value: unknown): Pick<ModelPrice, keyof ModelPriceRates | "tiers"> {
  if (!record(value)) return invalid();
  const result: Partial<ModelPriceRates> = {};
  const tiers = new Map<number, Partial<ModelPriceRates> & { context: number }>();
  for (const [raw, field] of Object.entries(fields)) {
    const rate = value[raw]; if (rate === undefined || rate === null) continue;
    const target = field as keyof ModelPriceRates;
    if (validPriceNumber(rate)) { result[target] = rate; continue; }
    if (!record(rate) || !validPriceNumber(rate.base) || !Array.isArray(rate.tiers)) return invalid();
    result[target] = rate.base;
    const seen = new Set<number>();
    for (const tier of rate.tiers) {
      if (!record(tier) || !Number.isSafeInteger(tier.start) || Number(tier.start) < 0
        || Number(tier.start) >= Number.MAX_SAFE_INTEGER || !validPriceNumber(tier.price) || seen.has(Number(tier.start))) return invalid();
      const context = Number(tier.start) + 1, row = tiers.get(context) ?? { context };
      row[target] = tier.price; tiers.set(context, row); seen.add(Number(tier.start));
    }
  }
  if (result.input === undefined || result.output === undefined) return invalid();
  const sorted = [...tiers.values()].sort((left, right) => left.context - right.context);
  // 各分项跨档位置可能不同，每一档必须累积前一档已生效的单价。
  const active: Partial<ModelPriceRates> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const { context, ...changes } = sorted[index]!; Object.assign(active, changes); sorted[index] = { context, ...active };
  }
  return { input: result.input, output: result.output, ...result, ...(sorted.length ? { tiers: sorted } : {}) };
}

/** 明确日期序列保留历史依据；无日期单价只作为当前快照，未支持约束整模型跳过。 */
export function parseHistoricalPriceCatalog(value: unknown, fetchedAt: string): PriceSnapshot {
  if (!Array.isArray(value) || !value.length || !instant(fetchedAt)) return invalid();
  const prices: ModelPrice[] = [], seen = new Set<string>();
  for (const provider of value) {
    if (!record(provider) || !validPriceIdentity(provider.id) || !Array.isArray(provider.models)) return invalid();
    for (const model of provider.models) {
      if (!record(model) || !validPriceIdentity(model.id)) return invalid();
      if (record(model.prices) && model.prices.constraint !== undefined) continue;
      // 嵌入、仅输入和其它计价单位不适用于当前请求费用结构，不能阻断文本目录。
      const entries = record(model.prices) ? [{ prices: model.prices }] : model.prices;
      if (!Array.isArray(entries) || !entries.length) continue;
      if (entries.some(item => record(item) && record(item.prices) && (item.prices.input_mtok == null || item.prices.output_mtok == null))) continue;
      const identity = priceKey({ provider: provider.id, model: model.id });
      if (seen.has(identity)) return invalid();
      seen.add(identity);
      if (entries.some(item => !record(item) || item.constraint !== undefined && (!record(item.constraint)
        || Object.keys(item.constraint).some(key => key !== "start_date")))) continue;
      const periods: { from?: string; price: ModelPrice }[] = [];
      for (const item of entries) {
        if (!record(item)) return invalid();
        const from = record(item.constraint) ? effectiveDate(item.constraint.start_date) : undefined;
        if (periods.length && (from === undefined || periods.at(-1)!.from !== undefined && from <= periods.at(-1)!.from!)) return invalid();
        periods.push({ from, price: { provider: provider.id, model: model.id, ...rates(item.prices),
          source: "network", fetchedAt, sourceUrl: historicalPriceSourceUrl, priceBasis: "historical", ...(from ? { effectiveFrom: from } : {}) } });
      }
      if (!periods.some(period => period.from !== undefined)) {
        prices.push({ ...periods[0]!.price, priceBasis: "current_snapshot" }); continue;
      }
      for (let index = 0; index < periods.length; index += 1) {
        const price = periods[index]!.price, to = periods[index + 1]?.from;
        prices.push({ ...price, ...(to ? { effectiveTo: to } : {}) });
      }
    }
  }
  prices.sort((left, right) => priceKey(left).localeCompare(priceKey(right)) || (left.effectiveFrom ?? "").localeCompare(right.effectiveFrom ?? ""));
  return { version: priceContentVersion(prices), fetchedAt, sourceUrl: historicalPriceSourceUrl, currency: "USD", prices };
}

/** 缓存保存已归一化的历史区间及当前快照；完整校验后才用于估价。 */
export function parseStoredHistoricalPriceSnapshot(value: unknown): PriceSnapshot {
  if (!record(value) || value.sourceUrl !== historicalPriceSourceUrl || value.currency !== "USD"
    || !instant(value.fetchedAt) || !Array.isArray(value.prices)) return invalid();
  const storedPrices = value.prices;
  const models = new Map<string, { id: string; models: { id: string; prices: unknown[] }[] }>();
  const seen = new Set<string>();
  for (const price of storedPrices) {
    if (!record(price) || !validPriceIdentity(price.provider) || !validPriceIdentity(price.model)
      || price.priceBasis !== "historical" && price.priceBasis !== "current_snapshot" || price.sourceUrl !== historicalPriceSourceUrl
      || price.source !== "network" && price.source !== "cache" || price.fetchedAt !== value.fetchedAt
      || price.priceBasis === "current_snapshot" && (price.effectiveFrom !== undefined || price.effectiveTo !== undefined)
      || price.effectiveFrom !== undefined && !instant(price.effectiveFrom)
      || price.effectiveTo !== undefined && !instant(price.effectiveTo)
      || price.effectiveFrom !== undefined && price.effectiveTo !== undefined && price.effectiveFrom >= price.effectiveTo) return invalid();
    const identity = JSON.stringify([price.provider, price.model, price.effectiveFrom ?? ""]);
    if (seen.has(identity)) return invalid(); seen.add(identity);
    if (price.tiers !== undefined) {
      if (!Array.isArray(price.tiers)) return invalid();
      let previous = 0;
      for (const tier of price.tiers) {
        if (!record(tier) || !Number.isSafeInteger(tier.context) || Number(tier.context) <= previous) return invalid();
        let count = 0;
        for (const target of Object.values(fields)) {
          if (tier[target] === undefined) continue;
          if (price[target] === undefined || !validPriceNumber(tier[target])) return invalid();
          count += 1;
        }
        if (!count) return invalid();
        previous = Number(tier.context);
      }
    }
    const provider = models.get(price.provider) ?? { id: price.provider, models: [] };
    let model = provider.models.find(item => item.id === price.model);
    if (!model) { model = { id: price.model, prices: [] }; provider.models.push(model); }
    const raw: Record<string, unknown> = {};
    for (const [field, target] of Object.entries(fields)) {
      if (price[target] === undefined) continue;
      if (!validPriceNumber(price[target])) return invalid();
      const tiers: { start: number; price: number }[] = [];
      if (price.tiers !== undefined) {
        if (!Array.isArray(price.tiers)) return invalid();
        for (const tier of price.tiers) {
          if (!record(tier) || !Number.isSafeInteger(tier.context) || Number(tier.context) < 1) return invalid();
          if (tier[target] === undefined) continue;
          if (!validPriceNumber(tier[target])) return invalid();
          tiers.push({ start: Number(tier.context) - 1, price: tier[target] });
        }
      }
      raw[field] = tiers.length ? { base: price[target], tiers } : price[target];
    }
    if (price.effectiveFrom !== undefined && new Date(price.effectiveFrom).toISOString().slice(0, 10) + "T00:00:00.000Z" !== price.effectiveFrom) return invalid();
    model.prices.push({ ...(price.effectiveFrom ? { constraint: { start_date: price.effectiveFrom.slice(0, 10) } } : {}), prices: raw });
    models.set(provider.id, provider);
  }
  const normalized = storedPrices.length ? parseHistoricalPriceCatalog([...models.values()], value.fetchedAt) :
    { version: priceContentVersion([]), fetchedAt: value.fetchedAt, sourceUrl: historicalPriceSourceUrl, currency: "USD" as const, prices: [] };
  if (normalized.prices.some((price, index) => price.effectiveTo !== storedPrices[index]?.effectiveTo)) return invalid();
  if (value.version !== normalized.version) return invalid();
  return { ...normalized, prices: normalized.prices.map(price => ({ ...price, source: "cache" })) };
}
