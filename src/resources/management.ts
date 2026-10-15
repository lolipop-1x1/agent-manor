import type { Client } from "../clients.js";
import type { ResourceKind } from "../resource-contracts.js";
import type { MessageDescriptor } from "../i18n/types.js";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { clientIds } from "../clients.js";
import type { ResourceInventoryEntry, ResourceInventorySnapshot, ResourceManualSource } from "../resource-inventory-contracts.js";
import type {
  ManagedResourceInventorySnapshot, ResourceManagementArchive, ResourceManagementInput, ResourceManagementOperation,
  ResourceManagementOperationQuery, ResourceManagementOperations, ResourceManagementPreview, StoredResourceManualSource,
} from "../resource-management-contracts.js";
import { ServiceError } from "../service/input.js";
import { acquireLock } from "../service/runtime.js";
import { configurationPreview, editableConfig, prepareConfig, restoreConfig } from "./config-editor.js";
import type { ConfigChange } from "./config-editor.js";
import { resourceMaterialPath } from "./vault-path.js";

interface Mode { path: string; mode: number; type: "file" | "directory" | "symlink" }
interface Inspection { hash: string; modes: Mode[]; contentHash: string }
interface Dependency { path: string; hash: string }
interface PrivateArchive { public: ResourceManagementArchive; change?: ConfigChange; modes: Mode[]; backupHash: string }
interface Plan { public: ResourceManagementPreview; entry: ResourceInventoryEntry; dependencies: Dependency[]; references: string;
  archiveId?: string; change?: ConfigChange; restoreText?: string; linkTarget?: { path: string; resolved: string } }
interface JsonRow { json: string }
const digest = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
const decode = <T>(row: JsonRow): T => JSON.parse(row.json) as T;
const stale = (message = "来源或共享入口已变化，请重新生成预览", messageDescriptor: MessageDescriptor = { key: "diagnostics.resources.management.sourceChanged" }): never => { throw new ServiceError("CONTENT_STALE", message, messageDescriptor); };

