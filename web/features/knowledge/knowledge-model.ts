import type { KnowledgeDetail, KnowledgeDraft, KnowledgeExtractionScope, KnowledgeLimitation, KnowledgeQuery, KnowledgeSource, KnowledgeType } from "../../../src/knowledge-contracts";
import { semanticQueryScope } from "../sessions/semantic-ui-model";

export interface KnowledgeSessionSelection { id: string; title?: string; totalTurns?: number }
export type KnowledgePage = "library" | "review" | "new" | "tasks" | "settings";
export function knowledgeTypeKey(type?: KnowledgeType): string { return `knowledge.type.${type ?? "unclassified"}`; }
export function restoreKnowledgeFocus(targets: readonly (HTMLElement | null | undefined)[]): void {
  for (const target of targets) if (target?.isConnected && target.getClientRects().length && !target.matches(":disabled, [aria-disabled=true]")) { target.focus({ preventScroll: true }); return; }
}
export function readKnowledgeAddress(hash: string): { page: KnowledgePage; id?: string; taskId?: string; query: KnowledgeQuery; scope?: KnowledgeExtractionScope; selection?: KnowledgeSessionSelection } {
  const params = new URLSearchParams(hash.split("?")[1]);
  const page = params.get("page");
  const view = params.get("view"), review = params.get("review");
  const query: KnowledgeQuery = { view: view === "personal" || view === "project" || view === "general" ? view : "all", review: review === "pending" || review === "reviewed" || review === "rejected" ? review : "reviewed", availability: "active", q: params.get("q") ?? "", project: params.get("project") ?? undefined, taskId: params.get("taskId") ?? undefined, page: 1, pageSize: 20 };
  const sessionId = params.get("sessionId");
  const scope = sessionId ? { ...semanticQueryScope(), relationship: "all" as const, executionMode: "all" as const, sessionIds: [sessionId], branch: params.get("branch") ?? "current", turnStart: positive(params.get("turnStart")), turnEnd: positive(params.get("turnEnd")) } : undefined;
  // 兼容旧会话入口；任务记录只接受 taskId 定位，不自动挑选旧任务。
  return { page: page === "tasks" && sessionId && !params.has("taskId") ? "new" : page === "review" || page === "new" || page === "tasks" || page === "settings" ? page : "library", id: params.get("id") ?? undefined, taskId: params.get("taskId") ?? undefined, query, scope, selection: sessionId ? { id: sessionId, title: params.get("sessionTitle") || undefined, totalTurns: positive(params.get("totalTurns")) } : undefined };
}
export function knowledgeListWidth(viewport: number, preferred?: number): number {
  const maximum = Math.max(315, viewport - 360);
  return Math.min(maximum, Math.max(315, preferred ?? Math.min(460, viewport * .4)));
}
export function knowledgeNavigationWidth(viewport: number, preferred = 192): number {
  return Math.min(Math.max(176, Math.min(360, viewport - 675)), Math.max(176, preferred));
}
const routineLimitations = new Set(["knowledge.limitation.inputSummarized", "knowledge.limitation.similarityUnavailable"]);
export function knowledgeSourceGroups(sources: readonly KnowledgeSource[]) {
  const groups = new Map<string, { key: string; sources: KnowledgeSource[]; warnings: KnowledgeLimitation[] }>();
  const notes = new Map<string, KnowledgeLimitation>();
  const identity = (item: KnowledgeLimitation) => item.messageDescriptor ? JSON.stringify([item.messageDescriptor.key, Object.entries(item.messageDescriptor.params ?? {}).sort(([left], [right]) => left.localeCompare(right))]) : item.message;
  for (const [index, source] of sources.entries()) {
    // 不跨会话、分支或输入版本合并证据；原始引用与摘录完整保留。
    const key = source.sessionId ? JSON.stringify([source.kind, source.client, source.sessionId, source.branch, source.sourceVersion ?? source.currentVersion]) : `unlinked:${index}`;
    let group = groups.get(key);
    if (!group) { group = { key, sources: [], warnings: [] }; groups.set(key, group); }
    group.sources.push(source);
    const limitations = source.limitationDetails?.length ? source.limitationDetails : source.limitation ? [{ message: source.limitation }] : [];
    for (const item of limitations) {
      if (routineLimitations.has(item.messageDescriptor?.key ?? "")) notes.set(identity(item), item);
      else if (!group.warnings.some(prior => identity(prior) === identity(item))) group.warnings.push(item);
    }
  }
  return { groups: [...groups.values()], notes: [...notes.values()] };
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
