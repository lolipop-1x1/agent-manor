import { parentPort, workerData } from "node:worker_threads";
import { AnalysisStore, StoreError } from "../index/store.js";
import { SessionStore } from "../sessions/store.js";
import { ReplayService } from "./service.js";
import type { ReplayWorkerRequest, ReplayWorkerResponse } from "./manager.js";

const { dbPath } = workerData as { dbPath: string };
const analysis = new AnalysisStore(dbPath, { readonly: true });
const sessions = new SessionStore(dbPath, { readonly: true });
const replay = new ReplayService(analysis, sessions);
parentPort!.on("message", async ({ id, type, query }: ReplayWorkerRequest) => {
  let response: ReplayWorkerResponse;
  try {
    const { repositoryId, sessionId, eventId, version, sessionVersion } = query;
    const result = type === "sessions" ? replay.sessions(repositoryId, version, sessionVersion)
      : type === "replay" ? replay.replay(repositoryId, sessionId!, version, sessionVersion)
        : await replay.evidence(repositoryId, sessionId!, eventId!, version, sessionVersion);
    response = { id, result };
  } catch (error) {
    response = { id, error: error instanceof StoreError
      ? { code: error.code, message: error.message, messageDescriptor: error.messageDescriptor }
      : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error), messageDescriptor: { key: "diagnostics.server.m003" } } };
  }
  parentPort!.postMessage(response);
});
