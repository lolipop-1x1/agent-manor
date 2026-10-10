import type { ResourceFavoriteProjection } from "../resource-contracts.js";

/** 统计与配置保护保持不变，仅根据当前收藏集合更新派生状态。 */
export function applyResourceFavorites<T extends ResourceFavoriteProjection & { favorite: boolean; protected?: boolean; candidates?: string[] }>(
  row: T, favorites: ReadonlySet<string>): T {
  if (!row.favoriteIds) return row;
  const favorite = row.favoriteIds.some(id => favorites.has(id));
  const included = favorite || (row.localFavoriteIds?.some(id => favorites.has(id)) ?? false);
  return { ...row, favorite,
    ...("protected" in row ? { protected: included || !!row.protectedByConfiguration } : {}),
    ...(row.candidates ? { candidates: included
      ? row.candidates.includes("favorite") ? row.candidates : [...row.candidates, "favorite"]
      : row.candidates.filter(value => value !== "favorite") } : {}) };
}
