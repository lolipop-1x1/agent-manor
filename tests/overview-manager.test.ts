import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OverviewManager } from "../src/overview/manager.js";
import { SessionStore } from "../src/sessions/store.js";
import { PricingService } from "../src/usage/pricing.js";

test("后台跨午夜缓存沿用报告日期，显式新报告重新计算完整日期", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-overview-clock-")), store = new SessionStore(join(directory, "index.sqlite"));
  const id = "synthetic-session", path = "/synthetic/history/clock.jsonl", revision = store.createRevision(path, "synthetic");
  for (const [index, day] of ["2026-02-28", "2026-03-01"].entries()) {
    const messageId = `synthetic-message-${index}`;
    revision.sink.message({ id: messageId, sessionId: id, ordinal: index, recordLine: index + 1, turnId: "synthetic-turn",
      kind: "assistant", text: "合成正文", occurredAt: `${day}T12:00:00Z` });
    revision.sink.usage({ id: `synthetic-request-${index}`, messageId, model: "synthetic-model", inputTokens: 100, outputTokens: 20, occurredAt: `${day}T12:00:00Z` });
  }
  revision.flush(); store.finishRevision(revision.revision, { id, client: "codex", clientSessionId: id, path, sourceId: "synthetic-source",
    project: "/synthetic/project", title: "合成日期会话", titleOrigin: "recorded", messageCount: 2, turnCount: 1, models: ["synthetic-model"], gaps: [] });
  store.publish(store.createJob().id, [{ path, revision: revision.revision, fingerprint: "synthetic" }], []);
  let now = new Date("2026-03-01T12:00:00Z");
  const prices = new PricingService(directory), manager = new OverviewManager(store, prices, () => [], () => now);
  try {
    const query = { window: "365" as const, timezone: "UTC", clients: ["codex"], projects: ["/synthetic/project"], models: ["synthetic-model"] };
    const report = await manager.report(query);
    now = new Date("2026-03-02T12:00:00Z");
    assert.equal(report.query.anchorDay, "2026-03-01");
    assert.deepEqual((await manager.report(report.query)).range, report.range);
    assert.deepEqual((await manager.evidence(report.query, { kind: "requests", period: "current", scope: "usage" })).rows.map(row => row.requestId), ["synthetic-request-0"]);
    assert.equal((await manager.evidence(report.query, { kind: "requests", period: "recent", scope: "usage" })).total, 1);
    const updated = await manager.report(query);
    assert.equal(updated.query.anchorDay, "2026-03-02");
    assert.equal((await manager.evidence(updated.query, { kind: "requests", period: "current", scope: "usage" })).total, 2);
  } finally { await manager.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
