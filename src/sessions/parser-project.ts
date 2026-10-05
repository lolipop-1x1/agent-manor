import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const git = promisify(execFile);
const roots = new Map<string, string | undefined>();
const MAX_ROOT_CACHE = 512;

/** 工具目标只能证明关联项目，不能据此重建历史 cwd。 */
export async function projectFromToolPaths(paths: Iterable<string>): Promise<{ project?: string; ambiguous: boolean; limited: boolean }> {
  const directories = new Set<string>();
  for (const path of paths) {
    if (!isAbsolute(path)) continue;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      directories.add(info.isDirectory() ? resolve(path) : dirname(resolve(path)));
    } catch { /* 不存在的历史目标无法用当前文件系统确认项目。 */ }
    if (directories.size > MAX_ROOT_CACHE) return { ambiguous: false, limited: true };
  }
  const candidates = new Set<string>();
  const markers = new Map<string, boolean>();
  const hasGitMarker = async (directory: string) => {
    if (markers.has(directory)) return markers.get(directory)!;
    let present = false;
    try { await lstat(join(directory, ".git")); present = true; } catch { /* 没有 Git 标记。 */ }
    markers.set(directory, present);
    return present;
  };
  for (const directory of directories) {
    let root: string | undefined;
    const known = [...new Set(roots.values())].filter((path): path is string => Boolean(path))
      .filter(path => { const local = relative(path, directory); return local === "" || (!local.startsWith("..") && !isAbsolute(local)); })
      .sort((left, right) => right.length - left.length);
    for (const candidate of known) {
      if (!await hasGitMarker(candidate)) continue;
      let current = directory;
      let nested = false;
      while (current !== candidate) {
        if (await hasGitMarker(current)) { nested = true; break; }
        const parent = dirname(current);
        if (parent === current) { nested = true; break; }
        current = parent;
      }
      if (!nested) { root = candidate; break; }
    }
    if (!root) {
      try {
        const result = await git("git", ["-C", directory, "rev-parse", "--show-toplevel"], { timeout: 2000, maxBuffer: 8192 });
        const path = result.stdout.trim();
        if (isAbsolute(path)) root = resolve(path);
      } catch { /* 没有 Git 根或当前目标不可读取时，保持项目未知。 */ }
      if (root) {
        roots.set(directory, root);
        if (roots.size > MAX_ROOT_CACHE) roots.delete(roots.keys().next().value!);
      }
    }
    if (root) candidates.add(root);
    if (candidates.size > 1) return { ambiguous: true, limited: false };
  }
  return { project: [...candidates][0], ambiguous: false, limited: false };
}
