import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EvidenceRecord, SourceReference } from "../contracts.js";
import { relativePath, ServiceError } from "./input.js";

export const contentHash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** 逐级检查目录，禁止已登记路径后来被改成符号链接。 */
export async function safeFile(root: string, path: string): Promise<string> {
  relativePath(path);
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) throw new ServiceError("FORBIDDEN", "仓库根目录已变化");
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new ServiceError("FORBIDDEN", "不读取符号链接内容");
  }
  const canonical = await realpath(current);
  const local = relative(root, canonical);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new ServiceError("FORBIDDEN", "路径超出已登记仓库");
  return current;
}

export async function readCurrentFile(root: string, path: string): Promise<Buffer> {
  const filename = await safeFile(root, path);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new ServiceError("FORBIDDEN", "只能读取普通文件");
    const bytes = await handle.readFile();
    // 读取前后都核对父目录，避免变更后的链接获得旧版高亮。
    await safeFile(root, path);
    return bytes;
  } finally { await handle.close(); }
}

/** 引用完全来自已发布事件；只读取被引用的物理记录并核对记录哈希。 */
export async function readEvidence(source: SourceReference): Promise<EvidenceRecord | undefined> {
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
      for await (const chunk of stream) {
        const bytes = chunk as Buffer;
        let start = 0;
        for (let end = 0; end < bytes.length; end++) {
          if (bytes[end] !== 10) continue;
          if (line === source.recordLine) {
            record.push(bytes.subarray(start, end));
            const raw = Buffer.concat(record).toString("utf8");
            return contentHash(raw) === source.hash && await realpath(filename) === canonical ? { source, raw } : undefined;
          }
          line++;
          start = end + 1;
        }
        if (line === source.recordLine) {
          const remaining = bytes.subarray(start);
          size += remaining.length;
          if (size > 16 * 1024 * 1024) return undefined;
          record.push(remaining);
        }
      }
      return undefined;
    } finally { stream.destroy(); }
  } catch { return undefined; }
  finally { await handle?.close().catch(() => undefined); }
}
