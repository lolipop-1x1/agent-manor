import assert from "node:assert/strict";
import Database from "better-sqlite3";

const database = new Database(":memory:");
try {
  assert.deepEqual(database.prepare("SELECT 1 AS loaded").get(), { loaded: 1 });
  const { version } = database.prepare("SELECT sqlite_version() AS version").get();
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, sqlite: version }));
} finally {
  database.close();
}
