import type { OverviewPeriod, OverviewQuery, OverviewRange, OverviewSource } from "../overview-contracts.js";
import { StoreError } from "../index/store.js";
import { calendarDay, instant } from "../usage/analytics.js";
import { usageDimensionKey } from "../usage/dimensions.js";

const formatters = new Map<string, Intl.DateTimeFormat>();
export function resolveTimezone(value?: string): string {
  const timezone = value ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
  catch { throw new StoreError("INVALID_INPUT", "无效时区", { key: "diagnostics.usage.invalidQuery", params: { field: "timezone" } }); }
  return timezone;
}
export function localDay(value: string | number | Date | undefined, timezone: string): string | null {
  const time = typeof value === "string" ? instant(value) : value instanceof Date ? value.getTime() : value;
  if (time === undefined || !Number.isFinite(time)) return null;
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timezone, formatter);
    while (formatters.size > 16) formatters.delete(formatters.keys().next().value!);
  }
  const parts = Object.fromEntries(formatter.formatToParts(time).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}
export function inPeriod(value: string | undefined, period: OverviewPeriod, timezone: string): boolean {
  const day = localDay(value, timezone);
  return day !== null && day >= period.from && day <= period.to;
}
export function resolveOverviewRange(source: OverviewSource, query: OverviewQuery, now = new Date()): OverviewRange {
  const timezone = resolveTimezone(query.timezone), today = localDay(now, timezone)!;
  const window = query.window ?? (query.from || query.to ? "custom" : "365");
  if (!["365", "7", "30", "90", "year", "all", "custom"].includes(window)) invalid("window");
  for (const field of ["from", "to"] as const) if (query[field] !== undefined && !calendarDay(query[field]!)) invalid(field);
  let from = query.from ?? (window === "year" ? `${today.slice(0, 4)}-01-01`
    : window === "custom" ? addDays(today, -364) : window === "all" ? today : addDays(today, -(Number(window) - 1)));
  const to = query.to ?? today;
  if (window === "all" && !query.from) {
    const scopedIds = new Set(source.sessions.filter(session => (!query.clients?.length || query.clients.includes(session.client))
      && (!query.projects?.length || query.projects.includes(usageDimensionKey(session.project)) || session.project === undefined && query.projects.includes("none"))).map(session => session.id));
    const dates = [...source.events.filter(event => scopedIds.has(event.sessionId) && !event.copied && !event.contextSource && event.kind !== "system" && event.kind !== "context"
      && !(event.kind === "user" && event.resource?.kind === "skill_read")).map(event => localDay(event.occurredAt, timezone)),
      ...source.requests.filter(request => scopedIds.has(request.sessionId)).map(request => localDay(request.usage.occurredAt, timezone))].filter((day): day is string => day !== null);
    from = dates.length ? dates.reduce((earliest, day) => day < earliest ? day : earliest, today) : today;
  }
  if (from > to) invalid("to");
  const includesToday = from <= today && to >= today;
  const completeTo = to >= today ? addDays(today, -1) : to;
  let comparison: OverviewRange["comparison"] = null;
  if (window !== "all" && completeTo >= from) {
    const length = daysBetween(from, completeTo) + 1;
    comparison = { current: { from, to: completeTo }, previous: { from: addDays(from, -length), to: addDays(from, -1) } };
  }
  const recentFrom = addDays(today, -30), previousFrom = addDays(today, -60);
  const recent = includesToday && from <= previousFrom
    ? { current: { from: recentFrom, to: addDays(today, -1) }, previous: { from: previousFrom, to: addDays(today, -31) } } : null;
  return { from, to, today, all: window === "all" && !query.from && !query.to, includesToday, comparison, recent };
}
function invalid(field: string): never {
  throw new StoreError("INVALID_INPUT", "无效总览筛选", { key: "diagnostics.usage.invalidQuery", params: { field } });
}
