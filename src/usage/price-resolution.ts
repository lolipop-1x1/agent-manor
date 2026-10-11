import type { ModelPrice, PricingConfiguration } from "../usage-contracts.js";

const key = (provider: string, model: string) => `${provider}\0${model}`;
// 解析口径变化必须使持久费用汇总失效，Token 事实仍可复用。
export const PRICE_RESOLUTION_VERSION = 5;

// 渠道前缀和免费标记不改变 API 估算基准；版本、日期和功能变体仍参与匹配。
function modelSignature(model: string): string {
  const name = model.trim().split("/").at(-1)!.toLowerCase().replace(/(?:[:\-]free)$/, "").replace(/[._\s]+/g, "-");
  return name.replace(/^claude-(\d+)(?:-(\d+))?-(sonnet|opus|haiku)(-.+)?$/, (_all, major, minor, family, suffix) =>
    `claude-${family}-${major}${minor ? `-${minor}` : ""}${suffix ?? ""}`);
}

function officialProviders(model: string): string[] {
  if (/^(?:gpt-|chatgpt-|codex-|o\d+(?:-|$))/.test(model)) return ["openai"];
  if (model.startsWith("claude-")) return ["anthropic"];
  if (model.startsWith("deepseek-")) return ["deepseek"];
  if (model.startsWith("glm-")) return ["zhipuai", "zai"];
  if (model.startsWith("kimi-")) return ["moonshotai", "moonshotai-cn"];
  if (model.startsWith("minimax-")) return ["minimax", "minimax-cn"];
  if (model.startsWith("gemini-")) return ["google"];
  return [];
}

/** 统计和价格管理共享同一解析顺序，原始模型名不会被映射改写。 */
export function createPriceResolver(prices: ModelPrice[], configuration: PricingConfiguration, historicalPrices: ModelPrice[] = []):
  (model: string, provider?: string, occurredAt?: string) => ModelPrice | undefined {
  const automatic = prices.filter(price => price.source !== "manual");
  const catalog = new Map(automatic.map(price => [key(price.provider, price.model), price]));
  const overrides = new Map(configuration.overrides.map(price => [key(price.provider ?? "", price.model), price]));
  const mappings = new Map(configuration.mappings.map(mapping => [mapping.model, mapping]));
  const exact = new Map<string, Set<string>>();
  const history = new Map<string, ModelPrice[]>();
  const signatures = new Map<string, Map<string, Set<string>>>();
  for (const price of historicalPrices) {
    const identity = key(price.provider, price.model), periods = history.get(identity) ?? [];
    periods.push(price); history.set(identity, periods);
  }
  for (const price of [...automatic, ...historicalPrices, ...configuration.overrides.filter(price => price.provider !== undefined)]) {
    const providers = exact.get(price.model) ?? new Set<string>(); providers.add(price.provider!); exact.set(price.model, providers);
    const signature = modelSignature(price.model), candidates = signatures.get(signature) ?? new Map<string, Set<string>>();
    const models = candidates.get(price.provider!) ?? new Set<string>(); models.add(price.model); candidates.set(price.provider!, models); signatures.set(signature, candidates);
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
  const targets = new Map<string, { provider: string; model: string; basis: "official" | "catalog" }[]>();
  const automaticTargets = (model: string) => {
    const cached = targets.get(model); if (cached) return cached;
    const signature = modelSignature(model), originals = officialProviders(signature);
    const result: { provider: string; model: string; basis: "official" | "catalog" }[] = [];
    // 已知模型系列才允许跨渠道采用 API 基准，不模糊猜测任意名称。
    for (const provider of originals.length ? [...originals, "openrouter"] : []) {
      const models = signatures.get(signature)?.get(provider); if (!models) continue;
      const ordinary = [...models].filter(name => !/(?:[:\-]free)$/i.test(name));
      const clean = model.trim().replace(/(?:[:\-]free)$/i, ""), tail = clean.split("/").at(-1)!;
      const target = ordinary.includes(clean) ? clean : ordinary.includes(tail) ? tail : ordinary.length === 1 ? ordinary[0] : undefined;
      if (!target) break;
      result.push({ provider, model: target, basis: provider === "openrouter" ? "catalog" : "official" });
    }
    targets.set(model, result); return result;
  };
  return (model, provider, occurredAt) => {
    const own = manualPrice(model, provider); if (own) return own;
    const mapping = mappings.get(model);
    if (mapping) return selectedPrice(mapping.targetProvider, mapping.targetModel, occurredAt);
    for (const target of automaticTargets(model)) {
      const price = selectedPrice(target.provider, target.model, occurredAt);
      if (price) return { ...price, matchBasis: target.basis,
        ...(provider === "deepseek-official" && target.provider === "deepseek" ? { apiBaselineForProvider: provider } : {}) };
    }
    const slash = model.indexOf("/");
    // 没有同模型 API 基准时保留明确服务商的精确匹配。
    if (provider) {
      const recorded = selectedPrice(provider, model, occurredAt); if (recorded) return recorded;
      const unqualified = slash > 0 && model.slice(0, slash) === provider ? model.slice(slash + 1) : model;
      if (unqualified !== model) { const own = selectedPrice(provider, unqualified, occurredAt); if (own) return own; }
      return undefined;
    }
    if (slash > 0) {
      const qualified = selectedPrice(model.slice(0, slash), model.slice(slash + 1), occurredAt);
      if (qualified) return qualified;
    }
    const providers = exact.get(model);
    return providers?.size === 1 ? selectedPrice(providers.values().next().value!, model, occurredAt) : undefined;
  };
}
