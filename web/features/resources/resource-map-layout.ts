import { hierarchy, treemap, treemapBinary } from "d3";
import type { ResourceMapNode } from "../../../src/resource-service-contracts";
import type { MapCamera, MapPoint, MapRect, MapSize } from "../../shared/map/geometry";
import { fitCamera, mapTileFillRect } from "../../shared/map/geometry";

export interface ResourceMapTile extends MapRect { id: string; node: ResourceMapNode }
export interface ResourceMapLayout { bounds: MapRect; tiles: ResourceMapTile[]; maxScale: number }
/** 局部原点与中心偏移分别保留，避免把极小宽度加到较大世界坐标上丢失精度。 */
export interface ResourceMapCamera extends MapCamera { origin?: MapPoint; offset?: MapPoint }
interface LayoutNode { node?: ResourceMapNode; children?: LayoutNode[] }
const bounds: MapRect = { x: 0, y: 0, width: 1000, height: 650 };
const maximumScale = Number.MAX_VALUE / (4 * Math.max(bounds.width, bounds.height));
const positiveNumber = (value: number, fallback: number) => Number.isFinite(value) && value > 0 ? value : fallback;

/** 只对正值分配原始线性面积；小值排在原点一侧，减少大坐标相减的精度损失。 */
export function layoutResourceMap(nodes: readonly ResourceMapNode[]): ResourceMapLayout {
  const positive = nodes.filter(node => node.value !== null && Number.isFinite(node.value) && node.value > 0);
  if (!positive.length) return { bounds: { ...bounds }, tiles: [], maxScale: 1024 };
  const total = positive.reduce((sum, node) => sum + node.value!, 0);
  const tree = hierarchy<LayoutNode>({ children: positive.map(node => ({ node })) })
    .sum(data => data.node?.value ?? 0)
    .sort((a, b) => (a.value ?? 0) - (b.value ?? 0) || (a.data.node?.id ?? "").localeCompare(b.data.node?.id ?? ""));
  const layout = treemap<LayoutNode>().size([bounds.width, bounds.height]).tile(treemapBinary).round(false).padding(0)(tree);
  let maxScale = 1024;
  const tiles = layout.leaves().map(leaf => {
    const node = leaf.data.node!;
    const area = node.value! / total * bounds.width * bounds.height;
    let width = leaf.x1 - leaf.x0, height = leaf.y1 - leaf.y0;
    // 由真实面积恢复差值精度，不增加统计权重或设置最小面积。
    if (height > 0) width = area / height;
    else if (width > 0) height = area / width;
    else { width = Math.sqrt(area * bounds.width / bounds.height); height = area / width; }
    maxScale = Math.max(maxScale, 160 / width * 16, 128 / height * 16);
    return { id: node.id, node, x: leaf.x0, y: leaf.y0, width, height };
  });
  return { bounds: { ...bounds }, tiles, maxScale: Math.min(maximumScale, maxScale) };
}

/** 间隔在屏幕坐标里扣除，不参与线性布局或占比计算。 */
export function resourceMapScreenRect(tile: ResourceMapTile, camera: ResourceMapCamera): MapRect {
  return mapTileFillRect(resourceMapProjectRect(tile, camera));
}

export function resourceMapProjectRect(rect: MapRect, camera: ResourceMapCamera): MapRect {
  return { x: ((rect.x - (camera.origin?.x ?? 0)) - (camera.offset?.x ?? 0)) * camera.scale + camera.x,
    y: ((rect.y - (camera.origin?.y ?? 0)) - (camera.offset?.y ?? 0)) * camera.scale + camera.y,
    width: rect.width * camera.scale, height: rect.height * camera.scale };
}

/** 用所选资源作局部原点，缩放真实宽高；不受代码地图的绝对坐标上限限制。 */
export function locateResourceMapCamera(rect: MapRect, viewport: MapSize, minScale: number, maxScale: number, padding = 24): ResourceMapCamera {
  const fitted = fitCamera(rect, viewport, padding);
  const lower = positiveNumber(minScale, Number.EPSILON), upper = Math.max(lower, Math.min(maximumScale, positiveNumber(maxScale, lower)));
  const readable = Math.max(160 / positiveNumber(rect.width, 1), 128 / positiveNumber(rect.height, 1));
  return { x: viewport.width / 2, y: viewport.height / 2, scale: Math.max(lower, Math.min(upper, Math.max(fitted.scale, readable))),
    origin: { x: rect.x, y: rect.y }, offset: { x: rect.width / 2, y: rect.height / 2 } };
}

export function zoomResourceMapCamera(camera: ResourceMapCamera, factor: number, focus: MapPoint, minScale: number, maxScale: number): ResourceMapCamera {
  if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(focus.x) || !Number.isFinite(focus.y)) return camera;
  const lower = positiveNumber(minScale, Number.EPSILON), upper = Math.max(lower, Math.min(maximumScale, positiveNumber(maxScale, lower)));
  const scale = Math.max(lower, Math.min(upper, camera.scale * factor)), ratio = scale / camera.scale;
  return { ...camera, scale, x: focus.x - (focus.x - camera.x) * ratio, y: focus.y - (focus.y - camera.y) * ratio };
}

export function panResourceMapCamera(camera: ResourceMapCamera, delta: MapPoint): ResourceMapCamera {
  return { ...camera, x: camera.x + (Number.isFinite(delta.x) ? delta.x : 0), y: camera.y + (Number.isFinite(delta.y) ? delta.y : 0) };
}

export function resizeResourceMapCamera(camera: ResourceMapCamera, previous: MapSize, next: MapSize): ResourceMapCamera {
  return panResourceMapCamera(camera, { x: (next.width - previous.width) / 2, y: (next.height - previous.height) / 2 });
}

/** 命中测试与绘制使用同一局部投影，不把屏幕点转回失去微小偏移的绝对坐标。 */
export function resourceMapTileAt(tiles: readonly ResourceMapTile[], camera: ResourceMapCamera, point: MapPoint): ResourceMapTile | undefined {
  return tiles.find(tile => {
    const rect = resourceMapScreenRect(tile, camera);
    return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
  });
}
