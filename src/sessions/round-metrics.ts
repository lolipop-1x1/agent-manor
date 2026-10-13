import type { Gap } from "../contracts.js";
import type { SessionMessage, SessionRoundMetrics, SessionUsage } from "../session-contracts.js";

type RoundMessage = Omit<SessionMessage, "text" | "sessionId"> & { text?: string };
type RoundRequest = Pick<SessionUsage, "id"> & Partial<Omit<SessionUsage, "id">>;
export interface RoundFact {
  turnId: string;
  start: RoundMessage;
  end?: RoundMessage;
  completion: "explicit" | "inferred" | "unconfirmed";
  eligible: boolean;
  steps: number | null;
  toolCalls: number;
  tokens: number | null;
  durationMs: number | null;
}

export function promptCharacterCount(text: string): number {
  let count = 0;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 128 ? code !== 32 && (code < 9 || code > 13) : !/\s/u.test(character)) count += 1;
  }
  return count;
}
export const isRoundActivityEvent = (message: Pick<SessionMessage, "kind" | "copied" | "contextSource" | "resource">) => !message.copied && !message.contextSource
  && !["system", "context"].includes(message.kind) && !(message.kind === "user" && message.resource?.kind === "skill_read");
const incompleteSource = new Set(["source_missing", "source_unavailable", "unsupported_format", "parse_error", "incomplete_record", "budget_exceeded"]);
const nonBoundaryGaps = new Set(["diagnostics.sessions.parser.m012", "diagnostics.sessions.parser.m013", "diagnostics.sessions.parser.m014", "diagnostics.sessions.parser.m015",
  "diagnostics.history.adapters.qoder.m004", "diagnostics.history.adapters.codebuddy.resourceCoverage",
  "diagnostics.history.adapters.opencode.m002", "diagnostics.history.adapters.opencode.m003", "diagnostics.history.adapters.zcode.m007"]);
const auxiliaryEvents = new Map([
  ["diagnostics.history.adapters.dsh.m016", new Set(["permission/preset", "sandbox/mode", "approval/policy", "agent/inbox/spliced", "session/title", "session/title-llm-request", "todo/write", "subagent/catalog", "goal/change"])],
  ["diagnostics.history.adapters.opencode.m006", new Set(["step-start", "patch"])],
  ["diagnostics.history.adapters.zcode.m004", new Set(["step-start", "step-finish", "patch"])],
  ["diagnostics.history.adapters.codebuddy.m006", new Set(["summary"])],
]);
export function completeRoundSource(gaps: Gap[]): boolean {
  return !gaps.some(gap => {
    const key = gap.messageDescriptor?.key ?? "";
    // 正文、分项与已知辅助事件缺口不影响请求身份；未知事件继续保守处理。
    const auxiliary = auxiliaryEvents.get(key)?.has(String(gap.messageDescriptor?.params?.p0 ?? ""));
    return incompleteSource.has(gap.kind) && !nonBoundaryGaps.has(key) && !auxiliary
      || ["diagnostics.sessions.parserUsage.m003", "diagnostics.sessions.parser.m019"].includes(key);
  });
}
const token = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value >= 0;

