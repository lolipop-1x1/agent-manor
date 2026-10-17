import { clientIds } from "../clients.js";
import type { Client } from "../clients.js";
import type { SessionSearchScope } from "../session-contracts.js";

/** 新查询显式携带共同范围；旧接口参数继续保留各自默认行为。 */
export function validateSearchScope(value: unknown): SessionSearchScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("scope");
  const scope = value as Record<string, unknown>;
  const strings = (key: string): string[] => {
    const values = scope[key] ?? [];
    if (!Array.isArray(values) || values.length > 1000 || values.some(item => typeof item !== "string" || item.length > 32768)) throw new Error(key);
    return [...new Set(values)] as string[];
  };
  const enumeration = <T extends string>(key: string, values: readonly T[], fallback: T): T => {
    const value = scope[key] ?? fallback;
    if (!values.includes(value as T)) throw new Error(key);
    return value as T;
  };
  const count = (key: string): number | undefined => {
    const value = scope[key];
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000_000) throw new Error(key);
    return Number(value);
  };
  const date = (key: string): string | undefined => {
    const value = scope[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(key);
    return value;
  };
  const clients = strings("clients");
  if (clients.some(client => !clientIds.includes(client as Client))) throw new Error("clients");
  if (scope.title !== undefined && (typeof scope.title !== "string" || scope.title.length > 4096)) throw new Error("title");
  const result: SessionSearchScope = { clients: clients as Client[], projects: strings("projects"), models: strings("models"), title: scope.title as string ?? "",
    relationship: enumeration("relationship", ["all", "exclude_children", "children", "forks", "unknown"], "exclude_children"),
    executionMode: enumeration("executionMode", ["all", "exclude_quiet", "quiet", "unknown"], "exclude_quiet"),
    branch: enumeration("branch", ["all", "current"], "all"), from: date("from"), to: date("to"),
    minMessages: count("minMessages"), maxMessages: count("maxMessages"), minTurns: count("minTurns"), maxTurns: count("maxTurns") };
  for (const [min, max] of [[result.minMessages, result.maxMessages], [result.minTurns, result.maxTurns]]) if (min !== undefined && max !== undefined && min > max) throw new Error("range");
  if (result.from && result.to && Date.parse(result.from) > Date.parse(result.to)) throw new Error("dates");
  for (const key of ["from", "to", "minMessages", "maxMessages", "minTurns", "maxTurns"] as const) if (result[key] === undefined) delete result[key];
  return result;
}

/** 两种搜索复用同一会话元数据谓词，分支范围由各自的消息／片段处理。 */
export function searchScopeFilter(scope: SessionSearchScope, relationship = "COALESCE(json_extract(r.json,'$.relationship'),'')"): { clauses: string[]; values: (string | number)[] } {
  const clauses: string[] = [], values: (string | number)[] = [];
  const list = (column: string, items: string[]) => {
    if (items.length) { clauses.push(`${column} IN (SELECT value FROM json_each(?))`); values.push(JSON.stringify(items)); }
  };
  list("r.client", scope.clients); list("COALESCE(r.project,'')", scope.projects.map(project => project === "none" ? "" : project));
  if (scope.relationship === "exclude_children") clauses.push(`${relationship}!='child'`);
  else if (scope.relationship !== "all") { clauses.push(`${relationship}=?`); values.push(scope.relationship === "children" ? "child" : scope.relationship === "forks" ? "fork" : ""); }
  if (scope.executionMode === "exclude_quiet") clauses.push("COALESCE(json_extract(r.json,'$.executionMode'),'')!='quiet'");
  else if (scope.executionMode !== "all") { clauses.push("COALESCE(json_extract(r.json,'$.executionMode'),'')=?"); values.push(scope.executionMode === "quiet" ? "quiet" : ""); }
  if (scope.models.length) { clauses.push("EXISTS(SELECT 1 FROM json_each(r.json,'$.models') model WHERE model.value IN (SELECT value FROM json_each(?)))"); values.push(JSON.stringify(scope.models)); }
  if (scope.title) { clauses.push("instr(lower(COALESCE(r.title,'')),lower(?))>0"); values.push(scope.title); }
  for (const [field, value, comparison] of [["messageCount", scope.minMessages, ">="], ["messageCount", scope.maxMessages, "<="], ["turnCount", scope.minTurns, ">="], ["turnCount", scope.maxTurns, "<="]] as const) {
    if (value !== undefined) { clauses.push(`json_extract(r.json,'$.${field}')${comparison}?`); values.push(value); }
  }
  if (scope.from) { clauses.push("julianday(COALESCE(r.updated_at,r.started_at))>=julianday(?)"); values.push(scope.from); }
  if (scope.to) { clauses.push("julianday(COALESCE(r.started_at,r.updated_at))<=julianday(?)"); values.push(scope.to); }
  return { clauses, values };
}
