import type { OverviewQuery, OverviewRequest, WeeklyReview, WeeklyReviewDetailPage, WeeklyReviewDetailQuery,
  WeeklyReviewDistribution, WeeklyReviewEvent, WeeklyReviewRank, WeeklyReviewRecord } from "../overview-contracts.js";
import type { SessionSummary } from "../session-contracts.js";
import type { PricingView } from "../usage/pricing.js";
import { clientName } from "../clients.js";
import { activityTime, inPeriod, resolveTimezone } from "./dates.js";
import { weeklyReviewRange, type WeeklyRoundFact, type WeeklySessionFacts } from "./weekly-review-facts.js";

const numeric = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value >= 0;
const sumKnown = (values: (number | null | undefined)[]) => { const known = values.filter((value): value is number => value !== null && value !== undefined); return known.length ? known.reduce((sum, value) => sum + value, 0) : null; };
const roundTokens = (request: OverviewRequest): number | null => numeric(request.usage.inputTokens) && numeric(request.usage.outputTokens)
  ? request.usage.inputTokens + request.usage.outputTokens : null;

export function weeklyDistribution(values: (number | null | undefined)[], missing = 0): WeeklyReviewDistribution {
  const samples = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value)).sort((a, b) => a - b);
  const quantile = (fraction: number): number | null => {
    if (!samples.length) return null;
    const index = (samples.length - 1) * fraction, left = Math.floor(index), right = Math.ceil(index);
    return samples[left]! + (samples[right]! - samples[left]!) * (index - left);
  };
  return { average: samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : null,
    median: quantile(0.5), p90: quantile(0.9), maximum: samples.at(-1) ?? null, samples: samples.length, missing: values.length - samples.length + missing };
}
function record(session: SessionSummary, extra: Partial<WeeklyReviewRecord>): WeeklyReviewRecord {
  return { id: session.id, sessionId: session.id, title: session.title, titleOrigin: session.titleOrigin,
    client: session.client, project: session.project, relationship: session.relationship, ...extra };
}
function roundRecord(session: SessionSummary, round: WeeklyRoundFact): WeeklyReviewRecord {
  return record(session, { id: JSON.stringify([session.id, round.turnId]), title: round.title || session.title,
    ...(round.title ? { titleOrigin: "first_user" } : {}), turnId: round.turnId, messageId: round.messageId,
    startedAt: round.startedAt, endedAt: round.endedAt, occurredAt: round.endedAt ?? round.startedAt, completion: round.completion,
    eligible: round.eligible ?? round.completion === "explicit", finalEvidence: round.finalEvidence,
    steps: round.steps ?? undefined, toolCalls: round.toolCalls, tokens: round.tokens, durationMs: round.durationMs });
}
type RequestRecord = WeeklyReviewRecord & { state: "zero" | "partial" | "full" | "unknown" };
function requestRecord(session: SessionSummary, request: OverviewRequest, pricing: PricingView, title?: string, prices?: Map<string, NonNullable<WeeklyReviewRecord["cost"]>["price"]>): RequestRecord {
  const usage = request.usage, cost = pricing.estimate(usage, session.client);
  if (cost.price && prices) {
    const key = JSON.stringify([cost.priceProvider, cost.priceModel, cost.priceEffectiveFrom, cost.priceEffectiveTo,
      cost.appliedContextThreshold, cost.priceMatchBasis, cost.apiBaselineForProvider]);
    const shared = prices.get(key);
    if (shared) cost.price = shared; else prices.set(key, cost.price);
  }
  const input = numeric(usage.inputTokens) ? usage.inputTokens : undefined;
  const cached = numeric(usage.cachedInputTokens) ? usage.cachedInputTokens : undefined;
  const consistent = input !== undefined && input > 0 && cached !== undefined && cached <= input;
  const state = !consistent ? "unknown" : input > 0 && cached === 0 ? "zero" : cached < input ? "partial" : "full";
  const ordinary = cost.freshInputTokens;
  // estimate附带适用上下文档位，差额只基于普通未缓存输入，不把缓存写入混入。
  const premium = cost.reason !== "semantics_unknown" && ordinary !== undefined && cost.price?.input !== undefined && cost.price.cacheRead !== undefined
    ? ordinary * (cost.price.input - cost.price.cacheRead) / 1_000_000 : null;
  return { ...record(session, { id: JSON.stringify([session.id, usage.id]), requestId: usage.id, messageId: usage.messageId,
    turnId: usage.turnId, title: title || session.title, ...(title ? { titleOrigin: "first_user" } : {}), occurredAt: usage.occurredAt,
    inputTokens: input, cachedInputTokens: cached, freshInputTokens: ordinary, hypotheticalPremium: premium,
    cacheShare: consistent && input > 0 ? cached / input : null, model: usage.model, reasoningEffort: usage.reasoningEffort,
    tokens: roundTokens(request), cost }), state };
}
function costCoverage(rows: WeeklyReviewRecord[]): WeeklyReviewRank["costCoverage"] {
  return !rows.length || rows.every(row => row.cost?.amount === null || row.cost === undefined) ? "missing"
    : rows.some(row => row.cost?.coverage !== "complete") ? "partial" : "complete";
}
function rank(groups: Map<string, { count: number; rows: WeeklyReviewRecord[]; sessions: Set<string>; name: string }>): WeeklyReviewRank[] {
  const total = [...groups.values()].reduce((sum, group) => sum + group.count, 0);
  return [...groups].map(([key, group]) => ({ key, name: group.name, count: group.count, share: total ? group.count / total : null,
    sessions: group.sessions.size, requests: group.rows.filter(row => row.requestId !== undefined).length,
    tokens: sumKnown(group.rows.map(row => row.tokens)), tokenSamples: group.rows.filter(row => row.requestId !== undefined && row.tokens != null).length,
    tokenMissing: group.rows.filter(row => row.requestId !== undefined && row.tokens == null).length,
    estimatedCost: sumKnown(group.rows.map(row => row.cost?.amount)), costCoverage: costCoverage(group.rows) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
function groupedRank(rows: WeeklyReviewRecord[], keyOf: (row: WeeklyReviewRecord) => string, nameOf?: (key: string) => string): WeeklyReviewRank[] {
  const groups = new Map<string, { count: number; rows: WeeklyReviewRecord[]; sessions: Set<string>; name: string }>();
  for (const row of rows) {
    const key = keyOf(row), group = groups.get(key) ?? { count: 0, rows: [], sessions: new Set<string>(), name: nameOf?.(key) ?? key };
    group.count += 1; group.rows.push(row); group.sessions.add(row.sessionId); groups.set(key, group);
  }
  return rank(groups);
}
function top(rows: WeeklyReviewRecord[], key: "durationMs" | "tokens" | "freshInputTokens", count = 3): WeeklyReviewRecord[] {
  return rows.filter(row => row[key] !== null && row[key] !== undefined).sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1) || a.id.localeCompare(b.id)).slice(0, count);
}

interface WeeklyReviewData {
  review: WeeklyReview;
  rows: Record<WeeklyReviewDetailQuery["kind"], WeeklyReviewRecord[]>;
  ranks: Partial<Record<WeeklyReviewDetailQuery["kind"], WeeklyReviewRank[]>>;
}

/** 事件窗口与结束轮次窗口独立聚合，跨周轮次仍使用完整已留存投入。 */
export function buildWeeklyReview(facts: WeeklySessionFacts[], query: OverviewQuery, pricing: PricingView, now: Date): WeeklyReviewData {
  const range = weeklyReviewRange(query, now), timezone = resolveTimezone(query.timezone), version = query.version!;
  const prices = new Map<string, NonNullable<WeeklyReviewRecord["cost"]>["price"]>();
  const unknownForks = facts.filter(fact => fact.session.relationship === "fork"
    && fact.session.gaps.some(gap => gap.messageDescriptor?.key === "diagnostics.sessions.parser.m019"));
  const excludedForkIds = new Set(unknownForks.map(fact => fact.session.id));
  const userFacts = facts.filter(fact => fact.session.relationship !== "child" && !excludedForkIds.has(fact.session.id)),
    childFacts = facts.filter(fact => fact.session.relationship === "child");
  const hasActivity = (fact: WeeklySessionFacts) => Boolean(fact.events.length || fact.requests.length
    || fact.activityDays?.some(day => day >= range.from && day <= range.to));
  const activeFacts = userFacts.filter(hasActivity);
  const startedRounds = userFacts.flatMap(fact => fact.rounds.filter(round => inPeriod(round.startedAt, range, timezone)).map(round => roundRecord(fact.session, round)));
  const sessionRoundGroups = new Map<string, { count: number; latest: WeeklyReviewRecord }>();
  for (const round of startedRounds) {
    const group = sessionRoundGroups.get(round.sessionId);
    sessionRoundGroups.set(round.sessionId, { count: (group?.count ?? 0) + 1,
      latest: !group || Date.parse(round.startedAt!) > Date.parse(group.latest.startedAt!) ? round : group.latest });
  }
  const sessionRounds = userFacts.flatMap(fact => {
    const group = sessionRoundGroups.get(fact.session.id);
    return group ? [record(fact.session, { roundCount: group.count, occurredAt: group.latest.startedAt,
      messageId: group.latest.messageId, turnId: group.latest.turnId })] : [];
  });
  const allRounds = userFacts.flatMap(fact => fact.rounds.map(round => roundRecord(fact.session, round)));
  const endedRounds = allRounds.filter(round => round.eligible && inPeriod(round.endedAt, range, timezone));
  const inferredIncluded = endedRounds.filter(round => round.completion === "inferred").length;
  const distribution = (key: "steps" | "toolCalls" | "tokens" | "durationMs") => {
    const result = weeklyDistribution(endedRounds.map(row => row[key]));
    const inferredSamples = endedRounds.filter(row => row.completion === "inferred" && row[key] != null).length;
    return { ...result, ...(inferredSamples ? { inferredSamples } : {}) };
  };
  const inferredRounds = allRounds.filter(round => round.completion === "inferred" && inPeriod(round.endedAt, range, timezone));
  const missingEndTime = startedRounds.filter(round => round.completion !== "unconfirmed" && !round.endedAt);
  const unconfirmedRounds = startedRounds.filter(round => round.completion === "unconfirmed");
  const requestRows = userFacts.flatMap(fact => {
    const titles = new Map(fact.rounds.map(round => [round.turnId, round.title]));
    return fact.requests.map(request => requestRecord(fact.session, request, pricing, request.usage.turnId ? titles.get(request.usage.turnId) : undefined, prices));
  });
  const childRows = childFacts.flatMap(fact => fact.requests.map(request => requestRecord(fact.session, request, pricing, undefined, prices)));
  const compressionEvents = activeFacts.flatMap(fact => fact.events.filter(event => event.kind === "compression").map(event => record(fact.session,
    { id: JSON.stringify([fact.session.id, event.id]), messageId: event.id, turnId: event.turnId, occurredAt: event.occurredAt, compressions: 1 })));
  const observable = activeFacts.filter(fact => fact.compressionSupported && fact.compressionComplete);
  const compressionLeaders = activeFacts.flatMap(fact => {
    const events = fact.events.filter(event => event.kind === "compression");
    return events.length ? [record(fact.session, { compressions: events.length, messageId: events[0]!.id, occurredAt: events.at(-1)!.occurredAt })] : [];
  }).sort((a, b) => b.compressions! - a.compressions! || a.id.localeCompare(b.id));
  const uncompressed = observable.filter(fact => fact.retainedCompressions === 0).flatMap(fact => {
    const requests = fact.requests.filter(request => numeric(request.usage.inputTokens)).sort((a, b) => b.usage.inputTokens! - a.usage.inputTokens!);
    return requests.length ? [requestRecord(fact.session, requests[0]!, pricing, undefined, prices)] : [];
  });
  const promptGroups = new Map<string, { session: SessionSummary; event: WeeklyReviewEvent; count: number }>();
  for (const fact of userFacts) for (const event of fact.events) if (event.kind === "user" && event.promptCharacters !== undefined) {
    const key = JSON.stringify([fact.session.id, event.turnId, event.recordLine]);
    const group = promptGroups.get(key) ?? { session: fact.session, event, count: 0 };
    group.count += event.promptCharacters; promptGroups.set(key, group);
  }
  const prompts = [...promptGroups].map(([id, group]) => record(group.session, { id, messageId: group.event.id, turnId: group.event.turnId,
    title: group.event.promptPreview?.trim() || group.session.title,
    titleOrigin: group.event.promptPreview?.trim() ? "first_user" : group.session.titleOrigin,
    occurredAt: group.event.occurredAt, promptCharacters: group.count }));
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, messages: 0 }));
  const weekdays = Array.from({ length: 7 }, (_, weekday) => ({ weekday, messages: 0 }));
  const weekdayHours = new Map<string, { weekday: number; hour: number; messages: number }>();
  for (const prompt of prompts) {
    const time = activityTime(prompt.occurredAt, timezone); if (!time) continue;
    hours[time.hour]!.messages += 1; weekdays[time.weekday]!.messages += 1;
    const key = `${time.weekday}:${time.hour}`, group = weekdayHours.get(key) ?? { ...time, messages: 0 };
    group.messages += 1; weekdayHours.set(key, group);
  }
  const agentsGroups = new Map<string, { count: number; rows: WeeklyReviewRecord[]; sessions: Set<string>; name: string }>();
  for (const round of startedRounds) {
    const key = round.client, group = agentsGroups.get(key) ?? { count: 0, rows: [], sessions: new Set<string>(), name: clientName(key as SessionSummary["client"]) };
    group.count += 1; group.sessions.add(round.sessionId); agentsGroups.set(key, group);
  }
  for (const request of requestRows) {
    const key = request.client, group = agentsGroups.get(key) ?? { count: 0, rows: [], sessions: new Set<string>(), name: clientName(key as SessionSummary["client"]) };
    group.rows.push(request); group.sessions.add(request.sessionId); agentsGroups.set(key, group);
  }
  const agents = rank(agentsGroups), models = groupedRank(requestRows, row => row.model ?? "unknown"), reasoning = groupedRank(requestRows, row => row.reasoningEffort ?? "unknown");
  const projectGroups = new Map<string, { count: number; rows: WeeklyReviewRecord[]; sessions: Set<string>; name: string }>();
  for (const round of endedRounds) {
    const key = round.project ?? "unknown", group = projectGroups.get(key) ?? { count: 0, rows: [], sessions: new Set<string>(), name: key };
    group.count += 1; group.sessions.add(round.sessionId); projectGroups.set(key, group);
  }
  for (const request of requestRows) {
    const key = request.project ?? "unknown", group = projectGroups.get(key) ?? { count: 0, rows: [], sessions: new Set<string>(), name: key };
    group.rows.push(request); group.sessions.add(request.sessionId); projectGroups.set(key, group);
  }
  const projects = rank(projectGroups), calls = userFacts.flatMap(fact => fact.events.filter(event => event.kind === "tool_call")
    .map(event => ({ fact, event })));
  const toolRows = calls.filter(({ event }) => event.status === "failure").map(({ fact, event }) => record(fact.session,
    { id: JSON.stringify([fact.session.id, event.id]), messageId: event.id, turnId: event.turnId,
      occurredAt: event.occurredAt, tool: event.tool, server: event.resource?.server, failures: 1 }));
  const pairedInputs = requestRows.filter(row => row.inputTokens !== undefined && row.cachedInputTokens !== undefined && row.cachedInputTokens <= row.inputTokens);
  const pairInput = sumKnown(pairedInputs.map(row => row.inputTokens)), pairRead = sumKnown(pairedInputs.map(row => row.cachedInputTokens));
  const premiumValues = requestRows.flatMap(row => row.hypotheticalPremium === null || row.hypotheticalPremium === undefined ? [] : [row.hypotheticalPremium]);
  const tokenValues = endedRounds.flatMap(row => row.tokens === null || row.tokens === undefined ? [] : [row.tokens]).sort((a, b) => b - a);
  const tokenTotal = tokenValues.reduce((sum, tokens) => sum + tokens, 0), childTokens = sumKnown(childRows.map(row => row.tokens)), userTokens = sumKnown(requestRows.map(row => row.tokens));
  const childCost = sumKnown(childRows.map(row => row.cost?.amount)), userCost = sumKnown(requestRows.map(row => row.cost?.amount));
  const gaps = [...activeFacts, ...unknownForks].flatMap(fact => fact.session.gaps), completed = endedRounds.length;
  const sessionsRows = activeFacts.map(fact => record(fact.session, { compressions: fact.events.filter(event => event.kind === "compression").length,
    occurredAt: [...fact.events.map(event => event.occurredAt), ...fact.requests.map(request => request.usage.occurredAt)].filter((time): time is string => !!time).sort().at(-1) }));
  const review: WeeklyReview = { version, priceVersion: pricing.status.version, timezone, query, range,
    sessions: { active: activeFacts.length, started: activeFacts.filter(fact => inPeriod(fact.session.startedAt, range, timezone)).length,
      compressionSessions: compressionLeaders.length, compressions: compressionEvents.length, compressionObservableSessions: observable.length,
      compressionRate: observable.length ? observable.filter(fact => fact.events.some(event => event.kind === "compression")).length / observable.length : null,
      roundsPerSession: weeklyDistribution(sessionRounds.map(row => row.roundCount)),
      uncompressedPeakInput: weeklyDistribution(uncompressed.map(row => row.inputTokens), activeFacts.length - uncompressed.length) },
    rounds: { started: startedRounds.length, completed, ...(inferredIncluded ? { inferredIncluded } : {}), inferred: inferredRounds.length, unconfirmed: unconfirmedRounds.length, missingEndTime: missingEndTime.length,
      steps: distribution("steps"), toolCalls: distribution("toolCalls"),
      tokens: distribution("tokens"), durationMs: distribution("durationMs"),
      topFiveTokenShare: tokenTotal ? tokenValues.slice(0, 5).reduce((sum, tokens) => sum + tokens, 0) / tokenTotal : null,
      longest: top(endedRounds, "durationMs"), highestTokens: top(endedRounds, "tokens") },
    cache: { requests: requestRows.length, zero: requestRows.filter(row => row.state === "zero").length,
      partial: requestRows.filter(row => row.state === "partial").length, full: requestRows.filter(row => row.state === "full").length,
      unknown: requestRows.filter(row => row.state === "unknown").length, inputTokens: sumKnown(requestRows.map(row => row.inputTokens)),
      cachedInputTokens: sumKnown(requestRows.map(row => row.cachedInputTokens)), readShare: pairInput ? (pairRead ?? 0) / pairInput : null,
      readShareSamples: pairedInputs.length, readShareMissing: requestRows.length - pairedInputs.length,
      freshInputTokens: sumKnown(requestRows.map(row => row.freshInputTokens)), freshSamples: requestRows.filter(row => row.freshInputTokens !== undefined).length,
      hypotheticalPremium: sumKnown(premiumValues), premiumSamples: premiumValues.length, premiumMissing: requestRows.length - premiumValues.length,
      largestFreshInputs: top(requestRows, "freshInputTokens") },
    preferences: { agents: agents.slice(0, 8), models: models.slice(0, 8), reasoning: reasoning.slice(0, 8),
      promptCharacters: weeklyDistribution(prompts.map(row => row.promptCharacters)), promptInputs: prompts.length, promptMixedInputs: null,
      hours, weekdays, weekdayHours: [...weekdayHours.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour),
      busiestHour: prompts.length ? [...hours].sort((a, b) => b.messages - a.messages || a.hour - b.hour)[0]!.hour : null, userMessages: prompts.length },
    extensions: { projects: projects.slice(0, 8), compressionLeaders: compressionLeaders.slice(0, 3), children: { sessions: childFacts.filter(hasActivity).length,
      requests: childRows.length, tokens: childTokens, estimatedCost: childCost,
      requestShare: requestRows.length + childRows.length ? childRows.length / (requestRows.length + childRows.length) : null,
      tokenShare: childTokens !== null && userTokens !== null && childTokens + userTokens > 0 ? childTokens / (childTokens + userTokens) : null,
      costShare: childCost !== null && userCost !== null && childCost + userCost > 0 ? childCost / (childCost + userCost) : null, costCoverage: costCoverage(childRows),
      tokenSamples: childRows.filter(row => row.tokens != null).length, tokenMissing: childRows.filter(row => row.tokens == null).length,
      userTokenSamples: requestRows.filter(row => row.tokens != null).length, userTokenMissing: requestRows.filter(row => row.tokens == null).length },
      tools: { calls: calls.length, failures: toolRows.length, failedRounds: new Set(toolRows.map(row => JSON.stringify([row.sessionId, row.turnId]))).size,
        unknownResults: calls.filter(({ event }) => event.status !== "success" && event.status !== "failure").length } },
    coverage: { gaps: gaps.slice(0, 100), gapCount: gaps.length, missingTimeEvents: userFacts.reduce((sum, fact) => sum + fact.missingTimeEvents, 0),
      missingTimeRequests: userFacts.reduce((sum, fact) => sum + fact.missingTimeRequests, 0), unassignedRequests: userFacts.reduce((sum, fact) => sum + fact.unassignedRequests, 0),
      excludedChildUserInputs: childFacts.reduce((sum, fact) => sum + fact.events.filter(event => event.kind === "user").length, 0),
      triggerIdentity: "unclassified", automaticSessions: null, unknownTriggerSessions: activeFacts.length,
      unsupportedCompressionSessions: activeFacts.filter(fact => !fact.compressionSupported || !fact.compressionComplete).length,
      unknownForkSessions: unknownForks.filter(hasActivity).length } };
  return { review, rows: { sessions: sessionsRows, sessionRounds, rounds: [...endedRounds, ...inferredRounds.filter(row => !row.eligible), ...unconfirmedRounds, ...missingEndTime], cache: requestRows,
    compressions: compressionEvents, projects: endedRounds, delegation: childRows, tools: toolRows, agents: startedRounds,
    models: requestRows, reasoning: requestRows, prompts, activity: prompts, uncompressed },
    ranks: { agents, models, reasoning, projects, tools: groupedRank(toolRows,
      row => JSON.stringify([row.tool ?? "unknown", row.server ?? null]), key => { const [tool, server] = JSON.parse(key) as [string, string | null]; return server ? `${server} · ${tool}` : tool; }),
      compressions: groupedRank(compressionEvents, row => row.sessionId, key => facts.find(fact => fact.session.id === key)?.session.title ?? key)
        .map(row => {
          const session = facts.find(fact => fact.session.id === row.key)?.session;
          return session?.titleOrigin === "fallback" ? { ...row, nameDescriptor: { key: session.relationship === "child" ? "sessions.title.childFallback" : "sessions.title.unnamed",
            ...(session.relationship === "child" ? { params: { id: session.clientSessionId.slice(-8) } } : {}) } } : row;
        }) } };
}

