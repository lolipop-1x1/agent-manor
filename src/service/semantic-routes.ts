import type { FastifyInstance } from "fastify";
import type { SemanticConnection, SemanticScope, SemanticSearchQuery, SemanticSettingsInput } from "../semantic-contracts.js";
import { SemanticManager } from "../semantic/manager.js";
import { SemanticError } from "../semantic/config.js";
import { ServiceError, bodyText } from "./input.js";

function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SemanticError("semantic_input_invalid", "Expected a JSON object");
  return value as Record<string, unknown>;
}

export async function semanticRequest<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ServiceError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const invalid = error instanceof SemanticError && /invalid|scope_required|connection_required|INPUT/.test(error.code);
    const descriptor = error instanceof SemanticError && error.messageDescriptor
      ? error.messageDescriptor : { key: "sessions.semantic.error", params: { message: reason } };
    throw new ServiceError(invalid ? "INVALID_INPUT" : "ANALYSIS_NOT_READY", reason, descriptor);
  }
}

export function registerSemanticRoutes(app: FastifyInstance, semantic: SemanticManager): void {
  app.get("/api/v1/semantic/settings", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return semanticRequest(() => semantic.settings());
  });
  app.put("/api/v1/semantic/settings", async request => semanticRequest(() => {
    const body = object(request.body);
    if (body.apiKey !== undefined && body.apiKey !== null && typeof body.apiKey !== "string") throw new SemanticError("semantic_input_invalid", "API key must be a string or null");
    return semantic.save(body as unknown as SemanticSettingsInput);
  }));
  app.get("/api/v1/semantic/key", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return semanticRequest(async () => ({ apiKey: await semantic.key() ?? null }));
  });
  app.get("/api/v1/semantic/facets", async () => semanticRequest(() => semantic.facets()));
  app.get("/api/v1/semantic/status", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return semanticRequest(() => semantic.status());
  });
  app.post("/api/v1/semantic/test", async request => semanticRequest(() => {
    const body = object(request.body);
    if (body.apiKey !== undefined && body.apiKey !== null && typeof body.apiKey !== "string") throw new SemanticError("semantic_input_invalid", "API key must be a string or null");
    return semantic.test({ connection: body.connection as SemanticConnection | undefined, apiKey: body.apiKey as string | null | undefined });
  }));
  app.post("/api/v1/semantic/preview", async request => semanticRequest(() => semantic.preview(object(request.body).scope as SemanticScope | undefined)));
  app.post("/api/v1/semantic/build", async request => semanticRequest(() => semantic.build(bodyText(request.body, "previewId"))));
  app.post("/api/v1/semantic/action", async request => semanticRequest(() => semantic.action(bodyText(request.body, "action"))));
  app.post("/api/v1/semantic/search", async (request, reply) => {
    const controller = new AbortController();
    const cancel = () => { if (!reply.raw.writableFinished) controller.abort(); };
    request.raw.once("aborted", cancel); reply.raw.once("close", cancel);
    try {
      return await semanticRequest(() => {
        const body = object(request.body);
        for (const key of ["page", "pageSize"] as const) if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || Number(body[key]) < 1)) throw new SemanticError("semantic_input_invalid", `Invalid ${key}`);
        if (body.sort !== undefined && !["relevance", "updated"].includes(String(body.sort))) throw new SemanticError("semantic_input_invalid", "Invalid sort");
        if (body.cacheOnly !== undefined && typeof body.cacheOnly !== "boolean") throw new SemanticError("semantic_input_invalid", "Invalid cacheOnly");
        if (body.sessionId !== undefined && typeof body.sessionId !== "string") throw new SemanticError("semantic_input_invalid", "Invalid sessionId");
        return semantic.search(body as unknown as SemanticSearchQuery, controller.signal);
      });
    } finally { request.raw.removeListener("aborted", cancel); reply.raw.removeListener("close", cancel); }
  });
}
