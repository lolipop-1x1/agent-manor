import type { ModelPrice, RequestCost } from "../../../src/usage-contracts";
import { Info } from "@phosphor-icons/react";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { useI18n } from "../../shared/i18n";

export function PriceDetails({ price, cost, threshold, catalog = false, container }: { container?: HTMLElement | null; price: ModelPrice; cost?: RequestCost; threshold?: number; catalog?: boolean }) {
  const { t, number, dateTime } = useI18n();
  const basis = cost?.priceBasis ?? (price.source === "manual" ? "manual" : price.priceBasis ?? "current_snapshot");
  const from = cost?.priceEffectiveFrom ?? price.effectiveFrom, to = cost?.priceEffectiveTo ?? price.effectiveTo;
  const sourceUrl = cost?.priceSourceUrl ?? price.sourceUrl;
  const provider = cost?.priceProvider ?? price.provider;
  const model = cost?.priceModel ?? price.model;
  const matchBasis = cost?.priceMatchBasis ?? price.matchBasis;
  const apiBaselineForProvider = cost?.apiBaselineForProvider ?? price.apiBaselineForProvider;
  const rateKeys = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "inputAudio", "outputAudio"] as const;
  const rates = (value: ModelPrice) => rateKeys.filter(key => value[key] !== undefined).map(key => <div key={key}><dt>{t(`usage.pricing.${key}`)}</dt><dd>{number(value[key]!, { maximumFractionDigits: 6 })}</dd></div>);
  return <HelpPopover container={container} label={t(catalog ? "usage.pricing.rules" : "usage.pricing.applied")} trigger={<button className="help-trigger is-icon-only" aria-label={t(catalog ? "usage.pricing.rules" : "usage.pricing.applied")} title={t(catalog ? "usage.pricing.rules" : "usage.pricing.applied")}><Info size={17} aria-hidden="true" /></button>}><div className="usage-price-details">
    <div className="usage-price-basis"><p>{t(`usage.pricing.basis.${basis}`)}</p>{basis !== "manual" && matchBasis && <p>{t(`usage.pricing.match.${matchBasis}`)}</p>}{!catalog && <p>{t("usage.pricing.appliedModel", { provider, model })}</p>}{apiBaselineForProvider && <p>{t("usage.pricing.apiBaseline", { provider: apiBaselineForProvider })}</p>}{basis === "historical" && <p>{t("usage.pricing.effectivePeriod", { from: from ? dateTime(from) : t("usage.pricing.openStart"), to: to ? dateTime(to) : t("usage.pricing.openEnd") })}</p>}</div>
    <p>{basis === "manual" && provider === "manual" ? t("usage.pricing.globalScope") : t("usage.pricing.appliedProvider", { provider })}</p>
    {apiBaselineForProvider && <p>{t("usage.pricing.apiBaselineEvidence", { provider: apiBaselineForProvider })}</p>}
    {sourceUrl && <p><a href={sourceUrl} target="_blank" rel="noreferrer">{t("usage.pricing.source")}</a></p>}
    {price.fetchedAt && <p>{t("usage.pricing.updated", { time: dateTime(price.fetchedAt) })}</p>}
    <p>{t("usage.pricing.rateUnit")}</p>
    {!catalog && threshold !== undefined && <p>{t(threshold === 0 ? "usage.pricing.baseTier" : "usage.pricing.contextThreshold", { ...(threshold === 0 ? {} : { count: threshold }) })}</p>}
    <dl>{rates(price)}</dl>
    {catalog && !!price.tiers?.length && <><p>{t("usage.pricing.tiers", { count: price.tiers.length })}</p>{price.tiers.map(tier => <div key={tier.context}><p>{t("usage.pricing.contextThreshold", { count: tier.context })}</p><dl>{rates({ ...price, ...tier })}</dl></div>)}</>}
  </div></HelpPopover>;
}
