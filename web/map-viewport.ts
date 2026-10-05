import { hierarchy, treemap, type HierarchyRectangularNode } from "d3";
import type { FileCoverage } from "../src/contracts";
import type { MapNode } from "./model";

export interface MapPoint { x: number; y: number }
export interface MapSize { width: number; height: number }
export interface MapRect extends MapPoint, MapSize {}
export interface MapCamera extends MapPoint { scale: number }
export interface MapTile extends MapRect { path: string; name: string; depth: number; file: FileCoverage }
export interface MapDirectory extends MapRect { path: string; name: string; depth: number }
export interface MapLayout { bounds: MapRect; files: MapTile[]; directories: MapDirectory[]; maxScale: number }
export interface VisibleMapTile { tile: MapTile; rect: MapRect; visible: MapRect }

const worldSize: MapSize = { width: 1000, height: 650 };
const readableSize: MapSize = { width: 160, height: 128 };
const maximumScale = Number.MAX_SAFE_INTEGER / Math.max(worldSize.width, worldSize.height);
const positive = (value: number, fallback: number) => Number.isFinite(value) && value > 0 ? value : fallback;
const dimension = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
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

/** 相机平移使用屏幕像素，缩放以给定屏幕焦点为中心。 */
export function zoomCamera(camera: MapCamera, factor: number, focus: MapPoint, minScale: number, maxScale: number): MapCamera {
  if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(focus.x) || !Number.isFinite(focus.y)) return camera;
  const lower = Math.min(maximumScale, positive(minScale, Number.EPSILON));
  const upper = Math.min(maximumScale, Math.max(lower, positive(maxScale, lower)));
  const scale = Math.max(lower, Math.min(upper, camera.scale * factor));
  const ratio = scale / camera.scale;
  return { scale, x: translation(focus.x - (focus.x - camera.x) * ratio), y: translation(focus.y - (focus.y - camera.y) * ratio) };
}

export function panCamera(camera: MapCamera, delta: MapPoint): MapCamera {
  return {
    ...camera,
    x: translation(camera.x + (Number.isFinite(delta.x) ? delta.x : 0)),
    y: translation(camera.y + (Number.isFinite(delta.y) ? delta.y : 0)),
  };
}

export function fitCamera(bounds: MapRect, viewport: MapSize, padding = 12): MapCamera {
  const inset = dimension(padding);
  const scale = Math.min(maximumScale, Math.min(
    Math.max(1, dimension(viewport.width) - inset * 2) / positive(bounds.width, 1),
    Math.max(1, dimension(viewport.height) - inset * 2) / positive(bounds.height, 1),
  ));
  return centerCamera(bounds, viewport, scale);
}

export function locateCamera(bounds: MapRect, viewport: MapSize, minScale: number, maxScale: number, padding = 24): MapCamera {
  const fitted = fitCamera(bounds, viewport, padding);
  const lower = Math.min(maximumScale, positive(minScale, Number.EPSILON));
  const upper = Math.min(maximumScale, Math.max(lower, positive(maxScale, lower)));
  const readable = Math.max(readableSize.width / positive(bounds.width, 1), readableSize.height / positive(bounds.height, 1));
  return centerCamera(bounds, viewport, Math.max(lower, Math.min(upper, Math.max(fitted.scale, readable))));
}

function centerCamera(bounds: MapRect, viewport: MapSize, scale: number): MapCamera {
  return {
    scale,
    x: translation(dimension(viewport.width) / 2 - (bounds.x + bounds.width / 2) * scale),
    y: translation(dimension(viewport.height) / 2 - (bounds.y + bounds.height / 2) * scale),
  };
}

/** 尺寸变化保留视口中心对应的逻辑位置和当前倍率。 */
export function resizeCamera(camera: MapCamera, previous: MapSize, next: MapSize): MapCamera {
  return panCamera(camera, { x: (dimension(next.width) - dimension(previous.width)) / 2, y: (dimension(next.height) - dimension(previous.height)) / 2 });
}

export function projectRect(bounds: MapRect, camera: MapCamera): MapRect {
  return { x: bounds.x * camera.scale + camera.x, y: bounds.y * camera.scale + camera.y, width: bounds.width * camera.scale, height: bounds.height * camera.scale };
}

/** 返回屏幕内可见部分，标签可据此定位，不使用裁剪后的尺寸改变面积。 */
export function clipRect(bounds: MapRect, viewport: MapSize): MapRect | null {
  const x = Math.max(0, bounds.x);
  const y = Math.max(0, bounds.y);
  const right = Math.min(dimension(viewport.width), bounds.x + bounds.width);
  const bottom = Math.min(dimension(viewport.height), bounds.y + bounds.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
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
