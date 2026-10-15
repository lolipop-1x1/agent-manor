import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { characterTerms } from "../src/sessions/search-index.js";

test("单字与相邻双字词项精确对应字面 LIKE，覆盖 NUL、Unicode 与特殊字符组合", () => {
  const database = new Database(":memory:");
  database.exec("CREATE TABLE documents(id INTEGER PRIMARY KEY,text TEXT); CREATE VIRTUAL TABLE terms USING fts5(tokens,content='',contentless_delete=1,detail=none)");
  const alphabet = ["事", "务", "的", "a", "A", "é", "É", "İ", "ı", "e", "\u0301", "😀", "🔒", "%", "_", "\\", " ", "\n", "\0", "\ud800"];
  const texts = ["事务", "事与务", "ab\0事务", "事务\0ab", "\0事务", "aa AA aA", "", "ééÉ", "😀🔒"];
  let state = 12345;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  for (let index = 0; index < 240; index++) texts.push(Array.from({ length: 20 }, () => alphabet[next() % alphabet.length]).join(""));
  const put = database.prepare("INSERT INTO documents VALUES(?,?)"), index = database.prepare("INSERT INTO terms(rowid,tokens) VALUES(?,?)");
  database.transaction(() => texts.forEach((text, id) => { put.run(id + 1, text); index.run(id + 1, characterTerms(text)); }))();
  const scan = database.prepare("SELECT id FROM documents WHERE text LIKE ? ESCAPE '\\' ORDER BY id");
  const indexed = database.prepare("SELECT rowid AS id FROM terms WHERE terms MATCH ? ORDER BY rowid");
  try {
    for (const q of [...alphabet, ...alphabet.flatMap(left => alphabet.map(right => left + right))]) {
      const needle = q.trim();
      if (!needle || needle.includes("\0")) continue;
      const tokens = characterTerms(needle).split(" ");
      const match = Array.from(needle.toWellFormed()).length === 1 ? tokens[0] : tokens.at(-1);
      const literal = `%${needle.replace(/[\\%_]/g, "\\$&")}%`;
      assert.deepEqual(indexed.all(match), scan.all(literal), JSON.stringify(needle));
    }
  } finally { database.close(); }
});
