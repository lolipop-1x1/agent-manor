import { parentPort, workerData } from "node:worker_threads";
import type { DiscoverRoots } from "./history/index.js";
import { refreshRepository } from "./index/refresh.js";
import { AnalysisStore } from "./index/store.js";
import { SessionStore } from "./sessions/store.js";
import { refreshSessions } from "./sessions/refresh.js";

if (!parentPort) throw new Error("分析入口必须由 Worker 启动");
const port = parentPort;
const options = workerData as { dbPath: string; roots?: DiscoverRoots };
const store = new AnalysisStore(options.dbPath);
const sessions = new SessionStore(options.dbPath);
let queue = Promise.resolve();

port.on("message", (message: { type: string; jobId: string; clearCache?: boolean }) => {
  if (message.type !== "refresh" && message.type !== "sessions") return;
  queue = queue.then(async () => {
    if (message.type === "sessions") await refreshSessions(sessions, message.jobId, options.roots, Boolean(message.clearCache));
    else await refreshRepository(store, message.jobId, options.roots, Boolean(message.clearCache));
    port.postMessage({ jobId: message.jobId });
  }).catch((error: unknown) => {
    const owner = message.type === "sessions" ? sessions : store;
    owner.failJob(message.jobId, error instanceof Error ? error.message : String(error));
    port.postMessage({ jobId: message.jobId });
  });
});
