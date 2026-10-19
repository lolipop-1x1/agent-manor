import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { DiagnosticError, errorDescriptor } from "../i18n/diagnostics.js";
import { parseSessionSource } from "./parser.js";
import { characterTerms } from "./search-index.js";
import type { SessionMessage, SessionUsage } from "../session-contracts.js";
import type { ImportItem, ImportRequest, ImportResponse } from "./import-pool.js";

if (!parentPort) throw new Error("解析入口必须由 Worker 启动");
const ack = (workerData as { ack: Int32Array }).ack;
parentPort.on("message", async ({ id, source, options, hash: observe }: ImportRequest) => {
  let items: ImportItem[] = [], bytes = 0, encodedBytes = 0;
  type PendingItem = { type: "message"; value: SessionMessage } | { type: "usage"; value: SessionUsage };
  const pending = new Map<string, { item: PendingItem; bytes: number }>();
  const terms = new Map<string, string>();
  const send = () => {
    if (!items.length) return;
    Atomics.store(ack, 0, 0);
    parentPort!.postMessage({ id, type: "batch", items } satisfies ImportResponse);
    while (Atomics.load(ack, 0) === 0) Atomics.wait(ack, 0, 0);
    if (Atomics.load(ack, 0) < 0) throw new DiagnosticError("写入方已停止接收解析批次", { key: "diagnostics.sessions.import.writeStopped" });
    items = []; encodedBytes = 0; terms.clear();
  };
  // 先合并流式快照，再编码最终词项；按保留的实际正文估算批次，避免中间快照反复建索引。
  const flush = () => {
    for (const { item } of pending.values()) {
      if (item.type === "message") {
        const encoded = terms.get(item.value.text) ?? characterTerms(item.value.text); terms.set(item.value.text, encoded);
        items.push({ ...item, terms: encoded }); encodedBytes += (item.value.text.length + encoded.length) * 2;
      } else { items.push(item); encodedBytes += 1024; }
      if (items.length >= 1000 || encodedBytes >= 8_000_000) send();
    }
    pending.clear(); bytes = 0; send();
  };
  const put = (item: PendingItem) => {
    const key = `${item.type}:${item.value.id}`, size = item.type === "message" ? item.value.text.length * 2 : 1024;
    bytes += size - (pending.get(key)?.bytes ?? 0); pending.set(key, { item, bytes: size });
    if (pending.size >= 1000 || bytes >= 8_000_000) flush();
  };
  try {
    const hash = observe ? createHash("sha256") : undefined;
    const meta = await parseSessionSource(source, {
      message: value => put({ type: "message", value }),
      usage: value => put({ type: "usage", value }),
    }, { ...options, onRead: hash ? chunk => { hash.update(chunk); } : undefined });
    flush();
    parentPort!.postMessage({ id, type: "done", meta, hash: hash?.digest("hex") } satisfies ImportResponse);
  } catch (error) {
    parentPort!.postMessage({ id, type: "error", message: error instanceof Error ? error.message : String(error), descriptor: errorDescriptor(error) } satisfies ImportResponse);
  }
});
