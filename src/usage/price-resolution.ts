import type { ModelPrice, PricingConfiguration } from "../usage-contracts.js";

const key = (provider: string, model: string) => `${provider}\0${model}`;

/** 统计和价格管理共享同一解析顺序，原始模型名不会被映射改写。 */
export function createPriceResolver(prices: ModelPrice[], configuration: PricingConfiguration): (model: string) => ModelPrice | undefined {
  const automatic = prices.filter(price => price.source !== "manual");
  const catalog = new Map(automatic.map(price => [key(price.provider, price.model), price]));
  const overrides = new Map(configuration.overrides.map(price => [price.model, price]));
  const mappings = new Map(configuration.mappings.map(mapping => [mapping.model, mapping]));
  const exact = new Map<string, ModelPrice[]>();
  for (const price of automatic) { const matches = exact.get(price.model) ?? []; matches.push(price); exact.set(price.model, matches); }
  const manualPrice = (model: string, provider?: string): ModelPrice | undefined => {
    const manual = overrides.get(model);
    if (!manual || provider !== undefined && manual.provider !== undefined && manual.provider !== provider) return;
    return { ...manual, provider: manual.provider ?? provider ?? "manual", source: "manual" };
  };
  return model => {
    const own = manualPrice(model); if (own) return own;
    const mapping = mappings.get(model);
    if (mapping) return manualPrice(mapping.targetModel, mapping.targetProvider)
      ?? catalog.get(key(mapping.targetProvider, mapping.targetModel));
    const slash = model.indexOf("/");
    if (slash > 0) {
      const provider = model.slice(0, slash), targetModel = model.slice(slash + 1);
      const qualified = manualPrice(targetModel, provider) ?? catalog.get(key(provider, targetModel));
      if (qualified) return qualified;
    }
    const matches = exact.get(model);
    return matches?.length === 1 ? matches[0] : undefined;
  };
}
