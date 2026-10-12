import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { OverviewResultStore } from "../src/overview/result-store.js";
const valid = (value: unknown): value is { count: number } => !!value && typeof value === "object" && typeof (value as { count?: unknown }).count === "number";

test("持久分区缓存限制权限和记录数量，重启保持有效结果", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-overview-results-")), path = join(directory, "cache.sqlite");
  let store = new OverviewResultStore(path);
  try {
    for (let index = 0; index < 120; index++) store.put(String(index), { count: index });
    assert.equal(store.get("0", valid), undefined); assert.equal(store.get("119", valid)?.count, 119);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    store.close(); store = new OverviewResultStore(path); assert.equal(store.get("119", valid)?.count, 119);
    const raw = new Database(path); assert.ok((raw.prepare("SELECT COUNT(*) count FROM overview_results").get() as { count: number }).count <= 96); raw.close();
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
test("坏JSON、过大项、坏文件和不可写路径退回计算", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-overview-bad-result-")), path = join(directory, "cache.sqlite");
  const store = new OverviewResultStore(path);
  try {
    store.put("bad", { count: 1 }); const raw = new Database(path); raw.prepare("UPDATE overview_results SET json='{' WHERE key='bad'").run(); raw.close();
    assert.equal(store.get("bad", valid), undefined);
    store.put("large", { count: 1, data: "x".repeat(5 * 1024 * 1024) }); assert.equal(store.get("large", valid), undefined);
    const badPath = join(directory, "bad.sqlite"); writeFileSync(badPath, "synthetic invalid sqlite");
    const bad = new OverviewResultStore(badPath), unavailable = new OverviewResultStore(join(directory, "missing", "cache.sqlite"));
    try { bad.put("a", { count: 1 }); unavailable.put("a", { count: 1 }); assert.equal(bad.get("a", valid), undefined); assert.equal(unavailable.get("a", valid), undefined); }
    finally { bad.close(); unavailable.close(); }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
test("旧分区形状的持久缓存不进入新结果", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-overview-old-result-")), path = join(directory, "cache.sqlite");
  const store = new OverviewResultStore(path);
  try {
    store.put("legacy", { count: 1 });
    const raw = new Database(path);
    try { raw.prepare("UPDATE overview_results SET format=1 WHERE key='legacy'").run(); } finally { raw.close(); }
    assert.equal(store.get("legacy", valid), undefined);
    store.put("legacy", { count: 2 }); assert.deepEqual(store.get("legacy", valid), { count: 2 });
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
