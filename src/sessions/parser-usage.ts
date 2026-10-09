import type { MessageDescriptor } from "../i18n/types.js";
import { createHash } from "node:crypto";
import type { SessionRequestTiming, SessionSink, SessionUsage } from "../session-contracts.js";

export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const string = (value: unknown): string | undefined => typeof value === "string" && value.length ? value : undefined;
export const tokens = (value: unknown): number | undefined => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

/** 用量身份优先来自请求；旧 Codex 记录通过累计进度去重，不能按单次数值去重。 */
export class UsageParser {
  private readonly requests = new Map<string, SessionUsage>();
  private readonly requestKeys = new Map<string, string>();
  private checkpoint?: string;
  private checkpointId?: string;
  private checkpointRequest?: string;
  private generation = 0;
  private cumulativeInput?: number;
  private afterCompression = false;

  constructor(private readonly sessionId: string, private readonly sink: SessionSink,
    private readonly gap: (kind: "ambiguous" | "unsupported_format", message: string, messageDescriptor?: MessageDescriptor) => void) {}

  private publish(key: string, value: SessionUsage): string {
    const previous = this.requests.get(this.requestKeys.get(value.id) ?? key);
    const merged = { ...previous, ...Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) } as SessionUsage;
    merged.turnId = previous?.turnId ?? value.turnId;
    merged.messageId = previous?.messageId ?? value.messageId;
    this.requests.set(key, merged);
    this.requestKeys.set(merged.id, key);
    this.sink.usage(merged);
    return merged.id;
  }

  timing(id: string, timing: SessionRequestTiming, requestMessageIds: string[]): void {
    const key = this.requestKeys.get(id);
    const value = key ? this.requests.get(key) : undefined;
    if (key && value) this.publish(key, { ...value, timing, requestMessageIds });
  }

  missing(requestId: string, context: { messageId?: string; turnId: string; model?: string; occurredAt?: string }): string {
    return this.publish(requestId, { id: `${this.sessionId}:usage:${digest(requestId)}`, ...context });
  }

  compression(): void { this.afterCompression = true; }

  native(client: "claude" | "codeflicker", raw: unknown, requestId: string, context: { messageId?: string; turnId: string; model?: string; occurredAt?: string }, identifyMissing = false): string | undefined {
    const usage = object(raw);
    if (!Object.keys(usage).length) return identifyMissing ? this.missing(requestId, context) : undefined;
    const input = tokens(usage.input_tokens);
    const read = tokens(usage.cache_read_input_tokens);
    const write = tokens(usage.cache_creation_input_tokens);
    // Claude 原生 input_tokens 是非缓存输入；CodeFlicker 已持久化规范化总输入。
    const total = client === "codeflicker" ? input : input !== undefined && read !== undefined && write !== undefined ? input + read + write : undefined;
    if (client === "claude" && input !== undefined && total === undefined) this.gap("unsupported_format", "Claude 输入用量缺少缓存分项，无法确认总输入口径", { key: "diagnostics.sessions.parserUsage.m001" });
    const value: SessionUsage = { id: `${this.sessionId}:usage:${digest(requestId)}`, ...context, inputTokens: total,
      outputTokens: tokens(usage.output_tokens), cachedInputTokens: read, cacheWriteTokens: write,
      reasoningOutputTokens: tokens(usage.reasoning_output_tokens), contextTokens: tokens(usage.context_tokens) };
    if (read !== undefined && total !== undefined && read > total) {
      value.cachedInputTokens = undefined;
      this.gap("ambiguous", "缓存读取超过总输入，未计算该请求的缓存比例", { key: "diagnostics.sessions.parserUsage.m002" });
    }
    return this.publish(requestId, value);
  }

  codex(raw: unknown, cumulative: unknown, requestId: string | undefined,
    context: { messageId?: string; turnId: string; model?: string; occurredAt?: string }): string | undefined {
    const usage = object(raw);
    if (!Object.keys(usage).length) return;
    const total = object(cumulative);
    const cumulativeInput = tokens(total.input_tokens);
    const checkpoint = Object.keys(total).length ? digest(total) : undefined;
    const regressed = cumulativeInput !== undefined && this.cumulativeInput !== undefined && cumulativeInput < this.cumulativeInput;
    // 压缩零快照描述累计状态重置，不是一次输出零 Token 的模型调用。
    if (!requestId && (this.afterCompression || regressed) && cumulativeInput === 0 && tokens(total.output_tokens) === 0
      && tokens(usage.input_tokens) === 0 && tokens(usage.output_tokens) === 0) {
      this.generation += 1;
      this.checkpoint = undefined; this.checkpointId = undefined; this.checkpointRequest = undefined;
      this.cumulativeInput = 0; this.afterCompression = false;
      return;
    }
    this.afterCompression = false;
    if (cumulativeInput !== undefined && this.cumulativeInput !== undefined && cumulativeInput < this.cumulativeInput) this.generation += 1;
    const requestKey = requestId ? `response:${requestId}` : undefined;
    const known = requestKey ? this.requests.get(requestKey) : undefined;
    const sameCheckpoint = checkpoint !== undefined && checkpoint === this.checkpoint;
    if (!requestKey && sameCheckpoint) return this.checkpointId;
    if (!requestKey && !checkpoint) {
      this.gap("ambiguous", "Codex 单次用量缺少请求身份及累计进度，未纳入请求统计", { key: "diagnostics.sessions.parserUsage.m003" });
      return;
    }
    if (sameCheckpoint && requestKey && this.checkpointRequest && this.checkpointRequest !== requestKey) {
      this.gap("ambiguous", "不同 Codex 请求记录相同累计进度，按明确请求身份分别保留", { key: "diagnostics.sessions.parserUsage.m004" });
    }
    const id = known?.id ?? (sameCheckpoint && !this.checkpointRequest ? this.checkpointId : undefined)
      ?? `${this.sessionId}:usage:${requestKey ? digest(requestKey) : `${this.generation}:${checkpoint}`}`;
    const input = tokens(usage.input_tokens);
    const value: SessionUsage = { id, ...context, inputTokens: input, outputTokens: tokens(usage.output_tokens),
      cachedInputTokens: tokens(usage.cached_input_tokens), cacheWriteTokens: tokens(usage.cache_write_input_tokens),
      reasoningOutputTokens: tokens(usage.reasoning_output_tokens), contextTokens: tokens(usage.context_tokens) };
    if (input !== undefined && value.cachedInputTokens !== undefined && value.cachedInputTokens > input) {
      value.cachedInputTokens = undefined;
      this.gap("ambiguous", "缓存读取超过总输入，未计算该请求的缓存比例", { key: "diagnostics.sessions.parserUsage.m002" });
    }
    this.publish(requestKey ?? `checkpoint:${this.generation}:${checkpoint}`, value);
    if (checkpoint) { this.checkpoint = checkpoint; this.checkpointId = id; this.checkpointRequest = requestKey; this.cumulativeInput = cumulativeInput; }
    return id;
  }
}
