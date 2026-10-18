import type { SessionSummary } from "../session-contracts.js";
import type { MessageDescriptor } from "../i18n/types.js";

/** 状态只携带计数、进度与必要错误；完整诊断通过独立分页读取。 */
export function sessionStatusSummaryResponse(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const source = value as Record<string, unknown>;
  const fields = (input: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  const job = (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? fields(value as Record<string, unknown>, ["id", "status", "phase", "phaseDescriptor", "progress", "createdAt", "startedAt", "finishedAt", "error", "errorDescriptor", "message", "messageDescriptor", "processedSources", "totalSources"]) : value;
  const result = fields(source, ["version", "previousVersion", "createdAt", "stale", "sessionCount", "sourceCount", "gapCount", "error", "errorDescriptor"]);
  if (result.gapCount === undefined && Array.isArray(source.gaps)) result.gapCount = source.gaps.length;
  if (source.job !== undefined) result.job = job(source.job);
  if (source.autoSync && typeof source.autoSync === "object") {
    const sync = source.autoSync as Record<string, unknown>;
    result.autoSync = { ...fields(sync, ["intervalMs", "state", "nextRunAt", "lastSuccessAt", "consecutiveFailures", "error", "errorDescriptor"]),
      ...(sync.job !== undefined ? { job: job(sync.job) } : {}) };
  }
  return result;
}

export function sessionSummaryResponse(session: SessionSummary) {
  const keys = ["id", "title", "client", "project", "updatedAt"] as const;
  const titleDescriptor = (session as SessionSummary & { titleDescriptor?: MessageDescriptor }).titleDescriptor
    ?? (session.titleOrigin === "fallback" ? { key: session.relationship === "child" ? "sessions.title.childFallback" : "sessions.title.unnamed",
      ...(session.relationship === "child" ? { params: { id: session.clientSessionId.slice(-8) } } : {}) } : undefined);
  return { ...Object.fromEntries(keys.filter(key => session[key] !== undefined).map(key => [key, session[key]])),
    ...(titleDescriptor ? { titleDescriptor } : {}) };
}

/** 分组只保留一次会话元信息，命中项用稳定身份关联。 */
export function searchSummaryResponse(value: unknown) {
  const result = value as Record<string, unknown>;
  const hasMore = Number(result.page) * Number(result.pageSize) < Number(result.total);
  const hit = (value: unknown) => {
    const row = value as { session?: SessionSummary; [key: string]: unknown };
    const { session, ...rest } = row;
    return session ? { ...rest, sessionId: session.id } : rest;
  };
  const groups = result.groups as { session: SessionSummary; hits: unknown[] }[] | undefined;
  if (groups) return { ...result, hasMore, groups: groups.map(group => ({ ...group, session: sessionSummaryResponse(group.session), hits: group.hits.map(hit) })),
    ...(Array.isArray(result.hits) ? { hits: result.hits.map(hit) } : {}) };
  const hits = result.hits as { session?: SessionSummary }[] | undefined;
  if (!hits) {
    const sessions = result.sessions as SessionSummary[] | undefined;
    return sessions ? { ...result, sessions: sessions.map(sessionSummaryResponse), hasMore } : value;
  }
  const candidates = result.sessions as SessionSummary[] | undefined ?? hits.flatMap(row => row.session ? [row.session] : []);
  const sessions = [...new Map(candidates.map(session => [session.id, sessionSummaryResponse(session)])).values()];
  return { ...result, hasMore, sessions, hits: hits.map(hit) };
}
