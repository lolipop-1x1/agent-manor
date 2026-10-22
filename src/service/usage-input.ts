import { clientIds } from "../clients.js";
import type { PricingConfiguration, UsageQuery } from "../usage-contracts.js";
import { ServiceError, integer, textValue } from "./input.js";

const invalid = (field: string): never => {
  throw new ServiceError("INVALID_INPUT", `无效用量参数：${field}`, { key: "diagnostics.usage.input.invalid", params: { field } });
};
const arrays = ["clients", "excludeClients", "projects", "excludeProjects", "models", "excludeModels", "speedGroups"] as const;
const enums = {
  relationship: ["all", "main", "child"], sessionType: ["all", "interactive", "automation", "fork"],
  coverage: ["all", "complete", "partial", "missing"], pricing: ["all", "complete", "partial", "missing"],
  metric: ["tokens", "cost", "requests"], groupBy: ["project", "model", "client"], interval: ["hour", "day", "week", "month"],
  sort: ["tokens", "cost", "requests", "recent"], direction: ["asc", "desc"],
} as const;

/** POST 读取与 GET 共用校验，同时接收 JSON 数组、数字和布尔值。 */
export function usageQueryBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("query");
  const raw = { ...body as Record<string, unknown> };
  for (const field of arrays) if (Array.isArray(raw[field])) raw[field] = JSON.stringify(raw[field]);
  for (const field of ["page", "pageSize", "requestPage", "requestPageSize", "minTokens", "maxTokens", "minCost", "maxCost"]) {
    if (typeof raw[field] === "number") raw[field] = String(raw[field]);
  }
  if (typeof raw.includeSpeed === "boolean") raw.includeSpeed = String(raw.includeSpeed);
  return raw;
}

export function usageQuery(raw: Record<string, unknown>): UsageQuery {
  const allowed = new Set([...arrays, ...Object.keys(enums), "version", "priceVersion", "timezone", "from", "to",
    "includeSpeed", "speedGroup", "page", "pageSize", "minTokens", "maxTokens", "minCost", "maxCost", "sessionId", "requestPage", "requestPageSize"]);
  for (const field of Object.keys(raw)) if (!allowed.has(field)) invalid(field);
  const query: UsageQuery = { page: integer(raw.page, "page", 1, 1_000_000), pageSize: integer(raw.pageSize, "pageSize", 25, 200) };
  for (const field of ["version", "priceVersion", "timezone", "from", "to"] as const) {
    const value = textValue(raw[field], field);
    if (value) query[field] = value;
  }
  if (raw.includeSpeed !== undefined) {
    if (raw.includeSpeed !== "true" && raw.includeSpeed !== "false") invalid("includeSpeed");
    query.includeSpeed = raw.includeSpeed === "true";
  }
  if (raw.speedGroup !== undefined) {
    const group = raw.speedGroup;
    if (!query.includeSpeed || typeof group !== "string" || !group.trim() || group.length > 8192) return invalid("speedGroup");
    query.speedGroup = group;
  }
  if (query.timezone) {
    try { new Intl.DateTimeFormat("en", { timeZone: query.timezone }).format(); } catch { invalid("timezone"); }
  }
  for (const field of ["from", "to"] as const) {
    const value = query[field];
    if (!value) continue;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    if (dateOnly) {
      const parsed = new Date(`${value}T00:00:00Z`);
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid(field);
    } else if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) invalid(field);
  }
  if (query.from && query.to) {
    if (query.from.includes("T") !== query.to.includes("T")) invalid("from/to");
    if (query.from.includes("T") ? Date.parse(query.from) > Date.parse(query.to) : query.from > query.to) invalid("from/to");
  }
  for (const field of arrays) {
    if (raw[field] === undefined) continue;
    let value: unknown;
    try {
      const text = field === "speedGroups" ? raw[field] : textValue(raw[field], field, true);
      if (typeof text !== "string") return invalid(field);
      value = JSON.parse(text);
    } catch { invalid(field); }
    const maxLength = field === "speedGroups" ? 8192 : 4096;
    if (!Array.isArray(value) || value.length > 500 || value.some(item => typeof item !== "string" || !item.trim() || item.length > maxLength)) invalid(field);
    if (field === "speedGroups" && !query.includeSpeed) invalid(field);
    const values = [...new Set(value as string[])];
    if ((field === "clients" || field === "excludeClients") && values.some(client => !clientIds.includes(client as typeof clientIds[number]))) invalid(field);
    query[field] = values;
  }
  for (const [field, values] of Object.entries(enums)) {
    if (raw[field] === undefined) continue;
    if (!(values as readonly unknown[]).includes(raw[field])) invalid(field);
    Object.assign(query, { [field]: raw[field] });
  }
  for (const field of ["minTokens", "maxTokens", "minCost", "maxCost"] as const) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== "string" || !/^\d+(?:\.\d+)?$/.test(raw[field] as string)) invalid(field);
    const value = Number(raw[field]);
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER || field.includes("Tokens") && !Number.isSafeInteger(value)) invalid(field);
    query[field] = value;
  }
  if (query.minTokens !== undefined && query.maxTokens !== undefined && query.minTokens > query.maxTokens) invalid("minTokens/maxTokens");
  if (query.minCost !== undefined && query.maxCost !== undefined && query.minCost > query.maxCost) invalid("minCost/maxCost");
  return query;
}

export function pricingConfiguration(body: unknown): PricingConfiguration {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("configuration");
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== "overrides" && key !== "mappings")
    || !Array.isArray(value.overrides) || !Array.isArray(value.mappings) || value.overrides.length > 500 || value.mappings.length > 500) invalid("configuration");
  return value as unknown as PricingConfiguration;
}
