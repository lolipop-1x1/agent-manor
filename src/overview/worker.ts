import { parentPort, workerData } from "node:worker_threads";
import { AnalysisStore, StoreError } from "../index/store.js";
import type { OverviewSource } from "../overview-contracts.js";
import { SessionStore } from "../sessions/store.js";
import { ServiceError } from "../service/input.js";
import { createPricingEstimator } from "../usage/pricing.js";
import { buildOverviewReport } from "./analytics.js";
import { loadOverviewSource } from "./data.js";
import { buildOverviewEvidence } from "./evidence.js";
import { generateOverviewInsights } from "./insights.js";
import { buildOverviewRepositories } from "./repositories.js";
import type { OverviewWorkerRequest, OverviewWorkerResponse } from "./worker-contracts.js";
import { prepareOverviewDateCache, resolveTimezone } from "./dates.js";

const { dbPath } = workerData as { dbPath: string };
const sessions = new SessionStore(dbPath), repositories = new AnalysisStore(dbPath);
let source: OverviewSource | undefined;

parentPort!.on("message", (request: OverviewWorkerRequest) => {
  try {
    // 先验证保留版本，再复用单份轻量事实；被淘汰的旧版本不会借缓存继续下钻。
    const version = sessions.usageVersion(request.query.version);
    if (!source || source.version !== version) source = loadOverviewSource(sessions, version);
    prepareOverviewDateCache(version, resolveTimezone(request.query.timezone));
    const pricing = { status: request.pricing, estimate: createPricingEstimator(request.pricing) }, now = new Date(request.now);
    let result;
    if (request.type === "evidence") {
      if (!request.evidence) throw new StoreError("INVALID_INPUT", "总览调查缺少查询范围", { key: "diagnostics.server.m002" });
      result = buildOverviewEvidence(source, request.query, request.evidence, pricing, now);
    } else {
      const report = buildOverviewReport(source, request.query, pricing, now);
      report.repositories = buildOverviewRepositories(repositories, request.repositories, source, request.query, report.range, report.timezone);
      Object.assign(report, generateOverviewInsights(source, request.query, pricing, report, now));
      // 后续调用组仅供生成洞察；完整过程由固定版本的分页证据查询读取。
      report.process.failureSequences = [];
      result = report;
    }
    parentPort!.postMessage({ id: request.id, type: "result", result } satisfies OverviewWorkerResponse);
  } catch (error) {
    const known = error instanceof StoreError || error instanceof ServiceError;
    parentPort!.postMessage({ id: request.id, type: "error", error: {
      code: known ? error.code : "INTERNAL_ERROR", message: known ? error.message : "总览统计失败",
      messageDescriptor: known ? error.messageDescriptor : { key: "diagnostics.server.m003" },
    } } satisfies OverviewWorkerResponse);
  }
});
parentPort!.on("close", () => { sessions.close(); repositories.close(); });
