import type { JsonValue } from "../../../src/contracts";
import { request } from "../../shared/api";

export const semanticRequest = <T,>(path: string, body?: unknown, method = "POST", signal?: AbortSignal) => request<T>(`/semantic${path}`, { method: body === undefined ? "GET" : method, body: body as JsonValue | undefined, signal });
