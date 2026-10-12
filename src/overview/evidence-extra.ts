import type { OverviewEvent, OverviewEvidencePage, OverviewEvidenceQuery, OverviewEvidenceRow, OverviewRequest, OverviewSnapshot } from "../overview-contracts.js";
import type { SessionSummary } from "../session-contracts.js";
import type { PricingView } from "../usage/pricing.js";
import { resourceGapRelevant } from "../resources/coverage.js";
import { resourceNameDescriptor, toolCategory } from "./analytics.js";
import { addDays, daysBetween, localDay } from "./dates.js";
import type { FactEvidenceScope } from "./evidence-scope.js";
import type { OverviewFactStore } from "./facts.js";

type EventRecord = Parameters<OverviewFactStore["decodeEvent"]>[0];
type RequestRecord = Parameters<OverviewFactStore["decodeRequest"]>[0];
type ResourceRecord = Parameters<OverviewFactStore["decodeResource"]>[0] & { resource_id: string; known: number };
type Value = string | number | null;
interface Candidate {
  id: string; raw_id: string; revision: string; session_id: string; time_ms: number | null;
  ordinal: number | null; tokens: number | null; duration_ms: number | null; type?: "event" | "request";
}
interface Context {
  id: string; revision: string; session_id: string; segment: number; joined: number;
  previous_id: string | null; previous_model: string | null; next_model: string | null;
  previous_ordinal: number | null; next_id: string | null;
  reliable_previous_model: string | null; reliable_next_model: string | null;
  reliable_previous_id: string | null; reliable_next_id: string | null;
}
const revisionWhere = "f.revision IN (SELECT value FROM json_each(?))";
const joinRevision = "JOIN overview_fact_revisions r ON r.revision=f.revision";
const tokensSql = "CASE WHEN f.input_tokens>=0 OR f.output_tokens>=0 THEN MAX(COALESCE(f.input_tokens,0),0)+MAX(COALESCE(f.output_tokens,0),0) END";
const modelKey = "CASE WHEN f.model IS NULL OR trim(f.model)='' THEN 'unknown' WHEN f.model='unknown' OR substr(f.model,1,8)='literal:' THEN 'literal:'||f.model ELSE f.model END";

/** 复杂调查只在 SQL 中聚合窄身份，页内才恢复原事件和请求成员。 */
export async function factExtraEvidence(store: OverviewFactStore, snapshot: OverviewSnapshot, evidence: OverviewEvidenceQuery,
  pricing: PricingView, _now: Date, scope: FactEvidenceScope): Promise<OverviewEvidencePage> {
  if (!scope.revisions.length) return scope.initial;
  if (evidence.kind === "sessions" || evidence.kind === "delegation") return sessionEvidence(store, snapshot, evidence, scope);
  if (evidence.kind === "activity") return activityEvidence(store, snapshot, evidence, pricing, scope);
  if (evidence.kind === "observations") return observationEvidence(store, evidence, scope);
  if (evidence.kind === "combinations") return combinationEvidence(store, evidence, scope);
  if (evidence.kind === "requests" || evidence.kind === "timing" || evidence.kind === "sequence" && evidence.scope === "usage") {
    return requestEvidence(store, snapshot, evidence, pricing, scope);
  }
  return eventEvidence(store, evidence, scope);
}

