import type { OverviewEvidenceQuery, OverviewQuery, OverviewWindow } from "../overview-contracts.js";
import { ServiceError, textValue } from "./input.js";
import { usageQuery } from "./usage-input.js";

const windows: OverviewWindow[] = ["365", "7", "30", "90", "year", "all", "custom"];
const invalid = (field: string): never => {
  throw new ServiceError("INVALID_INPUT", `无效总览参数：${field}`, { key: "diagnostics.usage.input.invalid", params: { field } });
};
const fields = ["version", "priceVersion", "timezone", "from", "to", "clients", "projects", "models"] as const;
const validDay = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export function overviewQuery(raw: Record<string, unknown>, allowEvidence = false): OverviewQuery {
  const allowed = new Set<string>([...fields, "window", "anchorDay", ...(allowEvidence ? ["evidence"] : [])]);
  for (const field of Object.keys(raw)) if (!allowed.has(field)) invalid(field);
  if (raw.window !== undefined && !windows.includes(raw.window as OverviewWindow)) invalid("window");
  const basic = usageQuery(Object.fromEntries(fields.filter(field => raw[field] !== undefined).map(field => [field, raw[field]])));
  const query: OverviewQuery = { window: raw.window as OverviewWindow | undefined ?? "365" };
  const anchorDay = raw.anchorDay;
  if (anchorDay !== undefined) { if (!validDay(anchorDay)) invalid("anchorDay"); query.anchorDay = anchorDay as string; }
  for (const field of fields) if (basic[field] !== undefined) Object.assign(query, { [field]: basic[field] });
  for (const field of ["from", "to"] as const) if (query[field] !== undefined && !validDay(query[field])) invalid(field);
  if (query.from && query.to && (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000 > 36_600) invalid("from/to");
  return query;
}

const enums = {
  kind: ["activity", "sessions", "requests", "resources", "tools", "failures", "compressions", "timing", "combinations", "observations", "sequence", "delegation"],
  scope: ["global", "usage"], period: ["selected", "current", "previous", "recent", "recent_previous"],
  relationship: ["main", "child", "fork"], resourceKind: ["skill", "mcp"], resourceEvidenceKind: ["skill_call", "skill_read", "mcp"],
  category: ["read", "search", "edit", "command", "delegate", "external", "other"], status: ["success", "failure", "unknown"],
  unit: ["session", "turn"], observationState: ["mature", "observing", "outside_range", "insufficient_coverage"],
  sort: ["recent", "tokens", "duration", "ordinal"],
  transition: ["switch", "delegation"],
} as const;
const textFields = ["from", "to", "day", "client", "project", "model", "modelFrom", "modelTo", "sessionId", "requestId", "turnId", "resourceId", "resourceId2", "tool", "toolId", "toolKey", "server", "timingGroup", "rule"] as const;

export function overviewEvidenceQuery(raw: unknown): OverviewEvidenceQuery {
  const encoded = textValue(raw, "evidence", true)!;
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { invalid("evidence"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("evidence");
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>([...Object.keys(enums), ...textFields, "page", "pageSize", "undated", "ordinalFrom", "ordinalTo"]);
  for (const field of Object.keys(record)) if (!allowed.has(field)) invalid(`evidence.${field}`);
  if (!enums.kind.includes(record.kind as typeof enums.kind[number])) invalid("evidence.kind");
  if (record.undated !== undefined && typeof record.undated !== "boolean") invalid("evidence.undated");
  for (const [field, choices] of Object.entries(enums)) {
    if (record[field] !== undefined && !(choices as readonly unknown[]).includes(record[field])) invalid(`evidence.${field}`);
  }
  for (const field of textFields) if (record[field] !== undefined) textValue(record[field], `evidence.${field}`);
  for (const field of ["from", "to", "day"] as const) if (record[field] !== undefined && !validDay(record[field])) invalid(`evidence.${field}`);
  if (record.from && record.to && String(record.from) > String(record.to)) invalid("evidence.from/to");
  for (const [field, maximum] of [["page", 1_000_000], ["pageSize", 200]] as const) {
    if (record[field] !== undefined && (!Number.isSafeInteger(record[field]) || Number(record[field]) < 1 || Number(record[field]) > maximum)) invalid(`evidence.${field}`);
  }
  for (const field of ["ordinalFrom", "ordinalTo"] as const) {
    if (record[field] !== undefined && (!Number.isSafeInteger(record[field]) || Number(record[field]) < 0)) invalid(`evidence.${field}`);
  }
  if (record.ordinalFrom !== undefined && record.ordinalTo !== undefined && Number(record.ordinalFrom) > Number(record.ordinalTo)) invalid("evidence.ordinalFrom/ordinalTo");
  return record as unknown as OverviewEvidenceQuery;
}
