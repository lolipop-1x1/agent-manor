import { parentPort, workerData } from "node:worker_threads";
import { SemanticEngine, SemanticEngineError } from "./engine.js";

const engine = new SemanticEngine((workerData as { sourceDbPath: string }).sourceDbPath, (workerData as { semanticDbPath: string }).semanticDbPath);
const methods = new Set(["preview", "batch", "saveVectors", "splitInput", "progress", "publish", "stats", "facets", "search", "clear", "close"]);
parentPort!.on("message", (request: { id: string | number; method: string; args: unknown[] }) => {
  try {
    if (!methods.has(request.method)) throw new SemanticEngineError("INVALID_INPUT", "未知语义索引操作");
    const result = (engine[request.method as keyof SemanticEngine] as (...args: unknown[]) => unknown).apply(engine, request.args);
    parentPort!.postMessage({ id: request.id, result });
  } catch (error) {
    parentPort!.postMessage({ id: request.id, error: { message: error instanceof Error ? error.message : String(error), code: error instanceof SemanticEngineError ? error.code : "INTERNAL_ERROR", messageDescriptor: error instanceof SemanticEngineError ? error.messageDescriptor : undefined } });
  }
});