function base(scope: FactEvidenceScope, sessionId: string): Omit<OverviewEvidenceRow, "id" | "kind"> {
  const session = scope.metadata.sessions.find(row => row.id === sessionId)!;
  return { sessionId, title: session.title, titleOrigin: session.titleOrigin, client: session.client,
    project: session.project, relationship: session.relationship };
}
function pageResult(scope: FactEvidenceScope, rows: OverviewEvidenceRow[], total: number): OverviewEvidencePage {
  return { ...scope.initial, rows, total };
}
function requestConditions(snapshot: OverviewSnapshot, evidence: OverviewEvidenceQuery, scope: FactEvidenceScope, filters: boolean) {
  const where = [revisionWhere, scope.time], values = [...scope.values];
  const add = (condition: string, value?: Value) => { where.push(condition); if (value !== undefined) values.push(value); };
  if (evidence.scope === "usage" || evidence.kind === "timing") {
    if (scope.query.models?.length) add(`${modelKey} IN (SELECT value FROM json_each(?))`, JSON.stringify(scope.query.models));
    if (snapshot.query.models?.length) add(`${modelKey} IN (SELECT value FROM json_each(?))`, JSON.stringify(snapshot.query.models));
  }
  if (filters) {
    if (evidence.model) add(`${modelKey}=?`, evidence.model);
    if (evidence.turnId) add("json_extract(f.json,'$.usage.turnId')=?", evidence.turnId);
    if (evidence.requestId) add("f.id=?", evidence.requestId);
    if (evidence.ordinalFrom !== undefined) add("f.ordinal>=?", evidence.ordinalFrom);
    if (evidence.ordinalTo !== undefined) add("f.ordinal<=?", evidence.ordinalTo);
    if (evidence.kind === "timing") add("overview_valid_timing(json_extract(f.json,'$.usage.timing'))=1");
    if (evidence.timingGroup) {
      const clients = JSON.stringify(scope.metadata.sessions.map(session => ({ id: session.id, client: session.client })));
      add(`json_array((SELECT json_extract(value,'$.client') FROM json_each(?) WHERE json_extract(value,'$.id')=r.session_id),
        f.model,COALESCE(json_extract(f.json,'$.usage.timing.window'),'response'),
        json_extract(f.json,'$.usage.timing.basis'),json_extract(f.json,'$.usage.timing.method'))=?`, clients);
      values.push(evidence.timingGroup);
    }
  }
  return { where: where.join(" AND "), values };
}
function eventConditions(evidence: OverviewEvidenceQuery, scope: FactEvidenceScope) {
  const where = [revisionWhere, scope.time, "f.active=1"], values = [...scope.values];
  const add = (condition: string, value?: Value) => { where.push(condition); if (value !== undefined) values.push(value); };
  if (evidence.turnId) add("f.turn_id=?", evidence.turnId);
  if (evidence.tool) add("f.tool=?", evidence.tool);
  if (evidence.status && evidence.kind !== "activity") add("f.status=?", evidence.status);
  if (evidence.toolKey !== undefined) add("CASE WHEN f.tool IS NULL THEN 'unknown' WHEN f.tool='unknown' OR substr(f.tool,1,8)='literal:' THEN 'literal:'||f.tool ELSE f.tool END=?", evidence.toolKey);
  if (evidence.server) add("json_extract(f.json,'$.resource.server')=?", evidence.server);
  if (evidence.toolId) add("json_array(f.tool,json_extract(f.json,'$.resource.server'))=?", evidence.toolId);
  return { where: where.join(" AND "), values };
}
function compare(evidence: OverviewEvidenceQuery, a: Candidate, b: Candidate): number {
  const order = evidence.sort === "tokens" ? (b.tokens ?? -1) - (a.tokens ?? -1) || a.id.localeCompare(b.id)
    : evidence.sort === "duration" ? (b.duration_ms ?? -1) - (a.duration_ms ?? -1) || a.id.localeCompare(b.id)
    : evidence.sort === "ordinal" ? a.session_id.localeCompare(b.session_id)
      || (a.ordinal ?? Number.MAX_SAFE_INTEGER) - (b.ordinal ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id)
    : (b.time_ms ?? -Infinity) - (a.time_ms ?? -Infinity) || a.id.localeCompare(b.id);
  // 活动原构建顺序是事件在前、独立请求在后，两种来源可有相同字符串身份。
  return order || (a.type === "request" ? 1 : 0) - (b.type === "request" ? 1 : 0);
}

/** 保留偏移量加一页的窄候选，不把排序所需对象扩成完整事实。 */
class PageSelection<T extends Candidate> {
  private readonly heap: T[] = [];
  total = 0;
  constructor(private readonly evidence: OverviewEvidenceQuery, private readonly scope: FactEvidenceScope) {}
  add(row: T): void {
    this.total += 1;
    const limit = this.scope.initial.page * this.scope.initial.pageSize;
    if (this.heap.length < limit) { this.heap.push(row); this.up(this.heap.length - 1); }
    else if (compare(this.evidence, row, this.heap[0]!) < 0) { this.heap[0] = row; this.down(0); }
  }
  page(): T[] {
    return this.heap.sort((a, b) => compare(this.evidence, a, b))
      .slice((this.scope.initial.page - 1) * this.scope.initial.pageSize);
  }
  private up(index: number): void {
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (compare(this.evidence, this.heap[index]!, this.heap[parent]!) <= 0) return;
      [this.heap[index], this.heap[parent]] = [this.heap[parent]!, this.heap[index]!]; index = parent;
    }
  }
  private down(index: number): void {
    for (;;) {
      const left = index * 2 + 1, right = left + 1;
      let worst = index;
      if (left < this.heap.length && compare(this.evidence, this.heap[left]!, this.heap[worst]!) > 0) worst = left;
      if (right < this.heap.length && compare(this.evidence, this.heap[right]!, this.heap[worst]!) > 0) worst = right;
      if (worst === index) return;
      [this.heap[index], this.heap[worst]] = [this.heap[worst]!, this.heap[index]!]; index = worst;
    }
  }
}
function candidateColumns(type: "event" | "request") {
  return `r.session_id||':'||f.id AS id,f.id AS raw_id,f.revision,r.session_id,f.time_ms,f.ordinal,
    ${type === "request" ? tokensSql : "NULL"} AS tokens,
    json_extract(f.json,'${type === "request" ? "$.usage.timing.durationMs" : "$.durationMs"}') AS duration_ms`;
}
function readIdentities<T>(store: OverviewFactStore, table: "events" | "requests", page: Pick<Candidate, "revision" | "raw_id">[]): T[] {
  if (!page.length) return [];
  return store.readRows<T>(`SELECT f.*,r.session_id FROM overview_fact_${table} f ${joinRevision}
    JOIN json_each(?) p ON f.revision=json_extract(p.value,'$.revision') AND f.id=json_extract(p.value,'$.raw_id')`, [JSON.stringify(page)]);
}
function eventRow(store: OverviewFactStore, scope: FactEvidenceScope, evidence: OverviewEvidenceQuery, raw: EventRecord, hydrated?: OverviewEvent): OverviewEvidenceRow {
  const event = hydrated ?? store.decodeEvent(raw);
  return { ...base(scope, event.sessionId), id: `${event.sessionId}:${event.id}`, kind: evidence.kind, messageId: event.id,
    resultMessageId: event.resultMessageId, turnId: event.turnId, ordinal: event.ordinal, occurredAt: event.occurredAt,
    day: localDay(event.occurredAt, scope.initial.timezone) ?? undefined, tool: event.tool, status: event.status,
    durationMs: event.durationMs, model: event.model,
    values: { eventKind: event.kind, pairing: event.pairing ?? null, server: event.resource?.server ?? null } };
}

