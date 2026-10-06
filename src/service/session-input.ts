import type { MessageKind, SessionMessageQuery, SessionQuery } from "../session-contracts.js";
import { coverageQuery, integer, ServiceError, textValue } from "./input.js";

export function sessionQuery(raw: Record<string, unknown>): SessionQuery {
  const { client, from, to, version } = coverageQuery(raw);
  const query: SessionQuery = { client, from, to, version, page: integer(raw.page, "page", 1, 1_000_000),
    pageSize: integer(raw.pageSize, "pageSize", 50, 200) };
  for (const key of ["project", "q"] as const) query[key] = textValue(raw[key], key);
  if (raw.includeSubagents !== undefined) query.includeSubagents = queryBoolean(raw.includeSubagents, "includeSubagents");
  if (raw.executionMode !== undefined) {
    if (!["regular", "quiet", "all"].includes(raw.executionMode as string)) throw new ServiceError("INVALID_INPUT", "未知会话执行类型");
    query.executionMode = raw.executionMode as SessionQuery["executionMode"];
  }
  const kinds = textValue(raw.kinds, "kinds");
  if (kinds) {
    const values = kinds.split(",");
    if (values.some(value => !["user", "assistant", "thinking", "tool_call", "tool_result", "system", "context", "compression"].includes(value))) {
      throw new ServiceError("INVALID_INPUT", "未知会话内容类型");
    }
    query.kinds = [...new Set(values)] as MessageKind[];
  }
  return query;
}

export function sessionMode(value: unknown): "brief" | "full" | "trace" | undefined {
  if (value === undefined) return undefined;
  if (value !== "brief" && value !== "full" && value !== "trace") throw new ServiceError("INVALID_INPUT", "未知会话查看方式");
  return value;
}

export function sessionMessageQuery(raw: Record<string, unknown>): SessionMessageQuery {
  const query: SessionMessageQuery = { ...sessionQuery(raw), mode: sessionMode(raw.mode) };
  const pageUnit = textValue(raw.pageUnit, "pageUnit");
  if (pageUnit !== undefined && pageUnit !== "message" && pageUnit !== "turn") throw new ServiceError("INVALID_INPUT", "未知消息分页单位");
  if (pageUnit) query.pageUnit = pageUnit;
  if (pageUnit === "turn" && raw.pageSize === undefined) query.pageSize = 10;
  if (raw.turnPosition !== undefined) {
    if (pageUnit !== "turn") throw new ServiceError("INVALID_INPUT", "turnPosition 仅支持完整轮次分页");
    query.turnPosition = integer(raw.turnPosition, "turnPosition", 1, 1_000_000_000);
  }
  for (const key of ["messageId", "toolName", "resourceName", "resourceServer", "branch"] as const) query[key] = textValue(raw[key], key);
  const resourceKind = textValue(raw.resourceKind, "resourceKind");
  if (resourceKind !== undefined && !["mcp", "skill_call", "skill_read"].includes(resourceKind)) throw new ServiceError("INVALID_INPUT", "未知资源证据类型");
  if (resourceKind) query.resourceKind = resourceKind as SessionMessageQuery["resourceKind"];
  return query;
}

export function queryBoolean(value: unknown, name: string): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new ServiceError("INVALID_INPUT", `${name} 必须是 true 或 false`);
}
