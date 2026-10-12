import type { OverviewDetailPage, OverviewDetailQuery, OverviewDetailRow, OverviewModelTransition, OverviewProjectMonth,
  OverviewSnapshot, OverviewSource } from "../overview-contracts.js";
import { buildProcess, buildResources, resourceCombinations, resourceIdentity, resourceObservations, selectedSource, timingGroupId, validDuration } from "./analytics.js";
import { inPeriod, localDay } from "./dates.js";
import { nonnegative } from "./insight-math.js";
import { usageDimensionKey } from "../usage/dimensions.js";

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
export function overviewDetail(source: OverviewSource, snapshot: OverviewSnapshot, query: OverviewDetailQuery,
  ranking?: OverviewDetailRow[]): OverviewDetailPage {
  const selected = selectedSource(source, snapshot.query, snapshot.range, true), page = query.page ?? 1, pageSize = query.pageSize ?? 20;
  let rows: OverviewDetailRow[] = [], object: OverviewDetailPage["object"], counts: OverviewDetailPage["counts"];
  if (query.view === "resources") {
    const resources = buildResources(source, selectedSource(source, snapshot.query, snapshot.range), snapshot.range, snapshot.timezone, false);
    rows = query.kind === "mcp" ? resources.mcp : query.kind === "skill" ? resources.skills : [...resources.skills, ...resources.mcp];
    rows.sort((a, b) => { const left = a as typeof resources.skills[number], right = b as typeof left;
      return query.sort === "sessions" || !query.sort && query.kind === "skill"
        ? right.sessions - left.sessions || right.uses - left.uses || left.id.localeCompare(right.id)
        : right.uses - left.uses || right.sessions - left.sessions || left.id.localeCompare(right.id); });
  } else if (query.view === "resource") {
    const scoped = { ...source, resources: source.resources.filter(event => resourceIdentity(event) === query.resourceId) };
    const resources = buildResources(scoped, selectedSource(scoped, snapshot.query, snapshot.range), snapshot.range, snapshot.timezone);
    const full = [...resources.skills, ...resources.mcp][0];
    if (full) {
      const dimension = query.dimension === "project" ? "projects" : query.dimension === "tool" ? "tools" : "clients";
      rows = full[dimension]; counts = { clients: full.clients.length, projects: full.projects.length, tools: full.tools.length };
      object = { ...full, clients: [], projects: [], tools: [] };
    }
  } else if (query.view === "months") rows = projectMonths(source, snapshot);
  else if (query.view === "transitions") rows = modelTransitions(source, snapshot).filter(row => !query.transition || query.transition === "all" || row.kind === query.transition);
  else if (query.view === "observations") rows = resourceObservations(source, selectedSource(source, snapshot.query, snapshot.range), snapshot.range, snapshot.timezone);
  else if (query.view === "combinations") rows = resourceCombinations(source, selectedSource(source, snapshot.query, snapshot.range).resources, query.unit ?? "session");
  else if (query.view === "timings" || query.view === "timing") {
    const byId = new Map(source.sessions.map(session => [session.id, session])), groups = new Map<string, typeof source.requests>();
    for (const request of selected.requests) {
      if (!validDuration(request.usage)) continue;
      const id = timingGroupId(byId.get(request.sessionId)!, request.usage); if (query.view === "timing" && id !== query.timingGroup) continue;
      const group = groups.get(id) ?? []; group.push(request); groups.set(id, group);
    }
    const ordered = [...groups].sort(([left, a], [right, b]) => b.length - a.length || left.localeCompare(right));
    const requests = ordered.slice((page - 1) * pageSize, page * pageSize).flatMap(([, values]) => values);
    const scoped = { ...selected, events: [], requests };
    rows = buildProcess({ ...source, events: [] }, scoped, scoped, snapshot.timezone).timing;
    return { snapshot, query, rows, total: ordered.length, page, pageSize };
  } else if (query.view === "ranking") rows = ranking ?? [];
  return { snapshot, query, rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize,
    ...(object ? { object, counts } : {}) };
}
