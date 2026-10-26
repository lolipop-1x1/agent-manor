import { CLIENTS, type Client } from "../../../src/clients";
import type { SemanticScope } from "../../../src/semantic-contracts";
import { validateSearchScope } from "../../../src/sessions/search-scope";
import { localSemanticDate, semanticDateBoundary, semanticQueryScope, sharedSessionSearchScope } from "./semantic-ui-model";

export interface SessionNavigationTarget {
  sessionId: string; messageId?: string; version?: string; mode?: "brief" | "full" | "trace"; branch?: string;
}
export type SessionEvidenceTarget = SessionNavigationTarget & { version: string };

/** 点击跳转和可复制链接共用同一版本与消息定位。 */
export function sessionNavigationAddress(target: SessionNavigationTarget): string {
  const params = new URLSearchParams({ id: target.sessionId });
  if (target.version) params.set("version", target.version);
  if (target.messageId) params.set("message", target.messageId);
  if (target.mode) params.set("mode", target.mode);
  if (target.branch) params.set("branch", target.branch);
  return `#sessions?${params}`;
}
export interface SessionFilters {
  client: Client | "all"; project: string; from: string; to: string; q: string; process: boolean; subagents: boolean; execution: "regular" | "quiet" | "all";
}
export function readSessionFilters(hash: string): SessionFilters {
  const params = new URLSearchParams(hash.startsWith("#sessions") ? hash.split("?")[1] : "");
  const client = params.get("client");
  const execution = params.get("execution");
  const date = (key: string) => {
    const value = params.get(key) ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
    const parsed = new Date(`${value}T00:00:00`);
    return !Number.isNaN(parsed.getTime()) && parsed.getDate() === Number(value.slice(-2)) && parsed.getMonth() + 1 === Number(value.slice(5, 7)) ? value : "";
  };
  return { client: CLIENTS.some(item => item.id === client) ? client as Client : "all", project: params.get("project") || "all",
    from: date("from"), to: date("to"), q: params.get("q") ?? "", process: params.get("process") === "true", subagents: params.get("subagents") === "true",
    execution: execution === "quiet" || execution === "all" ? execution : "regular" };
}
export function writeSessionFilters(params: URLSearchParams, filters: SessionFilters): void {
  for (const [key, value] of Object.entries(filters)) {
    if (value === false || value === "" || key === "client" && value === "all" || key === "project" && value === "all" || key === "execution" && value === "regular") params.delete(key);
    else params.set(key, String(value));
  }
}

export function readSessionSearchScope(hash: string): SemanticScope {
  const legacy = readSessionFilters(hash), defaults = semanticQueryScope();
  const raw = new URLSearchParams(hash.startsWith("#sessions") ? hash.split("?")[1] : "").get("scope");
  if (raw) { try { return { ...defaults, ...validateSearchScope(JSON.parse(raw)) }; } catch { /* 旧书签或非法范围回退到已校验的旧筛选。 */ } }
  return { ...defaults, clients: legacy.client === "all" ? [] : [legacy.client], projects: legacy.project === "all" ? [] : [legacy.project],
    from: semanticDateBoundary(legacy.from), to: semanticDateBoundary(legacy.to, true), relationship: legacy.subagents ? "all" : "exclude_children",
    executionMode: legacy.execution === "regular" ? "exclude_quiet" : legacy.execution };
}

export function writeSessionSearchFilters(params: URLSearchParams, scope: SemanticScope, q: string, process: boolean): void {
  writeSessionFilters(params, { client: scope.clients.length === 1 ? scope.clients[0]! : "all", project: scope.projects.length === 1 ? scope.projects[0]! : "all",
    from: localSemanticDate(scope.from), to: localSemanticDate(scope.to), q, process, subagents: scope.relationship !== "exclude_children",
    execution: scope.executionMode === "exclude_quiet" ? "regular" : scope.executionMode === "unknown" ? "all" : scope.executionMode });
  if (JSON.stringify(scope) === JSON.stringify(semanticQueryScope())) params.delete("scope");
  else params.set("scope", JSON.stringify(sharedSessionSearchScope(scope)));
}
