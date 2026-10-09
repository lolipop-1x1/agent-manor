import type { SessionMessage, SessionProfile } from "../src/session-contracts";
import { summarizeRequestSpeed, type RequestSpeedSummary } from "../src/session-speed";
import { formatNumber, type Language } from "../src/i18n";

export type SpeedStep = SessionProfile["steps"][number] & { branchIds?: string[]; currentBranch?: boolean };
export interface SessionSpeedMap {
  byMessage: Map<string, SpeedStep>;
  byTurn: Map<string, RequestSpeedSummary>;
  summary: RequestSpeedSummary;
  scopeUnknown: boolean;
}

/** 分支范围只采用索引成员关系；简易对话未返回的过程消息仍参与本轮汇总。 */
export function sessionSpeedMap(steps: readonly SpeedStep[], sessionId: string, branch = "all", hasBranches = false): SessionSpeedMap {
  const own = steps.filter(step => step.sessionId === sessionId);
  const scoped = own.filter(step => !hasBranches || branch === "all" || (branch === "current" ? step.currentBranch === true : step.branchIds?.includes(branch)));
  const scopeUnknown = hasBranches && branch !== "all" && own.some(step => step.currentBranch === undefined && !step.branchIds?.length);
  const candidates = new Map<string, Map<string, SpeedStep>>();
  const turnRequests = new Map<string, SpeedStep[]>();
  for (const step of scoped) {
    for (const id of new Set([step.messageId, ...(step.requestMessageIds ?? [])].filter((id): id is string => !!id))) {
      const values = candidates.get(id) ?? new Map<string, SpeedStep>();
      values.set(step.id, step); candidates.set(id, values);
    }
    if (step.turnId) {
      const values = turnRequests.get(step.turnId) ?? [];
      values.push(step); turnRequests.set(step.turnId, values);
    }
  }
  return {
    byMessage: new Map([...candidates].filter(([, values]) => values.size === 1).map(([id, values]) => [id, [...values.values()][0]!])),
    byTurn: new Map([...turnRequests].map(([id, usages]) => [id, summarizeRequestSpeed(usages)])),
    summary: summarizeRequestSpeed(scoped), scopeUnknown,
  };
}

/** 工具执行与工具结果不显示模型速度；原用量标记的定位语义保持独立。 */
export function messageSpeedRequest(message: SessionMessage, mapping: SessionSpeedMap): SpeedStep | undefined {
  if (message.copied || ["user", "tool_call", "tool_result", "context", "compression"].includes(message.kind)) return undefined;
  const step = mapping.byMessage.get(message.id);
  return step && (["assistant", "thinking"].includes(message.kind) || step.messageId === message.id) ? step : undefined;
}

export function requestLocation(step: SpeedStep): string | undefined {
  return step.messageId ?? step.requestMessageIds?.[0] ?? step.timing?.end?.messageId;
}

export function formatRequestSpeed(value: number, language: Language): string {
  return formatNumber(language, value, { maximumFractionDigits: value < 1 ? 1 : 0, minimumFractionDigits: value < 1 ? 1 : 0 });
}
