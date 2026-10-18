import type { FastifyInstance } from "fastify";
import type { PricingService } from "../usage/pricing.js";
import type { UsageManager } from "../usage/manager.js";
import type { SessionStore } from "../sessions/store.js";
import { emptyBody, integer, textValue } from "./input.js";
import { sessionProfileQuery, summaryResponse } from "./session-input.js";
import { pricingConfiguration, usageQuery } from "./usage-input.js";
import { sessionSummaryResponse } from "./summary-response.js";

export function registerUsageRoutes(app: FastifyInstance, usage: UsageManager, pricing: PricingService, sessions: SessionStore): void {
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>("/api/v1/sessions/:id/cost", request => {
    const profile = sessions.profile(request.params.id, { ...sessionProfileQuery(request.query), summary: true });
    void pricing.refresh().catch(() => undefined);
    return usage.sessionCost(profile, textValue(request.query.priceVersion, "priceVersion"));
  });
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/usage", async request => {
    const summary = summaryResponse(request.query);
    const { response: _response, ...raw } = request.query;
    if (!summary) return usage.report(usageQuery(raw));
    const report = await usage.summaryReport(usageQuery({ ...raw, pageSize: raw.pageSize ?? "20" }));
    return { ...report, sessions: report.sessions.map(({ requests: _requests, ...row }) => ({ ...row, session: sessionSummaryResponse(row.session) })) };
  });
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/usage/status", request => usage.status(usageQuery(request.query)));
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/usage/requests", request => {
    const query = usageQuery(request.query);
    const sessionId = textValue(request.query.sessionId, "sessionId", true)!;
    const page = integer(request.query.requestPage, "requestPage", 1, 1_000_000);
    const pageSize = integer(request.query.requestPageSize, "requestPageSize", 100, 200);
    return usage.requests(query, sessionId, page, pageSize);
  });
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/usage/pricing", request => {
    const summary = summaryResponse(request.query);
    // 页面立即读取本地结果，目录检查在后台进行，失败由状态响应说明。
    void pricing.refresh().catch(() => undefined);
    return summary ? pricing.configurationSummary() : pricing.status();
  });
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/usage/pricing/prices", request => pricing.prices(
    integer(request.query.page, "page", 1, 1_000_000), integer(request.query.pageSize, "pageSize", 20, 200),
    textValue(request.query.model, "model"), textValue(request.query.version, "version")));
  app.post<{ Querystring: Record<string, unknown> }>("/api/v1/usage/pricing/refresh", async request => {
    emptyBody(request.body);
    const summary = summaryResponse(request.query);
    const result = await pricing.refresh(true);
    return summary ? pricing.configurationSummary() : result;
  });
  app.put<{ Querystring: Record<string, unknown> }>("/api/v1/usage/pricing", request => {
    const summary = summaryResponse(request.query);
    const configuration = pricingConfiguration(request.body);
    return summary ? pricing.configure(configuration, true) : pricing.configure(configuration);
  });
}
