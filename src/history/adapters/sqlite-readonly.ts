import { lstat } from "node:fs/promises";
import Database from "better-sqlite3";

/** 在查询专用只读事务中读取 SQLite；SQLite 会将已提交 WAL 纳入快照。 */
export async function readOnlySqlite<T>(path: string, read: (database: Database.Database) => T): Promise<T> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("SQLite 历史来源必须为普通文件");
  const database = new Database(path, { readonly: true, fileMustExist: true });
  database.pragma("query_only = ON");
  let transaction = false;
  try {
    database.exec("BEGIN");
    transaction = true;
    const result = read(database);
    database.exec("ROLLBACK");
    transaction = false;
    return result;
  } finally {
    if (transaction) database.exec("ROLLBACK");
    database.close();
  }
}

export function sqliteTableExists(database: Database.Database, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

export function sqliteJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" && !Buffer.isBuffer(value)) return {};
  try {
    const decoded = JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value);
    return decoded !== null && typeof decoded === "object" && !Array.isArray(decoded) ? decoded as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
