import type { AnalysisSnapshot, MapSession } from "../contracts.js";
import type { SessionSummary } from "../session-contracts.js";
import { filterEvents } from "./coverage.js";

/** 完整仓库中确有文件活动的客户端，来源配置与纯工作目录事件不构成地图数据。 */
export function mapClientOptions(snapshot: AnalysisSnapshot) {
  return [...new Set(filterEvents(snapshot, { categories: ["source", "config", "docs", "unknown"] }).map(event => event.client))].sort();
}

/** 只按规范会话身份归属活动，来源中的分叉副本不改变原事件归属。 */
export function mapSessions(snapshot: AnalysisSnapshot, summaries: SessionSummary[]): MapSession[] {
  const sessions = new Map<string, MapSession>();
  const key = (client: string, id: string) => `${client}:${id}`;
  for (const source of [...snapshot.sources, ...snapshot.events]) {
    const identity = key(source.client, source.sessionId);
    if (!sessions.has(identity)) sessions.set(identity, { client: source.client, clientSessionId: source.sessionId, eventCount: 0 });
  }
  const seen = new Set<string>();
  for (const event of snapshot.events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const session = sessions.get(key(event.client, event.sessionId))!;
    session.eventCount++;
    if (event.occurredAt) {
      if (!session.startedAt || event.occurredAt < session.startedAt) session.startedAt = event.occurredAt;
      if (!session.updatedAt || event.occurredAt > session.updatedAt) session.updatedAt = event.occurredAt;
    }
  }
  for (const summary of summaries) {
    const session = sessions.get(key(summary.client, summary.clientSessionId));
    if (!session) continue;
    session.title = summary.title;
    if (summary.titleOrigin === "fallback") session.titleDescriptor = {
      key: summary.relationship === "child" ? "sessions.title.childFallback" : "sessions.title.unnamed",
      ...(summary.relationship === "child" ? { params: { id: summary.clientSessionId.slice(-8) } } : {}),
    };
    session.startedAt = summary.startedAt ?? session.startedAt;
    session.updatedAt = summary.updatedAt ?? session.updatedAt;
  }
  return [...sessions.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")
    || key(a.client, a.clientSessionId).localeCompare(key(b.client, b.clientSessionId)));
}
