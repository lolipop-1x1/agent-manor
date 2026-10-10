import type { ResourceLocalRow, ResourceMapSummary, ResourceOverviewSummary } from "../../../src/resource-service-contracts";
import { applyResourceFavorites } from "../../../src/resources/favorites";

export interface PendingFavorite {
  value: boolean;
  removedIds: string[];
}

/** 未完成的操作叠加到服务端收藏集合，旧响应不会覆盖后续点击。 */
export function pendingFavoriteIds(ids: readonly string[], pending: ReadonlyMap<string, PendingFavorite>): Set<string> {
  const favorites = new Set(ids);
  for (const [id, action] of pending) {
    if (action.value) favorites.add(id);
    else for (const removed of action.removedIds) favorites.delete(removed);
  }
  return favorites;
}

export function localFavoriteRow(row: ResourceLocalRow, favorites: ReadonlySet<string>): ResourceLocalRow {
  return { ...applyResourceFavorites(row, favorites), entries: row.entries.map(entry => ({ ...entry,
    favorite: favorites.has(entry.id) || favorites.has(entry.bodyId) })) };
}

export function overviewFavorites<T extends ResourceOverviewSummary>(result: T, favorites: ReadonlySet<string>): T {
  const resources = result.resources.map(row => applyResourceFavorites(row, favorites));
  const delta = resources.reduce((total, row, index) => total + Number(row.candidates.includes("favorite"))
    - Number(result.resources[index]!.candidates.includes("favorite")), 0);
  return { ...result, resources, counts: { ...result.counts, favorite: result.counts.favorite + delta } };
}

export function mapFavorites(result: ResourceMapSummary, favorites: ReadonlySet<string>): ResourceMapSummary {
  const project = (rows: ResourceMapSummary["positive"]) => rows.map(row => applyResourceFavorites(row, favorites));
  return { ...result, positive: project(result.positive), zero: project(result.zero), review: project(result.review) };
}
