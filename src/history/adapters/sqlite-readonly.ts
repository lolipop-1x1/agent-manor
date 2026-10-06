import { lstat } from "node:fs/promises";
import Database from "better-sqlite3";
import type { Gap } from "../../contracts.js";

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

export interface SqliteReadBudget {
  records: number;
  bytes: number;
  maxRecords: number;
  maxBytes: number;
  exceeded: boolean;
}

export function createSqliteReadBudget(maxRecords = 100_000, maxBytes = 128 * 1024 * 1024): SqliteReadBudget {
  return { records: 0, bytes: 0, maxRecords, maxBytes, exceeded: false };
}

export function readSqliteRows(database: Database.Database, sql: string, gaps: Gap[], budget: SqliteReadBudget, ...params: string[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const row of database.prepare(sql).iterate(...params) as Iterable<Record<string, unknown>>) {
    const bytes = Buffer.byteLength(JSON.stringify(row));
    if (budget.records + 1 > budget.maxRecords || budget.bytes + bytes > budget.maxBytes) {
      if (!budget.exceeded) gaps.push({ kind: "budget_exceeded", message: `SQLite 来源超过 ${budget.maxRecords} 条记录或 ${budget.maxBytes} 字节的有界读取上限` });
      budget.exceeded = true;
      break;
    }
    rows.push(row);
    budget.records += 1;
    budget.bytes += bytes;
  }
  return rows;
}

export function sqliteJson(value: unknown, gaps: Gap[]): Record<string, unknown> {
  if (typeof value !== "string" && !Buffer.isBuffer(value)) {
    if (value !== undefined && value !== null) gaps.push({ kind: "parse_error", message: "SQLite 原生 JSON 字段不是文本或字节串" });
    return {};
  }
  try {
    const decoded = JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value);
    if (decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)) return decoded as Record<string, unknown>;
    gaps.push({ kind: "parse_error", message: "SQLite 原生 JSON 字段不是对象" });
    return {};
  } catch {
    gaps.push({ kind: "parse_error", message: "SQLite 原生 JSON 字段无法解析，原记录仍保留" });
    return {};
  }
}
