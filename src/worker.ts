import { parentPort, workerData } from "node:worker_threads";
import type { DiscoverRoots } from "./history/index.js";
import { refreshRepository } from "./index/refresh.js";
import { AnalysisStore } from "./index/store.js";

if (!parentPort) throw new Error("分析入口必须由 Worker 启动");
const port = parentPort;
const options = workerData as { dbPath: string; roots?: DiscoverRoots };
const store = new AnalysisStore(options.dbPath);
let queue = Promise.resolve();

port.on("message", (message: { type: string; jobId: string; clearCache?: boolean }) => {
  if (message.type !== "refresh") return;
  queue = queue.then(async () => {
    await refreshRepository(store, message.jobId, options.roots, Boolean(message.clearCache));
    port.postMessage({ jobId: message.jobId });
  }).catch((error: unknown) => {
    store.failJob(message.jobId, error instanceof Error ? error.message : String(error));
    port.postMessage({ jobId: message.jobId });
  });
});
