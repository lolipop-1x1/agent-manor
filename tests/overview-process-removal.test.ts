import assert from "node:assert/strict";
import { test } from "node:test";
import { overviewDetailQuery, overviewEvidenceQuery } from "../src/service/overview-input.ts";
import { readOverviewRoute, overviewAddress } from "../web/features/overview/model.ts";

import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withoutRequestTiming, removeStoredRequestTiming } from "../src/overview/request-projection.ts";
import { OverviewManager } from "../src/overview/manager.ts";
import { PricingService } from "../src/usage/pricing.ts";
import { AnalysisStore } from "../src/index/store.ts";
import { SessionStore } from "../src/sessions/store.ts";
import { OverviewResultStore } from "../src/overview/result-store.ts";
import { weeklyRoundFacts } from "../src/overview/weekly-review-facts.ts";
import type { SessionUsage } from "../src/session-contracts.ts";


test("总览不再接受请求计时或过程压缩记录接口", () => {
  for (const view of ["timing", "timings"]) assert.throws(() => overviewDetailQuery(JSON.stringify({ view, timingGroup: "old-group" })));
  for (const kind of ["timing", "compressions"]) assert.throws(() => overviewEvidenceQuery(JSON.stringify({ kind })));
  assert.throws(() => overviewEvidenceQuery(JSON.stringify({ kind: "requests", timingGroup: "old-group" })));
  assert.throws(() => overviewEvidenceQuery(JSON.stringify({ kind: "requests", sort: "duration" })));
  assert.equal(overviewEvidenceQuery(JSON.stringify({ kind: "failures", sort: "duration" })).kind, "failures");
});

test("旧过程调查链接移除已删除选择并保留其他筛选", () => {
  for (const process of ["timing", "compressions", "failures"]) {
    const route = readOverviewRoute(`#overview?window=7&clients=%5B%22codex%22%5D&process=${process}`);
    assert.equal(overviewAddress(route).includes("process="), false);
    assert.equal(route.window, "7"); assert.deepEqual(route.clients, ["codex"]);
  }
});

const timed = (mirror = false): SessionUsage => ({ id: "request-a", inputTokens: 100, outputTokens: 20,
  occurredAt: "2026-01-01T00:00:05Z", timing: { basis: "estimated", method: "codex_event_boundary", completion: "inferred", durationMs: 5000,
    end: { messageId: "reply-a", ...(mirror ? { source: "mirror" as const } : {}) } } });

test("移除请求计时仍保留真实结束身份和七天轮次，镜像身份不参与", () => {
  const events = [{ id: "user-a", kind: "user" as const, ordinal: 1, recordLine: 1, turnId: "turn-a", occurredAt: "2026-01-01T00:00:00Z" },
    { id: "reply-a", kind: "assistant" as const, ordinal: 2, recordLine: 2, turnId: "turn-a", hasReply: true, occurredAt: "2026-01-01T00:00:05Z" }];
  const usage = withoutRequestTiming(timed()); assert.equal(usage.timing, undefined);
  assert.deepEqual(usage.requestMessageIds, ["reply-a"]);
  assert.deepEqual(withoutRequestTiming({ ...timed(), requestMessageIds: ["reply-a", "reply-a"] }).requestMessageIds, ["reply-a", "reply-a"]);
  const rounds = weeklyRoundFacts(events, [{ sessionId: "session-a", usage }]);
  assert.equal(rounds.rounds[0]!.steps, 1); assert.equal(rounds.rounds[0]!.durationMs, 5000); assert.equal(rounds.rounds[0]!.tokens, 120);
  const mirror = weeklyRoundFacts(events, [{ sessionId: "session-a", usage: withoutRequestTiming(timed(true)) }]);
  assert.equal(mirror.unassigned, 1); assert.equal(mirror.rounds[0]!.steps, null);
});

