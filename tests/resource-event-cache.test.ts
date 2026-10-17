import assert from "node:assert/strict";
import test from "node:test";
import type { ResourceEventStream, ResourceUsageEvent } from "../src/resource-contracts.js";
import type { SessionStore } from "../src/sessions/store.js";
import { ResourceUsageCache } from "../src/resources/usage-cache.js";
import { overviewResourceUsage, resourceUsageDetail, resourceUsageEvidence } from "../src/resources/usage.js";

function event(index: number, sourcePath = "/synthetic/history.jsonl"): ResourceUsageEvent {
  return { id: `event-${index}`, sessionId: `session-${index % 3}`, messageId: `message-${index}`, turnId: "turn", ordinal: index,
    client: "codex", kind: "skill_read", name: "guide", path: "/synthetic/guide/SKILL.md", tool: "Read", status: "success", pairing: "unique",
    occurredAt: index % 3 ? `2026-01-0${index % 2 + 1}T12:00:00Z` : undefined,
    source: { path: sourcePath, sourceId: "synthetic-source", revision: "revision", fingerprint: "synthetic", recordLine: index + 1 } };
}

test("元数据复用保留未知时间、日期边界和来源范围，不重复累计事件", async () => {
  let version = "version-a", reads = 0;
  const store = { usageVersion: () => version, resourceEvents: () => {
    reads++;
    return { version, events: Array.from({ length: 9 }, (_, index) => event(index)), sessionCount: 3, clients: ["codex"], gaps: [] } as ResourceEventStream;
  } } as unknown as SessionStore;
  const cache = new ResourceUsageCache(store);
  const base = cache.read({ kind: "skill" }, []);
  const identity = base.history.resources[0]!.identity;
  for (const query of [{ kind: "skill" as const }, { kind: "skill" as const, from: "2026-01-02T00:00:00Z", to: "2026-01-02T23:59:59Z" }]) {
    const before = reads;
    const result = cache.read(query, []);
    const detail = await cache.detail(identity.id, query, [], identity);
    const evidence = await cache.evidence(identity.id, query, identity);
    assert.equal(reads, before);
    assert.deepEqual(result, overviewResourceUsage(store, query, [], new Set()));
    assert.deepEqual(detail, resourceUsageDetail(store, identity.id, query, [], new Set(), identity));
    assert.deepEqual(evidence, resourceUsageEvidence(store, identity.id, query, identity));
    assert.equal(evidence.missingTimeEvents, 3);
    assert.equal(evidence.total, query.from ? 3 : 9);
    assert.equal(new Set(evidence.events.map(value => value.id)).size, evidence.total);
  }
  version = "version-b";
  const before = reads;
  assert.equal(cache.read({ kind: "skill" }, []).history.version, version);
  assert.equal(reads, before + 1, "新版本不复用上一版事件元数据");
});

test("超出单范围元数据预算时回退原查询，不保留截断结果或漏掉证据", async () => {
  const total = 4000, sourcePath = `/synthetic/${"x".repeat(4096)}`;
  let reads = 0, closed = 0;
  const store = { usageVersion: () => "version", resourceEvents: () => {
    reads++;
    return { version: "version", events: (function* () { try { for (let index = 0; index < total; index++) yield event(index, sourcePath); } finally { closed++; } })(),
      sessionCount: 3, clients: ["codex"], gaps: [] } as ResourceEventStream;
  } } as unknown as SessionStore;
  const cache = new ResourceUsageCache(store);
  const result = cache.read({ kind: "skill" }, []);
  assert.equal(result.history.stats.events, total);
  assert.equal(reads, 2, "超预算的前缀不作为完整缓存，回退完整查询");
  assert.equal(closed, 2, "提前退出的来源迭代器正确关闭");
  const evidence = await cache.evidence(result.history.resources[0]!.identity.id, { kind: "skill", pageSize: 200 }, result.history.resources[0]!.identity);
  assert.equal(evidence.total, total);
  assert.equal(evidence.events.length, 200);
  assert.equal(reads, 4, "超预算的快照不驻留");
  assert.equal(closed, 4);
});

test("空事件的来源缺口超出预算时也不驻留", () => {
  let reads = 0;
  const store = { usageVersion: () => "version", resourceEvents: () => {
    reads++;
    return { version: "version", events: [], sessionCount: 1, clients: ["codex"],
      gaps: [{ reason: "parse_error", message: "x".repeat(17 * 1024 * 1024) }] } as ResourceEventStream;
  } } as unknown as SessionStore;
  const cache = new ResourceUsageCache(store);
  assert.equal(cache.read({ kind: "skill" }, []).history.stats.events, 0);
  assert.equal(reads, 2);
  assert.equal(cache.read({ kind: "skill", from: "2026-01-02T00:00:00Z" }, []).history.stats.events, 0);
  assert.equal(reads, 4, "缺口上下文超预算也回退完整查询");
});
