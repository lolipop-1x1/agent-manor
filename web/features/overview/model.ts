import { localDay, validDay } from "../usage/model";

export type OverviewWindow = "365" | "7" | "30" | "90" | "year" | "all" | "custom";
export interface OverviewRoute {
  window: OverviewWindow; from?: string; to?: string; clients?: string[]; projects?: string[]; models?: string[];
  activity: "sessions" | "requests" | "tokens" | "tools";
  metric: "tokens" | "cost" | "requests"; interval: "day" | "week" | "month";
  distribution: "project" | "client" | "model" | "tool";
  process: "failures" | "compressions" | "timing";
  combinationUnit: "session" | "turn";
}
const windows: OverviewWindow[] = ["365", "7", "30", "90", "year", "all", "custom"];
export const defaultOverviewRoute = (): OverviewRoute => ({ window: "365", activity: "sessions", metric: "tokens", interval: "week", distribution: "project", process: "failures", combinationUnit: "session" });
export function readOverviewRoute(hash: string): OverviewRoute {
  const params = new URLSearchParams(hash.startsWith("#overview") ? hash.split("?")[1] : "");
  const route = defaultOverviewRoute();
  if (windows.includes(params.get("window") as OverviewWindow)) route.window = params.get("window") as OverviewWindow;
  route.from = validDay(params.get("from")); route.to = validDay(params.get("to"));
  for (const key of ["clients", "projects", "models"] as const) {
    try { const values: unknown = JSON.parse(params.get(key) ?? "[]"); if (Array.isArray(values) && values.every(value => typeof value === "string")) route[key] = [...new Set(values)]; } catch { /* 无效地址字段不改变筛选。 */ }
  }
  const choices = { activity: ["sessions", "requests", "tokens", "tools"], metric: ["tokens", "cost", "requests"], interval: ["day", "week", "month"], distribution: ["project", "client", "model", "tool"], process: ["failures", "compressions", "timing"], combinationUnit: ["session", "turn"] };
  for (const [key, values] of Object.entries(choices)) if (values.includes(params.get(key) ?? "")) Object.assign(route, { [key]: params.get(key) });
  return route;
}
export function overviewParameters(value: object): string {
  const params = new URLSearchParams();
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined && entry !== "" && (!Array.isArray(entry) || entry.length)) params.set(key, Array.isArray(entry) ? JSON.stringify(entry) : String(entry));
  return params.toString();
}
export const overviewAddress = (route: OverviewRoute): string => `#overview?${overviewParameters(route)}`;
export function overviewRange(route: OverviewRoute, now = new Date()): { from?: string; to?: string } {
  if (route.window === "all") return {};
  if (route.window === "custom") return { from: route.from, to: route.to };
  const end = new Date(now); const start = new Date(now);
  if (route.window === "year") start.setMonth(0, 1);
  else start.setDate(start.getDate() - Number(route.window) + 1);
  return { from: localDay(start), to: localDay(end) };
}
/** 局部图表选择不参与报告请求；模型只传给用量区域。 */
export function overviewQuery(route: OverviewRoute, version?: string, priceVersion?: string, now = new Date()) {
  return { ...overviewRange(route, now), window: route.window, clients: route.clients, projects: route.projects, models: route.models,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, version, priceVersion };
}
export const shortName = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
export const validOverviewRange = (route: OverviewRoute) => route.window !== "custom" || !route.from || !route.to || route.from <= route.to;

/** 连续区间使用真实活动日，不跨过报告的选择边界。 */
export function streakRange(days: { day: string; sessions: number }[], range: { from: string; to: string; includesToday: boolean }, longest = false): { from?: string; to?: string } {
  const sorted = [...days].filter(day => day.day >= range.from && day.day <= range.to).sort((a, b) => a.day.localeCompare(b.day));
  const active = new Set(sorted.filter(day => day.sessions > 0).map(day => day.day));
  const previousDay = (value: string) => { const d = new Date(`${value}T12:00:00`); d.setDate(d.getDate() - 1); return localDay(d); };
  if (!longest) {
    let end = range.to;
    if (range.includesToday && !active.has(end) && previousDay(end) >= range.from) end = previousDay(end);
    if (!active.has(end)) return { from: range.to, to: range.to };
    let start = end; while (previousDay(start) >= range.from && active.has(previousDay(start))) start = previousDay(start);
    return { from: start, to: end };
  }
  let start: string | undefined; let last: string | undefined; let count = 0; let best = 0; let result = { from: range.to, to: range.to };
  for (const day of sorted) {
    if (!active.has(day.day)) { start = undefined; last = undefined; count = 0; continue; }
    if (last && previousDay(day.day) !== last) { start = undefined; count = 0; }
    start ??= day.day; count += 1; last = day.day;
    if (count >= best) { best = count; result = { from: start, to: day.day }; }
  }
  return result;
}

/** 将本地日历日期构造成本地日期对象，避免 ISO 字符串按 UTC 解读后错日。 */
export function overviewCalendarDate(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  const value = new Date(0); value.setFullYear(year!, month! - 1, date!); value.setHours(12, 0, 0, 0);
  return value;
}
