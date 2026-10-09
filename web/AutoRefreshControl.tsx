import { autoRefreshIntervals, type AutoRefreshInterval, type RefreshScope } from "../src/refresh-preferences";
import { FilterSelect } from "./FilterSelect";
import { useI18n } from "./i18n";

export function AutoRefreshControl({ scope }: { scope: RefreshScope }) {
  const { refreshIntervals, setAutoRefreshInterval, saving, t } = useI18n();
  const label = t(scope === "sessions" ? "common.autoRefresh.sessions" : "common.autoRefresh.map");
  return <div className="auto-refresh-control"><span>{label}</span>
    <FilterSelect label={label} value={String(refreshIntervals[scope])} disabled={saving}
      options={autoRefreshIntervals.map(interval => ({ value: String(interval), label: interval === 0 ? t("common.autoRefresh.off")
        : interval < 60_000 ? t("common.autoRefresh.seconds", { count: interval / 1000 }) : t("common.autoRefresh.minutes", { count: interval / 60_000 }) }))}
      onChange={value => void setAutoRefreshInterval(scope, Number(value) as AutoRefreshInterval)} />
  </div>;
}
