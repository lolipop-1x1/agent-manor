import type { OverviewCountRow, OverviewDelegation, OverviewDetailPage, OverviewDetailQuery, OverviewDetailRow, OverviewModelTransition, OverviewProcess, OverviewProjectMonth,
  OverviewResourceRow, OverviewResources, OverviewResultCounts, OverviewSnapshot, OverviewSource, OverviewToolRow } from "../overview-contracts.js";
import { buildDelegation, buildResources, resourceNameDescriptor, selectedSource, toolCategory } from "./analytics.js";
import { addDays, inPeriod, localDay } from "./dates.js";
import { nonnegative } from "./insight-math.js";
import { usageDimensionKey, usageDimensionValue } from "../usage/dimensions.js";
import { intervalKey } from "../usage/analytics.js";
import { resourceGapRelevant } from "../resources/coverage.js";
import type { OverviewFactStore } from "./facts.js";
import type { UsageStatistics } from "../usage-contracts.js";

/** 月份及模型路径只在用户打开对应调查时构造。 */
export function projectMonths(source: OverviewSource, snapshot: OverviewSnapshot): OverviewProjectMonth[] {
  const selected = selectedSource(source, snapshot.query, snapshot.range, true), sessions = new Map(source.sessions.map(row => [row.id, row]));
  const groups = new Map<string, OverviewProjectMonth & { ids: Set<string> }>();
  const row = (sessionId: string, occurredAt?: string) => {
    const day = localDay(occurredAt, snapshot.timezone); if (!day || day < snapshot.range.from || day > snapshot.range.to) return;
    const month = day.slice(0, 7), project = sessions.get(sessionId)?.project ?? null, key = JSON.stringify([month, project]);
    const value = groups.get(key) ?? { month, project, sessions: 0, requests: 0, tokens: null,
      completeTokenRequests: 0, partialTokenRequests: 0, missingTokenRequests: 0, ids: new Set<string>() };
    groups.set(key, value); return value;
  };
  for (const event of selected.events) row(event.sessionId, event.occurredAt)?.ids.add(event.sessionId);
  // 活跃会话分母不随局部模型筛选变化。
  for (const request of selectedSource(source, snapshot.query, snapshot.range).requests) row(request.sessionId, request.usage.occurredAt)?.ids.add(request.sessionId);
  for (const request of selected.requests) {
    const value = row(request.sessionId, request.usage.occurredAt); if (!value) continue;
    value.requests++;
    const input = nonnegative(request.usage.inputTokens), output = nonnegative(request.usage.outputTokens);
    if (input || output) value.tokens = (value.tokens ?? 0) + (input ? request.usage.inputTokens! : 0) + (output ? request.usage.outputTokens! : 0);
    value[input && output ? "completeTokenRequests" : input || output ? "partialTokenRequests" : "missingTokenRequests"]++;
  }
  return [...groups.values()].map(({ ids, ...value }) => ({ ...value, sessions: ids.size }))
    .sort((a, b) => a.month.localeCompare(b.month) || b.sessions - a.sessions || (a.project ?? "").localeCompare(b.project ?? ""));
}
export function modelTransitions(source: OverviewSource, snapshot: OverviewSnapshot): OverviewModelTransition[] {
  const sessions = new Map(source.sessions.map(row => [row.id, row])), groups = new Map<string, typeof source.requests>();
  for (const request of source.requests) { const group = groups.get(request.sessionId) ?? []; group.push(request); groups.set(request.sessionId, group); }
  const pairs = new Map<string, { kind: "switch" | "delegation"; from: string; to: string; count: number; ids: Set<string> }>();
  const add = (kind: "switch" | "delegation", from: string, to: string, id: string) => {
    const key = JSON.stringify([kind, from, to]), pair = pairs.get(key) ?? { kind, from, to, count: 0, ids: new Set<string>() };
    pair.count++; pair.ids.add(id); pairs.set(key, pair);
  };
  const eligible = (request: typeof source.requests[number]) => !!request.usage.model?.trim() && inPeriod(request.usage.occurredAt, snapshot.range, snapshot.timezone)
    && (!snapshot.query.models?.length || snapshot.query.models.includes(usageDimensionKey(request.usage.model)));
  for (const [sessionId, requests] of groups) {
    const ordinals = requests.map(row => row.ordinal);
    if (ordinals.some(value => !Number.isSafeInteger(value) || value! < 0) || new Set(ordinals).size !== requests.length) continue;
    requests.sort((a, b) => a.ordinal! - b.ordinal!);
    for (let index = 1; index < requests.length; index++) {
      const before = requests[index - 1]!, next = requests[index]!;
      if (eligible(before) && eligible(next) && before.usage.model !== next.usage.model) add("switch", before.usage.model!, next.usage.model!, sessionId);
    }
  }
  const models = new Map([...groups].map(([id, values]) => [id, new Set(values.filter(eligible).map(value => value.usage.model!))]));
  for (const session of sessions.values()) if (session.relationship === "child" && session.parentSessionId) {
    for (const from of models.get(session.parentSessionId) ?? []) for (const to of models.get(session.id) ?? []) add("delegation", from, to, session.parentSessionId);
  }
  return [...pairs.values()].map(pair => ({ kind: pair.kind, fromModel: pair.from, toModel: pair.to,
    count: pair.count, sessions: pair.ids.size, evidence: { kind: pair.kind === "switch" ? "requests" as const : "delegation" as const,
      scope: "usage" as const, transition: pair.kind, modelFrom: pair.from, modelTo: pair.to, sort: "ordinal" as const } }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || b.count - a.count || a.fromModel.localeCompare(b.fromModel) || a.toModel.localeCompare(b.toModel));
}
/** 排行只扫描已经聚合的身份；分页后才构造展示行。 */
export function usageRankingDetail(report: UsageStatistics, snapshot: OverviewSnapshot, query: OverviewDetailQuery): OverviewDetailPage {
  const metric = query.sort === "tokens" ? "tokens" : query.sort === "cost" ? "estimatedCost" : query.sort === "sessions" ? "sessions" : "requests";
  const page = query.page ?? 1, pageSize = query.pageSize ?? 20;
  const identities = [...report.groups].sort((a, b) => (b.totals[metric] ?? -1) - (a.totals[metric] ?? -1) || a.key.localeCompare(b.key));
  const rows: OverviewCountRow[] = identities.slice((page - 1) * pageSize, page * pageSize).map(group => ({ key: group.key,
    name: usageDimensionValue(group.key) ?? "未知", ...(usageDimensionValue(group.key) === undefined ? { nameDescriptor: { key: "overview.unknown" } } : {}),
    count: group.totals.requests, requests: group.totals.requests, sessions: group.totals.sessions, tokens: group.totals.tokens,
    estimatedCost: group.totals.estimatedCost, costCoverage: group.totals.estimatedCost === null ? "missing"
      : group.totals.partiallyPricedRequests || group.totals.unpricedRequests ? "partial" : "complete" }));
  return { snapshot, query, rows, total: identities.length, page, pageSize };
}

type SqlValue = string | number | null;
type ResourceRecord = Parameters<OverviewFactStore["decodeResource"]>[0];
type EventRecord = Parameters<OverviewFactStore["decodeEvent"]>[0];
type RequestRecord = Parameters<OverviewFactStore["decodeRequest"]>[0];
interface ResourceAggregate {
  resource_id: string; uses: number; sessions: number; explicit: number; reads: number; calls: number; success: number; failure: number;
}
const counts = (calls: number, success: number, failure: number): OverviewResultCounts => ({ calls, success, failure,
  unknown: calls - success - failure, known: success + failure, failureRate: success + failure ? failure / (success + failure) : null,
  coverage: calls ? (success + failure) / calls : null });
const dimensionSql = (column: string) => `CASE WHEN ${column} IS NULL THEN 'unknown'
  WHEN ${column}='unknown' OR substr(${column},1,8)='literal:' THEN 'literal:' || ${column} ELSE ${column} END`;

/** SQL先聚合及分页身份，只有所选页的对象读取必要细项。 */
export function factDetail(store: OverviewFactStore, snapshot: OverviewSnapshot, query: OverviewDetailQuery, now: Date,
  options: { resourceDays?: boolean; resourceIds?: string[]; toolFailures?: boolean; toolCandidates?: boolean } = {}): OverviewDetailPage {
  const scope = store.sqlScope(snapshot.query, now), page = query.page ?? 1, pageSize = query.pageSize ?? 20, offset = (page - 1) * pageSize;
  const rangeWhere = scope.bounds ? "f.time_ms>=? AND f.time_ms<?" : "1";
  const bounds: SqlValue[] = scope.bounds ? [scope.bounds.fromMs, scope.bounds.toMs] : [];
  const selectedValues: SqlValue[] = [JSON.stringify(scope.revisions), ...bounds];
  if (options.resourceIds) selectedValues.push(JSON.stringify(options.resourceIds));
  const resourceSql = `WITH selected AS (SELECT f.revision,f.id,f.ordinal,f.time_ms,f.resource_id,f.known,f.kind,f.name,f.server,
    f.tool,f.status,f.turn_id,f.client,f.project,r.session_id FROM overview_fact_resources f
    JOIN overview_fact_revisions r ON r.revision=f.revision WHERE f.revision IN (SELECT value FROM json_each(?)) AND f.valid=1 AND ${rangeWhere}
    ${options.resourceIds ? "AND f.resource_id IN (SELECT value FROM json_each(?))" : ""})`;
  const read = <T>(sql: string, values: SqlValue[] = []) => store.readRows<T>(sql, values);
  const totalRows = (sql: string, values: SqlValue[]) => read<{ total: number }>(`${sql} SELECT COUNT(*) AS total FROM grouped`, values)[0]!.total;
  const aggregate = `SELECT resource_id,COUNT(*) AS uses,COUNT(DISTINCT session_id) AS sessions,
    SUM(kind='skill_call') AS explicit,SUM(kind='skill_read') AS reads,SUM(kind!='skill_read') AS calls,
    SUM(CASE WHEN kind!='skill_read' AND status='success' THEN 1 ELSE 0 END) AS success,SUM(CASE WHEN kind!='skill_read' AND status='failure' THEN 1 ELSE 0 END) AS failure
    FROM selected GROUP BY resource_id`;
  const resourceRows = (ids: string[]): OverviewResourceRow[] => {
    if (!ids.length) return [];
    const values = [...selectedValues, JSON.stringify(ids)];
    const aggregates = read<ResourceAggregate>(`${resourceSql} SELECT * FROM (${aggregate}) WHERE resource_id IN (SELECT value FROM json_each(?))`, values);
    const firstRecords = read<ResourceRecord & { resource_id: string }>(`${resourceSql},first AS (SELECT revision,id,resource_id,
      ROW_NUMBER() OVER (PARTITION BY resource_id ORDER BY session_id,ordinal,id) AS position FROM selected
      WHERE resource_id IN (SELECT value FROM json_each(?))) SELECT f.*,r.session_id,r.resource_source_json FROM first s
      JOIN overview_fact_resources f ON f.revision=s.revision AND f.id=s.id JOIN overview_fact_revisions r ON r.revision=f.revision WHERE position=1`, values);
    const firstById = new Map(firstRecords.map(row => [row.resource_id, row]));
    const dayRows = read<{ resource_id: string; day: string; uses: number; sessions: number }>(`${resourceSql}
      SELECT resource_id,overview_local_day(time_ms,?) AS day,COUNT(*) AS uses,COUNT(DISTINCT session_id) AS sessions
      FROM selected WHERE resource_id IN (SELECT value FROM json_each(?)) AND time_ms IS NOT NULL GROUP BY resource_id,day ORDER BY day`,
    [...selectedValues, snapshot.timezone, JSON.stringify(ids)]);
    return aggregates.map(row => {
      const first = firstById.get(row.resource_id)!;
      const event = store.decodeResource(first), source = { ...scope.source, events: [], requests: [], resources: [event] };
      const resources = buildResources(source, source, snapshot.range, snapshot.timezone, false);
      const identity = [...resources.skills, ...resources.mcp][0]!;
      const days = dayRows.filter(day => day.resource_id === row.resource_id).map(({ day, uses, sessions }) => ({ day, uses, sessions }));
      return { ...identity, uses: row.uses, sessions: row.sessions, explicitCalls: row.explicit, successfulReads: row.reads,
        activeWeeks: new Set(days.map(day => intervalKey(day.day, "week"))).size, firstDay: days[0]?.day ?? null, lastDay: days.at(-1)?.day ?? null,
        averagePerSession: row.sessions ? row.uses / row.sessions : null, days, results: counts(row.calls, row.success, row.failure) };
    });
  };
  let rows: OverviewDetailRow[] = [], total = 0, object: OverviewResourceRow | undefined, distributionCounts: OverviewDetailPage["counts"];
  if (query.view === "resources") {
    const kind = query.kind === "mcp" ? "kind='mcp'" : query.kind === "skill" ? "kind!='mcp'" : "1";
    const sql = `${resourceSql},grouped AS (${aggregate})`;
    const kindSql = ` AND resource_id IN (SELECT resource_id FROM selected WHERE ${kind})`;
    total = read<{ total: number }>(`${sql} SELECT COUNT(*) AS total FROM grouped WHERE 1${kindSql}`, selectedValues)[0]!.total;
    const order = query.sort === "sessions" || !query.sort && query.kind === "skill" ? "sessions DESC,uses DESC,resource_id" : "uses DESC,sessions DESC,resource_id";
    const ids = read<{ resource_id: string }>(`${sql} SELECT resource_id FROM grouped WHERE 1${kindSql} ORDER BY ${order} LIMIT ? OFFSET ?`, [...selectedValues, pageSize, offset]).map(row => row.resource_id);
    const byId = new Map(resourceRows(ids).map(row => [row.id, options.resourceDays ? row : { ...row, days: [] }])); rows = ids.map(id => byId.get(id)!);
  } else if (query.view === "resource") {
    object = resourceRows([query.resourceId!])[0];
    const dimension = query.dimension === "project" ? "project" : query.dimension === "tool" ? "tool" : "client";
    const column = dimension === "client" ? "client" : dimensionSql(dimension), callOnly = dimension === "tool" ? " AND kind!='skill_read'" : "";
    const sql = `${resourceSql},grouped AS (SELECT ${column} AS key,COUNT(*) AS count,COUNT(DISTINCT session_id) AS sessions,
      SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,SUM(CASE WHEN status='failure' THEN 1 ELSE 0 END) AS failure FROM selected WHERE resource_id=?${callOnly} GROUP BY key)`;
    const values = [...selectedValues, query.resourceId!]; total = totalRows(sql, values);
    rows = read<{ key: string; count: number; sessions: number; success: number; failure: number }>(`${sql}
      SELECT * FROM grouped ORDER BY ${query.sort === "sessions" ? "sessions DESC,count DESC" : "count DESC"},key LIMIT ? OFFSET ?`, [...values, pageSize, offset])
      .map(row => ({ key: row.key, name: dimension === "client" ? row.key : usageDimensionValue(row.key) ?? "未知",
        ...(dimension !== "client" && usageDimensionValue(row.key) === undefined ? { nameDescriptor: { key: "overview.unknown" } } : {}),
        count: row.count, sessions: row.sessions, ...(dimension === "tool" ? { results: counts(row.count, row.success, row.failure) } : {}) }));
    const value = read<{ clients: number; projects: number; tools: number }>(`${resourceSql}
      SELECT COUNT(DISTINCT client) AS clients,COUNT(DISTINCT ${dimensionSql("project")}) AS projects,
      COUNT(DISTINCT CASE WHEN kind!='skill_read' THEN ${dimensionSql("tool")} END) AS tools FROM selected WHERE resource_id=?`, values)[0]!;
    distributionCounts = value;
  } else if (query.view === "observations") {
    const sql = `${resourceSql},grouped AS (SELECT resource_id,MIN(time_ms) AS first FROM selected WHERE time_ms IS NOT NULL GROUP BY resource_id)`;
    total = totalRows(sql, selectedValues);
    const identities = read<{ resource_id: string }>(`${sql} SELECT resource_id FROM grouped ORDER BY first,resource_id LIMIT ? OFFSET ?`, [...selectedValues, pageSize, offset]);
    for (const { resource_id } of identities) {
      const dates = read<{ revision: string; id: string; ordinal: number; session_id: string; day: string }>(`${resourceSql}
        SELECT revision,id,ordinal,session_id,overview_local_day(time_ms,?) AS day FROM selected
        WHERE resource_id=? AND time_ms IS NOT NULL ORDER BY day,ordinal,id`, [...selectedValues, snapshot.timezone, resource_id]);
      const first = dates[0]!, record = read<ResourceRecord>(`SELECT f.*,r.session_id,r.resource_source_json FROM overview_fact_resources f
        JOIN overview_fact_revisions r ON r.revision=f.revision WHERE f.revision=? AND f.id=?`, [first.revision, first.id])[0]!;
      const event = store.decodeResource(record), sessionIds = new Set(read<{ session_id: string }>(`${resourceSql}
        SELECT DISTINCT session_id FROM selected WHERE resource_id=?`, [...selectedValues, resource_id]).map(row => row.session_id));
      const allSourceIds = read<{ resource_source_json: string }>(`${resourceSql} SELECT DISTINCT r.resource_source_json FROM selected s
        JOIN overview_fact_revisions r ON r.revision=s.revision WHERE s.resource_id=?`, [...selectedValues, resource_id])
        .map(row => JSON.parse(row.resource_source_json) as { sourceId?: string });
      const sourceIds = new Set(allSourceIds.flatMap(value => value.sourceId ?? [])), from = addDays(first.day, 1), to = addDays(first.day, 30);
      const relevantGap = scope.source.gaps.some(gap => !!gap.sourceId && sourceIds.has(gap.sourceId) && resourceGapRelevant(gap))
        || scope.source.sessions.some(session => sessionIds.has(session.id) && session.gaps.some(resourceGapRelevant));
      const state = to >= snapshot.range.today ? "observing" : from < snapshot.range.from || to > snapshot.range.to ? "outside_range"
        : relevantGap || !read<{ known: number }>(`SELECT known FROM overview_fact_resources WHERE revision=? AND id=?`, [first.revision, first.id])[0]!.known ? "insufficient_coverage" : "mature";
      const subsequentDays = new Set(dates.filter(value => value.day >= from && value.day <= to).map(value => value.day)).size;
      rows.push({ resourceId: resource_id, name: event.kind === "mcp" ? event.server ?? event.name : event.name,
        nameDescriptor: resourceNameDescriptor(event), kind: event.kind === "mcp" ? "mcp" : "skill",
        firstDay: first.day, window: { from, to }, state, reused: state === "mature" ? subsequentDays > 0 : null, subsequentDays, firstEventId: event.id });
    }
  } else if (query.view === "combinations") {
    const unit = query.unit ?? "session", unitSql = unit === "turn" ? "json_array(session_id,turn_id)" : "session_id";
    const trueTurn = unit === "turn" ? ` AND selected.turn_id!='' AND EXISTS (SELECT 1 FROM overview_fact_events e WHERE e.revision=selected.revision
      AND e.active=1 AND e.kind='user' AND e.turn_id=selected.turn_id)` : "";
    const sql = `${resourceSql},units AS (SELECT ${unitSql} AS unit,session_id,resource_id,MIN(CASE WHEN kind='mcp' THEN COALESCE(server,name) ELSE name END) AS name
      FROM selected WHERE known=1${trueTurn} GROUP BY unit,session_id,resource_id),grouped AS (SELECT a.resource_id AS first,b.resource_id AS second,
      MIN(a.name) AS first_name,MIN(b.name) AS second_name,COUNT(*) AS count,COUNT(DISTINCT a.session_id) AS sessions
      FROM units a JOIN units b ON a.unit=b.unit AND a.resource_id<b.resource_id GROUP BY a.resource_id,b.resource_id)`;
    total = totalRows(sql, selectedValues);
    rows = read<{ first: string; second: string; first_name: string; second_name: string; count: number; sessions: number }>(`${sql}
      SELECT * FROM grouped ORDER BY count DESC,first,second LIMIT ? OFFSET ?`, [...selectedValues, pageSize, offset]).map(row => {
      const pair: [string, string][] = [[row.first, row.first_name], [row.second, row.second_name]];
      pair.sort(([a], [b]) => a.localeCompare(b));
      const resources: [string, string] = [pair[0]![0], pair[1]![0]], names: [string, string] = [pair[0]![1], pair[1]![1]];
      return { id: JSON.stringify(resources), resources, names, unit, count: row.count, sessions: row.sessions };
    });
  } else if (query.view === "months") {
    const sessions = JSON.stringify(scope.source.sessions.map(session => ({ id: session.id, project: session.project ?? null })));
    const models = snapshot.query.models?.length ? ` AND ${dimensionSql("f.model")} IN (SELECT value FROM json_each(?))` : "";
    const sql = `WITH session_meta AS MATERIALIZED (SELECT CAST(value->>'$.id' AS TEXT) AS id,value->>'$.project' AS project FROM json_each(?)),
      active AS (SELECT r.session_id,substr(overview_local_day(f.time_ms,?),1,7) AS month FROM overview_fact_events f
        JOIN overview_fact_revisions r ON r.revision=f.revision WHERE f.revision IN (SELECT value FROM json_each(?)) AND f.active=1 AND f.time_ms IS NOT NULL AND ${rangeWhere}
        UNION SELECT r.session_id,substr(overview_local_day(f.time_ms,?),1,7) FROM overview_fact_requests f JOIN overview_fact_revisions r ON r.revision=f.revision
        WHERE f.revision IN (SELECT value FROM json_each(?)) AND f.time_ms IS NOT NULL AND ${rangeWhere}),
      active_groups AS (SELECT a.month,s.project,COUNT(DISTINCT a.session_id) AS sessions FROM active a JOIN session_meta s ON s.id=a.session_id GROUP BY a.month,s.project),
      requests AS (SELECT substr(overview_local_day(f.time_ms,?),1,7) AS month,s.project,COUNT(*) AS requests,
        SUM(CASE WHEN f.input_tokens>=0 OR f.output_tokens>=0 THEN CASE WHEN f.input_tokens>=0 THEN f.input_tokens ELSE 0 END
          + CASE WHEN f.output_tokens>=0 THEN f.output_tokens ELSE 0 END END) AS tokens,
        SUM(CASE WHEN f.input_tokens>=0 AND f.output_tokens>=0 THEN 1 ELSE 0 END) AS completeTokenRequests,
        SUM(CASE WHEN (CASE WHEN f.input_tokens>=0 THEN 1 ELSE 0 END)+(CASE WHEN f.output_tokens>=0 THEN 1 ELSE 0 END)=1 THEN 1 ELSE 0 END) AS partialTokenRequests,
        SUM(CASE WHEN (CASE WHEN f.input_tokens>=0 THEN 1 ELSE 0 END)+(CASE WHEN f.output_tokens>=0 THEN 1 ELSE 0 END)=0 THEN 1 ELSE 0 END) AS missingTokenRequests
        FROM overview_fact_requests f JOIN overview_fact_revisions r ON r.revision=f.revision JOIN session_meta s ON s.id=r.session_id
        WHERE f.revision IN (SELECT value FROM json_each(?)) AND f.time_ms IS NOT NULL AND ${rangeWhere}${models} GROUP BY month,s.project),
      grouped AS (SELECT a.month,a.project,a.sessions,COALESCE(q.requests,0) AS requests,q.tokens,COALESCE(q.completeTokenRequests,0) AS completeTokenRequests,
        COALESCE(q.partialTokenRequests,0) AS partialTokenRequests,COALESCE(q.missingTokenRequests,0) AS missingTokenRequests
        FROM active_groups a LEFT JOIN requests q ON q.month=a.month AND q.project IS a.project)`;
    const values = [sessions, snapshot.timezone, ...selectedValues, snapshot.timezone, ...selectedValues, snapshot.timezone, ...selectedValues,
      ...(models ? [JSON.stringify(snapshot.query.models)] : [])];
    total = totalRows(sql, values); rows = read<OverviewProjectMonth>(`${sql} SELECT * FROM grouped ORDER BY month,sessions DESC,COALESCE(project,'') LIMIT ? OFFSET ?`, [...values, pageSize, offset]);
  } else if (query.view === "transitions") {
    const modelFilter = snapshot.query.models?.length ? ` AND ${dimensionSql("f.model")} IN (SELECT value FROM json_each(?))` : "";
    const modelValues = modelFilter ? [JSON.stringify(snapshot.query.models)] : [];
    const relations = JSON.stringify(scope.source.sessions.map(session => ({ id: session.id, parent: session.relationship === "child" ? session.parentSessionId ?? null : null })));
    const sql = `WITH valid AS (SELECT revision FROM overview_fact_requests WHERE revision IN (SELECT value FROM json_each(?)) GROUP BY revision
        HAVING COUNT(DISTINCT ordinal)=COUNT(*) AND MIN(ordinal)>=0 AND MAX(ordinal)<=9007199254740991 AND SUM(typeof(ordinal)!='integer')=0),
      ordered AS (SELECT f.revision,f.id,f.ordinal,f.time_ms,f.model,LAG(model) OVER (PARTITION BY revision ORDER BY ordinal) AS previous_model,
        LAG(time_ms) OVER (PARTITION BY revision ORDER BY ordinal) AS previous_time FROM overview_fact_requests f WHERE revision IN (SELECT revision FROM valid)),
      switches AS (SELECT 'switch' AS kind,f.previous_model AS fromModel,f.model AS toModel,r.session_id AS session_id FROM ordered f
        JOIN overview_fact_revisions r ON r.revision=f.revision WHERE f.model IS NOT NULL AND trim(f.model)!='' AND f.previous_model IS NOT NULL AND trim(f.previous_model)!=''
        AND f.previous_model!=f.model AND ${rangeWhere} AND ${scope.bounds ? "f.previous_time>=? AND f.previous_time<?" : "f.time_ms IS NOT NULL AND f.previous_time IS NOT NULL"}${modelFilter}
        ${modelFilter ? ` AND ${dimensionSql("f.previous_model")} IN (SELECT value FROM json_each(?))` : ""}),
      models AS (SELECT DISTINCT r.session_id,f.model FROM overview_fact_requests f JOIN overview_fact_revisions r ON r.revision=f.revision
        WHERE f.revision IN (SELECT value FROM json_each(?)) AND f.model IS NOT NULL AND trim(f.model)!='' AND f.time_ms IS NOT NULL AND ${rangeWhere}${modelFilter}),
      relations AS (SELECT value->>'$.id' AS id,value->>'$.parent' AS parent FROM json_each(?)),
      pairs AS (SELECT * FROM switches UNION ALL SELECT 'delegation',a.model,b.model,a.session_id FROM relations r
        JOIN models a ON a.session_id=r.parent JOIN models b ON b.session_id=r.id),
      grouped AS (SELECT kind,fromModel,toModel,COUNT(*) AS count,COUNT(DISTINCT session_id) AS sessions FROM pairs
        ${query.transition && query.transition !== "all" ? "WHERE kind=?" : ""} GROUP BY kind,fromModel,toModel)`;
    const values = [JSON.stringify(scope.revisions), ...bounds, ...bounds, ...modelValues, ...modelValues, ...selectedValues, ...modelValues, relations,
      ...(query.transition && query.transition !== "all" ? [query.transition] : [])];
    total = totalRows(sql, values);
    rows = read<Omit<OverviewModelTransition, "evidence">>(`${sql} SELECT * FROM grouped ORDER BY kind,count DESC,fromModel,toModel LIMIT ? OFFSET ?`, [...values, pageSize, offset])
      .map(row => ({ ...row, evidence: { kind: row.kind === "switch" ? "requests" : "delegation", scope: "usage", transition: row.kind,
        modelFrom: row.fromModel, modelTo: row.toModel, sort: "ordinal" } }));
  } else if (query.view === "ranking" && query.dimension === "tool") {
    const sql = `WITH selected AS (SELECT f.revision,f.id,f.ordinal,f.time_ms,f.tool,f.status,json_extract(f.json,'$.resource.server') AS server,r.session_id,
        json_array(f.tool,json_extract(f.json,'$.resource.server')) AS key FROM overview_fact_events f JOIN overview_fact_revisions r ON r.revision=f.revision
        WHERE f.revision IN (SELECT value FROM json_each(?)) AND f.active=1 AND f.kind='tool_call' AND ${rangeWhere}),
      grouped AS (SELECT key,COUNT(*) AS count,COUNT(DISTINCT session_id) AS sessions,
        SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success,SUM(CASE WHEN status='failure' THEN 1 ELSE 0 END) AS failure FROM selected GROUP BY key)`;
    const candidate = options.toolCandidates ? " WHERE failure>=3 AND success+failure>=20 AND (success+failure)*1.0/count>=0.8 AND failure*1.0/(success+failure)>=0.05" : "";
    const groups = read<{ key: string; count: number; sessions: number; success: number; failure: number; total: number }>(`${sql}
      SELECT *,COUNT(*) OVER() AS total FROM grouped${candidate} ORDER BY ${options.toolFailures || options.toolCandidates ? "failure DESC,count DESC" : query.sort === "sessions" ? "sessions DESC,count DESC" : "count DESC"},key LIMIT ? OFFSET ?`, [...selectedValues, pageSize, offset]);
    total = groups[0]?.total ?? (offset ? read<{ total: number }>(`${sql} SELECT COUNT(*) AS total FROM grouped${candidate}`, selectedValues)[0]!.total : 0);
    if (!groups.length) return { snapshot, query, rows, total, page, pageSize };
    const dayRows = read<{ key: string; day: string; calls: number; failures: number }>(`${sql}
      SELECT key,overview_local_day(time_ms,?) AS day,COUNT(*) AS calls,SUM(CASE WHEN status='failure' THEN 1 ELSE 0 END) AS failures FROM selected
      WHERE key IN (SELECT value FROM json_each(?)) AND time_ms IS NOT NULL GROUP BY key,day ORDER BY day`, [...selectedValues, snapshot.timezone, JSON.stringify(groups.map(row => row.key))]);
    const firstRecords = read<EventRecord & { key: string }>(`${sql},first AS (SELECT revision,id,key,
      ROW_NUMBER() OVER (PARTITION BY key ORDER BY session_id,ordinal,id) AS position FROM selected WHERE key IN (SELECT value FROM json_each(?)))
      SELECT f.*,r.session_id,s.key FROM first s JOIN overview_fact_events f ON f.revision=s.revision AND f.id=s.id
      JOIN overview_fact_revisions r ON r.revision=f.revision WHERE position=1`, [...selectedValues, JSON.stringify(groups.map(row => row.key))]);
    const firstByKey = new Map(firstRecords.map(row => [row.key, row]));
    rows = groups.map(row => {
      const first = firstByKey.get(row.key)!;
      const event = store.decodeEvent(first), days = dayRows.filter(day => day.key === row.key).map(({ day, calls, failures }) => ({ day, calls, failures }));
      return { key: row.key, name: event.tool ?? "未知", ...(event.tool === undefined ? { nameDescriptor: { key: "overview.unknown" } } : {}),
        category: toolCategory(event.tool, event.resource), server: event.resource?.server, count: row.count, sessions: row.sessions,
        results: counts(row.count, row.success, row.failure), activeDays: days.length, clients: [], projects: [], days };
    });
  }
  return { snapshot, query, rows, total, page, pageSize, ...(object ? { object, counts: distributionCounts } : {}) };
}

/** 首页资源只需要所选前几项；洞察候选使用同一窄聚合，不读取所有资源事件JSON。 */
export function factResources(store: OverviewFactStore, snapshot: OverviewSnapshot, now: Date, limit = 5, trends = true) {
  const skills = factDetail(store, snapshot, { view: "resources", kind: "skill", pageSize: limit }, now, { resourceDays: trends });
  const mcp = factDetail(store, snapshot, { view: "resources", kind: "mcp", pageSize: limit }, now, { resourceDays: trends });
  const scope = store.sqlScope(snapshot.query, now), revisions = JSON.stringify(scope.revisions);
  const bounds = scope.bounds ? [scope.bounds.fromMs, scope.bounds.toMs] : [];
  const missingTimeEvents = store.readRows<{ count: number }>(`SELECT COUNT(*) AS count FROM overview_fact_resources
    WHERE revision IN (SELECT value FROM json_each(?)) AND valid=1 AND time_ms IS NULL`, [revisions])[0]!.count;
  const missingTurnEvents = store.readRows<{ count: number }>(`SELECT COUNT(*) AS count FROM overview_fact_resources f
    WHERE f.revision IN (SELECT value FROM json_each(?)) AND f.valid=1 AND ${scope.bounds ? "f.time_ms>=? AND f.time_ms<?" : "1"}
    AND NOT EXISTS (SELECT 1 FROM overview_fact_events e WHERE e.revision=f.revision AND e.active=1 AND e.kind='user' AND e.turn_id!='' AND e.turn_id=f.turn_id)`,
  [revisions, ...bounds])[0]!.count;
  const resources: OverviewResources = { skills: skills.rows as OverviewResourceRow[], mcp: mcp.rows as OverviewResourceRow[],
    observations: [], combinations: { sessions: [], turns: [] }, missingTimeEvents, missingTurnEvents };
  return { resources, counts: { skills: skills.total, mcp: mcp.total } };
}

/** 习惯洞察先用次数及活跃周筛出一个对象，再读取该对象的细项。 */
export function factResourceCandidates(store: OverviewFactStore, snapshot: OverviewSnapshot, now: Date) {
  const scope = store.sqlScope(snapshot.query, now), where = scope.bounds ? "f.time_ms>=? AND f.time_ms<?" : "1";
  const values: SqlValue[] = [snapshot.timezone, JSON.stringify(scope.revisions), ...(scope.bounds ? [scope.bounds.fromMs, scope.bounds.toMs] : [])];
  const groups = (filter: string) => `SELECT f.resource_id,MIN(f.kind) AS kind,COUNT(*) AS uses,COUNT(DISTINCT r.session_id) AS sessions,
    COUNT(DISTINCT date(overview_local_day(f.time_ms,?),'weekday 0','-6 days')) AS weeks FROM overview_fact_resources f
    JOIN overview_fact_revisions r ON r.revision=f.revision WHERE f.revision IN (SELECT value FROM json_each(?)) AND f.valid=1 AND f.known=1 AND ${filter} GROUP BY f.resource_id`;
  const order = "CASE WHEN kind='mcp' THEN 1 ELSE 0 END,CASE WHEN kind='mcp' THEN uses ELSE sessions END DESC,uses DESC,resource_id";
  const featureId = store.readRows<{ resource_id: string }>(`WITH grouped AS (${groups(where)}) SELECT resource_id FROM grouped
    WHERE sessions>=5 AND weeks>=4 ORDER BY ${order} LIMIT 1`, values)[0]?.resource_id;
  const resources = (target: OverviewSnapshot, id?: string): OverviewResources => ({ skills: [], mcp: [], observations: [],
    combinations: { sessions: [], turns: [] }, missingTimeEvents: 0, missingTurnEvents: 0, ...(id ? (() => {
      const row = factDetail(store, target, { view: "resources", pageSize: 1 }, now, { resourceIds: [id] }).rows[0] as OverviewResourceRow | undefined;
      return row ? row.kind === "skill" ? { skills: [row] } : { mcp: [row] } : {};
    })() : {}) });
  let currentResources: OverviewResources | undefined, previousResources: OverviewResources | undefined;
  if (snapshot.range.comparison) {
    const current = snapshot.range.comparison.current, previous = snapshot.range.comparison.previous;
    const currentSnapshot = { ...snapshot, query: { ...snapshot.query, window: "custom" as const, ...current }, range: { ...snapshot.range, ...current } };
    const previousSnapshot = { ...snapshot, query: { ...snapshot.query, window: "custom" as const, ...previous }, range: { ...snapshot.range, ...previous } };
    const currentScope = store.sqlScope(currentSnapshot.query, now), previousScope = store.sqlScope(previousSnapshot.query, now);
    const interval = "f.time_ms>=? AND f.time_ms<?";
    const changedId = store.readRows<{ resource_id: string }>(`WITH current AS (${groups(interval)}),previous AS (${groups(interval)})
      SELECT c.resource_id FROM current c JOIN previous p ON p.resource_id=c.resource_id WHERE c.sessions>=5 AND p.sessions>=5 AND c.weeks>=4
      AND ABS(c.sessions-p.sessions)*1.0/p.sessions>=0.2 ORDER BY CASE WHEN c.kind='mcp' THEN 1 ELSE 0 END,
      CASE WHEN c.kind='mcp' THEN c.uses ELSE c.sessions END DESC,c.uses DESC,c.resource_id LIMIT 1`,
    [snapshot.timezone, JSON.stringify(currentScope.revisions), currentScope.bounds!.fromMs, currentScope.bounds!.toMs,
      snapshot.timezone, JSON.stringify(previousScope.revisions), previousScope.bounds!.fromMs, previousScope.bounds!.toMs])[0]?.resource_id;
    if (changedId) { currentResources = resources(currentSnapshot, changedId); previousResources = resources(previousSnapshot, changedId); }
  }
  return { resources: resources(snapshot, featureId), currentResources, previousResources };
}

/** 工具失败概况只读取工具事实，原调用继续走按需调查。 */
export function factProcess(store: OverviewFactStore, snapshot: OverviewSnapshot, now: Date, candidates = false) {
  const scope = store.sqlScope(snapshot.query, now), bounds = scope.bounds ? [scope.bounds.fromMs, scope.bounds.toMs] : [];
  const values: SqlValue[] = [JSON.stringify(scope.revisions), ...bounds], where = scope.bounds ? "f.time_ms>=? AND f.time_ms<?" : "1";
  const leading = factDetail(store, snapshot, { view: "ranking", dimension: "tool", pageSize: candidates ? 1 : 5 }, now, { toolCandidates: candidates, toolFailures: !candidates });
  const tools = new Map((leading.rows as OverviewToolRow[]).filter(row => row.results.failure > 0).map(row => [row.key, row]));
  if (candidates) return { process: { tools: [...tools.values()], categories: [], results: counts(0, 0, 0), failures: 0 } satisfies OverviewProcess, counts: { tools: leading.total } };
  // 次数、结果与分类会话数在同一次聚合中完成，不重复扫描全部工具历史。
  const categories = store.readRows<{ key: string; count: number; sessions: number; success: number; failure: number }>(`SELECT
    overview_tool_category(f.tool,json_extract(f.json,'$.resource.kind')) AS key,COUNT(*) AS count,
    COUNT(DISTINCT r.session_id) AS sessions,SUM(f.status='success') AS success,SUM(f.status='failure') AS failure
    FROM overview_fact_events f JOIN overview_fact_revisions r ON r.revision=f.revision
    WHERE f.revision IN (SELECT value FROM json_each(?)) AND f.active=1 AND f.kind='tool_call' AND ${where} GROUP BY key`, values)
    .map(row => ({ key: row.key, name: row.key, count: row.count, sessions: row.sessions,
      results: counts(row.count, row.success ?? 0, row.failure ?? 0) })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const summary = categories.reduce((sum, row) => ({ calls: sum.calls + row.count,
    success: sum.success + row.results.success, failure: sum.failure + row.results.failure }), { calls: 0, success: 0, failure: 0 });
  const process: OverviewProcess = { tools: [...tools.values()], categories,
    results: counts(summary.calls, summary.success, summary.failure), failures: summary.failure };
  return { process, counts: { tools: leading.total } };
}

/** 委派用量仅汇总已归属会话的必要数值，不恢复请求计时及成员JSON。 */
export function factDelegation(store: OverviewFactStore, snapshot: OverviewSnapshot, now: Date): OverviewDelegation {
  const scope = store.sqlScope(snapshot.query, now), active = store.activitySessions(snapshot.query, now);
  const result = buildDelegation(scope.source, selectedSource(scope.source, snapshot.query, snapshot.range), scope.source,
    new Set(active.activeIds), snapshot.timezone, undefined, new Set(active.datedIds));
  const byId = new Map(scope.source.sessions.map(session => [session.id, session]));
  const eligible = scope.source.sessions.filter(session => session.relationship !== "fork"
    && !(session.relationship === "child" && (!session.parentSessionId || !byId.has(session.parentSessionId)))
    && !session.gaps.some(gap => ["diagnostics.sessions.store.m004", "diagnostics.sessions.store.m005", "diagnostics.sessions.store.m006", "diagnostics.sessions.store.m017"].includes(gap.messageDescriptor?.key ?? "")));
  const where = scope.bounds ? "f.time_ms>=? AND f.time_ms<?" : "1", bounds = scope.bounds ? [scope.bounds.fromMs, scope.bounds.toMs] : [];
  const models = snapshot.query.models?.length ? ` AND ${dimensionSql("f.model")} IN (SELECT value FROM json_each(?))` : "";
  const sum = (ids: string[]) => store.readRows<{ requests: number; tokens: number | null }>(`SELECT COUNT(*) AS requests,
    SUM(CASE WHEN f.input_tokens>=0 AND f.output_tokens>=0 THEN f.input_tokens+f.output_tokens END) AS tokens FROM overview_fact_requests f
    JOIN overview_fact_revisions r ON r.revision=f.revision WHERE f.revision IN (SELECT value FROM json_each(?))
    AND ${where}${models} AND r.session_id IN (SELECT value FROM json_each(?))`,
  [JSON.stringify(scope.revisions), ...bounds, ...(models ? [JSON.stringify(snapshot.query.models)] : []), JSON.stringify(ids)])[0]!;
  const assigned = sum(eligible.map(session => session.id)), child = sum(eligible.filter(session => session.relationship === "child").map(session => session.id));
  return { ...result, assignedRequests: assigned.requests, assignedTokens: assigned.tokens, childRequests: child.requests, childTokens: child.tokens };
}
