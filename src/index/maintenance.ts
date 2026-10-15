import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, statfs, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IndexMaintenanceResult } from "../contracts.js";
import { DiagnosticError } from "../i18n/diagnostics.js";
import { INDEX_SCHEMA_VERSION } from "./schema.js";
import { prepareSearchIndex } from "../sessions/search-index.js";

const activityPath = (home: string) => join(home, "index-maintenance-active.json");
const successPath = (home: string) => join(home, "index-maintenance.json");
interface Activity { pid: number; nonce: string; startedAt: string; phase?: "validating" | "compacting" | "verifying" }
export interface MaintenanceStatistics { pageSize: number; pageCount: number; freePages: number }


function statistics(database: Database.Database): MaintenanceStatistics {
  return { pageSize: database.pragma("page_size", { simple: true }) as number,
    pageCount: database.pragma("page_count", { simple: true }) as number,
    freePages: database.pragma("freelist_count", { simple: true }) as number };
}

function result(reason: IndexMaintenanceResult["reason"], status: IndexMaintenanceResult["status"] = "skipped", values: Partial<IndexMaintenanceResult> = {}): IndexMaintenanceResult {
  return { status, reason, messageDescriptor: { key: `diagnostics.index.maintenance.${reason}` }, ...values };
}

function quoted(value: string): string { return '"' + value.replaceAll('"', '""') + '"'; }

