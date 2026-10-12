import { line, tickStep } from "d3";
import type { UsageTotals } from "../../../src/usage-contracts";
import { localDay } from "../usage/model";
import { overviewCalendarDate, type OverviewRoute } from "./model";

export interface TrendBucket { from: string; to: string; value: number | null; partial?: boolean }

export function trendBuckets(days: { key: string; totals: Pick<UsageTotals, "tokens" | "estimatedCost" | "requests">
  & Partial<Pick<UsageTotals, "partialTokenRequests" | "missingTokenRequests" | "partiallyPricedRequests" | "unpricedRequests">> }[], interval: OverviewRoute["interval"], metric: OverviewRoute["metric"]): TrendBucket[] {
  const groups = new Map<string, TrendBucket>();
  for (const day of days) {
    const d = overviewCalendarDate(day.key);
    if (interval === "week") d.setDate(d.getDate() - (d.getDay() + 6) % 7);
    const key = interval === "month" ? day.key.slice(0, 7) : interval === "week" ? localDay(d) : day.key;
    const value = metric === "tokens" ? day.totals.tokens : metric === "cost" ? day.totals.estimatedCost : day.totals.requests;
    const partial = value === null || (metric === "tokens" ? (day.totals.partialTokenRequests ?? 0) + (day.totals.missingTokenRequests ?? 0)
      : metric === "cost" ? (day.totals.partiallyPricedRequests ?? 0) + (day.totals.unpricedRequests ?? 0) : 0) > 0;
    const group = groups.get(key);
    if (group) { group.to = day.key; if (value !== null) group.value = (group.value ?? 0) + value; if (partial) group.partial = true; }
    else groups.set(key, { from: day.key, to: day.key, value, ...(partial ? { partial: true } : {}) });
  }
  return [...groups.values()];
}

export function trendAxis(maximum: number, integer: boolean) {
  const max = maximum > 0 ? Math.max(integer ? 1 : 0, maximum) : 1, step = Math.max(integer ? 1 : 0, tickStep(0, max, 4));
  const count = Math.ceil(max / step);
  return { max: count * step, ticks: Array.from({ length: count + 1 }, (_, index) => index * step) };
}

export const trendDisplay = (interval: OverviewRoute["interval"], count: number, width: number) => interval === "day" && width / Math.max(1, count) < 4 ? "line" : "bar";

export function trendDateTicks(buckets: TrendBucket[], width: number): number[] {
  if (!buckets.length) return [];
  if (buckets.length === 1) return [0];
  const last = buckets.length - 1, capacity = Math.max(2, Math.floor(width / 90));
  const months = buckets.flatMap((bucket, index) => index > 0 && index < last && bucket.from.slice(0, 7) !== buckets[index - 1]!.from.slice(0, 7) ? [index] : []);
  const candidates = months.length ? months : Array.from({ length: Math.min(last - 1, capacity - 2) }, (_, index) => Math.round((index + 1) * last / (capacity - 1)));
  const gap = 90 / width * buckets.length, selected = [0];
  for (const index of candidates) if (selected.length < capacity - 1 && index - selected.at(-1)! >= gap * (selected.length === 1 ? 1.25 : 1)
    && last - index >= gap * 1.25) selected.push(index);
  return [...selected, last];
}

/** 绘图区的边缘也能准确选择第一及最后一个日期。 */
export function trendBucketAt(offset: number, width: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.floor(offset / width * count)));
}

export function trendLine(buckets: TrendBucket[], x: (index: number) => number, y: (value: number) => number): string {
  return line<TrendBucket>().defined(bucket => bucket.value !== null).x((_, index) => x(index)).y(bucket => y(bucket.value!))(buckets) ?? "";
}
