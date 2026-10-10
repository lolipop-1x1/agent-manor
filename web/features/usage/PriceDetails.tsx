import type { ModelPrice } from "../../../src/usage-contracts";
import { useI18n } from "../../shared/i18n";

export function PriceDetails({ price, threshold, catalog = false }: { price: ModelPrice; threshold?: number; catalog?: boolean }) {
  const { t, number } = useI18n();
  const rateKeys = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "inputAudio", "outputAudio"] as const;
  const rates = (value: ModelPrice) => rateKeys.filter(key => value[key] !== undefined).map(key => <div key={key}><dt>{t(`usage.pricing.${key}`)}</dt><dd>{number(value[key]!, { maximumFractionDigits: 6 })}</dd></div>);
  return <details className="usage-price-details"><summary>{t(catalog ? "usage.pricing.rules" : "usage.pricing.applied")}</summary>
    <p>{t("usage.pricing.rateUnit")}</p>
    {!catalog && threshold !== undefined && <p>{t(threshold === 0 ? "usage.pricing.baseTier" : "usage.pricing.contextThreshold", { ...(threshold === 0 ? {} : { count: threshold }) })}</p>}
    <dl>{rates(price)}</dl>
    {catalog && !!price.tiers?.length && <><p>{t("usage.pricing.tiers", { count: price.tiers.length })}</p>{price.tiers.map(tier => <div key={tier.context}><p>{t("usage.pricing.contextThreshold", { count: tier.context })}</p><dl>{rates({ ...price, ...tier })}</dl></div>)}</>}
  </details>;
}