function requestWindows() {
  const reliable = (prefix: string) => `${prefix}ordinal IS NOT NULL AND ${prefix}model IS NOT NULL AND ${prefix}model<>'' AND ${prefix}time_ms IS NOT NULL`;
  return `WITH ordered AS (SELECT f.revision,f.id,f.ordinal,f.model,f.time_ms,
    LAG(f.id) OVER w AS previous_id,LAG(f.ordinal) OVER w AS previous_ordinal,LAG(f.model) OVER w AS previous_model,LAG(f.time_ms) OVER w AS previous_time_ms,
    LEAD(f.id) OVER w AS next_id,LEAD(f.model) OVER w AS next_model,LEAD(f.time_ms) OVER w AS next_time_ms,
    LEAD(f.ordinal) OVER w AS next_ordinal FROM overview_fact_requests f WHERE ${revisionWhere}
    WINDOW w AS (PARTITION BY f.revision ORDER BY f.ordinal,f.id)),
    joined AS (SELECT *,CASE WHEN ${reliable("")} AND ${reliable("previous_")}
      AND ordinal<>previous_ordinal AND model=previous_model THEN 1 ELSE 0 END AS joined,
      CASE WHEN ${reliable("")} AND ${reliable("previous_")} THEN previous_model END AS reliable_previous_model,
      CASE WHEN ${reliable("")} AND ${reliable("next_")} THEN next_model END AS reliable_next_model,
      CASE WHEN ${reliable("")} AND ${reliable("previous_")} THEN previous_id END AS reliable_previous_id,
      CASE WHEN ${reliable("")} AND ${reliable("next_")} THEN next_id END AS reliable_next_id FROM ordered),
    contexts AS (SELECT *,SUM(1-joined) OVER (PARTITION BY revision ORDER BY ordinal,id ROWS UNBOUNDED PRECEDING) AS segment FROM joined)`;
}
function requestEvidence(store: OverviewFactStore, snapshot: OverviewSnapshot, evidence: OverviewEvidenceQuery, pricing: PricingView, scope: FactEvidenceScope): OverviewEvidencePage {
  const selected = requestConditions(snapshot, evidence, scope, true), selection = new PageSelection(evidence, scope);
  const switchFilter = evidence.transition === "switch" ? ` AND c.reliable_previous_model IS NOT NULL AND f.model<>c.reliable_previous_model
    ${evidence.modelFrom ? " AND c.reliable_previous_model=?" : ""}${evidence.modelTo ? " AND f.model=?" : ""}` : "";
  for (const row of store.iterateRows<Candidate>(`${requestWindows()} SELECT ${candidateColumns("request")} FROM overview_fact_requests f ${joinRevision}
    JOIN contexts c ON c.revision=f.revision AND c.id=f.id WHERE ${selected.where}${switchFilter}`,
    [JSON.stringify(scope.revisions), ...selected.values, ...(evidence.transition === "switch" ? [evidence.modelFrom, evidence.modelTo].filter((value): value is string => !!value) : [])])) selection.add(row);
  const page = selection.page(), rows = hydrateFactRequestEvidence(store, snapshot, evidence, scope, readIdentities<RequestRecord>(store, "requests", page), pricing);
  const byId = new Map(rows.map(row => [row.id, row]));
  return pageResult(scope, page.map(row => byId.get(row.id)!), selection.total);
}

