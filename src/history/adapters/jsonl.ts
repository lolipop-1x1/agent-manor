import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { historyBytes } from "../stream.js";
import { MAX_HISTORY_RECORD_BYTES } from "../records.js";
import type { EvidenceRecord, SourceReference } from "../../contracts.js";

/** 引用完全来自已发布事件；只读取被引用的物理记录并核对记录哈希。 */
export async function readJsonlEvidence(source: SourceReference): Promise<EvidenceRecord | undefined> {
  if (!Number.isSafeInteger(source.recordLine) || source.recordLine < 1) return undefined;
  let handle;
  try {
    const filename = resolve(source.path);
    const canonical = await realpath(filename);
    if ((await lstat(filename)).isSymbolicLink()) return undefined;
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) return undefined;
    // 流式定位单条记录，避免为了回读证据载入整个历史文件。
    const stream = handle.createReadStream({ autoClose: false });
    let line = 1;
    let record: Buffer[] = [];
    let size = 0;
    try {
      for await (const bytes of historyBytes(filename, { input: stream })) {
        let start = 0;
        for (let end = 0; end < bytes.length; end++) {
          if (bytes[end] !== 10) continue;
          if (line === source.recordLine) {
            size += end - start;
            if (size > MAX_HISTORY_RECORD_BYTES) return undefined;
            record.push(bytes.subarray(start, end));
            const raw = Buffer.concat(record).toString("utf8");
            return createHash("sha256").update(raw).digest("hex") === source.hash && await realpath(filename) === canonical ? { source, raw } : undefined;
          }
          line++;
          start = end + 1;
        }
        if (line === source.recordLine) {
          const remaining = bytes.subarray(start);
          size += remaining.length;
          if (size > MAX_HISTORY_RECORD_BYTES) return undefined;
          record.push(remaining);
        }
      }
      return undefined;
    } finally { stream.destroy(); }
  } catch { return undefined; }
  finally { await handle?.close().catch(() => undefined); }
}
