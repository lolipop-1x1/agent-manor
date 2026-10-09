import { errorDescriptor } from "./i18n/diagnostics.js";
import { DiagnosticError } from "./i18n/diagnostics.js";
import { parentPort, workerData } from "node:worker_threads";
import type { DiscoverRoots } from "./history/index.js";
import { refreshRepository } from "./index/refresh.js";
import { AnalysisStore } from "./index/store.js";
import { SessionStore } from "./sessions/store.js";
import { refreshSessions } from "./sessions/refresh.js";
import { reclaimIndexBatch } from "./index/maintenance.js";

if (!parentPort) throw new DiagnosticError("分析入口必须由 Worker 启动", { key: "diagnostics.worker.m001" });
const port = parentPort;
const options = workerData as { dbPath: string; roots?: DiscoverRoots };
const store = new AnalysisStore(options.dbPath);
const sessions = new SessionStore(options.dbPath);
let queue = Promise.resolve();
let pending = 0;

// 回收和解析共用串行 Worker，短批次之间让出执行权以接收新任务。
const reclaimTimer = setInterval(() => {
  if (pending) return;
  const reclaim = reclaimIndexBatch(options.dbPath);
  if (reclaim.reason === "unsupportedSchema") clearInterval(reclaimTimer);
  if (reclaim.status !== "skipped" || reclaim.reason !== "threshold") port.postMessage({ reclaim });
}, 1_000).unref();

port.on("message", (message: { type: string; jobId: string; clearCache?: boolean }) => {
  if (message.type !== "refresh" && message.type !== "sessions") return;
  pending += 1;
  queue = queue.then(async () => {
    if (message.type === "sessions") await refreshSessions(sessions, message.jobId, options.roots, Boolean(message.clearCache));
    else await refreshRepository(store, message.jobId, options.roots, Boolean(message.clearCache));
    port.postMessage({ jobId: message.jobId });
  }).catch((error: unknown) => {
    const owner = message.type === "sessions" ? sessions : store;
    owner.failJob(message.jobId, error instanceof Error ? error.message : String(error), errorDescriptor(error));
    port.postMessage({ jobId: message.jobId });
  }).finally(() => { pending -= 1; });
});