/** 原请求成员只读当前页与直接前邻居；序列段及前后模型由 SQL 窗口保留。 */
export function hydrateFactRequestEvidence(store: OverviewFactStore, _snapshot: OverviewSnapshot, evidence: OverviewEvidenceQuery,
  scope: FactEvidenceScope, page: RequestRecord[], pricing: PricingView): OverviewEvidenceRow[] {
  if (!page.length) return [];
  const contexts = store.readRows<Context>(`${requestWindows()} SELECT c.*,r.session_id FROM contexts c
    JOIN overview_fact_revisions r ON r.revision=c.revision JOIN json_each(?) p
      ON c.revision=json_extract(p.value,'$.revision') AND c.id=json_extract(p.value,'$.id')`,
    [JSON.stringify([...new Set(page.map(row => row.revision))]), JSON.stringify(page)]);
  const predecessors = store.readRows<RequestRecord>(`SELECT f.*,r.session_id FROM overview_fact_requests f ${joinRevision}
    JOIN json_each(?) p ON f.revision=json_extract(p.value,'$.revision') AND f.id=json_extract(p.value,'$.previous_id')`, [JSON.stringify(contexts)]);
  const unique = new Map([...page, ...predecessors].map(row => [`${row.revision}\u0000${row.id}`, row]));
  const needed = [...unique.values()], hydrated = store.hydrateRequestMembers(needed);
  const byId = new Map(hydrated.map(row => [`${row.sessionId}\u0000${row.usage.id}`, row]));
  const members = JSON.stringify(needed.flatMap((row, index) => memberIds(hydrated[index]!).map(id => ({ revision: row.revision, id }))));
  const ordinals = new Map<string, number>();
  for (const event of store.iterateRows<{ revision: string; id: string; ordinal: number }>(`SELECT DISTINCT f.revision,f.id,f.ordinal
    FROM overview_fact_events f JOIN json_each(?) p ON f.revision=json_extract(p.value,'$.revision') AND f.id=json_extract(p.value,'$.id')`, [members])) {
    ordinals.set(`${event.revision}\u0000${event.id}`, event.ordinal);
  }
  const firstOrdinal = (revision: string, request: OverviewRequest | undefined) => request ? memberIds(request)
    .map(id => ordinals.get(`${revision}\u0000${id}`)).filter((ordinal): ordinal is number => ordinal !== undefined).sort((a, b) => a - b)[0] : undefined;
  const contextById = new Map(contexts.map(context => [`${context.session_id}\u0000${context.id}`, context]));
  const intervals = page.flatMap(row => {
    const context = contextById.get(`${row.session_id}\u0000${row.id}`)!, request = byId.get(`${row.session_id}\u0000${row.id}`);
    const from = firstOrdinal(row.revision, context.previous_id ? byId.get(`${row.session_id}\u0000${context.previous_id}`) : undefined), to = firstOrdinal(row.revision, request);
    return from !== undefined && to !== undefined && from < to ? [{ revision: row.revision, requestId: row.id, from, to }] : [];
  });
  const compressions = new Map<string, string[]>();
  for (const event of store.iterateRows<{ revision: string; id: string; request_id: string }>(`SELECT f.revision,f.id,json_extract(p.value,'$.requestId') AS request_id
    FROM overview_fact_events f JOIN json_each(?) p ON f.revision=json_extract(p.value,'$.revision')
      AND f.ordinal>json_extract(p.value,'$.from') AND f.ordinal<=json_extract(p.value,'$.to')
    WHERE f.kind='compression' ORDER BY f.ordinal,f.id`, [JSON.stringify(intervals)])) {
    const key = `${event.revision}\u0000${event.request_id}`, ids = compressions.get(key) ?? []; ids.push(event.id); compressions.set(key, ids);
  }
  return page.map(raw => {
    const request = byId.get(`${raw.session_id}\u0000${raw.id}`)!, usage = request.usage;
    const context = contextById.get(`${raw.session_id}\u0000${raw.id}`)!, currentOrdinal = firstOrdinal(raw.revision, request);
    const previousOrdinal = firstOrdinal(raw.revision, context.previous_id ? byId.get(`${raw.session_id}\u0000${context.previous_id}`) : undefined);
    return { ...base(scope, raw.session_id), id: `${raw.session_id}:${raw.id}`, kind: evidence.kind, requestId: raw.id,
      messageId: usage.messageId ?? usage.requestMessageIds?.[0], ordinal: request.ordinal, turnId: usage.turnId,
      occurredAt: usage.occurredAt, day: localDay(usage.occurredAt, scope.initial.timezone) ?? undefined,
      tokens: raw.input_tokens !== null && raw.input_tokens >= 0 || raw.output_tokens !== null && raw.output_tokens >= 0
        ? Math.max(raw.input_tokens ?? 0, 0) + Math.max(raw.output_tokens ?? 0, 0) : null,
      inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, cacheWriteTokens: usage.cacheWriteTokens,
      durationMs: usage.timing?.durationMs, model: usage.model, usage, cost: pricing.estimate(usage, base(scope, raw.session_id).client),
      values: { segmentId: `${raw.session_id}:${context.segment}`, previousModel: context.reliable_previous_model ?? null,
        nextModel: context.reliable_next_model ?? null, previousRequestId: context.reliable_previous_id ?? null,
        nextRequestId: context.reliable_next_id ?? null,
        sequenceBreak: !context.joined, eventOrdinal: currentOrdinal ?? null,
        compressions: previousOrdinal !== undefined && currentOrdinal !== undefined && previousOrdinal < currentOrdinal
          ? JSON.stringify(compressions.get(`${raw.revision}\u0000${raw.id}`) ?? []) : null } };
  });
}
function memberIds(request: OverviewRequest): string[] {
  return [request.usage.messageId, ...(request.usage.requestMessageIds ?? [])].filter((id): id is string => id !== undefined);
}

