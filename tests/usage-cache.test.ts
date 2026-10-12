import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { UsageResultCache } from "../src/usage/cache.js";
import { UsageRollupStore } from "../src/usage/rollup-store.js";
import type { UsageRollup } from "../src/usage/rollup-contracts.js";

test("结果缓存同时限制体积和条目，使用 LRU 且不驻留过大项", () => {
  const cache = new UsageResultCache<string>(20, 2);
  cache.set("a", "1234"); cache.set("b", "1234");
  assert.equal(cache.get("a"), "1234");
  cache.set("c", "1234"); assert.equal(cache.get("b"), undefined);
  cache.set("large", "x".repeat(30)); assert.equal(cache.get("large"), undefined);
  cache.set("a", "x".repeat(16)); assert.equal(cache.get("c"), undefined);
  cache.set("a", "x".repeat(30)); assert.equal(cache.get("a"), undefined);
  cache.set("d", "ok"); cache.clear(); assert.equal(cache.get("d"), undefined);
});

test("结果缓存接受保守字节上界，避免序列化并正确维护替换顺序", () => {
  let serialized = 0;
  const value = { toJSON: () => { serialized += 1; throw new Error("不应序列化带估算值的缓存项"); } };
  const cache = new UsageResultCache<typeof value>(8, 2);
  cache.set("a", value, 4); cache.set("b", value, 4);
  assert.equal(cache.get("a"), value);
  cache.set("a", value, 5);
  assert.equal(cache.get("a"), value);
  assert.equal(cache.get("b"), undefined, "替换项更新估算后按 LRU 淘汰最旧项");
  cache.set("oversized", value, 9);
  assert.equal(cache.get("oversized"), undefined, "超过缓存预算的估算项不驻留");
  assert.equal(serialized, 0);
});

test("持久化汇总保留旧修订版本，淘汰旧价格/时区并可重建损坏缓存", t => {
  const home = mkdtempSync(join(tmpdir(), "usage-cache-test-")), path = join(home, "rollups.sqlite");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let store = new UsageRollupStore(path);
  const rollup: UsageRollup = { version: "index-a", timezone: "UTC", sessions: [], cells: [], sessionIdsWithUsage: [], models: [] };
  const bytes = Buffer.byteLength(JSON.stringify(rollup));
  assert.equal(store.put("revision-old", "codex", "price-a", "UTC", rollup), bytes);
  assert.deepEqual(store.getWithBytes("revision-old", "codex", "price-a", "UTC"), { rollup, bytes });
  store.put("revision-new", "codex", "price-a", "UTC", rollup);
  store.put("removed", "codex", "price-a", "UTC", rollup);
  store.close(); store = new UsageRollupStore(path);
  assert.deepEqual(store.get("revision-old", "codex", "price-a", "UTC"), rollup);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  store.prune(["revision-old", "revision-new"]);
  assert.ok(store.get("revision-old", "codex", "price-a", "UTC"));
  assert.equal(store.get("removed", "codex", "price-a", "UTC"), undefined);
  const database = new Database(path);
  database.prepare("UPDATE usage_rollup_cache SET json=? WHERE revision=?").run("{broken", "revision-new");
  assert.equal(store.get("revision-new", "codex", "price-a", "UTC"), undefined);
  store.put("revision-new", "codex", "price-a", "UTC", rollup);
  database.prepare("UPDATE usage_rollup_cache SET json=? WHERE revision=?").run(JSON.stringify({ ...rollup, cells: [{ sessionId: "bad" }] }), "revision-new");
  assert.equal(store.get("revision-new", "codex", "price-a", "UTC"), undefined);
  store.put("revision-new", "codex", "price-a", "UTC", rollup);
  for (const [price, time] of [["price-a", 1], ["price-b", 2], ["price-c", 3]] as const) {
    store.put("revision-new", "codex", price, "UTC", rollup);
    database.prepare("UPDATE usage_rollup_cache SET accessed_at=? WHERE price_version=?").run(time, price);
  }
  store.prune(["revision-old", "revision-new"]);
  assert.equal(store.get("revision-new", "codex", "price-a", "UTC"), undefined);
  assert.ok(store.get("revision-new", "codex", "price-b", "UTC"));
  assert.ok(store.get("revision-new", "codex", "price-c", "UTC"));
  for (const [zone, time] of [["UTC", 1], ["Asia/Shanghai", 2], ["America/New_York", 3], ["Europe/London", 4]] as const) {
    store.put("revision-new", "codex", "price-c", zone, { ...rollup, timezone: zone });
    database.prepare("UPDATE usage_rollup_cache SET accessed_at=? WHERE timezone=?").run(time, zone);
  }
  store.prune(["revision-old", "revision-new"]);
  assert.equal(store.get("revision-new", "codex", "price-c", "UTC"), undefined);
  assert.ok(store.get("revision-new", "codex", "price-c", "Europe/London"));
  database.prepare("UPDATE usage_rollup_cache SET bytes=?,accessed_at=0 WHERE timezone=?").run(300 * 1024 * 1024, "Asia/Shanghai");
  store.prune(["revision-old", "revision-new"]);
  assert.equal(store.get("revision-new", "codex", "price-c", "Asia/Shanghai"), undefined);
  assert.ok(store.get("revision-new", "codex", "price-c", "Europe/London"));
  database.prepare("UPDATE usage_rollup_cache SET bytes=?,accessed_at=0 WHERE timezone=?").run(300 * 1024 * 1024, "America/New_York");
  store.close(); store = new UsageRollupStore(path);
  assert.equal(store.get("revision-new", "codex", "price-c", "America/New_York"), undefined, "重启时先淘汰超限记录");
  database.prepare("UPDATE usage_rollup_cache SET bytes=? WHERE timezone=?").run(256 * 1024 * 1024, "Europe/London");
  store.close(); store = new UsageRollupStore(path);
  store.put("latest", "codex", "price-c", "UTC", rollup);
  const budget = database.prepare("SELECT SUM(bytes) AS bytes FROM usage_rollup_cache").get() as { bytes: number };
  assert.ok(budget.bytes <= 256 * 1024 * 1024, "写入超限时立即淘汰，不等待完整历史准备结束");
  assert.ok(store.get("latest", "codex", "price-c", "UTC"));
  database.close(); store.close();
});
