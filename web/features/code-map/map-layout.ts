import { hierarchy, treemap, type HierarchyRectangularNode } from "d3";
import type { FileCoverage } from "../../../src/contracts";
import type { MapNode } from "./model";
import { clipRect, fitCamera, projectRect, zoomCamera, type MapCamera, type MapRect, type MapSize } from "../../shared/map/geometry";

export interface MapTile extends MapRect { path: string; name: string; depth: number; file: FileCoverage }
export interface MapDirectory extends MapRect { path: string; name: string; depth: number }
export interface MapLayout { bounds: MapRect; files: MapTile[]; directories: MapDirectory[]; maxScale: number }
export interface VisibleMapTile { tile: MapTile; rect: MapRect; visible: MapRect }

const worldSize: MapSize = { width: 1000, height: 650 };
const readableSize: MapSize = { width: 160, height: 128 };
const maximumScale = Number.MAX_SAFE_INTEGER / Math.max(worldSize.width, worldSize.height);
const translation = (value: number) => Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, value));
const rect = (node: HierarchyRectangularNode<MapNode>): MapRect => ({ x: node.x0, y: node.y0, width: node.x1 - node.x0, height: node.y1 - node.y0 });

/** 逻辑布局不随视口改变；目录不预留像素间距，避免深层目录吞掉叶子。 */
export function layoutMap(files: FileCoverage[], directory: string): MapLayout {
  const included = files.filter(file => Number.isFinite(file.lineCount) && file.lineCount > 0
    && (!directory || file.path.startsWith(`${directory}/`)));
  const root: MapNode = { name: directory || "整个仓库", path: directory, children: [] };
  const parents = new Map<string, MapNode>([[directory, root]]);
  let largest = 1;
  for (const file of included) largest = Math.max(largest, file.lineCount);
  const total = included.reduce((sum, file) => sum + file.lineCount / largest, 0);
  // 仅在行数比例接近浮点精度边界时保留最小权重；零行文件始终不分配面积。
  const minimumWeight = total * Number.EPSILON * 128;
  for (const file of included) {
    const relative = directory ? file.path.slice(directory.length + 1) : file.path;
    const parts = relative.split("/");
    let parent = root;
    let path = directory;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index]!;
      path = path ? `${path}/${name}` : name;
      if (index === parts.length - 1) parent.children!.push({ name, path, file });
      else {
        let child = parents.get(path);
        if (!child) {
          child = { name, path, children: [] };
          parents.set(path, child);
          parent.children!.push(child);
        }
        parent = child;
      }
    }
  }
  const tree = hierarchy(root).sum(node => node.file ? Math.max(node.file.lineCount / largest, minimumWeight) : 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.data.path.localeCompare(b.data.path));
  const layout = treemap<MapNode>().size([worldSize.width, worldSize.height]).round(false).padding(0)(tree);
  const tiles: MapTile[] = [];
  const directories: MapDirectory[] = [];
  let maxScale = 1;
  layout.eachBefore(node => {
    if (node.data.file) {
      const tile = { ...rect(node), path: node.data.path, name: node.data.name, depth: node.depth, file: node.data.file };
      tiles.push(tile);
      maxScale = Math.max(maxScale, readableSize.width / tile.width, readableSize.height / tile.height);
    } else if (node.depth) directories.push({ ...rect(node), path: node.data.path, name: node.data.name, depth: node.depth });
  });
  return { bounds: { x: 0, y: 0, ...worldSize }, files: tiles, directories, maxScale: Math.min(maximumScale, Math.max(1024, maxScale * 16)) };
}

/** 自动换版保留视口中心的文件与文件内位置；原来适配全图时继续适配。 */
export function refreshCamera(camera: MapCamera, previous: MapLayout, next: MapLayout, viewport: MapSize): MapCamera {
  const beforeFit = fitCamera(previous.bounds, viewport), afterFit = fitCamera(next.bounds, viewport);
  if (Math.abs(camera.scale - beforeFit.scale) < 1e-8 && Math.abs(camera.x - beforeFit.x) < 1 && Math.abs(camera.y - beforeFit.y) < 1) return afterFit;
  const center = { x: (viewport.width / 2 - camera.x) / camera.scale, y: (viewport.height / 2 - camera.y) / camera.scale };
  const anchor = previous.files.find(tile => center.x >= tile.x && center.x <= tile.x + tile.width && center.y >= tile.y && center.y <= tile.y + tile.height);
  const replacement = anchor && next.files.find(tile => tile.path === anchor.path);
  if (!anchor || !replacement) return zoomCamera(camera, 1, { x: viewport.width / 2, y: viewport.height / 2 }, afterFit.scale, next.maxScale);
  const scale = Math.min(next.maxScale, Math.max(afterFit.scale, camera.scale * Math.sqrt(anchor.width * anchor.height / (replacement.width * replacement.height))));
  const x = replacement.x + (center.x - anchor.x) / anchor.width * replacement.width;
  const y = replacement.y + (center.y - anchor.y) / anchor.height * replacement.height;
  return { scale, x: translation(viewport.width / 2 - x * scale), y: translation(viewport.height / 2 - y * scale) };
}

export function visibleTiles(tiles: MapTile[], camera: MapCamera, viewport: MapSize): VisibleMapTile[] {
  const visible: VisibleMapTile[] = [];
  for (const tile of tiles) {
    const projected = projectRect(tile, camera);
    const clipped = clipRect(projected, viewport);
    if (clipped) visible.push({ tile, rect: projected, visible: clipped });
  }
  return visible;
}
