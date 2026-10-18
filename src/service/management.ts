import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ServiceError } from "./input.js";

export interface ManagementOperation { method: string; path: string; body?: unknown }
interface Grant { digest: string; instance: string; expiresAt: number }
const grants = new WeakMap<FastifyInstance, Map<string, Grant>>();

export function managementDigest(operation: ManagementOperation): string {
  return createHash("sha256").update(JSON.stringify({ method: operation.method.toUpperCase(), path: operation.path, body: operation.body ?? null })).digest("hex");
}

function denied(): never {
  throw new ServiceError("FORBIDDEN", "This operation requires explicit confirmation of its exact contents", { key: "knowledge.errors.management_confirmation" });
}

function allowed(operation: ManagementOperation): boolean {
  if (operation.method === "GET" && operation.path === "/semantic/key") return operation.body === undefined || operation.body === null;
  if (operation.method !== "POST") return false;
  if (operation.path === "/knowledge/settings/key") return true;
  return /^\/knowledge\/entries\/[^/?#]+\/(reviews|availability)$/.test(operation.path);
}

/** 令牌记录具体操作的明确确认，不将终端或进程身份视为人工证明。 */
export function registerManagementRoutes(app: FastifyInstance): void {
  if (grants.has(app)) return;
  const pending = new Map<string, Grant>();
  grants.set(app, pending);
  app.post("/api/v1/management/authorizations", async (request, reply) => {
    const instance = request.headers["x-agent-manor-instance"];
    if (typeof instance !== "string" || request.headers["sec-fetch-site"] !== undefined) denied();
    const raw = request.body;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) denied();
    const input = raw as Record<string, unknown>;
    if (Object.keys(input).some(key => !["method", "path", "body", "confirmation"].includes(key))
      || typeof input.method !== "string" || typeof input.path !== "string") denied();
    const operation = { method: input.method.toUpperCase(), path: input.path, body: input.body };
    const digest = managementDigest(operation);
    if (!allowed(operation) || input.confirmation !== digest) denied();
    const now = Date.now();
    for (const [token, grant] of pending) if (grant.expiresAt <= now) pending.delete(token);
    if (pending.size >= 128) throw new ServiceError("CONTENT_STALE", "Too many pending confirmations", { key: "knowledge.errors.management_confirmation" });
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + 120_000;
    pending.set(token, { digest, instance, expiresAt });
    reply.header("Cache-Control", "no-store");
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  });
  app.addHook("onClose", async () => { pending.clear(); });
}

export function requireManagement(request: FastifyRequest): void {
  const instance = request.headers["x-agent-manor-instance"];
  if (instance === undefined && request.headers["sec-fetch-site"] === "same-origin") return;
  const token = request.headers["x-agent-manor-management"];
  if (typeof instance !== "string" || typeof token !== "string") denied();
  const pending = grants.get(request.server);
  const grant = pending?.get(token);
  pending?.delete(token);
  if (!grant || grant.instance !== instance || grant.expiresAt <= Date.now()) denied();
  const operation = { method: request.method, path: request.url.replace(/^\/api\/v1/, ""), body: request.body };
  if (!allowed(operation) || grant.digest !== managementDigest(operation)) denied();
}
