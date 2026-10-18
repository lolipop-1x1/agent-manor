import { sessionStatusSummaryResponse } from "../../../../src/service/summary-response.js";

/** CLI 只在已支持的接口请求摘要，Web 默认契约继续保留。 */
export function summaryRequestPath(path: string, full: boolean, method = "GET"): string {
  if (full) return path;
  const url = new URL(path, "http://127.0.0.1");
  const name = url.pathname;
  const supported = ["/status", "/sessions", "/sessions/search", "/sessions/search/groups", "/sessions/status", "/sessions/gaps", "/usage", "/usage/pricing", "/usage/pricing/refresh", "/usage/pricing/prices"].includes(name)
    || /^\/sessions\/[^/]+\/(messages|profile)$/.test(name)
    || /^\/knowledge\/extractions(?:\/[^/]+(?:\/(?:pause|resume|retry))?)?$/.test(name);
  if (supported) url.searchParams.set("response", "summary");
  const paged = ["/sessions", "/sessions/search", "/sessions/search/groups", "/sessions/gaps", "/usage", "/usage/pricing/prices", "/resources/overview", "/resources/usage", "/resources/local", "/resources/archives", "/resources/operations", "/knowledge/entries", "/knowledge/extractions"].includes(name)
    || /^\/sessions\/[^/]+\/(messages|turns|matches|profile)$/.test(name) || /^\/resources\/usage\/[^/]+\/evidence$/.test(name);
  if (paged && method === "GET" && !url.searchParams.has("pageSize")) url.searchParams.set("pageSize", "20");
  return `${name}${url.search}`;
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
}
function pick(value: ObjectValue, keys: string[]): ObjectValue {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

/** 服务实例外壳保留本机定位；完整状态只在 status 内保留一份。 */
export function summarizeStatus(value: unknown): unknown {
  const result = object(value);
  if (!result) return value;
  const nested = object(result.status);
  if (nested) return { ...pick(result, ["running", "state", "instance", "logPath", "details", "error"]), status: summarizeStatus(nested) };
  return { ...pick(result, ["running", "state", "instance", "url", "logPath", "version", "protocolVersion", "preparation", "activeTasks", "error", "errorDescriptor", "indexMaintenance", "indexReclaim", "repositoryCount", "jobCount"]),
    ...(result.sessions ? { sessions: sessionStatusSummaryResponse(result.sessions) } : {}),
    ...(Array.isArray(result.repositories) ? { repositoryCount: result.repositories.length } : {}),
    ...(Array.isArray(result.jobs) ? { jobCount: result.jobs.length } : {}) };
}

function revisionSummary(value: unknown): unknown {
  const revision = object(value);
  return revision ? pick(revision, ["id", "knowledgeId", "version", "baseRevisionId", "review", "title", "type", "scope", "subject", "language", "createdAt", "summary", "tags"]) : value;
}

/** 写操作返回操作定位，不重复历史正文；授权前的具体内容仍由原始 fetch 读取。 */
export function summarizeResponse(path: string, method: string, value: unknown, body?: unknown): unknown {
  const result = object(value);
  if (!result) return value;
  const input = object(body);
  const name = path.split("?")[0]!;
  if (name === "/status") return summarizeStatus(result);
  if (method !== "GET" && /^\/knowledge\/entries(?:\/[^/]+(?:\/(revisions|restore|reviews|availability))?)?$/.test(name) && result.latestRevisionId) {
    return { ...pick(result, ["id", "createdAt", "updatedAt", "availability", "availabilityReason", "publishedRevisionId", "latestRevisionId"]),
      ...(result.revision ? { revision: revisionSummary(result.revision) } : {}),
      ...(result.pendingRevision ? { pendingRevision: revisionSummary(result.pendingRevision) } : {}) };
  }
  if (method !== "GET" && name === "/resources/favorites" && Array.isArray(result.favoriteIds) && input) {
    return { id: input.id, favorite: result.favoriteIds.includes(input.id), favoriteCount: result.favoriteIds.length };
  }
  if ((name === "/resources/refresh" || /^\/resources\/sources(?:\/[^/]+)?$/.test(name)) && method !== "GET" && Array.isArray(result.manualSources)) {
    return { observedAt: result.observedAt, sourceCount: Array.isArray(result.sources) ? result.sources.length : undefined,
      gapCount: Array.isArray(result.gaps) ? result.gaps.length : undefined, manualSourceCount: result.manualSources.length,
      ...(method === "DELETE" ? { sourceId: decodeURIComponent(name.split("/").at(-1)!), removed: true } : {}),
      ...(input?.path ? { source: result.manualSources.find(source => object(source)?.path === input.path) } : {}) };
  }
  if (method === "PUT" && ["/knowledge/settings", "/semantic/settings"].includes(name) && result.config) {
    return { ...pick(result, ["fingerprint", "hasGenerationKey", "hasEmbeddingKey", "hasKey"]), saved: true };
  }
  if ((name === "/knowledge/entries" && method === "GET" || name === "/knowledge/search" && method === "POST") && Array.isArray(result.items)) {
    return { ...result, items: result.items.map(item => {
      const entry = object(item);
      return entry ? { ...pick(entry, ["id", "createdAt", "updatedAt", "availability", "publishedRevisionId", "latestRevisionId", "score", "snippet"]),
        revision: revisionSummary(entry.revision), ...(entry.pendingRevision ? { pendingRevision: revisionSummary(entry.pendingRevision) } : {}) } : item;
    }) };
  }
  if (/^\/knowledge\/extractions\/(preview|previews\/[^/]+)$/.test(name) && Array.isArray(result.targets)) {
    return { ...result, targets: result.targets.map(target => {
      const entry = object(target);
      if (!entry) return target;
      const { messageIds, hashes: _hashes, ...summary } = entry;
      return { ...summary, messageCount: Array.isArray(messageIds) ? messageIds.length : undefined };
    }) };
  }
  if (name === "/knowledge/extractions" && method === "GET" && Array.isArray(result.jobs)) {
    return { ...result, jobs: result.jobs.map(jobSummary) };
  }
  if (/^\/knowledge\/extractions(?:\/[^/]+(?:\/(?:pause|resume|retry))?)?$/.test(name)) {
    if (result.job) return { ...result, job: jobSummary(result.job) };
    if (result.previewId && result.status) return jobSummary(result);
  }
  return value;
}

function jobSummary(value: unknown): unknown {
  const job = object(value);
  if (!job) return value;
  const { events, results, failedSessions, model: _model, ...summary } = job;
  return { ...summary, ...(Array.isArray(events) ? { eventCount: events.length } : {}),
    ...(Array.isArray(results) ? { resultCount: results.length } : {}),
    ...(Array.isArray(failedSessions) ? { failedSessionCount: failedSessions.length } : {}) };
}
