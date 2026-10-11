import type { OverviewEvidenceQuery, OverviewInsight, OverviewModelTransition, OverviewPeriod, OverviewProjectMonth, OverviewQuery, OverviewReport,
  OverviewRequest, OverviewSource } from "../overview-contracts.js";
import type { MessageParams } from "../i18n/types.js";
import type { SessionSummary } from "../session-contracts.js";
import type { PricingView } from "../usage/pricing.js";
import { buildDelegation, isActivityEvent, matchesGlobalSession, pairToolCalls, selectedSource, validDuration } from "./analytics.js";
import { inPeriod, localDay } from "./dates.js";
import { usageDimensionKey } from "../usage/dimensions.js";
import { decomposeUsage, nonnegative, percent, quantile, selectFeaturedInsights } from "./insight-math.js";

type Request = OverviewRequest & { session: SessionSummary; day: string | null };
interface PeriodRequests { all: Request[]; complete: Request[]; tokens: number; input: number; output: number }
const identity = (...parts: (string | number)[]) => JSON.stringify(parts);
const knownModel = (request: Request) => Boolean(request.usage.model?.trim());
const completeTokens = (request: OverviewRequest) => nonnegative(request.usage.inputTokens) && nonnegative(request.usage.outputTokens);
const totalTokens = (request: OverviewRequest) => request.usage.inputTokens! + request.usage.outputTokens!;

function periodRequests(requests: Request[], period: OverviewPeriod, timezone: string): PeriodRequests {
  const all = requests.filter(request => inPeriod(request.usage.occurredAt, period, timezone));
  const complete = all.filter(completeTokens);
  return { all, complete, tokens: complete.reduce((sum, request) => sum + totalTokens(request), 0),
    input: complete.reduce((sum, request) => sum + request.usage.inputTokens!, 0),
    output: complete.reduce((sum, request) => sum + request.usage.outputTokens!, 0) };
}

function groupRequests(requests: Request[], key: (request: Request) => string | undefined): Map<string, Request[]> {
  const groups = new Map<string, Request[]>();
  for (const request of requests) {
    const value = key(request);
    if (!value) continue;
    const group = groups.get(value) ?? [];
    group.push(request); groups.set(value, group);
  }
  return groups;
}

/** 缺少可靠顺序或日期的请求切断片段，不跨未知模型建立相邻关系。 */
function orderedSessions(requests: Request[]): Map<string, Request[]> {
  const grouped = groupRequests(requests, request => request.sessionId);
  for (const [sessionId, group] of grouped) {
    const ordinals = group.map(request => request.ordinal);
    if (ordinals.some(ordinal => !Number.isSafeInteger(ordinal) || ordinal! < 0) || new Set(ordinals).size !== ordinals.length) {
      grouped.delete(sessionId); continue;
    }
    group.sort((left, right) => left.ordinal! - right.ordinal!);
  }
  return grouped;
}

interface InsightInput {
  rule: string; type: OverviewInsight["type"]; key: string; params: MessageParams;
  object?: string; metric?: string; current: number | null; previous?: number | null;
  sample: number; missing?: number; period?: OverviewPeriod; previousPeriod?: OverviewPeriod;
  values?: OverviewInsight["values"]; evidence: OverviewEvidenceQuery;
}