/** 画像与周复盘共用需求、请求关联及结束资格，未知状态不能替代完成证据。 */
export function deriveRoundFacts(messages: Iterable<RoundMessage>, requests: Iterable<RoundRequest>, complete = true): { rounds: RoundFact[]; unassigned: number } {
  const starts = new Map<string, RoundMessage>(), ends = new Map<string, RoundMessage>();
  const identities = new Map<string, string>(), interruptions = new Map<string, number>(), tools = new Map<string, { count: number; last: number }>();
  for (const message of messages) {
    if (message.copied || !message.turnId) continue;
    identities.set(message.id, message.turnId);
    if (message.interrupted) interruptions.set(message.turnId, Math.max(interruptions.get(message.turnId) ?? -1, message.ordinal));
    if (!isRoundActivityEvent(message)) continue;
    if (message.kind === "user" && (!starts.has(message.turnId) || message.ordinal < starts.get(message.turnId)!.ordinal)) starts.set(message.turnId, message);
    if (message.kind === "assistant" && message.final && (!ends.has(message.turnId) || message.ordinal > ends.get(message.turnId)!.ordinal)) ends.set(message.turnId, message);
    if (message.kind === "tool_call") {
      const value = tools.get(message.turnId) ?? { count: 0, last: -1 };
      value.count += 1; value.last = Math.max(value.last, message.ordinal); tools.set(message.turnId, value);
    }
  }
  const grouped = new Map<string, RoundRequest[]>(), seen = new Set<string>();
  let unassigned = 0;
  for (const request of requests) {
    if (seen.has(request.id)) continue;
    seen.add(request.id);
    const endId = request.timing?.end?.source === "mirror" ? undefined : request.timing?.end?.messageId;
    const associated = new Set([request.messageId, ...(request.requestMessageIds ?? []), endId].flatMap(id => id && identities.has(id) ? [identities.get(id)!] : []));
    const turnId = request.turnId ?? (associated.size === 1 ? [...associated][0] : undefined);
    if (!turnId || !starts.has(turnId)) { unassigned += 1; continue; }
    const values = grouped.get(turnId) ?? []; values.push(request); grouped.set(turnId, values);
  }
  const rounds = [...starts].map(([turnId, start]): RoundFact => {
    const candidate = ends.get(turnId), values = grouped.get(turnId) ?? [], calls = tools.get(turnId);
    const end = candidate && candidate.ordinal >= start.ordinal ? candidate : undefined;
    const matching = end ? values.filter(request => request.messageId === end.id || request.requestMessageIds?.includes(end.id)
      || request.timing?.end?.source !== "mirror" && request.timing?.end?.messageId === end.id) : [];
    const partial = matching.some(request => request.timing?.completion === "partial");
    const invalidated = Boolean(end && ((interruptions.get(turnId) ?? -1) >= end.ordinal || (calls?.last ?? -1) > end.ordinal || partial));
    const completion = end && !invalidated ? end.final! : "unconfirmed";
    const eligible = completion === "explicit" || completion === "inferred" && end?.finalEvidence !== undefined;
    // 原生完成时间优先；消息创建时间不应截短流式响应耗时。
    const completionTimes = [end?.finalAt, end?.occurredAt, ...matching.map(request => request.timing?.end?.occurredAt)].filter((value): value is string => value !== undefined && Number.isFinite(Date.parse(value)));
    const endedAt = end?.finalAt ?? completionTimes.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? end?.occurredAt;
    const resolvedEnd = end ? { ...end, occurredAt: endedAt } : undefined;
    const startTime = Date.parse(start.occurredAt ?? ""), endTime = Date.parse(endedAt ?? "");
    return { turnId, start, end: resolvedEnd, completion, eligible, steps: complete && values.length ? values.length : null, toolCalls: calls?.count ?? 0,
      tokens: complete && values.length && values.every(request => token(request.inputTokens) && token(request.outputTokens))
        ? values.reduce((sum, request) => sum + request.inputTokens! + request.outputTokens!, 0) : null,
      durationMs: Number.isFinite(startTime) && Number.isFinite(endTime) && endTime >= startTime ? endTime - startTime : null };
  });
  return { rounds, unassigned };
}

/** 合并同一次输入的文本块，保留来源中无法可靠拆分的混合正文。 */
export function summarizeRoundMetrics(messages: Iterable<RoundMessage>, requests: Iterable<RoundRequest>, complete = true): SessionRoundMetrics {
  const rows = [...messages], { rounds } = deriveRoundFacts(rows, requests, complete), prompts = new Map<string, number>();
  for (const message of rows) if (isRoundActivityEvent(message) && message.kind === "user" && message.turnId && message.text !== undefined) {
    const key = JSON.stringify([message.turnId, message.recordLine]);
    prompts.set(key, (prompts.get(key) ?? 0) + promptCharacterCount(message.text));
  }
  const eligible = rounds.filter(round => round.eligible), steps = eligible.filter(round => round.steps !== null), timed = eligible.filter(round => round.durationMs !== null);
  const inferred = eligible.filter(round => round.completion === "inferred").length;
  const inferredSteps = steps.filter(round => round.completion === "inferred").length, inferredTimed = timed.filter(round => round.completion === "inferred").length;
  return { userTurns: rounds.length, completedTurns: eligible.length, stepTurns: steps.length, timedTurns: timed.length, promptInputs: prompts.size,
    ...(inferred ? { inferredTurns: inferred } : {}), ...(inferredSteps ? { inferredStepTurns: inferredSteps } : {}), ...(inferredTimed ? { inferredTimedTurns: inferredTimed } : {}),
    averageSteps: steps.length ? steps.reduce((sum, round) => sum + round.steps!, 0) / steps.length : null,
    averageDurationMs: timed.length ? timed.reduce((sum, round) => sum + round.durationMs!, 0) / timed.length : null,
    averagePromptCharacters: prompts.size ? [...prompts.values()].reduce((sum, count) => sum + count, 0) / prompts.size : null };
}
