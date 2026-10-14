import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import { DiagnosticError } from "./i18n/diagnostics.js";

function readFailure(code: "EFBIG" | "EINVAL"): DiagnosticError & { code: string } {
  return Object.assign(new DiagnosticError(code === "EFBIG" ? "文件超过有界读取上限" : "来源必须为普通文件",
    { key: code === "EFBIG" ? "diagnostics.files.boundedLimit" : "diagnostics.files.regularRequired" }), { code });
}

/** 不跟随入口链接；读取期间增长也不能突破预算。 */
export async function readBoundedText(path: string, limit: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw readFailure("EINVAL");
    if (info.size > limit) throw readFailure("EFBIG");
    const chunks: Buffer[] = []; let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw readFailure("EFBIG");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally { await handle.close(); }
}

/** 同步来源发现只读取小型根配置，不扫描正文。 */
export function readBoundedTextSync(path: string, limit: number): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw readFailure("EINVAL");
    if (info.size > limit) throw readFailure("EFBIG");
    const chunks: Buffer[] = []; let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit - total + 1));
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw readFailure("EFBIG");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally { closeSync(descriptor); }
}