async function inspect(path: string): Promise<Inspection> {
  const parts: string[] = []; const contents: string[] = []; const modes: Mode[] = [];
  async function walk(current: string): Promise<void> {
    const stat = await lstat(current); const name = relative(path, current);
    const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : undefined;
    if (!type) throw new ServiceError("FORBIDDEN", "资源包含尚未支持的文件类型，只读", { key: "diagnostics.resources.management.m001" });
    const value = type === "symlink" ? await readlink(current) : type === "file" ? digest(await readFile(current)) : "";
    const mode = stat.mode & 0o777; modes.push({ path: name, mode, type });
    contents.push(JSON.stringify([name, type, value])); parts.push(JSON.stringify([name, type, value, mode]));
    if (type === "directory") for (const child of (await readdir(current)).sort()) await walk(join(current, child));
  }
  try { await walk(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hash: "missing", contentHash: "missing", modes: [] }; throw error; }
  return { hash: digest(parts.join("\n")), contentHash: digest(contents.join("\n")), modes };
}
/** 迁移核对恢复材料时复用管理操作的内容校验口径。 */
export async function resourceMaterialFingerprint(path: string): Promise<string> { return (await inspect(path)).contentHash; }
async function permissions(path: string, modes: Mode[], restricted: boolean): Promise<void> {
  for (const item of [...modes].reverse()) if (item.type !== "symlink") await chmod(join(path, item.path), restricted ? item.type === "directory" ? 0o700 : 0o600 : item.mode);
}
function references(snapshot: ResourceInventorySnapshot, entry: ResourceInventoryEntry): ResourceInventoryEntry[] {
  const paths = new Set([entry.entryPath, entry.targetPath].filter((value): value is string => value !== undefined));
  if (entry.kind === "mcp") return snapshot.entries.filter(value => value.kind === "mcp" && (value.bodyId === entry.bodyId
    || value.entryPath === entry.entryPath && (value.server ?? value.name) === (entry.server ?? entry.name)))
    .sort((left, right) => left.id.localeCompare(right.id));
  return snapshot.entries.filter(value => value.bodyId === entry.bodyId || value.entryPath === entry.entryPath
    || value.targetPath !== undefined && paths.has(value.targetPath)
    || value.entryType === "symlink" && value.linkTarget !== undefined && paths.has(resolve(dirname(value.entryPath), value.linkTarget)))
    .sort((left, right) => left.id.localeCompare(right.id));
}
/** 入口隔离保持原范围；共享文件回收另行核验完整的已知引用。 */
function sharedPhysical(entry: ResourceInventoryEntry, refs: readonly ResourceInventoryEntry[]): boolean {
  return entry.kind === "skill" && (entry.entryType === "directory" || entry.entryType === "file") && refs.some(value => value.id !== entry.id);
}
function nameReferences(snapshot: ResourceInventorySnapshot, entry: ResourceInventoryEntry): ResourceInventoryEntry[] {
  const path = entry.locator.controlPath;
  return snapshot.entries.filter(value => value.client === entry.client && value.kind === entry.kind && (value.name === entry.name
    || entry.locator.nativeRule && JSON.stringify(value.locator.nativeRule) === JSON.stringify(entry.locator.nativeRule))
    && (value.locator.controlPath === path || path !== undefined && value.locator.dependencyPaths?.includes(path)))
    .sort((left, right) => left.id.localeCompare(right.id));
}
function revealed(snapshot: ResourceInventorySnapshot, entry: ResourceInventoryEntry): NonNullable<ResourceManagementPreview["revealedEntries"]> {
  return (snapshot.diagnostics ?? []).filter(value => value.reason === "shadowed" && value.client === entry.client && value.kind === entry.kind
    && (value.selectedEntryId === entry.id || value.selectedPath === entry.entryPath && (entry.scope === value.scope && entry.project === value.project
      || entry.selectionScopes?.some(scope => scope.scope === value.scope && scope.project === value.project))))
    .map(value => ({ name: value.name ?? entry.name, client: value.client, scope: value.scope, project: value.project, entryPath: value.path }));
}
function markerShared(entry: ResourceInventoryEntry, refs: readonly ResourceInventoryEntry[]): boolean {
  return entry.locator.nativeControl === "codeflicker-desktop-skill" && refs.some(value => value.id !== entry.id);
}
function nameScopesKnown(entry: ResourceInventoryEntry, snapshot: ResourceInventorySnapshot): boolean {
  const refs = nameReferences(snapshot, entry);
  if (refs.some(value => value.selectionScopes?.some(scope => (entry.locator.nativeRule || entry.scope === "user" || scope.project === entry.project) && scope.nativeState === "unknown"))) return false;
  const dependencies = new Set(entry.locator.dependencyPaths);
  return !snapshot.sources.some(source => (source.client === "codeflicker" || entry.locator.nativeRule && source.client === entry.client) && dependencies.has(source.path)
    && !["ok", "missing"].includes(source.readState));
}
function nativeDisable(entry: ResourceInventoryEntry, snapshot: ResourceInventorySnapshot): boolean {
  if (entry.nativeState === "disabled") return false;
  const control = entry.locator.nativeControl;
  if (control === "native-rule") return entry.nativeState === "enabled" && !!entry.locator.nativeRule && !!entry.locator.controlPath && nameScopesKnown(entry, snapshot);
  if (entry.client === "codex") return entry.scope === "user" && (entry.kind === "skill" ? control === "codex-skill" && !!entry.locator.controlPath
    : control === "codex-mcp" && entry.locator.format === "toml");
  if (entry.client === "codeflicker") return entry.nativeState === "enabled" && (entry.kind === "skill" ? control === "codeflicker-skill" && !!entry.locator.controlPath
    && (!entry.selectionScopes || entry.selectionScopes.some(scope => scope.scope === entry.scope && scope.project === entry.project))
    && nameScopesKnown(entry, snapshot)
    : control === "codeflicker-mcp" && entry.locator.format === "json");
  return entry.client === "codeflicker-desktop" && entry.kind === "skill" && entry.nativeState === "enabled"
    && control === "codeflicker-desktop-skill" && !!entry.locator.controlPath && !markerShared(entry, references(snapshot, entry));
}
const signature = (snapshot: ResourceInventorySnapshot, entry: ResourceInventoryEntry): string => digest(JSON.stringify({ references: references(snapshot, entry)
  .map(value => [value.id, value.entryPath, value.targetPath, value.client, value.project, value.sourceId, value.protected,
    value.owner, value.contentFingerprint, value.locator, value.selectionScopes, snapshot.sources.find(source => source.id === value.sourceId)?.verified]),
  diagnostics: entry.client === "codeflicker" ? snapshot.diagnostics?.filter(value => value.name === entry.name && value.client === entry.client && value.kind === entry.kind) : undefined,
  nameReferences: entry.client === "codeflicker" || entry.locator.nativeRule ? nameReferences(snapshot, entry).map(value => [value.id, value.sourceId, value.locator, value.selectionScopes]) : undefined }));

/** 管理状态与受限恢复材料独立保存，不因历史索引清理而丢失或重放操作。 */
export class ResourceManager {
  readonly dbPath: string;
  readonly vaultPath: string;
  private readonly database: Database.Database;
  private readonly home: string;

