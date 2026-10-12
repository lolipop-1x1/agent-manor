import * as Tooltip from "@radix-ui/react-tooltip";
import { WarningCircle } from "@phosphor-icons/react";
import { useI18n } from "../../shared/i18n";
import { HelpPopover } from "../../shared/ui/HelpPopover";
import { overviewCostState } from "./model";

export function CostAmount({ value, coverage, onInspect, container }: { value: number | null | undefined; coverage?: "complete" | "partial" | "missing"; onInspect?: () => void; container?: HTMLElement | null }) {
  const { t, number } = useI18n();
  const state = overviewCostState(value, coverage);
  const amount = state.amount == null ? "—" : number(state.amount, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", maximumFractionDigits: 2 });
  const label = t(state.label);
  const amountLabel = t("overview.metric.costValue", { label, value: amount });
  return <span className="overview-cost-value">{onInspect ? <button className="text-button overview-cost-amount" onClick={onInspect} aria-label={amountLabel}>{amount}</button> : <span aria-label={amountLabel}>{amount}</span>}{(state.partial || state.amount == null) && <Tooltip.Root><HelpPopover label={label} container={container}
    trigger={<Tooltip.Trigger asChild><button className="overview-cost-help" type="button" aria-label={label}><WarningCircle size={14} aria-hidden="true" /></button></Tooltip.Trigger>}><p>{t("usage.help.cost")}</p></HelpPopover><Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={5}>{label}</Tooltip.Content></Tooltip.Portal></Tooltip.Root>}</span>;
}
