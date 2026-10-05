import { createHash } from "node:crypto";
import type { SessionSink, SessionUsage } from "../session-contracts.js";

export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const string = (value: unknown): string | undefined => typeof value === "string" && value.length ? value : undefined;
export const tokens = (value: unknown): number | undefined => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

/** 用量身份优先来自请求；旧 Codex 记录通过累计进度去重，不能按单次数值去重。 */
export class UsageParser {
  private readonly requests = new Map<string, SessionUsage>();
  private checkpoint?: string;
  private checkpointId?: string;
  private checkpointRequest?: string;
  private generation = 0;
  private cumulativeInput?: number;

  constructor(private readonly sessionId: string, private readonly sink: SessionSink,
    private readonly gap: (kind: "ambiguous" | "unsupported_format", message: string) => void) {}

  private publish(key: string, value: SessionUsage): void {
    const previous = this.requests.get(key);
    const merged = { ...previous, ...Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) } as SessionUsage;
    this.requests.set(key, merged);
    this.sink.usage(merged);
  }

  native(client: "claude" | "codeflicker", raw: unknown, requestId: string, context: { messageId?: string; turnId: string; model?: string; occurredAt?: string }): void {
    const usage = object(raw);
    if (!Object.keys(usage).length) return;
    const input = tokens(usage.input_tokens);
    const read = tokens(usage.cache_read_input_tokens);
    const write = tokens(usage.cache_creation_input_tokens);
    // Claude 原生 input_tokens 是非缓存输入；CodeFlicker 已持久化规范化总输入。
    const total = client === "codeflicker" ? input : input !== undefined && read !== undefined && write !== undefined ? input + read + write : undefined;
    if (client === "claude" && input !== undefined && total === undefined) this.gap("unsupported_format", "Claude 输入用量缺少缓存分项，无法确认总输入口径");
    const value: SessionUsage = { id: `${this.sessionId}:usage:${digest(requestId)}`, ...context, inputTokens: total,
      outputTokens: tokens(usage.output_tokens), cachedInputTokens: read, cacheWriteTokens: write,
      reasoningOutputTokens: tokens(usage.reasoning_output_tokens), contextTokens: tokens(usage.context_tokens) };
    if (read !== undefined && total !== undefined && read > total) {
      value.cachedInputTokens = undefined;
      this.gap("ambiguous", "缓存读取超过总输入，未计算该请求的缓存比例");
    }
    this.publish(requestId, value);
  }

  codex(raw: unknown, cumulative: unknown, requestId: string | undefined,
    context: { messageId?: string; turnId: string; model?: string; occurredAt?: string }): void {
    const usage = object(raw);
    if (!Object.keys(usage).length) return;
    const total = object(cumulative);
    const cumulativeInput = tokens(total.input_tokens);
    const checkpoint = Object.keys(total).length ? digest(total) : undefined;
    if (cumulativeInput !== undefined && this.cumulativeInput !== undefined && cumulativeInput < this.cumulativeInput) this.generation += 1;
    const requestKey = requestId ? `response:${requestId}` : undefined;
    const known = requestKey ? this.requests.get(requestKey) : undefined;
    const sameCheckpoint = checkpoint !== undefined && checkpoint === this.checkpoint;
    if (!requestKey && sameCheckpoint) return;
    if (!requestKey && !checkpoint) {
      this.gap("ambiguous", "Codex 单次用量缺少请求身份及累计进度，未纳入请求统计");
      return;
    }
    if (sameCheckpoint && requestKey && this.checkpointRequest && this.checkpointRequest !== requestKey) {
      this.gap("ambiguous", "不同 Codex 请求记录相同累计进度，按明确请求身份分别保留");
    }
    const id = known?.id ?? (sameCheckpoint && !this.checkpointRequest ? this.checkpointId : undefined)
      ?? `${this.sessionId}:usage:${requestKey ? digest(requestKey) : `${this.generation}:${checkpoint}`}`;
    const input = tokens(usage.input_tokens);
    const value: SessionUsage = { id, ...context, inputTokens: input, outputTokens: tokens(usage.output_tokens),
      cachedInputTokens: tokens(usage.cached_input_tokens), cacheWriteTokens: tokens(usage.cache_write_input_tokens),
      reasoningOutputTokens: tokens(usage.reasoning_output_tokens), contextTokens: tokens(usage.context_tokens) };
    if (input !== undefined && value.cachedInputTokens !== undefined && value.cachedInputTokens > input) {
      value.cachedInputTokens = undefined;
      this.gap("ambiguous", "缓存读取超过总输入，未计算该请求的缓存比例");
    }
    this.publish(requestKey ?? `checkpoint:${this.generation}:${checkpoint}`, value);
    if (checkpoint) { this.checkpoint = checkpoint; this.checkpointId = id; this.checkpointRequest = requestKey; this.cumulativeInput = cumulativeInput; }
  }
}
