import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { historyAdapter, historyClient } from "./adapters/index.js";
import type { SourceLocation } from "./types.js";

/** 同时返回依赖标记，发现前后可在尚未读到原生选择器时核对同一批文件。 */
export async function sourceQuickCheck(source: SourceLocation): Promise<{ stamp: string; dependencies: string } | undefined> {
  const format = source.format ?? historyClient(source.client).format;
  const capability = historyAdapter(format)?.quickCheck;
  const dependencies = capability?.dependencies(source);
  if (!capability || !dependencies) return undefined;
  const sourcePath = resolve(source.path);
  const paths = [...new Set([sourcePath, ...dependencies.map(path => resolve(path))])].sort();
  const signatures: unknown[] = [];
  for (const path of paths) {
    try {
      const info = await lstat(path, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink()) return undefined;
      signatures.push([path, String(info.dev), String(info.ino), String(info.size), String(info.mtimeNs), String(info.ctimeNs)]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path === sourcePath) return undefined;
      // 可选元信息的缺失也参与标记，后续新建或删除都必须触发重新发现。
      signatures.push([path, "missing"]);
    }
  }
  const dependencyStamp = createHash("sha256").update(JSON.stringify(["source-dependencies-v1", source.client, format, capability.version, signatures])).digest("hex");
  const stamp = createHash("sha256").update(JSON.stringify(["source-quick-v2", source.selector, dependencyStamp])).digest("hex");
  return { stamp, dependencies: dependencyStamp };
}

/** 标记只表示已核验依赖的变化指示；不能代替正文内容哈希。 */
export async function sourceQuickStamp(source: SourceLocation): Promise<string | undefined> {
  return (await sourceQuickCheck(source))?.stamp;
}
