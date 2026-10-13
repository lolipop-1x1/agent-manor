import { overviewPanels, type OverviewDetailQuery, type OverviewDistributionDimension, type OverviewEvidenceQuery, type OverviewPanel, type OverviewQuery, type OverviewWindow, type WeeklyReviewDetailQuery } from "../overview-contracts.js";
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
  kind: ["activity", "sessions", "requests", "resources", "tools", "failures", "combinations", "observations", "sequence", "delegation"],
  scope: ["global", "usage"], period: ["selected", "current", "previous", "recent", "recent_previous"],
  relationship: ["main", "child", "fork"], resourceKind: ["skill", "mcp"], resourceEvidenceKind: ["skill_call", "skill_read", "mcp"],
  category: ["read", "search", "edit", "command", "delegate", "external", "other"], status: ["success", "failure", "unknown"],
  unit: ["session", "turn"], observationState: ["mature", "observing", "outside_range", "insufficient_coverage"],
  sort: ["recent", "tokens", "duration", "ordinal"],
  transition: ["switch", "delegation"],
} as const;
const textFields = ["from", "to", "day", "client", "project", "model", "modelFrom", "modelTo", "sessionId", "requestId", "turnId", "resourceId", "resourceId2", "tool", "toolId", "toolKey", "server", "rule"] as const;

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
  if (record.sort === "duration" && (record.kind === "requests" || record.kind === "sequence" && record.scope === "usage")) invalid("evidence.sort");
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

export function overviewPanel(raw: unknown): OverviewPanel {
  if (typeof raw !== "string" || ![...overviewPanels, "distribution", "delegation", "facets"].includes(raw)) invalid("panel");
  return raw as OverviewPanel;
}
export function overviewDistributionDimension(raw: unknown, panel: OverviewPanel): OverviewDistributionDimension | undefined {
  if (panel !== "distribution") { if (raw !== undefined) invalid("dimension"); return; }
  if (typeof raw !== "string" || !["client", "project", "model"].includes(raw)) invalid("dimension");
  return raw as OverviewDistributionDimension;
}
export function overviewDetailQuery(raw: unknown): OverviewDetailQuery {
  const encoded = textValue(raw, "detail", true)!;
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { invalid("detail"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("detail");
  const record = value as Record<string, unknown>;
  const choices = { view: ["resources", "resource", "ranking", "months", "transitions", "observations", "combinations"],
    kind: ["skill", "mcp"], dimension: ["client", "project", "model", "tool"], unit: ["session", "turn"],
    transition: ["all", "switch", "delegation"], sort: ["uses", "sessions", "count", "tokens", "cost"] };
  const allowed = new Set([...Object.keys(choices), "resourceId", "page", "pageSize"]);
  for (const field of Object.keys(record)) if (!allowed.has(field)) invalid(`detail.${field}`);
  if (!choices.view.includes(record.view as string)) invalid("detail.view");
  for (const [field, values] of Object.entries(choices)) if (record[field] !== undefined && !values.includes(record[field] as string)) invalid(`detail.${field}`);
  if (record.resourceId !== undefined) textValue(record.resourceId, "detail.resourceId");
  for (const [field, maximum] of [["page", 1_000_000], ["pageSize", 100]] as const) {
    if (record[field] !== undefined && (!Number.isSafeInteger(record[field]) || Number(record[field]) < 1 || Number(record[field]) > maximum)) invalid(`detail.${field}`);
  }
  if (record.view === "resource" && !record.resourceId) invalid("detail.resourceId");
  if (record.view === "resource" && record.dimension === "model") invalid("detail.dimension");
  return record as unknown as OverviewDetailQuery;
}

export function weeklyReviewDetailQuery(raw: unknown): WeeklyReviewDetailQuery {
  const encoded = textValue(raw, "detail", true)!;
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { invalid("detail"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("detail");
  const record = value as Record<string, unknown>;
  const kinds = ["sessions", "rounds", "cache", "compressions", "projects", "delegation", "tools", "agents", "models", "reasoning", "prompts", "activity", "uncompressed"];
  const allowed = new Set(["kind", "sort", "key", "filter", "page", "pageSize"]);
  for (const field of Object.keys(record)) if (!allowed.has(field)) invalid(`detail.${field}`);
  if (!kinds.includes(record.kind as string)) invalid("detail.kind");
  if (record.sort !== undefined && !["recent", "duration", "tokens", "steps", "fresh"].includes(record.sort as string)) invalid("detail.sort");
  if (record.key !== undefined) {
    if (!["agents", "models", "reasoning", "projects", "tools", "compressions"].includes(record.kind as string)) invalid("detail.key");
    textValue(record.key, "detail.key", true);
  }
  if (record.filter !== undefined && !(record.kind === "cache" ? ["zero", "partial", "full", "unknown"]
    : record.kind === "rounds" ? ["ended", "explicit", "inferred", "unconfirmed"] : []).includes(record.filter as string)) invalid("detail.filter");
  for (const [field, maximum] of [["page", 1_000_000], ["pageSize", 100]] as const) {
    if (record[field] !== undefined && (!Number.isSafeInteger(record[field]) || Number(record[field]) < 1 || Number(record[field]) > maximum)) invalid(`detail.${field}`);
  }
  return record as unknown as WeeklyReviewDetailQuery;
}
