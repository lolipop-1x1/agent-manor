import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { SourceLocation } from "../history/types.js";

export interface ClientProjectMetadata {
  project?: string;
  ambiguous?: boolean;
}

/** 按原生编码比较已知完整路径，不能由有损目录名反向恢复路径。 */
function projectSlug(path: string): string {
  const slug = path.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return slug.length <= 80 ? slug : `${slug.slice(0, 80)}-${createHash("sha1").update(path).digest("hex").slice(0, 8)}`;
}

function projectDirectory(path: string): string | undefined {
  let current = dirname(resolve(path));
  while (dirname(current) !== current) {
    if (basename(dirname(current)) === "projects") return current;
    current = dirname(current);
  }
  return undefined;
}

/** 只读取已发现来源所属客户端目录的旁路元数据，不额外搜索默认用户目录。 */
export async function loadCodeFlickerProjects(sources: readonly SourceLocation[]): Promise<Map<string, ClientProjectMetadata>> {
  const locations = sources.filter(source => source.client === "codeflicker")
    .map(source => ({ path: source.path, directory: projectDirectory(source.path) }))
    .filter((source): source is { path: string; directory: string } => source.directory !== undefined);
  const homes = new Set(locations.map(source => dirname(dirname(source.directory))));
  const associations = new Map<string, Set<string>>();
  for (const home of homes) {
    let text: string;
    try { text = await readFile(join(home, "data.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    let metadata: { projects?: unknown };
    try { metadata = JSON.parse(text) as typeof metadata; }
    catch { throw new Error("CodeFlicker 项目元数据不是有效 JSON"); }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
      || (metadata.projects !== undefined && (!metadata.projects || typeof metadata.projects !== "object" || Array.isArray(metadata.projects)))) {
      throw new Error("CodeFlicker 项目元数据格式不支持");
    }
    for (const path of Object.keys(metadata.projects ?? {})) {
      if (!isAbsolute(path)) continue;
      const directory = join(home, "projects", projectSlug(path));
      const projects = associations.get(directory) ?? new Set<string>();
      projects.add(resolve(path));
      associations.set(directory, projects);
    }
  }
  const result = new Map<string, ClientProjectMetadata>();
  for (const source of locations) {
    const projects = associations.get(source.directory);
    if (projects?.size === 1) result.set(source.path, { project: [...projects][0]! });
    else if (projects && projects.size > 1) result.set(source.path, { ambiguous: true });
  }
  return result;
}