/** 全部洞察只使用固定报告的事实投影，不读取会话正文，也不推断成果或因果。 */
export function generateOverviewInsights(source: OverviewSource, query: OverviewQuery, pricing: PricingView,
  report: OverviewReport, _now?: Date): { insights: OverviewInsight[]; featuredInsights: OverviewInsight[];
    projectMonths: OverviewProjectMonth[]; modelTransitions: OverviewModelTransition[] } {
  const sessions = new Map(source.sessions.filter(session => matchesGlobalSession(session, query)).map(session => [session.id, session]));
  const allRequests: Request[] = source.requests.flatMap(request => {
    const session = sessions.get(request.sessionId);
    return session ? [{ ...request, session, day: localDay(request.usage.occurredAt ?? "", report.timezone) }] : [];
  });
  const modelMatches = (request: Request) => !query.models?.length || query.models.includes(usageDimensionKey(request.usage.model));
  const requests = allRequests.filter(modelMatches);
  const selected = requests.filter(request => report.range.all || inPeriod(request.usage.occurredAt, report.range, report.timezone));
  const complete = selected.filter(completeTokens);
  const events = source.events.filter(event => sessions.has(event.sessionId) && isActivityEvent(event));
  const selectedEvents = events.filter(event => report.range.all || inPeriod(event.occurredAt, report.range, report.timezone));
  const pairedCalls = pairToolCalls(events);
  const monthly = new Map<string, OverviewProjectMonth & { activitySessions: Set<string> }>();
  const monthRow = (sessionId: string, occurredAt?: string) => {
    const day = localDay(occurredAt, report.timezone);
    if (!day || day < report.range.from || day > report.range.to) return undefined;
    const month = day.slice(0, 7), project = sessions.get(sessionId)?.project ?? null, key = identity(month, project ?? "");
    let row = monthly.get(key);
    if (!row) { row = { month, project, sessions: 0, requests: 0, tokens: null, completeTokenRequests: 0,
      partialTokenRequests: 0, missingTokenRequests: 0, activitySessions: new Set<string>() }; monthly.set(key, row); }
    return row;
  };
  for (const event of selectedEvents) monthRow(event.sessionId, event.occurredAt)?.activitySessions.add(event.sessionId);
  for (const request of allRequests) monthRow(request.sessionId, request.usage.occurredAt)?.activitySessions.add(request.sessionId);
  for (const request of selected) {
    const row = monthRow(request.sessionId, request.usage.occurredAt); if (!row) continue;
    row.requests += 1;
    const hasInput = nonnegative(request.usage.inputTokens), hasOutput = nonnegative(request.usage.outputTokens);
    if (hasInput || hasOutput) row.tokens = (row.tokens ?? 0) + (hasInput ? request.usage.inputTokens! : 0) + (hasOutput ? request.usage.outputTokens! : 0);
    row[hasInput && hasOutput ? "completeTokenRequests" : hasInput || hasOutput ? "partialTokenRequests" : "missingTokenRequests"] += 1;
  }
  const projectMonths = [...monthly.values()].map(({ activitySessions, ...row }) => ({ ...row, sessions: activitySessions.size }))
    .sort((left, right) => left.month.localeCompare(right.month) || right.sessions - left.sessions || (left.project ?? "").localeCompare(right.project ?? ""));
  const modelTransitions: OverviewModelTransition[] = [];
  const insights: OverviewInsight[] = [];
  const seen = new Set<string>();
  const add = (input: InsightInput) => {
    const id = identity(input.rule, input.type, input.object ?? "", input.metric ?? input.key, input.period?.from ?? report.range.from,
      input.period?.to ?? report.range.to);
    if (seen.has(id)) return;
    seen.add(id);
    insights.push({ id, rule: input.rule, type: input.type, descriptor: { key: `overview.insight.${input.key}`, params: input.params },
      object: input.object, metric: input.metric, current: input.current, previous: input.previous,
      sample: input.sample, missing: input.missing ?? 0, period: input.period ?? { from: report.range.from, to: report.range.to },
      previousPeriod: input.previousPeriod, values: input.values, evidence: { ...input.evidence, rule: input.rule } });
  };

  // 01：只有两期同口径完整请求进入构成拆分，部分量保留为缺失数。
  const compareUsage = (comparison: NonNullable<OverviewReport["range"]["comparison"]>, recent: boolean) => {
    const current = periodRequests(requests, comparison.current, report.timezone);
    const previous = periodRequests(requests, comparison.previous, report.timezone);
    if (current.complete.length < 20 || previous.complete.length < 20 || current.tokens === previous.tokens) return;
    const composition = decomposeUsage(previous.complete.length, previous.tokens, current.complete.length, current.tokens)!;
    add({ rule: "01", type: "change", key: recent ? "recentUsage" : "usage",
      params: recent ? { current: current.tokens, previous: previous.tokens } : { current: current.tokens, previous: previous.tokens,
        countContribution: composition.countContribution, meanContribution: composition.meanContribution },
      metric: recent ? "recent_complete_tokens" : "complete_tokens", current: current.tokens, previous: previous.tokens,
      sample: current.complete.length, missing: current.all.length - current.complete.length,
      period: comparison.current, previousPeriod: comparison.previous,
      values: { currentRequests: current.complete.length, previousRequests: previous.complete.length,
        previousMissing: previous.all.length - previous.complete.length, currentInput: current.input, previousInput: previous.input,
        currentOutput: current.output, previousOutput: previous.output, currentMean: composition.currentMean,
        previousMean: composition.previousMean, countContribution: composition.countContribution, meanContribution: composition.meanContribution,
        priceVersion: report.priceVersion }, evidence: { kind: "requests", scope: "usage", period: recent ? "recent" : "current", sort: "tokens" } });
  };
  if (report.range.comparison) compareUsage(report.range.comparison, false);
  if (report.range.recent) compareUsage(report.range.recent, true);
  const activityForPeriod = (period: OverviewPeriod) => {
    const sessionDates = new Map<string, Set<string>>();
    const addActivity = (sessionId: string, occurredAt?: string) => {
      const day = localDay(occurredAt, report.timezone);
      if (!day || day < period.from || day > period.to) return;
      const dates = sessionDates.get(sessionId) ?? new Set<string>(); dates.add(day); sessionDates.set(sessionId, dates);
    };
    for (const event of events) addActivity(event.sessionId, event.occurredAt);
    for (const request of allRequests) addActivity(request.sessionId, request.usage.occurredAt);
    return { sessionDates, days: new Set([...sessionDates.values()].flatMap(dates => [...dates])) };
  };
  if (report.range.comparison) {
    const comparison = report.range.comparison;
    const current = periodRequests(requests, comparison.current, report.timezone);
    const previous = periodRequests(requests, comparison.previous, report.timezone);
    if (current.all.length >= 20 && previous.all.length >= 20 && current.all.length !== previous.all.length) add({ rule: "01", type: "change",
      key: "change.requests", metric: "request_count", params: { current: current.all.length, previous: previous.all.length },
      current: current.all.length, previous: previous.all.length, sample: current.all.length, period: comparison.current, previousPeriod: comparison.previous,
      evidence: { kind: "requests", scope: "usage", period: "current" } });
    const cost = (rows: Request[]) => rows.map(request => pricing.estimate(request.usage, request.session.client))
      .filter(cost => cost.coverage === "complete" && cost.amount !== null);
    const nextCosts = cost(current.all); const previousCosts = cost(previous.all);
    const nextCost = nextCosts.reduce((sum, cost) => sum + cost.amount!, 0); const priorCost = previousCosts.reduce((sum, cost) => sum + cost.amount!, 0);
    if (nextCosts.length >= 20 && previousCosts.length >= 20 && nextCost !== priorCost) add({ rule: "01", type: "change", key: "change.cost",
      metric: "fully_priced_estimate", params: { current: nextCost, previous: priorCost }, current: nextCost, previous: priorCost,
      sample: nextCosts.length, missing: current.all.length - nextCosts.length, period: comparison.current, previousPeriod: comparison.previous,
      values: { priceVersion: report.priceVersion, previousSamples: previousCosts.length, previousMissing: previous.all.length - previousCosts.length },
      evidence: { kind: "requests", scope: "usage", period: "current" } });
    const nextActivity = activityForPeriod(comparison.current); const priorActivity = activityForPeriod(comparison.previous);
    if (nextActivity.sessionDates.size >= 10 && priorActivity.sessionDates.size >= 10) {
      for (const [metric, current, previous] of [["sessions", nextActivity.sessionDates.size, priorActivity.sessionDates.size],
        ["activeDays", nextActivity.days.size, priorActivity.days.size]] as const) if (current !== previous) add({ rule: "13", type: "change",
        key: `change.${metric}`, metric, params: { current, previous }, current, previous, sample: nextActivity.sessionDates.size,
        period: comparison.current, previousPeriod: comparison.previous, evidence: { kind: "sessions", period: "current" } });
    }
  }

  // 02：会话只累计自身完整请求，部分会话不混入完整量的集中度分母。
  const sessionUsage = groupRequests(selected, request => request.sessionId);
  const ranked = [...sessionUsage.entries()].filter(([, group]) => group.every(completeTokens))
    .map(([sessionId, group]) => ({ sessionId, tokens: group.reduce((sum, request) => sum + totalTokens(request), 0) }))
    .sort((left, right) => right.tokens - left.tokens || left.sessionId.localeCompare(right.sessionId));
  const rankedTokens = ranked.reduce((sum, row) => sum + row.tokens, 0);
  if (ranked.length >= 10 && rankedTokens > 0) {
    const topOne = percent(ranked[0]!.tokens, rankedTokens)!;
    const topFive = percent(ranked.slice(0, 5).reduce((sum, row) => sum + row.tokens, 0), rankedTokens)!;
    const values = complete.map(totalTokens);
    add({ rule: "02", type: "feature", key: "concentration", params: { sessions: ranked.length, topOne, topFive },
      metric: "session_token_concentration", current: topFive, sample: ranked.length, missing: sessionUsage.size - ranked.length,
      values: { topOne, topFive, tokens: rankedTokens, median: quantile(values, .5), p90: quantile(values, .9) },
      evidence: { kind: "sessions", scope: "usage", sort: "tokens" } });
  }
  const peak = [...complete].sort((left, right) => totalTokens(right) - totalTokens(left)
    || (left.usage.occurredAt ?? "").localeCompare(right.usage.occurredAt ?? "") || left.usage.id.localeCompare(right.usage.id))[0];
  if (peak) add({ rule: "02", type: "investigation", key: "peak", params: { tokens: totalTokens(peak) },
    object: identity(peak.sessionId, peak.usage.id), metric: "request_peak", current: totalTokens(peak), sample: complete.length,
    missing: selected.length - complete.length, evidence: { kind: "requests", scope: "usage", sessionId: peak.sessionId, requestId: peak.usage.id, sort: "tokens" } });

  // 03、04：频度、广度与日期窗口各保留自己的分母。
  for (const resource of [...report.resources.skills, ...report.resources.mcp]) {
    if (resource.sessions < 5) continue;
    add({ rule: "03", type: "feature", key: "resource", object: resource.id, metric: "resource_breadth",
      params: { name: resource.name, sessions: resource.sessions, calls: resource.uses, weeks: resource.activeWeeks },
      current: resource.sessions, sample: resource.sessions,
      values: { uses: resource.uses, activeWeeks: resource.activeWeeks, persistent: resource.activeWeeks >= 4,
        averagePerSession: resource.averagePerSession, projects: resource.projects.length,
        explicitCalls: resource.explicitCalls, successfulReads: resource.successfulReads },
      evidence: { kind: "resources", resourceId: resource.id } });
  }
  const observations = report.resources.observations;
  const mature = observations.filter(observation => observation.state === "mature");
  if (mature.length >= 5) {
    const repeated = mature.filter(observation => observation.reused === true).length;
    add({ rule: "04", type: "feature", key: "followup", params: { repeated, mature: mature.length },
      metric: "resource_followup", current: repeated, sample: mature.length, missing: observations.length - mature.length,
      values: { repeated, mature: mature.length, ratio: repeated / mature.length,
        observing: observations.filter(observation => observation.state === "observing").length,
        outsideRange: observations.filter(observation => observation.state === "outside_range").length,
        insufficientCoverage: observations.filter(observation => observation.state === "insufficient_coverage").length },
      evidence: { kind: "observations", observationState: "mature" } });
  }

  // 05：委派活动与子用量分别保持全局和模型局部范围。
  const delegation = report.delegation;
  if (delegation.eligibleMainSessions >= 10) add({ rule: "05", type: "feature", key: "delegation",
    params: { delegated: delegation.withChildActivity, parents: delegation.eligibleMainSessions }, metric: "delegated_activity",
    current: delegation.withChildActivity, sample: delegation.eligibleMainSessions, missing: delegation.unknownMainSessions,
    values: { ratio: delegation.withChildActivity / delegation.eligibleMainSessions, forks: delegation.forkSessions,
      unknownRelationships: delegation.unknownRelationshipSessions }, evidence: { kind: "delegation" } });
  if (delegation.assignedRequests >= 20 && delegation.childRequests > 0) add({ rule: "05", type: "feature", key: "childUsage",
    params: { childRequests: delegation.childRequests, requests: delegation.assignedRequests }, metric: "child_requests",
    current: delegation.childRequests, sample: delegation.assignedRequests,
    values: { requestShare: delegation.childRequests / delegation.assignedRequests, childTokens: delegation.childTokens,
      assignedTokens: delegation.assignedTokens }, evidence: { kind: "requests", scope: "usage", relationship: "child" } });
  if (report.range.comparison) {
    const comparison = report.range.comparison;
    const periodDelegation = (period: OverviewPeriod) => {
      const range = { ...report.range, ...period, all: false };
      const selected = selectedSource(source, report.query, range);
      const usageSelected = selectedSource(source, report.query, range, true);
      const activeIds = new Set([...selected.events.map(event => event.sessionId), ...selected.requests.map(request => request.sessionId)]);
      return buildDelegation(source, selected, usageSelected, activeIds, report.timezone);
    };
    const current = periodDelegation(comparison.current); const previous = periodDelegation(comparison.previous);
    if (current.eligibleMainSessions >= 10 && previous.eligibleMainSessions >= 10
      && current.withChildActivity * previous.eligibleMainSessions !== previous.withChildActivity * current.eligibleMainSessions) {
      add({ rule: "05", type: "change", key: "change.delegation", metric: "delegation_share",
        params: { current: percent(current.withChildActivity, current.eligibleMainSessions)!,
          previous: percent(previous.withChildActivity, previous.eligibleMainSessions)! },
        current: current.withChildActivity / current.eligibleMainSessions, previous: previous.withChildActivity / previous.eligibleMainSessions,
        sample: current.eligibleMainSessions, missing: current.unknownMainSessions, period: comparison.current, previousPeriod: comparison.previous,
        values: { currentDelegated: current.withChildActivity, currentEligible: current.eligibleMainSessions,
          previousDelegated: previous.withChildActivity, previousEligible: previous.eligibleMainSessions, previousUnknown: previous.unknownMainSessions },
        evidence: { kind: "delegation", period: "current" } });
    }
  }

  if (report.range.comparison) {
    const comparison = report.range.comparison;
    const current = periodRequests(requests, comparison.current, report.timezone);
    const previous = periodRequests(requests, comparison.previous, report.timezone);
    // 06：缓存比较限定客户端与原始模型，fresh 使用既有分项归一化规则。
    const cacheGroups = (rows: Request[]) => groupRequests(rows, request => knownModel(request)
      ? identity(request.session.client, request.usage.model!) : undefined);
    const currentCache = cacheGroups(current.all); const previousCache = cacheGroups(previous.all);
    for (const [key, currentGroup] of currentCache) {
      const previousGroup = previousCache.get(key) ?? [];
      const eligible = (group: Request[]) => group.flatMap(request => {
        const fresh = pricing.estimate(request.usage, request.session.client).freshInputTokens;
        return nonnegative(request.usage.inputTokens) && nonnegative(request.usage.cachedInputTokens) && nonnegative(fresh)
          ? [{ request, fresh }] : [];
      });
      const currentRows = eligible(currentGroup); const previousRows = eligible(previousGroup);
      if (currentRows.length < 20 || previousRows.length < 20) continue;
      const summarize = (rows: typeof currentRows) => ({ input: rows.reduce((sum, row) => sum + row.request.usage.inputTokens!, 0),
        cache: rows.reduce((sum, row) => sum + row.request.usage.cachedInputTokens!, 0),
        fresh: rows.reduce((sum, row) => sum + row.fresh, 0),
        write: rows.reduce((sum, row) => sum + (row.request.usage.cacheWriteTokens ?? 0), 0) });
      const next = summarize(currentRows); const prior = summarize(previousRows);
      const currentRatio = percent(next.cache, next.input); const previousRatio = percent(prior.cache, prior.input);
      if (currentRatio === null || previousRatio === null || currentRatio === previousRatio && next.fresh === prior.fresh) continue;
      const first = currentRows[0]!.request;
      add({ rule: "06", type: "change", key: "cache", object: key, metric: "cache_input_share",
        params: { client: first.session.client, model: first.usage.model!, current: currentRatio, previous: previousRatio },
        current: currentRatio, previous: previousRatio, sample: currentRows.length, missing: currentGroup.length - currentRows.length,
        period: comparison.current, previousPeriod: comparison.previous,
        values: { currentInput: next.input, previousInput: prior.input, currentFresh: next.fresh, previousFresh: prior.fresh,
          currentCacheRead: next.cache, previousCacheRead: prior.cache, currentCacheWrite: next.write, previousCacheWrite: prior.write,
          previousSamples: previousRows.length, previousMissing: previousGroup.length - previousRows.length },
        evidence: { kind: "requests", scope: "usage", client: first.session.client, model: first.usage.model!, period: "current" } });
    }

    // 07：项目会话与请求使用各自的完整分母，不将项目切面相加为变化原因。
    const currentProjects = groupRequests(current.all, request => request.session.project);
    const previousProjects = groupRequests(previous.all, request => request.session.project);
    for (const project of [...new Set([...currentProjects.keys(), ...previousProjects.keys()])].sort()) {
      const next = currentProjects.get(project) ?? []; const prior = previousProjects.get(project) ?? [];
      const nextComplete = next.filter(completeTokens); const priorComplete = prior.filter(completeTokens);
      if (next.length >= 20 && prior.length >= 20 && next.length !== prior.length) add({ rule: "07", type: "change", key: "project.requests",
        object: project, metric: "project_requests", params: { project, current: next.length, previous: prior.length },
        current: next.length, previous: prior.length, sample: next.length, period: comparison.current, previousPeriod: comparison.previous,
        values: { currentShare: next.length / current.all.length, previousShare: prior.length / previous.all.length },
        evidence: { kind: "requests", scope: "usage", project, period: "current" } });
      const nextTokens = nextComplete.reduce((sum, request) => sum + totalTokens(request), 0);
      const priorTokens = priorComplete.reduce((sum, request) => sum + totalTokens(request), 0);
      if (nextComplete.length >= 20 && priorComplete.length >= 20 && nextTokens !== priorTokens) add({ rule: "07", type: "change", key: "project.tokens",
        object: project, metric: "project_complete_tokens", params: { project, current: nextTokens, previous: priorTokens },
        current: nextTokens, previous: priorTokens, sample: nextComplete.length, missing: next.length - nextComplete.length,
        period: comparison.current, previousPeriod: comparison.previous,
        values: { currentShare: current.tokens > 0 ? nextTokens / current.tokens : null,
          previousShare: previous.tokens > 0 ? priorTokens / previous.tokens : null,
          previousSamples: priorComplete.length, previousMissing: prior.length - priorComplete.length },
        evidence: { kind: "requests", scope: "usage", project, period: "current", sort: "tokens" } });
    }
    const activityProjects = (period: OverviewPeriod) => {
      const groups = new Map<string, Set<string>>();
      const mark = (sessionId: string, occurredAt?: string) => {
        const project = sessions.get(sessionId)?.project;
        if (!project || !inPeriod(occurredAt, period, report.timezone)) return;
        const group = groups.get(project) ?? new Set<string>(); group.add(sessionId); groups.set(project, group);
      };
      for (const event of events) mark(event.sessionId, event.occurredAt);
      for (const request of allRequests) mark(request.sessionId, request.usage.occurredAt);
      return groups;
    };
    const nextActivity = activityProjects(comparison.current); const priorActivity = activityProjects(comparison.previous);
    for (const [project, next] of nextActivity) {
      const prior = priorActivity.get(project) ?? new Set<string>();
      if (next.size < 10 || prior.size < 10 || next.size === prior.size) continue;
      add({ rule: "07", type: "change", key: "project.sessions", object: project, metric: "project_sessions",
        params: { project, current: next.size, previous: prior.size }, current: next.size, previous: prior.size, sample: next.size,
        period: comparison.current, previousPeriod: comparison.previous, evidence: { kind: "sessions", project, period: "current" } });
    }
  }

  // 08：模型分布、同一会话切换、主子模型组合是三个独立统计对象。
  const projects = groupRequests(selected, request => request.session.project);
  for (const [project, group] of projects) {
    const known = group.filter(knownModel);
    if (known.length < 20 || new Set(known.map(request => request.sessionId)).size < 5) continue;
    const models = [...groupRequests(known, request => request.usage.model).entries()].sort((left, right) => right[1].length - left[1].length
      || left[0].localeCompare(right[0]));
    const [model, rows] = models[0]!;
    add({ rule: "08", type: "feature", key: "model", object: identity(project, model), metric: "project_model",
      params: { project, model, requests: rows.length, total: known.length }, current: rows.length, sample: known.length,
      missing: group.length - known.length, values: { share: rows.length / known.length, models: models.length },
      evidence: { kind: "requests", scope: "usage", project, model } });
  }
  const ordered = orderedSessions(allRequests);
  let comparableSessions = 0; let switchedSessions = 0; let switches = 0; let comparablePairs = 0;
  const switchGroups = new Map<string, { from: string; to: string; count: number; sessions: Set<string> }>();
  for (const group of ordered.values()) {
    let pairs = 0; let changes = 0;
    for (let index = 1; index < group.length; index++) {
      const left = group[index - 1]!; const right = group[index]!;
      if (!left.day || !right.day || !knownModel(left) || !knownModel(right) || !modelMatches(left) || !modelMatches(right)
        || !inPeriod(left.usage.occurredAt, report.range, report.timezone) || !inPeriod(right.usage.occurredAt, report.range, report.timezone)) continue;
      pairs += 1;
      if (left.usage.model !== right.usage.model) {
        changes += 1;
        const key = identity(left.usage.model!, right.usage.model!);
        const group = switchGroups.get(key) ?? { from: left.usage.model!, to: right.usage.model!, count: 0, sessions: new Set<string>() };
        group.count += 1; group.sessions.add(left.sessionId); switchGroups.set(key, group);
      }
    }
    if (pairs) comparableSessions += 1;
    if (changes) switchedSessions += 1;
    comparablePairs += pairs; switches += changes;
  }
  for (const group of switchGroups.values()) modelTransitions.push({ kind: "switch", fromModel: group.from, toModel: group.to,
    count: group.count, sessions: group.sessions.size, evidence: { kind: "sequence", scope: "usage", transition: "switch",
      modelFrom: group.from, modelTo: group.to, sort: "ordinal" } });
  if (comparableSessions >= 10) add({ rule: "08", type: "feature", key: "switch", metric: "session_model_switch",
    params: { switched: switchedSessions, sessions: comparableSessions }, current: switchedSessions, sample: comparableSessions,
    missing: sessionUsage.size - comparableSessions, values: { switches, comparablePairs, ratio: switchedSessions / comparableSessions },
    evidence: { kind: "sequence", scope: "usage", sort: "ordinal" } });
  const sessionModels = new Map([...groupRequests(selected.filter(knownModel), request => request.sessionId)].map(([sessionId, rows]) =>
    [sessionId, new Set(rows.map(request => request.usage.model!))]));
  const childModels = new Map<string, { parent: string; child: string; count: number; sessions: Set<string> }>();
  for (const session of sessions.values()) {
    if (session.relationship !== "child" || !session.parentSessionId) continue;
    for (const parent of sessionModels.get(session.parentSessionId) ?? []) for (const child of sessionModels.get(session.id) ?? []) {
      const key = identity(parent, child); const group = childModels.get(key) ?? { parent, child, count: 0, sessions: new Set<string>() };
      group.count += 1; group.sessions.add(session.parentSessionId); childModels.set(key, group);
    }
  }
  for (const [key, group] of childModels) {
    const evidence: OverviewEvidenceQuery = { kind: "delegation", scope: "usage", transition: "delegation", modelFrom: group.parent, modelTo: group.child };
    modelTransitions.push({ kind: "delegation", fromModel: group.parent, toModel: group.child, count: group.count, sessions: group.sessions.size, evidence });
    if (group.sessions.size >= 10) add({ rule: "08", type: "feature", key: "childModels",
      object: key, metric: "delegated_model_pair", params: { parentModel: group.parent, childModel: group.child, parents: group.sessions.size },
      current: group.sessions.size, sample: group.sessions.size, evidence });
  }

  // 09、10：只统计实际使用，资源对在会话或真实轮次中去重。
  for (const resource of report.resources.mcp) {
    const knownTools = resource.tools.filter(tool => tool.name && tool.name !== "none");
    const calls = knownTools.reduce((sum, tool) => sum + tool.count, 0);
    if (calls < 20) continue;
    add({ rule: "09", type: "feature", key: "mcp", object: resource.id, metric: "mcp_tools",
      params: { server: resource.name, tools: knownTools.length, calls, sessions: resource.sessions }, current: knownTools.length,
      sample: calls, missing: resource.uses - calls, values: { sessions: resource.sessions },
      evidence: { kind: "resources", resourceId: resource.id, resourceKind: "mcp" } });
    const tool = [...knownTools].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))[0];
    if (tool) add({ rule: "09", type: "feature", key: "mcpTool", object: identity(resource.id, tool.name), metric: "mcp_tool_share",
      params: { server: resource.name, tool: tool.name, calls: tool.count, total: calls }, current: tool.count, sample: calls,
      missing: resource.uses - calls, values: { share: tool.count / calls, sessions: tool.sessions },
      evidence: { kind: "resources", resourceId: resource.id, tool: tool.name, resourceKind: "mcp" } });
  }
  for (const combination of [...report.resources.combinations.sessions, ...report.resources.combinations.turns]) {
    if (combination.sessions < 3) continue;
    add({ rule: "10", type: "feature", key: `combination.${combination.unit}`, object: combination.id, metric: `resource_pair_${combination.unit}`,
      params: { first: combination.names[0], second: combination.names[1], sessions: combination.sessions,
        ...(combination.unit === "turn" ? { turns: combination.count } : {}) }, current: combination.count, sample: combination.sessions,
      values: { unit: combination.unit, sessions: combination.sessions },
      evidence: { kind: "combinations", resourceId: combination.resources[0], resourceId2: combination.resources[1], unit: combination.unit } });
  }

  // 11：单条明确失败可调查，小样本不生成百分比结论。
  for (const tool of report.process.tools) {
    if (!tool.results.failure) continue;
    const eligible = tool.results.known >= 20 && (tool.results.coverage ?? 0) >= .8;
    add({ rule: "11", type: "investigation", key: eligible ? "failure" : "singleFailure", object: tool.key, metric: "confirmed_tool_failure",
      params: eligible ? { tool: tool.name, failures: tool.results.failure, days: tool.days.filter(day => day.failures > 0).length,
        known: tool.results.known, unknown: tool.results.unknown } : { tool: tool.name },
      current: tool.results.failure, sample: tool.results.known, missing: tool.results.unknown,
      values: { success: tool.results.success, failure: tool.results.failure, unknown: tool.results.unknown,
        resultCoverage: tool.results.coverage, failureRate: eligible ? tool.results.failureRate : null,
        failureDays: tool.days.filter(day => day.failures > 0).length, sessions: tool.sessions, server: tool.server ?? null },
      evidence: { kind: "failures", tool: tool.name, status: "failure" } });
  }
  if (report.range.comparison) {
    const comparison = report.range.comparison;
    const failureGroups = (period: OverviewPeriod) => {
      const groups = new Map<string, typeof pairedCalls>();
      for (const call of pairedCalls) if (inPeriod(call.occurredAt, period, report.timezone)) {
        const key = identity(call.tool ?? "", call.resource?.server ?? "");
        const group = groups.get(key) ?? []; group.push(call); groups.set(key, group);
      }
      return groups;
    };
    const currentGroups = failureGroups(comparison.current); const previousGroups = failureGroups(comparison.previous);
    for (const [key, currentGroup] of currentGroups) {
      const previousGroup = previousGroups.get(key) ?? [];
      const count = (rows: typeof pairedCalls) => ({ known: rows.filter(row => row.status === "success" || row.status === "failure").length,
        failure: rows.filter(row => row.status === "failure").length });
      const current = count(currentGroup); const previous = count(previousGroup);
      if (current.known < 20 || previous.known < 20 || current.known / currentGroup.length < .8
        || previous.known / previousGroup.length < .8 || current.failure * previous.known === previous.failure * current.known) continue;
      add({ rule: "11", type: "change", key: "change.failureRate", object: key, metric: "known_failure_rate",
        params: { tool: currentGroup[0]!.tool ?? "", current: percent(current.failure, current.known)!, previous: percent(previous.failure, previous.known)! },
        current: current.failure / current.known, previous: previous.failure / previous.known, sample: current.known,
        missing: currentGroup.length - current.known, period: comparison.current, previousPeriod: comparison.previous,
        values: { currentFailures: current.failure, currentKnown: current.known, currentCalls: currentGroup.length,
          previousFailures: previous.failure, previousKnown: previous.known, previousCalls: previousGroup.length },
        evidence: { kind: "tools", tool: currentGroup[0]!.tool, period: "current" } });
    }
  }

  // 12：原始调用身份与顺序保留，后续成功不改称重试或任务恢复。
  for (const sequence of report.process.failureSequences) {
    if (!sequence.calls.length) continue;
    add({ rule: "12", type: "investigation", key: "followupCalls", object: identity(sequence.sessionId, sequence.turnId, sequence.tool),
      metric: "later_same_turn_calls", params: { tool: sequence.tool, calls: sequence.calls.length, failures: sequence.failures.length },
      current: sequence.calls.length, sample: sequence.failures.length,
      missing: sequence.calls.filter(call => call.status === "unknown").length,
      values: { success: sequence.calls.filter(call => call.status === "success").length,
        failure: sequence.calls.filter(call => call.status === "failure").length,
        unknown: sequence.calls.filter(call => call.status === "unknown").length, truncated: sequence.truncated },
      evidence: { kind: "sequence", sessionId: sequence.sessionId, turnId: sequence.turnId, tool: sequence.tool, sort: "ordinal" } });
  }

  // 13：日期集合由真实活动建立，不以会话摘要跨度填满中间日期。
  if (report.activity.datedSessions >= 10) add({ rule: "13", type: "feature", key: "crossDay", metric: "cross_day_sessions",
    params: { crossDay: report.activity.crossDaySessions, sessions: report.activity.datedSessions },
    current: report.activity.crossDaySessions, sample: report.activity.datedSessions, missing: report.activity.missingTimeSessions,
    values: { ratio: report.activity.crossDaySessions / report.activity.datedSessions }, evidence: { kind: "sessions" } });
  if (report.range.comparison) {
    const comparison = report.range.comparison;
    const current = activityForPeriod(comparison.current); const previous = activityForPeriod(comparison.previous);
    const currentCrossDay = [...current.sessionDates.values()].filter(dates => dates.size > 1).length;
    const previousCrossDay = [...previous.sessionDates.values()].filter(dates => dates.size > 1).length;
    if (current.sessionDates.size >= 10 && previous.sessionDates.size >= 10
      && currentCrossDay * previous.sessionDates.size !== previousCrossDay * current.sessionDates.size) add({ rule: "13", type: "change", key: "change.crossDay",
      metric: "cross_day_share", params: { current: percent(currentCrossDay, current.sessionDates.size)!, previous: percent(previousCrossDay, previous.sessionDates.size)! },
      current: currentCrossDay / current.sessionDates.size, previous: previousCrossDay / previous.sessionDates.size, sample: current.sessionDates.size,
      period: comparison.current, previousPeriod: comparison.previous,
      values: { currentCrossDay, previousCrossDay, currentSessions: current.sessionDates.size, previousSessions: previous.sessionDates.size },
      evidence: { kind: "sessions", period: "current" } });
  }

  // 14：输入走势限定同一模型片段，压缩只标位置和已记录分项。
  const compressionBySession = new Map<string, typeof selectedEvents>();
  for (const event of selectedEvents) if (event.kind === "compression") {
    const group = compressionBySession.get(event.sessionId) ?? []; group.push(event); compressionBySession.set(event.sessionId, group);
  }
  for (const [sessionId, group] of ordered) {
    let segment: Request[] = [];
    const flush = () => {
      if (segment.length < 2) { segment = []; return; }
      const first = segment[0]!; const last = segment.at(-1)!;
      const compression = (compressionBySession.get(sessionId) ?? []).filter(event => event.ordinal >= first.ordinal! && event.ordinal <= last.ordinal!);
      if (first.usage.inputTokens !== last.usage.inputTokens || compression.length) add({ rule: "14", type: "investigation", key: "input",
        object: identity(sessionId, first.usage.id, last.usage.id), metric: "input_sequence",
        params: { model: first.usage.model!, requests: segment.length, first: first.usage.inputTokens!, last: last.usage.inputTokens!, compressions: compression.length },
        current: last.usage.inputTokens!, previous: first.usage.inputTokens!, sample: segment.length,
        values: { compressions: compression.length, firstRequest: first.usage.id, lastRequest: last.usage.id,
          firstCacheRead: first.usage.cachedInputTokens ?? null, lastCacheRead: last.usage.cachedInputTokens ?? null,
          firstCacheWrite: first.usage.cacheWriteTokens ?? null, lastCacheWrite: last.usage.cacheWriteTokens ?? null },
        evidence: { kind: "sequence", scope: "usage", sessionId, model: first.usage.model!, ordinalFrom: first.ordinal!, ordinalTo: last.ordinal!, sort: "ordinal" } });
      segment = [];
    };
    for (const request of group) {
      if (!request.day || !knownModel(request) || !nonnegative(request.usage.inputTokens) || !modelMatches(request)
        || !inPeriod(request.usage.occurredAt, report.range, report.timezone)) { flush(); continue; }
      if (segment.length && segment[0]!.usage.model !== request.usage.model) flush();
      segment.push(request);
    }
    flush();
  }
  if (report.process.compressions > 0) add({ rule: "14", type: "investigation", key: "compression", metric: "compression_events",
    params: { count: report.process.compressions, sessions: report.process.compressionSessions },
    current: report.process.compressions, sample: report.process.compressionSessions, evidence: { kind: "compressions" } });

  // 15：两期在同一快照中计算，独立仓库保留各自文件基线。
  if (report.range.comparison) for (const repository of report.repositories) {
    if (repository.state !== "ready" || !repository.version || !repository.baselineHash) continue;
    for (const hotspot of repository.hotspots) for (const metric of ["read", "edit", "failure"] as const) {
      const previous = hotspot.previous?.[metric]; const current = hotspot.comparison?.[metric];
      if (current === undefined || previous === undefined || previous === current || !previous && !current) continue;
      add({ rule: "15", type: "change", key: `hotspot.${metric}`, object: identity(repository.repository.id, hotspot.path), metric: `repository_${metric}`,
        params: { repository: repository.repository.name, path: hotspot.path, current, previous }, current, previous,
        sample: current, period: report.range.comparison.current, previousPeriod: report.range.comparison.previous,
        values: { repositoryId: repository.repository.id, repositoryVersion: repository.version, baselineHash: repository.baselineHash,
          path: hotspot.path, currentFrom: report.range.comparison.current.from, currentTo: report.range.comparison.current.to,
          previousFrom: report.range.comparison.previous.from, previousTo: report.range.comparison.previous.to,
          read: hotspot.comparison?.read ?? null, edit: hotspot.comparison?.edit ?? null, failure: hotspot.comparison?.failure ?? null },
        evidence: { kind: "activity", project: repository.repository.path, period: "current" } });
    }
  }

  // 16：两期覆盖按可归日事实比较，无时间记录单列为报告整体缺口。
  if (report.range.comparison) {
    const comparison = report.range.comparison;
    const next = periodRequests(requests, comparison.current, report.timezone); const prior = periodRequests(requests, comparison.previous, report.timezone);
    const validTiming = (request: Request) => validDuration(request.usage);
    for (const [metric, predicate] of [["tokens", completeTokens], ["models", knownModel], ["timing", validTiming]] as const) {
      const currentKnown = next.all.filter(predicate).length; const previousKnown = prior.all.filter(predicate).length;
      if (next.all.length < 20 || prior.all.length < 20 || currentKnown * prior.all.length === previousKnown * next.all.length) continue;
      add({ rule: "16", type: "change", key: `coverage.${metric}`, metric: `coverage_${metric}`,
        params: { currentKnown, currentTotal: next.all.length, previousKnown, previousTotal: prior.all.length },
        current: currentKnown / next.all.length, previous: previousKnown / prior.all.length, sample: next.all.length,
        missing: next.all.length - currentKnown, period: comparison.current, previousPeriod: comparison.previous,
        values: { currentKnown, currentTotal: next.all.length, previousKnown, previousTotal: prior.all.length },
        evidence: { kind: "requests", scope: "usage", period: "current" } });
    }
    const toolCoverage = (period: OverviewPeriod) => pairedCalls.filter(event => inPeriod(event.occurredAt, period, report.timezone));
    const currentTools = toolCoverage(comparison.current); const previousTools = toolCoverage(comparison.previous);
    const currentKnown = currentTools.filter(event => event.status === "success" || event.status === "failure").length;
    const previousKnown = previousTools.filter(event => event.status === "success" || event.status === "failure").length;
    if (currentTools.length >= 20 && previousTools.length >= 20
      && currentKnown * previousTools.length !== previousKnown * currentTools.length) add({ rule: "16", type: "change", key: "coverage.tools",
      metric: "coverage_tools", params: { currentKnown, currentTotal: currentTools.length, previousKnown, previousTotal: previousTools.length },
      current: currentKnown / currentTools.length, previous: previousKnown / previousTools.length, sample: currentTools.length,
      missing: currentTools.length - currentKnown, period: comparison.current, previousPeriod: comparison.previous,
      values: { currentKnown, currentTotal: currentTools.length, previousKnown, previousTotal: previousTools.length },
      evidence: { kind: "tools", period: "current" } });
  }
  const coverage = report.coverage;
  if (coverage.missingTimeEvents || coverage.missingTimeRequests || coverage.missingTimeResources) add({ rule: "16", type: "investigation", key: "undated",
    metric: "undated_records", params: { events: coverage.missingTimeEvents, requests: coverage.missingTimeRequests, resources: coverage.missingTimeResources },
    current: coverage.missingTimeRequests, sample: source.requests.length, missing: coverage.missingTimeRequests,
    values: { events: coverage.missingTimeEvents, requests: coverage.missingTimeRequests, resources: coverage.missingTimeResources },
    evidence: { kind: "requests", scope: "usage", undated: true } });
  const sourceGaps = coverage.gaps.filter(gap => ["source_missing", "source_unavailable", "parse_error", "unsupported_format", "incomplete_record"].includes(gap.kind));
  if (sourceGaps.length) add({ rule: "16", type: "investigation", key: "sourceGaps", metric: "source_gaps",
    params: { count: sourceGaps.length }, current: sourceGaps.length, sample: sourceGaps.length, evidence: { kind: "sessions" } });

  // 计时分组沿用基础报告，不套用吐字速度的输出量门槛，也不自动判定异常。
  for (const timing of report.process.timing) {
    if (!timing.model) continue;
    if (timing.samples >= 20 && timing.duration.medianMs !== null && timing.duration.p90Ms !== null) add({ rule: "16", type: "feature", key: "timing",
      object: timing.id, metric: "timing_distribution", params: { client: timing.client, model: timing.model, samples: timing.samples,
        median: timing.duration.medianMs, p90: timing.duration.p90Ms }, current: timing.duration.medianMs, sample: timing.samples,
      values: { window: timing.window, basis: timing.basis, method: timing.method, p90: timing.duration.p90Ms, speedSamples: timing.speed.samples },
      evidence: { kind: "timing", scope: "usage", timingGroup: timing.id, sort: "duration" } });
    const longest = timing.longest[0];
    if (longest) add({ rule: "16", type: "investigation", key: "longestRequest", object: timing.id, metric: "longest_request",
      params: { client: timing.client, model: timing.model, duration: longest.durationMs }, current: longest.durationMs, sample: timing.samples,
      values: { window: timing.window, basis: timing.basis, method: timing.method, requestId: longest.requestId },
      evidence: { kind: "timing", scope: "usage", timingGroup: timing.id, sessionId: longest.sessionId, requestId: longest.requestId, sort: "duration" } });
  }
  insights.sort((left, right) => left.rule.localeCompare(right.rule) || left.type.localeCompare(right.type)
    || (left.metric === right.metric ? (right.current ?? -1) - (left.current ?? -1) : (left.metric ?? "").localeCompare(right.metric ?? ""))
    || left.id.localeCompare(right.id));
  modelTransitions.sort((left, right) => left.kind.localeCompare(right.kind) || right.count - left.count
    || left.fromModel.localeCompare(right.fromModel) || left.toModel.localeCompare(right.toModel));
  return { insights, featuredInsights: selectFeaturedInsights(insights), projectMonths, modelTransitions };
}
