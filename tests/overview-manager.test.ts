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
    const dispatched = (manager as unknown as { nextId: number }).nextId;
    assert.deepEqual(await manager.report(report.query), report);
    assert.equal((manager as unknown as { nextId: number }).nextId, dispatched);
    await manager.report({ ...report.query, models: ["synthetic-other-model"] });
    const filteredDispatches = (manager as unknown as { nextId: number }).nextId;
    assert.deepEqual(await manager.report(report.query), report);
    assert.equal((manager as unknown as { nextId: number }).nextId, filteredDispatches);
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

test("核心分区重启复用持久结果，模型身份重绑定且已淘汰版本先拒绝", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-overview-panels-")), store = new SessionStore(join(directory, "index.sqlite"));
  const id = "synthetic-main", path = "/synthetic/main.jsonl", revision = store.createRevision(path, "synthetic");
  revision.sink.message({ id: "synthetic-user", sessionId: id, ordinal: 0, recordLine: 1, turnId: "synthetic-turn", kind: "user", text: "合成正文", occurredAt: "2026-03-01T12:00:00Z" });
  revision.sink.usage({ id: "synthetic-request", messageId: "synthetic-user", inputTokens: 100, outputTokens: 20, model: "synthetic-model", occurredAt: "2026-03-01T12:00:00Z" });
  revision.flush(); store.finishRevision(revision.revision, { id, path, sourceId: "synthetic-source", client: "codex", clientSessionId: id,
    title: "合成会话", titleOrigin: "recorded", models: ["synthetic-model"], messageCount: 1, turnCount: 1, gaps: [] });
  const version = store.publish(store.createJob().id, [{ path, revision: revision.revision, fingerprint: "synthetic" }], []);
  const prices = new PricingService(directory), clock = () => new Date("2026-03-01T12:00:00Z");
  const first = new OverviewManager(store, prices, () => [], clock);
  const internal = first as unknown as { dispatch(type: string, ...parameters: unknown[]): Promise<unknown> };
  const dispatch = internal.dispatch.bind(first), dispatchedTypes: string[] = [];
  internal.dispatch = (type, ...parameters) => { dispatchedTypes.push(type); return dispatch(type, ...parameters); };
  const query = { window: "365" as const, timezone: "UTC", version };
  let restarted: OverviewManager | undefined;
  try {
    const [core, duplicate] = await Promise.all([first.panel(query, "core"), first.panel(query, "core"),
      first.panel(query, "resources"), first.panel(query, "process")]);
    assert.deepEqual(core, duplicate); assert.equal(core.data.summary!.requests, 1);
    assert.equal(dispatchedTypes.filter(type => type === "prepare").length, 1);
    await first.panel({ ...query, window: "30", models: ["synthetic-other"] }, "core");
    assert.equal(dispatchedTypes.filter(type => type === "prepare").length, 1);
    await first.panel({ ...query, timezone: "America/New_York" }, "core");
    assert.equal(dispatchedTypes.filter(type => type === "prepare").length, 2);
    await first.close(); restarted = new OverviewManager(store, prices, () => [], clock);
    assert.deepEqual(await restarted.panel(query, "core"), core);
    assert.equal((restarted as unknown as { nextId: number }).nextId, 0);
    const model = await restarted.panel({ ...query, models: ["synthetic-other"] }, "core");
    assert.deepEqual(model.data.summary, core.data.summary); assert.deepEqual(model.snapshot.query.models, ["synthetic-other"]);
    assert.equal((restarted as unknown as { nextId: number }).nextId, 0);
    await assert.rejects(restarted.panel({ ...query, version: "synthetic-missing" }, "core"), { code: "VERSION_NOT_FOUND" });
    await assert.rejects(restarted.panel({ ...query, priceVersion: "synthetic-missing" }, "core"), { code: "VERSION_NOT_FOUND" });
  } finally { await first.close(); await restarted?.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
