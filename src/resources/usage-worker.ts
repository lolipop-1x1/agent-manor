import { parentPort, workerData } from "node:worker_threads";
import { StoreError } from "../index/store.js";
import { SessionStore } from "../sessions/store.js";
import { ResourceUsageCache, summarizeUsageDetail } from "./usage-cache.js";
import { serviceErrorDetails } from "../service/logging.js";
import type { ResourceHistoryRequest, ResourceHistoryResponse } from "./usage-manager.js";

const sessions = new SessionStore((workerData as { dbPath: string }).dbPath, { readonly: true });
const cache = new ResourceUsageCache(sessions);
parentPort!.on("message", (request: ResourceHistoryRequest) => {
  let response: ResourceHistoryResponse;
  try {
    const result = sessions.searchSnapshot(() => request.operation === "overview" ? cache.read(request.query, request.entries)
      : request.operation === "evidence" ? cache.evidenceNow(request.resourceId!, request.query, request.identity)
      : request.operation === "summary" ? summarizeUsageDetail(cache.detailNow(request.resourceId!, request.query, request.entries, request.identity))
      : cache.detailNow(request.resourceId!, request.query, request.entries, request.identity));
    response = { id: request.id, result };
  } catch (error) {
    response = { id: request.id, diagnostic: serviceErrorDetails(error), error: error instanceof StoreError
      ? { code: error.code, message: error.message, messageDescriptor: error.messageDescriptor }
      : { code: "INTERNAL_ERROR", message: "本地服务处理失败", messageDescriptor: { key: "diagnostics.server.m003" } } };
  }
  parentPort!.postMessage(response);
});
parentPort!.on("close", () => sessions.close());
