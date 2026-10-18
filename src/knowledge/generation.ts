import { setTimeout as delay } from "node:timers/promises";
import type { KnowledgeConfig, KnowledgeUsage, KnowledgeUsageCounters, KnowledgeUsagePurpose } from "../knowledge-contracts.js";
import type { KnowledgeStore } from "./store.js";
import { KnowledgeModelError, normalizeGenerationUrl } from "./config.js";

export interface ChatMessage { role: "system" | "user"; content: string }
export interface GenerationResult { value: unknown; inputTokens: number; outputTokens: number; actualInputTokens?: number; actualOutputTokens?: number }
interface Ledger { current: KnowledgeUsage; previous: Record<string, KnowledgeUsage>; rate: number[]; knownCost: number; unpricedInput: number; unpricedOutput: number }
/** 无模型 tokenizer 时沿用本地文本粗估；字节上界单独用于窗口保护。 */
export function estimateKnowledgeTokens(text: string): number { return Math.ceil(Buffer.byteLength(text, "utf8") / 3); }
export function textByteBudget(text: string): number { return Buffer.byteLength(text, "utf8"); }
export function requestTokens(messages: readonly ChatMessage[]): number { return messages.reduce((sum, message) => sum + estimateKnowledgeTokens(message.content) + 8, 32); }
export function requestUpperBound(messages: readonly ChatMessage[]): number { return messages.reduce((sum, message) => sum + textByteBudget(message.content) + 16, 64); }
export function fitsRequest(config: KnowledgeConfig, messages: readonly ChatMessage[]): boolean { return requestUpperBound(messages) + config.generation.outputTokens + 256 <= config.generation.contextTokens; }
function today(): string { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function emptyCounters(): KnowledgeUsageCounters { return { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, estimatedInputTokens: 0, estimatedOutputTokens: 0, actualInputTokens: 0, actualOutputTokens: 0, actualRequests: 0 }; }
export function emptyKnowledgeUsage(date = today()): KnowledgeUsage { return { ...emptyCounters(), date, byPurpose: { extract: emptyCounters(), merge: emptyCounters(), try: emptyCounters(), test: emptyCounters() } }; }
function normalizeUsage(usage: KnowledgeUsage): KnowledgeUsage & KnowledgeUsageCounters {
  // 较早记录没有实测依据，迁移为估算，不能倒推为服务端实测用量。
  usage.estimatedInputTokens ??= usage.inputTokens; usage.estimatedOutputTokens ??= usage.outputTokens; usage.actualInputTokens ??= 0; usage.actualOutputTokens ??= 0; usage.actualRequests ??= 0;
  usage.byPurpose ??= { extract: emptyCounters(), merge: emptyCounters(), try: emptyCounters(), test: emptyCounters() };
  return usage as KnowledgeUsage & KnowledgeUsageCounters;
}
function reserveCounters(usage: KnowledgeUsage, purpose: KnowledgeUsagePurpose, inputTokens: number, outputTokens: number, cost: number | null): void {
  const normalized = normalizeUsage(usage);
  for (const target of [normalized, normalized.byPurpose![purpose]]) {
    target.requests++; target.inputTokens += inputTokens; target.outputTokens += outputTokens; target.estimatedInputTokens += inputTokens; target.estimatedOutputTokens += outputTokens;
    target.estimatedCost = target.estimatedCost === null || cost === null ? null : target.estimatedCost + cost;
  }
}
function settleCounters(usage: KnowledgeUsage, purpose: KnowledgeUsagePurpose, reservation: { inputTokens: number; outputTokens: number }, result: GenerationResult, costDifference?: number): void {
  const normalized = normalizeUsage(usage), inputDifference = result.inputTokens - reservation.inputTokens, outputDifference = result.outputTokens - reservation.outputTokens;
  for (const target of [normalized, normalized.byPurpose![purpose]]) {
    target.inputTokens += inputDifference; target.outputTokens += outputDifference;
    target.estimatedInputTokens += result.actualInputTokens === undefined ? inputDifference : -reservation.inputTokens;
    target.estimatedOutputTokens += result.actualOutputTokens === undefined ? outputDifference : -reservation.outputTokens;
    target.actualInputTokens += result.actualInputTokens ?? 0; target.actualOutputTokens += result.actualOutputTokens ?? 0;
    if (result.actualInputTokens !== undefined && result.actualOutputTokens !== undefined) target.actualRequests++;
    if (target.estimatedCost !== null && costDifference !== undefined) target.estimatedCost = Math.max(0, target.estimatedCost + costDifference);
  }
}
function error(code: string, message: string, status = 400, retryAfterMs?: number): KnowledgeModelError { return new KnowledgeModelError(code, message, status, retryAfterMs); }
function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw error("cancelled", "知识模型调用已取消", 499); }
function transient(cause: unknown): cause is KnowledgeModelError { return cause instanceof KnowledgeModelError && ["rate_limited", "timeout", "network", "service"].includes(cause.code); }
async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw error("response_invalid", "模型返回空响应", 502);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 8 * 1024 * 1024) { await reader.cancel(); throw error("response_invalid", "模型响应超过大小限制", 502); } chunks.push(value); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw error("response_invalid", "模型响应不是有效 JSON", 502); }
  } finally { reader.releaseLock(); }
}
async function errorResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let remaining = 4096;
  try {
    while (remaining > 0) { const { done, value } = await reader.read(); if (done) break; chunks.push(value.subarray(0, remaining)); remaining -= value.length; }
    if (remaining <= 0) await reader.cancel(); return Buffer.concat(chunks).toString("utf8");
  } finally { reader.releaseLock(); }
}
function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
export class KnowledgeGenerationScheduler {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly stopping = new AbortController();
  private closed = false;
  constructor(private readonly store: KnowledgeStore) {}
  private ledger(): Ledger {
    const stored = this.store.getState<Ledger>("generation.usage");
    const value: Ledger = stored ?? { current: emptyKnowledgeUsage(), previous: {}, rate: [], knownCost: 0, unpricedInput: 0, unpricedOutput: 0 };
    if (value.current.date !== today()) {
      value.previous[value.current.date] = value.current; const days = Object.keys(value.previous).sort(); for (const day of days.slice(0, -30)) delete value.previous[day];
      value.current = emptyKnowledgeUsage(); value.knownCost = 0; value.unpricedInput = 0; value.unpricedOutput = 0;
    }
    normalizeUsage(value.current);
    value.rate = value.rate.filter(time => Date.now() - time < 60_000); return value;
  }
  usage(): KnowledgeUsage { return structuredClone(this.ledger().current); }
  private reserve(config: KnowledgeConfig, inputTokens: number, purpose: KnowledgeUsagePurpose): { date: string; inputTokens: number; outputTokens: number } {
    return this.store.transaction(() => {
      const ledger = this.ledger(), generation = config.generation, outputTokens = generation.outputTokens;
      const priced = generation.inputPricePerMillion !== undefined && generation.outputPricePerMillion !== undefined;
      const cost = priced ? (inputTokens * generation.inputPricePerMillion! + outputTokens * generation.outputPricePerMillion!) / 1_000_000 : null;
      const used = ledger.knownCost + (priced ? (ledger.unpricedInput * generation.inputPricePerMillion! + ledger.unpricedOutput * generation.outputPricePerMillion!) / 1_000_000 : 0);
      if (generation.dailyBudget !== undefined && (cost === null || used + cost > generation.dailyBudget)) throw error("budget_exceeded", "已达到知识生成的每日预算", 429);
      reserveCounters(ledger.current, purpose, inputTokens, outputTokens, cost);
      if (cost === null) { ledger.unpricedInput += inputTokens; ledger.unpricedOutput += outputTokens; }
      else ledger.knownCost += cost;
      ledger.rate.push(Date.now()); this.store.setState("generation.usage", ledger);
      return { date: ledger.current.date, inputTokens, outputTokens };
    });
  }
  private settle(config: KnowledgeConfig, reservation: { date: string; inputTokens: number; outputTokens: number }, result: GenerationResult, purpose: KnowledgeUsagePurpose): void {
    this.store.transaction(() => {
      const ledger = this.ledger(), usage = ledger.current.date === reservation.date ? ledger.current : ledger.previous[reservation.date]; if (!usage) return;
      const inputDifference = result.inputTokens - reservation.inputTokens, outputDifference = result.outputTokens - reservation.outputTokens;
      const { inputPricePerMillion: input, outputPricePerMillion: output } = config.generation;
      const costDifference = input !== undefined && output !== undefined ? (inputDifference * input + outputDifference * output) / 1_000_000 : undefined;
      settleCounters(usage, purpose, reservation, result, costDifference);
      if (input !== undefined && output !== undefined) {
        const difference = costDifference!;
        if (usage === ledger.current) ledger.knownCost = Math.max(0, ledger.knownCost + difference);
      } else if (usage === ledger.current) { ledger.unpricedInput += inputDifference; ledger.unpricedOutput += outputDifference; }
      this.store.setState("generation.usage", ledger);
    });
  }
  execute(config: KnowledgeConfig, messages: ChatMessage[], apiKey?: string, signal?: AbortSignal, meter?: KnowledgeUsage, purpose: KnowledgeUsagePurpose = "extract"): Promise<GenerationResult> {
    if (this.closed) return Promise.reject(error("stopped", "知识模型调度已停止", 503));
    if (!config.generation.url || !config.generation.model) return Promise.reject(error("connection_required", "请先配置知识生成模型"));
    if (!fitsRequest(config, messages)) return Promise.reject(error("input_too_long", "请求总预算超过模型上下文，请缩小提示词或增加上下文预算"));
    const frozen = structuredClone(config), request = structuredClone(messages);
    const operation = this.queue.then(() => this.run(frozen, request, apiKey, signal, meter, purpose));
    this.queue = operation.catch(() => undefined); return operation;
  }
  private async run(config: KnowledgeConfig, messages: ChatMessage[], apiKey?: string, caller?: AbortSignal, meter?: KnowledgeUsage, purpose: KnowledgeUsagePurpose = "extract"): Promise<GenerationResult> {
    const signal = caller ? AbortSignal.any([caller, this.stopping.signal]) : this.stopping.signal;
    for (let attempt = 0;; attempt++) {
      aborted(signal);
      const rpm = config.generation.requestsPerMinute, rate = this.ledger().rate;
      if (rpm > 0 && rate.length >= rpm) await delay(Math.max(1, rate[rate.length - rpm]! + 60_000 - Date.now()), undefined, { signal }).catch(() => aborted(signal));
      aborted(signal);
      const reservation = this.reserve(config, requestTokens(messages), purpose);
      const inputPrice = config.generation.inputPricePerMillion, outputPrice = config.generation.outputPricePerMillion;
      if (meter) reserveCounters(meter, purpose, reservation.inputTokens, reservation.outputTokens, inputPrice !== undefined && outputPrice !== undefined ? (reservation.inputTokens * inputPrice + reservation.outputTokens * outputPrice) / 1_000_000 : null);
      try {
        const timeout = AbortSignal.timeout(config.generation.timeoutMs), combined = AbortSignal.any([signal, timeout]);
        let response: Response;
        try {
          response = await fetch(normalizeGenerationUrl(config.generation.url), {
            method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, signal: combined,
            body: JSON.stringify({ model: config.generation.model, messages, temperature: 0, max_tokens: config.generation.outputTokens, ...(config.generation.reasoningEffort !== undefined ? { reasoning_effort: config.generation.reasoningEffort } : {}), response_format: { type: "json_object" }, stream: false }),
          });
        } catch (cause) { aborted(signal); if (timeout.aborted) throw error("timeout", "知识模型请求超时", 504); throw error("network", cause instanceof Error ? cause.message : "知识模型网络请求失败", 502); }
        if (!response.ok) {
          let raw: string;
          try { raw = await errorResponse(response); } catch (cause) { aborted(signal); if (timeout.aborted) throw error("timeout", "知识模型响应超时", 504); throw cause; }
          const status = response.status;
          const retryAfter = response.headers.get("retry-after"); let retryAfterMs: number | undefined;
          if (retryAfter) { const seconds = Number(retryAfter); retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter) - Date.now()); }
          throw error(status === 429 ? "rate_limited" : status === 401 || status === 403 ? "auth" : status >= 500 ? "service" : "request_invalid", `模型 HTTP ${status}${raw ? `: ${raw}` : ""}`, status, retryAfterMs);
        }
        let payload: unknown;
        try { payload = await readResponse(response); } catch (cause) { aborted(signal); if (timeout.aborted) throw error("timeout", "知识模型响应超时", 504); throw cause; }
        const body = payload as { choices?: { message?: { content?: unknown }; finish_reason?: string }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
        const choice = body?.choices?.[0], content = choice?.message?.content;
        const result: GenerationResult = { value: undefined, inputTokens: nonnegative(body?.usage?.prompt_tokens) ? body.usage.prompt_tokens : reservation.inputTokens, outputTokens: nonnegative(body?.usage?.completion_tokens) ? body.usage.completion_tokens : typeof content === "string" && content.trim() && choice?.finish_reason !== "length" ? estimateKnowledgeTokens(content) : reservation.outputTokens, actualInputTokens: nonnegative(body?.usage?.prompt_tokens) ? body.usage.prompt_tokens : undefined, actualOutputTokens: nonnegative(body?.usage?.completion_tokens) ? body.usage.completion_tokens : undefined };
        // 返回格式不合格或输出截断仍可能已经收费，用量与候选是否有效分别记录。
        this.settle(config, reservation, result, purpose);
        if (meter) {
          const inputDifference = result.inputTokens - reservation.inputTokens, outputDifference = result.outputTokens - reservation.outputTokens;
          settleCounters(meter, purpose, reservation, result, inputPrice !== undefined && outputPrice !== undefined ? (inputDifference * inputPrice + outputDifference * outputPrice) / 1_000_000 : undefined);
        }
        if (choice?.finish_reason === "length") throw error("output_truncated", "模型输出达到上限，未保存不完整结果", 502);
        if (typeof content !== "string" || !content.trim()) throw error("response_invalid", "模型没有返回结构化内容", 502);
        try { result.value = JSON.parse(content.trim()); } catch { throw error("response_invalid", "模型内容不是有效 JSON", 502); }
        return result;
      } catch (cause) {
        aborted(signal);
        if (!transient(cause) || attempt >= config.generation.retries) throw cause;
        // 失败请求可能已经产生服务端费用，保留预留；退避和重试也逐次计入速率与预算。
        const wait = Math.min(60_000, Math.max(250 * 2 ** attempt, cause.retryAfterMs ?? 0));
        await delay(wait, undefined, { signal }).catch(() => aborted(signal));
      }
    }
  }
  async close(): Promise<void> { this.closed = true; this.stopping.abort(); await this.queue; }
}
