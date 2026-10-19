import { scenarioResponse, scenarioResponsePath } from "./scenario-response.js";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(object) : [];
const pick = (value: unknown, keys: readonly string[]): Row => {
  const row = object(value);
  return Object.fromEntries(keys.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
};
const pageKeys = ["version", "total", "page", "pageSize", "hasMore", "observedAt", "partial", "stale"];
const entryKeys = ["id", "updatedAt", "availability", "availabilityReason", "latestRevisionId", "publishedRevisionId", "score", "snippet"];
const revisionKeys = ["id", "version", "title", "type", "scope", "review", "tags"];
const resourceKeys = ["id", "name", "kind", "client", "scope", "project", "entryPath", "readState", "nativeState", "managementState", "protected", "capabilities"];

/** 按 CLI 场景选择核心字段，人工授权材料与显式原始证据保留完整内容。 */
export function coreResponsePath(path: string): boolean {
  return scenarioResponsePath(path) || /^\/repositories(?:\/[^/]+)?$/.test(path)
    || /^\/knowledge\/(?:search|entries(?:\/[^/]+(?:\/(?:revisions(?:\/[^/]+)?|restore|reviews|availability))?)?)$/.test(path)
    || /^\/resources\/(?:status|refresh|favorites|sources(?:\/[^/]+)?|overview|usage|local|archives|operations|apply)$/.test(path);
}

function revisionResponse(value: unknown, mode: "list" | "detail" | "write" | "history"): Row {
  const revision = object(value);
  const result = pick(revision, mode === "write" ? ["id", "version", "review"] : mode === "history"
    ? ["id", "version", "title", "review", "createdAt", "baseRevisionId", "changeReason"]
    : [...revisionKeys, ...(mode === "detail" ? ["subject", "language", "body", "summary", "applicability", "validUntil", "occurredAt", "resolved", "sourceCount", "changedSourceCount", "missingSourceCount"] : [])]);
  if (mode === "detail" && Array.isArray(revision.sources)) {
    result.sourceCount = revision.sources.length;
    result.changedSourceCount = rows(revision.sources).filter(source => source.status === "changed").length;
    result.missingSourceCount = rows(revision.sources).filter(source => source.status === "missing").length;
    result.sources = revision.sources.map(source => pick(source, ["kind", "taskId", "client", "sessionId", "sourceVersion", "currentVersion", "branch", "messageId", "turnId", "turnPosition", "callId", "status", "limitation"]));
  }
  return result;
}

function knowledgeEntry(value: unknown, mode: "list" | "detail" | "write"): Row {
  const row = object(value);
  return { ...pick(row, mode === "write" ? ["id", "latestRevisionId", "publishedRevisionId", "availability", "availabilityReason"] : entryKeys),
    ...(row.revision ? { revision: revisionResponse(row.revision, mode) } : {}),
    ...(row.pendingRevision ? { pendingRevision: revisionResponse(row.pendingRevision, "write") } : {}) };
}

function resourceRow(value: unknown): Row {
  const row = object(value);
  return { ...pick(row, ["favorite", "protected", "observation", "partial", "candidates", "localSummary"]),
    ...(row.identity ? { identity: pick(row.identity, ["id", "name", "kind", "client", "project", "grouping"]) } : {}),
    ...(row.body ? { body: pick(row.body, ["id", "name", "kind"]), entryCount: row.entryCount ?? rows(row.entries).length } : {}),
    ...(row.stats !== undefined ? { stats: row.stats } : {}), ...(row.usage !== undefined ? { usage: row.usage } : {}) };
}

/** HTTP 与 CLI 共用白名单，旧后台返回完整对象时 CLI 仍可保证默认契约。 */
export function coreResponse(path: string, method: string, value: unknown, body?: unknown): unknown {
  const name = path.split("?")[0]!;
  if (!coreResponsePath(name)) return value;
  if (scenarioResponsePath(name)) return scenarioResponse(name, method, value, body);
  const result = object(value);
  if (name === "/repositories") {
    const repository = (row: unknown) => pick(row, ["id", "name", "path", "version", "stale"]);
    if (Array.isArray(value)) return value.map(repository);
    if (Array.isArray(result.repositories)) return { repositories: result.repositories.map(repository) };
    return result.repository ? { repository: repository(result.repository), ...(result.job ? { job: { ...object(result.job),
      ...(result.id === object(result.job).id ? pick(result, ["status", "phase", "progress", "finishedAt", "error", "errorDescriptor", "version"]) : {}) } } : {}) } : value;
  }
  if (name.startsWith("/repositories/") && method === "DELETE" && result.repositoryId) return pick(result, ["repositoryId"]);
  if (name.startsWith("/knowledge/")) {
    if (Array.isArray(result.items)) return { ...pick(result, [...pageKeys, "mode", "indexState"]), items: result.items.map(row => knowledgeEntry(row, "list")) };
    if (Array.isArray(result.revisions)) {
      if (/\/revisions$/.test(name) && method === "GET") return { revisions: result.revisions.map(revision => revisionResponse(revision, "history")) };
    }
    if (result.latestRevisionId) return knowledgeEntry(result, method === "GET" ? "detail" : "write");
    if (/\/revisions\/[^/]+$/.test(name) && result.id && (result.knowledgeId || result.body !== undefined)) return revisionResponse(result, "detail");
    return value;
  }
  if (name === "/resources/favorites" && Array.isArray(result.favoriteIds)) {
    const input = object(body);
    return { id: input.id, favorite: result.favoriteIds.includes(input.id), favoriteCount: result.favoriteIds.length };
  }
  if (["/resources/status", "/resources/refresh", "/resources/sources"].includes(name) || /^\/resources\/sources\/[^/]+$/.test(name)) {
    const summary = { observedAt: result.observedAt, sourceCount: result.sourceCount ?? rows(result.sources).length,
      gapCount: result.gapCount ?? rows(result.gaps).length, manualSourceCount: result.manualSourceCount ?? rows(result.manualSources).length };
    if (method === "DELETE") return { ...summary, sourceId: decodeURIComponent(name.split("/").at(-1)!), removed: true };
    const source = rows(result.manualSources).find(source => source.path === object(body).path);
    return { ...summary, ...(result.source ? { source: pick(result.source, ["id", "client", "kind", "path", "project"]) }
      : source ? { source: pick(source, ["id", "client", "kind", "path", "project"]) } : {}) };
  }
  if (name === "/resources/local" && Array.isArray(result.rows)) return { ...pick(result, pageKeys), rows: result.rows.map(resourceRow) };
  if (["/resources/overview", "/resources/usage"].includes(name) && Array.isArray(result.resources)) {
    return { ...pick(result, pageKeys), resources: result.resources.map(resourceRow),
      ...(result.coverage ? { coverage: pick(result.coverage, ["partial", "uncertainClients", "unavailableClients"]) } : {}) };
  }
  if (name === "/resources/archives" && Array.isArray(result.archives)) return { ...pick(result, pageKeys), archives: rows(result.archives).map(row => ({
    ...pick(row, ["id", "operationId", "state", "createdAt", "restorable", "operationStatus", "target"]), entry: pick(row.entry, resourceKeys) })) };
  const operation = (row: unknown) => pick(row, ["id", "previewId", "action", "entryId", "name", "resource", "status", "message", "messageDescriptor", "createdAt", "archiveId", "localState", "clientEffect"]);
  if (name === "/resources/operations" && Array.isArray(result.operations)) return { ...pick(result, pageKeys), operations: result.operations.map(operation) };
  if (name === "/resources/apply" && result.status) return { ...operation(result), ...pick(result, ["details", "target", "affectedEntries", "link"]) };
  return value;
}
