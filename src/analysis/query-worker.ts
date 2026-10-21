import { withIndexWrite } from "../index/write-gate.js";
import { parentPort, workerData } from "node:worker_threads";
import { AnalysisStore, StoreError } from "../index/store.js";
import { SessionStore } from "../sessions/store.js";
import { ServiceError } from "../service/input.js";
import { MapQueryService } from "./query-service.js";
import type { MapWorkerRequest, MapWorkerResponse } from "./query-manager.js";

const { dbPath, writeGate } = workerData as { dbPath: string; writeGate?: SharedArrayBuffer };
// 仅补齐已发布版本的紧凑派生缓存，不修改原始历史或分析版本。
const analysis = withIndexWrite(writeGate, () => new AnalysisStore(dbPath, { writeGate }));
const sessions = new SessionStore(dbPath, { readonly: true });
const service = new MapQueryService(analysis, sessions);
parentPort!.on("message", async ({ id, type, query }: MapWorkerRequest) => {
  let response: MapWorkerResponse;
  try { response = { id, result: await service.execute(type, query) }; }
  catch (error) {
    response = { id, error: error instanceof StoreError || error instanceof ServiceError
      ? { code: error.code, message: error.message, messageDescriptor: error.messageDescriptor }
      : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error), messageDescriptor: { key: "diagnostics.server.m003" } } };
  }
  parentPort!.postMessage(response);
});
