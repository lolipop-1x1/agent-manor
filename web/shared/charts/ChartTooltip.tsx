import type { ReactNode } from "react";
import "./chart-tooltip.css";

/** 图表明细在选中点的另一侧浮动，不占用图表或正文布局。 */
export function ChartTooltip({ id, position, className = "", children }: { id: string; position: number; className?: string; children: ReactNode }) {
  return <div id={id} role="tooltip" className={`chart-tooltip ${className}`} style={position < .5 ? { right: 8 } : { left: 8 }}>{children}</div>;
}