/** 同时验证显式消息身份、FTS 文档键和全部逻辑行，避免只比较消息数量。 */
function logicalFingerprint(database: Database.Database): string {
  if (database.pragma("quick_check", { simple: true }) !== "ok" || (database.pragma("foreign_key_check") as unknown[]).length) {
    throw new Error("SQLite integrity check failed");
  }
  const tables = database.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
  if (tables.some(table => table.name === "session_messages")) {
    const columns = database.pragma("table_info(session_messages)") as { name: string; type: string; pk: number }[];
    if (!columns.some(column => column.name === "message_key" && column.type === "INTEGER" && column.pk === 1)) throw new Error("Stable message keys are required");
    for (const [table, state] of [["session_message_search", "session_search_state"], ["session_character_search", "session_character_search_state"]]) {
      if (!tables.some(item => item.name === table)) continue;
      database.prepare(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`).run();
      const complete = (database.prepare(`SELECT complete FROM ${state} WHERE id=1`).get() as { complete: number } | undefined)?.complete;
      const orphan = database.prepare(`SELECT rowid FROM ${table} EXCEPT SELECT message_key FROM session_messages LIMIT 1`).get();
      const missing = complete && database.prepare(`SELECT message_key FROM session_messages EXCEPT SELECT rowid FROM ${table} LIMIT 1`).get();
      if (orphan || missing) throw new Error("FTS document keys do not match message keys");
    }
  }
  const hash = createHash("sha256");
  for (const table of tables) {
    const columns = database.pragma(`table_info(${quoted(table.name)})`) as { name: string; pk: number }[];
    const primary = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => quoted(column.name));
    const fts = /^CREATE VIRTUAL TABLE/i.test(table.sql);
    const ordering = primary.length ? primary.join(",") : "rowid";
    hash.update(JSON.stringify([table.name, table.sql]));
    for (const row of database.prepare(`SELECT ${fts ? "rowid AS document_key," : ""}* FROM ${quoted(table.name)} ORDER BY ${ordering}`).iterate()) {
      hash.update(JSON.stringify(row));
      hash.update("\n");
    }
  }
  return hash.digest("hex");
}

function invalidIndex(error: unknown): DiagnosticError {
  return new DiagnosticError(`索引内容校验失败，服务启动已停止：${String(error)}`, { key: "diagnostics.index.maintenance.invalidIndex" });
}

function fingerprint(database: Database.Database): string {
  try { return logicalFingerprint(database); }
  catch (error) { throw invalidIndex(error); }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export async function activeIndexMaintenance(home: string, expectedPid?: number): Promise<boolean> {
  try {
    const activity = JSON.parse(await readFile(activityPath(home), "utf8")) as Activity;
    const owner = JSON.parse(await readFile(join(home, "service.lock", "owner.json"), "utf8")) as { pid: number; nonce: string };
    if (!Number.isSafeInteger(activity.pid) || activity.pid < 1 || expectedPid !== undefined && activity.pid !== expectedPid
      || activity.pid !== owner.pid || activity.nonce !== owner.nonce || !Number.isFinite(Date.parse(activity.startedAt))) return false;
    try { process.kill(activity.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  } catch { return false; }
}

interface MaintenanceOptions {
  now?: number;
  availableBytes?: (path: string) => Promise<number>;
  /** 隔离测试可直接核验小库整理；产品仅在旧库需要转换时执行全库整理。 */
  decision?: (statistics: MaintenanceStatistics, now: number, lastSuccess?: string) => "threshold" | "cooldown" | "compact";
}

/** 生命周期锁已持有，且任何 store、查询和 Worker 连接尚未打开。 */
export async function compactIndexAtStartup(home: string, options: MaintenanceOptions = {}): Promise<IndexMaintenanceResult> {
  const path = join(home, "index.sqlite");
  if (!existsSync(path)) return result("noDatabase");
  const database = new Database(path, { fileMustExist: true, timeout: 0 });
  let active = false;
  try {
    if (database.pragma("user_version", { simple: true }) !== INDEX_SCHEMA_VERSION) return result("unsupportedSchema");
    const before = statistics(database);
    const values = { beforeBytes: before.pageCount * before.pageSize, freeBytes: before.freePages * before.pageSize };
    let lastSuccess: string | undefined;
    try { lastSuccess = (JSON.parse(await readFile(successPath(home), "utf8")) as { completedAt?: string }).completedAt; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return result("error", "failed", { ...values, details: String(error) }); }
    const mode = database.pragma("auto_vacuum", { simple: true }) as number;
    // NONE 库只转换一次；已支持增量回收的库不再因重启执行整库整理。
    const decision = options.decision ? options.decision(before, options.now ?? Date.now(), lastSuccess)
      : mode === 0 ? "compact" : "threshold";
    if (decision !== "compact") return result(decision, "skipped", { ...values, lastSuccess });
    const available = options.availableBytes ?? (async (directory: string) => { const volume = await statfs(directory); return volume.bavail * volume.bsize; });
    // VACUUM 的工作数据库及回写日志至多需要约两倍主库空间；两处卷均保守预检。
    const required = values.beforeBytes * 2 + 64 * 1024 ** 2;
    const temporary = process.env.SQLITE_TMPDIR ?? process.env.TMPDIR ?? tmpdir();
    if (await available(dirname(path)) < required || await available(temporary) < required) return result("insufficientSpace", "skipped", { ...values, lastSuccess });
    database.pragma("locking_mode = EXCLUSIVE");
    database.exec("BEGIN EXCLUSIVE; COMMIT;");
    const owner = JSON.parse(await readFile(join(home, "service.lock", "owner.json"), "utf8")) as { pid: number; nonce: string };
    if (owner.pid !== process.pid || typeof owner.nonce !== "string") throw new Error("Service lifecycle lock is not owned by this process");
    const activity: Activity = { ...owner, startedAt: new Date(options.now ?? Date.now()).toISOString(), phase: "validating" };
    await atomicJson(activityPath(home), activity);
    active = true;
    try {
      if (database.prepare("SELECT 1 FROM sqlite_master WHERE name='session_search_state'").get()) await prepareSearchIndex(database);
    } catch (error) { throw invalidIndex(error); }
    const previous = fingerprint(database);
    await atomicJson(activityPath(home), { ...activity, phase: "compacting" });
    database.pragma("auto_vacuum = INCREMENTAL");
    database.exec("VACUUM");
    await atomicJson(activityPath(home), { ...activity, phase: "verifying" });
    if (fingerprint(database) !== previous) throw new DiagnosticError("整理后的索引内容不一致，服务启动已停止", { key: "diagnostics.index.maintenance.inconsistent" });
    const completedAt = new Date(options.now ?? Date.now()).toISOString();
    await atomicJson(successPath(home), { completedAt });
    return result("completed", "completed", { ...values, afterBytes: statistics(database).pageCount * before.pageSize, lastSuccess: completedAt });
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    const busy = ["SQLITE_BUSY", "SQLITE_LOCKED"].includes((error as { code?: string }).code ?? "");
    return result(busy ? "busy" : "error", busy ? "skipped" : "failed", { details: String(error) });
  } finally {
    database.close();
    if (active) await rm(activityPath(home), { force: true });
  }
}

/** 仅分析 Worker 空闲时调用；有界写锁和非阻塞 checkpoint 不等待前台读者。 */
export function reclaimIndexBatch(path: string, pageLimit = 256): IndexMaintenanceResult {
  const database = new Database(path, { fileMustExist: true, timeout: 0 });
  try {
    if (database.pragma("user_version", { simple: true }) !== INDEX_SCHEMA_VERSION) return result("unsupportedSchema");
    if (database.pragma("auto_vacuum", { simple: true }) !== 2) return { ...result("unsupportedSchema"), messageDescriptor: { key: "diagnostics.index.maintenance.reclaimUnavailable" } };
    const before = statistics(database);
    const values = { beforeBytes: before.pageCount * before.pageSize, freeBytes: before.freePages * before.pageSize };
    if (before.freePages) {
      const pages = Math.min(before.freePages, Math.max(1, Math.min(256, Math.floor(pageLimit))));
      // exec 消耗 PRAGMA 的全部步进结果，不能只读取第一行而只回收一个页。
      database.exec(`PRAGMA incremental_vacuum(${pages})`);
    }
    const after = statistics(database);
    database.pragma("wal_checkpoint(PASSIVE)");
    // timeout=0；尚有读事务时 TRUNCATE 安全返回 busy，下一批再尝试。
    database.pragma("wal_checkpoint(TRUNCATE)");
    return before.freePages ? { ...result("completed", "completed", { ...values, afterBytes: after.pageCount * after.pageSize }), messageDescriptor: { key: "diagnostics.index.maintenance.reclaimed" } }
      : result("threshold", "skipped", values);
  } catch (error) {
    const busy = ["SQLITE_BUSY", "SQLITE_LOCKED"].includes((error as { code?: string }).code ?? "");
    return result(busy ? "busy" : "error", busy ? "skipped" : "failed", { details: String(error) });
  } finally { database.close(); }
}
