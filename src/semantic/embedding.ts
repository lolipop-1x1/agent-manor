import type { EmbeddingResult, SemanticConnection } from "../semantic-contracts.js";
import { normalizeEmbeddingUrl, SemanticError } from "./config.js";

function responseInvalid(): never { throw new SemanticError("semantic_embedding_invalid", "模型返回的向量格式、数量或维度无效", 502); }

export async function embeddings(connection: SemanticConnection, apiKey: string | undefined, texts: string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<EmbeddingResult> {
  if (!texts.length || texts.some(text => typeof text !== "string" || !text.trim()) || !connection.model.trim()) throw new SemanticError("semantic_input_invalid", "模型输入不能为空", 400);
  const endpoint = normalizeEmbeddingUrl(connection.url);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST", signal,
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: connection.model, input: texts, ...(connection.dimensions === undefined ? {} : { dimensions: connection.dimensions }) }),
    });
  } catch {
    if (options.signal?.aborted) throw new SemanticError("semantic_aborted", "模型请求已取消", 499);
    if (timeout.aborted) throw new SemanticError("semantic_timeout", "模型请求超时", 504);
    throw new SemanticError("semantic_network", "无法连接模型服务", 502);
  }
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    const retryAfterMs = retry === null ? undefined : /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now());
    let inputTooLong = response.status === 413;
    if (response.status === 400) {
      // 只识别可靠的协议错误码；不把可能包含历史正文的服务响应写入错误或日志。
      try {
        const body: unknown = await response.json();
        const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
        inputTooLong = Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "context_length_exceeded");
      } catch { /* 无法识别的 400 继续作为普通输入错误。 */ }
    } else await response.body?.cancel().catch(() => undefined);
    throw new SemanticError(response.status === 429 ? "semantic_rate_limited" : response.status === 401 || response.status === 403 ? "semantic_auth" : inputTooLong ? "semantic_input_too_long" : response.status >= 500 ? "semantic_service" : "semantic_request_invalid", `模型服务返回 HTTP ${response.status}`, response.status, Number.isFinite(retryAfterMs) ? retryAfterMs : undefined);
  }
  let body: Record<string, unknown>;
  try { const value: unknown = await response.json(); if (!value || typeof value !== "object" || Array.isArray(value)) return responseInvalid(); body = value as Record<string, unknown>; }
  catch (error) {
    if (error instanceof SemanticError) throw error;
    if (options.signal?.aborted) throw new SemanticError("semantic_aborted", "模型请求已取消", 499);
    if (timeout.aborted) throw new SemanticError("semantic_timeout", "模型请求超时", 504);
    return responseInvalid();
  }
  if (!Array.isArray(body.data) || body.data.length !== texts.length) return responseInvalid();
  const vectors: number[][] = new Array(texts.length);
  let dimensions = connection.dimensions;
  for (const item of body.data) {
    if (!item || typeof item !== "object") return responseInvalid();
    const entry = item as Record<string, unknown>, index = entry.index, embedding = entry.embedding;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= texts.length || vectors[index] || !Array.isArray(embedding) || !embedding.length || embedding.length > 65_536) return responseInvalid();
    if (embedding.some(value => typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) || !embedding.some(value => Math.fround(value) !== 0)) return responseInvalid();
    dimensions ??= embedding.length;
    if (embedding.length !== dimensions) return responseInvalid();
    vectors[index] = embedding as number[];
  }
  const usage = body.usage && typeof body.usage === "object" ? body.usage as Record<string, unknown> : undefined;
  const tokens = usage?.prompt_tokens ?? usage?.total_tokens;
  if (tokens !== undefined && (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0)) return responseInvalid();
  return { vectors, dimensions: dimensions!, ...(tokens === undefined ? {} : { tokens: tokens as number }) };
}

export { SemanticError } from "./config.js";
