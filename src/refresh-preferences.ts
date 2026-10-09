/** 0 表示关闭；间隔单位为毫秒，前后端共用同一组可选值。 */
export const autoRefreshIntervals = [0, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000] as const;
export type AutoRefreshInterval = typeof autoRefreshIntervals[number];
export const isAutoRefreshInterval = (value: unknown): value is AutoRefreshInterval =>
  typeof value === "number" && autoRefreshIntervals.some(interval => interval === value);

export type RefreshScope = "sessions" | "map";
