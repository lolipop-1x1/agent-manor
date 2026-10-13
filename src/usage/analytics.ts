import type { SessionSummary, SessionUsage } from "../session-contracts.js";
import type { PricingStatus, RequestCost, UsageGroup, UsageInterval, UsageQuery, UsageReport, UsageRequestPage, UsageSeries,
  UsageSessionRow, UsageSource, UsageStatistics, UsageStatisticsView, UsageTimeBucket, UsageTotals } from "../usage-contracts.js";
import { StoreError } from "../index/store.js";
import { usageDimensionKey, usageDimensionValue } from "./dimensions.js";
import { buildUsageSpeedReport, speedProfile } from "./speed.js";

const UNKNOWN = "unknown";
type Estimate = (usage: SessionUsage, client?: string) => RequestCost;
type Coverage = "complete" | "partial" | "missing";
interface Request {
  session: SessionSummary; usage: SessionUsage; cost: RequestCost; coverage: Coverage;
  time?: number; day?: string; bucket?: string;
}
interface Accumulator {
  totals: UsageTotals; sessions: Set<string>; pairedInput: number; pairedCache: number;
}
interface Selection {
  query: UsageQuery; timezone: string; requests: Request[]; undated: Request[];
  rows: UsageSessionRow[]; missingUsageSessions: number; facets: UsageReport["facets"];
}
const numeric = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;
const coverageOf = (usage: SessionUsage): Coverage => numeric(usage.inputTokens) && numeric(usage.outputTokens) ? "complete"
  : numeric(usage.inputTokens) || numeric(usage.outputTokens) ? "partial" : "missing";
const dimension = (request: Request, group: UsageGroup): string => group === "project" ? usageDimensionKey(request.session.project)
  : group === "model" ? usageDimensionKey(request.usage.model) : request.session.client;
const includes = (value: string, included?: string[], excluded?: string[]) => (!included?.length || included.includes(value))
  && !excluded?.includes(value);

function accumulator(): Accumulator {
  return { sessions: new Set(), pairedInput: 0, pairedCache: 0, totals: {
    requests: 0, sessions: 0, tokens: null, inputTokens: null, outputTokens: null, freshInputTokens: null,
    cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, estimatedCost: null, cacheReadRatio: null, cacheReadRatioRequests: 0,
    completeTokenRequests: 0, partialTokenRequests: 0, missingTokenRequests: 0,
    pricedRequests: 0, partiallyPricedRequests: 0, unpricedRequests: 0, missingTimeRequests: 0,
    historicalPricedRequests: 0, currentSnapshotPricedRequests: 0, manualPricedRequests: 0,
  } };
}

function add(target: Accumulator, request: Request): void {
  const { totals } = target, { usage, cost } = request;
  const sum = (key: "tokens" | "inputTokens" | "outputTokens" | "freshInputTokens" | "cacheReadTokens"
    | "cacheWriteTokens" | "reasoningTokens" | "estimatedCost", value: number | undefined | null) => {
    if (value !== null && numeric(value)) totals[key] = (totals[key] ?? 0) + value;
  };
  totals.requests += 1;
  target.sessions.add(request.session.id);
  totals.sessions = target.sessions.size;
  sum("inputTokens", usage.inputTokens); sum("outputTokens", usage.outputTokens);
  // 缺失分项保留缺失；已有分项只构成已记录小计，不将推理或缓存再次加入总量。
  if (numeric(usage.inputTokens) || numeric(usage.outputTokens)) sum("tokens", (numeric(usage.inputTokens) ? usage.inputTokens : 0)
    + (numeric(usage.outputTokens) ? usage.outputTokens : 0));
  sum("freshInputTokens", cost.freshInputTokens); sum("cacheReadTokens", usage.cachedInputTokens);
  sum("cacheWriteTokens", usage.cacheWriteTokens); sum("reasoningTokens", usage.reasoningOutputTokens);
  sum("estimatedCost", cost.amount);
  totals[request.coverage === "complete" ? "completeTokenRequests" : request.coverage === "partial" ? "partialTokenRequests" : "missingTokenRequests"] += 1;
  totals[cost.coverage === "complete" ? "pricedRequests" : cost.coverage === "partial" ? "partiallyPricedRequests" : "unpricedRequests"] += 1;
  if (cost.amount !== null) {
    const basis = cost.priceBasis === "historical" ? "historicalPricedRequests"
      : cost.priceBasis === "manual" ? "manualPricedRequests" : "currentSnapshotPricedRequests";
    totals[basis] += 1;
  }
  if (request.time === undefined) totals.missingTimeRequests += 1;
  if (numeric(usage.inputTokens) && numeric(usage.cachedInputTokens) && usage.cachedInputTokens <= usage.inputTokens) {
    target.pairedInput += usage.inputTokens; target.pairedCache += usage.cachedInputTokens;
    totals.cacheReadRatioRequests += 1;
    totals.cacheReadRatio = target.pairedInput > 0 ? target.pairedCache / target.pairedInput : null;
  }
}
function summarize(requests: Request[]): UsageTotals {
  const result = accumulator();
  for (const request of requests) add(result, request);
  return result.totals;
}