function pointsSql(snapshot: OverviewSnapshot, evidence: OverviewEvidenceQuery, scope: FactEvidenceScope) {
  const requests = requestConditions(snapshot, evidence, scope, false);
  return { sql: `WITH points AS (
    SELECT f.revision,f.id,f.ordinal,f.time_ms,json_extract(f.json,'$.occurredAt') AS occurred_at,0 AS request,NULL AS tokens
      FROM overview_fact_events f WHERE ${revisionWhere} AND ${scope.time} AND f.active=1
    UNION ALL SELECT f.revision,f.id,f.ordinal,f.time_ms,f.occurred_at,1 AS request,${tokensSql} AS tokens
      FROM overview_fact_requests f ${joinRevision} WHERE ${requests.where})`, values: [...scope.values, ...requests.values] };
}
function sessionEvidence(store: OverviewFactStore, snapshot: OverviewSnapshot, evidence: OverviewEvidenceQuery, scope: FactEvidenceScope): OverviewEvidencePage {
  const points = pointsSql(snapshot, evidence, scope), selection = new PageSelection<Candidate & { events: number; requests: number }>(evidence, scope);
  const models = evidence.kind === "delegation" ? relationshipModels(store, snapshot, scope) : new Map<string, string[]>();
  const metadata = new Map(scope.metadata.sessions.map(session => [session.id, session]));
  const children = new Map<string, string[]>();
  for (const session of scope.metadata.sessions) if (session.relationship === "child" && session.parentSessionId) {
    const ids = children.get(session.parentSessionId) ?? []; ids.push(session.id); children.set(session.parentSessionId, ids);
  }
  const childModels = (session: SessionSummary) => session.relationship === "child" ? models.get(session.id) ?? []
    : [...new Set((children.get(session.id) ?? []).flatMap(id => models.get(id) ?? []))];
  for (const row of store.iterateRows<Candidate & { events: number; requests: number }>(`${points.sql}
    SELECT r.session_id AS id,r.session_id AS raw_id,p.revision,r.session_id,MAX(p.time_ms) AS time_ms,
      NULL AS ordinal,NULL AS duration_ms,SUM(p.tokens) AS tokens,SUM(1-p.request) AS events,SUM(p.request) AS requests,
      COUNT(DISTINCT overview_local_day(p.time_ms,?)) AS days FROM points p JOIN overview_fact_revisions r ON r.revision=p.revision
    GROUP BY p.revision${evidence.rule === "13" ? " HAVING days>=2" : ""}`, [...points.values, scope.initial.timezone])) {
    const session = metadata.get(row.session_id)!;
    if (evidence.transition === "delegation") {
      const parents = session.parentSessionId ? models.get(session.parentSessionId) ?? [] : [], own = childModels(session);
      if (session.relationship !== "child" || !parents.length || !own.length
        || evidence.modelFrom && !parents.includes(evidence.modelFrom) || evidence.modelTo && !own.includes(evidence.modelTo)) continue;
    }
    selection.add(row);
  }
  const page = selection.page(), pageScope = { ...scope, revisions: page.map(row => row.revision), values: [JSON.stringify(page.map(row => row.revision)), ...scope.values.slice(1)] };
  const pagePoints = pointsSql(snapshot, evidence, pageScope), dates = new Map<string, Set<string>>(), latest = new Map<string, string>();
  for (const point of store.iterateRows<{ revision: string; day: string | null }>(`${pagePoints.sql}
    SELECT DISTINCT revision,overview_local_day(time_ms,?) AS day FROM points`, [...pagePoints.values, scope.initial.timezone])) {
    if (point.day === null) continue;
    const days = dates.get(point.revision) ?? new Set<string>(); days.add(point.day); dates.set(point.revision, days);
  }
  for (const point of store.iterateRows<{ revision: string; occurred_at: string }>(`${pagePoints.sql}
    SELECT revision,occurred_at FROM (SELECT *,ROW_NUMBER() OVER (PARTITION BY revision ORDER BY time_ms DESC,request,ordinal,id) AS position
      FROM points WHERE time_ms IS NOT NULL) WHERE position=1`, pagePoints.values)) latest.set(point.revision, point.occurred_at);
  return pageResult(scope, page.map(row => {
    const session = metadata.get(row.session_id)!, days = [...dates.get(row.revision) ?? []].sort();
    const gaps = days.slice(1).map((day, index) => daysBetween(days[index]!, day));
    return { ...base(scope, row.session_id), id: row.session_id, kind: evidence.kind, occurredAt: latest.get(row.revision), dates: days, tokens: row.tokens,
      values: { requests: row.requests, activityDays: days.length, activeDays: days.length, events: row.events, gapCount: session.gaps.length,
        maxGapDays: gaps.reduce((maximum, gap) => Math.max(maximum, gap), 0), dateGaps: JSON.stringify(gaps),
        ...(evidence.kind === "delegation" ? { parentSessionId: session.parentSessionId ?? null,
          parentModels: JSON.stringify(session.parentSessionId ? models.get(session.parentSessionId) ?? [] : []),
          childModels: JSON.stringify(childModels(session)) } : {}) } };
  }), selection.total);
}
function relationshipModels(store: OverviewFactStore, snapshot: OverviewSnapshot, scope: FactEvidenceScope): Map<string, string[]> {
  const where = [revisionWhere, scope.time], values: Value[] = [JSON.stringify(scope.globalRevisions), ...scope.values.slice(1)];
  if (snapshot.query.models?.length) { where.push(`${modelKey} IN (SELECT value FROM json_each(?))`); values.push(JSON.stringify(snapshot.query.models)); }
  const groups = new Map<string, string[]>();
  for (const row of store.iterateRows<{ session_id: string; model: string }>(`SELECT r.session_id,f.model FROM overview_fact_requests f ${joinRevision}
    WHERE ${where.join(" AND ")} AND f.model IS NOT NULL AND f.model<>'' GROUP BY r.session_id,f.model ORDER BY r.session_id,MIN(f.ordinal)`, values)) {
    const models = groups.get(row.session_id) ?? []; models.push(row.model); groups.set(row.session_id, models);
  }
  return groups;
}

