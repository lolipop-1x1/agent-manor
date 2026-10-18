import type { ServiceInstance } from "../../../../src/contracts.js";
import { apiRequest, delay, RequestError } from "../../../../src/service/runtime.js";

export function timeoutMilliseconds(value: string | boolean | undefined, fallback = 120): number {
  const seconds = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new RequestError("INVALID_INPUT", "timeout must be greater than 0 and no more than 3600 seconds", { key: "cli.error.timeout" });
  return seconds * 1000;
}
interface Task { id?: string; status?: string }
function task(value: unknown): Task | undefined {
  if (!value || typeof value !== "object") return;
  const result = value as { job?: Task; status?: string; id?: string };
  return result.job ?? (typeof result.status === "string" ? result : undefined);
}
export async function waitForTask(instance: ServiceInstance, initial: unknown, timeout?: string | boolean, path?: string): Promise<unknown> {
  const deadline = Date.now() + timeoutMilliseconds(timeout);
  let value = initial;
  let current = task(value);
  if (!current) return value;
  const endpoint = path ?? (current.id ? `/jobs/${encodeURIComponent(current.id)}` : undefined);
  while (current && ["queued", "running"].includes(current.status ?? "")) {
    if (!endpoint) throw new RequestError("INVALID_INPUT", "Task has no status endpoint");
    if (Date.now() >= deadline) throw new RequestError("WAIT_TIMEOUT", `Timed out waiting for job ${current.id ?? ""}`, { key: "cli.error.waitTimeout", params: { id: current.id ?? "" } });
    await delay(100);
    value = await apiRequest(instance, endpoint);
    current = task(value);
  }
  if (current && !["complete", "completed"].includes(current.status ?? "")) process.exitCode = 1;
  return initial && typeof initial === "object" && value && typeof value === "object" ? { ...initial, ...value } : value;
}