function invalid(field: string): never {
  throw new StoreError("INVALID_INPUT", `无效用量筛选：${field}`, { key: "diagnostics.usage.invalidQuery", params: { field } });
}
function calendarDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}
function instant(value?: string): number | undefined {
  if (!value || !calendarDay(value.slice(0, 10)) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}
function queryOf(query: UsageQuery, source: UsageSource, pricing: PricingStatus): UsageQuery {
  if (query.version !== undefined && query.version !== source.version) {
    throw new StoreError("VERSION_NOT_FOUND", "用量统计的分析版本不匹配", { key: "diagnostics.usage.versionMismatch" });
  }
  if (query.priceVersion !== undefined && query.priceVersion !== pricing.version) {
    throw new StoreError("VERSION_NOT_FOUND", "用量统计的价格版本不匹配", { key: "diagnostics.usage.priceVersionMismatch" });
  }
  const result: UsageQuery = { ...query, version: source.version, priceVersion: pricing.version,
    timezone: query.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    metric: query.metric ?? "tokens", groupBy: query.groupBy ?? "project", interval: query.interval ?? "day",
    page: query.page ?? 1, pageSize: query.pageSize ?? 25, sort: query.sort ?? "tokens", direction: query.direction ?? "desc" };
  for (const [key, choices] of Object.entries({ metric: ["tokens", "cost", "requests"], groupBy: ["project", "model", "client"],
    interval: ["hour", "day", "week", "month"], relationship: ["all", "main", "child"], sessionType: ["all", "interactive", "automation", "fork"],
    coverage: ["all", "complete", "partial", "missing"], pricing: ["all", "complete", "partial", "missing"],
    sort: ["tokens", "cost", "requests", "recent"], direction: ["asc", "desc"] })) {
    const value = result[key as keyof UsageQuery];
    if (value !== undefined && !choices.includes(value as string)) invalid(key);
  }
  if (result.includeSpeed !== undefined && typeof result.includeSpeed !== "boolean") invalid("includeSpeed");
  if (result.speedGroup !== undefined && (!result.includeSpeed || typeof result.speedGroup !== "string"
    || !result.speedGroup.trim() || result.speedGroup.length > 8192)) invalid("speedGroup");
  if (result.speedGroups !== undefined) {
    if (!result.includeSpeed || !Array.isArray(result.speedGroups) || result.speedGroups.length > 500
      || result.speedGroups.some(value => typeof value !== "string" || !value.trim() || value.length > 8192)) invalid("speedGroups");
    result.speedGroups = [...new Set(result.speedGroups)];
  }
  for (const key of ["clients", "excludeClients", "projects", "excludeProjects", "models", "excludeModels"] as const) {
    if (result[key] !== undefined && (!Array.isArray(result[key]) || result[key]!.some(value => typeof value !== "string" || !value))) invalid(key);
  }
  for (const key of ["minTokens", "maxTokens", "minCost", "maxCost"] as const) {
    if (result[key] !== undefined && !numeric(result[key])) invalid(key);
  }
  for (const [min, max] of [["minTokens", "maxTokens"], ["minCost", "maxCost"]] as const) {
    if (result[min] !== undefined && result[max] !== undefined && result[min]! > result[max]!) invalid(max);
  }
  for (const key of ["page", "pageSize"] as const) {
    if (!Number.isInteger(result[key]) || result[key]! < 1 || key === "pageSize" && result[key]! > 200) invalid(key);
  }
  for (const key of ["from", "to"] as const) {
    if (result[key] !== undefined && !calendarDay(result[key]!) && instant(result[key]) === undefined) invalid(key);
  }
  if (result.from && result.to && calendarDay(result.from) && calendarDay(result.to) && result.from > result.to) invalid("to");
  if (result.from && result.to && !calendarDay(result.from) && !calendarDay(result.to) && instant(result.from)! >= instant(result.to)!) invalid("to");
  return result;
}

function timeKeys(timezone: string, interval: UsageInterval): (time: number) => { day: string; bucket: string } {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { invalid("timezone"); }
  return time => {
    const parts = Object.fromEntries(formatter.formatToParts(time).map(part => [part.type, part.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    if (interval !== "hour") return { day, bucket: intervalKey(day, interval) };
    const localTime = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const offset = Math.round((localTime - Math.floor(time / 1000) * 1000) / 60000);
    const absolute = Math.abs(offset);
    // 夏令时回拨的两个同名小时使用各自 UTC 偏移，保持两个不同的时间桶。
    const zone = `${offset < 0 ? "-" : "+"}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
    return { day, bucket: `${day}T${parts.hour}:00:00${zone}` };
  };
}
function intervalKey(day: string, interval: UsageInterval): string {
  if (interval === "month") return `${day.slice(0, 7)}-01`;
  if (interval !== "week") return day;
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
function matchesDate(request: Request, query: UsageQuery): boolean {
  if (request.time === undefined) return !query.from && !query.to;
  return (!query.from || (calendarDay(query.from) ? request.day! >= query.from : request.time >= instant(query.from)!))
    && (!query.to || (calendarDay(query.to) ? request.day! <= query.to : request.time < instant(query.to)!));
}
function matchesSession(session: SessionSummary, query: UsageQuery): boolean {
  const type = session.relationship === "fork" ? "fork" : session.executionMode === "quiet" ? "automation" : "interactive";
  return includes(session.client, query.clients, query.excludeClients) && includes(usageDimensionKey(session.project), query.projects, query.excludeProjects)
    && (!query.relationship || query.relationship === "all" || (session.relationship === "child" ? "child" : "main") === query.relationship)
    && (!query.sessionType || query.sessionType === "all" || type === query.sessionType);
}
function matchesCoverage(coverage: Coverage, costCoverage: Coverage, query: UsageQuery): boolean {
  return (!query.coverage || query.coverage === "all" || query.coverage === coverage)
    && (!query.pricing || query.pricing === "all" || query.pricing === costCoverage);
}
function matchesThreshold(totals: UsageTotals, query: UsageQuery): boolean {
  const ranges: [number | null, number | undefined, number | undefined][] = [
    [totals.tokens, query.minTokens, query.maxTokens], [totals.estimatedCost, query.minCost, query.maxCost],
  ];
  return ranges
    .every(([value, min, max]) => min === undefined && max === undefined || value !== null && value !== undefined
      && (min === undefined || value >= min) && (max === undefined || value <= max));
}
function compareValues(left: number | null | undefined, right: number | null | undefined, direction: "asc" | "desc"): number {
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  return (left - right) * (direction === "asc" ? 1 : -1);
}
function requestOrder(left: Request, right: Request): number {
  return compareValues(left.time, right.time, "desc") || left.usage.id.localeCompare(right.usage.id);
}

function select(source: UsageSource, requested: UsageQuery, pricing: PricingStatus, estimate: Estimate, includeRows = true): Selection {
  const query = queryOf(requested, source, pricing), timezone = query.timezone!;
  const keys = timeKeys(timezone, query.interval!);
  const sessions = new Map(source.sessions.map(session => [session.id, session]));
  // 请求身份在会话内有意义；跨会话的继承副本由索引的明确复制依据排除。
  const unique = new Map(source.requests.map(request => [`${request.sessionId}\0${request.usage.id}`, request]));
  const hasUsage = new Set([...unique.values()].map(request => request.sessionId));
  const bySession = new Map<string, { dated: Request[]; undated: Request[] }>();
  const facets = { clients: new Set<string>(), projects: new Set<string>(), models: new Set<string>() };
  for (const session of sessions.values()) {
    facets.clients.add(session.client); facets.projects.add(usageDimensionKey(session.project));
    if (!hasUsage.has(session.id)) facets.models.add(UNKNOWN);
    if (matchesSession(session, query)) bySession.set(session.id, { dated: [], undated: [] });
  }
  for (const item of unique.values()) {
    const session = sessions.get(item.sessionId);
    if (!session) continue;
    facets.models.add(usageDimensionKey(item.usage.model));
    const target = bySession.get(session.id);
    if (!target || !includes(usageDimensionKey(item.usage.model), query.models, query.excludeModels)) continue;
    const coverage = coverageOf(item.usage), cost = estimate(item.usage, session.client);
    if (!matchesCoverage(coverage, cost.coverage, query)) continue;
    const time = instant(item.usage.occurredAt);
    const request: Request = { session, usage: item.usage, cost, coverage, ...(time === undefined ? {} : { time, ...keys(time) }) };
    if (time === undefined) target.undated.push(request);
    else if (matchesDate(request, query)) target.dated.push(request);
  }
  const requests: Request[] = [], undated: Request[] = [], rows: UsageSessionRow[] = [];
  let missingUsageSessions = 0;
  for (const [id, target] of bySession) {
    const session = sessions.get(id)!;
    const missing = !hasUsage.has(id);
    if (missing && (!includes(UNKNOWN, query.models, query.excludeModels) || !matchesCoverage("missing", "missing", query))) continue;
    if (!missing && !target.dated.length && !target.undated.length) continue;
    const included = !query.from && !query.to ? [...target.dated, ...target.undated] : target.dated;
    const totals = summarize(included);
    if (!matchesThreshold(totals, query)) continue;
    if (missing) missingUsageSessions += 1;
    for (const request of included) requests.push(request);
    for (const request of target.undated) undated.push(request);
    if (!includeRows) continue;
    const evidence = [...target.dated, ...target.undated].sort(requestOrder);
    const latest = evidence.find(request => request.time !== undefined);
    rows.push({ session, totals, ...(latest ? { lastOccurredAt: new Date(latest.time!).toISOString() } : {}),
      ...(target.undated.length ? { undated: summarize(target.undated) } : {}),
      requestsTotal: evidence.length, requestsLimited: evidence.length > 12,
      requests: evidence.slice(0, 12).map(({ usage, cost }) => ({ usage, cost })) });
  }
  rows.sort((left, right) => {
    const value = (row: UsageSessionRow): number | null | undefined => query.sort === "recent" ? instant(row.lastOccurredAt)
      : query.sort === "cost" ? row.totals.estimatedCost : query.sort === "requests" ? row.totals.requests : row.totals.tokens;
    return compareValues(value(left), value(right), query.direction!) || left.session.id.localeCompare(right.session.id);
  });
  return { query, timezone, requests, undated, rows, missingUsageSessions,
    facets: { clients: [...facets.clients].sort(), projects: [...facets.projects].sort(), models: [...facets.models].sort() } };
}

function grouped(requests: Request[], query: UsageQuery): UsageSeries[] {
  const groups = new Map<string, Accumulator>();
  for (const request of requests) {
    const key = dimension(request, query.groupBy!);
    if (!groups.has(key)) groups.set(key, accumulator());
    add(groups.get(key)!, request);
  }
  const value = (totals: UsageTotals) => query.metric === "cost" ? totals.estimatedCost : query.metric === "requests" ? totals.requests : totals.tokens;
  return [...groups].map(([key, result]) => ({ key, label: usageDimensionValue(key) ?? UNKNOWN, totals: result.totals }))
    .sort((left, right) => compareValues(value(left.totals), value(right.totals), "desc") || left.key.localeCompare(right.key));
}
function bucketed(requests: Request[], query: UsageQuery, dayOnly = false, includeGroups = true): UsageTimeBucket[] {
  const buckets = new Map<string, Request[]>();
  for (const request of requests) {
    const key = dayOnly ? request.day : request.bucket;
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(request);
  }
  return [...buckets].map(([key, values]) => ({ key, totals: summarize(values), groups: includeGroups ? grouped(values, query) : [] }));
}
function fillDays(days: UsageTimeBucket[], query: UsageQuery, timezone: string): UsageTimeBucket[] {
  const keys = timeKeys(timezone, "day");
  const observed = days.map(day => day.key).sort();
  const from = query.from ? calendarDay(query.from) ? query.from : keys(instant(query.from)!).day : observed[0];
  const to = query.to ? calendarDay(query.to) ? query.to : keys(instant(query.to)! - 1).day : observed.at(-1);
  if (!from || !to || from > to) return days;
  const byDay = new Map(days.map(day => [day.key, day]));
  const cursor = new Date(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end) {
    const key = cursor.toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, { key, totals: accumulator().totals, groups: [] });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return [...byDay.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function fillHours(buckets: UsageTimeBucket[], days: UsageTimeBucket[], query: UsageQuery, timezone: string): UsageTimeBucket[] {
  if (!days.length) return buckets;
  const keys = timeKeys(timezone, "hour");
  // 用当地日期寻找真实边界，不能假定每日恰好 24 小时或偏移为整小时。
  const dayStart = (day: string): number => {
    const midnight = Date.parse(`${day}T00:00:00Z`);
    let low = midnight - 36 * 3_600_000, high = midnight + 36 * 3_600_000;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (keys(middle).day >= day) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  const finalDay = new Date(`${days.at(-1)!.key}T00:00:00Z`);
  finalDay.setUTCDate(finalDay.getUTCDate() + 1);
  let cursor = dayStart(days[0]!.key), end = dayStart(finalDay.toISOString().slice(0, 10));
  if (query.from && !calendarDay(query.from)) cursor = Math.max(cursor, instant(query.from)!);
  if (query.to && !calendarDay(query.to)) end = Math.min(end, instant(query.to)!);
  const byHour = new Map(buckets.map(bucket => [bucket.key, bucket]));
  while (cursor < end) {
    const key = keys(cursor).bucket;
    if (!byHour.has(key)) byHour.set(key, { key, totals: accumulator().totals, groups: [] });
    const nextHour = Math.min(Date.parse(key) + 3_600_000, end);
    if (!Number.isFinite(nextHour) || nextHour <= cursor) invalid("dateRange");
    if (keys(nextHour - 1).bucket === key) { cursor = nextHour; continue; }
    // 半小时等非整小时夏令时变化也保留真实偏移，不跳过重复或缩短的小时。
    let low = cursor + 1, high = nextHour;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (keys(middle).bucket === key) low = middle + 1;
      else high = middle;
    }
    cursor = low;
  }
  return [...byHour.values()];
}

/** 指标、图表和分页明细由同一请求集合构建，表格页码不改变聚合范围。 */
export function buildUsageReport(source: UsageSource, query: UsageQuery, pricing: PricingStatus, estimate: Estimate): UsageReport {
  const selected = select(source, query, pricing, estimate);
  const days = fillDays(bucketed(selected.requests, selected.query, true), selected.query, selected.timezone);
  const observedBuckets = selected.query.interval === "day" ? days : bucketed(selected.requests, selected.query);
  const buckets = selected.query.interval === "hour" ? fillHours(observedBuckets, days, selected.query, selected.timezone) : observedBuckets;
  if (selected.query.interval !== "hour") {
    const present = new Set(buckets.map(bucket => bucket.key));
    for (const day of days) {
      const key = intervalKey(day.key, selected.query.interval!);
      if (!present.has(key)) { present.add(key); buckets.push({ key, totals: accumulator().totals, groups: [] }); }
    }
  }
  buckets.sort((left, right) => selected.query.interval === "hour" ? Date.parse(left.key) - Date.parse(right.key) : left.key.localeCompare(right.key));
  const { configuration: _configuration, prices: _prices, historicalPrices: _historicalPrices, ...status } = pricing;
  const pageSize = selected.query.pageSize!, page = selected.query.page!;
  const projects = new Set<string>(), models = new Set<string>();
  for (const request of selected.requests) {
    if (request.session.project !== undefined) projects.add(request.session.project);
    if (request.usage.model !== undefined) models.add(request.usage.model);
  }
  return { version: source.version, priceVersion: pricing.version, timezone: selected.timezone, query: selected.query,
    totals: summarize(selected.requests), undated: summarize(selected.undated), buckets, days,
    projectCount: projects.size, modelCount: models.size,
    groups: grouped(selected.requests, selected.query), sessions: selected.rows.slice((page - 1) * pageSize, page * pageSize),
    totalSessions: selected.rows.length, page, pageSize, missingUsageSessions: selected.missingUsageSessions, facets: selected.facets, pricing: status,
    ...(selected.query.includeSpeed ? { speed: buildUsageSpeedReport(selected.requests.filter(request => request.time !== undefined)
      .map(request => ({ bucket: request.bucket!, requests: 1, ...speedProfile(request.session.client, request.usage) })),
    buckets.map(bucket => bucket.key), selected.undated.length, selected.query.speedGroup, selected.query.speedGroups) } : {}) };
}

/** 精确统计复用报告筛选，但不创建会话行、请求预览及未显示的分组。 */
export function buildUsageStatistics(source: UsageSource, query: UsageQuery, pricing: PricingStatus, estimate: Estimate,
  view: UsageStatisticsView): UsageStatistics {
  const selected = select(source, query, pricing, estimate, false);
  return { version: source.version, priceVersion: pricing.version, timezone: selected.timezone, query: selected.query,
    totals: summarize(selected.requests), undated: summarize(selected.undated), facets: selected.facets,
    days: view === "trend" ? fillDays(bucketed(selected.requests, selected.query, true, false), selected.query, selected.timezone) : [],
    groups: view === "distribution" ? grouped(selected.requests, selected.query) : [] };
}

/** 请求证据独立分页；缺时间记录保留其状态，不混入有限日期范围的用量总量。 */
export function buildUsageRequestPage(source: UsageSource, query: UsageQuery, pricing: PricingStatus, estimate: Estimate,
  sessionId: string, page = 1, pageSize = 100): UsageRequestPage {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) invalid("requestPage");
  const selected = select(source, query, pricing, estimate);
  const row = selected.rows.find(row => row.session.id === sessionId);
  const requests = row ? [...selected.requests, ...(query.from || query.to ? selected.undated : [])]
    .filter(request => request.session.id === sessionId).sort(requestOrder) : [];
  return { version: source.version, priceVersion: pricing.version, sessionId,
    requests: requests.slice((page - 1) * pageSize, page * pageSize).map(({ usage, cost }) => ({ usage, cost })), total: requests.length, page, pageSize };
}

// 汇总路径复用实时分析的筛选和时间口径，实时函数继续作为差异验收依据。
export { accumulator, add, calendarDay, compareValues, coverageOf, fillDays, fillHours, includes, instant, intervalKey,
  matchesCoverage, matchesSession, matchesThreshold, queryOf, requestOrder, timeKeys };
export type { Accumulator, Coverage, Estimate, Request };
