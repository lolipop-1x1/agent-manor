import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../../../../src/version.js";

const RECORD = ".agent-manor-skill.json";
const PRODUCT = "agent-manor";
type SkillAction = "install" | "status" | "update" | "remove";
export interface SkillOptions {
  target?: "codex" | "claude" | "custom";
  scope?: "user" | "project";
  directory?: string;
  projectDirectory?: string;
  userHome?: string;
  overwrite?: boolean;
  templateDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}
interface InstallRecord { product: string; version: string; files: Record<string, string> }
export interface SkillResult {
  action: SkillAction;
  status: "installed" | "updated" | "current" | "outdated" | "modified" | "foreign" | "missing" | "removed";
  targetPath: string;
  version: string;
  installedVersion?: string;
  conflicts?: string[];
  backupPath?: string;
}
function failure(code: string, message: string, details?: unknown): Error {
  const suffix: Record<string, string> = { SKILL_TARGET_REQUIRED: "targetRequired", SKILL_INVALID_SCOPE: "invalidScope", SKILL_INVALID_TARGET: "invalidTarget", SKILL_INVALID_PATH: "invalidPath", SKILL_TEMPLATE_MISSING: "templateMissing", SKILL_SYMLINK_CONFLICT: "symlinkBlocked", SKILL_FILE_CONFLICT: "fileConflict", SKILL_TARGET_CONFLICT: "targetConflict", SKILL_NOT_MANAGED: "notManaged", SKILL_MODIFIED: "modified", SKILL_BUSY: "busy" };
  return Object.assign(new Error(message), { code, details, messageDescriptor: { key: `cli.ext.skillError.${suffix[code] ?? "fileConflict"}` } });
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export function skillTargetPath(options: SkillOptions): string {
  const scope = options.scope ?? "user";
  if (!["user", "project"].includes(scope)) throw failure("SKILL_INVALID_SCOPE", "Skill 范围必须是 user 或 project");
  if (options.target && !["codex", "claude", "custom"].includes(options.target)) throw failure("SKILL_INVALID_TARGET", "Skill 宿主必须是 codex、claude 或 custom");
  if (options.directory) return join(resolve(options.directory), PRODUCT);
  if (!options.target || options.target === "custom") throw failure("SKILL_TARGET_REQUIRED", "请选择 Skill 宿主或提供自定义目录");
  const base = scope === "project" ? resolve(options.projectDirectory ?? process.cwd()) : resolve(options.userHome ?? homedir());
  if (options.target === "claude") return join(base, ".claude", "skills", PRODUCT);
  const configured = (options.environment ?? process.env).CODEX_HOME;
  if (scope === "user" && configured && !options.userHome) {
    if (!isAbsolute(configured)) throw failure("SKILL_INVALID_PATH", "CODEX_HOME 必须是绝对路径");
    return join(configured, "skills", PRODUCT);
  }
  return join(base, scope === "project" ? ".agents" : ".codex", "skills", PRODUCT);
}
async function templatePath(): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let index = 0; index < 8; index++) {
    const manifest = join(directory, "package.json");
    if (await exists(manifest)) {
      const data = JSON.parse(await readFile(manifest, "utf8")) as { name?: string };
      if (data.name === PRODUCT) return join(directory, "skills", PRODUCT);
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw failure("SKILL_TEMPLATE_MISSING", "安装包中没有可用的 Skill 模板");
}
async function inventory(directory: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  async function walk(path: string, prefix = ""): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (name === RECORD) continue;
      if (entry.isSymbolicLink()) throw failure("SKILL_SYMLINK_CONFLICT", "Skill 包含符号链接，需先人工处理", { path: name });
      if (entry.isDirectory()) await walk(join(path, entry.name), name);
      else if (entry.isFile()) result.set(name, await readFile(join(path, entry.name)));
      else throw failure("SKILL_FILE_CONFLICT", "Skill 中存在不支持的文件类型", { path: name });
    }
  }
  await walk(directory);
  return result;
}
function hashes(files: Map<string, Buffer>): Record<string, string> {
  return Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => [path, createHash("sha256").update(content).digest("hex")]));
}
function changes(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]).sort();
}
async function installedRecord(path: string): Promise<InstallRecord | undefined> {
  try {
    const recordPath = join(path, RECORD);
    if ((await lstat(recordPath)).isSymbolicLink()) return undefined;
    const value = JSON.parse(await readFile(recordPath, "utf8")) as InstallRecord;
    if (value.product !== PRODUCT || typeof value.version !== "string" || typeof value.files !== "object" || value.files === null || Array.isArray(value.files)) return undefined;
    if (Object.entries(value.files).some(([path, hash]) => path.startsWith("/") || path.split(/[\\/]/).includes("..") || typeof hash !== "string")) return undefined;
    return value;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function manageSkill(action: SkillAction, options: SkillOptions): Promise<SkillResult> {
  const targetPath = skillTargetPath(options);
  const result: SkillResult = { action, status: "missing", targetPath, version: VERSION };
  // 父目录可以是用户已有的共享入口，目标副本本身必须是独立目录。
  if (await exists(targetPath)) {
    const stat = await lstat(targetPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure("SKILL_TARGET_CONFLICT", "Skill 目标不是独立目录", { targetPath });
  }
  const record = await installedRecord(targetPath);
  const current = await exists(targetPath) ? hashes(await inventory(targetPath)) : undefined;
  if (record) result.installedVersion = record.version;
  const conflicts = record && current ? changes(record.files, current) : [];
  if (current) result.status = !record ? "foreign" : conflicts.length ? "modified" : record.version === VERSION ? "current" : "outdated";
  if (conflicts.length) result.conflicts = conflicts;
  const template = action === "remove" ? undefined : await inventory(options.templateDirectory ?? await templatePath());
  if (template && !template.has("SKILL.md")) throw failure("SKILL_TEMPLATE_MISSING", "Skill 模板缺少 SKILL.md");
  if (record && result.status === "current" && template && changes(record.files, hashes(template)).length) result.status = "outdated";
  if (action === "status") return result;
  if (action === "remove" && !current) return result;
  if (action === "remove" && !record) throw failure("SKILL_NOT_MANAGED", "只能移除本产品安装的 Skill 副本", result);
  if ((result.status === "foreign" || conflicts.length) && !options.overwrite) {
    throw failure("SKILL_MODIFIED", "目标目录存在外来内容或用户修改；覆盖前请明确选择备份覆盖", result);
  }
  if (action !== "remove" && result.status === "current") return result;
  if (action === "update" && !record && current) throw failure("SKILL_NOT_MANAGED", "目标 Skill 没有有效安装记录，请使用 install 显式接管", result);
  if (action === "remove") {
    if (conflicts.length) {
      result.backupPath = `${targetPath}.backup-${Date.now()}-${randomUUID().slice(0, 8)}`;
      await rename(targetPath, result.backupPath);
    } else await rm(targetPath, { recursive: true });
    return { ...result, status: "removed" };
  }

  const staging = `${targetPath}.install-${randomUUID()}`;
  await mkdir(dirname(targetPath), { recursive: true });
  await mkdir(staging);
  try {
    for (const [path, content] of template!) {
      const output = join(staging, path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, content);
    }
    await writeFile(join(staging, RECORD), `${JSON.stringify({ product: PRODUCT, version: VERSION, files: hashes(template!) }, null, 2)}\n`);
    // 再核对复制期间的目标变化，保留用户并发编辑。
    if (current && changes(current, hashes(await inventory(targetPath))).length) throw failure("SKILL_MODIFIED", "复制期间目标内容发生变化，请重新预览", result);
    let previous: string | undefined;
    if (current) {
      previous = `${targetPath}.backup-${Date.now()}-${randomUUID().slice(0, 8)}`;
      await rename(targetPath, previous);
    }
    try { await rename(staging, targetPath); } catch (error) {
      if (previous) await rename(previous, targetPath);
      throw error;
    }
    // 覆盖外来副本或用户修改时始终保留恢复材料。
    if (previous && (conflicts.length || !record)) result.backupPath = previous;
    else if (previous) await rm(previous, { recursive: true });
    return { ...result, status: current ? "updated" : "installed" };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
