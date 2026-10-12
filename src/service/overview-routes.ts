import type { FastifyInstance } from "fastify";
import type { OverviewManager } from "../overview/manager.js";
import { overviewDetailQuery, overviewDistributionDimension, overviewEvidenceQuery, overviewPanel, overviewQuery } from "./overview-input.js";

export function registerOverviewRoutes(app: FastifyInstance, overview: OverviewManager): void {
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/overview/snapshot", request => overview.snapshot(overviewQuery(request.query)));
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/overview/panel", request => {
    const { panel, dimension, ...query } = request.query, selectedPanel = overviewPanel(panel);
    return overview.panel(overviewQuery(query), selectedPanel, overviewDistributionDimension(dimension, selectedPanel));
  });
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/overview/detail", request => {
    const { detail, ...query } = request.query;
    return overview.detail(overviewQuery(query), overviewDetailQuery(detail));
  });
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/overview/report", request => overview.report(overviewQuery(request.query)));
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/overview/evidence", request =>
    overview.evidence(overviewQuery(request.query, true), overviewEvidenceQuery(request.query.evidence)));
}
