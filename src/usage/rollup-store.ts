import Database from "better-sqlite3";
import { chmodSync } from "node:fs";
import type { UsageRollup } from "./rollup-contracts.js";
import { USAGE_FACT_FORMAT_VERSION } from "../sessions/usage-facts.js";
import { accumulator } from "./analytics.js";

const ROLLUP_FORMAT_VERSION = 3;
const format = ROLLUP_FORMAT_VERSION * 1000 + USAGE_FACT_FORMAT_VERSION;
const maxDiskBytes = 256 * 1024 * 1024;
const totalDefaults = accumulator().totals;

interface StoredRollup { rollup: UsageRollup; bytes: number }

function validRollup(value: unknown, timezone: string): value is UsageRollup {
  if (!value || typeof value !== "object") return false;
  const item = value as UsageRollup;
  return typeof item.version === "string" && item.timezone === timezone && Array.isArray(item.sessions)
    && Array.isArray(item.models) && item.models.every(model => typeof model === "string")
    && Array.isArray(item.sessionIdsWithUsage) && item.sessionIdsWithUsage.every(id => typeof id === "string")
    && Array.isArray(item.cells) && item.cells.every(cell => cell && typeof cell.sessionId === "string"
      && ["complete", "partial", "missing"].includes(cell.coverage) && ["complete", "partial", "missing"].includes(cell.costCoverage)
      && cell.totals && Object.entries(totalDefaults).every(([key, initial]) => {
        const value = cell.totals[key as keyof typeof totalDefaults];
        return initial === null && value === null || typeof value === "number" && Number.isFinite(value) && value >= 0;
      })
      && Number.isSafeInteger(cell.speedEligibleRequests) && cell.speedEligibleRequests >= 0
      && Array.isArray(cell.speedProfiles) && cell.speedProfiles.every(profile => profile && typeof profile.key === "string"
        && typeof profile.client === "string" && typeof profile.model === "string" && profile.model.trim().length > 0
        && ["response", "generation"].includes(profile.window) && ["recorded", "estimated"].includes(profile.basis)
        && typeof profile.method === "string" && profile.method.length > 0
        && Number.isSafeInteger(profile.requests) && profile.requests > 0
        && Number.isSafeInteger(profile.eligibleRequests) && profile.eligibleRequests >= 0 && profile.eligibleRequests <= profile.requests
        && (profile.eligibleRequests === 0 ? profile.outputTokens === null && profile.durationMs === null
          : typeof profile.outputTokens === "number" && Number.isFinite(profile.outputTokens) && profile.outputTokens > 0
            && typeof profile.durationMs === "number" && Number.isFinite(profile.durationMs) && profile.durationMs > 0))
      && Number.isFinite(cell.pairedInput) && Number.isFinite(cell.pairedCache)
      && (cell.day === undefined && cell.hour === undefined || typeof cell.day === "string" && typeof cell.hour === "string")
      && Array.isArray(cell.previews) && cell.previews.length <= 12
      && cell.previews.every(preview => preview?.usage && typeof preview.usage.id === "string" && preview.cost
        && ["complete", "partial", "missing"].includes(preview.cost.coverage)
        && (preview.cost.amount === null || typeof preview.cost.amount === "number" && Number.isFinite(preview.cost.amount) && preview.cost.amount >= 0)));
}

/** 汇总可丢弃重建，不与原始会话或手动价格共用生命周期。 */
export class UsageRollupStore {
  private readonly database: Database.Database;
  private bytes = 0;

