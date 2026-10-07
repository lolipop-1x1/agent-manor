import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ResourceManagementArchive } from "./resource-management-contracts.js";
import { resourceMaterialFingerprint } from "./resources/management.js";
import { resourceMaterialPath } from "./resources/vault-path.js";
import { readPreferences } from "./service/preferences.js";
import { acquireLock } from "./service/runtime.js";

export class DataMigrationError extends Error {
  constructor(readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new DataMigrationError(code); };
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function futureRealPath(path: string): Promise<string> {
  let parent = path; const suffix: string[] = [];
  while (!await exists(parent)) { suffix.unshift(basename(parent)); parent = dirname(parent); }
  return join(await realpath(parent), ...suffix);
}
const contained = (root: string, path: string): boolean => {
  const value = relative(root, path);
  return value !== "" && value !== ".." && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(value);
};
async function fingerprint(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function restrict(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  await chmod(path, info.isDirectory() ? 0o700 : 0o600);
  if (info.isDirectory()) for (const name of await readdir(path)) await restrict(join(path, name));
}
async function materialParents(vault: string, material: string): Promise<void> {
  let path = vault;
  for (const part of ["", ...relative(vault, dirname(material)).split(sep).filter(Boolean)]) {
    path = join(path, part);
    if (!(await lstat(path)).isDirectory()) fail("RECOVERY_DIRECTORY_INVALID");
  }
}
function healthy(db: Database.Database): void {
  const results = db.pragma("quick_check") as { quick_check: string }[];
  if (results.length !== 1 || results[0]?.quick_check !== "ok") fail("DATABASE_INVALID");
}
interface StoredArchive { public: ResourceManagementArchive; backupHash: string; [key: string]: unknown }

/** 只修改复制后的管理库和材料，原目录始终保留；外部资源路径和材料正文不改写。 */
async function relocateResources(staging: string, roots: string[], to: string): Promise<number> {
  const path = join(staging, "resources.sqlite");
  if (!await exists(path)) return 0;
  const db = new Database(path, { fileMustExist: true });
  try {
    healthy(db);
    const rows = db.prepare("SELECT id,json FROM resource_archives").all() as { id: string; json: string }[];
    const updates: { id: string; json: string }[] = [];
    for (const row of rows) {
      const archive = JSON.parse(row.json) as StoredArchive;
      if (!archive.public.storedPath) continue;
      const from = roots.find(root => contained(join(root, "resource-vault"), archive.public.storedPath!)) ?? fail("RECOVERY_PATH_OUTSIDE_SOURCE");
      const copied = join(staging, relative(from, archive.public.storedPath));
      await materialParents(join(staging, "resource-vault"), copied);
      if (await resourceMaterialFingerprint(copied) !== archive.backupHash || archive.backupHash === "missing") fail("RECOVERY_MATERIAL_INVALID");
      const action = archive.public.state === "disabled" ? "disable"
        : db.prepare("SELECT json FROM resource_operations WHERE id=?").get(archive.public.operationId) as { json: string } | undefined;
      const disabled = action === "disable" || typeof action === "object" && JSON.parse(action.json).action === "disable";
      const destination = resourceMaterialPath(join(to, "resource-vault"), disabled ? "disable" : "trash", archive.public.entry, archive.public.operationId);
      const relocated = join(staging, relative(to, destination));
      await mkdir(dirname(relocated), { recursive: true, mode: 0o700 });
      await materialParents(join(staging, "resource-vault"), relocated);
      if (resolve(copied) !== resolve(relocated)) {
        if (await exists(relocated)) fail("RECOVERY_TARGET_OCCUPIED");
        await rename(copied, relocated);
      }
      archive.public.storedPath = destination;
      updates.push({ id: row.id, json: JSON.stringify(archive) });
    }
    db.transaction(() => {
      for (const row of updates) db.prepare("UPDATE resource_archives SET json=? WHERE id=?").run(row.json, row.id);
      db.prepare("DELETE FROM resource_plans").run();
    })();
    healthy(db); db.pragma("wal_checkpoint(TRUNCATE)");
    return rows.length;
  } finally { db.close(); }
}

/** 服务停止后整体复制并校验，最后发布目标目录；已有目标或任何失败均不覆盖原数据。 */
export async function migrateDataHome(source: string, destination: string,
  progress: (phase: string) => void = () => {}): Promise<{ databases: number; archives: number; sourceRetained: true }> {
  const from = await realpath(source); const to = resolve(destination);
  const roots = [...new Set([from, resolve(source)])];
  if (roots.some(root => root === to || contained(root, to) || contained(to, root))) fail("DIRECTORIES_OVERLAP");
  if (await exists(to)) fail("TARGET_EXISTS");
  const canonicalTo = await futureRealPath(to);
  if (canonicalTo === from || contained(from, canonicalTo) || contained(canonicalTo, from)) fail("DIRECTORIES_OVERLAP");
  if (!await exists(join(from, "index.sqlite"))) fail("SOURCE_INDEX_MISSING");
  let releaseService: (() => Promise<void>) | undefined; let releaseManagement: (() => Promise<void>) | undefined;
  let staging: string | undefined;
  try {
    try { releaseService = await acquireLock(from, "service.lock"); releaseManagement = await acquireLock(from, "resource-management.lock"); }
    catch { fail("SOURCE_IN_USE"); }
    await mkdir(dirname(to), { recursive: true });
    const parent = await realpath(dirname(to));
    if (join(parent, basename(to)) !== canonicalTo) fail("TARGET_PATH_CHANGED");
    staging = join(parent, `.${basename(to)}-migration-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    let databases = 0;
    for (const name of ["index.sqlite", "resources.sqlite"]) {
      if (!await exists(join(from, name))) continue;
      progress(`copy:${name}`);
      for (const file of [name, `${name}-wal`]) {
        const original = join(from, file); if (!await exists(original)) continue;
        if (!(await lstat(original)).isFile()) fail("SOURCE_DATABASE_INVALID");
        const copied = join(staging, file);
        await cp(original, copied, { errorOnExist: true, force: false, mode: constants.COPYFILE_FICLONE });
        await chmod(copied, 0o600);
        if (await fingerprint(original) !== await fingerprint(copied)) fail("COPY_CHECK_FAILED");
      }
      progress(`verify:${name}`);
      const db = new Database(join(staging, name), { fileMustExist: true });
      try { healthy(db); db.pragma("wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
      databases++;
    }
    for (const name of ["preferences.json", "resource-vault"]) if (await exists(join(from, name))) {
      const info = await lstat(join(from, name));
      if (name === "resource-vault" ? !info.isDirectory() : !info.isFile()) fail("SOURCE_DATA_INVALID");
      await cp(join(from, name), join(staging, name), { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    }
    await readPreferences(staging);
    progress("relocate:recovery");
    const archives = await relocateResources(staging, roots, to);
    await restrict(staging);
    if (await exists(to)) fail("TARGET_EXISTS");
    progress("publish");
    await rename(staging, to); staging = undefined;
    return { databases, archives, sourceRetained: true };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await releaseManagement?.(); await releaseService?.();
  }
}
