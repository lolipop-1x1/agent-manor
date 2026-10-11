import { hierarchy, treemap } from "d3";

export interface AttributionItem { key: string; value: number | null; text: string; title: string }
interface Node { item?: AttributionItem; value?: number; children?: Node[] }
export function attributionTiles(items: AttributionItem[], width: number, height: number) {
  const root = hierarchy<Node>({ children: items.filter(item => item.value !== null && item.value > 0).map(item => ({ item, value: item.value! })) }).sum(node => node.value ?? 0);
  if (!root.value) return [];
  const maximum = Math.max(...root.leaves().map(node => node.value!));
  return treemap<Node>().size([width, height]).round(false)(root).leaves().map(node => ({
    item: node.data.item!, tone: Math.min(4, Math.floor(node.value! / maximum * 4)) as 0 | 1 | 2 | 3 | 4,
    rect: { x: node.x0, y: node.y0, width: node.x1 - node.x0, height: node.y1 - node.y0 },
  }));
}
