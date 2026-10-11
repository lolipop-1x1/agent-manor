import type { FastifyInstance } from "fastify";
import type { OverviewManager } from "../overview/manager.js";
import { overviewEvidenceQuery, overviewQuery } from "./overview-input.js";

export function registerOverviewRoutes(app: FastifyInstance, overview: OverviewManager): void {
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/overview/report", request => overview.report(overviewQuery(request.query)));
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/overview/evidence", request =>
    overview.evidence(overviewQuery(request.query, true), overviewEvidenceQuery(request.query.evidence)));
}
