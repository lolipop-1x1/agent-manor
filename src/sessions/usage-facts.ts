import type Database from "better-sqlite3";
import type { SessionUsage } from "../session-contracts.js";
import { StoreError } from "../index/store.js";
import { instant } from "../usage/analytics.js";
import { usageDimensionKey } from "../usage/dimensions.js";

export const USAGE_FACT_FORMAT_VERSION = 2;

export interface UsageFactMetadata {
  revision: string; minTime?: number; maxTime?: number; undatedCount: number; hasUsage: boolean; models: string[];
}

interface UsageFactRow {
  id: string;
  model: string | null;
  occurred_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  context_tokens: number | null;
}

/** 派生事实独立标记格式，不改变原始历史索引版本，也不在启动时补齐历史。 */
export function initializeUsageFacts(database: Database.Database): void {
  // 统计时间只接受明确时区和有效日历日期，不能沿用较宽松的会话展示时间解析。
  database.function("usage_time_ms", { deterministic: true }, value => typeof value === "string" ? instant(value) ?? null : null);
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_usage_fact_revisions (
      revision TEXT PRIMARY KEY REFERENCES session_revisions(id) ON DELETE CASCADE, format_version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS session_usage_facts (
      revision TEXT NOT NULL REFERENCES session_revisions(id) ON DELETE CASCADE, id TEXT NOT NULL,
      ordinal INTEGER NOT NULL, time_ms REAL, occurred_at TEXT, model TEXT,
      input_tokens REAL, output_tokens REAL, cache_read_tokens REAL, cache_write_tokens REAL,
      reasoning_tokens REAL, context_tokens REAL, eligible INTEGER NOT NULL CHECK(eligible IN (0,1)), PRIMARY KEY(revision,id));
    CREATE INDEX IF NOT EXISTS session_usage_fact_order ON session_usage_facts(revision,eligible,ordinal);
  `);
}

const ready = (database: Database.Database, revision: string): boolean => Boolean(database.prepare(
  "SELECT 1 FROM session_usage_fact_revisions WHERE revision=? AND format_version=?").get(revision, USAGE_FACT_FORMAT_VERSION));

export function usageFactsReady(database: Database.Database, revision: string): boolean { return ready(database, revision); }

/** 同一事务确认输入仍存在并发布全部事实，失败时不会留下准备完成标识。 */
export function prepareUsageFacts(database: Database.Database, revision: string, eligibleWhere: string): void {
  if (ready(database, revision)) return;
  database.transaction(() => {
    if (!database.prepare("SELECT 1 FROM session_revisions WHERE id=?").get(revision)) {
      throw new StoreError("SOURCE_NOT_FOUND", "会话不存在于当前索引版本", { key: "diagnostics.sessions.store.m011" });
    }
    if (ready(database, revision)) return;
    // 没有复制消息的不可变修订无需逐请求关联消息；存在复制时完整沿用原查询判定。
    const copied = Boolean(database.prepare("SELECT 1 FROM session_messages WHERE revision=? AND copied=1 LIMIT 1").get(revision));
    database.prepare("DELETE FROM session_usage_facts WHERE revision=?").run(revision);
    database.prepare(`INSERT INTO session_usage_facts
      (revision,id,ordinal,time_ms,occurred_at,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,context_tokens,eligible)
      SELECT u.revision,u.id,u.rowid,usage_time_ms(json_extract(u.json,'$.occurredAt')),json_extract(u.json,'$.occurredAt'),
        json_extract(u.json,'$.model'),json_extract(u.json,'$.inputTokens'),json_extract(u.json,'$.outputTokens'),
        json_extract(u.json,'$.cachedInputTokens'),json_extract(u.json,'$.cacheWriteTokens'),
        json_extract(u.json,'$.reasoningOutputTokens'),json_extract(u.json,'$.contextTokens'),
        ${copied ? `CASE WHEN ${eligibleWhere} THEN 1 ELSE 0 END` : "1"}
      FROM session_usage u WHERE u.revision=? ORDER BY u.rowid`).run(revision);
    database.prepare(`INSERT INTO session_usage_fact_revisions(revision,format_version) VALUES(?,?)
      ON CONFLICT(revision) DO UPDATE SET format_version=excluded.format_version`).run(revision, USAGE_FACT_FORMAT_VERSION);
  }).immediate();
}

/** 批量读取调度和全集筛选所需元数据；空修订与缺时间记录仍有明确身份。 */
export function readUsageFactMetadata(database: Database.Database, revisions: string[]): UsageFactMetadata[] {
  const ids = [...new Set(revisions)];
  if (!ids.length) return [];
  const rows = database.prepare(`SELECT r.revision,COUNT(f.id) AS requests,MIN(f.time_ms) AS min_time,MAX(f.time_ms) AS max_time,
    SUM(CASE WHEN f.id IS NOT NULL AND f.time_ms IS NULL THEN 1 ELSE 0 END) AS undated_count,
    json_group_array(DISTINCT f.model) FILTER (WHERE f.id IS NOT NULL) AS models
    FROM session_usage_fact_revisions r LEFT JOIN session_usage_facts f ON f.revision=r.revision AND f.eligible=1
    WHERE r.format_version=? AND r.revision IN (SELECT value FROM json_each(?)) GROUP BY r.revision`)
    .all(USAGE_FACT_FORMAT_VERSION, JSON.stringify(ids)) as {
      revision: string; requests: number; min_time: number | null; max_time: number | null; undated_count: number; models: string;
    }[];
  if (rows.length !== ids.length) {
    throw new StoreError("ANALYSIS_NOT_READY", "会话索引尚未完成", { key: "diagnostics.sessions.store.m009" });
  }
  const values = new Map(rows.map(row => [row.revision, { revision: row.revision, hasUsage: row.requests > 0,
    undatedCount: row.undated_count, models: (JSON.parse(row.models) as (string | null)[]).map(model => usageDimensionKey(model ?? undefined)).sort(),
    ...(row.min_time === null ? {} : { minTime: row.min_time }), ...(row.max_time === null ? {} : { maxTime: row.max_time }) }]));
  return ids.map(id => values.get(id)!);
}

/** 缺失字段不转换成零，证据身份与计时信息留在原请求表按需读取。 */
export function readUsageFacts(database: Database.Database, revision: string): SessionUsage[] {
  const rows = database.prepare(`SELECT id,model,occurred_at,input_tokens,output_tokens,cache_read_tokens,
    cache_write_tokens,reasoning_tokens,context_tokens FROM session_usage_facts WHERE revision=? AND eligible=1 ORDER BY ordinal`)
    .all(revision) as UsageFactRow[];
  return rows.map(row => ({ id: row.id,
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.occurred_at !== null ? { occurredAt: row.occurred_at } : {}),
    ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
    ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
    ...(row.cache_read_tokens !== null ? { cachedInputTokens: row.cache_read_tokens } : {}),
    ...(row.cache_write_tokens !== null ? { cacheWriteTokens: row.cache_write_tokens } : {}),
    ...(row.reasoning_tokens !== null ? { reasoningOutputTokens: row.reasoning_tokens } : {}),
    ...(row.context_tokens !== null ? { contextTokens: row.context_tokens } : {}),
  }));
}
