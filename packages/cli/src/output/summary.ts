import { searchSummaryResponse, sessionSummaryResponse, sessionStatusSummaryResponse } from "../../../../src/service/summary-response.js";
import type { SessionSummary } from "../../../../src/session-contracts.js";
import { coreResponse, coreResponsePath } from "../../../../src/service/core-response.js";

/** CLI 只在已支持的接口请求摘要，Web 默认契约继续保留。 */
export function summaryRequestPath(path: string, full: boolean, method = "GET"): string {
  if (full) return path;
  const url = new URL(path, "http://127.0.0.1");
  const name = url.pathname;
  const supported = ["/status", "/sessions", "/sessions/search", "/sessions/search/groups", "/sessions/status", "/sessions/gaps", "/usage", "/usage/pricing", "/usage/pricing/refresh", "/usage/pricing/prices"].includes(name)
    || /^\/sessions\/[^/]+\/(messages|profile)$/.test(name)
    || /^\/knowledge\/extractions(?:\/[^/]+(?:\/(?:pause|resume|retry))?)?$/.test(name);
  // 人工授权绑定精确路径，审批写入保持授权路径，仅在 CLI 投影返回结果。
  const authorizedWrite = method === "POST" && /^\/knowledge\/entries\/[^/]+\/(reviews|availability)$/.test(name);
  if ((supported || coreResponsePath(name)) && !authorizedWrite) url.searchParams.set("response", "summary");
  const paged = ["/sessions", "/sessions/search", "/sessions/search/groups", "/sessions/gaps", "/usage", "/usage/pricing/prices", "/resources/overview", "/resources/usage", "/resources/local", "/resources/archives", "/resources/operations", "/knowledge/entries", "/knowledge/extractions"].includes(name)
    || /^\/sessions\/[^/]+\/(messages|turns|matches|profile)$/.test(name) || /^\/resources\/usage\/[^/]+\/evidence$/.test(name);
  if (paged && method === "GET" && !url.searchParams.has("pageSize")) url.searchParams.set("pageSize", "20");
  if (/^\/repositories\/[^/]+\/events$/.test(name) && !url.searchParams.has("pageSize")) url.searchParams.set("pageSize", "20");
  if (/^\/sessions\/[^/]+\/timeline$/.test(name) && !url.searchParams.has("maxEvents")) url.searchParams.set("maxEvents", "200");
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

/** ready 只回答数据准备结果，其他业务计数由 status 查询。 */
export function summarizeReady(value: unknown): unknown {
  const result = object(value);
  return result ? pick(result, ["instance", "version", "protocolVersion", "preparation", "activeTasks", "error", "errorDescriptor"]) : value;
}

/** 写操作返回操作定位，不重复历史正文；授权前的具体内容仍由原始 fetch 读取。 */
export function summarizeResponse(path: string, method: string, value: unknown, body?: unknown): unknown {
  if (coreResponsePath(path.split("?")[0]!)) return coreResponse(path, method, value, body);
  const result = object(value);
  if (!result) return value;
  const name = path.split("?")[0]!;
  if (name === "/status") return summarizeStatus(result);
  if (["/sessions", "/sessions/search", "/sessions/search/groups"].includes(name)) return searchSummaryResponse(result);
  if (/^\/sessions\/[^/]+\/messages$/.test(name) && result.session) return { ...result, session: sessionSummaryResponse(result.session as SessionSummary) };
  if (method === "PUT" && ["/knowledge/settings", "/semantic/settings"].includes(name) && result.config) {
    return { ...pick(result, ["fingerprint", "hasGenerationKey", "hasEmbeddingKey", "hasKey"]), saved: true };
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
