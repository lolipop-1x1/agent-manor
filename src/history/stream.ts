import { DiagnosticError } from "../i18n/diagnostics.js";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";

export const compressedHistory = (path: string) => path.endsWith(".jsonl.zst");

/** 原始字节用于指纹，解压字节用于 JSONL 行号；不在磁盘生成明文副本。 */
export async function* historyBytes(path: string, options: {
  byteLimit?: number; onRead?: (chunk: Uint8Array) => void; maxDecodedBytes?: number; maxInputBytes?: number; input?: Readable;
} = {}): AsyncGenerator<Buffer> {
  if (options.byteLimit === 0) {
    if (compressedHistory(path)) throw new DiagnosticError("Zstandard 历史帧不完整", { key: "diagnostics.history.compressed.incomplete" });
    return;
  }
  const input = options.input ?? createReadStream(path, { highWaterMark: 65_536,
    end: options.byteLimit === undefined ? undefined : options.byteLimit - 1 });
  const iterator = input[Symbol.asyncIterator]();
  let chunk: Buffer = Buffer.alloc(0);
  let offset = 0, decoded = 0, frames = 0, rawBytes = 0;
  const limit = options.maxDecodedBytes ?? 4 * 1024 * 1024 * 1024;
  async function available(): Promise<boolean> {
    if (offset < chunk.length) return true;
    const next = await iterator.next();
    if (next.done) return false;
    chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as Uint8Array); offset = 0;
    rawBytes += chunk.length;
    if (compressedHistory(path) && rawBytes > (options.maxInputBytes ?? 4 * 1024 * 1024 * 1024)) {
      throw new DiagnosticError("Zstandard 历史原始输入超过字节预算", { key: "diagnostics.history.compressed.inputBudget" });
    }
    options.onRead?.(chunk);
    return true;
  }
  async function* take(size: number): AsyncGenerator<Buffer> {
    while (size) {
      if (!await available()) throw new DiagnosticError("Zstandard 历史帧不完整", { key: "diagnostics.history.compressed.incomplete" });
      const end = Math.min(chunk.length, offset + size);
      const part = chunk.subarray(offset, end);
      offset = end; size -= part.length;
      yield part;
    }
  }
  async function header(size: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of take(size)) parts.push(part);
    return Buffer.concat(parts, size);
  }
  async function* frame(magic: Buffer): AsyncGenerator<Buffer> {
    yield magic;
    const descriptor = await header(1);
    const flags = descriptor[0]!;
    if (flags & 0x18) throw new DiagnosticError("Zstandard 历史帧头无效", { key: "diagnostics.history.compressed.header" });
    yield descriptor;
    const single = Boolean(flags & 0x20), sizeFlag = flags >>> 6, dictionary = flags & 3;
    yield* take((single ? 0 : 1) + (dictionary === 3 ? 4 : dictionary) + (sizeFlag ? 1 << sizeFlag : single ? 1 : 0));
    for (;;) {
      const block = await header(3), value = block.readUIntLE(0, 3), type = (value >>> 1) & 3, size = value >>> 3;
      if (type === 3 || size > 131_072) throw new DiagnosticError("Zstandard 历史块无效", { key: "diagnostics.history.compressed.block" });
      yield block;
      yield* take(type === 1 ? 1 : size);
      if (value & 1) break;
    }
    if (flags & 4) yield* take(4);
  }
  try {
    if (!compressedHistory(path)) {
      while (await available()) { const part = chunk.subarray(offset); offset = chunk.length; yield part; }
      return;
    }
    while (await available()) {
      const magic = await header(4), value = magic.readUInt32LE(0);
      if (value >= 0x184d2a50 && value <= 0x184d2a5f) {
        frames++;
        const size = (await header(4)).readUInt32LE(0);
        for await (const _ of take(size)) { /* 规范的 skippable 帧不包含 JSONL 正文。 */ }
        continue;
      }
      if (value !== 0xfd2fb528) throw new DiagnosticError("Zstandard 历史帧标识无效", { key: "diagnostics.history.compressed.magic" });
      frames++;
      // Node 在一次输入包含多个帧时可能只输出首帧；必须逐帧解码并验证完整边界。
      const decoder = createZstdDecompress();
      const completed = pipeline(Readable.from(frame(magic)), decoder);
      void completed.catch(() => undefined);
      try {
        for await (const output of decoder) {
          const bytes = output as Buffer;
          decoded += bytes.length;
          if (decoded > limit) throw new DiagnosticError("Zstandard 历史解压超过字节预算", { key: "diagnostics.history.compressed.budget" });
          yield bytes;
        }
        await completed;
      } finally {
        decoder.destroy();
        await completed.catch(() => undefined);
      }
    }
    if (!frames) throw new DiagnosticError("Zstandard 历史帧不完整", { key: "diagnostics.history.compressed.incomplete" });
  } finally { input.destroy(); }
}

/** 发现阶段只解压有界头部，不把整份冷历史放进内存。 */
export async function historyHead(path: string, limit = 65_536): Promise<Buffer> {
  if (!compressedHistory(path)) {
    const handle = await open(path, "r");
    try {
      const bytes = Buffer.alloc(limit);
      const result = await handle.read(bytes, 0, limit, 0);
      return bytes.subarray(0, result.bytesRead);
    } finally { await handle.close(); }
  }
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of historyBytes(path)) {
    const part = chunk.subarray(0, limit - size);
    parts.push(part); size += part.length;
    if (size === limit) break;
  }
  return Buffer.concat(parts, size);
}
