import type Database from "better-sqlite3";
import { setImmediate } from "node:timers/promises";

/** 索引只保存三字符词项和消息 rowid，正文仍由会话表唯一保存。 */
export function initializeSearchIndex(database: Database.Database): void {
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_message_search USING fts5(
      text, tokenize='trigram', content='', contentless_delete=1, detail=none);
    CREATE TABLE IF NOT EXISTS session_search_state (id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL, complete INTEGER NOT NULL);
    INSERT OR IGNORE INTO session_search_state VALUES(1,0,NOT EXISTS(SELECT 1 FROM session_messages LIMIT 1));
    CREATE TRIGGER IF NOT EXISTS session_search_insert AFTER INSERT ON session_messages BEGIN
      INSERT INTO session_message_search(rowid,text) VALUES(new.rowid,new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS session_search_update AFTER UPDATE OF text ON session_messages WHEN old.text<>new.text BEGIN
      INSERT OR REPLACE INTO session_message_search(rowid,text) VALUES(new.rowid,new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS session_search_delete AFTER DELETE ON session_messages BEGIN
      DELETE FROM session_message_search WHERE rowid=old.rowid;
    END;
    CREATE INDEX IF NOT EXISTS session_version_revision ON session_version_sessions(version,revision);
  `);
}

/** 在刷新 Worker 分批补齐旧消息；游标和词项在同一事务提交，可中断续建。 */
export async function prepareSearchIndex(database: Database.Database, onProgress?: (progress: number) => void): Promise<void> {
  if ((database.prepare("SELECT complete FROM session_search_state WHERE id=1").get() as { complete: number }).complete) return;
  const maximum = (database.prepare("SELECT COALESCE(MAX(rowid),0) AS maximum FROM session_messages").get() as { maximum: number }).maximum;
  const next = database.prepare("SELECT rowid FROM session_messages WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 200");
  const insert = database.prepare(`INSERT OR REPLACE INTO session_message_search(rowid,text)
    SELECT rowid,text FROM session_messages WHERE rowid>? AND rowid<=?`);
  const update = database.prepare("UPDATE session_search_state SET cursor=?,complete=? WHERE id=1");
  const batch = database.transaction(() => {
    const { cursor, complete } = database.prepare("SELECT cursor,complete FROM session_search_state WHERE id=1").get() as { cursor: number; complete: number };
    if (complete) return 1;
    const rows = next.all(cursor, maximum) as { rowid: number }[];
    const end = rows.at(-1)?.rowid ?? maximum;
    insert.run(cursor, end);
    update.run(end, end >= maximum ? 1 : 0);
    return maximum ? end / maximum : 1;
  });
  let reported = -1;
  for (;;) {
    // 先取得写锁，避免主线程登记任务时使读事务升级为写事务失败。
    const progress = batch.immediate();
    if (progress === 1 || progress - reported >= 0.01) { onProgress?.(progress); reported = progress; }
    if (progress === 1) return;
    await setImmediate();
  }
}

/** 分别匹配有界数量的三字符词项，再由原字面 LIKE 验证完整内容及顺序。 */
export function searchMatch(database: Database.Database, needle: string): string | undefined {
  const characters = Array.from(needle);
  if (characters.length < 3 || needle.includes("\0")) return undefined;
  if (!(database.prepare("SELECT complete FROM session_search_state WHERE id=1").get() as { complete: number }).complete) return undefined;
  const terms = new Set<string>();
  for (let sample = 0; sample < Math.min(8, characters.length - 2); sample += 1) {
    const index = Math.floor(sample * (characters.length - 3) / Math.max(1, Math.min(7, characters.length - 3)));
    terms.add('"' + characters.slice(index, index + 3).join("").replaceAll('"', '""') + '"');
  }
  return [...terms].join(" AND ");
}
