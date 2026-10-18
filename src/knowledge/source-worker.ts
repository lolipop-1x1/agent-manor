import { parentPort, workerData } from "node:worker_threads";
import type { KnowledgeExtractionScope, KnowledgeSource, KnowledgeTarget } from "../knowledge-contracts.js";
import { SessionStore } from "../sessions/store.js";
import { SessionKnowledgeReader } from "./source-reader.js";

const sessions = new SessionStore((workerData as { dbPath: string }).dbPath, { readonly: true });
const reader = new SessionKnowledgeReader(sessions);
parentPort!.on("message", async (message: { id: number; method: string; input: unknown }) => {
  try {
    const result = message.method === "plan" ? await reader.plan(message.input as KnowledgeExtractionScope)
      : message.method === "read" ? await reader.read(message.input as KnowledgeTarget)
        : message.method === "verify" ? await reader.verify(message.input as KnowledgeSource) : undefined;
    parentPort!.postMessage({ id: message.id, result });
  } catch (error) { parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) }); }
});
