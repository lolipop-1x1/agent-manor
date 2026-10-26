import { withIndexWrite, withIndexWriteAsync } from "./write-gate.js";
import { parentPort, workerData } from "node:worker_threads";
import { errorDescriptor } from "../i18n/diagnostics.js";
import { AnalysisStore, StoreError } from "./store.js";
import { SessionStore } from "../sessions/store.js";
import { WorkerManager } from "./worker-manager.js";
import type { TaskCommand, TaskMessage } from "./task-manager.js";
import type { DiscoverRoots } from "../history/index.js";
import type { SessionJob } from "../session-contracts.js";

const port = parentPort!;
const options = workerData as { dbPath: string; roots?: DiscoverRoots; writeGate?: SharedArrayBuffer };
const store = withIndexWrite(options.writeGate, () => new AnalysisStore(options.dbPath, { writeGate: options.writeGate }));
const sessions = withIndexWrite(options.writeGate, () => new SessionStore(options.dbPath, { writeGate: options.writeGate }));
const manager = new WorkerManager(store, { roots: options.roots, writeGate: options.writeGate }, sessions);
const sendState = (jobs: SessionJob[] = []) => port.postMessage({ state: {
  busy: manager.busy, sessions: manager.sessionState(), reclaim: manager.reclaimStatus,
}, jobs } satisfies TaskMessage);
manager.subscribeChanges(sendState);
sendState();
port.postMessage({ ready: true } satisfies TaskMessage);

/** 此队列只处理登记和短事务，解析与发布在两个独立任务 Worker 中完成。 */
let queue = Promise.resolve();
port.on("message", (command: TaskCommand) => {
  const execute = async () => {
    let result: unknown;
    switch (command.type) {
      case "register": {
        const registered = await store.registerRepositoryResult(...command.args);
        result = registered.created ? { repository: registered.repository, job: manager.refresh(registered.repository.id) } : { repository: registered.repository };
        break;
      }
      case "associate": store.associateSource(...command.args); result = manager.refresh(command.args[0]); break;
      case "delete": manager.deleteRepository(...command.args); break;
      case "refresh": result = manager.refresh(...command.args); break;
      case "clearCache": result = manager.clearCache(...command.args); break;
      case "autoRefresh": result = manager.autoRefreshRepository(...command.args); break;
      case "sessions": result = manager.refreshSessions(...command.args); break;
      case "retainJobs": manager.retainJobs(...command.args); break;
      case "close": await manager.close(); sessions.close(); store.close(); break;
    }
    if (command.type !== "close") sendState();
    port.postMessage({ id: command.id, result } satisfies TaskMessage);
  };
  queue = queue.then(() => command.type === "close" ? execute() : withIndexWriteAsync(options.writeGate, execute)).catch((error: unknown) => {
    port.postMessage({ id: command.id, error: { code: error instanceof StoreError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error), messageDescriptor: errorDescriptor(error) } } satisfies TaskMessage);
  });
});
