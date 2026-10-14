import { autoRefreshIntervals, type AutoRefreshInterval, type RefreshScope } from "../../../src/refresh-preferences";
import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CaretRight, Check } from "@phosphor-icons/react";
import { FilterSelect } from "./FilterSelect";
import { t, useI18n } from "../i18n";

const intervalLabel = (interval: number) => interval === 0 ? t("common.autoRefresh.off")
  : interval < 60_000 ? t("common.autoRefresh.seconds", { count: interval / 1000 }) : t("common.autoRefresh.minutes", { count: interval / 60_000 });

export function AutoRefreshControl({ scope }: { scope: RefreshScope }) {
  const { refreshIntervals, setAutoRefreshInterval, saving, t } = useI18n();
  const label = t(scope === "sessions" ? "common.autoRefresh.sessions" : "common.autoRefresh.map");
  return <div className="auto-refresh-control"><span>{label}</span>
    <FilterSelect label={label} value={String(refreshIntervals[scope])} disabled={saving}
      options={autoRefreshIntervals.map(interval => ({ value: String(interval), label: intervalLabel(interval) }))}
      onChange={value => void setAutoRefreshInterval(scope, Number(value) as AutoRefreshInterval)} />
  </div>;
}

export function AutoRefreshMenu({ scope }: { scope: RefreshScope }) {
  const { refreshIntervals, setAutoRefreshInterval, saving, t } = useI18n();
  const label = t(scope === "sessions" ? "common.autoRefresh.sessions" : "common.autoRefresh.map");
  const [compact, setCompact] = useState(() => matchMedia("(max-width: 599px)").matches);
  useEffect(() => {
    const media = matchMedia("(max-width: 599px)");
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const options = <DropdownMenu.RadioGroup value={String(refreshIntervals[scope])} onValueChange={value => void setAutoRefreshInterval(scope, Number(value) as AutoRefreshInterval)}>
    {autoRefreshIntervals.map(interval => <DropdownMenu.RadioItem className="filter-option" key={interval} value={String(interval)} disabled={saving}>
      {intervalLabel(interval)}<DropdownMenu.ItemIndicator className="filter-check"><Check size={14} aria-hidden="true" /></DropdownMenu.ItemIndicator>
    </DropdownMenu.RadioItem>)}
  </DropdownMenu.RadioGroup>;
  if (compact) return <DropdownMenu.Group className="auto-refresh-inline" aria-label={label}>
    <DropdownMenu.Label className="history-refresh-menu-label">{label}</DropdownMenu.Label>{options}
  </DropdownMenu.Group>;
  return <DropdownMenu.Sub>
    <DropdownMenu.SubTrigger className="filter-option auto-refresh-menu-trigger" aria-label={label} disabled={saving}>
      <span>{label}</span><span className="auto-refresh-menu-value">{intervalLabel(refreshIntervals[scope])}<CaretRight size={12} aria-hidden="true" /></span>
    </DropdownMenu.SubTrigger>
    <DropdownMenu.Portal><DropdownMenu.SubContent className="filter-menu auto-refresh-menu" aria-label={label} sideOffset={4} collisionPadding={12}>
      {options}
    </DropdownMenu.SubContent></DropdownMenu.Portal>
  </DropdownMenu.Sub>;
}
