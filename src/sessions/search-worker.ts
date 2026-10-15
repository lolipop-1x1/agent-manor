import { parentPort, workerData } from "node:worker_threads";
import { StoreError } from "../index/store.js";
import { SessionStore } from "./store.js";
import type { SearchRequest, SearchResponse } from "./search-manager.js";

const sessions = new SessionStore((workerData as { dbPath: string }).dbPath, { readonly: true });
parentPort!.on("message", (request: SearchRequest) => {
  sessions.setSearchCancellation(request.cancellation);
  let response: SearchResponse;
  try {
    if (Atomics.load(request.cancellation, 0)) throw new Error("Search cancelled");
    const { query } = request;
    const result = sessions.searchSnapshot(() => request.type === "groups" ? sessions.groupedSearch(query)
      : request.type === "records" ? sessions.search(query)
      : request.type === "matches" ? sessions.matches(query.sessionId!, query) : sessions.list(query));
    response = { id: request.id, result };
  } catch (error) {
    response = { id: request.id, error: error instanceof StoreError
      ? { code: error.code, message: error.message, messageDescriptor: error.messageDescriptor }
      : { code: "INTERNAL_ERROR", message: String(error), messageDescriptor: { key: "diagnostics.server.m003" } } };
  } finally { sessions.setSearchCancellation(); }
  parentPort!.postMessage(response);
});
