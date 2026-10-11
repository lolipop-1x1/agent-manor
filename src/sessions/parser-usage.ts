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
  private readonly recordedRequests = new Set<string>();
  private checkpoint?: string;
  private checkpointId?: string;
  private checkpointRequest?: string;
  private generation = 0;
  private cumulativeInput?: number;
  private afterCompression = false;
  private projection?: { id: string; requestKey?: string; signature: string; turnId: string; model?: string; requestGroup?: string };

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

  hasRecordedUsage(id: string): boolean { return this.recordedRequests.has(id); }

  missing(requestId: string, context: { messageId?: string; turnId: string; model?: string; occurredAt?: string }): string {
    // 请求存在不代表原始用量记录存在，模型关联由 requestMessageIds 独立承载。
    return this.publish(requestId, { id: `${this.sessionId}:usage:${digest(requestId)}`, ...context, messageId: undefined });
  }

  compression(): void { this.afterCompression = true; this.projection = undefined; }

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
    this.recordedRequests.add(value.id);
    if (read !== undefined && total !== undefined && read > total) {
      value.cachedInputTokens = undefined;
      this.gap("ambiguous", "缓存读取超过总输入，未计算该请求的缓存比例", { key: "diagnostics.sessions.parserUsage.m002" });
    }
    return this.publish(requestId, value);
  }

  codex(raw: unknown, cumulative: unknown, requestId: string | undefined,
    context: { messageId?: string; turnId: string; model?: string; occurredAt?: string; requestGroup?: string }): string | undefined {
    const usage = object(raw);
    if (!Object.keys(usage).length) return;
    const total = object(cumulative);
    const cumulativeInput = tokens(total.input_tokens);
    const checkpoint = Object.keys(total).length ? digest([total.input_tokens, total.cached_input_tokens,
      total.cache_write_input_tokens ?? 0, total.output_tokens, total.reasoning_output_tokens, total.total_tokens]) : undefined;
    const regressed = cumulativeInput !== undefined && this.cumulativeInput !== undefined && cumulativeInput < this.cumulativeInput;
    // 零用量仅报告上下文状态；只有压缩或累计回退时重置旧式进度。
    if (!requestId && (this.afterCompression || (tokens(usage.total_tokens) ?? 0) > 0 || regressed && cumulativeInput === 0 && tokens(total.output_tokens) === 0)
      && tokens(usage.input_tokens) === 0 && tokens(usage.output_tokens) === 0) {
      if (this.afterCompression || regressed) {
        this.generation += 1;
        this.checkpoint = undefined; this.checkpointId = undefined; this.checkpointRequest = undefined;
      }
      this.cumulativeInput = cumulativeInput; this.afterCompression = false;
      return;
    }
    this.afterCompression = false;
    if (!requestId && regressed) this.generation += 1;
    const requestKey = requestId ? `response:${requestId}` : undefined;
    const known = requestKey ? this.requests.get(requestKey) : undefined;
    const signature = digest([usage.input_tokens, usage.cached_input_tokens, usage.cache_write_input_tokens ?? 0,
      usage.output_tokens, usage.reasoning_output_tokens]);
    const previous = this.projection;
    const sameCheckpoint = checkpoint !== undefined && checkpoint === this.checkpoint;
    // 原生响应后的旧式投影按事件组配对；反向关联还须进度一致，避免吞掉明确的新响应身份。
    const mirrored = previous && Boolean(previous.requestKey) !== Boolean(requestKey) && previous.signature === signature
      && previous.turnId === context.turnId && previous.model === context.model && previous.requestGroup === context.requestGroup
      && (!requestKey || sameCheckpoint);
    if (mirrored && !requestKey) {
      this.checkpoint = checkpoint; this.checkpointId = previous.id; this.checkpointRequest = previous.requestKey;
      this.cumulativeInput = cumulativeInput; this.projection = undefined;
      return previous.id;
    }
    if (!requestKey && sameCheckpoint) return this.checkpointId;
    if (!requestKey && !checkpoint) {
      this.gap("ambiguous", "Codex 单次用量缺少请求身份及累计进度，未纳入请求统计", { key: "diagnostics.sessions.parserUsage.m003" });
      return;
    }
    if (sameCheckpoint && requestKey && this.checkpointRequest && this.checkpointRequest !== requestKey) {
      this.gap("ambiguous", "不同 Codex 请求记录相同累计进度，按明确请求身份分别保留", { key: "diagnostics.sessions.parserUsage.m004" });
    }
    const id = known?.id ?? (mirrored ? previous.id : undefined)
      ?? `${this.sessionId}:usage:${requestKey ? digest(requestKey) : `${this.generation}:${checkpoint}`}`;
    const input = tokens(usage.input_tokens);
    const { requestGroup: _requestGroup, ...usageContext } = context;
    const value: SessionUsage = { id, ...usageContext, inputTokens: input, outputTokens: tokens(usage.output_tokens),
      cachedInputTokens: tokens(usage.cached_input_tokens), cacheWriteTokens: tokens(usage.cache_write_input_tokens),
      reasoningOutputTokens: tokens(usage.reasoning_output_tokens), contextTokens: tokens(usage.context_tokens) };
    this.recordedRequests.add(id);
    if (input !== undefined && value.cachedInputTokens !== undefined && value.cachedInputTokens > input) {
      value.cachedInputTokens = undefined;
      this.gap("ambiguous", "缓存读取超过总输入，未计算该请求的缓存比例", { key: "diagnostics.sessions.parserUsage.m002" });
    }
    this.publish(requestKey ?? `checkpoint:${this.generation}:${checkpoint}`, value);
    if (checkpoint) { this.checkpoint = checkpoint; this.checkpointId = id; this.checkpointRequest = requestKey; }
    if (!requestKey) this.cumulativeInput = cumulativeInput;
    this.projection = mirrored ? undefined : { id, requestKey, signature, turnId: context.turnId, model: context.model, requestGroup: context.requestGroup };
    return id;
  }
}
