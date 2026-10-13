import type { SessionMessage, SessionRequestBoundary, SessionRequestTiming } from "../session-contracts.js";
import type { UsageParser } from "./parser-usage.js";

type TimingClient = "codex" | "claude" | "codeflicker";
interface RequestGroup {
  key: string;
  first: SessionMessage;
  timing: SessionRequestTiming;
  messages: Set<string>;
  calls: Set<string>;
  usageId?: string;
  finalOutput?: boolean;
  identified?: boolean;
  endedBeforeUsage?: boolean;
}
const boundary = (message: SessionMessage): SessionRequestBoundary => ({ occurredAt: message.occurredAt,
  recordLine: message.recordLine, messageId: message.id });
const complete = (group: RequestGroup) => ["explicit", "inferred"].includes(group.timing.completion);

/** 按原生请求身份和事件组保存依据；不使用同轮或最近用量为消息补配请求。 */
export class RequestTimingParser {
  private readonly groups = new Map<string, RequestGroup>();
  private readonly usageRecords = new Set<string>();
  private readonly byMessage = new Map<string, RequestGroup>();
  private readonly byCall = new Map<string, RequestGroup>();
  private readonly nativeAliases = new Map<string, string>();
  private readonly boundaryMessages = new Set<string>();
  private active?: RequestGroup;
  private nativeKey?: string;
  private nativeIdentified = false;
  private latestBoundary?: SessionRequestBoundary;
  private endedWithoutUsage?: RequestGroup;
  private latestGroup?: RequestGroup;

  constructor(private readonly client: TimingClient, private readonly usage: UsageParser) {}

  private create(key: string, first: SessionMessage): RequestGroup {
    const group: RequestGroup = { key, first, messages: new Set(), calls: new Set(),
      identified: this.client === "codex" || this.nativeIdentified,
      timing: { basis: "estimated", method: this.client === "codex" ? "codex_event_boundary"
        : this.client === "claude" ? "claude_message_boundary" : "codeflicker_message_boundary", completion: "unknown",
      start: this.latestBoundary, end: boundary(first) } };
    this.groups.set(key, group);
    return group;
  }

  private close(group: RequestGroup): void {
    if (!group.usageId) this.endedWithoutUsage = group;
    if (this.active === group) this.active = undefined;
  }

  context(point: SessionRequestBoundary): void {
    if (!this.active) this.latestBoundary = point;
  }

  compression(point: SessionRequestBoundary): void {
    if (this.active) this.close(this.active);
    this.nativeKey = undefined;
    this.latestBoundary = point;
    this.endedWithoutUsage = undefined;
    this.latestGroup = undefined;
  }

  nativeRequest(key: string, alias: string, identified: boolean): void {
    this.nativeKey = `native:${key}`;
    this.nativeIdentified = identified;
    if (this.nativeAliases.has(alias)) return;
    this.nativeAliases.set(alias, this.nativeKey);
    this.nativeAliases.set(key, this.nativeKey);
    if (this.active && this.active.key !== this.nativeKey) {
      const previous = this.active;
      this.close(previous);
      this.latestBoundary = previous.timing.end;
    }
  }

  ignoreNative(): void { this.nativeKey = undefined; }

  interruptedMessage(id: string): boolean { return this.byMessage.get(id)?.timing.completion === "partial"; }

  message(message: SessionMessage): void {
    if (message.copied) return;
    if (["assistant", "thinking", "tool_call"].includes(message.kind)) {
      const known = this.byMessage.get(message.id);
      if (known) return;
      const key = this.client === "codex" ? this.active?.key ?? `model:${message.id}` : this.nativeKey;
      if (!key) return;
      const group = this.groups.get(key) ?? this.create(key, message);
      this.active = group;
      this.latestGroup = group;
      this.byMessage.set(message.id, group);
      if (message.kind !== "tool_call") group.messages.add(message.id);
      if (message.kind === "tool_call" && message.callId) {
        group.calls.add(message.callId); this.byCall.set(message.callId, group);
      }
      group.finalOutput ||= message.final === "explicit";
      group.timing.end = boundary(message);
      return;
    }
    if (message.kind === "compression") { this.compression(boundary(message)); return; }
    if (!["user", "context", "tool_result"].includes(message.kind)) return;
    if (this.boundaryMessages.has(message.id)) return;
    this.boundaryMessages.add(message.id);
    if (message.kind === "tool_result" && message.callId) {
      const group = this.byCall.get(message.callId);
      if (group && group.timing.completion !== "partial") {
        // 配对工具结果证明该工具请求已提交；模型区间止于工具请求，排除执行等待。
        if (!complete(group)) { group.timing.completion = "inferred"; group.timing.completionEvidence = "tool_result"; }
        group.endedBeforeUsage = true;
        this.close(group);
      }
    } else if (this.active) this.close(this.active);
    this.nativeKey = undefined;
    this.latestBoundary = boundary(message);
    if (message.kind === "user") { this.endedWithoutUsage = undefined; this.latestGroup = undefined; }
  }

