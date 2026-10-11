import type { SessionSummary, SessionUsage } from "../session-contracts.js";
import type { ResourceUsageEvent } from "../resource-contracts.js";
import type { OverviewActivity, OverviewActivityDay, OverviewCountRow, OverviewDelegation, OverviewEvent,
  OverviewFailureSequence, OverviewProcess, OverviewQuery, OverviewRange, OverviewReport, OverviewResourceCombination,
  OverviewResourceObservation, OverviewResourceRow, OverviewResources, OverviewResultCounts, OverviewSource,
  OverviewTimingGroup, OverviewToolCategory, OverviewToolRow } from "../overview-contracts.js";
import type { PricingView } from "../usage/pricing.js";
import { StoreError } from "../index/store.js";
import { requestSpeed, speedOutputTokens } from "../session-speed.js";
import { resourceGapRelevant } from "../resources/coverage.js";
import { resourceHistoryIdentity, resourceOverviewIdentity } from "../resources/usage.js";
import { buildUsageReport, instant, intervalKey, timeKeys } from "../usage/analytics.js";
import { usageDimensionKey } from "../usage/dimensions.js";
import { addDays, daysBetween, localDay, resolveOverviewRange, resolveTimezone } from "./dates.js";

const nonnegative = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;
export function isActivityEvent(event: OverviewEvent): boolean {
  return !event.copied && !event.contextSource && event.kind !== "system" && event.kind !== "context"
    && !(event.kind === "user" && event.resource?.kind === "skill_read");
}
export function matchesGlobalSession(session: SessionSummary, query: OverviewQuery): boolean {
  return (!query.clients?.length || query.clients.includes(session.client))
    && (!query.projects?.length || query.projects.includes(usageDimensionKey(session.project))
      || session.project === undefined && query.projects.includes("none"));
}
export function trueTurnIds(source: OverviewSource): Set<string> {
  return new Set(source.events.filter(event => event.kind === "user" && isActivityEvent(event) && !!event.turnId)
    .map(event => `${event.sessionId}\u0000${event.turnId}`));
}
export function resourceIdentity(event: ResourceUsageEvent): string {
  return resourceOverviewIdentity(resourceHistoryIdentity(event), event.source.sourceId).id;
}
export function knownResourceIdentity(event: ResourceUsageEvent): boolean {
  return resourceOverviewIdentity(resourceHistoryIdentity(event), event.source.sourceId).grouping !== "source";
}
export function validResource(event: ResourceUsageEvent): boolean {
  return event.kind !== "skill_read" || event.status === "success";
}
export function selectedSource(source: OverviewSource, query: OverviewQuery, range: OverviewRange, usageScope = false): OverviewSource {
  const sessions = source.sessions.filter(session => matchesGlobalSession(session, query)), ids = new Set(sessions.map(session => session.id));
  const dated = (value?: string) => {
    const day = localDay(value, query.timezone!);
    return day === null ? range.all : day >= range.from && day <= range.to;
  };
  return { ...source, sessions, events: source.events.filter(event => ids.has(event.sessionId) && isActivityEvent(event) && dated(event.occurredAt)),
    requests: source.requests.filter(request => ids.has(request.sessionId) && dated(request.usage.occurredAt)
      && (!usageScope || !query.models?.length || query.models.includes(usageDimensionKey(request.usage.model)))),
    resources: source.resources.filter(event => ids.has(event.sessionId) && validResource(event) && dated(event.occurredAt)) };
}
export function resultCounts(statuses: readonly ("success" | "failure" | "unknown" | undefined)[]): OverviewResultCounts {
  const success = statuses.filter(status => status === "success").length, failure = statuses.filter(status => status === "failure").length;
  const known = success + failure;
  return { calls: statuses.length, success, failure, unknown: statuses.length - known, known,
    failureRate: known ? failure / known : null, coverage: statuses.length ? known / statuses.length : null };
}
export function pairToolCalls(events: OverviewEvent[]): OverviewEvent[] {
  const groups = new Map<string, { calls: OverviewEvent[]; results: OverviewEvent[] }>();
  for (const event of events) {
    if (!event.callId || event.kind !== "tool_call" && event.kind !== "tool_result") continue;
    const key = `${event.sessionId}\u0000${event.callId}`, group = groups.get(key) ?? { calls: [], results: [] };
    group[event.kind === "tool_call" ? "calls" : "results"].push(event); groups.set(key, group);
  }
  return events.filter(event => event.kind === "tool_call").map(event => {
    const group = event.callId ? groups.get(`${event.sessionId}\u0000${event.callId}`) : undefined;
    const unique = group?.calls.length === 1 && group.results.length === 1;
    const result = unique ? group.results[0] : undefined;
    return { ...event, status: event.status === "success" || event.status === "failure" ? event.status
      : result?.status === "success" || result?.status === "failure" ? result.status : "unknown",
    ...(result ? { resultMessageId: result.id } : {}),
    pairing: group && (group.calls.length > 1 || group.results.length > 1) ? "ambiguous" : result ? "unique" : "missing" };
  });
}
export function toolCategory(tool?: string, resource?: OverviewEvent["resource"]): OverviewToolCategory {
  if (resource?.kind === "mcp" || /^(?:mcp__|mcp\.)/.test(tool ?? "")) return "external";
  const name = (tool ?? "").toLowerCase().replace(/^.*[./]/, "");
  if (/(?:spawn_agent|subagent|delegate|agent_task)/.test(name)) return "delegate";
  if (/(?:apply_patch|write_file|edit_file|multiedit|^edit$|^write$)/.test(name)) return "edit";
  if (/(?:search|glob|grep|find_file|list_files)/.test(name)) return "search";
  if (/(?:read_file|file_read|^read$|view_file)/.test(name)) return "read";
  if (/(?:exec_command|bash|shell|terminal|run_command)/.test(name)) return "command";
  return "other";
}
function aggregateCount<T>(items: T[], identity: (item: T) => string, sessionId: (item: T) => string,
  status?: (item: T) => "success" | "failure" | "unknown" | undefined): OverviewCountRow[] {
  const groups = new Map<string, T[]>();
  for (const item of items) { const key = identity(item), group = groups.get(key) ?? []; group.push(item); groups.set(key, group); }
  return [...groups].map(([key, group]) => ({ key, name: key, count: group.length, sessions: new Set(group.map(sessionId)).size,
    ...(status ? { results: resultCounts(group.map(status)) } : {}) })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
function streaks(days: Set<string>, range: OverviewRange): { current: number; longest: number } {
  let current = 0, endpoint = range.to;
  if (range.to === range.today && !days.has(endpoint) && addDays(endpoint, -1) >= range.from) endpoint = addDays(endpoint, -1);
  for (let day = endpoint; day >= range.from && days.has(day); day = addDays(day, -1)) current += 1;
  let longest = 0, length = 0, previous: string | undefined;
  for (const day of [...days].sort()) {
    length = previous && addDays(previous, 1) === day ? length + 1 : 1;
    longest = Math.max(longest, length); previous = day;
  }
  return { current, longest };
}
function buildActivity(selected: OverviewSource, source: OverviewSource, range: OverviewRange, timezone: string,
  usageDays: OverviewReport["usage"]["days"]): { activity: OverviewActivity; activeIds: Set<string>; sessionDates: Map<string, Set<string>> } {
  const activeIds = new Set<string>(), daySessions = new Map<string, Set<string>>(), sessionDates = new Map<string, Set<string>>();
  const points = new Map<string, { events: number; requests: number; toolCalls: number }>();
  const missingTimeSessions = new Set<string>();
  const add = (sessionId: string, occurredAt?: string) => {
    activeIds.add(sessionId);
    const day = localDay(occurredAt, timezone);
    if (day === null) { missingTimeSessions.add(sessionId); return; }
    const sessions = daySessions.get(day) ?? new Set<string>(); sessions.add(sessionId); daySessions.set(day, sessions);
    const dates = sessionDates.get(sessionId) ?? new Set<string>(); dates.add(day); sessionDates.set(sessionId, dates);
    return day;
  };
  for (const event of selected.events) {
    const day = add(event.sessionId, event.occurredAt); if (!day) continue;
    const point = points.get(day) ?? { events: 0, requests: 0, toolCalls: 0 }; point.events += 1;
    if (event.kind === "tool_call") point.toolCalls += 1; points.set(day, point);
  }
  for (const request of selected.requests) {
    const day = add(request.sessionId, request.usage.occurredAt); if (!day) continue;
    const point = points.get(day) ?? { events: 0, requests: 0, toolCalls: 0 }; point.requests += 1; points.set(day, point);
  }
  const tokenDays = new Map(usageDays.map(day => [day.key, day.totals.tokens]));
  const days: OverviewActivityDay[] = [];
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
    const point = points.get(day) ?? { events: 0, requests: 0, toolCalls: 0 };
    days.push({ day, sessions: daySessions.get(day)?.size ?? 0, ...point, tokens: tokenDays.get(day) ?? (point.requests ? null : 0) });
  }
  const weekday = Array.from({ length: 7 }, () => ({ count: 0, sessions: new Set<string>() }));
  const hours = Array.from({ length: 24 }, () => ({ count: 0, sessions: new Set<string>() }));
  const weekdayHours = new Map<string, { weekday: number; hour: number; count: number; sessions: Set<string> }>();
  const keys = timeKeys(timezone, "hour"), eventIds = new Set(selected.events.filter(event => instant(event.occurredAt) !== undefined)
    .map(event => `${event.sessionId}\u0000${event.id}`));
  const activityPoints = [...selected.events.map(event => ({ sessionId: event.sessionId, occurredAt: event.occurredAt })),
    ...selected.requests.filter(request => ![request.usage.messageId, ...(request.usage.requestMessageIds ?? []),
      request.usage.timing?.end?.source !== "mirror" ? request.usage.timing?.end?.messageId : undefined]
      .some(id => id !== undefined && eventIds.has(`${request.sessionId}\u0000${id}`)))
      .map(request => ({ sessionId: request.sessionId, occurredAt: request.usage.occurredAt }))];
  for (const point of activityPoints) {
    const time = instant(point.occurredAt); if (time === undefined) continue;
    const { day, bucket } = keys(time), wd = new Date(`${day}T00:00:00Z`).getUTCDay(), hour = Number(bucket.slice(11, 13));
    weekday[wd]!.count += 1; weekday[wd]!.sessions.add(point.sessionId); hours[hour]!.count += 1; hours[hour]!.sessions.add(point.sessionId);
    const key = `${wd}:${hour}`, value = weekdayHours.get(key) ?? { weekday: wd, hour, count: 0, sessions: new Set<string>() };
    value.count += 1; value.sessions.add(point.sessionId); weekdayHours.set(key, value);
  }
  const ids = new Set(selected.sessions.map(session => session.id));
  const undated = source.events.filter(event => ids.has(event.sessionId) && isActivityEvent(event) && localDay(event.occurredAt, timezone) === null);
  for (const event of undated) missingTimeSessions.add(event.sessionId);
  for (const request of source.requests) if (ids.has(request.sessionId) && localDay(request.usage.occurredAt, timezone) === null) missingTimeSessions.add(request.sessionId);
  return { activeIds, sessionDates, activity: { days,
    weekdays: weekday.map((row, index) => ({ weekday: index, events: row.count, sessions: row.sessions.size })),
    hours: hours.map((row, hour) => ({ hour, events: row.count, sessions: row.sessions.size })),
    weekdayHours: [...weekdayHours.values()].map(row => ({ weekday: row.weekday, hour: row.hour, events: row.count, sessions: row.sessions.size })),
    missingTimeEvents: undated.length, missingTimeSessions: missingTimeSessions.size,
    datedSessions: sessionDates.size, crossDaySessions: [...sessionDates.values()].filter(dates => dates.size >= 2).length } };
}
export function resourceObservations(source: OverviewSource, selected: OverviewSource, range: OverviewRange, timezone: string): OverviewResourceObservation[] {
  const groups = new Map<string, ResourceUsageEvent[]>();
  for (const event of selected.resources) { const id = resourceIdentity(event), events = groups.get(id) ?? []; events.push(event); groups.set(id, events); }
  return [...groups].flatMap(([resourceId, events]) => {
    const dated = events.map(event => ({ event, day: localDay(event.occurredAt, timezone) })).filter((value): value is { event: ResourceUsageEvent; day: string } => value.day !== null)
      .sort((a, b) => a.day.localeCompare(b.day) || a.event.ordinal - b.event.ordinal || a.event.id.localeCompare(b.event.id));
    if (!dated.length) return [];
    const first = dated[0]!, from = addDays(first.day, 1), to = addDays(first.day, 30), sourceIds = new Set(events.map(event => event.source.sourceId));
    const sessionIds = new Set(events.map(event => event.sessionId));
    const relevantGap = source.gaps.some(gap => !!gap.sourceId && sourceIds.has(gap.sourceId) && resourceGapRelevant(gap))
      || source.sessions.some(session => sessionIds.has(session.id) && session.gaps.some(resourceGapRelevant));
    const state = to >= range.today ? "observing" : from < range.from || to > range.to ? "outside_range"
      : relevantGap || !knownResourceIdentity(first.event) ? "insufficient_coverage" : "mature";
    const subsequentDays = new Set(dated.filter(value => value.day >= from && value.day <= to).map(value => value.day)).size;
    return [{ resourceId, name: first.event.kind === "mcp" ? first.event.server ?? first.event.name : first.event.name,
      kind: first.event.kind === "mcp" ? "mcp" as const : "skill" as const, firstDay: first.day,
      window: { from, to }, state, reused: state === "mature" ? subsequentDays > 0 : null, subsequentDays, firstEventId: first.event.id }];
  });
}
export function resourceCombinations(source: OverviewSource, events: ResourceUsageEvent[], unit: "session" | "turn"): OverviewResourceCombination[] {
  const turns = trueTurnIds(source), units = new Map<string, { sessionId: string; resources: Map<string, string> }>();
  for (const event of events) {
    if (!knownResourceIdentity(event)) continue;
    const turnKey = `${event.sessionId}\u0000${event.turnId}`;
    if (unit === "turn" && !turns.has(turnKey)) continue;
    const key = unit === "session" ? event.sessionId : turnKey;
    const entry = units.get(key) ?? { sessionId: event.sessionId, resources: new Map<string, string>() };
    entry.resources.set(resourceIdentity(event), event.kind === "mcp" ? event.server ?? event.name : event.name); units.set(key, entry);
  }
  const pairs = new Map<string, { resources: [string, string]; names: [string, string]; count: number; sessions: Set<string> }>();
  for (const entry of units.values()) {
    const resources = [...entry.resources].sort(([a], [b]) => a.localeCompare(b));
    for (let left = 0; left < resources.length; left += 1) for (let right = left + 1; right < resources.length; right += 1) {
      const a = resources[left]!, b = resources[right]!, id = JSON.stringify([a[0], b[0]]);
      const pair = pairs.get(id) ?? { resources: [a[0], b[0]], names: [a[1], b[1]], count: 0, sessions: new Set<string>() };
      pair.count += 1; pair.sessions.add(entry.sessionId); pairs.set(id, pair);
    }
  }
  return [...pairs].map(([id, value]) => ({ id, resources: value.resources, names: value.names, unit, count: value.count, sessions: value.sessions.size }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}
function buildResources(source: OverviewSource, selected: OverviewSource, range: OverviewRange, timezone: string): OverviewResources {
  const groups = new Map<string, ResourceUsageEvent[]>();
  for (const event of selected.resources) { const id = resourceIdentity(event), events = groups.get(id) ?? []; events.push(event); groups.set(id, events); }
  const rows: OverviewResourceRow[] = [...groups].map(([id, events]) => {
    const first = events[0]!, daysByKey = new Map<string, { uses: number; sessions: Set<string> }>();
    for (const event of events) {
      const day = localDay(event.occurredAt, timezone); if (!day) continue;
      const value = daysByKey.get(day) ?? { uses: 0, sessions: new Set<string>() };
      value.uses += 1; value.sessions.add(event.sessionId); daysByKey.set(day, value);
    }
    const dates = [...daysByKey.keys()].sort(), days = dates.map(day => ({ day, uses: daysByKey.get(day)!.uses, sessions: daysByKey.get(day)!.sessions.size }));
    const sessions = new Set(events.map(event => event.sessionId)).size, calls = events.filter(event => event.kind !== "skill_read");
    const identity = resourceOverviewIdentity(resourceHistoryIdentity(first), first.source.sourceId);
    return { id, kind: first.kind === "mcp" ? "mcp" : "skill", name: identity.name,
      ...(!knownResourceIdentity(first) ? { nameDescriptor: { key: "sessions.resource.nameUnrecorded" } } : first.nameDescriptor ? { nameDescriptor: first.nameDescriptor } : {}), uses: events.length, sessions,
      explicitCalls: events.filter(event => event.kind === "skill_call").length, successfulReads: events.filter(event => event.kind === "skill_read").length,
      activeWeeks: new Set(dates.map(day => intervalKey(day, "week"))).size, firstDay: dates[0] ?? null, lastDay: dates.at(-1) ?? null,
      averagePerSession: sessions ? events.length / sessions : null,
      clients: aggregateCount(events, event => event.client, event => event.sessionId),
      projects: aggregateCount(events, event => usageDimensionKey(event.project), event => event.sessionId),
      tools: aggregateCount(calls, event => usageDimensionKey(event.tool), event => event.sessionId, event => event.status),
      days, results: resultCounts(calls.map(event => event.status)) };
  });
  const sessionIds = new Set(selected.sessions.map(session => session.id)), turns = trueTurnIds(source);
  return { skills: rows.filter(row => row.kind === "skill").sort((a, b) => b.sessions - a.sessions || b.uses - a.uses || a.id.localeCompare(b.id)),
    mcp: rows.filter(row => row.kind === "mcp").sort((a, b) => b.uses - a.uses || a.id.localeCompare(b.id)),
    observations: resourceObservations(source, selected, range, timezone),
    combinations: { sessions: resourceCombinations(source, selected.resources, "session"), turns: resourceCombinations(source, selected.resources, "turn") },
    missingTimeEvents: source.resources.filter(event => sessionIds.has(event.sessionId) && validResource(event) && localDay(event.occurredAt, timezone) === null).length,
    missingTurnEvents: selected.resources.filter(event => !turns.has(`${event.sessionId}\u0000${event.turnId}`)).length };
}
export function failureSequences(source: OverviewSource, selectedCalls: OverviewEvent[]): OverviewFailureSequence[] {
  const turns = trueTurnIds(source), groups = new Map<string, OverviewEvent[]>();
  const allCalls = new Map<string, OverviewEvent[]>();
  for (const event of source.events) {
    if (event.kind !== "tool_call" || !event.tool || !isActivityEvent(event)) continue;
    const key = JSON.stringify([event.sessionId, event.turnId, event.tool, event.resource?.server ?? null]), group = allCalls.get(key) ?? [];
    group.push(event); allCalls.set(key, group);
  }
  for (const event of selectedCalls) {
    if (!event.tool || !turns.has(`${event.sessionId}\u0000${event.turnId}`)) continue;
    const key = JSON.stringify([event.sessionId, event.turnId, event.tool, event.resource?.server ?? null]), group = groups.get(key) ?? []; group.push(event); groups.set(key, group);
  }
  const result: OverviewFailureSequence[] = [];
  for (const calls of groups.values()) {
    calls.sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
    const firstFailure = calls.findIndex(call => call.status === "failure"); if (firstFailure < 0) continue;
    const first = calls[firstFailure]!, retained = calls.slice(firstFailure);
    const completeCalls = allCalls.get(JSON.stringify([first.sessionId, first.turnId, first.tool, first.resource?.server ?? null])) ?? [], retainedIds = new Set(retained.map(call => call.id));
    result.push({ sessionId: first.sessionId, turnId: first.turnId, tool: first.tool!, server: first.resource?.server,
      failures: retained.filter(call => call.status === "failure").map(call => call.id),
      calls: retained.map(call => ({ messageId: call.id, resultMessageId: call.resultMessageId, ordinal: call.ordinal, status: call.status ?? "unknown" })),
      truncated: completeCalls.some(call => call.ordinal > first.ordinal && !retainedIds.has(call.id)) });
  }
  return result;
}
export function timingGroupId(session: SessionSummary, usage: SessionUsage): string {
  return JSON.stringify([session.client, usage.model ?? null, usage.timing?.window ?? "response", usage.timing?.basis, usage.timing?.method]);
}
export function validDuration(usage: SessionUsage): boolean {
  const timing = usage.timing;
  if (!timing || timing.completion !== "explicit" && timing.completion !== "inferred"
    || !nonnegative(timing.durationMs) || timing.durationMs <= 0) return false;
  if ([timing.start?.occurredAt, timing.end?.occurredAt].some(value => value !== undefined && instant(value) === undefined)) return false;
  return !(timing.start?.occurredAt && timing.end?.occurredAt
    && Math.abs(instant(timing.end.occurredAt)! - instant(timing.start.occurredAt)! - timing.durationMs) > 1);
}
export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * q, low = Math.floor(index), fraction = index - low;
  return sorted[low]! + (sorted[Math.min(low + 1, sorted.length - 1)]! - sorted[low]!) * fraction;
}
function buildProcess(source: OverviewSource, selected: OverviewSource, usageSelected: OverviewSource, timezone: string): OverviewProcess {
  const sessionById = new Map(source.sessions.map(session => [session.id, session]));
  const selectedIds = new Set(selected.events.filter(event => event.kind === "tool_call").map(event => `${event.sessionId}\u0000${event.id}`));
  // 结果可以稍晚于调用落在范围外，唯一配对仍属于同一个范围内调用。
  const calls = pairToolCalls(source.events.filter(isActivityEvent)).filter(event => selectedIds.has(`${event.sessionId}\u0000${event.id}`));
  const groups = new Map<string, OverviewEvent[]>();
  for (const call of calls) { const id = JSON.stringify([call.tool ?? null, call.resource?.server ?? null]), values = groups.get(id) ?? []; values.push(call); groups.set(id, values); }
  const tools: OverviewToolRow[] = [...groups].map(([key, values]) => {
    const first = values[0]!, status = (event: OverviewEvent) => event.status, sessionId = (event: OverviewEvent) => event.sessionId;
    const dayCounts = new Map<string, { calls: number; failures: number }>();
    for (const event of values) {
      const day = localDay(event.occurredAt, timezone); if (!day) continue;
      const counts = dayCounts.get(day) ?? { calls: 0, failures: 0 };
      counts.calls += 1; if (event.status === "failure") counts.failures += 1; dayCounts.set(day, counts);
    }
    const dates = [...dayCounts.keys()].sort();
    return { key, name: first.tool ?? "unknown", server: first.resource?.server, category: toolCategory(first.tool, first.resource),
      count: values.length, sessions: new Set(values.map(sessionId)).size, results: resultCounts(values.map(status)), activeDays: dates.length,
      clients: aggregateCount(values, event => sessionById.get(event.sessionId)!.client, sessionId, status),
      projects: aggregateCount(values, event => usageDimensionKey(sessionById.get(event.sessionId)!.project), sessionId, status),
      days: dates.map(day => ({ day, ...dayCounts.get(day)! })) };
  }).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const timingGroups = new Map<string, OverviewSource["requests"]>();
  let missingTimingRequests = 0;
  for (const request of usageSelected.requests) {
    if (!validDuration(request.usage)) { missingTimingRequests += 1; continue; }
    const session = sessionById.get(request.sessionId)!, id = timingGroupId(session, request.usage), values = timingGroups.get(id) ?? [];
    values.push(request); timingGroups.set(id, values);
  }
  const timing: OverviewTimingGroup[] = [...timingGroups].map(([id, requests]) => {
    const first = requests[0]!, session = sessionById.get(first.sessionId)!, times = requests.map(request => request.usage.timing!.durationMs!);
    const speeds = requests.flatMap(request => { const speed = requestSpeed(request.usage); return speed.tokensPerSecond !== undefined ? [speed.tokensPerSecond] : []; });
    const eligible = requests.filter(request => requestSpeed(request.usage).tokensPerSecond !== undefined);
    return { id, client: session.client, model: first.usage.model ?? null, window: first.usage.timing?.window ?? "response",
      basis: first.usage.timing!.basis, method: first.usage.timing!.method, samples: requests.length,
      duration: { medianMs: quantile(times, .5), p90Ms: quantile(times, .9), maxMs: times.reduce((max, time) => Math.max(max, time), 0), averageMs: times.reduce((sum, time) => sum + time, 0) / times.length,
        histogram: durationHistogram(times) },
      speed: { samples: speeds.length, median: quantile(speeds, .5), p90: quantile(speeds, .9), average: eligible.length
        ? eligible.reduce((sum, request) => sum + speedOutputTokens(request.usage)!, 0) * 1000 / eligible.reduce((sum, request) => sum + request.usage.timing!.durationMs!, 0) : null },
      longest: [...requests].sort((a, b) => b.usage.timing!.durationMs! - a.usage.timing!.durationMs! || a.usage.id.localeCompare(b.usage.id)).slice(0, 5)
        .map(request => ({ sessionId: request.sessionId, requestId: request.usage.id, messageId: request.usage.messageId, durationMs: request.usage.timing!.durationMs! })) };
  }).sort((a, b) => b.samples - a.samples || a.id.localeCompare(b.id));
  const compressions = selected.events.filter(event => event.kind === "compression");
  return { tools, categories: aggregateCount(calls, event => toolCategory(event.tool, event.resource), event => event.sessionId, event => event.status),
    results: resultCounts(calls.map(event => event.status)), failures: calls.filter(event => event.status === "failure").length,
    failureSequences: failureSequences(source, calls), compressions: compressions.length,
    compressionSessions: new Set(compressions.map(event => event.sessionId)).size, timing, missingTimingRequests };
}
export function buildDelegation(source: OverviewSource, selected: OverviewSource, usageSelected: OverviewSource, activeIds: Set<string>, timezone: string): OverviewDelegation {
  const byId = new Map(source.sessions.map(session => [session.id, session])), children = new Map<string, SessionSummary[]>();
  for (const session of source.sessions) if (session.relationship === "child" && session.parentSessionId) {
    const group = children.get(session.parentSessionId) ?? []; group.push(session); children.set(session.parentSessionId, group);
  }
  let eligibleMainSessions = 0, withChildActivity = 0, unknownMainSessions = 0, unknownRelationshipSessions = 0;
  const datedActivityIds = new Set([...source.events.filter(event => isActivityEvent(event) && localDay(event.occurredAt, timezone) !== null).map(event => event.sessionId),
    ...source.requests.filter(request => localDay(request.usage.occurredAt, timezone) !== null).map(request => request.sessionId)]);
  const selectedRequests = usageSelected.requests;
  const relationUnknown = (session: SessionSummary) => session.relationship === "child" && (!session.parentSessionId || !byId.has(session.parentSessionId))
    || session.gaps.some(gap => ["diagnostics.sessions.store.m004", "diagnostics.sessions.store.m005", "diagnostics.sessions.store.m006", "diagnostics.sessions.store.m017"].includes(gap.messageDescriptor?.key ?? ""));
  for (const session of selected.sessions) {
    if (!activeIds.has(session.id) || session.relationship === "fork") continue;
    if (relationUnknown(session)) { unknownRelationshipSessions += 1; continue; }
    if (session.relationship === "child") continue;
    const knownChildren = children.get(session.id) ?? [], declared = new Set(session.childSessionIds ?? []);
    for (const child of knownChildren) declared.add(child.id);
    const hasActivity = knownChildren.some(child => activeIds.has(child.id));
    const uncertain = [...declared].some(id => {
      const child = byId.get(id); if (!child || child.relationship !== "child" || child.parentSessionId !== session.id) return true;
      return !datedActivityIds.has(id);
    });
    if (hasActivity) { eligibleMainSessions += 1; withChildActivity += 1; }
    else if (uncertain) unknownMainSessions += 1;
    else eligibleMainSessions += 1;
  }
  const assigned = selectedRequests.filter(request => { const session = byId.get(request.sessionId)!; return session.relationship !== "fork" && !relationUnknown(session); });
  const child = assigned.filter(request => byId.get(request.sessionId)!.relationship === "child");
  const tokens = (requests: OverviewSource["requests"]) => {
    const values = requests.filter(request => nonnegative(request.usage.inputTokens) && nonnegative(request.usage.outputTokens));
    return values.length ? values.reduce((sum, request) => sum + request.usage.inputTokens! + request.usage.outputTokens!, 0) : null;
  };
  return { eligibleMainSessions, withChildActivity, unknownMainSessions, unknownRelationshipSessions,
    forkSessions: selected.sessions.filter(session => activeIds.has(session.id) && session.relationship === "fork").length,
    childRequests: child.length, assignedRequests: assigned.length, childTokens: tokens(child), assignedTokens: tokens(assigned) };
}

export function buildOverviewReport(source: OverviewSource, input: OverviewQuery, pricing: PricingView, now = new Date()): OverviewReport {
  const timezone = resolveTimezone(input.timezone), query: OverviewQuery = { ...input, timezone, version: source.version, priceVersion: pricing.status.version };
  if (input.version !== undefined && input.version !== source.version || input.priceVersion !== undefined && input.priceVersion !== pricing.status.version) {
    throw new StoreError("VERSION_NOT_FOUND", "总览版本已不可用", { key: "diagnostics.usage.versionMismatch" });
  }
  for (const key of ["clients", "projects", "models"] as const) if (query[key] !== undefined
    && (!Array.isArray(query[key]) || query[key]!.some(value => typeof value !== "string" || !value))) {
    throw new StoreError("INVALID_INPUT", "无效总览筛选", { key: "diagnostics.usage.invalidQuery", params: { field: key } });
  }
  const range = resolveOverviewRange(source, query, now), selected = selectedSource(source, query, range), usageSelected = selectedSource(source, query, range, true);
  const costs = new WeakMap<SessionUsage, Map<string, ReturnType<PricingView["estimate"]>>>();
  const estimate: PricingView["estimate"] = (usage, client) => {
    const clientKey = client ?? "", values = costs.get(usage) ?? new Map<string, ReturnType<PricingView["estimate"]>>();
    if (!values.has(clientKey)) values.set(clientKey, pricing.estimate(usage, client));
    costs.set(usage, values); return values.get(clientKey)!;
  };
  const usageQuery = { version: source.version, priceVersion: pricing.status.version, timezone, clients: query.clients,
    projects: query.projects?.map(project => project === "none" ? "unknown" : project), ...(range.all ? {} : { from: range.from, to: range.to }),
    interval: "week" as const, page: 1, pageSize: 5, groupBy: "model" as const };
  const global = buildUsageReport(source, usageQuery, pricing.status, estimate);
  const usage = query.models?.length ? buildUsageReport(source, { ...usageQuery, models: query.models }, pricing.status, estimate) : global;
  // 首屏报告不重复返回会话内原请求，明细由独立分页证据接口读取。
  global.sessions = global.sessions.map(row => ({ ...row, requests: [], requestsLimited: row.requestsTotal > 0 }));
  if (usage !== global) usage.sessions = usage.sessions.map(row => ({ ...row, requests: [], requestsLimited: row.requestsTotal > 0 }));
  const { activity, activeIds } = buildActivity(selected, source, range, timezone, global.days);
  const activeSessions = selected.sessions.filter(session => activeIds.has(session.id)), activeDays = new Set(activity.days.filter(day => day.sessions > 0).map(day => day.day));
  const streak = streaks(activeDays, range), resources = buildResources(source, selected, range, timezone);
  const complete = selected.requests.filter(request => nonnegative(request.usage.inputTokens) && nonnegative(request.usage.outputTokens))
    .sort((a, b) => b.usage.inputTokens! + b.usage.outputTokens! - a.usage.inputTokens! - a.usage.outputTokens!
      || (a.usage.occurredAt ?? "").localeCompare(b.usage.occurredAt ?? "") || `${a.sessionId}:${a.usage.id}`.localeCompare(`${b.sessionId}:${b.usage.id}`));
  const peak = complete[0], totals = global.totals;
  const process = buildProcess(source, selected, usageSelected, timezone), sessionById = new Map(source.sessions.map(session => [session.id, session]));
  const requestDistribution = (dimension: "client" | "project" | "model") => {
    const requests = usageSelected.requests;
    const rows = aggregateCount(requests, request => dimension === "model" ? usageDimensionKey(request.usage.model)
      : dimension === "project" ? usageDimensionKey(sessionById.get(request.sessionId)!.project) : sessionById.get(request.sessionId)!.client, request => request.sessionId);
    return rows.map(row => { const group = requests.filter(request => (dimension === "model" ? usageDimensionKey(request.usage.model)
      : dimension === "project" ? usageDimensionKey(sessionById.get(request.sessionId)!.project) : sessionById.get(request.sessionId)!.client) === row.key);
      const tokens = group.flatMap(request => nonnegative(request.usage.inputTokens) || nonnegative(request.usage.outputTokens)
        ? [(nonnegative(request.usage.inputTokens) ? request.usage.inputTokens : 0) + (nonnegative(request.usage.outputTokens) ? request.usage.outputTokens : 0)] : []);
      const costs = group.flatMap(request => { const amount = estimate(request.usage, sessionById.get(request.sessionId)!.client).amount;
        return amount !== null ? [amount] : []; });
      return { ...row, requests: row.count, tokens: tokens.length ? tokens.reduce((sum, value) => sum + value, 0) : null,
        estimatedCost: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null }; });
  };
  const scopedIds = new Set(selected.sessions.map(session => session.id));
  return { version: source.version, priceVersion: pricing.status.version, timezone, query, range, totals, usage,
    summary: { sessions: activeSessions.length, mainSessions: activeSessions.filter(session => session.relationship !== "child" && session.relationship !== "fork").length,
      childSessions: activeSessions.filter(session => session.relationship === "child").length, forkSessions: activeSessions.filter(session => session.relationship === "fork").length,
      requests: totals.requests, tokens: totals.tokens, estimatedCost: totals.estimatedCost,
      tokenCoverage: totals.tokens === null ? "missing" : totals.partialTokenRequests || totals.missingTokenRequests ? "partial" : "complete",
      costCoverage: totals.estimatedCost === null ? "missing" : totals.partiallyPricedRequests || totals.unpricedRequests ? "partial" : "complete",
      activeDays: activeDays.size, currentStreak: streak.current, longestStreak: streak.longest,
      projectCount: new Set(activeSessions.flatMap(session => session.project ?? [])).size,
      modelCount: new Set(selected.requests.flatMap(request => request.usage.model ?? [])).size,
      resourceCount: new Set(selected.resources.filter(knownResourceIdentity).map(resourceIdentity)).size,
      peak: peak ? { sessionId: peak.sessionId, requestId: peak.usage.id, messageId: peak.usage.messageId,
        occurredAt: peak.usage.occurredAt, tokens: peak.usage.inputTokens! + peak.usage.outputTokens! } : null },
    activity, distributions: { clients: requestDistribution("client"), projects: requestDistribution("project"), models: requestDistribution("model") },
    resources, process, delegation: buildDelegation(source, selected, usageSelected, activeIds, timezone), repositories: [], insights: [], featuredInsights: [],
    projectMonths: [], modelTransitions: [],
    facets: { clients: [...new Set(source.sessions.map(session => session.client))].sort(),
      projects: [...new Set(source.sessions.flatMap(session => session.project ?? []))].sort(),
      models: [...new Set(source.requests.flatMap(request => request.usage.model ?? []))].sort() },
    coverage: { gaps: source.gaps.slice(0, 100), gapCount: source.gaps.length, missingTimeEvents: activity.missingTimeEvents,
      missingTimeRequests: source.requests.filter(request => scopedIds.has(request.sessionId) && localDay(request.usage.occurredAt, timezone) === null).length,
      missingTimeResources: resources.missingTimeEvents } };
}

function durationHistogram(values: number[]): { fromMs: number; toMs: number; count: number }[] {
  const maximum = values.reduce((max, value) => Math.max(max, value), 0), width = Math.max(maximum / 8, 1);
  const bins = Array.from({ length: 8 }, (_, index) => ({ fromMs: index * width, toMs: (index + 1) * width, count: 0 }));
  for (const value of values) bins[Math.min(Math.floor(value / width), 7)]!.count += 1;
  return bins;
}
