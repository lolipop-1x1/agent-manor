import { useMemo } from "react";
import { mapTileFillRect, type MapRect, type MapSize } from "./geometry";
import "./map-tile-layer.css";

export type MapTone = 0 | 1 | 2 | 3 | 4 | "missing";
export interface MapColorTile { rect: MapRect; tone: MapTone }

/** 调用方只提供屏幕矩形与色阶，填充间隔和共享边界统一在此绘制。 */
export function MapTileLayer({ tiles, size, className }: { tiles: readonly MapColorTile[]; size: MapSize; className: string }) {
  const paths = useMemo(() => {
    const result = Array.from({ length: 6 }, () => ({ fill: "", border: "" }));
    for (const { rect, tone } of tiles) {
      const path = result[tone === "missing" ? 5 : tone]!;
      const fill = mapTileFillRect(rect);
      path.fill += `M${fill.x},${fill.y}h${fill.width}v${fill.height}h${-fill.width}Z`;
      // 边界沿原始共享边缘绘制，固定 1px；小块不留间隔也不画边界。
      if (fill.width < rect.width) path.border += `M${rect.x},${rect.y}h${rect.width}v${rect.height}h${-rect.width}Z`;
    }
    return result[5]!.fill ? result : result.slice(0, 5);
  }, [tiles]);
  return <svg className={`map-tile-layer ${className}`} width={size.width} height={size.height} aria-hidden="true">
    {paths.map((path, index) => <path key={index} className={`tone-${index === 5 ? "missing" : index}`} fill={index === 5 ? "var(--surface-alt)" : `var(--map-${index})`} d={path.fill} />)}
    {paths.map((path, index) => <path key={`border-${index}`} className="map-boundary" data-tone={index === 5 ? "missing" : index} fill="none" strokeWidth={1}
      stroke={index === 5 ? "var(--near)" : `var(--map-${index}-border)`} strokeDasharray={index === 5 ? "3 2" : undefined} d={path.border} />)}
  </svg>;
}