  codexUsage(id: string | undefined, point: SessionRequestBoundary): void {
    if (!id || this.usageRecords.has(id)) return;
    this.usageRecords.add(id);
    const group = this.active ?? this.endedWithoutUsage;
    // 没有助手事件组时仍保留原请求用量，但不猜测正文关联与完成状态。
    if (!group || group.usageId) return;
    group.usageId = id;
    if (!group.endedBeforeUsage && point.occurredAt) group.timing.end = point;
    if (group.timing.completion !== "partial" && !complete(group)) {
      if (group.calls.size) {
        group.timing.completion = "inferred"; group.timing.completionEvidence = "tool_response_snapshot";
      } else if (group.finalOutput) {
        group.timing.completion = "inferred"; group.timing.completionEvidence = "final_response_snapshot";
      }
    }
    this.close(group);
    if (this.endedWithoutUsage === group) this.endedWithoutUsage = undefined;
    if (!group.endedBeforeUsage) this.latestBoundary = point;
  }

  nativeUsage(id: string | undefined, stopReason: string | undefined, persisted: boolean, partial: boolean, point: SessionRequestBoundary): void {
    const group = this.nativeKey ? this.groups.get(this.nativeKey) : undefined;
    if (!group) return;
    if (!group.endedBeforeUsage && point.occurredAt && (!group.timing.end?.occurredAt
      || Date.parse(point.occurredAt) >= Date.parse(group.timing.end.occurredAt))) group.timing.end = point;
    if (id) group.usageId = id;
    if (partial) {
      group.timing.completion = "partial"; group.timing.completionEvidence = "request_interrupted";
    } else if (group.timing.completion !== "partial") {
      if (["end_turn", "stop_sequence", "tool_use", "max_tokens", "pause_turn", "refusal", "model_context_window_exceeded"].includes(stopReason ?? "")) {
        group.timing.completion = "explicit"; group.timing.completionEvidence = "stop_reason";
      } else if (persisted) {
        // CLI 成功流式结果在原生助手记录中一次提交；缺少成功写入身份时保留未知。
        group.timing.completion = "inferred"; group.timing.completionEvidence = "persisted_stream_result";
      }
    }
  }

  codexRequestGroup(): string | undefined { return (this.active ?? this.latestGroup ?? this.endedWithoutUsage)?.key; }

  codexReasoningSetting(): { reasoningEffort?: string } | undefined {
    const group = this.active ?? this.latestGroup ?? this.endedWithoutUsage;
    if (group && !this.active && (this.latestBoundary?.recordLine ?? 0) > (group.timing.end?.recordLine ?? 0)) return undefined;
    return group ? { reasoningEffort: group.first.reasoningEffort } : undefined;
  }

  interrupt(alias?: string, force = false): string[] | undefined {
    const key = alias ? this.nativeAliases.get(alias) : undefined;
    const group = alias ? key ? this.groups.get(key) : undefined : this.active ?? this.latestGroup;
    if (!group || (!alias && !force && complete(group))) return;
    group.timing.completion = "partial"; group.timing.completionEvidence = "request_interrupted";
    this.close(group);
    this.nativeKey = undefined;
    this.latestBoundary = undefined;
    return [...group.messages];
  }

  finish(): void {
    for (const group of this.groups.values()) {
      let id = group.usageId;
      if (!id && group.identified) id = this.usage.missing(group.key, { turnId: group.first.turnId,
        model: group.first.model, reasoningEffort: group.first.reasoningEffort, occurredAt: group.timing.end?.occurredAt });
      if (!id) continue;
      const start = group.timing.start?.occurredAt;
      const end = group.timing.end?.occurredAt;
      const elapsed = start && end ? Date.parse(end) - Date.parse(start) : NaN;
      if (Number.isFinite(elapsed)) group.timing.durationMs = elapsed;
      this.usage.timing(id, group.timing, [...group.messages]);
    }
  }
}
