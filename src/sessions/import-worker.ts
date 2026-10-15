import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { DiagnosticError, errorDescriptor } from "../i18n/diagnostics.js";
import { parseSessionSource } from "./parser.js";
import { characterTerms } from "./search-index.js";
import type { ImportItem, ImportRequest, ImportResponse } from "./import-pool.js";

if (!parentPort) throw new Error("解析入口必须由 Worker 启动");
const ack = (workerData as { ack: Int32Array }).ack;
parentPort.on("message", async ({ id, source, options, hash: observe }: ImportRequest) => {
  let items: ImportItem[] = [], bytes = 0;
  const terms = new Map<string, string>();
  const flush = () => {
    if (!items.length) return;
    Atomics.store(ack, 0, 0);
    parentPort!.postMessage({ id, type: "batch", items } satisfies ImportResponse);
    while (Atomics.load(ack, 0) === 0) Atomics.wait(ack, 0, 0);
    if (Atomics.load(ack, 0) < 0) throw new DiagnosticError("写入方已停止接收解析批次", { key: "diagnostics.sessions.import.writeStopped" });
    items = []; bytes = 0; terms.clear();
  };
  try {
    const hash = observe ? createHash("sha256") : undefined;
    const meta = await parseSessionSource(source, {
      message: value => {
        const encoded = terms.get(value.text) ?? characterTerms(value.text); terms.set(value.text, encoded);
        items.push({ type: "message", value, terms: encoded }); bytes += (value.text.length + encoded.length) * 2;
        if (items.length >= 1000 || bytes >= 8_000_000) flush();
      },
      usage: value => { items.push({ type: "usage", value }); bytes += 1024; if (items.length >= 1000 || bytes >= 8_000_000) flush(); },
    }, { ...options, onRead: hash ? chunk => { hash.update(chunk); } : undefined });
    flush();
    parentPort!.postMessage({ id, type: "done", meta, hash: hash?.digest("hex") } satisfies ImportResponse);
  } catch (error) {
    parentPort!.postMessage({ id, type: "error", message: error instanceof Error ? error.message : String(error), descriptor: errorDescriptor(error) } satisfies ImportResponse);
  }
});
