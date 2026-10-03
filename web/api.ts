import type { ApiErrorResponse, CoverageQuery, JsonValue } from "../src/contracts";

export class ApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export function queryString(query: CoverageQuery, extra: Record<string, string | number | undefined> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...query, ...extra })) {
    if (value === undefined || value === "") continue;
    params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const result = params.toString();
  return result ? `?${result}` : "";
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
    throw new ApiError("CONNECTION_FAILED", "无法连接本地分析服务，请确认服务正在运行后重试。");
  }
  const body = await response.json().catch(() => null) as T | ApiErrorResponse | null;
  if (!response.ok) {
    if (body && typeof body === "object" && "error" in body) {
      const failure = body as ApiErrorResponse;
      throw new ApiError(failure.error.code, failure.error.message);
    }
    throw new ApiError("INVALID_RESPONSE", `服务返回异常（HTTP ${response.status}），请重试。`);
  }
  if (body === null) throw new ApiError("INVALID_RESPONSE", "服务未返回有效结果，请重试。");
  return body as T;
}

export const repositoryPath = (id: string) => `/repositories/${encodeURIComponent(id)}`;
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : "查询失败，请重试。";
export const isAborted = (error: unknown) => error instanceof Error && error.name === "AbortError";
