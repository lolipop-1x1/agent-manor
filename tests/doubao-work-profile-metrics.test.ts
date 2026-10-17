import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseNormalizedSession, normalizedRecord, normalizedSnapshot } from "../src/history/adapters/normalized.js";
import { SessionStore } from "../src/sessions/store.js";
import { OverviewFactStore } from "../src/overview/facts.js";
import { WeeklyReviewFactStore } from "../src/overview/weekly-review-facts.js";
import type { SessionContextSnapshot } from "../src/session-contracts.js";

test("上下文快照独立持久化，画像及跨周回复耗时在原始和窄缓存投影一致", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-native-message-metrics-"));
  const path = join(directory, "sessions.sqlite");
  let store = new SessionStore(path);
  const context: SessionContextSnapshot = { id: "synthetic-context", occurredAt: "2026-10-05T00:00:30.000Z", usedTokens: 40,
    capacityTokens: 100, systemPromptTokens: 10, messageTokens: 20, skillTokens: 5, toolTokens: 5 };
  try {
    const snapshot = normalizedSnapshot({ client: "pi", path: "/synthetic/cache/CURRENT", sessionId: "synthetic-native" }, [
      normalizedRecord({ key: "u", kind: "user", text: "合成需求", turnKey: "u", occurredAt: "2026-10-04T23:59:00.000Z" }, "{}", 1),
      normalizedRecord({ key: "a", kind: "assistant", text: "合成回复", turnKey: "u", allowInferredFinal: false,
        occurredAt: "2026-10-04T23:59:01.000Z", finishedAt: "2026-10-05T00:00:30.000Z", durationMs: 89_000 }, "{}", 2),
    ], { contextSnapshots: [context] });
    const pending = store.createRevision(snapshot.source.path, snapshot.hash);
    const meta = parseNormalizedSession(snapshot, pending.sink);
    pending.flush(); store.finishRevision(pending.revision, meta);
    const version = store.publish(store.createJob().id, [{ path: snapshot.source.path, revision: pending.revision, fingerprint: snapshot.hash }], []);
    assert.equal(meta.updatedAt, "2026-10-05T00:00:30.000Z", "来源时间覆盖已记录的消息结束，跨日候选不漏读");
    store.close(); store = new SessionStore(path);
    const profile = store.profile(meta.id);
    assert.deepEqual(profile.contextSnapshots, [{ ...context, sessionId: meta.id }]);
    assert.equal(profile.roundMetrics?.averageDurationMs, 90_000);
    assert.equal(profile.roundMetrics?.averageSteps, 1);
    assert.equal(profile.roundMetrics?.estimatedStepTurns, 1);
    assert.equal(profile.usage.requests, 0);
    assert.equal(profile.usage.inputTokens, null);
    assert.equal(profile.usage.peakContextTokens, null, "独立窗口快照不混入逐请求峰值");
    assert.equal(profile.tools.length, 0);
    assert.equal(profile.steps.length, 0);
    assert.equal(profile.usageReports, undefined);
    const query = { version, timezone: "UTC", anchorDay: "2026-10-12" };
    for (const prepared of [false, true]) {
      if (prepared) {
        const overview = new OverviewFactStore(store);
        try { await overview.prepare(query, new Date("2026-10-12T04:00:00Z")); } finally { overview.close(); }
      }
      const facts = new WeeklyReviewFactStore(store, join(directory, prepared ? "prepared.sqlite" : "raw.sqlite"));
      try {
        const first = await facts.source(query, new Date("2026-10-12T04:00:00Z"));
        const round = first.facts[0]?.rounds[0];
        assert.equal(round?.durationMs, 90_000);
        assert.equal(round?.endedAt, "2026-10-05T00:00:30.000Z");
        assert.equal(round?.completion, "inferred");
        assert.equal(round?.finalEvidence, undefined);
        assert.deepEqual((await facts.source(query, new Date("2026-10-12T04:00:00Z"))).facts, first.facts);
      } finally { facts.close(); }
    }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
