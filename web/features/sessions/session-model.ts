import type { MessageKind, SessionMessage, SessionQuery, SessionSearchHit, SessionSummary, SessionUsage } from "../../../src/session-contracts";
import type { PanelSemantics, PanelSide } from "../../shared/layout/workspace-layout";
import { isQuietEntry } from "../../../src/session-execution";
import { formatNumber, translate, translateMessageOrOriginal, type Language } from "../../../src/i18n";
import { getLanguage } from "../../shared/i18n";

export const PAGE_SIZE = 40;
export const TURN_PAGE_SIZE = 10;
export type EvidenceTarget = { toolName?: string; resourceKind?: "mcp" | "skill_call" | "skill_read"; resourceName?: string; resourceServer?: string };

export function executionEntryLabel(client: SessionSummary["client"], entry: NonNullable<SessionSummary["executionEntries"]>[number], language = getLanguage()): string {
  // 仅采用已核查的客户端版本映射；入口标记也可能被原生子会话继承。
  return translate(language, isQuietEntry(client, entry) ? "sessions.execution.quiet" : "sessions.execution.entry", { entrypoint: entry.entrypoint });
}

export function sessionDisplayTitle(session: SessionSummary, language = getLanguage()): string {
  if (session.titleOrigin !== "fallback") return session.title;
  return translate(language, session.relationship === "child" ? "sessions.title.childFallback" : "sessions.title.unnamed", { id: session.clientSessionId.slice(-8) });
}

export function sessionParentTitle(session: SessionSummary, language = getLanguage()): string {
  return translateMessageOrOriginal(language, session.parentTitleDescriptor, session.parentTitle);
}

export function sessionResourceName(resource: NonNullable<SessionMessage["resource"]>, language = getLanguage()): string {
  return translateMessageOrOriginal(language, resource.nameDescriptor, resource.name);
}

export function sessionMessageText(message: SessionMessage, language = getLanguage()): string {
  const descriptor = message.textDescriptor;
  if (descriptor && ["sessions.body.usage", "sessions.body.hook", "sessions.body.attachment"].includes(descriptor.key)) {
    // 稳定标识确定产品标题，原始详情只引用正文第一行之后的内容。
    const separator = message.text.indexOf("\n");
    return translate(language, descriptor.key, { details: separator < 0 ? "" : message.text.slice(separator + 1) });
  }
  return translateMessageOrOriginal(language, descriptor, message.text) || translate(language, "sessions.body.empty");
}

export function usageAxis(value: number): { max: number; ticks: number[] } {
  const target = Math.max(1, value) / 4;
  const power = 10 ** Math.floor(Math.log10(target));
  const fraction = target / power;
  const factor = fraction >= Math.sqrt(50) ? 10 : fraction >= Math.sqrt(10) ? 5 : fraction >= Math.sqrt(2) ? 2 : 1;
  const step = Math.max(1, factor * power);
  const intervals = Math.ceil(Math.max(1, value) / step);
  return { max: intervals * step, ticks: Array.from({ length: intervals + 1 }, (_, index) => index * step) };
}

export function usageSegments(steps: SessionUsage[], key: "inputTokens" | "outputTokens" | "cachedInputTokens", max: number): string[] {
  const segments: string[] = [];
  let points: string[] = [];
  steps.forEach((step, index) => {
    const value = step[key];
    if (value === undefined) { if (points.length) segments.push(points.join(" ")); points = []; return; }
    points.push(`${steps.length <= 1 ? 50 : index / (steps.length - 1) * 100},${100 - value / Math.max(1, max) * 100}`);
  });
  if (points.length) segments.push(points.join(" "));
  return segments;
}

export function usageIndexAt(position: number, count: number): number {
  return Math.round(Math.max(0, Math.min(1, position)) * Math.max(0, count - 1));
}

export function turnTitle(id: string, position: number, language = getLanguage()): string {
  const match = /:turn:(\d+)$/.exec(id);
  if (match) return translate(language, Number(match[1]) === 0 ? "sessions.turn.initial" : "sessions.turn.number", { number: formatNumber(language, Number(match[1])) });
  return translate(language, id === "unknown" ? "sessions.turn.unrecorded" : "sessions.turn.pageGroup", { number: formatNumber(language, position) });
}

const processKinds: MessageKind[] = ["thinking", "tool_call", "tool_result", "system", "context", "compression"];

export function searchKinds(includeProcess: boolean): MessageKind[] {
  return includeProcess ? ["user", "assistant", ...processKinds] : ["user", "assistant"];
}

export function sessionParams(query: Partial<SessionQuery> & {
  mode?: "brief" | "full" | "trace";
  messageId?: string;
  sessionId?: string;
  includeChildren?: boolean;
  pageUnit?: "turn";
  turnPosition?: number;
  branch?: string;
  toolName?: string;
  resourceKind?: string;
  resourceName?: string;
  resourceServer?: string;
  summary?: boolean;
  stepOffset?: number;
  stepLimit?: number;
  maxEvents?: number;
  messageLimit?: number;
  messageOffset?: number;
  maxTextChars?: number;
}): string {
  const params = new URLSearchParams();
  const values: Record<string, string | number | boolean | readonly string[] | undefined> = {
    client: query.client,
    project: query.project,
    from: query.from,
    to: query.to,
    q: query.q,
    kinds: query.kinds,
    page: query.page,
    pageSize: query.pageSize,
    version: query.version,
    mode: query.mode,
    messageId: query.messageId,
    sessionId: query.sessionId,
    includeChildren: query.includeChildren,
    includeSubagents: query.includeSubagents,
    executionMode: query.executionMode,
    pageUnit: query.pageUnit,
    turnPosition: query.turnPosition,
    branch: query.branch,
    toolName: query.toolName,
    resourceKind: query.resourceKind,
    resourceName: query.resourceName,
    resourceServer: query.resourceServer,
    summary: query.summary,
    stepOffset: query.stepOffset,
    stepLimit: query.stepLimit,
    maxEvents: query.maxEvents,
    messageLimit: query.messageLimit,
    messageOffset: query.messageOffset,
    maxTextChars: query.maxTextChars,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export function groupedTurns(messages: SessionMessage[]): { id: string; messages: SessionMessage[] }[] {
  const ordered = messages.map((message, index) => ({ message, index }))
    .sort((a, b) => a.message.ordinal - b.message.ordinal || a.index - b.index)
    .map(item => item.message);
  const turns = new Map<string, SessionMessage[]>();
  for (const message of ordered) {
    const id = message.turnId || "unknown";
    const group = turns.get(id);
    if (group) group.push(message);
    else turns.set(id, [message]);
  }
  return [...turns].map(([id, grouped]) => ({ id, messages: grouped }));
}

export function searchHitMode(hit: SessionSearchHit, current: "brief" | "full" | "trace"): "brief" | "full" | "trace" {
  return hit.messageId ? "trace" : current;
}

export function displayRecorded(value: number | null | undefined, language: Language = getLanguage()): string {
  return value === null || value === undefined ? translate(language, "common.notRecorded") : formatNumber(language, value);
}

export function localDateBoundary(value: string, end = false): string | undefined {
  if (!value) return undefined;
  return new Date(`${value}T${end ? "23:59:59.999" : "00:00:00"}`).toISOString();
}

export function workspaceSessionSemantics(language = getLanguage()): PanelSemantics {
  return {
    sidebar: { label: translate(language, "sessions.layout.listWidth"), controls: "session-list-content" },
    details: { label: translate(language, "sessions.layout.profileWidth"), controls: "session-profile-content" },
  } satisfies Record<PanelSide, { label: string; controls: string }>;
}
