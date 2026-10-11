import type { ModelPrice } from "../../../src/usage-contracts";
import type { PriceMatch } from "../../../src/usage/price-resolution";

export interface PriceRow { model: string; provider: string; price?: ModelPrice; resolution?: PriceMatch; manual: boolean; recorded?: boolean; mapped?: boolean }
export type PriceListState = "all" | "unmatched" | "automatic" | "mapping" | "manual";
export type PriceSortKey = "model" | "effective" | "input" | "output" | "cacheRead" | "cacheWrite";
export interface PriceListSort { key: PriceSortKey; direction: "asc" | "desc" }

export function priceRowState(row: PriceRow): Exclude<PriceListState, "all"> | undefined {
  if (row.manual) return "manual";
  if (!row.recorded) return undefined;
  if (!row.price) return "unmatched";
  return row.mapped ? "mapping" : "automatic";
}

export function selectPriceRows(rows: PriceRow[], state: PriceListState, sort: PriceListSort | null): PriceRow[] {
  const selected = rows.filter(row => state === "all" || priceRowState(row) === state);
  if (!sort) return selected;
  const value = (row: PriceRow) => sort.key === "model" ? row.model : sort.key === "effective" ? row.price && `${row.price.provider}/${row.price.model}` : row.price?.[sort.key];
  return selected.sort((left, right) => {
    const a = value(left), b = value(right);
    // 缺失单价始终放在末尾，真实零价参与正常排序。
    if (a === undefined || b === undefined) return a === b ? left.model.localeCompare(right.model) : a === undefined ? 1 : -1;
    const comparison = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
    return comparison ? comparison * (sort.direction === "asc" ? 1 : -1) : left.model.localeCompare(right.model) || left.provider.localeCompare(right.provider);
  });
}
