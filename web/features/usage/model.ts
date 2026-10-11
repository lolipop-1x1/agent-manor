import type { UsageMetric, UsageQuery, UsageTimeBucket, UsageTotals } from "../../../src/usage-contracts";

export type DateWindow = "today" | "yesterday" | "7" | "14" | "30" | "90" | "all" | "custom";
export interface UsageRoute extends UsageQuery { window: DateWindow; selectedSession?: string; requestPage?: number; chart: "bar" | "line"; attribution: "treemap" | "bar"; timeFrom?: string; timeTo?: string }
const arrayKeys = ["clients", "excludeClients", "projects", "excludeProjects", "models", "excludeModels"] as const;
const numericKeys = ["minTokens", "maxTokens", "minCost", "maxCost"] as const;
const enums = { relationship: ["all", "main", "child"], sessionType: ["all", "interactive", "automation", "fork"], coverage: ["all", "complete", "partial", "missing"], pricing: ["all", "complete", "partial", "missing"], metric: ["tokens", "cost", "requests"], groupBy: ["project", "model", "client"], interval: ["hour", "day", "week", "month"], sort: ["tokens", "cost", "requests", "recent"], direction: ["asc", "desc"] } as const;
export const localDay = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
export function validDay(value: string | null): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00`);
  return Number.isFinite(date.getTime()) && localDay(date) === value ? value : undefined;
}
export function defaultRoute(): UsageRoute { return { window: "30", metric: "tokens", groupBy: "model", interval: "day", page: 1, pageSize: 20, sort: "tokens", direction: "desc", chart: "bar", attribution: "treemap" }; }
export function readUsageRoute(hash: string): UsageRoute {
  const params = new URLSearchParams(hash.startsWith("#usage") ? hash.split("?")[1] : "");
  const route = defaultRoute();
  if (["today", "yesterday", "7", "14", "30", "90", "all", "custom"].includes(params.get("window") ?? "")) route.window = params.get("window") as DateWindow;
  for (const key of arrayKeys) {
    try { const values: unknown = JSON.parse(params.get(key) ?? "[]"); if (Array.isArray(values) && values.every(value => typeof value === "string")) route[key] = [...new Set(values)]; } catch { /* 无效地址字段不污染已知筛选。 */ }
  }
  for (const key of numericKeys) {
    const value = params.get(key); if (value !== null && value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0) route[key] = Number(value);
  }
  for (const [key, choices] of Object.entries(enums)) { const value = params.get(key); if (value && (choices as readonly string[]).includes(value)) Object.assign(route, { [key]: value }); }
  route.from = validDay(params.get("from")); route.to = validDay(params.get("to"));
  const timeFrom = params.get("timeFrom"); const timeTo = params.get("timeTo");
  if (timeFrom && timeTo && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(timeFrom) && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(timeTo) && Number.isFinite(Date.parse(timeFrom)) && Date.parse(timeTo) > Date.parse(timeFrom)) { route.timeFrom = timeFrom; route.timeTo = timeTo; }
  for (const key of ["page", "requestPage"] as const) { const value = Number(params.get(key)); if (Number.isSafeInteger(value) && value > 0) route[key] = value; }
  if ([20, 50, 100].includes(Number(params.get("pageSize")))) route.pageSize = Number(params.get("pageSize"));
  route.version = params.get("version") || undefined; route.priceVersion = params.get("priceVersion") || undefined;
  route.selectedSession = params.get("selectedSession") || undefined;
  if (params.get("chart") === "line") route.chart = "line";
  if (params.get("attribution") === "bar") route.attribution = "bar";
  // 排除优先，防止手工地址把同一项同时放入两个集合。
  for (const [include, exclude] of [["clients", "excludeClients"], ["projects", "excludeProjects"], ["models", "excludeModels"]] as const) route[include] = route[include]?.filter(value => !route[exclude]?.includes(value));
  return route;
}
export function usageAddress(route: UsageRoute): string { return `#usage?${usageParameters(route)}`; }
export function usageParameters(value: object): string {
  const params = new URLSearchParams();
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined && entry !== "" && (!Array.isArray(entry) || entry.length)) params.set(key, Array.isArray(entry) ? JSON.stringify(entry) : String(entry));
  return params.toString();
}
export function usageQuery(route: UsageRoute, version: string, priceVersion: string, now = new Date()): UsageQuery {
  const { window, selectedSession: _selectedSession, requestPage: _requestPage, chart: _chart, attribution: _attribution, timeFrom, timeTo, ...query } = route;
  delete query.from; delete query.to;
  if (window === "custom") { query.from = timeFrom ?? route.from; query.to = timeTo ?? route.to; }
  else if (window !== "all") {
    const end = new Date(now); if (window === "yesterday") end.setDate(end.getDate() - 1);
    const start = new Date(end); if (window !== "today" && window !== "yesterday") start.setDate(start.getDate() - Number(window) + 1);
    query.from = localDay(start); query.to = localDay(end);
  }
  return { ...query, version: route.version ?? version, priceVersion: route.priceVersion ?? priceVersion, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}
export function metricValue(totals: UsageTotals, metric: UsageMetric): number | null { return metric === "cost" ? totals.estimatedCost : metric === "requests" ? totals.requests : totals.tokens; }
export function activeFilterCount(route: UsageRoute): number {
  return arrayKeys.reduce((sum, key) => sum + (route[key]?.length ?? 0), 0) + [route.relationship, route.sessionType, route.coverage, route.pricing].filter(value => value && value !== "all").length + numericKeys.filter(key => route[key] !== undefined).length;
}
/** 组成图仅使用服务端确认互斥的桶，推理已经包含在总输出中。 */
export function composition(totals: UsageTotals) {
  return [{ key: "freshInput", value: totals.freshInputTokens }, { key: "cacheRead", value: totals.cacheReadTokens }, { key: "cacheWrite", value: totals.cacheWriteTokens }, { key: "output", value: totals.outputTokens }];
}
export function compositionIsPartial(totals: UsageTotals): boolean {
  const items = composition(totals);
  return items.some(item => item.value === null) || totals.tokens !== null && items.reduce((sum, item) => sum + (item.value ?? 0), 0) !== totals.tokens;
}

/** 日期统计不纳入无时间请求；空白日仍属于所选日历范围。 */
export function usageDailyMetrics(days: UsageTimeBucket[]) {
  const priced = days.filter(day => day.totals.estimatedCost !== null);
  const cost = priced.reduce((sum, day) => sum + day.totals.estimatedCost!, 0);
  const peak = [...priced].sort((left, right) => right.totals.estimatedCost! - left.totals.estimatedCost! || left.key.localeCompare(right.key))[0];
  return { averageCost: priced.length ? cost / days.length : null, peak,
    activeDays: days.filter(day => day.totals.requests > 0).length };
}
