import type { KnowledgeDetail, KnowledgeDraft, KnowledgeExtractionScope, KnowledgeQuery, KnowledgeSource, KnowledgeType } from "../../../src/knowledge-contracts";
import { semanticQueryScope } from "../sessions/semantic-ui-model";

export interface KnowledgeSessionSelection { id: string; title?: string; totalTurns?: number }
export type KnowledgePage = "library" | "review" | "tasks" | "settings";
export function knowledgeTypeKey(type?: KnowledgeType): string { return `knowledge.type.${type ?? "unclassified"}`; }
export function restoreKnowledgeFocus(targets: readonly (HTMLElement | null | undefined)[]): void {
  for (const target of targets) if (target?.isConnected && target.getClientRects().length && !target.matches(":disabled, [aria-disabled=true]")) { target.focus({ preventScroll: true }); return; }
}
export function readKnowledgeAddress(hash: string): { page: KnowledgePage; id?: string; query: KnowledgeQuery; scope?: KnowledgeExtractionScope; selection?: KnowledgeSessionSelection } {
  const params = new URLSearchParams(hash.split("?")[1]);
  const page = params.get("page");
  const view = params.get("view"), review = params.get("review");
  const query: KnowledgeQuery = { view: view === "personal" || view === "project" || view === "general" ? view : "all", review: review === "pending" || review === "reviewed" || review === "rejected" ? review : "reviewed", availability: "active", q: params.get("q") ?? "", project: params.get("project") ?? undefined, taskId: params.get("taskId") ?? undefined, page: 1, pageSize: 20 };
  const sessionId = params.get("sessionId");
  const scope = sessionId ? { ...semanticQueryScope(), relationship: "all" as const, executionMode: "all" as const, sessionIds: [sessionId], branch: params.get("branch") ?? "current", turnStart: positive(params.get("turnStart")), turnEnd: positive(params.get("turnEnd")) } : undefined;
  return { page: page === "review" || page === "tasks" || page === "settings" ? page : "library", id: params.get("id") ?? undefined, query, scope, selection: sessionId ? { id: sessionId, title: params.get("sessionTitle") || undefined, totalTurns: positive(params.get("totalTurns")) } : undefined };
}
function positive(value: string | null): number | undefined { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : undefined; }
export function sourceAddress(source: KnowledgeSource): string | undefined {
  if (!source.sessionId || source.status !== "available") return undefined;
  const params = new URLSearchParams({ id: source.sessionId, mode: "trace", branch: source.branch ?? "all" });
  if (source.messageId) params.set("message", source.messageId);
  if (source.currentVersion ?? source.sourceVersion) params.set("version", (source.currentVersion ?? source.sourceVersion)!);
  if (source.turnPosition) params.set("turn", String(source.turnPosition));
  return `#sessions?${params}`;
}
export function emptyDraft(language: "zh-CN" | "en"): KnowledgeDraft {
  return { title: "", body: "", scope: { kind: "global" }, subject: "general", type: "fact", tags: [], language, sources: [{ kind: "manual" }] };
}
export function editableDraft(detail: KnowledgeDetail): KnowledgeDraft {
  const { id: _id, knowledgeId: _knowledgeId, version: _version, baseRevisionId: _base, review: _review, createdAt: _created, ...draft } = detail.pendingRevision ?? detail.revision;
  return draft;
}
