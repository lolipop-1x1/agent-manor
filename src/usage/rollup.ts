import type { SessionSummary, SessionUsage } from "../session-contracts.js";
import type { PricingStatus, UsageGroup, UsageQuery, UsageReport, UsageSeries, UsageSessionRow, UsageSource,
  UsageStatistics, UsageStatisticsView, UsageTimeBucket, UsageTotals } from "../usage-contracts.js";
import { StoreError } from "../index/store.js";
import { accumulator, add, calendarDay, compareValues, coverageOf, fillDays, fillHours, includes, instant, intervalKey,
  matchesCoverage, matchesSession, matchesThreshold, queryOf, timeKeys } from "./analytics.js";
import type { Accumulator, Estimate } from "./analytics.js";
import { usageDimensionKey, usageDimensionValue } from "./dimensions.js";
import type { CompactUsage, UsageRollup, UsageRollupCell, UsageRollupPreview } from "./rollup-contracts.js";
import { buildUsageSpeedReport, mergeSpeedProfiles, speedProfile } from "./speed.js";

const PREVIEW_LIMIT = 12;
const nullableTotals = ["tokens", "inputTokens", "outputTokens", "freshInputTokens", "cacheReadTokens", "cacheWriteTokens",
  "reasoningTokens", "estimatedCost"] as const;
const countTotals = ["requests", "cacheReadRatioRequests", "completeTokenRequests", "partialTokenRequests", "missingTokenRequests",
  "pricedRequests", "partiallyPricedRequests", "unpricedRequests", "missingTimeRequests",
  "historicalPricedRequests", "currentSnapshotPricedRequests", "manualPricedRequests"] as const;

function compactUsage(usage: SessionUsage): CompactUsage {
  const result: CompactUsage = { id: usage.id };
  for (const key of ["model", "provider", "occurredAt", "inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens",
    "reasoningOutputTokens", "contextTokens", "messageId", "turnId"] as const) {
    if (usage[key] !== undefined) Object.assign(result, { [key]: usage[key] });
  }
  return result;
}
function previewOrder(left: UsageRollupPreview, right: UsageRollupPreview): number {
  return compareValues(left.time, right.time, "desc") || left.usage.id.localeCompare(right.usage.id);
}
function appendPreview(previews: UsageRollupPreview[], preview: UsageRollupPreview): void {
  if (previews.length === PREVIEW_LIMIT && previewOrder(preview, previews.at(-1)!) >= 0) return;
  const index = previews.findIndex(current => previewOrder(preview, current) < 0);
  if (index < 0) previews.push(preview);
  else previews.splice(index, 0, preview);
  if (previews.length > PREVIEW_LIMIT) previews.pop();
}

/** 索引或价格变化时生成小时事实汇总，无可靠时间的记录单独成组。 */
export function buildUsageRollup(source: UsageSource, timezone: string, estimate: Estimate): UsageRollup {
  const keys = timeKeys(timezone, "hour");
  const sessions = new Map(source.sessions.map(session => [session.id, session]));
  const unique = new Map(source.requests.map(request => [`${request.sessionId}\0${request.usage.id}`, request]));
  const cells = new Map<string, { cell: UsageRollupCell; result: Accumulator }>();
  const hasUsage = new Set<string>(), models = new Set<string>();
  for (const item of unique.values()) {
    const session = sessions.get(item.sessionId);
    if (!session) continue;
    hasUsage.add(session.id); models.add(usageDimensionKey(item.usage.model));
    const coverage = coverageOf(item.usage), cost = estimate(item.usage, session.client), time = instant(item.usage.occurredAt);
    const local = time === undefined ? undefined : keys(time);
    const key = JSON.stringify([session.id, local?.bucket, item.usage.model, coverage, cost.coverage]);
    let target = cells.get(key);
    if (!target) {
      const result = accumulator();
      const cell: UsageRollupCell = { sessionId: session.id, coverage, costCoverage: cost.coverage, totals: result.totals,
        pairedInput: 0, pairedCache: 0, previews: [], speedEligibleRequests: 0, speedProfiles: [],
        ...(item.usage.model === undefined ? {} : { model: item.usage.model }),
        ...(local ? { day: local.day, hour: local.bucket } : {}) };
      target = { cell, result }; cells.set(key, target);
    }
    add(target.result, { session, usage: item.usage, cost, coverage, ...(time === undefined ? {} : { time }) });
    const speed = speedProfile(session.client, item.usage);
    target.cell.speedEligibleRequests += speed.eligibleRequests;
    mergeSpeedProfiles(target.cell.speedProfiles, speed.profiles);
    target.cell.pairedInput = target.result.pairedInput; target.cell.pairedCache = target.result.pairedCache;
    if (time !== undefined && (target.cell.latestTime === undefined || time > target.cell.latestTime)) target.cell.latestTime = time;
    const { price: _price, ...compactCost } = cost;
    appendPreview(target.cell.previews, { usage: compactUsage(item.usage), cost: compactCost, ...(time === undefined ? {} : { time }) });
  }
  return { version: source.version, timezone, sessions: source.sessions, cells: [...cells.values()].map(value => value.cell),
    sessionIdsWithUsage: [...hasUsage], models: [...models].sort() };
}

