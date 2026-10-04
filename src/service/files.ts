import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readHistoryEvidence } from "../history/adapters/index.js";
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

/** 通过原始格式回读证据；JSONL 适配器核对物理行与记录哈希。 */
export const readEvidence = readHistoryEvidence;
