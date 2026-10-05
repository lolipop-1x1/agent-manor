import type { MessageKind, SessionMessage, SessionQuery, SessionSearchHit, SessionUsage } from "../src/session-contracts";
import type { PanelSemantics, PanelSide } from "./workspace-layout";

export const PAGE_SIZE = 40;
export const TURN_PAGE_SIZE = 10;
export type EvidenceTarget = { toolName?: string; resourceKind?: "mcp" | "skill_call" | "skill_read"; resourceName?: string; resourceServer?: string };

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

export function turnTitle(id: string, position: number): string {
  const match = /:turn:(\d+)$/.exec(id);
  if (match) return Number(match[1]) === 0 ? "初始上下文" : `第 ${Number(match[1])} 轮`;
  return id === "unknown" ? "轮次未记录" : `本页第 ${position} 组`;
}

const processKinds: MessageKind[] = ["thinking", "tool_call", "tool_result", "system", "compression"];

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
  toolName?: string;
  resourceKind?: string;
  resourceName?: string;
  resourceServer?: string;
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
    pageUnit: query.pageUnit,
    turnPosition: query.turnPosition,
    toolName: query.toolName,
    resourceKind: query.resourceKind,
    resourceName: query.resourceName,
    resourceServer: query.resourceServer,
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

export function displayRecorded(value: number | null | undefined, locale = "zh-CN"): string {
  return value === null || value === undefined ? "未记录" : value.toLocaleString(locale);
}

export function localDateBoundary(value: string, end = false): string | undefined {
  if (!value) return undefined;
  return new Date(`${value}T${end ? "23:59:59.999" : "00:00:00"}`).toISOString();
}

export function workspaceSessionSemantics(): PanelSemantics {
  return {
    sidebar: { label: "调整会话列表宽度", controls: "session-list-content" },
    details: { label: "调整会话画像宽度", controls: "session-profile-content" },
  } satisfies Record<PanelSide, { label: string; controls: string }>;
}
