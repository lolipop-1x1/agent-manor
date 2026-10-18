import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeStore } from "../src/knowledge/store.js";
import { knowledgeFixture, requestError } from "./helpers/knowledge-fixture.js";

test("抽取任务摘要在后台分页并去掉大结果，完整查询保留原任务详情", async () => knowledgeFixture(async ({ agent, home, calls }) => {
  const store = new KnowledgeStore(join(home, "knowledge", "knowledge.sqlite"));
  const ids = Array.from({ length: 25 }, (_, index) => `fixture-task-${index}`);
  const results = Array.from({ length: 2000 }, (_, index) => ({ knowledgeId: `fixture-knowledge-${index}`, revisionId: `fixture-revision-${index}` }));
  const events = Array.from({ length: 400 }, (_, index) => ({ id: `fixture-event-${index}`, at: "2026-01-01T00:00:00Z", kind: "progress" }));
  const failedSessions = Array.from({ length: 80 }, (_, index) => ({ sessionId: `fixture-session-${index}`, title: "合成失败会话", error: "synthetic diagnostic".repeat(20) }));
  try {
    for (const id of ids) store.setState(`extraction.job:${id}`, { job: { id, previewId: "fixture-preview", status: id === ids[0] ? "running" : "complete", phase: "complete",
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", totalSessions: 80, completedSessions: 80, totalChunks: 100, completedChunks: 100,
      createdEntries: 2000, updatedEntries: 0, duplicates: 0, noValue: 0, needsContext: 0, results, events, failedSessions,
      error: "synthetic task error", errorDescriptor: { key: "knowledge.errors.stopped" }, outputLanguage: "en", fingerprint: "synthetic-fingerprint" },
      preview: { targets: [{ title: "合成任务标题" }] } });
    const idempotencyKey = "fixture-existing-task";
    const idempotencyHash = createHash("sha256").update(JSON.stringify(idempotencyKey)).digest("hex");
    store.setState("extraction.manager", { previews: [], jobs: ids, idempotency: { [idempotencyHash]: { previewId: "fixture-preview", jobId: ids[0] } }, automatic: { enabled: false } });
    const list = await agent<any>("/extractions?response=summary");
    assert.equal(list.total, 25); assert.equal(list.jobs.length, 20); assert.equal(list.page, 1); assert.equal(list.pageSize, 20); assert.equal(list.hasMore, true);
    assert.equal(list.jobs[0].id, ids.at(-1)); assert.equal(list.jobs[0].resultCount, 2000); assert.equal(list.jobs[0].eventCount, 400);
    assert.equal(list.jobs[0].failedSessionCount, 80); assert.equal(list.jobs[0].error, "synthetic task error");
    assert.equal(list.jobs[0].results, undefined); assert.equal(list.jobs[0].events, undefined); assert.equal(list.jobs[0].failedSessions, undefined);
    assert.ok(JSON.stringify(list).length < 25000);
    const next = await agent<any>("/extractions?response=summary&page=2&pageSize=3");
    assert.deepEqual(next.jobs.map((job: { id: string }) => job.id), ids.toReversed().slice(3, 6)); assert.equal(next.total, 25);
    const empty = await agent<any>("/extractions?response=summary&page=100&pageSize=3"); assert.deepEqual(empty.jobs, []); assert.equal(empty.hasMore, false);
    const summary = await agent<any>(`/extractions/${ids[0]}?response=summary`);
    assert.equal(summary.title, "合成任务标题"); assert.equal(summary.resultCount, 2000); assert.equal(summary.eventCount, 400); assert.equal(summary.results, undefined);
    assert.ok(JSON.stringify(summary).length < 2000);
    const full = await agent<any>(`/extractions/${ids[0]}`);
    assert.equal(full.results.length, 2000); assert.equal(full.events.length, 400); assert.equal(full.failedSessions.length, 80);
    assert.ok(JSON.stringify(full).length > 100000);
    const replay = await agent<any>("/extractions?response=summary", "POST", { previewId: "fixture-preview", idempotencyKey });
    assert.equal(replay.id, ids[0]); assert.equal(replay.resultCount, 2000); assert.equal(replay.results, undefined);
    const paused = await agent<any>(`/extractions/${ids[0]}/pause?response=summary`, "POST", {});
    assert.equal(paused.status, "paused"); assert.equal(paused.results, undefined); assert.equal(paused.resultCount, 2000); assert.ok(JSON.stringify(paused).length < 2000);
    const readBack = await agent<any>(`/extractions/${ids[0]}`); assert.equal(readBack.status, "paused"); assert.equal(readBack.results.length, 2000);
    const original = await agent<any>("/extractions"); assert.equal(original.jobs.length, 25); assert.equal(original.jobs[0].results.length, 2000); assert.equal(original.total, undefined);
    await assert.rejects(agent("/extractions?response=summary&page=0"), requestError("INVALID_INPUT"));
    await assert.rejects(agent("/extractions?response=summary&pageSize=201"), requestError("INVALID_INPUT"));
    await assert.rejects(agent("/extractions?response=unknown"), requestError("INVALID_INPUT"));
    assert.equal(calls.length, 0);
  } finally { store.close(); }
}));