/** 当前发布版本组合不变修订的汇总，父子关系和筛选维度使用当前会话摘要。 */
export function combineUsageRollups(parts: UsageRollup[], version: string, sessions: SessionSummary[],
  timezone = parts[0]?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone): UsageRollup {
  if (parts.some(part => part.timezone !== timezone)) {
    throw new StoreError("INVALID_INPUT", "用量汇总的时区不一致", { key: "diagnostics.usage.invalidQuery", params: { field: "timezone" } });
  }
  const ids = new Set(sessions.map(session => session.id));
  return { version, timezone, sessions, cells: parts.flatMap(part => part.cells).filter(cell => ids.has(cell.sessionId)),
    sessionIdsWithUsage: [...new Set(parts.flatMap(part => part.sessionIdsWithUsage).filter(id => ids.has(id)))],
    models: [...new Set(parts.flatMap(part => part.models))].sort() };
}

/** 精确时间和费用比较保留原始顺序，避免浮点合并改变阈值或同金额排序。 */
export function canUseUsageRollup(query: UsageQuery): boolean {
  return (!query.from || calendarDay(query.from)) && (!query.to || calendarDay(query.to))
    && query.minCost === undefined && query.maxCost === undefined && query.sort !== "cost" && query.metric !== "cost";
}

function merge(target: Accumulator, cell: UsageRollupCell): void {
  for (const key of nullableTotals) {
    const value = cell.totals[key];
    if (value !== null) target.totals[key] = (target.totals[key] ?? 0) + value;
  }
  for (const key of countTotals) target.totals[key] += cell.totals[key];
  target.sessions.add(cell.sessionId); target.totals.sessions = target.sessions.size;
  target.pairedInput += cell.pairedInput; target.pairedCache += cell.pairedCache;
  target.totals.cacheReadRatio = target.pairedInput > 0 ? target.pairedCache / target.pairedInput : null;
}
function summarize(cells: UsageRollupCell[]): UsageTotals {
  const result = accumulator();
  for (const cell of cells) merge(result, cell);
  return result.totals;
}
function dimension(cell: UsageRollupCell, session: SessionSummary, group: UsageGroup): string {
  return group === "project" ? usageDimensionKey(session.project) : group === "model" ? usageDimensionKey(cell.model) : session.client;
}
function grouped(cells: UsageRollupCell[], query: UsageQuery, sessions: Map<string, SessionSummary>): UsageSeries[] {
  const groups = new Map<string, Accumulator>();
  for (const cell of cells) {
    const key = dimension(cell, sessions.get(cell.sessionId)!, query.groupBy!);
    let result = groups.get(key);
    if (!result) { result = accumulator(); groups.set(key, result); }
    merge(result, cell);
  }
  const value = (totals: UsageTotals) => query.metric === "cost" ? totals.estimatedCost : query.metric === "requests" ? totals.requests : totals.tokens;
  return [...groups].map(([key, result]) => ({ key, label: usageDimensionValue(key) ?? "unknown", totals: result.totals }))
    .sort((left, right) => compareValues(value(left.totals), value(right.totals), "desc") || left.key.localeCompare(right.key));
}
function bucketed(cells: UsageRollupCell[], query: UsageQuery, sessions: Map<string, SessionSummary>, dayOnly = false,
  includeGroups = true): UsageTimeBucket[] {
  const buckets = new Map<string, UsageRollupCell[]>();
  for (const cell of cells) {
    if (!cell.day) continue;
    const key = dayOnly ? cell.day : query.interval === "hour" ? cell.hour! : intervalKey(cell.day, query.interval!);
    let values = buckets.get(key);
    if (!values) { values = []; buckets.set(key, values); }
    values.push(cell);
  }
  return [...buckets].map(([key, values]) => ({ key, totals: summarize(values), groups: includeGroups ? grouped(values, query, sessions) : [] }));
}

