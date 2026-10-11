import type { OverviewEvidencePage, OverviewEvidenceQuery, OverviewEvidenceRow, OverviewEvent, OverviewPeriod,
  OverviewQuery, OverviewRequest, OverviewSource } from "../overview-contracts.js";
import type { SessionSummary } from "../session-contracts.js";
import type { PricingView } from "../usage/pricing.js";
import { StoreError } from "../index/store.js";
import { instant } from "../usage/analytics.js";
import { usageDimensionKey } from "../usage/dimensions.js";
import { failureSequences, isActivityEvent, matchesGlobalSession, pairToolCalls, resourceIdentity, resourceObservations,
  selectedSource, timingGroupId, toolCategory, trueTurnIds, validDuration } from "./analytics.js";
import { daysBetween, localDay, resolveOverviewRange, resolveTimezone } from "./dates.js";

export function buildOverviewEvidence(source: OverviewSource, input: OverviewQuery, evidence: OverviewEvidenceQuery,
  pricing: PricingView, now = new Date()): OverviewEvidencePage {
  if (input.version !== undefined && input.version !== source.version || input.priceVersion !== undefined && input.priceVersion !== pricing.status.version) {
    throw new StoreError("VERSION_NOT_FOUND", "总览版本已不可用", { key: "diagnostics.usage.versionMismatch" });
  }
  const timezone = resolveTimezone(input.timezone), query = { ...input, timezone };
  const range = resolveOverviewRange(source, query, now), page = evidence.page ?? 1, pageSize = evidence.pageSize ?? 25;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) invalid("page");
  if (!["activity", "sessions", "requests", "resources", "tools", "failures", "compressions", "timing", "combinations", "observations", "sequence", "delegation"].includes(evidence.kind)) invalid("kind");
  let period: OverviewPeriod = range;
  if (evidence.period === "current") period = range.comparison?.current ?? range;
  if (evidence.period === "previous") { if (!range.comparison) return empty(); period = range.comparison.previous; }
  if (evidence.period === "recent") { if (!range.recent) return empty(); period = range.recent.current; }
  if (evidence.period === "recent_previous") { if (!range.recent) return empty(); period = range.recent.previous; }
  if (evidence.day) period = { from: evidence.day, to: evidence.day };
  if (evidence.from || evidence.to) period = { from: evidence.from ?? period.from, to: evidence.to ?? period.to };
  const evidenceRange = resolveOverviewRange(source, { ...query, window: "custom", ...period }, now);
  evidenceRange.all = evidence.undated === true || range.all && (!evidence.period || evidence.period === "selected") && !evidence.from && !evidence.to && !evidence.day;
  const scopedQuery: OverviewQuery = { ...query,
    ...(evidence.client ? { clients: [evidence.client] } : {}), ...(evidence.project ? { projects: [evidence.project] } : {}),
    ...(evidence.model ? { models: [evidence.model] } : {}) };
  // 证据中的追加条件只能缩小报告范围，不能越过原客户端、项目条件。
  const sessions = source.sessions.filter(session => matchesGlobalSession(session, query) && matchesGlobalSession(session, scopedQuery)
    && (!evidence.sessionId || session.id === evidence.sessionId)
    && (!evidence.relationship || (evidence.relationship === "main" ? session.relationship !== "child" && session.relationship !== "fork" : session.relationship === evidence.relationship)));
  const ids = new Set(sessions.map(session => session.id)), byId = new Map(source.sessions.map(session => [session.id, session]));
  const scopedSource: OverviewSource = { ...source, sessions, events: source.events.filter(event => ids.has(event.sessionId)),
    requests: source.requests.filter(request => ids.has(request.sessionId)), resources: source.resources.filter(event => ids.has(event.sessionId)) };
  const selected = selectedSource(scopedSource, scopedQuery, evidenceRange, evidence.scope === "usage" || evidence.kind === "timing");
  if (evidence.undated) {
    selected.events = selected.events.filter(event => localDay(event.occurredAt, timezone) === null);
    selected.requests = selected.requests.filter(request => localDay(request.usage.occurredAt, timezone) === null);
    selected.resources = selected.resources.filter(event => localDay(event.occurredAt, timezone) === null);
  }
  if ((evidence.scope === "usage" || evidence.kind === "timing") && query.models?.length) {
    selected.requests = selected.requests.filter(request => query.models!.includes(usageDimensionKey(request.usage.model)));
  }
  const eventsBySession = new Map<string, OverviewEvent[]>(), requestsBySession = new Map<string, OverviewRequest[]>();
  for (const event of selected.events) { const group = eventsBySession.get(event.sessionId) ?? []; group.push(event); eventsBySession.set(event.sessionId, group); }
  for (const request of selected.requests) { const group = requestsBySession.get(request.sessionId) ?? []; group.push(request); requestsBySession.set(request.sessionId, group); }
  const relationshipModels = new Map<string, Set<string>>();
  if (evidence.kind === "delegation") {
    const related = selectedSource(source, query, evidenceRange, true);
    for (const request of related.requests) if (request.usage.model) {
      const models = relationshipModels.get(request.sessionId) ?? new Set<string>(); models.add(request.usage.model); relationshipModels.set(request.sessionId, models);
    }
  }
  const requestContexts = new Map<string, NonNullable<OverviewEvidenceRow["values"]>>();
  function prepareRequestContexts(contextSessionIds: Set<string>): void {
    if (!contextSessionIds.size) return;
    const orderedRequests = new Map<string, OverviewRequest[]>();
    for (const request of scopedSource.requests) { if (!contextSessionIds.has(request.sessionId)) continue; const group = orderedRequests.get(request.sessionId) ?? []; group.push(request); orderedRequests.set(request.sessionId, group); }
    const contextEvents = scopedSource.events.filter(event => contextSessionIds.has(event.sessionId));
    const compressionEvents = contextEvents.filter(event => event.kind === "compression");
    const eventById = new Map(contextEvents.map(event => [`${event.sessionId}\u0000${event.id}`, event]));
    const eventOrdinal = (request: OverviewRequest | undefined) => request ? [request.usage.messageId, ...(request.usage.requestMessageIds ?? [])]
      .flatMap(id => id !== undefined && eventById.has(`${request.sessionId}\u0000${id}`) ? [eventById.get(`${request.sessionId}\u0000${id}`)!.ordinal] : [])
      .sort((a, b) => a - b)[0] : undefined;
    for (const [sessionId, requests] of orderedRequests) {
      requests.sort((a, b) => (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity) || a.usage.id.localeCompare(b.usage.id));
      let segment = 0;
      const reliable = (request: OverviewRequest | undefined) => !!request && request.ordinal !== undefined && !!request.usage.model && localDay(request.usage.occurredAt, timezone) !== null;
      for (let index = 0; index < requests.length; index += 1) {
        const request = requests[index]!, previous = requests[index - 1], next = requests[index + 1];
        const joined = reliable(request) && reliable(previous) && request.ordinal !== previous!.ordinal && request.usage.model === previous!.usage.model;
        if (!joined) segment += 1;
        const previousOrdinal = eventOrdinal(previous), currentOrdinal = eventOrdinal(request);
        const compressions = previousOrdinal !== undefined && currentOrdinal !== undefined
          ? compressionEvents.filter(event => event.sessionId === sessionId && event.ordinal > previousOrdinal && event.ordinal <= currentOrdinal).map(event => event.id) : [];
        requestContexts.set(`${sessionId}\u0000${request.usage.id}`, {
          segmentId: `${sessionId}:${segment}`, previousModel: reliable(request) && reliable(previous) ? previous!.usage.model! : null,
          nextModel: reliable(request) && reliable(next) ? next!.usage.model! : null,
          previousRequestId: reliable(request) && reliable(previous) ? previous!.usage.id : null,
          nextRequestId: reliable(request) && reliable(next) ? next!.usage.id : null,
          sequenceBreak: !joined, eventOrdinal: currentOrdinal ?? null, compressions: JSON.stringify(compressions),
        });
      }
    }
  }
  const eventMatch = (event: OverviewEvent) => (!evidence.turnId || event.turnId === evidence.turnId)
    && (!evidence.tool || event.tool === evidence.tool) && (!evidence.status || event.status === evidence.status)
    && (!evidence.server || event.resource?.server === evidence.server)
    && (!evidence.toolId || JSON.stringify([event.tool ?? null, event.resource?.server ?? null]) === evidence.toolId)
    && (!evidence.category || toolCategory(event.tool, event.resource) === evidence.category);
  const base = (sessionId: string): Omit<OverviewEvidenceRow, "id" | "kind"> => {
    const session = byId.get(sessionId)!;
    return { sessionId, title: session.title, titleOrigin: session.titleOrigin, client: session.client,
      project: session.project, relationship: session.relationship };
  };
  const eventRow = (event: OverviewEvent): OverviewEvidenceRow => ({ ...base(event.sessionId), id: `${event.sessionId}:${event.id}`,
    kind: evidence.kind, messageId: event.id, resultMessageId: event.resultMessageId, turnId: event.turnId,
    ordinal: event.ordinal, occurredAt: event.occurredAt, day: localDay(event.occurredAt, timezone) ?? undefined,
    tool: event.tool, status: event.status, durationMs: event.durationMs, model: event.model,
    values: { eventKind: event.kind, pairing: event.pairing ?? null } });
  const requestRow = (request: OverviewRequest): OverviewEvidenceRow => ({ ...base(request.sessionId),
    id: `${request.sessionId}:${request.usage.id}`, kind: evidence.kind, requestId: request.usage.id,
    messageId: request.usage.messageId ?? request.usage.requestMessageIds?.[0], ordinal: request.ordinal, turnId: request.usage.turnId,
    occurredAt: request.usage.occurredAt, day: localDay(request.usage.occurredAt, timezone) ?? undefined,
    tokens: tokens(request), inputTokens: request.usage.inputTokens, cachedInputTokens: request.usage.cachedInputTokens,
    cacheWriteTokens: request.usage.cacheWriteTokens, durationMs: request.usage.timing?.durationMs, model: request.usage.model,
    usage: request.usage });
  let rows: OverviewEvidenceRow[] = [];
  if (evidence.kind === "activity" || evidence.kind === "compressions") {
    rows = selected.events.filter(event => eventMatch(event) && (evidence.kind !== "compressions" || event.kind === "compression")).map(eventRow);
    if (evidence.kind === "activity") {
      const included = new Set(rows.map(row => `${row.sessionId}\u0000${row.messageId}`));
      rows.push(...selected.requests.filter(request => ![request.usage.messageId, ...(request.usage.requestMessageIds ?? []),
        request.usage.timing?.end?.source !== "mirror" ? request.usage.timing?.end?.messageId : undefined]
        .some(id => id && included.has(`${request.sessionId}\u0000${id}`))).map(requestRow));
    }
  } else if (evidence.kind === "requests" || evidence.kind === "timing") {
    rows = selected.requests.filter(request => (!evidence.turnId || request.usage.turnId === evidence.turnId)
      && (!evidence.requestId || request.usage.id === evidence.requestId)
      && (evidence.ordinalFrom === undefined || request.ordinal !== undefined && request.ordinal >= evidence.ordinalFrom)
      && (evidence.ordinalTo === undefined || request.ordinal !== undefined && request.ordinal <= evidence.ordinalTo)
      && (!evidence.model || usageDimensionKey(request.usage.model) === evidence.model)
      && (evidence.kind !== "timing" || validDuration(request.usage))
      && (!evidence.timingGroup || timingGroupId(byId.get(request.sessionId)!, request.usage) === evidence.timingGroup)).map(requestRow);
  } else if (evidence.kind === "resources") {
    rows = selected.resources.filter(event => (!evidence.resourceId || resourceIdentity(event) === evidence.resourceId)
      && (!evidence.resourceKind || (event.kind === "mcp" ? "mcp" : "skill") === evidence.resourceKind)
      && (!evidence.resourceEvidenceKind || event.kind === evidence.resourceEvidenceKind)
      && (!evidence.server || event.server === evidence.server)
      && (!evidence.toolId || JSON.stringify([event.tool ?? null, event.server ?? null]) === evidence.toolId)
      && (!evidence.tool || event.tool === evidence.tool) && (!evidence.turnId || event.turnId === evidence.turnId)
      && (!evidence.status || event.status === evidence.status)).map(event => ({ ...base(event.sessionId), id: event.id,
      kind: evidence.kind, messageId: event.messageId, resultMessageId: event.resultMessageId, turnId: event.turnId,
      ordinal: event.ordinal, occurredAt: event.occurredAt, day: localDay(event.occurredAt, timezone) ?? undefined,
      resourceId: resourceIdentity(event), resourceName: event.kind === "mcp" ? event.server ?? event.name : event.name,
      resourceKind: event.kind === "mcp" ? "mcp" : "skill", resourceEvidenceKind: event.kind,
      tool: event.tool, status: event.status, durationMs: event.durationMs, values: { pairing: event.pairing } }));
  } else if (evidence.kind === "tools" || evidence.kind === "failures" || evidence.kind === "sequence") {
    const selectedIds = new Set(selected.events.filter(event => event.kind === "tool_call").map(event => `${event.sessionId}\u0000${event.id}`));
    const calls = pairToolCalls(source.events.filter(isActivityEvent)).filter(event => selectedIds.has(`${event.sessionId}\u0000${event.id}`));
    if (evidence.kind === "sequence") {
      const sequences = failureSequences(source, calls).filter(sequence => (!evidence.turnId || sequence.turnId === evidence.turnId)
        && (!evidence.tool || sequence.tool === evidence.tool) && (!evidence.server || sequence.server === evidence.server)
        && (!evidence.toolId || JSON.stringify([sequence.tool, sequence.server ?? null]) === evidence.toolId));
      const included = new Set(sequences.flatMap(sequence => sequence.calls.map(call => `${sequence.sessionId}\u0000${call.messageId}`)));
      rows = calls.filter(event => included.has(`${event.sessionId}\u0000${event.id}`)).map(eventRow);
    } else rows = calls.filter(event => eventMatch(event) && (evidence.kind !== "failures" || event.status === "failure")).map(eventRow);
  } else if (evidence.kind === "combinations") {
    const turns = trueTurnIds(source), units = new Map<string, typeof selected.resources>();
    for (const event of selected.resources) {
      const turnKey = `${event.sessionId}\u0000${event.turnId}`;
      if (evidence.unit === "turn" && !turns.has(turnKey)) continue;
      const key = evidence.unit === "turn" ? turnKey : event.sessionId, group = units.get(key) ?? [];
      group.push(event); units.set(key, group);
    }
    for (const [id, events] of units) {
      const identities = new Set(events.map(resourceIdentity));
      if (evidence.resourceId && !identities.has(evidence.resourceId) || evidence.resourceId2 && !identities.has(evidence.resourceId2) || identities.size < 2) continue;
      const first = events[0]!, filtered = events.filter(event => !evidence.resourceId && !evidence.resourceId2
        || resourceIdentity(event) === evidence.resourceId || resourceIdentity(event) === evidence.resourceId2);
      rows.push({ ...base(first.sessionId), id, kind: evidence.kind, turnId: evidence.unit === "turn" ? first.turnId : undefined,
        messageId: filtered[0]?.messageId, relatedMessageIds: [...new Set(filtered.map(event => event.messageId))],
        occurredAt: filtered.at(-1)?.occurredAt, values: { uses: filtered.length, resources: identities.size } });
    }
  } else if (evidence.kind === "observations") {
    rows = resourceObservations(source, selected, evidenceRange, timezone).filter(observation => (!evidence.resourceId || observation.resourceId === evidence.resourceId)
      && (!evidence.observationState || observation.state === evidence.observationState)).flatMap(observation => {
      const first = selected.resources.find(event => event.id === observation.firstEventId); if (!first) return [];
      return [{ ...base(first.sessionId), id: observation.resourceId, kind: evidence.kind, messageId: first.messageId,
        resourceId: observation.resourceId, resourceName: observation.name, resourceKind: observation.kind, occurredAt: first.occurredAt,
        values: { firstDay: observation.firstDay, from: observation.window.from, to: observation.window.to,
          state: observation.state, reused: observation.reused, subsequentDays: observation.subsequentDays } }];
    });
  } else {
    const activeIds = new Set([...selected.events.map(event => event.sessionId), ...selected.requests.map(request => request.sessionId)]);
    rows = sessions.filter(session => activeIds.has(session.id)).map(session => sessionRow(session));
    if (evidence.rule === "13") rows = rows.filter(row => (row.dates?.length ?? 0) >= 2);
  }
  if (evidence.transition === "switch") {
    prepareRequestContexts(new Set(rows.map(row => row.sessionId)));
    rows = rows.filter(row => {
      const context = row.requestId ? requestContexts.get(`${row.sessionId}\u0000${row.requestId}`) : undefined;
      return context?.previousModel !== null && context?.previousModel !== undefined && row.model !== context.previousModel
        && (!evidence.modelFrom || context.previousModel === evidence.modelFrom) && (!evidence.modelTo || row.model === evidence.modelTo);
    });
  }
  if (evidence.transition === "delegation") rows = rows.filter(row => {
    const parentModels = JSON.parse(String(row.values?.parentModels ?? "[]")) as string[];
    const childModels = JSON.parse(String(row.values?.childModels ?? "[]")) as string[];
    return row.relationship === "child" && parentModels.length > 0 && childModels.length > 0
      && (!evidence.modelFrom || parentModels.includes(evidence.modelFrom)) && (!evidence.modelTo || childModels.includes(evidence.modelTo));
  });
  rows.sort((a, b) => evidence.sort === "tokens" ? (b.tokens ?? -1) - (a.tokens ?? -1) || a.id.localeCompare(b.id)
    : evidence.sort === "duration" ? (b.durationMs ?? -1) - (a.durationMs ?? -1) || a.id.localeCompare(b.id)
    : evidence.sort === "ordinal" ? a.sessionId.localeCompare(b.sessionId) || (a.ordinal ?? Number.MAX_SAFE_INTEGER) - (b.ordinal ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id)
    : (instant(b.occurredAt) ?? -Infinity) - (instant(a.occurredAt) ?? -Infinity) || a.id.localeCompare(b.id));
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
  prepareRequestContexts(new Set(pageRows.filter(row => row.requestId).map(row => row.sessionId)));
  for (const row of pageRows) if (row.usage) {
    row.cost = pricing.estimate(row.usage, byId.get(row.sessionId)!.client);
    row.values = requestContexts.get(`${row.sessionId}\u0000${row.requestId}`);
  }
  return { version: source.version, priceVersion: pricing.status.version, timezone, query: evidence, range,
    rows: pageRows, total: rows.length, page, pageSize };

  function empty(): OverviewEvidencePage { return { version: source.version, priceVersion: pricing.status.version, timezone, query: evidence, range, rows: [], total: 0, page, pageSize }; }
  function sessionRow(session: SessionSummary): OverviewEvidenceRow {
    const events = eventsBySession.get(session.id) ?? [], requests = requestsBySession.get(session.id) ?? [];
    const dates = [...new Set([...events.map(event => localDay(event.occurredAt, timezone)), ...requests.map(request => localDay(request.usage.occurredAt, timezone))]
      .filter((day): day is string => day !== null))].sort();
    const values = requests.flatMap(request => tokens(request) ?? []), times = [...events.map(event => event.occurredAt), ...requests.map(request => request.usage.occurredAt)]
      .filter((value): value is string => instant(value) !== undefined).sort((a, b) => instant(b)! - instant(a)!);
    return { ...base(session.id), id: session.id, kind: evidence.kind, occurredAt: times[0], dates,
      tokens: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
      values: { requests: requests.length, activityDays: dates.length, activeDays: dates.length, events: events.length, gapCount: session.gaps.length,
        maxGapDays: dates.slice(1).reduce((maximum, day, index) => Math.max(maximum, daysBetween(dates[index]!, day)), 0),
        dateGaps: JSON.stringify(dates.slice(1).map((day, index) => daysBetween(dates[index]!, day))),
        ...(evidence.kind === "delegation" ? { parentSessionId: session.parentSessionId ?? null,
          parentModels: JSON.stringify(session.parentSessionId ? [...relationshipModels.get(session.parentSessionId) ?? []] : []),
          childModels: JSON.stringify(session.relationship === "child" ? [...relationshipModels.get(session.id) ?? []]
            : [...new Set(source.sessions.filter(child => child.relationship === "child" && child.parentSessionId === session.id)
              .flatMap(child => [...relationshipModels.get(child.id) ?? []]))]) } : {}) } };
  }
}
function tokens(request: OverviewRequest): number | null {
  const input = request.usage.inputTokens, output = request.usage.outputTokens;
  const validInput = input !== undefined && Number.isFinite(input) && input >= 0, validOutput = output !== undefined && Number.isFinite(output) && output >= 0;
  return !validInput && !validOutput ? null : (validInput ? input : 0) + (validOutput ? output : 0);
}
function invalid(field: string): never {
  throw new StoreError("INVALID_INPUT", "无效证据筛选", { key: "diagnostics.usage.invalidQuery", params: { field } });
}
