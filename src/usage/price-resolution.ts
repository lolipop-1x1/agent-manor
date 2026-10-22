import type { ModelPrice, PriceResolutionReason, PricingConfiguration } from "../usage-contracts.js";

const key = (provider: string, model: string) => `${provider}\0${model}`;
// 解析口径变化必须使持久费用汇总失效，Token 事实仍可复用。
export const PRICE_RESOLUTION_VERSION = 8;

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

const providerAliases: Record<string, string[]> = {
  tencent: ["tencent-tokenhub"], google: ["google-vertex"], "z-ai": ["zhipuai", "zai"],
  moonshotai: ["moonshotai-cn"], minimax: ["minimax-cn"],
};
const canonicalKey = (identity: string) => `${identity.split("/")[0]!.toLowerCase()}/${modelSignature(identity)}`;
export interface PriceMatch {
  price?: ModelPrice; reason?: PriceResolutionReason; canonicalModelId?: string; candidates: ModelPrice[];
}

/** 先确认标准模型身份，再选择 API 基准；冲突不通过价格高低或目录顺序解决。 */
export function createPriceMatcher(prices: ModelPrice[], configuration: PricingConfiguration, historicalPrices: ModelPrice[] = []):
  (model: string, provider?: string, occurredAt?: string) => PriceMatch {
  const automatic = prices.filter(price => price.source !== "manual");
  const catalog = new Map(automatic.map(price => [key(price.provider, price.model), price]));
  const overrides = new Map(configuration.overrides.map(price => [key(price.provider ?? "", price.model), price]));
  const mappings = new Map(configuration.mappings.map(mapping => [mapping.model, mapping]));
  const exact = new Map<string, Set<string>>();
  const history = new Map<string, ModelPrice[]>();
  const signatures = new Map<string, Map<string, Set<string>>>();
  const identities = new Map<string, Set<string>>();
  const candidates = new Map<string, Map<string, ModelPrice>>();
  for (const price of historicalPrices) {
    if (price.priceBasis === "current_snapshot") {
      if (!catalog.has(key(price.provider, price.model))) catalog.set(key(price.provider, price.model), price);
      continue;
    }
    const identity = key(price.provider, price.model), periods = history.get(identity) ?? [];
    periods.push(price); history.set(identity, periods);
  }
  const configured = configuration.overrides.filter(price => price.provider !== undefined).map(price => ({ ...price, provider: price.provider!, source: "manual" as const }));
  for (const price of [...automatic, ...historicalPrices, ...configured]) {
    const providers = exact.get(price.model) ?? new Set<string>(); providers.add(price.provider!); exact.set(price.model, providers);
    const canonical = "canonicalModelId" in price && typeof price.canonicalModelId === "string" ? price.canonicalModelId : undefined;
    // 目录标准身份可能合并路由别名和收费变体，只采信型号签名一致的身份。
    for (const signature of [modelSignature(price.model)]) {
      const matches = signatures.get(signature) ?? new Map<string, Set<string>>();
      const models = matches.get(price.provider!) ?? new Set<string>(); models.add(price.model); matches.set(price.provider!, models); signatures.set(signature, matches);
      if ("source" in price) {
        const options = candidates.get(signature) ?? new Map<string, ModelPrice>();
        const identity = key(price.provider!, price.model); if (!options.has(identity)) options.set(identity, price);
        candidates.set(signature, options);
      }
      if (canonical && modelSignature(canonical) === signature) {
        const known = identities.get(signature) ?? new Set<string>(); known.add(canonicalKey(canonical)); identities.set(signature, known);
      }
    }
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
  const explicitPrice = (model: string, provider?: string, occurredAt?: string): ModelPrice | undefined => {
    const slash = model.indexOf("/");
    if (!provider) return slash > 0 ? selectedPrice(model.slice(0, slash), model.slice(slash + 1), occurredAt) : undefined;
    const price = selectedPrice(provider, model, occurredAt); if (price) return price;
    const names = signatures.get(modelSignature(model))?.get(provider);
    const ordinary = [...(names ?? [])].filter(name => !/(?:[:\-]free)$/i.test(name));
    return ordinary.length === 1 ? selectedPrice(provider, ordinary[0]!, occurredAt) : undefined;
  };
  // 固定价格视图内复用模型身份和候选，逐请求只选择时间对应的单价。
  const plans = new Map<string, { result: PriceMatch; originals: string[]; targets: { provider: string; model: string }[] }>();
  const automaticPlan = (model: string, provider?: string) => {
    const identity = key(provider ?? "", model), cached = plans.get(identity); if (cached) return cached;
    const signature = modelSignature(model), options = [...(candidates.get(signature)?.values() ?? [])];
    const ids = identities.get(signature);
    const explicit = ids?.has(canonicalKey(model)) ? canonicalKey(model) : undefined;
    const recordedIds = new Set(options.filter(price => price.provider === provider && price.canonicalModelId
      && modelSignature(price.canonicalModelId) === signature).map(price => canonicalKey(price.canonicalModelId!)));
    const canonical = explicit ?? (recordedIds.size === 1 ? [...recordedIds][0] : ids?.size === 1 ? [...ids][0] : undefined);
    const result: PriceMatch = { candidates: options, ...(canonical ? { canonicalModelId: canonical } : {}) };
    if (ids && ids.size > 1 && !canonical) result.reason = "identity_conflict";
    const origin = canonical?.split("/")[0];
    const originals = origin ? [origin, ...(providerAliases[origin] ?? [])] : officialProviders(signature);
    const targets: { provider: string; model: string }[] = [];
    for (const targetProvider of !result.reason && originals.length ? [...originals, "openrouter"] : []) {
      const models = signatures.get(signature)?.get(targetProvider); if (!models) continue;
      const ordinary = [...models].filter(name => !/(?:[:\-]free)$/i.test(name));
      const clean = model.trim().replace(/(?:[:\-]free)$/i, ""), tail = clean.split("/").at(-1)!;
      const target = ordinary.includes(clean) ? clean : ordinary.includes(tail) ? tail : ordinary.length === 1 ? ordinary[0] : undefined;
      if (!target) { if (!targets.length) result.reason = "identity_conflict"; break; }
      targets.push({ provider: targetProvider, model: target });
    }
    const plan = { result, originals, targets }; plans.set(identity, plan); return plan;
  };
  return (model, provider, occurredAt) => {
    const own = manualPrice(model, provider); if (own) return { price: own, candidates: [] };
    const mapping = mappings.get(model);
    if (mapping) {
      const price = selectedPrice(mapping.targetProvider, mapping.targetModel, occurredAt);
      return { price, ...(price ? {} : { reason: "mapping_missing" }), candidates: [] };
    }
    const { result, originals, targets } = automaticPlan(model, provider);
    if (result.reason) {
      const price = explicitPrice(model, provider, occurredAt);
      const { reason: _reason, ...resolved } = result;
      return price ? { ...resolved, price } : result;
    }
    for (const target of targets) {
      const price = selectedPrice(target.provider, target.model, occurredAt);
      if (price) return { ...result, price: { ...price, matchBasis: target.provider === "openrouter" ? "catalog" : "official",
        ...(provider === "deepseek-official" && target.provider === "deepseek" ? { apiBaselineForProvider: provider } : {}) } };
    }
    // 没有同模型 API 基准时保留明确服务商的精确匹配。
    const recorded = explicitPrice(model, provider, occurredAt); if (recorded) return { ...result, price: recorded };
    if (!provider) {
      const providers = exact.get(model);
      if (providers?.size === 1) {
        const price = selectedPrice(providers.values().next().value!, model, occurredAt);
        if (price) return { ...result, price };
      }
    }
    return { ...result, reason: originals.length ? "api_price_missing" : result.candidates.length ? "provider_required" : "model_unknown" };
  };
}

/** 统计与价格管理使用同一个匹配结果，原始模型名和用户配置保持不变。 */
export function createPriceResolver(prices: ModelPrice[], configuration: PricingConfiguration, historicalPrices: ModelPrice[] = []):
  (model: string, provider?: string, occurredAt?: string) => ModelPrice | undefined {
  const match = createPriceMatcher(prices, configuration, historicalPrices);
  return (model, provider, occurredAt) => match(model, provider, occurredAt).price;
}
