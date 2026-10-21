import { tryIndexWrite, withIndexWrite } from "./index/write-gate.js";
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
const options = workerData as { dbPath: string; roots?: DiscoverRoots; lifecycleHandshake?: boolean; kind?: "maps" | "sessions"; writeGate?: SharedArrayBuffer };
const kind = options.kind ?? "maps";
const store = kind === "maps" ? withIndexWrite(options.writeGate, () => new AnalysisStore(options.dbPath, { writeGate: options.writeGate })) : undefined;
const sessions = kind === "sessions" ? withIndexWrite(options.writeGate, () => new SessionStore(options.dbPath, { writeGate: options.writeGate })) : undefined;
let queue = Promise.resolve();
let pending = 0;
const cancelled = new Set<string>();
const queued = new Set<string>();
// 主线程停止服务时可以避开原生模块尚未初始化完成的窗口。
if (options.lifecycleHandshake) port.postMessage({ ready: true });

// 回收和解析共用串行 Worker，短批次之间让出执行权以接收新任务。
const reclaimTimer = kind === "maps" ? setInterval(() => {
  if (pending) return;
  const reclaim = tryIndexWrite(options.writeGate, () => reclaimIndexBatch(options.dbPath));
  if (!reclaim) return;
  if (reclaim.reason === "unsupportedSchema") clearInterval(reclaimTimer!);
  if (reclaim.status !== "skipped" || reclaim.reason !== "threshold") port.postMessage({ reclaim });
}, 1_000).unref() : undefined;

port.on("message", (message: { type: string; jobId: string; jobIds?: string[]; clearCache?: boolean }) => {
  if (message.type === "cancel") {
    for (const id of message.jobIds ?? []) if (queued.has(id)) cancelled.add(id);
    return;
  }
  if (message.type !== (kind === "maps" ? "refresh" : "sessions")) return;
  pending += 1;
  queued.add(message.jobId);
  queue = queue.then(async () => {
    if (message.type === "sessions") await refreshSessions(sessions!, message.jobId, options.roots, Boolean(message.clearCache));
    else if (!cancelled.has(message.jobId) && store!.findJob(message.jobId)) {
      await refreshRepository(store!, message.jobId, options.roots, Boolean(message.clearCache), () => cancelled.has(message.jobId));
    }
    port.postMessage({ jobId: message.jobId });
  }).catch((error: unknown) => {
    const owner = message.type === "sessions" ? sessions : store;
    owner!.failJob(message.jobId, error instanceof Error ? error.message : String(error), errorDescriptor(error));
    port.postMessage({ jobId: message.jobId });
  }).finally(() => { cancelled.delete(message.jobId); queued.delete(message.jobId); pending -= 1; });
});