test("旧总览请求派生 JSON 原地清理计时，日期和用量完整保留", () => {
  for (const table of ["overview_fact_requests", "weekly_requests"] as const) {
    const db = new Database(":memory:"); db.exec(`CREATE TABLE ${table}(json TEXT)`);
    const insert = db.prepare(`INSERT INTO ${table} VALUES(?)`);
    for (const mirror of [false, true]) insert.run(JSON.stringify({ sessionId: "session-a", usage: timed(mirror) }));
    insert.run(JSON.stringify({ usage: { ...timed(), requestMessageIds: ["reply-a", "reply-a"] } }));
    insert.run(JSON.stringify({ usage: { ...timed(), requestMessageIds: ["start-a", "start-a"] } }));
    removeStoredRequestTiming(db, table);
    const rows = db.prepare(`SELECT json FROM ${table}`).all() as { json: string }[];
    for (const row of rows) { const usage = JSON.parse(row.json).usage; assert.equal(usage.timing, undefined); assert.equal(usage.inputTokens, 100); assert.equal(usage.occurredAt, timed().occurredAt); }
    assert.deepEqual(JSON.parse(rows[0]!.json).usage.requestMessageIds, ["reply-a"]);
    assert.equal(JSON.parse(rows[1]!.json).usage.requestMessageIds, undefined);
    assert.deepEqual(JSON.parse(rows[2]!.json).usage.requestMessageIds, ["reply-a", "reply-a"]);
    assert.deepEqual(JSON.parse(rows[3]!.json).usage.requestMessageIds, ["start-a", "start-a", "reply-a"]);
    removeStoredRequestTiming(db, table); db.close();
  }
});

test("升级清除旧总览结果与请求证据缓存，保留七天洞察缓存", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-process-cache-")), path = join(directory, "overview.sqlite");
  const key = (type: string, extra = {}) => JSON.stringify([6, type, {}, extra]);
  try {
    const db = new Database(path); db.exec("CREATE TABLE overview_results(key TEXT PRIMARY KEY,format INTEGER,json TEXT,bytes INTEGER,accessed INTEGER)");
    const insert = db.prepare("INSERT INTO overview_results VALUES(?,2,?,2,1)");
    for (const type of ["report", "evidence", "review", "review_detail"]) insert.run(key(type), "{}");
    db.close(); const cache = new OverviewResultStore(path); const valid = (v: unknown): v is object => typeof v === "object" && v !== null;
    assert.equal(cache.get(key("report"), valid), undefined); assert.equal(cache.get(key("evidence"), valid), undefined);
    assert.deepEqual(cache.get(key("review"), valid), {}); assert.deepEqual(cache.get(key("review_detail"), valid), {}); cache.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("工具失败通道首次启动在历史刷新持有源库写锁时仍可统计", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-process-readonly-")), path = join(directory, "index.sqlite");
  new AnalysisStore(path).close(); const sessions = new SessionStore(path);
  const entry = sessions.createRevision("/synthetic/history.jsonl", "synthetic");
  entry.sink.message({ id: "user-a", sessionId: "session-a", ordinal: 1, recordLine: 1, turnId: "turn-a", kind: "user", text: "合成需求", occurredAt: "2026-01-10T00:00:00Z" });
  entry.sink.message({ id: "call-a", sessionId: "session-a", ordinal: 2, recordLine: 2, turnId: "turn-a", kind: "tool_call", tool: "read_file", status: "failure", text: "合成调用", occurredAt: "2026-01-10T00:00:01Z" });
  entry.flush(); sessions.finishRevision(entry.revision, { id: "session-a", path: "/synthetic/history.jsonl", sourceId: "source-a", client: "codex", clientSessionId: "session-a", title: "合成会话", titleOrigin: "recorded", models: [], messageCount: 2, turnCount: 1, gaps: [] });
  const version = sessions.publish(sessions.createJob().id, [{ path: "/synthetic/history.jsonl", revision: entry.revision, fingerprint: "synthetic" }], []);
  const manager = new OverviewManager(sessions, new PricingService(directory), () => [], () => new Date("2026-01-12T00:00:00Z")), writer = new Database(path);
  writer.exec("BEGIN IMMEDIATE"); writer.prepare("UPDATE session_state SET json=json WHERE id=1").run();
  try {
    const process = await manager.panel({ version, timezone: "UTC" }, "process");
    assert.equal(process.data.process!.failures, 1);
    assert.equal(process.data.process!.tools[0]!.name, "read_file");
  } finally { writer.exec("ROLLBACK"); writer.close(); await manager.close(); sessions.close(); await rm(directory, { recursive: true, force: true }); }
});