function select(rollup: UsageRollup, requested: UsageQuery, pricing: PricingStatus, includeRows = true) {
  const query = queryOf({ ...requested, timezone: requested.timezone ?? rollup.timezone }, { ...rollup, requests: [] }, pricing);
  if (!canUseUsageRollup(query) || query.timezone !== rollup.timezone) {
    throw new StoreError("INVALID_INPUT", "用量汇总的查询范围或时区不匹配", { key: "diagnostics.usage.invalidQuery", params: { field: "timezone/dateRange" } });
  }
  // 即使没有请求也校验时区，并沿用实时路径的空桶和夏令时边界。
  timeKeys(query.timezone!, "hour");
  const sessions = new Map(rollup.sessions.map(session => [session.id, session])), hasUsage = new Set(rollup.sessionIdsWithUsage);
  const targets = new Map<string, { dated: UsageRollupCell[]; undated: UsageRollupCell[] }>();
  for (const session of sessions.values()) if (matchesSession(session, query)) targets.set(session.id, { dated: [], undated: [] });
  for (const cell of rollup.cells) {
    const target = targets.get(cell.sessionId);
    if (!target || !includes(usageDimensionKey(cell.model), query.models, query.excludeModels)
      || !matchesCoverage(cell.coverage, cell.costCoverage, query)) continue;
    if (!cell.day) target.undated.push(cell);
    else if ((!query.from || cell.day >= query.from) && (!query.to || cell.day <= query.to)) target.dated.push(cell);
  }
  const cells: UsageRollupCell[] = [], undated: UsageRollupCell[] = [], rows: UsageSessionRow[] = [];
  let missingUsageSessions = 0;
  for (const [id, target] of targets) {
    const session = sessions.get(id)!, missing = !hasUsage.has(id);
    if (missing && (!includes("unknown", query.models, query.excludeModels) || !matchesCoverage("missing", "missing", query))) continue;
    if (!missing && !target.dated.length && !target.undated.length) continue;
    const included = !query.from && !query.to ? [...target.dated, ...target.undated] : target.dated;
    const totals = summarize(included);
    if (!matchesThreshold(totals, query)) continue;
    if (missing) missingUsageSessions += 1;
    for (const cell of included) cells.push(cell);
    for (const cell of target.undated) undated.push(cell);
    if (!includeRows) continue;
    const previews: UsageRollupPreview[] = [];
    let latestTime: number | undefined, requestsTotal = 0;
    for (const cell of [...target.dated, ...target.undated]) {
      requestsTotal += cell.totals.requests;
      if (cell.latestTime !== undefined && (latestTime === undefined || cell.latestTime > latestTime)) latestTime = cell.latestTime;
      for (const preview of cell.previews) appendPreview(previews, preview);
    }
    rows.push({ session, totals, ...(latestTime === undefined ? {} : { lastOccurredAt: new Date(latestTime).toISOString() }),
      ...(target.undated.length ? { undated: summarize(target.undated) } : {}), requestsTotal, requestsLimited: requestsTotal > PREVIEW_LIMIT,
      requests: previews.map(({ usage, cost }) => ({ usage, cost })) });
  }
  rows.sort((left, right) => {
    const value = (row: UsageSessionRow): number | null | undefined => query.sort === "recent" ? instant(row.lastOccurredAt)
      : query.sort === "cost" ? row.totals.estimatedCost : query.sort === "requests" ? row.totals.requests : row.totals.tokens;
    return compareValues(value(left), value(right), query.direction!) || left.session.id.localeCompare(right.session.id);
  });
  const models = new Set(rollup.models);
  if (rollup.sessions.some(session => !hasUsage.has(session.id))) models.add("unknown");
  return { query, sessions, cells, undated, rows, missingUsageSessions,
    facets: { clients: [...new Set(rollup.sessions.map(session => session.client))].sort(),
      projects: [...new Set(rollup.sessions.map(session => usageDimensionKey(session.project)))].sort(), models: [...models].sort() } };
}

