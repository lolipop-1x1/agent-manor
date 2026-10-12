import type { SessionMessage, SessionRoundMetrics, SessionUsage } from "../session-contracts.js";

type RoundMessage = Omit<SessionMessage, "text" | "sessionId"> & { text?: string };

export function promptCharacterCount(text: string): number {
  let count = 0;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 128 ? code !== 32 && (code < 9 || code > 13) : !/\s/u.test(character)) count += 1;
  }
  return count;
}

/** 合并同一次输入的文本块，保留来源中无法可靠拆分的混合正文。 */
export function summarizeRoundMetrics(messages: Iterable<RoundMessage>, requests: Iterable<Pick<SessionUsage, "id" | "turnId">>): SessionRoundMetrics {
  const starts = new Map<string, RoundMessage>();
  const ends = new Map<string, RoundMessage>();
  const prompts = new Map<string, number>();
  for (const message of messages) {
    if (message.copied || !message.turnId || message.contextSource) continue;
    if (message.kind === "user" && message.resource?.kind !== "skill_read") {
      if (!starts.has(message.turnId) || message.ordinal < starts.get(message.turnId)!.ordinal) starts.set(message.turnId, message);
      if (message.text !== undefined) {
        const key = JSON.stringify([message.turnId, message.recordLine]);
        prompts.set(key, (prompts.get(key) ?? 0) + promptCharacterCount(message.text));
      }
    } else if (message.kind === "assistant" && message.final === "explicit"
      && (!ends.has(message.turnId) || message.ordinal > ends.get(message.turnId)!.ordinal)) ends.set(message.turnId, message);
  }
  const steps = new Map<string, number>();
  const seen = new Set<string>();
  for (const request of requests) {
    if (!request.turnId || !starts.has(request.turnId) || seen.has(request.id)) continue;
    seen.add(request.id);
    steps.set(request.turnId, (steps.get(request.turnId) ?? 0) + 1);
  }
  const result: SessionRoundMetrics = { userTurns: starts.size, completedTurns: 0, stepTurns: 0, timedTurns: 0, promptInputs: prompts.size,
    averageSteps: null, averageDurationMs: null, averagePromptCharacters: null };
  let totalSteps = 0;
  let totalDuration = 0;
  for (const [turnId, start] of starts) {
    const end = ends.get(turnId);
    if (!end || end.ordinal < start.ordinal) continue;
    result.completedTurns += 1;
    const count = steps.get(turnId);
    if (count !== undefined) { totalSteps += count; result.stepTurns += 1; }
    const startTime = Date.parse(start.occurredAt ?? "");
    const endTime = Date.parse(end.occurredAt ?? "");
    if (Number.isFinite(startTime) && Number.isFinite(endTime) && endTime >= startTime) {
      totalDuration += endTime - startTime;
      result.timedTurns += 1;
    }
  }
  if (result.stepTurns) result.averageSteps = totalSteps / result.stepTurns;
  if (result.timedTurns) result.averageDurationMs = totalDuration / result.timedTurns;
  if (result.promptInputs) result.averagePromptCharacters = [...prompts.values()].reduce((sum, count) => sum + count, 0) / result.promptInputs;
  return result;
}
