import type { FastifyInstance } from "fastify";
import { RequestError } from "./runtime.js";
import { emptyBody, ServiceError } from "./input.js";
import type { ReleaseService } from "./releases.js";

/** 版本检查的失败与业务服务分开；网页不提供程序安装入口。 */
export function registerUpdateRoutes(app: FastifyInstance, releases: ReleaseService): void {
  app.get("/api/v1/update/status", () => releases.status());
  app.post("/api/v1/update/check", request => {
    emptyBody(request.body);
    return releases.check();
  });
  app.patch("/api/v1/update/settings", async (request, reply) => {
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body) || !Object.keys(request.body).length) {
      throw new ServiceError("INVALID_INPUT", "An update settings patch is required", { key: "updates.invalidSettings" });
    }
    try {
      await releases.settings(request.body as Parameters<ReleaseService["settings"]>[0]);
      return await releases.status();
    } catch (error) {
      if (!(error instanceof RequestError)) throw error;
      reply.code(error.code === "INVALID_INPUT" ? 400 : 500);
      return { error: { code: error.code, message: error.message, messageDescriptor: error.messageDescriptor } };
    }
  });
}
