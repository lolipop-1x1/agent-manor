import { WarningCircle } from "@phosphor-icons/react";
import { useI18n } from "../../shared/i18n";
import { overviewCostState } from "./model";

export function CostAmount({ value, coverage }: { value: number | null | undefined; coverage?: "complete" | "partial" | "missing" }) {
  const { t, number } = useI18n();
  const state = overviewCostState(value, coverage);
  const amount = state.amount == null ? "—" : number(state.amount, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", maximumFractionDigits: 2 });
  return <span className="overview-cost-value" title={t(state.label)} aria-label={t("overview.metric.costValue", { label: t(state.label), value: amount })}>{amount}{state.partial && <WarningCircle size={14} aria-hidden="true" />}</span>;
}
