import type { FastifyInstance } from "fastify";
import type { PricingService } from "../usage/pricing.js";
import type { UsageManager } from "../usage/manager.js";
import { emptyBody, integer, textValue } from "./input.js";
import { pricingConfiguration, usageQuery } from "./usage-input.js";

export function registerUsageRoutes(app: FastifyInstance, usage: UsageManager, pricing: PricingService): void {
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/usage", request => usage.report(usageQuery(request.query)));
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/usage/status", request => usage.status(usageQuery(request.query)));
  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/usage/requests", request => {
    const query = usageQuery(request.query);
    const sessionId = textValue(request.query.sessionId, "sessionId", true)!;
    const page = integer(request.query.requestPage, "requestPage", 1, 1_000_000);
    const pageSize = integer(request.query.requestPageSize, "requestPageSize", 100, 200);
    return usage.requests(query, sessionId, page, pageSize);
  });
  app.get("/api/v1/usage/pricing", () => {
    // 页面立即读取本地结果，目录检查在后台进行，失败由状态响应说明。
    void pricing.refresh().catch(() => undefined);
    return pricing.status();
  });
  app.post("/api/v1/usage/pricing/refresh", async request => {
    emptyBody(request.body);
    return pricing.refresh(true);
  });
  app.put("/api/v1/usage/pricing", request => pricing.configure(pricingConfiguration(request.body)));
}