function activityEvidence(store: OverviewFactStore, snapshot: OverviewSnapshot, evidence: OverviewEvidenceQuery, pricing: PricingView, scope: FactEvidenceScope): OverviewEvidencePage {
  const events = eventConditions(evidence, scope), selection = new PageSelection<Candidate>(evidence, scope);
  const categoryMatch = (row: { tool: string | null; external: number }) => !evidence.category
    || toolCategory(row.tool ?? undefined, row.external ? { kind: "mcp", name: "" } : undefined) === evidence.category;
  if (evidence.status) {
    let batch: EventRecord[] = [];
    const addEvents = () => {
      for (const [index, event] of store.hydrateActivityEvents(batch).entries()) {
        if (event.status !== evidence.status || evidence.category && toolCategory(event.tool, event.resource) !== evidence.category) continue;
        const raw = batch[index]!;
        selection.add({ id: `${raw.session_id}:${raw.id}`, raw_id: raw.id, revision: raw.revision, session_id: raw.session_id,
          time_ms: raw.time_ms, ordinal: raw.ordinal, duration_ms: event.durationMs ?? null, tokens: null, type: "event" });
      }
      batch = [];
    };
    for (const raw of store.iterateRows<EventRecord>(`SELECT f.*,r.session_id FROM overview_fact_events f ${joinRevision} WHERE ${events.where}`, events.values)) {
      batch.push(raw); if (batch.length === 128) addEvents();
    }
    addEvents();
  } else {
    for (const row of store.iterateRows<Candidate & { tool: string | null; external: number }>(`SELECT ${candidateColumns("event")},f.tool,
      json_extract(f.json,'$.resource.kind')='mcp' AS external FROM overview_fact_events f ${joinRevision} WHERE ${events.where}`, events.values)) {
      if (categoryMatch(row)) selection.add({ ...row, type: "event" });
    }
  }
  const requests = requestConditions(snapshot, evidence, scope, false);
  let batch: RequestRecord[] = [];
  const addBatch = () => {
    if (!batch.length) return;
    const hydrated = store.hydrateRequestMembers(batch);
    const members = hydrated.flatMap((request, index) => [...memberIds(request),
      ...(request.usage.timing?.end?.source !== "mirror" && request.usage.timing?.end?.messageId ? [request.usage.timing.end.messageId] : [])]
      .map(id => ({ revision: batch[index]!.revision, id })));
    const included = new Set<string>();
    let statusCandidates: { revision: string; raw_id: string }[] = [];
    const addStatuses = () => {
      const raw = readIdentities<EventRecord>(store, "events", statusCandidates), hydrated = store.hydrateActivityEvents(raw);
      for (const [index, event] of hydrated.entries()) if (event.status === evidence.status) included.add(`${raw[index]!.revision}\u0000${event.id}`);
      statusCandidates = [];
    };
    for (const row of store.iterateRows<{ revision: string; id: string; tool: string | null; external: number }>(`SELECT DISTINCT f.revision,f.id,f.tool,
      json_extract(f.json,'$.resource.kind')='mcp' AS external FROM overview_fact_events f
      JOIN json_each(?) p ON f.revision=json_extract(p.value,'$.revision') AND f.id=json_extract(p.value,'$.id') WHERE ${events.where}`, [JSON.stringify(members), ...events.values])) {
      if (!categoryMatch(row)) continue;
      if (!evidence.status) included.add(`${row.revision}\u0000${row.id}`);
      else {
        statusCandidates.push({ revision: row.revision, raw_id: row.id });
        if (statusCandidates.length === 128) addStatuses();
      }
    }
    addStatuses();
    for (let index = 0; index < batch.length; index += 1) {
      const raw = batch[index]!, request = hydrated[index]!, ids = [...memberIds(request),
        ...(request.usage.timing?.end?.source !== "mirror" && request.usage.timing?.end?.messageId ? [request.usage.timing.end.messageId] : [])];
      if (ids.some(id => id && included.has(`${raw.revision}\u0000${id}`))) continue;
      const input = raw.input_tokens, output = raw.output_tokens;
      selection.add({ id: `${raw.session_id}:${raw.id}`, raw_id: raw.id, revision: raw.revision, session_id: raw.session_id,
        time_ms: raw.time_ms, ordinal: raw.ordinal, duration_ms: request.usage.timing?.durationMs ?? null, type: "request",
        tokens: input !== null && input >= 0 || output !== null && output >= 0 ? Math.max(input ?? 0, 0) + Math.max(output ?? 0, 0) : null });
    }
    batch = [];
  };
  for (const request of store.iterateRows<RequestRecord>(`SELECT f.*,r.session_id FROM overview_fact_requests f ${joinRevision} WHERE ${requests.where}`, requests.values)) {
    batch.push(request); if (batch.length === 128) addBatch();
  }
  addBatch();
  const page = selection.page(), rows = new Map<string, OverviewEvidenceRow>();
  const pageEvents = readIdentities<EventRecord>(store, "events", page.filter(row => row.type === "event"));
  for (const [index, event] of store.hydrateActivityEvents(pageEvents).entries()) {
    const row = eventRow(store, scope, evidence, pageEvents[index]!, event); rows.set(`event:${row.id}`, row);
  }
  for (const row of hydrateFactRequestEvidence(store, snapshot, evidence, scope,
    readIdentities<RequestRecord>(store, "requests", page.filter(row => row.type === "request")), pricing)) rows.set(`request:${row.id}`, row);
  return pageResult(scope, page.map(row => rows.get(`${row.type}:${row.id}`)!), selection.total);
}

