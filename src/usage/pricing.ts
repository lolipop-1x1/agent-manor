import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageDescriptor } from "../i18n/types.js";
import type { SessionUsage } from "../session-contracts.js";
import { ServiceError } from "../service/input.js";
import type { ModelPrice, ModelPriceRates, PriceSnapshot, PricingConfiguration, PricingStatus, PricingSummary, RequestCost } from "../usage-contracts.js";
import { createPriceResolver, PRICE_RESOLUTION_VERSION } from "./price-resolution.js";
import { bundledPriceSnapshot } from "./bundled-prices.js";
import { parsePriceCatalog, parseStoredPriceSnapshot, priceContentVersion, priceKey, priceSourceUrl, validPriceIdentity, validPriceNumber } from "./price-catalog.js";
import { historicalPriceSourceUrl, parseHistoricalPriceCatalog, parseStoredHistoricalPriceSnapshot } from "./historical-prices.js";

const refreshInterval = 24 * 60 * 60 * 1000;
const rateFields = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "inputAudio", "outputAudio"] as const;
const descriptor = (key: string): MessageDescriptor => ({ key: `diagnostics.usage.pricing.${key}` });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): number | undefined => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;

export interface PricingView {
  status: PricingStatus;
  estimate(usage: SessionUsage, client?: string): RequestCost;
}

function validateConfiguration(value: unknown): PricingConfiguration {
  const invalid = () => new ServiceError("INVALID_INPUT", "模型价格配置无效", descriptor("invalidConfiguration"));
  if (!record(value) || Object.keys(value).some(key => key !== "overrides" && key !== "mappings")
    || !Array.isArray(value.overrides) || !Array.isArray(value.mappings)) throw invalid();
  const overrides: PricingConfiguration["overrides"] = [];
  const mappings: PricingConfiguration["mappings"] = [];
  const seenPrices = new Set<string>(); const seenMappings = new Set<string>();
  for (const item of value.overrides) {
    if (!record(item) || !validPriceIdentity(item.model) || seenPrices.has(JSON.stringify([item.provider ?? "", item.model]))
      || item.provider !== undefined && !validPriceIdentity(item.provider)
      || Object.keys(item).some(key => key !== "model" && key !== "provider" && !rateFields.some(field => field === key))
      || !validPriceNumber(item.input) || !validPriceNumber(item.output)) throw invalid();
    const price: PricingConfiguration["overrides"][number] = { model: item.model, input: item.input, output: item.output };
    if (item.provider !== undefined) price.provider = item.provider as string;
    for (const field of rateFields) {
      if (item[field] === undefined) continue;
      if (!validPriceNumber(item[field])) throw invalid();
      price[field] = item[field];
    }
    seenPrices.add(JSON.stringify([price.provider ?? "", price.model])); overrides.push(price);
  }
  for (const item of value.mappings) {
    if (!record(item) || !validPriceIdentity(item.model) || !validPriceIdentity(item.targetModel) || !validPriceIdentity(item.targetProvider)
      || seenMappings.has(item.model) || Object.keys(item).some(key => key !== "model" && key !== "targetModel" && key !== "targetProvider")) throw invalid();
    seenMappings.add(item.model); mappings.push({ model: item.model, targetModel: item.targetModel, targetProvider: item.targetProvider });
  }
  return { overrides, mappings };
}

function save(home: string, name: string, value: unknown): void {
  const path = join(home, name); const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch { throw new ServiceError("INTERNAL_ERROR", "模型价格数据未保存", descriptor("storage")); }
  finally { try { rmSync(temporary, { force: true }); } catch {} }
}

/** 原始输入已归一化为包含缓存的总输入；缺失分项不能直接按零扣减。 */
function inputParts(usage: SessionUsage, client?: string): { input?: number; read?: number; write?: number; fresh?: number; inconsistent: boolean } {
  const input = count(usage.inputTokens);
  const read = count(usage.cachedInputTokens) ?? (input === 0 ? 0 : undefined);
  // Codex 格式没有缓存写入收费桶；其余来源必须以已记录分项为准。
  const write = count(usage.cacheWriteTokens) ?? (client === "codex" || input === 0 ? 0 : undefined);
  const inconsistent = input !== undefined && ((read ?? 0) + (write ?? 0) > input);
  const fresh = !inconsistent && input !== undefined && read !== undefined && write !== undefined ? input - read - write : undefined;
  return { input, read, write, fresh, inconsistent };
}