export function weeklyReviewDetail(data: WeeklyReviewData, detail: WeeklyReviewDetailQuery): WeeklyReviewDetailPage {
  let rows = data.rows[detail.kind];
  if (detail.key !== undefined) rows = rows.filter(row => (detail.kind === "agents" ? row.client : detail.kind === "models" ? row.model
    : detail.kind === "reasoning" ? row.reasoningEffort : detail.kind === "projects" ? row.project : detail.kind === "compressions" ? row.sessionId : JSON.stringify([row.tool ?? "unknown", row.server ?? null]))
    === (detail.key === "unknown" ? undefined : detail.key));
  if (detail.filter) rows = rows.filter(row => detail.kind === "cache" ? (row as RequestRecord).state === detail.filter : detail.filter === "ended" ? row.eligible : row.completion === detail.filter);
  const sort = detail.sort ?? (detail.kind === "cache" ? "fresh" : detail.kind === "sessionRounds" ? "rounds" : "recent");
  rows = [...rows].sort((a, b) => sort === "recent" ? (b.occurredAt ?? "").localeCompare(a.occurredAt ?? "") || a.id.localeCompare(b.id)
    : (b[sort === "duration" ? "durationMs" : sort === "fresh" ? "freshInputTokens" : sort === "rounds" ? "roundCount" : sort] ?? -1)
      - (a[sort === "duration" ? "durationMs" : sort === "fresh" ? "freshInputTokens" : sort === "rounds" ? "roundCount" : sort] ?? -1) || a.id.localeCompare(b.id));
  const pageSize = Math.min(100, Math.max(1, detail.pageSize ?? 25)), page = Math.min(Math.max(1, detail.page ?? 1), Math.max(1, Math.ceil(rows.length / pageSize)));
  const { rounds: _rounds, cache: _cache, preferences: _preferences, extensions: _extensions, ...review } = data.review;
  return { version: review.version, priceVersion: review.priceVersion, timezone: review.timezone, query: review.query, range: review.range,
    detail, rows: rows.slice((page - 1) * pageSize, page * pageSize), ranks: data.ranks[detail.kind], total: rows.length, page, pageSize, review };
}
