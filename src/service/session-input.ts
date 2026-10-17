import type { MessageKind, SessionMessageQuery, SessionQuery, SessionRefreshOptions, SessionProfileQuery, SessionTimelineQuery } from "../session-contracts.js";
import { clientIds } from "../clients.js";
import type { Client } from "../clients.js";
import { coverageQuery, integer, ServiceError, textValue } from "./input.js";
import { validateSearchScope } from "../sessions/search-scope.js";

export function sessionRefreshOptions(body: unknown): SessionRefreshOptions {
  if (body === undefined) return {};
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some(key => key !== "client" && key !== "mode")) {
    throw new ServiceError("INVALID_INPUT", "刷新请求体只能包含 client 和 mode", { key: "diagnostics.service.sessionInput.m001" });
  }
  const raw = body as Record<string, unknown>;
  const client = textValue(raw.client, "client");
  if (client && !clientIds.includes(client as Client)) throw new ServiceError("INVALID_INPUT", "未知客户端", { key: "diagnostics.service.sessionInput.m002" });
  if (raw.mode !== undefined && raw.mode !== "quick" && raw.mode !== "full") throw new ServiceError("INVALID_INPUT", "检查方式必须是 quick 或 full", { key: "diagnostics.service.sessionInput.m003" });
  return { client: client as Client | undefined, mode: raw.mode as SessionRefreshOptions["mode"] };
}

export function sessionQuery(raw: Record<string, unknown>): SessionQuery {
  const { client, from, to, version } = coverageQuery(raw);
  const query: SessionQuery = { client, from, to, version, page: integer(raw.page, "page", 1, 1_000_000),
    pageSize: integer(raw.pageSize, "pageSize", 50, 200) };
  if (raw.scope !== undefined) {
    try {
      const value = raw.scope;
      if (typeof value !== "string" || !value.trim() || value.length > 65536) throw new Error("scope");
      query.scope = validateSearchScope(JSON.parse(value));
    } catch { throw new ServiceError("INVALID_INPUT", "会话搜索范围无效", { key: "sessions.filter.invalidScope" }); }
  }
  for (const key of ["project", "q"] as const) query[key] = textValue(raw[key], key);
  if (raw.includeSubagents !== undefined) query.includeSubagents = queryBoolean(raw.includeSubagents, "includeSubagents");
  if (raw.executionMode !== undefined) {
    if (!["regular", "quiet", "all"].includes(raw.executionMode as string)) throw new ServiceError("INVALID_INPUT", "未知会话执行类型", { key: "diagnostics.service.sessionInput.m004" });
    query.executionMode = raw.executionMode as SessionQuery["executionMode"];
  }
  const kinds = textValue(raw.kinds, "kinds");
  if (kinds) {
    const values = kinds.split(",");
    if (values.some(value => !["user", "assistant", "thinking", "tool_call", "tool_result", "system", "context", "compression"].includes(value))) {
      throw new ServiceError("INVALID_INPUT", "未知会话内容类型", { key: "diagnostics.service.sessionInput.m005" });
    }
    query.kinds = [...new Set(values)] as MessageKind[];
  }
  return query;
}

export function sessionMode(value: unknown): "brief" | "full" | "trace" | undefined {
  if (value === undefined) return undefined;
  if (value !== "brief" && value !== "full" && value !== "trace") throw new ServiceError("INVALID_INPUT", "未知会话查看方式", { key: "diagnostics.service.sessionInput.m006" });
  return value;
}

export function sessionMessageQuery(raw: Record<string, unknown>): SessionMessageQuery {
  const query: SessionMessageQuery = { ...sessionQuery(raw), mode: sessionMode(raw.mode) };
  const pageUnit = textValue(raw.pageUnit, "pageUnit");
  if (pageUnit !== undefined && pageUnit !== "message" && pageUnit !== "turn") throw new ServiceError("INVALID_INPUT", "未知消息分页单位", { key: "diagnostics.service.sessionInput.m007" });
  if (pageUnit) query.pageUnit = pageUnit;
  if (pageUnit === "turn" && raw.pageSize === undefined) query.pageSize = 10;
  if (raw.turnPosition !== undefined) {
    if (pageUnit !== "turn") throw new ServiceError("INVALID_INPUT", "turnPosition 仅支持完整轮次分页", { key: "diagnostics.service.sessionInput.m008" });
    query.turnPosition = integer(raw.turnPosition, "turnPosition", 1, 1_000_000_000);
  }
  for (const key of ["messageId", "toolName", "resourceName", "resourceServer", "branch"] as const) query[key] = textValue(raw[key], key);
  const resourceKind = textValue(raw.resourceKind, "resourceKind");
  if (resourceKind !== undefined && !["mcp", "skill_call", "skill_read"].includes(resourceKind)) throw new ServiceError("INVALID_INPUT", "未知资源证据类型", { key: "diagnostics.service.sessionInput.m009" });
  if (resourceKind) query.resourceKind = resourceKind as SessionMessageQuery["resourceKind"];
  for (const [key, maximum] of [["messageLimit", 2000], ["maxTextChars", 100_000]] as const) {
    if (raw[key] !== undefined) query[key] = integer(raw[key], key, 1, maximum);
  }
  if (raw.messageOffset !== undefined) query.messageOffset = queryOffset(raw.messageOffset, "messageOffset");
  return query;
}

function queryOffset(value: unknown, name: string): number {
  if (value === "0") return 0;
  return integer(value, name, 0, 1_000_000_000);
}

export function sessionProfileQuery(raw: Record<string, unknown>): SessionProfileQuery {
  const query: SessionProfileQuery = { ...sessionQuery(raw), includeChildren: queryBoolean(raw.includeChildren, "includeChildren") };
  if (raw.summary !== undefined) query.summary = queryBoolean(raw.summary, "summary");
  if (raw.stepLimit !== undefined) query.stepLimit = integer(raw.stepLimit, "stepLimit", 1, 2000);
  if (raw.stepOffset !== undefined) query.stepOffset = queryOffset(raw.stepOffset, "stepOffset");
  return query;
}

export function sessionTimelineQuery(raw: Record<string, unknown>): SessionTimelineQuery {
  return { version: textValue(raw.version, "version"),
    messageId: textValue(raw.messageId, "messageId"),
    ...(raw.maxEvents !== undefined ? { maxEvents: integer(raw.maxEvents, "maxEvents", 1, 5000) } : {}) };
}

export function queryBoolean(value: unknown, name: string): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new ServiceError("INVALID_INPUT", `${name} 必须是 true 或 false`, { key: "diagnostics.service.sessionInput.m010", params: { p0: String(name) } });
}
