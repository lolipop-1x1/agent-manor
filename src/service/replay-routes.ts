import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ReplayManager, ReplayOperation, ReplayQuery } from "../replay/manager.js";
import { textValue } from "./input.js";

export function registerReplayRoutes(app: FastifyInstance, replay: ReplayManager): void {
  const execute = async (request: FastifyRequest, reply: FastifyReply, type: ReplayOperation, query: ReplayQuery) => {
    const controller = new AbortController();
    const cancel = () => { if (!reply.raw.writableFinished) controller.abort(); };
    request.raw.once("aborted", cancel); reply.raw.once("close", cancel);
    if (request.raw.aborted || reply.raw.destroyed) controller.abort();
    try { return await replay.execute(type, query, controller.signal); }
    finally { request.raw.removeListener("aborted", cancel); reply.raw.removeListener("close", cancel); }
  };
  const base = "/api/v1/repositories/:id/replay";
  type Request = { Params: { id: string }; Querystring: Record<string, unknown> };
  app.get<Request>(`${base}/sessions`, (request, reply) => execute(request, reply, "sessions", { repositoryId: request.params.id,
    version: textValue(request.query.version, "version"), sessionVersion: textValue(request.query.sessionVersion, "sessionVersion") }));
  app.get<Request>(base, (request, reply) => execute(request, reply, "replay", { repositoryId: request.params.id,
    sessionId: textValue(request.query.sessionId, "sessionId", true)!, version: textValue(request.query.version, "version"),
    sessionVersion: textValue(request.query.sessionVersion, "sessionVersion") }));
  app.get<{ Params: { id: string; eventId: string }; Querystring: Record<string, unknown> }>(`${base}/evidence/:eventId`, (request, reply) =>
    execute(request, reply, "evidence", { repositoryId: request.params.id, sessionId: textValue(request.query.sessionId, "sessionId", true)!, eventId: request.params.eventId,
      version: textValue(request.query.version, "version", true)!, sessionVersion: textValue(request.query.sessionVersion, "sessionVersion", true)! }));
}
