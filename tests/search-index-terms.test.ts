import assert from "node:assert/strict";
import Database from "better-sqlite3";
import test from "node:test";
import { initializeSearchIndex, prepareSearchIndex, searchCandidateIndex } from "../src/sessions/search-index.js";

const create = () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE session_messages(message_key INTEGER PRIMARY KEY,kind TEXT,text TEXT); CREATE TABLE session_version_sessions(version TEXT,revision TEXT)");
  return db;
};

test("对话保留精确长词候选，过程保留字符候选和完整原文核验", async () => {
  const db = create();
  try {
    initializeSearchIndex(db);
    const add = db.prepare("INSERT INTO session_messages(kind,text) VALUES(?,?)");
    for (const kind of ["user", "assistant", "tool_result", "thinking", "context"]) {
      for (const text of ["abcd", "ab bc cd", "初始化缓存", "INIT hello😀界", "ab\0cd", "éÉ İı", "50%_\\path"]) add.run(kind, text);
    }
    await prepareSearchIndex(db);
    assert.equal(db.prepare("SELECT count(*) AS count FROM session_dialogue_search").get()?.count, 14);
    assert.equal(db.prepare("SELECT count(*) AS count FROM session_character_search").get()?.count, 35);
    for (const kinds of [["user", "assistant"], ["tool_result"], ["user", "context", "thinking"]]) {
      for (const needle of ["a", "ab", "abcd", "初始化", "hello😀", "éÉ", "İı", "50%_\\", "not-here"]) {
        const candidate = searchCandidateIndex(db, needle, kinds)!;
        const pattern = `%${needle.replace(/[\\%_]/g, "\\$&")}%`;
        const values = kinds.map(() => "?").join(",");
        const expected = db.prepare(`SELECT message_key FROM session_messages WHERE kind IN (${values}) AND text LIKE ? ESCAPE '\\' ORDER BY message_key`).all(...kinds, pattern);
        const actual = db.prepare(`SELECT message_key FROM session_messages WHERE kind IN (${values}) AND message_key IN
          (SELECT rowid FROM ${candidate.table} WHERE ${candidate.table} MATCH ?)
          ${candidate.exact ? "" : "AND text LIKE ? ESCAPE '\\'"} ORDER BY message_key`)
          .all(...kinds, candidate.match, ...(candidate.exact ? [] : [pattern]));
        assert.deepEqual(actual, expected, `${kinds}: ${needle}`);
      }
    }
    assert.equal(searchCandidateIndex(db, "abcd")?.table, "session_dialogue_search");
    assert.equal(searchCandidateIndex(db, "abcd", ["tool_result"])?.table, "session_character_search");
    db.exec("UPDATE session_messages SET kind='tool_result' WHERE kind='user'");
    assert.equal(db.prepare("SELECT count(*) AS count FROM session_dialogue_search").get()?.count, 7);
    db.exec("UPDATE session_messages SET kind='user' WHERE kind='thinking'");
    assert.equal(db.prepare("SELECT count(*) AS count FROM session_dialogue_search").get()?.count, 14);
  } finally { db.close(); }
});

test("补齐新对话索引前保留旧候选，中断不清理旧词项，完成后安全回收", async () => {
  const db = create();
  db.exec(`CREATE VIRTUAL TABLE session_message_search USING fts5(text,tokenize='trigram',content='',contentless_delete=1,detail=none);
    CREATE TABLE session_search_state(id INTEGER PRIMARY KEY,cursor INTEGER,complete INTEGER);
    INSERT INTO session_search_state VALUES(1,0,1);
    INSERT INTO session_messages(kind,text) VALUES('user','初始化缓存');
    INSERT INTO session_message_search(rowid,text) VALUES(1,'初始化缓存')`);
  try {
    initializeSearchIndex(db);
    assert.equal(searchCandidateIndex(db, "初始化")?.table, "session_message_search");
    await assert.rejects(prepareSearchIndex(db, () => { throw new Error("合成补建中断"); }), /合成补建中断/);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='session_message_search'").get());
    await prepareSearchIndex(db);
    assert.equal(searchCandidateIndex(db, "初始化")?.table, "session_dialogue_search");
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='session_message_search'").get(), undefined);
    db.exec("UPDATE session_messages SET text='新版缓存'; DELETE FROM session_messages");
    assert.equal(db.prepare("SELECT count(*) AS count FROM session_dialogue_search").get()?.count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM session_character_search").get()?.count, 0);
  } finally { db.close(); }
});