  constructor(path: string) {
    this.database = new Database(path);
    chmodSync(path, 0o600);
    if (!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()) {
      this.database.pragma("auto_vacuum=INCREMENTAL");
    }
    this.database.pragma("journal_mode=WAL");
    // 仅派生缓存采用 NORMAL，掉电后可重建；原会话索引的持久化策略不变。
    this.database.pragma("synchronous=NORMAL");
    this.database.pragma("busy_timeout=5000");
    this.database.exec(`CREATE TABLE IF NOT EXISTS usage_rollup_cache (
      revision TEXT NOT NULL, client TEXT NOT NULL, price_version TEXT NOT NULL, timezone TEXT NOT NULL,
      format INTEGER NOT NULL, json TEXT NOT NULL, accessed_at INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(revision,client,price_version,timezone));
      CREATE INDEX IF NOT EXISTS usage_rollup_access ON usage_rollup_cache(accessed_at)`);
    const columns = this.database.pragma("table_info(usage_rollup_cache)") as { name: string }[];
    if (!columns.some(column => column.name === "bytes")) {
      this.database.exec("ALTER TABLE usage_rollup_cache ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0");
      this.database.exec("UPDATE usage_rollup_cache SET bytes=LENGTH(CAST(json AS BLOB))");
    }
    this.database.transaction(() => {
      this.bytes = (this.database.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes FROM usage_rollup_cache").get() as { bytes: number }).bytes;
      this.trim();
    })();
  }

  get(revision: string, client: string, priceVersion: string, timezone: string): UsageRollup | undefined {
    return this.getWithBytes(revision, client, priceVersion, timezone)?.rollup;
  }

  getWithBytes(revision: string, client: string, priceVersion: string, timezone: string): StoredRollup | undefined {
    const row = this.database.prepare(`SELECT json,bytes FROM usage_rollup_cache
      WHERE revision=? AND client=? AND price_version=? AND timezone=? AND format=?`)
      .get(revision, client, priceVersion, timezone, format) as { json: string; bytes: number } | undefined;
    if (!row) return;
    try {
      const parsed: unknown = JSON.parse(row.json);
      if (validRollup(parsed, timezone)) return { rollup: parsed, bytes: Math.max(row.bytes, Buffer.byteLength(row.json)) };
    }
    catch { /* 派生缓存损坏时丢弃该项，从结构化事实重新准备。 */ }
    const removed = this.database.prepare("DELETE FROM usage_rollup_cache WHERE revision=? AND client=? AND price_version=? AND timezone=? RETURNING bytes")
      .get(revision, client, priceVersion, timezone) as { bytes: number } | undefined;
    this.bytes -= removed?.bytes ?? 0;
    return undefined;
  }

  put(revision: string, client: string, priceVersion: string, timezone: string, rollup: UsageRollup): number {
    const json = JSON.stringify(rollup), bytes = Buffer.byteLength(json);
    this.database.transaction(() => {
      const previous = this.database.prepare("SELECT bytes FROM usage_rollup_cache WHERE revision=? AND client=? AND price_version=? AND timezone=?")
        .get(revision, client, priceVersion, timezone) as { bytes: number } | undefined;
      this.database.prepare(`INSERT INTO usage_rollup_cache(revision,client,price_version,timezone,format,json,accessed_at,bytes) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(revision,client,price_version,timezone) DO UPDATE SET format=excluded.format,json=excluded.json,accessed_at=excluded.accessed_at,bytes=excluded.bytes`)
        .run(revision, client, priceVersion, timezone, format, json, Date.now(), bytes);
      this.bytes += bytes - (previous?.bytes ?? 0);
      this.trim();
    })();
    return bytes;
  }

  touch(priceVersion: string, timezone: string): void {
    this.database.prepare("UPDATE usage_rollup_cache SET accessed_at=? WHERE price_version=? AND timezone=?")
      .run(Date.now(), priceVersion, timezone);
  }

  prune(revisions: string[]): void {
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM usage_rollup_cache WHERE revision NOT IN (SELECT value FROM json_each(?))")
        .run(JSON.stringify(revisions));
      this.database.prepare(`DELETE FROM usage_rollup_cache WHERE price_version NOT IN
        (SELECT price_version FROM usage_rollup_cache GROUP BY price_version ORDER BY MAX(accessed_at) DESC LIMIT 2)`)
        .run();
      this.database.prepare(`DELETE FROM usage_rollup_cache WHERE timezone NOT IN
        (SELECT timezone FROM usage_rollup_cache GROUP BY timezone ORDER BY MAX(accessed_at) DESC LIMIT 3)`)
        .run();
      this.bytes = (this.database.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes FROM usage_rollup_cache").get() as { bytes: number }).bytes;
      this.trim();
    })();
    this.database.pragma("incremental_vacuum(1024)");
  }

  /** 每次写入与重启都限制记录体积，准备被中止时也不会留下超额有效缓存。 */
  private trim(): void {
    if (this.bytes <= maxDiskBytes) return;
    const rows = this.database.prepare("SELECT rowid,bytes FROM usage_rollup_cache ORDER BY accessed_at,rowid").all() as { rowid: number; bytes: number }[];
    const remove = this.database.prepare("DELETE FROM usage_rollup_cache WHERE rowid=?");
    for (const row of rows) { if (this.bytes <= maxDiskBytes) break; remove.run(row.rowid); this.bytes -= row.bytes; }
  }

  close(): void { this.database.close(); }
}
