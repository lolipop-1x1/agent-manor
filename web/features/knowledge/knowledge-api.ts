import type { JsonValue } from "../../../src/contracts";
import { request } from "../../shared/api";

export function knowledgeRequest<T>(path: string, body?: unknown, method = "POST", signal?: AbortSignal): Promise<T> {
  return request<T>(`/knowledge${path}`, { method: body === undefined ? "GET" : method, body: body as JsonValue | undefined, signal });
}
