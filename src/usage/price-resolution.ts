import type { ModelPrice, PricingConfiguration } from "../usage-contracts.js";

const key = (provider: string, model: string) => `${provider}\0${model}`;
// 解析口径变化必须使持久费用汇总失效，Token 事实仍可复用。
export const PRICE_RESOLUTION_VERSION = 4;

/** 统计和价格管理共享同一解析顺序，原始模型名不会被映射改写。 */
export function createPriceResolver(prices: ModelPrice[], configuration: PricingConfiguration, historicalPrices: ModelPrice[] = []):
  (model: string, provider?: string, occurredAt?: string) => ModelPrice | undefined {
  const automatic = prices.filter(price => price.source !== "manual");
  const catalog = new Map(automatic.map(price => [key(price.provider, price.model), price]));
  const overrides = new Map(configuration.overrides.map(price => [key(price.provider ?? "", price.model), price]));
  const mappings = new Map(configuration.mappings.map(mapping => [mapping.model, mapping]));
  const exact = new Map<string, Set<string>>();
  const history = new Map<string, ModelPrice[]>();
  for (const price of historicalPrices) {
    const identity = key(price.provider, price.model), periods = history.get(identity) ?? [];
    periods.push(price); history.set(identity, periods);
  }
  for (const price of [...automatic, ...historicalPrices, ...configuration.overrides.filter(price => price.provider !== undefined)]) {
    const providers = exact.get(price.model) ?? new Set<string>(); providers.add(price.provider!); exact.set(price.model, providers);
  }
  const manualPrice = (model: string, provider?: string): ModelPrice | undefined => {
    const manual = overrides.get(key("", model)) ?? (provider ? overrides.get(key(provider, model)) : undefined);
    return manual && { ...manual, provider: manual.provider ?? provider ?? "manual", source: "manual" };
  };
  const selectedPrice = (provider: string, model: string, occurredAt?: string): ModelPrice | undefined => {
    const manual = manualPrice(model, provider); if (manual) return manual;
    const time = occurredAt === undefined ? NaN : Date.parse(occurredAt);
    if (Number.isFinite(time)) {
      const dated = history.get(key(provider, model))?.find(price => (price.effectiveFrom === undefined || time >= Date.parse(price.effectiveFrom))
        && (price.effectiveTo === undefined || time < Date.parse(price.effectiveTo)));
      if (dated) return dated;
    }
    return catalog.get(key(provider, model));
  };
  return (model, provider, occurredAt) => {
    const own = manualPrice(model, provider); if (own) return own;
    const mapping = mappings.get(model);
    if (mapping) return selectedPrice(mapping.targetProvider, mapping.targetModel, occurredAt);
    const slash = model.indexOf("/");
    // 来源明确服务商时先精确匹配，未知渠道不能借用其他服务商价格。
    if (provider) {
      const recorded = selectedPrice(provider, model, occurredAt); if (recorded) return recorded;
      const unqualified = slash > 0 && model.slice(0, slash) === provider ? model.slice(slash + 1) : model;
      if (unqualified !== model) { const own = selectedPrice(provider, unqualified, occurredAt); if (own) return own; }
      // 已知内置官方 API 路由允许明确标记的估算基准；可覆盖端点，不能据此认定实际账单。
      if (provider === "deepseek-official") {
        const baselineModel = slash > 0 && model.slice(0, slash) === "deepseek" ? model.slice(slash + 1) : unqualified;
        const baseline = selectedPrice("deepseek", baselineModel, occurredAt);
        if (baseline) return { ...baseline, apiBaselineForProvider: provider };
      }
      return undefined;
    }
    if (slash > 0) {
      const qualified = selectedPrice(model.slice(0, slash), model.slice(slash + 1), occurredAt);
      if (qualified) return qualified;
    }
    // 未声明服务商的标准 OpenAI 名称使用精确原厂条目作为 API 估算基准。
    if (slash < 0 && /^(?:gpt-|chatgpt-|codex-|o\d+(?:-|$))/.test(model)) {
      const original = selectedPrice("openai", model, occurredAt); if (original) return original;
    }
    const providers = exact.get(model);
    return providers?.size === 1 ? selectedPrice(providers.values().next().value!, model, occurredAt) : undefined;
  };
}
