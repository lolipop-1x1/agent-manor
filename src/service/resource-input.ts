import type { ResourceLocalQuery, ResourceMapQuery, ResourceOverviewQuery } from "../resource-service-contracts.js";
import type { ResourceUsageEvidenceQuery } from "../resource-contracts.js";
import { coverageQuery, integer, ServiceError, textValue } from "./input.js";
import { queryBoolean } from "./session-input.js";

export function resourceQuery(raw: Record<string, unknown>): ResourceLocalQuery & ResourceUsageEvidenceQuery {
  const { client, from, to, version } = coverageQuery(raw);
  const query: ResourceLocalQuery & ResourceUsageEvidenceQuery = { client, from, to, version,
    page: integer(raw.page, "page", 1, 1_000_000), pageSize: integer(raw.pageSize, "pageSize", 30, 200),
    lowSessions: integer(raw.lowSessions, "lowSessions", 2, 10_000), inactiveDays: integer(raw.inactiveDays, "inactiveDays", 90, 3650) };
  query.favorite = queryBoolean(raw.favorite, "favorite");
  for (const key of ["project", "q", "tool"] as const) query[key] = textValue(raw[key], key);
  const enums = { kind: ["skill", "mcp"], sort: ["sessions", "calls", "reads", "uses", "recent", "name"], order: ["asc", "desc"],
    candidate: ["all", "unused", "low", "old", "broken", "duplicate", "favorite", "review"],
    evidenceKind: ["skill_call", "skill_read", "mcp"] };
  for (const [key, values] of Object.entries(enums)) {
    const value = textValue(raw[key], key);
    if (value && !values.includes(value)) throw new ServiceError("INVALID_INPUT", `未知 ${key}`, { key: "diagnostics.service.resourceInput.m001", params: { p0: String(key) } });
    if (value) Object.assign(query, { [key]: value });
  }
  return query;
}

export function resourceOverviewQuery(raw: Record<string, unknown>): ResourceOverviewQuery {
  const candidate = textValue(raw.candidate, "candidate");
  if (candidate && !["all", "used", "unused", "low", "old", "review", "favorite"].includes(candidate)) throw new ServiceError("INVALID_INPUT", "未知 candidate", { key: "diagnostics.service.resourceInput.m002" });
  const query = resourceQuery({ ...raw, candidate: undefined, pageSize: raw.pageSize ?? "20" });
  return { ...query, kind: query.kind ?? "skill", project: undefined, candidate: candidate as ResourceOverviewQuery["candidate"] };
}

export function resourceMapQuery(raw: Record<string, unknown>): ResourceMapQuery {
  const { page: _page, pageSize: _pageSize, sort: _sort, order: _order, ...query } = resourceOverviewQuery({
    ...raw, page: undefined, pageSize: undefined, sort: undefined, order: undefined });
  const metric = textValue(raw.metric, "metric") ?? "calls";
  if (!["calls", "sessions", "reads", "uses"].includes(metric) || query.kind === "mcp" && metric === "reads") {
    throw new ServiceError("INVALID_INPUT", "所选资源不支持该面积指标", { key: "diagnostics.service.resourceInput.m003" });
  }
  const value = raw.maxValue;
  if (value !== undefined && (typeof value !== "string" || !/^\d+$/.test(value)
    || !Number.isSafeInteger(Number(value)))) throw new ServiceError("INVALID_INPUT", "maxValue 必须是非负安全整数", { key: "diagnostics.service.resourceInput.m004" });
  return { ...query, metric: metric as ResourceMapQuery["metric"], maxValue: value === undefined ? undefined : Number(value) };
}

export function resourceBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) {
    throw new ServiceError("INVALID_INPUT", `请求体只接受 ${allowed.join("、")}`, { key: "diagnostics.service.resourceInput.m005", params: { p0: allowed.join(", ") } });
  }
  return body as Record<string, unknown>;
}