function requestCost(usage: SessionUsage, price: ModelPrice | undefined, client?: string, includePrice = true): RequestCost {
  const parts = inputParts(usage, client);
  const extra: Partial<RequestCost> = { ...(parts.fresh === undefined ? {} : { freshInputTokens: parts.fresh }),
    ...(price ? { priceBasis: price.source === "manual" ? "manual" : price.priceBasis ?? "current_snapshot", priceProvider: price.provider,
      priceSourceUrl: price.source === "manual" ? undefined : price.sourceUrl ?? priceSourceUrl,
      priceEffectiveFrom: price.effectiveFrom, priceEffectiveTo: price.effectiveTo,
      ...(price.apiBaselineForProvider ? { apiBaselineForProvider: price.apiBaselineForProvider } : {}) } : {}) };
  if (!usage.model) return { amount: null, coverage: "missing", reason: "model_missing", ...extra };
  if (!price) return { amount: null, coverage: "missing", reason: "price_missing", ...extra };
  if (price.tiers?.length && parts.input === undefined) return { amount: null, coverage: "missing", reason: "tier_unknown", ...(includePrice ? { price: structuredClone(price) } : {}), ...extra };
  const tier = price.tiers?.filter(item => parts.input! >= item.context).at(-1);
  const { context: _context, ...tierRates } = tier ?? {};
  const applicable = { ...price, ...tierRates };
  const output = count(usage.outputTokens); const reasoning = count(usage.reasoningOutputTokens);
  let amount = 0; let computed = 0; let missingTokens = false; let missingPrice = false; let ambiguous = parts.inconsistent;
  const add = (tokens: number | undefined, rate: number | undefined) => {
    if (tokens === undefined) { missingTokens = true; return; }
    if (tokens === 0) { computed += 1; return; }
    if (rate === undefined) { missingPrice = true; return; }
    amount += tokens * rate; computed += 1;
  };
  // 没有音频独立用量时，不能用文本单价替代目录中不同的音频单价。
  if (parts.input !== 0 && applicable.inputAudio !== undefined && applicable.inputAudio !== applicable.input) ambiguous = true;
  else if (!parts.inconsistent) {
    add(parts.fresh, applicable.input); add(parts.read, applicable.cacheRead); add(parts.write, applicable.cacheWrite);
  }
  if (output !== 0 && applicable.outputAudio !== undefined && applicable.outputAudio !== applicable.output) ambiguous = true;
  else if (applicable.reasoning !== undefined && applicable.reasoning !== applicable.output) {
    if (output !== undefined && reasoning !== undefined && reasoning <= output) {
      add(output - reasoning, applicable.output); add(reasoning, applicable.reasoning);
    } else if (output === 0) add(0, applicable.output);
    else { missingTokens = true; if (reasoning !== undefined && output !== undefined) ambiguous = true; }
  } else add(output, applicable.output);
  const coverage = !missingTokens && !missingPrice && !ambiguous ? "complete" : computed > 0 ? "partial" : "missing";
  return { amount: computed > 0 ? amount / 1_000_000 : null, coverage, ...(coverage === "complete" ? {} : { reason: ambiguous ? "semantics_unknown" as const : missingTokens ? "tokens_missing" as const : "price_missing" as const }),
    ...(includePrice ? { price: structuredClone(applicable) } : {}), appliedContextThreshold: tier?.context ?? 0, ...extra };
}

/** 后台汇总使用固定价格快照，完整价格证据只在当前页按需附加。 */
export function createPricingEstimator(status: PricingStatus, includePrice = false): PricingView["estimate"] {
  const resolve = createPriceResolver(status.prices, status.configuration, status.historicalPrices);
  return (usage, client) => requestCost(usage, usage.model ? resolve(usage.model, usage.provider, usage.occurredAt) : undefined, client, includePrice);
}

/** 本地配置独立保存，后台刷新只更新自动目录；每次查询使用固定价格视图。 */
export class PricingService {
  private configuration: PricingConfiguration = { overrides: [], mappings: [] };
  private snapshot?: PriceSnapshot;
  private historySnapshot?: PriceSnapshot;
  private historyStatus?: PricingStatus["history"];
  private source: PricingStatus["source"] = "bundled";
  private lastAttemptAt?: string;
  private error?: string;
  private errorDescriptor?: MessageDescriptor;
  private pending?: Promise<PricingStatus>;
  private controller?: AbortController;
  private closed = false;
  private current!: PricingView;
  private readonly versions = new Map<string, PricingView>();
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => Date;

