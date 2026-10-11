import { useEffect, useMemo, useRef, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { MapTileLayer } from "../../shared/map/MapTileLayer";
import { useI18n } from "../../shared/i18n";
import { attributionTiles, type AttributionItem } from "./treemap";

export function UsageAttribution({ items, total, onGroup, formatValue }: {
  items: AttributionItem[]; total: number | null; onGroup: (key: string) => void; formatValue: (value: number | null) => string;
}) {
  const { t, percent } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const height = 300;
  useEffect(() => {
    const observer = new ResizeObserver(entries => { const value = entries[0]?.contentRect.width; if (value) setWidth(value); });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const tiles = useMemo(() => attributionTiles(items, width, height), [items, width]);
  return <div ref={container} className="usage-attribution-map" role="group" aria-label={t("usage.chart.treemap")}>
    {tiles.length ? <><MapTileLayer tiles={tiles} size={{ width, height }} className="usage-attribution-colors" />
      {tiles.map(({ item, rect, tone }) => <Tooltip.Root key={item.key} delayDuration={0}><Tooltip.Trigger asChild><button type="button" className={`usage-attribution-tile usage-attribution-tone-${tone}`}
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, padding: rect.width <= 38 || rect.height <= 28 ? 0 : undefined }}
        aria-disabled={item.key === "__other"} aria-label={item.title} onClick={() => { if (item.key !== "__other") onGroup(item.key); }}>
        {rect.width > 38 && rect.height > 28 && <>{rect.width > 72 && rect.height > 48 && <span>{item.text}</span>}<strong className={rect.width < 90 || rect.height < 50 ? "is-compact" : undefined}>{total ? percent(item.value! / total) : "—"}</strong>{rect.width > 110 && rect.height > 88 && <em>{formatValue(item.value)}</em>}</>}
      </button></Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip usage-attribution-tooltip" sideOffset={8} collisionPadding={12}>{item.title}<Tooltip.Arrow /></Tooltip.Content></Tooltip.Portal></Tooltip.Root>)}
    </> : <div className="usage-empty">{t("usage.chart.noData")}</div>}
  </div>;
}
