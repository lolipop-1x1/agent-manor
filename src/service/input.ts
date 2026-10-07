import type { MessageDescriptor } from "../i18n/types.js";
import type { ApiErrorCode, Client, CoverageQuery, EventKind, EventsQuery, FileCategory } from "../contracts.js";
import { clientIds } from "../clients.js";

export class ServiceError extends Error {
  constructor(readonly code: ApiErrorCode, message: string, readonly messageDescriptor?: MessageDescriptor) { super(message); }
}

export function textValue(value: unknown, name: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 4096) {
    throw new ServiceError("INVALID_INPUT", `${name} 必须是非空字符串`, { key: "diagnostics.service.input.m001", params: { p0: String(name) } });
  }
  return value;
}

export function relativePath(value: unknown, name = "path", allowRoot = false): string {
  const path = textValue(value, name, true)!;
  if (allowRoot && path === ".") return path;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || /^[A-Za-z]:/.test(path)
    || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ServiceError("INVALID_INPUT", `${name} 必须是仓库内的相对路径`, { key: "diagnostics.service.input.m002", params: { p0: String(name) } });
  }
  return path;
}

export function integer(value: unknown, name: string, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new ServiceError("INVALID_INPUT", `${name} 必须是 1 到 ${maximum} 的整数`, { key: "diagnostics.service.input.m003", params: { p0: String(name), p1: maximum } });
  }
  return Number(value);
}

export function coverageQuery(raw: Record<string, unknown>): CoverageQuery {
  const query: CoverageQuery = {};
  const version = textValue(raw.version, "version");
  if (version) query.version = version;
  const client = textValue(raw.client, "client");
  if (client && !clientIds.includes(client as Client)) throw new ServiceError("INVALID_INPUT", "未知客户端", { key: "diagnostics.service.input.m004" });
  if (client) query.client = client as Client;
  for (const key of ["from", "to"] as const) {
    const value = textValue(raw[key], key);
    if (value && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))) {
      throw new ServiceError("INVALID_INPUT", `${key} 必须是 ISO 8601 时间`, { key: "diagnostics.service.input.m005", params: { p0: String(key) } });
    }
    if (value) query[key] = value;
  }
  if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) throw new ServiceError("INVALID_INPUT", "from 不能晚于 to", { key: "diagnostics.service.input.m006" });
  const categories = textValue(raw.categories, "categories");
  if (categories) {
    const values = categories.split(",");
    if (values.some((value) => !["source", "config", "docs", "unknown"].includes(value))) {
      throw new ServiceError("INVALID_INPUT", "未知文件类别", { key: "diagnostics.service.input.m007" });
    }
    query.categories = [...new Set(values)] as FileCategory[];
  }
  if (raw.directory !== undefined) query.directory = relativePath(raw.directory, "directory", true);
  return query;
}

export function eventsQuery(raw: Record<string, unknown>): EventsQuery {
  const query: EventsQuery = coverageQuery(raw);
  if (raw.path !== undefined) query.path = relativePath(raw.path);
  const kind = textValue(raw.kind, "kind");
  if (kind && !["read", "edit", "search", "other"].includes(kind)) throw new ServiceError("INVALID_INPUT", "未知活动类型", { key: "diagnostics.service.input.m008" });
  if (kind) query.kind = kind as EventKind;
  query.page = integer(raw.page, "page", 1, 1_000_000);
  query.pageSize = integer(raw.pageSize, "pageSize", 50, 200);
  return query;
}

export function bodyText(body: unknown, key: string): string {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((name) => name !== key)) {
    throw new ServiceError("INVALID_INPUT", `请求体只能包含 ${key}`, { key: "diagnostics.service.input.m009", params: { p0: String(key) } });
  }
  return textValue((body as Record<string, unknown>)[key], key, true)!;
}

export function emptyBody(body: unknown): void {
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0)) {
    throw new ServiceError("INVALID_INPUT", "此操作不接受请求体字段", { key: "diagnostics.service.input.m010" });
  }
}
