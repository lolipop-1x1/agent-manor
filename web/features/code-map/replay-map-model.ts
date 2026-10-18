import type { FileCoverage } from "../../../src/contracts";
import type { ReplayStep } from "../../../src/replay-contracts";
import type { MapLayout, MapTile, VisibleMapTile } from "./map-layout";
import { clipRect, projectRect, type MapCamera, type MapRect, type MapSize } from "../../shared/map/geometry";

export interface ReplayMarker { track: number; kind: string; status: string }
export interface ReplayMapPlayback { visited: ReadonlyMap<string, number>; current: ReadonlyMap<string, ReplayMarker[]> }

/** 只纳入明确文件路径；目录搜索不证明目录内每个文件都有活动。 */
export function replaySessionFiles(files: FileCoverage[], steps: ReplayStep[]): FileCoverage[] {
  const paths = new Set(steps.flatMap(step => step.activities.flatMap(activity => activity.paths)));
  return files.filter(file => paths.has(file.path));
}

export function replayDirectories(files: FileCoverage[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let length = 1; length < parts.length; length += 1) paths.add(parts.slice(0, length).join("/"));
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

/** 并行活动取共同模块；根目录文件或跨模块活动退回共同上级，不任意选择某条轨道。 */
export function replayFollowDirectory(paths: readonly string[], directories: ReadonlySet<string>): string | null {
  if (!paths.length) return null;
  const parents = paths.map(path => path === "." ? [] : (directories.has(path) ? path : path.split("/").slice(0, -1).join("/")).split("/").filter(Boolean));
  const common = [...parents[0]!];
  for (const parent of parents.slice(1)) while (common.length && common.some((part, index) => parent[index] !== part)) common.pop();
  return common.slice(0, 2).join("/");
}

export function replayModuleActivity(path: string, playback: ReplayMapPlayback): { files: number; visited: boolean; markers: ReplayMarker[] } {
  const prefix = `${path}/`;
  const paths = [...playback.current.keys()].filter(value => value === path || value.startsWith(prefix));
  const markers: ReplayMarker[] = [];
  for (const currentPath of paths) for (const marker of playback.current.get(currentPath)!) {
    if (!markers.some(value => value.track === marker.track && value.kind === marker.kind && value.status === marker.status)) markers.push(marker);
  }
  return { files: paths.length, visited: [...playback.visited.keys()].some(value => value === path || value.startsWith(prefix)), markers };
}

/** 缩小时合并拥挤的一级模块；放大后自然展开，逻辑矩形位置保持不变。 */
export function replayCollapsedModules(layout: MapLayout, camera: MapCamera, viewport: MapSize) {
  return layout.directories.filter(directory => directory.depth === 1).flatMap(directory => {
    const children = layout.files.filter(file => file.path.startsWith(`${directory.path}/`));
    const rect = clipRect(projectRect(directory, camera), viewport);
    if (!rect || children.length < 12 || directory.width * directory.height * camera.scale ** 2 / children.length >= 2_200) return [];
    return [{ directory, rect, children }];
  });
}

export interface ReplayCallout { tile: MapTile; rect: MapRect; label: MapRect; markers: ReplayMarker[] }
export function replayCallouts(visible: readonly VisibleMapTile[], playback: ReplayMapPlayback, viewport: MapSize, selected: string | null): ReplayCallout[] {
  const candidates = visible.filter(({ tile }) => playback.current.has(tile.path)).sort((a, b) => {
    if (a.tile.path === selected) return -1;
    if (b.tile.path === selected) return 1;
    const edit = (path: string) => playback.current.get(path)!.some(marker => marker.kind === "edit") ? 1 : 0;
    return edit(b.tile.path) - edit(a.tile.path) || a.tile.path.localeCompare(b.tile.path);
  });
  const width = Math.min(300, Math.max(0, viewport.width - 16));
  const height = 49;
  const placed: ReplayCallout[] = [];
  for (const { tile, visible: rect } of candidates) {
    if (placed.length >= 3 || viewport.height < height + 16 || !width) break;
    const x = Math.max(8, Math.min(viewport.width - width - 8, rect.x + rect.width / 2 - width / 2));
    const above = rect.y - height - 10;
    const preferred = above >= 8 ? above : rect.y + rect.height + 10;
    const positions = [preferred, 8, viewport.height - height - 8, viewport.height / 2 - height / 2];
    const y = positions.map(value => Math.max(8, Math.min(viewport.height - height - 8, value))).find(value => placed.every(other => x + width + 6 <= other.label.x || other.label.x + other.label.width + 6 <= x || value + height + 6 <= other.label.y || other.label.y + other.label.height + 6 <= value));
    if (y === undefined) continue;
    placed.push({ tile, rect, label: { x, y, width, height }, markers: playback.current.get(tile.path)! });
  }
  return placed;
}
