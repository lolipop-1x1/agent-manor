import type { OverviewEvidencePage, OverviewEvidenceQuery, OverviewSnapshot, OverviewSource } from "../overview-contracts.js";
import type { PricingView } from "../usage/pricing.js";
import { matchesGlobalSession } from "./analytics.js";
import { buildOverviewEvidence } from "./evidence.js";
import type { OverviewFactStore } from "./facts.js";
import { factExtraEvidence, hydrateFactRequestEvidence } from "./evidence-extra.js";

type EventRecord = Parameters<OverviewFactStore["decodeEvent"]>[0];
type RequestRecord = Parameters<OverviewFactStore["decodeRequest"]>[0];
type ResourceRecord = Parameters<OverviewFactStore["decodeResource"]>[0];
type Value = string | number | null;

/** 先选当前页身份，再补成员与相邻请求；原证据构建器仍负责展示口径。 */
export async function factEvidence(store: OverviewFactStore, snapshot: OverviewSnapshot, evidence: OverviewEvidenceQuery,
  pricing: PricingView, now: Date): Promise<OverviewEvidencePage> {
  const metadata = store.snapshot(snapshot.query), prepared = { range: snapshot.range, rowIds: new Set<string>(), total: 0 };
  const empty = () => buildOverviewEvidence(metadata, snapshot.query, evidence, pricing, now, prepared);
  const initial = empty();
  const period = snapshot.range;
  if (evidence.period === "previous" && !period.comparison || evidence.period === "recent_previous" && !period.recent) return initial;
  const comparison = evidence.period === "current" ? period.comparison?.current : evidence.period === "previous" ? period.comparison?.previous
    : evidence.period === "recent" ? period.recent?.current : evidence.period === "recent_previous" ? period.recent?.previous : undefined;
  if (evidence.period === "recent" && !period.recent) return initial;
  const from = evidence.day ?? evidence.from, to = evidence.day ?? evidence.to;
  const dates = { from: comparison?.from ?? period.from, to: comparison?.to ?? period.to };
  if (from && from > dates.from) dates.from = from;
  if (to && to < dates.to) dates.to = to;
  if (dates.from > dates.to) return initial;
  const all = evidence.undated === true || period.all && (!evidence.period || evidence.period === "selected") && !from && !to;
  const scope = store.sqlScope({ ...snapshot.query, window: "custom", ...dates }, now);
  const extra = { ...snapshot.query, ...(evidence.client ? { clients: [evidence.client] } : {}),
    ...(evidence.project ? { projects: [evidence.project] } : {}) };
  const selectedSessions = metadata.sessions.filter(session => matchesGlobalSession(session, snapshot.query) && matchesGlobalSession(session, extra)
    && (!evidence.sessionId || session.id === evidence.sessionId)
    && (!evidence.relationship || (evidence.relationship === "main" ? session.relationship !== "child" && session.relationship !== "fork" : session.relationship === evidence.relationship)));
  const selectedIds = JSON.stringify(selectedSessions.map(row => row.id));
  const revisions = store.readRows<{ revision: string }>(`SELECT revision FROM overview_fact_revisions WHERE revision IN (SELECT value FROM json_each(?))
    AND session_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(scope.revisions), selectedIds]).map(row => row.revision);
  const json = JSON.stringify(revisions), time = evidence.undated ? "f.time_ms IS NULL" : all ? "1" : "f.time_ms>=? AND f.time_ms<?";
  const values: Value[] = [json, ...(!all && !evidence.undated ? [scope.bounds!.fromMs, scope.bounds!.toMs] : [])];
  const baseValues = [...values];
  const evidenceScope = { metadata, revisions, time, values: baseValues, initial, range: { ...scope.range, all },
    query: { ...extra, ...(evidence.model ? { models: [evidence.model] } : {}) } };
  const where = [`f.revision IN (SELECT value FROM json_each(?))`, time];
  const event = evidence.kind === "tools" || evidence.kind === "failures" || evidence.kind === "compressions";
  const request = evidence.kind === "requests" || evidence.kind === "timing";
  const resource = evidence.kind === "resources";
  const keyedModel = `CASE WHEN f.model IS NULL THEN 'unknown' WHEN f.model='unknown' OR substr(f.model,1,8)='literal:' THEN 'literal:'||f.model ELSE f.model END`;
  const add = (condition: string, value?: Value) => { where.push(condition); if (value !== undefined) values.push(value); };
  if (request) {
    if ((evidence.scope === "usage" || evidence.kind === "timing") && snapshot.query.models?.length) add(`${keyedModel} IN (SELECT value FROM json_each(?))`, JSON.stringify(snapshot.query.models));
    if (evidence.model) add(`${keyedModel}=?`, evidence.model);
    if (evidence.turnId) add("json_extract(f.json,'$.usage.turnId')=?", evidence.turnId);
    if (evidence.requestId) add("f.id=?", evidence.requestId);
    if (evidence.ordinalFrom !== undefined) add("f.ordinal>=?", evidence.ordinalFrom);
    if (evidence.ordinalTo !== undefined) add("f.ordinal<=?", evidence.ordinalTo);
    if (evidence.kind === "timing") add("overview_valid_timing(json_extract(f.json,'$.usage.timing'))=1");
    if (evidence.timingGroup) add(`json_array(json_extract(s.value,'$.client'),f.model,json_extract(f.json,'$.usage.timing.window'),
      json_extract(f.json,'$.usage.timing.basis'),json_extract(f.json,'$.usage.timing.method'))=?`, evidence.timingGroup);
  } else if (event || resource) {
    add(event ? "f.active=1" : "f.valid=1");
    if (event) add(evidence.kind === "compressions" ? "f.kind='compression'" : "f.kind='tool_call'");
    if (evidence.kind === "failures") add("f.status='failure'");
    if (evidence.turnId) add("f.turn_id=?", evidence.turnId);
    if (evidence.tool) add("f.tool=?", evidence.tool);
    if (evidence.toolKey !== undefined) add(`CASE WHEN f.tool IS NULL THEN 'unknown' WHEN f.tool='unknown' OR substr(f.tool,1,8)='literal:' THEN 'literal:'||f.tool ELSE f.tool END=?`, evidence.toolKey);
    if (evidence.status) add("f.status=?", evidence.status);
    const server = resource ? "f.server" : "json_extract(f.json,'$.resource.server')";
    if (evidence.server) add(`${server}=?`, evidence.server);
    if (evidence.toolId) add(`json_array(f.tool,${server})=?`, evidence.toolId);
    if (event && evidence.category) add("overview_tool_category(f.tool,json_extract(f.json,'$.resource.kind'))=?", evidence.category);
    if (resource) {
      if (evidence.resourceId) add("f.resource_id=?", evidence.resourceId);
      if (evidence.resourceKind) add(evidence.resourceKind === "mcp" ? "f.kind='mcp'" : "f.kind<>'mcp'");
      if (evidence.resourceEvidenceKind) add("f.kind=?", evidence.resourceEvidenceKind);
    }
  }
  const join = "JOIN overview_fact_revisions r ON r.revision=f.revision";
  if (request && !evidence.transition || resource || event) {
    const table = request ? "requests" : resource ? "resources" : "events";
    const meta = request && evidence.timingGroup ? ` JOIN json_each(?) s ON json_extract(s.value,'$.id')=r.session_id` : "";
    const parameters = meta ? [JSON.stringify(metadata.sessions.map(row => ({ id: row.id, client: row.client }))), ...values] : values;
    const candidate = `SELECT f.*,r.session_id,r.resource_source_json FROM overview_fact_${table} f ${join}${meta} WHERE ${where.join(" AND ")}`;
    const total = store.readRows<{ total: number }>(`SELECT COUNT(*) AS total FROM (${candidate})`, parameters)[0]!.total;
    const tokenOrder = "CASE WHEN input_tokens>=0 OR output_tokens>=0 THEN CASE WHEN input_tokens>=0 THEN input_tokens ELSE 0 END+CASE WHEN output_tokens>=0 THEN output_tokens ELSE 0 END ELSE -1 END";
    const order = evidence.sort === "tokens" && request ? `${tokenOrder} DESC,session_id||':'||id`
      : evidence.sort === "duration" ? `COALESCE(json_extract(json,'${request ? "$.usage.timing.durationMs" : "$.durationMs"}'),-1) DESC,session_id||':'||id`
      : evidence.sort === "ordinal" ? "session_id,ordinal,session_id||':'||id" : "time_ms DESC,session_id||':'||id";
    const page = store.readRows<EventRecord | RequestRecord | ResourceRecord>(`SELECT * FROM (${candidate}) ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...parameters, initial.pageSize, (initial.page - 1) * initial.pageSize]);
    if (request) return { ...initial, total, rows: hydrateFactRequestEvidence(store, snapshot, evidence, evidenceScope, page as RequestRecord[], pricing) };
    const source: OverviewSource = { ...metadata, events: [], requests: [], resources: [] };
    if (resource) source.resources = page.map(row => store.decodeResource(row as ResourceRecord));
    else source.events = page.map(row => store.decodeEvent(row as EventRecord));
    return buildOverviewEvidence(source, snapshot.query, evidence, pricing, now, { range: snapshot.range, total,
      rowIds: new Set(page.map(row => resource ? row.id : `${row.session_id}:${row.id}`)) });
  }
  return factExtraEvidence(store, snapshot, evidence, pricing, now, evidenceScope);
}
