import { sessionSummaryResponse } from "./summary-response.js";
import type { SessionSummary } from "../session-contracts.js";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(object) : [];
const pick = (value: unknown, keys: readonly string[]): Row => {
  const row = object(value);
  return Object.fromEntries(keys.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
};

export function scenarioResponsePath(path: string): boolean {
  return ["/usage", "/usage/pricing/refresh", "/preferences", "/resources/map"].includes(path)
    || /^\/sessions\/[^/]+\/turns$/.test(path)
    || /^\/knowledge\/extractions\/(preview|previews\/[^/]+)$/.test(path)
    || /^\/repositories\/[^/]+\/(coverage|unobserved|hotspots|events|file|replay)$/.test(path)
    || /^\/resources\/(usage|local)\/[^/]+$/.test(path);
}

/** 列表只提供活动身份；原始调用与源码片段由同版本 evidence 回读。 */
function eventSummary(value: unknown): Row {
  const row = object(value);
  return { ...pick(row, ["id", "client", "sessionId", "parentSessionId", "occurredAt", "tool", "kind", "status", "cwd", "path", "reason", "reasonDescriptor", "mapping"]),
    sourceCount: row.sourceCount ?? rows(row.sources).length };
}

function previewSummary(value: Row): Row {
  const scope = object(value.scope);
  const { sessionIds, ...scopeFields } = scope;
  const targets = rows(value.targets);
  const targetCount = value.targetCount ?? targets.length;
  return { ...pick(value, ["id", "createdAt", "fingerprint", "sessionCount", "turnCount", "estimatedTokens", "contextTokens", "skippedMessages", "pendingMessages", "estimatedCost",
    "plannedChunks", "estimatedOutputTokens", "sourceBytes", "textBytes", "omittedMedia", "limitations", "limitationDetails"]),
    scope: { ...scopeFields, ...(Array.isArray(sessionIds) ? { selectedSessionCount: sessionIds.length } : {}) }, targetCount,
    targetsTruncated: value.targetsTruncated === true || targets.length > 20,
    targets: targets.slice(0, 20).map(target => ({ ...pick(target, ["sessionId", "title", "client", "project", "updatedAt", "version", "branch", "turnCount", "inputTokens", "contextTokens", "plannedChunks"]),
      messageCount: target.messageCount ?? (Array.isArray(target.messageIds) ? target.messageIds.length : 0) })) };
}

/** 场景投影不更改原对象，HTTP 与旧后台兼容路径重复调用保持相同结果。 */
export function scenarioResponse(path: string, method: string, value: unknown, body?: unknown): unknown {
  const result = object(value);
  if (path === "/preferences") return method === "PUT" ? { saved: true, ...pick(result, Object.keys(object(body))) } : value;
  if (path === "/usage") {
    const { days: _days, facets: _facets, ...report } = result;
    return { ...report, ...(Array.isArray(result.sessions) ? { sessions: rows(result.sessions).map(row => {
      const { requests: _requests, ...summary } = row;
      return { ...summary, ...(row.session ? { session: sessionSummaryResponse(row.session as SessionSummary) } : {}) };
    }) } : {}) };
  }
  if (path === "/usage/pricing/refresh") {
    const configuration = object(result.configuration);
    return { ...pick(result, ["version", "fetchedAt", "lastAttemptAt", "source", "refreshing", "error", "errorDescriptor", "currency", "sourceUrl", "history", "priceCount", "historicalPriceCount"]),
      overrideCount: result.overrideCount ?? rows(configuration.overrides).length, mappingCount: result.mappingCount ?? rows(configuration.mappings).length };
  }
  if (/^\/knowledge\/extractions\/(preview|previews\/[^/]+)$/.test(path)) return previewSummary(result);
  if (/^\/sessions\/[^/]+\/turns$/.test(path)) return { ...result, turns: rows(result.turns).map(turn => {
    const question = Array.from(typeof turn.question === "string" ? turn.question : "");
    return { ...pick(turn, ["id", "position"]), question: question.slice(0, 240).join(""),
      ...(turn.questionTruncated || question.length > 240 ? { questionTruncated: true } : {}) };
  }) };
  if (path.startsWith("/repositories/")) {
    const resultFields: Row = { ...result, ...(result.repository ? { repository: pick(result.repository, ["id", "name", "path", "version", "stale"]) } : {}) };
    if (/\/(events|file)$/.test(path)) return { ...resultFields, events: rows(result.events).map(eventSummary) };
    if (/\/(coverage|unobserved|hotspots)$/.test(path)) {
      const { gaps: _gaps, ...coverage } = resultFields;
      return { ...coverage, gapCount: result.gapCount ?? rows(result.gaps).length,
        files: rows(result.files).map(file => pick(file, ["path", "category", "lineCount", "readExactLines", "readNearLines", "editExactLines", "editNearLines",
          "readCount", "editCount", "activityCount", "searchCount", "failedCount", "unknownCount", "readExactRanges", "readNearRanges", "editExactRanges", "editNearRanges"])) };
    }
    return resultFields;
  }
  if (path === "/resources/map") {
    const coverage = object(result.coverage);
    const { gaps: _gaps, ...coverageFields } = coverage;
    const gapCount = coverage.gapCount ?? (Array.isArray(coverage.gaps) ? coverage.gaps.length : undefined);
    const nodes = (value: unknown) => rows(value).map(row => pick(row, ["id", "name", "nameDescriptor", "value", "share", "lastUsedAt", "missingTimeEvents", "clients", "favorite", "protected", "observation", "partial", "usageUnassociated", "localSummary"]));
    return { ...result, positive: nodes(result.positive), zero: nodes(result.zero), review: nodes(result.review),
      ...(result.coverage ? { coverage: { ...coverageFields, ...(gapCount === undefined ? {} : { gapCount }) } } : {}) };
  }
  if (/^\/resources\/usage\/[^/]+$/.test(path)) {
    const { favoriteIds: _favoriteIds, ...detail } = result;
    return detail;
  }
  if (/^\/resources\/local\/[^/]+$/.test(path) && result.inventory) {
    const inventory = object(result.inventory);
    const sourceIds = new Set(rows(object(result.row).entries).map(entry => entry.sourceId));
    return { ...result, inventory: { ...inventory, gaps: rows(inventory.gaps).filter(gap => !gap.sourceId || sourceIds.has(gap.sourceId)) } };
  }
  return value;
}
