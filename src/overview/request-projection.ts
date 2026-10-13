import type Database from "better-sqlite3";
import type { SessionUsage } from "../session-contracts.js";

export function requestMembersWithEnd(members?: string[], end?: string): string[] | undefined {
  return end && !members?.includes(end) ? [...(members ?? []), end] : members;
}

/** 总览只保留请求结束消息身份用于去重和轮次关联，不复制请求计时。 */
export function withoutRequestTiming(usage: SessionUsage): SessionUsage {
  const { timing, ...value } = usage;
  const end = timing?.end?.source === "mirror" ? undefined : timing?.end?.messageId;
  const members = requestMembersWithEnd(value.requestMessageIds, end);
  if (members !== undefined) value.requestMessageIds = members;
  return value;
}

/** 原地迁移派生 JSON，保留日期、用量和结束身份，避免重新扫描全部历史。 */
export function removeStoredRequestTiming(database: Database.Database, table: "overview_fact_requests" | "weekly_requests"): void {
  if (Number(database.pragma("user_version", { simple: true })) >= 1) return;
  database.transaction(() => {
    database.exec(`UPDATE ${table} SET json=CASE
      WHEN COALESCE(json_extract(json,'$.usage.timing.end.source'),'')<>'mirror'
        AND json_type(json,'$.usage.timing.end.messageId')='text'
        AND length(json_extract(json,'$.usage.timing.end.messageId'))>0
        THEN json_set(json_remove(json,'$.usage.timing'),'$.usage.requestMessageIds',json(
          CASE WHEN EXISTS(SELECT 1 FROM json_each(COALESCE(json_extract(${table}.json,'$.usage.requestMessageIds'),'[]'))
            WHERE value=json_extract(${table}.json,'$.usage.timing.end.messageId'))
          THEN json_extract(${table}.json,'$.usage.requestMessageIds')
          ELSE json_insert(COALESCE(json_extract(${table}.json,'$.usage.requestMessageIds'),'[]'),'$[#]',
            json_extract(${table}.json,'$.usage.timing.end.messageId')) END))
      ELSE json_remove(json,'$.usage.timing') END
      WHERE json_type(json,'$.usage.timing') IS NOT NULL`);
    database.pragma("user_version=1");
  })();
}