function eventEvidence(store: OverviewFactStore, evidence: OverviewEvidenceQuery, scope: FactEvidenceScope): OverviewEvidencePage {
  const selection = new PageSelection<Candidate>(evidence, scope), selected = eventConditions(evidence, scope);
  let query: string, values: Value[];
  if (evidence.kind === "sequence") {
    const where = [revisionWhere, scope.time, "f.active=1", "f.kind='tool_call'", "f.tool IS NOT NULL AND f.tool<>''",
      "EXISTS (SELECT 1 FROM overview_fact_events u WHERE u.revision=f.revision AND u.kind='user' AND u.active=1 AND u.turn_id=f.turn_id)"];
    values = [...scope.values];
    for (const [condition, value] of [["f.turn_id=?", evidence.turnId], ["f.tool=?", evidence.tool],
      ["json_extract(f.json,'$.resource.server')=?", evidence.server], ["json_array(f.tool,json_extract(f.json,'$.resource.server'))=?", evidence.toolId]] as const) {
      if (value) { where.push(condition); values.push(value); }
    }
    query = `WITH calls AS (SELECT f.*,json_extract(f.json,'$.resource.server') AS server FROM overview_fact_events f WHERE ${where.join(" AND ")}),
      failures AS (SELECT *,MIN(CASE WHEN status='failure' THEN ordinal END) OVER (PARTITION BY revision,turn_id,tool,server) AS failure_ordinal FROM calls)
      SELECT ${candidateColumns("event")} FROM failures f ${joinRevision} WHERE f.ordinal>=f.failure_ordinal`;
  } else {
    query = `SELECT ${candidateColumns("event")},f.tool,json_extract(f.json,'$.resource.kind')='mcp' AS external FROM overview_fact_events f ${joinRevision}
      WHERE ${selected.where} AND ${evidence.kind === "compressions" ? "f.kind='compression'" : "f.kind='tool_call'"}
      ${evidence.kind === "failures" ? "AND f.status='failure'" : ""}`;
    values = selected.values;
  }
  for (const row of store.iterateRows<Candidate & { tool?: string; external?: number }>(query, values)) {
    if (evidence.kind !== "sequence" && evidence.category
      && toolCategory(row.tool, row.external ? { kind: "mcp", name: "" } : undefined) !== evidence.category) continue;
    selection.add(row);
  }
  const page = selection.page(), rows = new Map(readIdentities<EventRecord>(store, "events", page).map(raw => {
    const row = eventRow(store, scope, evidence, raw); return [row.id, row];
  }));
  return pageResult(scope, page.map(row => rows.get(row.id)!), selection.total);
}

function observationEvidence(store: OverviewFactStore, evidence: OverviewEvidenceQuery, scope: FactEvidenceScope): OverviewEvidencePage {
  interface Observation extends Candidate { first: ResourceRecord; days: Set<string>; gap: boolean }
  const groups = new Map<string, Observation>(), sessionGaps = new Set(scope.metadata.sessions.filter(session => session.gaps.some(resourceGapRelevant)).map(session => session.id));
  const sourceGaps = new Set(scope.metadata.gaps.filter(gap => gap.sourceId && resourceGapRelevant(gap)).map(gap => gap.sourceId));
  const where = [revisionWhere, scope.time, "f.valid=1"], values = [...scope.values];
  if (evidence.resourceId) { where.push("f.resource_id=?"); values.push(evidence.resourceId); }
  for (const raw of store.iterateRows<ResourceRecord>(`SELECT f.*,r.session_id,r.resource_source_json FROM overview_fact_resources f ${joinRevision} WHERE ${where.join(" AND ")}`, values)) {
    const day = localDay(raw.time_ms ?? undefined, scope.initial.timezone);
    const group = groups.get(raw.resource_id);
    const sourceId = (JSON.parse(raw.resource_source_json ?? "{}") as { sourceId?: string }).sourceId;
    const gap = sessionGaps.has(raw.session_id) || sourceGaps.has(sourceId);
    if (!group) groups.set(raw.resource_id, { id: raw.resource_id, raw_id: raw.id, session_id: raw.session_id, revision: raw.revision,
      ordinal: null, tokens: null, duration_ms: null, time_ms: raw.time_ms, first: raw, days: new Set(day ? [day] : []), gap });
    else {
      if (day) {
        group.days.add(day);
        const firstDay = localDay(group.first.time_ms ?? undefined, scope.initial.timezone);
        if (!firstDay || day.localeCompare(firstDay) < 0 || day === firstDay
          && (raw.ordinal < group.first.ordinal || raw.ordinal === group.first.ordinal && raw.id.localeCompare(group.first.id) < 0)) {
          group.first = raw; group.raw_id = raw.id; group.session_id = raw.session_id; group.revision = raw.revision; group.time_ms = raw.time_ms;
        }
      }
      group.gap ||= gap;
    }
  }
  const selection = new PageSelection<Observation & { state: string; from: string; to: string; subsequentDays: number }>(evidence, scope);
  for (const group of groups.values()) {
    const firstDay = localDay(group.first.time_ms ?? undefined, scope.initial.timezone); if (!firstDay) continue;
    const from = addDays(firstDay, 1), to = addDays(firstDay, 30);
    const state = to >= scope.range.today ? "observing" : from < scope.range.from || to > scope.range.to ? "outside_range"
      : group.gap || !group.first.known ? "insufficient_coverage" : "mature";
    if (evidence.observationState && evidence.observationState !== state) continue;
    selection.add({ ...group, state, from, to, subsequentDays: [...group.days].filter(day => day >= from && day <= to).length });
  }
  return pageResult(scope, selection.page().map(group => {
    const first = store.decodeResource(group.first);
    return { ...base(scope, first.sessionId), id: group.id, kind: evidence.kind, messageId: first.messageId, resourceId: group.id,
      resourceName: first.kind === "mcp" ? first.server ?? first.name : first.name, resourceNameDescriptor: resourceNameDescriptor(first),
      resourceKind: first.kind === "mcp" ? "mcp" : "skill", occurredAt: first.occurredAt,
      values: { firstDay: localDay(first.occurredAt, scope.initial.timezone)!, from: group.from, to: group.to, state: group.state,
        reused: group.state === "mature" ? group.subsequentDays > 0 : null, subsequentDays: group.subsequentDays } };
  }), selection.total);
}