  constructor(private readonly home: string, options: { fetch?: typeof globalThis.fetch; now?: () => Date } = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch; this.now = options.now ?? (() => new Date());
    try { this.configuration = validateConfiguration(JSON.parse(readFileSync(join(home, "usage-pricing.json"), "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.failure("invalidConfiguration", "本地模型价格配置无法读取");
    }
    try {
      this.snapshot = parseStoredPriceSnapshot(JSON.parse(readFileSync(join(home, "usage-price-cache.json"), "utf8")));
      this.source = "cache";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !this.error) this.failure("invalidCatalog", "本地模型价格缓存无效，已使用随包目录");
    }
    try {
      this.historySnapshot = parseStoredHistoricalPriceSnapshot(JSON.parse(readFileSync(join(home, "usage-price-history-cache.json"), "utf8")));
      this.historyStatus = { sourceUrl: historicalPriceSourceUrl, fetchedAt: this.historySnapshot.fetchedAt, source: "cache" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.historyStatus = { sourceUrl: historicalPriceSourceUrl,
        error: "本地历史价格缓存无效，已保留当前快照估算", errorDescriptor: descriptor("invalidCatalog") };
    }
    this.capture();
  }

  private failure(key: string, message: string): void { this.error = message; this.errorDescriptor = descriptor(key); }

  private capture(): void {
    const catalog = new Map(bundledPriceSnapshot.prices.map(price => [priceKey(price), price]));
    for (const price of this.snapshot?.prices ?? []) catalog.set(priceKey(price), price);
    const automatic = [...catalog.values()];
    const historicalPrices = this.historySnapshot?.prices ?? [];
    const resolve = createPriceResolver(automatic, this.configuration, historicalPrices);
    const listed = new Map(catalog);
    for (const price of this.configuration.overrides) {
      const manual: ModelPrice = { ...price, provider: price.provider ?? "manual", source: "manual" }; listed.set(priceKey(manual), manual);
    }
    const prices = [...listed.values()].sort((left, right) => priceKey(left) < priceKey(right) ? -1 : priceKey(left) > priceKey(right) ? 1 : 0);
    const version = createHash("sha256").update(JSON.stringify({ prices: priceContentVersion(prices), history: priceContentVersion(historicalPrices), mappings: this.configuration.mappings,
      resolution: PRICE_RESOLUTION_VERSION })).digest("hex").slice(0, 24);
    const status: PricingStatus = { version, currency: "USD", sourceUrl: priceSourceUrl, source: this.source,
      fetchedAt: this.snapshot?.fetchedAt ?? bundledPriceSnapshot.fetchedAt, lastAttemptAt: this.lastAttemptAt, refreshing: false,
      error: this.error, errorDescriptor: this.errorDescriptor, configuration: structuredClone(this.configuration), prices,
      ...(historicalPrices.length ? { historicalPrices: structuredClone(historicalPrices) } : {}), history: this.historyStatus && structuredClone(this.historyStatus) };
    this.current = { status, estimate: (usage, client) => requestCost(usage, usage.model ? resolve(usage.model, usage.provider, usage.occurredAt) : undefined, client) };
    this.versions.delete(version); this.versions.set(version, this.current);
    // 旧视图只在进程内短期保留；不存在的版本明确失败，不偷偷改成最新单价。
    while (this.versions.size > 8) this.versions.delete(this.versions.keys().next().value!);
  }

  status(): PricingStatus {
    return { ...structuredClone(this.current.status), source: this.source, lastAttemptAt: this.lastAttemptAt, refreshing: !!this.pending,
      error: this.error, errorDescriptor: this.errorDescriptor && { ...this.errorDescriptor } };
  }

  view(version?: string): PricingView {
    const value = version === undefined || version === this.current.status.version ? this.current : this.versions.get(version);
    if (!value) throw new ServiceError("VERSION_NOT_FOUND", "价格版本已不可用，请重新查询", descriptor("versionMissing"));
    return { status: version === undefined || version === this.current.status.version ? this.status() : structuredClone(value.status), estimate: value.estimate };
  }

  estimate(usage: SessionUsage, client?: string): RequestCost { return this.current.estimate(usage, client); }

  version(): string { return this.current.status.version; }

  summary(version?: string): PricingSummary {
    const view = version === undefined || version === this.current.status.version ? this.current : this.versions.get(version);
    if (!view) throw new ServiceError("VERSION_NOT_FOUND", "价格版本已不可用，请重新查询", descriptor("versionMissing"));
    const { configuration: _configuration, prices: _prices, historicalPrices: _history, ...status } = view.status;
    return { ...status, ...(view === this.current ? { source: this.source, lastAttemptAt: this.lastAttemptAt, refreshing: !!this.pending,
      error: this.error, errorDescriptor: this.errorDescriptor && { ...this.errorDescriptor } } : {}) };
  }

  configure(configuration: PricingConfiguration): PricingStatus {
    if (this.closed) throw new ServiceError("INTERNAL_ERROR", "价格服务已关闭", descriptor("closed"));
    const next = validateConfiguration(configuration);
    save(this.home, "usage-pricing.json", next);
    this.configuration = next;
    if (this.errorDescriptor?.key === descriptor("invalidConfiguration").key) { this.error = undefined; this.errorDescriptor = undefined; }
    this.capture(); return this.status();
  }

  refresh(force = false): Promise<PricingStatus> {
    if (this.closed) return Promise.resolve(this.status());
    if (this.pending) return this.pending;
    const now = this.now();
    // 升级后缺少历史目录时允许首次检查；失败后的本次进程仍按检查时间限频。
    const lastCheck = this.lastAttemptAt ?? (this.snapshot && this.historySnapshot ? this.snapshot.fetchedAt : undefined);
    if (!force && lastCheck && now.getTime() - Date.parse(lastCheck) < refreshInterval) return Promise.resolve(this.status());
    this.lastAttemptAt = now.toISOString();
    const controller = new AbortController(); this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000); timeout.unref();
    const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("price_fetch_aborted")), { once: true }));
    const download = async () => {
      let response: Response;
      try {
        response = await this.fetcher(priceSourceUrl, { signal: controller.signal, redirect: "error", credentials: "omit", headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error("price_fetch_failed");
      } catch { throw new ServiceError("INTERNAL_ERROR", "价格目录更新失败，已保留本地价格", descriptor("fetch")); }
      let next: PriceSnapshot;
      try { next = parsePriceCatalog(await response.json(), this.now().toISOString()); }
      catch { throw new ServiceError("INTERNAL_ERROR", "价格目录响应无效，已保留本地价格", descriptor("invalidCatalog")); }
      if (controller.signal.aborted || this.closed) return;
      // 新目录未列出的模型继续使用上次成功价格；每条价格保留自己的获取日期。
      const keys = new Set(next.prices.map(priceKey));
      next.prices.push(...(this.snapshot?.prices ?? []).filter(price => !keys.has(priceKey(price))).map(price => ({ ...price, source: "cache" as const })));
      next.prices.sort((left, right) => priceKey(left) < priceKey(right) ? -1 : priceKey(left) > priceKey(right) ? 1 : 0);
      next.version = priceContentVersion(next.prices);
      save(this.home, "usage-price-cache.json", next);
      this.snapshot = next; this.source = "network";
      if (this.errorDescriptor?.key !== descriptor("invalidConfiguration").key) { this.error = undefined; this.errorDescriptor = undefined; }
    };
    const currentDownload = Promise.race([download(), aborted]).catch(error => {
      if (this.closed) return;
      if (error instanceof ServiceError) { this.error = error.message; this.errorDescriptor = error.messageDescriptor; }
      else this.failure("fetch", "价格目录更新失败，已保留本地价格");
      this.source = this.snapshot ? "cache" : "bundled";
      if (this.snapshot) this.snapshot = { ...this.snapshot, prices: this.snapshot.prices.map(price => ({ ...price, source: "cache" })) };
    });
    const downloadHistory = async () => {
      let response: Response;
      try {
        response = await this.fetcher(historicalPriceSourceUrl, { signal: controller.signal, redirect: "error", credentials: "omit", headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error("price_fetch_failed");
      } catch { throw new ServiceError("INTERNAL_ERROR", "历史价格更新失败，已保留本地价格", descriptor("fetch")); }
      let next: PriceSnapshot;
      try { next = parseHistoricalPriceCatalog(await response.json(), this.now().toISOString()); }
      catch { throw new ServiceError("INTERNAL_ERROR", "历史价格响应无效，已保留本地价格", descriptor("invalidCatalog")); }
      if (controller.signal.aborted || this.closed) return;
      save(this.home, "usage-price-history-cache.json", next);
      this.historySnapshot = next;
      this.historyStatus = { sourceUrl: historicalPriceSourceUrl, fetchedAt: next.fetchedAt, source: "network" };
    };
    const historicalDownload = Promise.race([downloadHistory(), aborted]).catch(error => {
      if (this.closed) return;
      this.historyStatus = { sourceUrl: historicalPriceSourceUrl, fetchedAt: this.historySnapshot?.fetchedAt, ...(this.historySnapshot ? { source: "cache" as const } : {}),
        error: error instanceof ServiceError ? error.message : "历史价格更新失败，已保留本地价格",
        errorDescriptor: error instanceof ServiceError ? error.messageDescriptor : descriptor("fetch") };
      if (this.historySnapshot) this.historySnapshot = { ...this.historySnapshot, prices: this.historySnapshot.prices.map(price => ({ ...price, source: "cache" })) };
    });
    // 两个目录独立保留最后成功版本，统一发布固定视图，网络失败不影响另一目录。
    const operation = Promise.all([currentDownload, historicalDownload]).then(() => { if (!this.closed) this.capture(); })
      .finally(() => { clearTimeout(timeout); this.controller = undefined; this.pending = undefined; });
    this.pending = operation.then(() => this.status());
    return this.pending;
  }

  close(): void { this.closed = true; this.controller?.abort(); }
}
