import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { hierarchy, treemap, type HierarchyRectangularNode } from "d3";
import { CaretRight, Folder } from "@phosphor-icons/react";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { FileCoverage } from "../src/contracts";
import { fmt, mapTree, metricNames, metricValue, percent, type MapNode, type Metric } from "./model";

export function Hint({ label, children }: { label: string; children: ReactNode }) {
  return <Tooltip.Root><Tooltip.Trigger asChild>{children}</Tooltip.Trigger><Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={6}>{label}<Tooltip.Arrow /></Tooltip.Content></Tooltip.Portal></Tooltip.Root>;
}

export function CodeMap({ files, directory, metric, selected, browse, select }: {
  files: FileCoverage[]; directory: string; metric: Metric; selected: string | null;
  browse: (directory: string) => void; select: (path: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 700, height: 450 });
  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(host.current!);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(() => treemap<MapNode>().size([size.width, size.height]).paddingOuter(4).paddingInner(3)
    .paddingTop(node => node.depth === 1 && node.children ? 29 : 3).round(true)(
      hierarchy(mapTree(files, directory)).sum(node => node.file?.lineCount ?? 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
    ), [files, directory, size]);
  const maxCount = Math.max(1, ...files.map(file => metricValue(file, "activity")));
  const position = (node: HierarchyRectangularNode<MapNode>): CSSProperties => ({ left: node.x0, top: node.y0, width: Math.max(0, node.x1 - node.x0), height: Math.max(0, node.y1 - node.y0) });
  return <div ref={host} className="code-map" role="group" aria-label="文件行数决定面积的代码活动地图">
    {layout.children?.filter(node => node.children).map(node => <button key={node.data.path} className="map-directory" style={{ left: node.x0 + 8, top: node.y0 + 5, maxWidth: Math.max(0, node.x1 - node.x0 - 12) }} onClick={() => browse(node.data.path)} aria-label={`进入目录 ${node.data.path}`}><Folder size={13} /><span>{node.data.name}</span><CaretRight size={12} /></button>)}
    {layout.leaves().filter(node => node.data.file).map(node => {
      const file = node.data.file!;
      const value = metricValue(file, metric);
      const ratio = metric === "activity" ? value / maxCount : value / file.lineCount;
      const tone = value === 0 ? 0 : Math.min(4, Math.ceil(ratio * 4));
      const near = metric === "edit" ? file.editNearLines : file.readNearLines;
      const valueLabel = metric === "activity" ? `${fmt(value)} 次` : percent(value, file.lineCount);
      const label = `${file.path}，${metricNames[metric]} ${valueLabel}，${fmt(file.lineCount)} 行${metric !== "activity" && near ? `，另有 ${near} 行近似` : ""}`;
      const roomy = node.x1 - node.x0 > 120 && node.y1 - node.y0 > 75;
      return <Hint key={file.path} label={label}><button className={`map-file tone-${tone}${selected === file.path ? " selected" : ""}${metric !== "activity" && near ? " has-near" : ""}`} style={position(node)} onClick={() => select(file.path)} aria-label={label}>
        <span className="tile-name">{node.data.name}</span>{roomy && <><strong>{valueLabel}</strong><span className="tile-meta">{fmt(file.lineCount)} 行{metric !== "activity" && near > 0 && <em>+{fmt(near)} 近似</em>}</span></>}
      </button></Hint>;
    })}
  </div>;
}
