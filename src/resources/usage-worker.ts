import { parentPort, workerData } from "node:worker_threads";
import { StoreError } from "../index/store.js";
import { SessionStore } from "../sessions/store.js";
import { ResourceUsageCache } from "./usage-cache.js";
import type { ResourceHistoryRequest, ResourceHistoryResponse } from "./usage-manager.js";

const sessions = new SessionStore((workerData as { dbPath: string }).dbPath, { readonly: true });
const cache = new ResourceUsageCache(sessions);
parentPort!.on("message", (request: ResourceHistoryRequest) => {
  let response: ResourceHistoryResponse;
  try {
    const result = sessions.searchSnapshot(() => cache.read(request.query, request.entries));
    response = { id: request.id, result };
  } catch (error) {
    response = { id: request.id, error: error instanceof StoreError
      ? { code: error.code, message: error.message, messageDescriptor: error.messageDescriptor }
      : { code: "INTERNAL_ERROR", message: String(error), messageDescriptor: { key: "diagnostics.server.m003" } } };
  }
  parentPort!.postMessage(response);
});
parentPort!.on("close", () => sessions.close());