function combinationEvidence(store: OverviewFactStore, evidence: OverviewEvidenceQuery, scope: FactEvidenceScope): OverviewEvidencePage {
  const turn = evidence.unit === "turn", unit = turn ? "f.turn_id" : "''", selected = [evidence.resourceId, evidence.resourceId2].filter((id): id is string => !!id);
  const selectedSql = selected.length ? "f.resource_id IN (SELECT value FROM json_each(?))" : "1";
  const values = [...scope.values, ...(selected.length ? [JSON.stringify(selected)] : [])];
  const cte = `WITH resources AS (SELECT f.*,${unit} AS unit,${selectedSql} AS included FROM overview_fact_resources f
    WHERE ${revisionWhere} AND ${scope.time} AND f.valid=1${turn ? " AND EXISTS (SELECT 1 FROM overview_fact_events u WHERE u.revision=f.revision AND u.kind='user' AND u.active=1 AND u.turn_id=f.turn_id)" : ""}),
    units AS (SELECT revision,unit,COUNT(DISTINCT resource_id) AS resources,COUNT(DISTINCT CASE WHEN included THEN resource_id END) AS matched
      FROM resources GROUP BY revision,unit HAVING resources>=2${selected.length ? " AND matched=?" : ""}),
    retained AS (SELECT f.*,u.resources,ROW_NUMBER() OVER (PARTITION BY f.revision,f.unit ORDER BY f.ordinal DESC,f.id DESC) AS position
      FROM resources f JOIN units u ON u.revision=f.revision AND u.unit=f.unit WHERE f.included)`;
  // SELECT 中的占位符早于 WHERE，参数也按同一顺序绑定。
  const parameters = [...(selected.length ? [JSON.stringify(selected)] : []), ...scope.values, ...(selected.length ? [new Set(selected).size] : [])];
  const selection = new PageSelection<Candidate & { unit: string; resources: number }>(evidence, scope);
  for (const row of store.iterateRows<Candidate & { unit: string; resources: number }>(`${cte} SELECT r.session_id${turn ? "||char(0)||f.unit" : ""} AS id,
    f.id AS raw_id,f.revision,r.session_id,f.time_ms,NULL AS ordinal,NULL AS tokens,NULL AS duration_ms,f.unit,f.resources
    FROM retained f ${joinRevision} WHERE f.position=1`, parameters)) selection.add(row);
  const page = selection.page(), units = JSON.stringify(page.map(row => ({ revision: row.revision, unit: row.unit }))), groups = new Map<string, { messageId?: string; ids: string[]; occurredAt?: string; uses: number; turnId: string }>();
  for (const raw of store.iterateRows<{ revision: string; turn_id: string; json: string }>(`SELECT f.revision,f.turn_id,f.json FROM overview_fact_resources f
    JOIN json_each(?) p ON f.revision=json_extract(p.value,'$.revision') AND ${unit}=json_extract(p.value,'$.unit')
    WHERE ${revisionWhere} AND ${scope.time} AND f.valid=1 AND ${selectedSql} ORDER BY f.ordinal,f.id`, [units, ...values])) {
    const event = JSON.parse(raw.json) as { messageId: string; occurredAt?: string };
    const key = `${raw.revision}\u0000${turn ? raw.turn_id : ""}`, group = groups.get(key) ?? { messageId: event.messageId, ids: [], uses: 0, turnId: raw.turn_id };
    group.ids.push(event.messageId); group.uses += 1; group.occurredAt = event.occurredAt; groups.set(key, group);
  }
  return pageResult(scope, page.map(row => {
    const group = groups.get(`${row.revision}\u0000${row.unit}`)!;
    return { ...base(scope, row.session_id), id: row.id, kind: evidence.kind, turnId: turn ? group.turnId : undefined,
      messageId: group.messageId, relatedMessageIds: [...new Set(group.ids)], occurredAt: group.occurredAt,
      values: { uses: group.uses, resources: row.resources } };
  }), selection.total);
}
