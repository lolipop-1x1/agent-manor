import { createHash } from "node:crypto";
import type { ModelPrice, ModelPriceRates, PriceSnapshot } from "../usage-contracts.js";

export const priceSourceUrl = "https://models.dev/api.json";
const fields = { input: "input", output: "output", cache_read: "cacheRead", cache_write: "cacheWrite", reasoning: "reasoning",
  input_audio: "inputAudio", output_audio: "outputAudio" } as const;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const validPriceNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const validPriceIdentity = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 2048
  && !/[\u0000-\u001f]/.test(value);
export const priceKey = (value: Pick<ModelPrice, "provider" | "model">): string => JSON.stringify([value.provider, value.model]);

/** 来源和抓取时间不改变单价内容版本；实际日期仍随每条价格保存。 */
export function priceContentVersion(prices: ModelPrice[]): string {
  return createHash("sha256").update(JSON.stringify(prices.map(({ source: _source, fetchedAt: _date, ...price }) => price)))
    .digest("hex").slice(0, 24);
}

function rates(value: Record<string, unknown>): Partial<ModelPriceRates> {
  const result: Partial<ModelPriceRates> = {};
  for (const [raw, normalized] of Object.entries(fields)) {
    if (value[raw] === undefined) continue;
    if (!validPriceNumber(value[raw])) throw new Error("invalid_price_catalog");
    result[normalized as keyof ModelPriceRates] = value[raw];
  }
  return result;
}

/** 只保存公开计价字段，不保存目录中的凭据环境变量、描述或其他无关内容。 */
export function parsePriceCatalog(value: unknown, fetchedAt: string, source: ModelPrice["source"] = "network"): PriceSnapshot {
  if (!record(value) || !Number.isFinite(Date.parse(fetchedAt))) throw new Error("invalid_price_catalog");
  const prices: ModelPrice[] = [];
  for (const [provider, entry] of Object.entries(value)) {
    if (!validPriceIdentity(provider) || !record(entry) || !record(entry.models)) throw new Error("invalid_price_catalog");
    for (const [model, data] of Object.entries(entry.models)) {
      if (!validPriceIdentity(model) || !record(data)) throw new Error("invalid_price_catalog");
      if (data.cost === undefined) continue;
      if (!record(data.cost)) throw new Error("invalid_price_catalog");
      const cost = rates(data.cost);
      if (cost.input === undefined || cost.output === undefined) throw new Error("invalid_price_catalog");
      const tiers: NonNullable<ModelPrice["tiers"]> = [];
      if (data.cost.tiers !== undefined) {
        if (!Array.isArray(data.cost.tiers)) throw new Error("invalid_price_catalog");
        for (const item of data.cost.tiers) {
          if (!record(item) || !record(item.tier) || item.tier.type !== "context"
            || !Number.isSafeInteger(item.tier.size) || Number(item.tier.size) < 0) throw new Error("invalid_price_catalog");
          const tierRates = rates(item);
          if (!Object.keys(tierRates).length) throw new Error("invalid_price_catalog");
          tiers.push({ context: Number(item.tier.size), ...tierRates });
        }
      } else if (data.cost.context_over_200k !== undefined) {
        if (!record(data.cost.context_over_200k)) throw new Error("invalid_price_catalog");
        const tierRates = rates(data.cost.context_over_200k);
        if (!Object.keys(tierRates).length) throw new Error("invalid_price_catalog");
        tiers.push({ context: 200_000, ...tierRates });
      }
      tiers.sort((left, right) => left.context - right.context);
      if (tiers.some((tier, index) => index > 0 && tiers[index - 1]!.context === tier.context)) throw new Error("invalid_price_catalog");
      prices.push({ provider, model, ...(validPriceIdentity(data.name) ? { name: data.name } : {}),
        ...cost as ModelPriceRates, ...(tiers.length ? { tiers } : {}), source, fetchedAt });
    }
  }
  if (!prices.length) throw new Error("invalid_price_catalog");
  prices.sort((left, right) => priceKey(left) < priceKey(right) ? -1 : priceKey(left) > priceKey(right) ? 1 : 0);
  return { version: priceContentVersion(prices), fetchedAt, sourceUrl: priceSourceUrl, currency: "USD", prices };
}

/** 磁盘缓存仍进行校验，避免损坏的本地快照取代随包兜底。 */
export function parseStoredPriceSnapshot(value: unknown): PriceSnapshot {
  if (!record(value) || value.sourceUrl !== priceSourceUrl || value.currency !== "USD" || !Array.isArray(value.prices)
    || typeof value.fetchedAt !== "string" || !Number.isFinite(Date.parse(value.fetchedAt)) || !value.prices.length) throw new Error("invalid_price_catalog");
  const prices: ModelPrice[] = [];
  const seen = new Set<string>();
  for (const item of value.prices) {
    if (!record(item) || !validPriceIdentity(item.model) || !validPriceIdentity(item.provider)
      || !validPriceNumber(item.input) || !validPriceNumber(item.output)) throw new Error("invalid_price_catalog");
    const price: ModelPrice = { model: item.model, provider: item.provider, input: item.input, output: item.output, source: "cache",
      fetchedAt: typeof item.fetchedAt === "string" && Number.isFinite(Date.parse(item.fetchedAt)) ? item.fetchedAt : value.fetchedAt };
    if (validPriceIdentity(item.name)) price.name = item.name;
    for (const key of Object.values(fields)) {
      if (item[key] === undefined) continue;
      if (!validPriceNumber(item[key])) throw new Error("invalid_price_catalog");
      price[key] = item[key];
    }
    if (item.tiers !== undefined) {
      if (!Array.isArray(item.tiers)) throw new Error("invalid_price_catalog");
      price.tiers = item.tiers.map(tier => {
        if (!record(tier) || !Number.isSafeInteger(tier.context) || Number(tier.context) < 0) throw new Error("invalid_price_catalog");
        const normalized: Partial<ModelPriceRates> & { context: number } = { context: Number(tier.context) };
        for (const key of Object.values(fields)) {
          if (tier[key] === undefined) continue;
          if (!validPriceNumber(tier[key])) throw new Error("invalid_price_catalog");
          normalized[key] = tier[key];
        }
        if (Object.keys(normalized).length === 1) throw new Error("invalid_price_catalog");
        return normalized;
      }).sort((left, right) => left.context - right.context);
      if (price.tiers.some((tier, index) => index > 0 && price.tiers![index - 1]!.context === tier.context)) throw new Error("invalid_price_catalog");
    }
    const key = priceKey(price);
    if (seen.has(key)) throw new Error("invalid_price_catalog");
    seen.add(key); prices.push(price);
  }
  prices.sort((left, right) => priceKey(left) < priceKey(right) ? -1 : priceKey(left) > priceKey(right) ? 1 : 0);
  return { version: priceContentVersion(prices), fetchedAt: value.fetchedAt, sourceUrl: priceSourceUrl, currency: "USD", prices };
}
