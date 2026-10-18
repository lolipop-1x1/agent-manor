import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { MapQueryManager } from "../analysis/query-manager.js";
import type { MapOperation, MapQuery } from "../analysis/query-service.js";
import { coverageQuery, eventsQuery, integer, relativePath, ServiceError } from "./input.js";
import { queryBoolean } from "./session-input.js";

export function registerMapQueryRoutes(app: FastifyInstance, manager: MapQueryManager): void {
  const execute = async (request: FastifyRequest, reply: FastifyReply, type: MapOperation, query: MapQuery) => {
    const controller = new AbortController();
    const cancel = () => { if (!reply.raw.writableFinished) controller.abort(); };
    request.raw.once("aborted", cancel); reply.raw.once("close", cancel);
    if (request.raw.aborted || reply.raw.destroyed) controller.abort();
    try { return await manager.execute(type, query, controller.signal); }
    finally { request.raw.removeListener("aborted", cancel); reply.raw.removeListener("close", cancel); }
  };
  const base = "/api/v1/repositories/:id";
  type Request = { Params: { id: string }; Querystring: Record<string, unknown> };
  for (const [suffix, type] of [["sessions", "sessions"], ["coverage", "coverage"], ["coverage/gaps", "gaps"], ["unobserved", "unobserved"], ["sources", "sources"]] as const) {
    app.get<Request>(`${base}/${suffix}`, (request, reply) => execute(request, reply, type, {
      ...coverageQuery(request.query), repositoryId: request.params.id,
      ...(type === "coverage" ? { summary: queryBoolean(request.query.summary, "summary") } : {}),
    }));
  }
  app.get<Request>(`${base}/hotspots`, (request, reply) => {
    const query = coverageQuery(request.query);
    const metric = request.query.metric ?? "activity";
    if (metric !== "read" && metric !== "edit" && metric !== "activity") throw new ServiceError("INVALID_INPUT", "未知热点指标", { key: "diagnostics.server.m016" });
    return execute(request, reply, "hotspots", { ...query, repositoryId: request.params.id, metric, limit: integer(request.query.limit, "limit", 20, 1000) });
  });
  app.get<Request>(`${base}/file`, (request, reply) => execute(request, reply, "file", {
    ...coverageQuery(request.query), repositoryId: request.params.id, path: relativePath(request.query.path),
  }));
  app.get<Request>(`${base}/events`, (request, reply) => execute(request, reply, "events", { ...eventsQuery(request.query), repositoryId: request.params.id }));
  app.get<{ Params: { id: string; eventId: string }; Querystring: Record<string, unknown> }>(`${base}/evidence/:eventId`, (request, reply) =>
    execute(request, reply, "evidence", { ...coverageQuery(request.query), repositoryId: request.params.id, eventId: request.params.eventId }));
}
