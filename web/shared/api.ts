import type { ApiErrorResponse, JsonValue } from "../../src/contracts";
import type { MessageDescriptor } from "../../src/i18n";
import { messageText, t } from "./i18n";

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly messageDescriptor?: MessageDescriptor) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(path: string, options: { method?: string; body?: JsonValue; signal?: AbortSignal } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: options.method ?? "GET",
      headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError("CONNECTION_FAILED", "无法连接本地分析服务，请确认服务正在运行后重试。", { key: "common.error.connection" });
  }
  let body: T | ApiErrorResponse | null;
  try {
    body = await response.json() as T | ApiErrorResponse;
  } catch (error) {
    if (isAborted(error)) throw error;
    body = null;
  }
  if (!response.ok) {
    if (body && typeof body === "object" && "error" in body) {
      const failure = body as ApiErrorResponse;
      throw new ApiError(failure.error.code, failure.error.message, failure.error.messageDescriptor);
    }
    throw new ApiError("INVALID_RESPONSE", `服务返回异常（HTTP ${response.status}），请重试。`, { key: "common.error.http", params: { status: response.status } });
  }
  if (body === null) throw new ApiError("INVALID_RESPONSE", "服务未返回有效结果，请重试。", { key: "common.error.invalidResponse" });
  return body as T;
}

export const errorMessage = (error: unknown): string => error instanceof ApiError ? messageText(error.messageDescriptor, error.message) : error instanceof Error ? error.message : typeof error === "string" ? error : t("common.error.query");
export const isAborted = (error: unknown) => error instanceof Error && error.name === "AbortError";
