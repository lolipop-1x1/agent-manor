import { chmodSync } from "node:fs";
import Database from "better-sqlite3";

const format = 2, maxBytes = 64 * 1024 * 1024, maxEntries = 96, maxItemBytes = 4 * 1024 * 1024;
/** 分区结果有界持久化；无权限、坏文件及失效记录退回正常计算。 */
export class OverviewResultStore {
  private database?: Database.Database;
  constructor(path: string) {
    try {
      this.database = new Database(path); chmodSync(path, 0o600);
      this.database.pragma("journal_mode=WAL"); this.database.pragma("synchronous=NORMAL"); this.database.pragma("busy_timeout=1000");
      this.database.exec(`CREATE TABLE IF NOT EXISTS overview_results (
        key TEXT PRIMARY KEY,format INTEGER NOT NULL,json TEXT NOT NULL,bytes INTEGER NOT NULL,accessed INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS overview_results_access ON overview_results(accessed)`);
      if (Number(this.database.pragma("user_version", { simple: true })) < 1) {
        // 七天洞察继续保留，旧总览结果可能包含已删除的过程视图和请求计时。
        this.database.transaction(() => {
          this.database!.exec("DELETE FROM overview_results WHERE NOT json_valid(key) OR json_extract(key,'$[1]') NOT IN ('review','review_detail')");
          this.database!.pragma("user_version=1");
        })();
      }
      this.trim();
    } catch { this.database?.close(); this.database = undefined; }
  }
  get<T>(key: string, valid: (value: unknown) => value is T): T | undefined {
    try {
      const row = this.database?.prepare("SELECT json,bytes FROM overview_results WHERE key=? AND format=?").get(key, format) as { json: string; bytes: number } | undefined;
      if (!row) return;
      const value: unknown = row.bytes <= maxItemBytes ? JSON.parse(row.json) : undefined;
      if (valid(value)) { this.database!.prepare("UPDATE overview_results SET accessed=? WHERE key=?").run(Date.now(), key); return value; }
      this.database!.prepare("DELETE FROM overview_results WHERE key=?").run(key);
    } catch { /* 不可信派生项不进入响应。 */ }
    return;
  }
  put(key: string, value: unknown): void {
    if (!this.database) return;
    try {
      const json = JSON.stringify(value), bytes = Buffer.byteLength(json); if (bytes > maxItemBytes) return;
      this.database.transaction(() => {
        this.database!.prepare(`INSERT INTO overview_results(key,format,json,bytes,accessed) VALUES(?,?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET format=excluded.format,json=excluded.json,bytes=excluded.bytes,accessed=excluded.accessed`)
          .run(key, format, json, bytes, Date.now());
        this.trim();
      })();
    } catch { /* 只读或满盘不阻止正常查询。 */ }
  }
  private trim(): void {
    const rows = this.database!.prepare("SELECT key,bytes FROM overview_results ORDER BY accessed DESC,key").all() as { key: string; bytes: number }[];
    let bytes = 0;
    const remove = this.database!.prepare("DELETE FROM overview_results WHERE key=?");
    for (const [index, row] of rows.entries()) { bytes += row.bytes; if (index >= maxEntries || bytes > maxBytes) remove.run(row.key); }
  }
  close(): void { this.database?.close(); this.database = undefined; }
}