/** 只合并小时汇总；页面预览保留原请求身份，由调用方按最终页补全原始证据。 */
export function buildUsageRollupReport(rollup: UsageRollup, requested: UsageQuery, pricing: PricingStatus): UsageReport {
  const { query, sessions, cells, undated, rows, missingUsageSessions, facets } = select(rollup, requested, pricing);
  const days = fillDays(bucketed(cells, query, sessions, true), query, rollup.timezone);
  const observedBuckets = query.interval === "day" ? days : bucketed(cells, query, sessions);
  const buckets = query.interval === "hour" ? fillHours(observedBuckets, days, query, rollup.timezone) : observedBuckets;
  if (query.interval !== "hour") {
    const present = new Set(buckets.map(bucket => bucket.key));
    for (const day of days) {
      const key = intervalKey(day.key, query.interval!);
      if (!present.has(key)) { present.add(key); buckets.push({ key, totals: accumulator().totals, groups: [] }); }
    }
  }
  buckets.sort((left, right) => query.interval === "hour" ? Date.parse(left.key) - Date.parse(right.key) : left.key.localeCompare(right.key));
  const { configuration: _configuration, prices: _prices, historicalPrices: _historicalPrices, ...status } = pricing;
  const page = query.page!, pageSize = query.pageSize!;
  const selectedProjects = new Set<string>(), selectedModels = new Set<string>();
  for (const cell of cells) {
    const project = sessions.get(cell.sessionId)!.project;
    if (project !== undefined) selectedProjects.add(project);
    if (cell.model !== undefined) selectedModels.add(cell.model);
  }
  return { version: rollup.version, priceVersion: pricing.version, timezone: rollup.timezone, query,
    totals: summarize(cells), undated: summarize(undated), buckets, days, groups: grouped(cells, query, sessions),
    projectCount: selectedProjects.size, modelCount: selectedModels.size,
    sessions: rows.slice((page - 1) * pageSize, page * pageSize), totalSessions: rows.length, page, pageSize, missingUsageSessions,
    facets, pricing: status,
    ...(query.includeSpeed ? { speed: buildUsageSpeedReport(cells.filter(cell => cell.day !== undefined).map(cell => ({
      bucket: query.interval === "hour" ? cell.hour! : intervalKey(cell.day!, query.interval!),
      requests: cell.totals.requests, eligibleRequests: cell.speedEligibleRequests, profiles: cell.speedProfiles,
    })), buckets.map(bucket => bucket.key), undated.reduce((sum, cell) => sum + cell.totals.requests, 0), query.speedGroup) } : {}) };
}

/** 按视图合并已准备的汇总，不读取预览，也不构建会话明细或其他维度。 */
export function buildUsageRollupStatistics(rollup: UsageRollup, requested: UsageQuery, pricing: PricingStatus,
  view: UsageStatisticsView): UsageStatistics {
  const { query, sessions, cells, undated, facets } = select(rollup, requested, pricing, false);
  return { version: rollup.version, priceVersion: pricing.version, timezone: rollup.timezone, query,
    totals: summarize(cells), undated: summarize(undated), facets,
    days: view === "trend" ? fillDays(bucketed(cells, query, sessions, true, false), query, rollup.timezone) : [],
    groups: view === "distribution" ? grouped(cells, query, sessions) : [] };
}
