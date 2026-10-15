import type Database from "better-sqlite3";
import { setImmediate } from "node:timers/promises";

const preparedTerms = new WeakMap<Database.Database, ReadonlyMap<string, string>>();

/** 只在当前同步写入批次复用解析线程已算好的词项，其他写入仍使用统一编码函数。 */
export function withCharacterTerms<T>(database: Database.Database, terms: ReadonlyMap<string, string>, write: () => T): T {
  preparedTerms.set(database, terms);
  try { return write(); }
  finally { preparedTerms.delete(database); }
}

/** 单字和相邻双字编码为 ASCII 词项；只折叠 ASCII 大写，保持 SQLite LIKE 的大小写规则。 */
export function characterTerms(text: string): string {
  const singles = new Set<number>(), pairs = new Set<number>();
  let previous: number | undefined;
  for (const character of text.toWellFormed()) {
    // SQLite LIKE 将 NUL 视为正文终点，索引必须采用相同边界。
    if (character === "\0") break;
    let code = character.codePointAt(0)!;
    if (code >= 65 && code <= 90) code += 32;
    singles.add(code);
    if (previous !== undefined) pairs.add(previous * 0x110000 + code);
    previous = code;
  }
  // 循环中只去重整数，避免为大段重复工具输出反复分配词项字符串。
  return [...Array.from(singles, code => `u${code.toString(16)}`),
    ...Array.from(pairs, pair => `b${Math.floor(pair / 0x110000).toString(16)}x${(pair % 0x110000).toString(16)}`)].join(" ");
}

/** 所有写连接（包括维护连接）在触发器运行前注册同一个函数。 */
export function registerSearchFunctions(database: Database.Database): void {
  database.function("session_character_terms", { deterministic: true }, text => {
    const value = String(text);
    return preparedTerms.get(database)?.get(value) ?? characterTerms(value);
  });
}

/** 正文仍由会话表唯一保存，两类 FTS 只保存词项和显式消息键。 */
export function initializeSearchIndex(database: Database.Database): void {
  registerSearchFunctions(database);
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_message_search USING fts5(
      text, tokenize='trigram', content='', contentless_delete=1, detail=none);
    CREATE TABLE IF NOT EXISTS session_search_state (id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL, complete INTEGER NOT NULL);
    INSERT OR IGNORE INTO session_search_state VALUES(1,0,NOT EXISTS(SELECT 1 FROM session_messages LIMIT 1));
    CREATE TRIGGER IF NOT EXISTS session_search_insert AFTER INSERT ON session_messages BEGIN
      INSERT INTO session_message_search(rowid,text) VALUES(new.message_key,new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS session_search_update AFTER UPDATE OF text ON session_messages WHEN old.text<>new.text BEGIN
      INSERT OR REPLACE INTO session_message_search(rowid,text) VALUES(new.message_key,new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS session_search_delete AFTER DELETE ON session_messages BEGIN
      DELETE FROM session_message_search WHERE rowid=old.message_key;
    END;
    CREATE VIRTUAL TABLE IF NOT EXISTS session_character_search USING fts5(
      terms, content='', contentless_delete=1, detail=none);
    CREATE TABLE IF NOT EXISTS session_character_search_state (id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL, complete INTEGER NOT NULL);
    INSERT OR IGNORE INTO session_character_search_state VALUES(1,0,NOT EXISTS(SELECT 1 FROM session_messages LIMIT 1));
    CREATE TRIGGER IF NOT EXISTS session_character_insert AFTER INSERT ON session_messages BEGIN
      INSERT INTO session_character_search(rowid,terms) VALUES(new.message_key,session_character_terms(new.text));
    END;
    CREATE TRIGGER IF NOT EXISTS session_character_update AFTER UPDATE OF text ON session_messages WHEN old.text<>new.text BEGIN
      INSERT OR REPLACE INTO session_character_search(rowid,terms) VALUES(new.message_key,session_character_terms(new.text));
    END;
    CREATE TRIGGER IF NOT EXISTS session_character_delete AFTER DELETE ON session_messages BEGIN
      DELETE FROM session_character_search WHERE rowid=old.message_key;
    END;
    CREATE INDEX IF NOT EXISTS session_version_revision ON session_version_sessions(version,revision);
  `);
}

/** 在刷新 Worker 分批补齐未完成词项；游标和词项在同一事务提交，可中断续建。 */
export async function prepareSearchIndex(database: Database.Database, onProgress?: (progress: number) => void): Promise<void> {
  initializeSearchIndex(database);
  // 旧库的类型索引也在刷新 Worker 建设，不把首次全表读取放到服务初始化中。
  database.exec("CREATE INDEX IF NOT EXISTS session_message_search_kind ON session_messages(kind,message_key)");
  const indexes = [
    { table: "session_message_search", state: "session_search_state", column: "text", value: "text" },
    { table: "session_character_search", state: "session_character_search_state", column: "terms", value: "session_character_terms(text)" },
  ];
  for (const [position, index] of indexes.entries()) {
    if ((database.prepare(`SELECT complete FROM ${index.state} WHERE id=1`).get() as { complete: number }).complete) continue;
    const maximum = (database.prepare("SELECT COALESCE(MAX(message_key),0) AS maximum FROM session_messages").get() as { maximum: number }).maximum;
    const next = database.prepare("SELECT message_key AS rowid FROM session_messages WHERE message_key>? AND message_key<=? ORDER BY message_key LIMIT 200");
    const insert = database.prepare(`INSERT OR REPLACE INTO ${index.table}(rowid,${index.column})
      SELECT message_key,${index.value} FROM session_messages WHERE message_key>? AND message_key<=?`);
    const update = database.prepare(`UPDATE ${index.state} SET cursor=?,complete=? WHERE id=1`);
    const batch = database.transaction(() => {
      const { cursor, complete } = database.prepare(`SELECT cursor,complete FROM ${index.state} WHERE id=1`).get() as { cursor: number; complete: number };
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
      if (progress === 1 || progress - reported >= 0.01) { onProgress?.((position + progress) / indexes.length); reported = progress; }
      if (progress === 1) break;
      await setImmediate();
    }
  }
  onProgress?.(1);
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

/** 短词词项本身即精确字面判定；长词仍只是候选，调用方必须核验完整正文。 */
export function searchCandidateIndex(database: Database.Database, needle: string): { table: string; match: string; exact: boolean } | undefined {
  const characters = Array.from(needle.toWellFormed());
  if (!characters.length || needle.includes("\0")) return undefined;
  if (characters.length >= 3) {
    const match = searchMatch(database, needle);
    return match ? { table: "session_message_search", match, exact: false } : undefined;
  }
  // 旧只读库不创建表；未完成补建时仍以正文扫描提供完整结果。
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='session_character_search_state'").get()
    || !(database.prepare("SELECT complete FROM session_character_search_state WHERE id=1").get() as { complete: number }).complete) return undefined;
  const terms = characterTerms(needle).split(" ");
  return { table: "session_character_search", match: characters.length === 1 ? terms[0]! : terms.at(-1)!, exact: true };
}