  constructor(home: string) {
    this.home = resolve(home); this.dbPath = join(this.home, "resources.sqlite"); this.vaultPath = join(this.home, "resource-vault");
    mkdirSync(this.home, { recursive: true, mode: 0o700 }); mkdirSync(this.vaultPath, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.vaultPath).isDirectory()) throw new TypeError("恢复目录根不能是符号链接");
    chmodSync(this.vaultPath, 0o700);
    if (!existsSync(this.dbPath)) writeFileSync(this.dbPath, "", { flag: "wx", mode: 0o600 });
    chmodSync(this.dbPath, 0o600); this.database = new Database(this.dbPath);
    this.database.pragma("journal_mode = WAL"); this.database.pragma("busy_timeout = 5000");
    this.database.exec(`CREATE TABLE IF NOT EXISTS resource_favorites(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS resource_manual_sources(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resource_seen(id TEXT PRIMARY KEY,first_seen TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resource_plans(id TEXT PRIMARY KEY,expires_at TEXT NOT NULL,consumed INTEGER NOT NULL DEFAULT 0,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resource_operations(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resource_archives(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,state TEXT NOT NULL,phase TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS resource_operation_order ON resource_operations(created_at);
      CREATE INDEX IF NOT EXISTS resource_archive_operation ON resource_archives(operation_id);`);
    this.database.prepare("UPDATE resource_archives SET phase='partial' WHERE phase='prepared'").run();
    this.database.prepare("DELETE FROM resource_plans WHERE expires_at<?").run(new Date().toISOString());
  }
  close(): void { this.database.close(); }
  favorites(): string[] { return (this.database.prepare("SELECT id FROM resource_favorites ORDER BY id").all() as { id: string }[]).map(row => row.id); }
  setFavorite(id: string, value: boolean): void {
    if (typeof id !== "string" || !id || id.length > 4096 || typeof value !== "boolean") throw new ServiceError("INVALID_INPUT", "收藏参数无效", { key: "diagnostics.resources.management.m002" });
    if (value) this.database.prepare("INSERT OR IGNORE INTO resource_favorites(id) VALUES(?)").run(id);
    else this.database.prepare("DELETE FROM resource_favorites WHERE id=?").run(id);
  }
  manualSources(): StoredResourceManualSource[] {
    return (this.database.prepare("SELECT json FROM resource_manual_sources ORDER BY rowid").all() as JsonRow[]).map(row => decode(row));
  }
  addManualSource(input: ResourceManualSource): StoredResourceManualSource {
    if (!input || !clientIds.includes(input.client) || !["skill", "mcp"].includes(input.kind) || typeof input.path !== "string" || !isAbsolute(input.path)
      || input.path.includes("\0") || input.project !== undefined && (typeof input.project !== "string" || !isAbsolute(input.project))
      || input.keyPath !== undefined && (!Array.isArray(input.keyPath) || input.keyPath.some(key => typeof key !== "string" || !key))
      || input.format !== undefined && !["skill-directory", "skill-files", "json", "jsonc", "toml", "plugin", "unsupported"].includes(input.format)) {
      throw new ServiceError("INVALID_INPUT", "手动来源必须指定已知客户端、类型及绝对路径", { key: "diagnostics.resources.management.m003" });
    }
    const value: StoredResourceManualSource = { id: randomUUID(), client: input.client, kind: input.kind, path: resolve(input.path),
      project: input.project, format: input.format, keyPath: input.keyPath };
    const existing = this.manualSources().find(source => source.client === value.client && source.kind === value.kind && source.path === value.path
      && source.project === value.project && JSON.stringify(source.keyPath) === JSON.stringify(value.keyPath));
    if (existing) return existing;
    this.database.prepare("INSERT INTO resource_manual_sources(id,json) VALUES(?,?)").run(value.id, JSON.stringify(value)); return value;
  }
  removeManualSource(id: string): void {
    if (!this.database.prepare("DELETE FROM resource_manual_sources WHERE id=?").run(id).changes) throw new ServiceError("SOURCE_NOT_FOUND", "手动来源不存在", { key: "diagnostics.resources.management.m004" });
  }
  observeInventory(snapshot: ResourceInventorySnapshot): void {
    const insert = this.database.prepare("INSERT OR IGNORE INTO resource_seen(id,first_seen) VALUES(?,?)");
    this.database.transaction(() => { for (const entry of snapshot.entries) insert.run(entry.id, snapshot.observedAt); })();
  }
  private writable(entry: ResourceInventoryEntry, snapshot: ResourceInventorySnapshot): boolean {
    const source = snapshot.sources.find(value => value.id === entry.sourceId);
    return !entry.protected && !entry.owner && (source?.verified === true || entry.locator.nativeRule !== undefined) && source?.client === entry.client && source.kind === entry.kind
      && !["plugin", "system", "managed"].includes(source.origin)
      && (["codex", "claude"].includes(entry.client) || entry.client === "codeflicker" && ["codeflicker-skill", "codeflicker-mcp"].includes(entry.locator.nativeControl ?? "")
        || entry.client === "codeflicker-desktop" && entry.kind === "skill" && entry.locator.nativeControl === "codeflicker-desktop-skill"
        || !!entry.locator.nativeRule || entry.locator.registrationWritable === true)
      && entry.readState !== "unreadable";
  }
  private fileWritable(entry: ResourceInventoryEntry, snapshot: ResourceInventorySnapshot): boolean {
    const source = snapshot.sources.find(value => value.id === entry.sourceId);
    return entry.kind === "skill" && !entry.protected && !entry.owner && source?.verified === true
      && source.client === entry.client && source.kind === entry.kind && !["plugin", "system", "managed"].includes(source.origin)
      && entry.readState !== "unreadable" && ["directory", "file", "symlink"].includes(entry.entryType)
      && !references(snapshot, entry).some(value => value.protected || value.owner);
  }
  private favorite(entry: ResourceInventoryEntry, snapshot: ResourceInventorySnapshot): boolean {
    const favorites = new Set(this.favorites());
    return favorites.has(entry.bodyId) || favorites.has(entry.id) || references(snapshot, entry).some(value => favorites.has(value.id)
      || "favorite" in value && value.favorite === true);
  }
  decorateInventory(snapshot: ResourceInventorySnapshot): ManagedResourceInventorySnapshot {
    this.observeInventory(snapshot);
    const favorites = new Set(this.favorites()); const seen = new Map((this.database.prepare("SELECT id,first_seen FROM resource_seen").all() as { id: string; first_seen: string }[])
      .map(row => [row.id, row.first_seen]));
    const archives = this.archives(); const texts = new Map<string, string | undefined>(); const editability = new Map<string, boolean>();
    return { ...snapshot, entries: snapshot.entries.map(entry => {
      const writable = this.writable(entry, snapshot);
      let disable = writable && nativeDisable(entry, snapshot);
      const path = entry.locator.controlPath ?? entry.locator.configPath;
      if (writable && path && !texts.has(path)) {
        try { texts.set(path, existsSync(path) ? readFileSync(path, "utf8") : entry.kind === "skill" || entry.locator.nativeRule ? "" : undefined); }
        catch { texts.set(path, undefined); }
      }
      const editKey = JSON.stringify([writable, entry.kind, entry.locator.nativeControl, path, entry.locator.keyPath]);
      if (!editability.has(editKey)) editability.set(editKey, writable && path !== undefined && texts.get(path) !== undefined && editableConfig(texts.get(path)!, entry));
      const configWritable = editability.get(editKey)!;
      disable = disable && configWritable;
      const refs = references(snapshot, entry);
      const source = snapshot.sources.find(value => value.id === entry.sourceId);
      let registrationEditable = configWritable;
      if (entry.kind === "mcp" && entry.locator.nativeRule) {
        const configPath = entry.locator.configPath;
        try { registrationEditable = !!configPath && editableConfig(readFileSync(configPath, "utf8"), { ...entry, locator: { ...entry.locator, nativeRule: undefined } }); }
        catch { registrationEditable = false; }
      }
      const isolation = writable && source?.verified === true && (entry.kind === "skill" || registrationEditable && (!entry.locator.nativeRule || entry.locator.registrationWritable === true)) && !sharedPhysical(entry, refs);
      const trash = entry.kind === "skill" ? this.fileWritable(entry, snapshot) : isolation;
      const archive = archives.find(value => (value.entry.id === entry.id || value.target === "file"
        && (value.entry.bodyId === entry.bodyId || value.affectedEntries?.some(affected => affected.id === entry.id)))
        && !["restored", "purged"].includes(value.state));
      return { ...entry, favorite: favorites.has(entry.id) || favorites.has(entry.bodyId), firstSeenAt: seen.get(entry.id)!, managementState: archive?.state ?? "active",
        capabilities: { ...entry.capabilities, disable, standby: isolation, trash, restore: !!archive?.restorable, purge: !!archive?.restorable } };
    }) };
  }
  archives(state?: ResourceManagementArchive["state"]): ResourceManagementArchive[] {
    const filter = state === "trash" ? " AND state IN ('trash','standby')" : state ? " AND state=?" : "";
    const rows = this.database.prepare(`SELECT json FROM resource_archives WHERE phase<>'prepared'${filter} ORDER BY rowid DESC`)
      .all(...(state && state !== "trash" ? [state] : [])) as JsonRow[];
    return rows.map(row => decode<PrivateArchive>(row).public);
  }
  /** 管理候选覆盖完整记录和共享本体关联入口，不受列表分页影响。 */
  clientOptions(): { kind: ResourceKind; client: Client; view: "disabled" | "trash" | "operations" }[] {
    return this.database.prepare(`
      SELECT DISTINCT json_extract(json,'$.resource.kind') AS kind,json_extract(json,'$.resource.client') AS client,'operations' AS view
      FROM resource_operations
      UNION SELECT json_extract(o.json,'$.resource.kind'),json_extract(ref.value,'$.client'),'operations'
      FROM resource_operations o,json_each(o.json,'$.affectedEntries') ref WHERE json_extract(o.json,'$.target')='file'
      UNION SELECT json_extract(json,'$.public.entry.kind'),json_extract(json,'$.public.entry.client'),CASE WHEN state='disabled' THEN 'disabled' ELSE 'trash' END
      FROM resource_archives WHERE phase<>'prepared' AND state IN ('disabled','standby','trash')
      UNION SELECT json_extract(a.json,'$.public.entry.kind'),json_extract(ref.value,'$.client'),CASE WHEN a.state='disabled' THEN 'disabled' ELSE 'trash' END
      FROM resource_archives a,json_each(a.json,'$.public.affectedEntries') ref
      WHERE a.phase<>'prepared' AND a.state IN ('disabled','standby','trash') AND json_extract(a.json,'$.public.target')='file'
    `).all() as { kind: ResourceKind; client: Client; view: "disabled" | "trash" | "operations" }[];
  }
  operations(page = 1, pageSize = 50, query: ResourceManagementOperationQuery = {}): ResourceManagementOperations {
    page = Math.max(1, Math.floor(page)); pageSize = Math.min(200, Math.max(1, Math.floor(pageSize)));
    const parts: string[] = []; const values: string[] = [];
    for (const [field, value] of [["kind", query.kind], ["client", query.client], ["project", query.project]] as const) if (value !== undefined) {
      const shared = field !== "kind" ? ` OR (json_extract(resource_operations.json,'$.target')='file' AND EXISTS (SELECT 1 FROM json_each(json_extract(resource_operations.json,'$.affectedEntries')) ref WHERE json_extract(ref.value,'$.${field}')${field === "project" && value === "none" ? " IS NULL" : "=?"}))` : "";
      if (field === "project" && value === "none") parts.push(`(json_extract(resource_operations.json,'$.resource.project') IS NULL${shared})`);
      else { parts.push(`(json_extract(resource_operations.json,'$.resource.${field}')=?${shared})`); values.push(value); if (shared) values.push(value); }
    }
    if (query.q?.trim()) {
      parts.push("(json_extract(resource_operations.json,'$.name') LIKE ? ESCAPE '\\' OR (json_extract(resource_operations.json,'$.target')='file' AND EXISTS (SELECT 1 FROM json_each(json_extract(resource_operations.json,'$.affectedEntries')) ref WHERE json_extract(ref.value,'$.name') LIKE ? ESCAPE '\\' OR json_extract(ref.value,'$.entryPath') LIKE ? ESCAPE '\\')))");
      const pattern = `%${query.q.trim().replace(/[\\%_]/g, "\\$&")}%`; values.push(pattern, pattern, pattern);
    }
    const filter = parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
    const total = (this.database.prepare(`SELECT COUNT(*) AS total FROM resource_operations${filter}`).get(...values) as { total: number }).total;
    const operations = (this.database.prepare(`SELECT json FROM resource_operations${filter} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`)
      .all(...values, pageSize, (page - 1) * pageSize) as JsonRow[]).map(row => decode<ResourceManagementOperation>(row));
    return { operations, total, page, pageSize };
  }
  private archive(operationId: string): PrivateArchive {
    const row = this.database.prepare("SELECT json FROM resource_archives WHERE operation_id=? AND phase<>'prepared'").get(operationId) as JsonRow | undefined;
    if (!row) throw new ServiceError("SOURCE_NOT_FOUND", "恢复材料不存在", { key: "diagnostics.resources.management.m005" }); return decode(row);
  }
  async preview(input: ResourceManagementInput, snapshot: ResourceInventorySnapshot): Promise<ResourceManagementPreview> {
    if (!input || !["disable", "standby", "trash", "restore", "purge"].includes(input.action)
      || (input.action === "restore" || input.action === "purge" ? !input.operationId || !!input.entryId : !input.entryId || !!input.operationId)) {
      throw new ServiceError("INVALID_INPUT", "操作必须指定所选入口或恢复记录", { key: "diagnostics.resources.management.m006" });
    }
    const archive = input.operationId ? this.archive(input.operationId) : undefined;
    const entry = archive?.public.entry ?? snapshot.entries.find(value => value.id === input.entryId);
    if (!entry) throw new ServiceError("SOURCE_NOT_FOUND", "资源入口不存在", { key: "diagnostics.resources.management.m007" });
    if (entry.protected || entry.owner) throw new ServiceError("FORBIDDEN", "系统或插件受管理资源只读", { key: "diagnostics.resources.management.m008" });
    if (archive && (input.action === "restore" ? !archive.public.restorable : !archive.public.storedPath || archive.public.state === "purged")) {
      throw new ServiceError("INVALID_INPUT", "该记录已恢复或永久清除，所选操作不可用", { key: "diagnostics.resources.management.m009" });
    }
    const id = randomUUID(); const createdAt = new Date().toISOString(); const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const refs = references(snapshot, entry); const dependencies: Dependency[] = [];
    const target = archive?.public.target ?? (entry.kind === "skill" && input.action === "trash"
      && ["directory", "file"].includes(entry.entryType) ? "file" : "entry");
    if (target === "file" && refs.some(value => value.protected || value.owner)) {
      throw new ServiceError("FORBIDDEN", "系统或插件受管理资源只读", { key: "diagnostics.resources.management.m008" });
    }
    if (sharedPhysical(entry, refs) && (input.action === "standby" || input.action === "restore" && !archive?.change && target !== "file")) {
      throw new ServiceError("FORBIDDEN", "该物理本体有其他已发现入口引用，隔离或恢复范围尚未核验，请选择符号链接入口或原生停用", { key: "diagnostics.resources.management.m010" });
    }
    const check = async (path: string) => { if (!dependencies.some(value => value.path === path)) dependencies.push({ path, hash: (await inspect(path)).hash }); };
    for (const path of entry.locator.dependencyPaths ?? []) await check(path);
    let change: ConfigChange | undefined; let restoreText: string | undefined; let linkTarget: Plan["linkTarget"];
    let sourcePath = entry.entryPath; let destinationPath: string | undefined;
    let method: ResourceManagementPreview["method"] = input.action === "disable" ? "native_toggle" : entry.kind === "mcp" ? "registration_remove" : "entry_isolation";
    if (archive) {
      sourcePath = archive.public.storedPath!; method = input.action === "restore" ? "restore" : "permanent_purge";
      await check(sourcePath);
      if ((await inspect(sourcePath)).contentHash !== archive.backupHash) stale("恢复材料已变化，请检查操作记录", { key: "diagnostics.resources.management.m011" });
      if (input.action === "restore") {
        for (const reference of refs) await check(reference.entryPath);
        destinationPath = archive.public.originalPath;
        await check(destinationPath);
        if (archive.change) {
          if ((await inspect(destinationPath)).modes[0]?.type === "symlink") throw new ServiceError("FORBIDDEN", "共享配置链接的恢复写入能力尚未核验，只读", { key: "diagnostics.resources.management.m012" });
          try { restoreText = restoreConfig(archive.change, await readFile(destinationPath, "utf8")); }
          catch (error) { if (error instanceof ServiceError) throw error; stale("配置无法读取，恢复不会覆盖现有文件", { key: "diagnostics.resources.management.m013" }); }
        } else {
          if ((await inspect(destinationPath)).hash !== "missing") stale("原位置已被占用，恢复不会覆盖现有资源", { key: "diagnostics.resources.management.m014" });
          if (entry.entryType === "symlink") {
            const path = resolve(dirname(destinationPath), await readlink(sourcePath));
            try { linkTarget = { path, resolved: await realpath(path) }; }
            catch { stale("链接目标已不存在，请先恢复目标文件", { key: "diagnostics.resources.management.linkTargetMissing" }); }
          }
        }
      }
    } else {
      const writable = input.action === "trash" && entry.kind === "skill" ? this.fileWritable(entry, snapshot) : this.writable(entry, snapshot);
      if (!writable) throw new ServiceError("FORBIDDEN", "该来源没有已核验的写入能力，只读", { key: "diagnostics.resources.management.m015" });
      if (input.action === "disable" && !nativeDisable(entry, snapshot)) {
        throw new ServiceError(entry.nativeState === "disabled" ? "INVALID_INPUT" : "FORBIDDEN", entry.nativeState === "disabled" ? "资源已停用，没有新的本地修改" : "该入口未适配原生停用，可检查明确的隔离操作", entry.nativeState === "disabled" ? { key: "diagnostics.resources.management.m016" } : { key: "diagnostics.resources.management.m017" });
      }
      await check(entry.entryPath);
      for (const reference of refs) await check(reference.entryPath);
      if (input.action === "standby" || input.action === "trash") for (const value of revealed(snapshot, entry)) await check(value.entryPath);
      if (entry.kind === "mcp" || input.action === "disable") {
        const skillPath = entry.kind === "skill" ? await realpath(entry.locator.skillFile ?? join(entry.entryPath, "SKILL.md")) : undefined;
        try { change = await prepareConfig(entry, input.action as "disable" | "standby" | "trash", skillPath); }
        catch (error) { if (error instanceof ServiceError) throw error; throw new ServiceError("FORBIDDEN", "配置无法可靠读取或编辑，当前保持只读", { key: "diagnostics.resources.management.m018" }); }
        const file = await inspect(change.path);
        if (file.modes[0]?.type === "symlink") throw new ServiceError("FORBIDDEN", "共享配置链接的写入能力尚未核验，只读", { key: "diagnostics.resources.management.m019" });
        if ((file.hash === "missing" ? "" : await readFile(change.path, "utf8")) !== change.beforeText) stale();
        await check(change.path); sourcePath = change.path;
      }
      destinationPath = resourceMaterialPath(this.vaultPath, input.action, entry, id);
    }
    const favorite = this.favorite(entry, snapshot);
    const affected = input.action === "disable" && (entry.locator.nativeControl === "codeflicker-skill" || entry.locator.nativeRule) ? nameReferences(snapshot, entry)
      : entry.entryType === "symlink" && (input.action === "trash" || archive && !archive.change)
        ? [entry, ...refs.filter(value => value.entryPath === entry.entryPath && value.id !== entry.id)] : refs;
    const revealedEntries = input.action === "standby" || input.action === "trash" ? revealed(snapshot, entry) : undefined;
    const preview: ResourceManagementPreview = { id, action: input.action, entryId: entry.id, operationId: input.operationId,
      resource: { name: entry.name, kind: entry.kind, client: entry.client, scope: entry.scope, project: entry.project }, method, target,
      sourcePath, destinationPath, configuration: change ? configurationPreview(change)
        : input.action === "restore" && archive?.change ? configurationPreview(archive.change, true) : undefined,
      affectedEntries: affected.flatMap(value => {
        const scopes = value.selectionScopes?.filter(scope => !(input.action === "disable" && entry.locator.nativeControl === "codeflicker-skill" && entry.scope === "project")
          || scope.project === entry.project) ?? [{ scope: value.scope, project: value.project }];
        return scopes.map(scope => ({ id: value.id, name: value.name, client: value.client, scope: scope.scope, project: scope.project, entryPath: value.entryPath }));
      }), revealedEntries, referencesComplete: false,
      protected: favorite, protectionReasons: favorite ? ["favorite"] : [],
      restoration: input.action === "purge" ? "永久清除本次恢复材料后将失去该恢复路径；其他副本可能仍存在" : "保存原位置及受限恢复材料；恢复冲突时不覆盖当前内容", restorationDescriptor: input.action === "purge" ? { key: "diagnostics.resources.management.m020" } : { key: "diagnostics.resources.management.m021" },
      createdAt, expiresAt, requiresConfirmation: true, clientEffect: input.action === "purge" ? "unknown" : "pending_reload" };
    if ((target === "file" || entry.entryType === "symlink" && !archive?.change) && archive?.public.affectedEntries) preview.affectedEntries = [...new Map(
      [...archive.public.affectedEntries, ...preview.affectedEntries].map(value => [JSON.stringify([value.id, value.scope, value.project, value.entryPath]), value])).values()];
    const plan: Plan = { public: preview, entry, dependencies, references: signature(snapshot, entry), archiveId: archive?.public.id, change, restoreText, linkTarget };
    this.database.prepare("INSERT INTO resource_plans(id,expires_at,json) VALUES(?,?,?)").run(id, expiresAt, JSON.stringify(plan)); return preview;
  }

  private saveOperation(value: ResourceManagementOperation): void {
    this.database.prepare("INSERT INTO resource_operations(id,created_at,json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json")
      .run(value.id, value.createdAt, JSON.stringify(value));
  }
  private saveArchive(value: PrivateArchive, phase: string): void {
    this.database.prepare(`INSERT INTO resource_archives(id,operation_id,state,phase,json) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,phase=excluded.phase,json=excluded.json`)
      .run(value.public.id, value.public.operationId, value.public.state, phase, JSON.stringify(value));
  }
  private async createMaterialDirectory(directory: string): Promise<void> {
    const subpath = relative(this.vaultPath, directory);
    if (!subpath || isAbsolute(subpath) || subpath === ".." || subpath.startsWith(`..${sep}`)) {
      throw new TypeError("恢复材料必须保存在本地回收目录内");
    }
    let current = this.vaultPath;
    if (!(await lstat(current)).isDirectory()) throw new TypeError("恢复目录根不能是符号链接");
    await chmod(current, 0o700);
    const parts = subpath.split(sep);
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      await mkdir(current, { recursive: true, mode: 0o700 });
      if (!(await lstat(current)).isDirectory()) throw new TypeError("恢复目录包含未经核验的链接");
      await chmod(current, 0o700);
    }
    await mkdir(directory, { mode: 0o700 });
  }
  private async writeConfig(path: string, text: string, dependency: Dependency): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.agent-manor-${randomUUID()}.tmp`;
    const original = await inspect(path);
    if (original.hash !== dependency.hash) stale();
    const mode = original.modes[0]?.mode ?? 0o600;
    try {
      await writeFile(temp, text, { flag: "wx", mode }); await chmod(temp, mode);
      if ((await inspect(path)).hash !== dependency.hash) stale();
      await rename(temp, path);
    } finally { await rm(temp, { force: true }); }
  }
  async apply(previewId: string, confirmed: true, snapshot: ResourceInventorySnapshot): Promise<ResourceManagementOperation> {
    if (confirmed !== true) throw new ServiceError("INVALID_INPUT", "执行需要明确确认该次具体预览", { key: "diagnostics.resources.management.m022" });
    const release = await acquireLock(this.home, "resource-management.lock", 5000);
    try {
      const row = this.database.prepare("SELECT json,consumed FROM resource_plans WHERE id=?").get(previewId) as (JsonRow & { consumed: number }) | undefined;
      if (!row) throw new ServiceError("SOURCE_NOT_FOUND", "预览不存在或已经过期", { key: "diagnostics.resources.management.m023" });
      if (row.consumed) throw new ServiceError("CONTENT_STALE", "该预览已执行，请重新生成预览", { key: "diagnostics.resources.management.m024" });
      const plan = decode<Plan>(row); const preview = plan.public;
      const operation: ResourceManagementOperation = { id: randomUUID(), previewId, action: preview.action, entryId: preview.entryId,
        name: preview.resource.name, resource: { kind: plan.entry.kind, client: plan.entry.client, scope: plan.entry.scope, project: plan.entry.project },
        status: "partial", message: "执行尚未确认完成，恢复材料保留", messageDescriptor: { key: "diagnostics.resources.management.m025" }, createdAt: new Date().toISOString(), localState: "partial", clientEffect: "unknown",
        target: preview.target, affectedEntries: preview.affectedEntries };
      this.database.prepare("UPDATE resource_plans SET consumed=1 WHERE id=?").run(previewId);
      let saved: PrivateArchive | undefined; let mutationStarted = false; let createdBackupDirectory: string | undefined;
      try {
        if (Date.parse(preview.expiresAt) < Date.now()) stale("预览已过期，请重新生成预览", { key: "diagnostics.resources.management.m026" });
        if (this.favorite(plan.entry, snapshot) !== preview.protected) stale("保护状态已变化，请重新生成预览", { key: "diagnostics.resources.management.m027" });
        if (signature(snapshot, plan.entry) !== plan.references) stale();
        if (sharedPhysical(plan.entry, references(snapshot, plan.entry))
          && preview.target !== "file" && (preview.method === "entry_isolation" || preview.action === "restore" && plan.restoreText === undefined)) {
          stale("该物理本体有其他已发现入口引用，隔离或恢复范围尚未核验，请重新检查入口", { key: "diagnostics.resources.management.m028" });
        }
        for (const dependency of plan.dependencies) if ((await inspect(dependency.path)).hash !== dependency.hash) stale();
        if (plan.linkTarget) {
          const current = await realpath(plan.linkTarget.path).catch(() => stale());
          if (current !== plan.linkTarget.resolved) stale();
        }
        if (plan.archiveId) {
          saved = this.archive(preview.operationId!);
          if (preview.action === "restore" ? !saved.public.restorable : !saved.public.storedPath || saved.public.state === "purged") stale("该恢复记录已变化，请重新生成预览", { key: "diagnostics.resources.management.m029" });
          this.saveOperation(operation);
          mutationStarted = true;
          if (preview.action === "purge") {
            await rm(dirname(saved.public.storedPath!), { recursive: true, force: false });
            saved = { public: { ...saved.public, state: "purged", restorable: false, storedPath: undefined, operationStatus: "success" }, modes: [], backupHash: "missing" };
          } else if (saved.change) {
            const dependency = plan.dependencies.find(value => value.path === saved!.public.originalPath)!;
            if (saved.change.fileExistedBefore === false && plan.restoreText === "") {
              if ((await inspect(saved.public.originalPath)).hash !== dependency.hash) stale();
              await rm(saved.public.originalPath, { force: false });
            } else await this.writeConfig(saved.public.originalPath, plan.restoreText!, dependency);
            saved.public.state = "restored"; saved.public.restorable = false; saved.public.operationStatus = "success";
          } else {
            const material = saved.public.storedPath!; const destination = saved.public.originalPath;
            if ((await inspect(destination)).hash !== "missing") stale("原位置已被占用，恢复不会覆盖现有资源", { key: "diagnostics.resources.management.m014" });
            await mkdir(dirname(destination), { recursive: true });
            const root = saved.modes.find(value => !value.path)!;
            if (root.type === "symlink") await symlink(await readlink(material), destination);
            else if (root.type === "file") await copyFile(material, destination, constants.COPYFILE_EXCL);
            else {
              await mkdir(destination);
              for (const child of await readdir(material)) await cp(join(material, child), join(destination, child),
                { recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true });
            }
            await permissions(destination, saved.modes, false);
            if ((await inspect(destination)).contentHash !== saved.backupHash) throw new ServiceError("INTERNAL_ERROR", "恢复内容未通过校验，恢复材料继续保留", { key: "diagnostics.resources.management.m030" });
            saved.public.state = "restored"; saved.public.restorable = false; saved.public.operationStatus = "success";
          }
          this.saveArchive(saved, "complete"); operation.archiveId = saved.public.id;
        } else {
          const directory = dirname(preview.destinationPath!); const material = preview.destinationPath!;
          await this.createMaterialDirectory(directory);
          createdBackupDirectory = directory;
          const original = await inspect(preview.sourcePath);
          if (plan.change) await writeFile(material, plan.change.beforeText, { flag: "wx", mode: 0o600 });
          else await cp(preview.sourcePath, material, { recursive: true, force: false, errorOnExist: true, dereference: false, verbatimSymlinks: true });
          const backup = await inspect(material);
          if (plan.change ? digest(await readFile(material)) !== digest(plan.change.beforeText) : backup.contentHash !== original.contentHash) {
            throw new ServiceError("INTERNAL_ERROR", "恢复材料校验失败，未修改来源", { key: "diagnostics.resources.management.m031" });
          }
          await permissions(material, backup.modes, true);
          for (const dependency of plan.dependencies) if ((await inspect(dependency.path)).hash !== dependency.hash) stale();
          saved = { public: { id: randomUUID(), operationId: operation.id, entry: plan.entry,
            state: preview.action === "disable" ? "disabled" : preview.action === "standby" ? "standby" : "trash",
            originalPath: preview.sourcePath, storedPath: material, createdAt: operation.createdAt, restorable: true, operationStatus: "partial",
            target: preview.target, affectedEntries: preview.affectedEntries },
            change: plan.change, modes: original.modes, backupHash: (await inspect(material)).contentHash };
          this.saveArchive(saved, "prepared"); operation.archiveId = saved.public.id; this.saveOperation(operation);
          mutationStarted = true;
          if (plan.change) await this.writeConfig(plan.change.path, plan.change.afterText, plan.dependencies.find(value => value.path === plan.change!.path)!);
          else await rm(plan.entry.entryPath, { recursive: plan.entry.entryType === "directory", force: false });
          saved.public.operationStatus = "success"; this.saveArchive(saved, "complete");
        }
        operation.status = "success"; operation.message = preview.action === "purge" ? "本次恢复材料已永久清除" : "本地修改完成，客户端待重新加载"; operation.messageDescriptor = preview.action === "purge" ? { key: "diagnostics.resources.management.m032" } : { key: "diagnostics.resources.management.m033" };
        operation.localState = "changed"; operation.clientEffect = preview.action === "purge" ? "unknown" : "pending_reload";
      } catch (error) {
        const unchanged = plan.archiveId ? !mutationStarted : (await inspect(preview.sourcePath).catch(() => undefined))?.hash === plan.dependencies.find(value => value.path === preview.sourcePath)?.hash;
        const conflict = error instanceof ServiceError && error.code === "CONTENT_STALE";
        operation.status = conflict ? "conflict" : mutationStarted && !unchanged ? "partial" : "failure";
        operation.message = error instanceof ServiceError ? error.message : "本地操作未完成；未确认客户端生效，请检查来源及恢复材料"; operation.messageDescriptor = error instanceof ServiceError ? error.messageDescriptor : { key: "diagnostics.resources.management.m034" };
        operation.localState = !conflict && mutationStarted && !unchanged ? "partial" : "unchanged";
        if (saved && operation.localState === "partial") { saved.public.operationStatus = "partial"; this.saveArchive(saved, "partial"); }
        else if (saved && !plan.archiveId) { this.database.prepare("DELETE FROM resource_archives WHERE id=?").run(saved.public.id); operation.archiveId = undefined; }
        if (!plan.archiveId && operation.localState === "unchanged" && createdBackupDirectory) {
          try { await rm(createdBackupDirectory, { recursive: true, force: true }); }
          catch { operation.message += "；未使用备份的清理未完成"; operation.details = [{ key: "diagnostics.resources.management.backupCleanupIncomplete" }]; }
        }
      }
      this.saveOperation(operation);
      // 已执行的私有预览不再保留配置副本，恢复材料由独立档案持有。
      this.database.prepare("UPDATE resource_plans SET json=? WHERE id=?").run(JSON.stringify({ public: preview }), previewId);
      return operation;
    } finally { await release(); }
  }
}
