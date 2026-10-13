import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OverviewEvidenceQuery, OverviewQuery, OverviewSource } from "../src/overview-contracts.js";
import { buildOverviewReport } from "../src/overview/analytics.js";
import { buildOverviewEvidence } from "../src/overview/evidence.js";
import { factEvidence } from "../src/overview/evidence-facts.js";
import { OverviewFactStore } from "../src/overview/facts.js";
import { SessionStore } from "../src/sessions/store.js";
import { now, pricing } from "./overview-fixtures.js";

const normalized = <T>(value: T): T => JSON.parse(JSON.stringify(value));
async function fixture(run: (facts: OverviewFactStore, source: OverviewSource) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-overview-evidence-page-")), store = new SessionStore(join(directory, "index.sqlite"));
  const facts = new OverviewFactStore(store);
  try {
    const revisions = Array.from({ length: 5 }, (_, index) => {
      const id = `synthetic-${index}`, path = `/synthetic/history/${id}.jsonl`, pending = store.createRevision(path, "synthetic");
      for (let ordinal = 0; ordinal < 12; ordinal++) {
        const messageId = `message-${ordinal}`, occurredAt = ordinal < 5 ? "2026-01-01T12:00:00Z" : "2026-02-01T12:00:00Z";
        pending.sink.message({ id: messageId, sessionId: id, ordinal, recordLine: ordinal + 1, turnId: "synthetic-turn",
          kind: ordinal === 4 ? "compression" : ordinal % 3 === 0 ? "user" : "tool_call", text: "合成正文",
          tool: "read_file", status: ordinal % 2 ? "failure" : "success", occurredAt,
          ...(ordinal % 3 === 1 ? { resource: { kind: "skill_call" as const, name: "synthetic-skill" } } : {}) });
        pending.sink.usage({ id: `request-${ordinal}`, messageId, turnId: "synthetic-turn", occurredAt,
          model: ordinal < 5 ? "unknown" : "literal:model-a", inputTokens: ordinal * 100, outputTokens: 10,
          requestMessageIds: [messageId, `message-${Math.max(0, ordinal - 1)}`],
          timing: { basis: "recorded", method: "zcode_request_span", completion: "explicit", durationMs: (ordinal + 1) * 1000 } });
      }
      pending.flush(); store.finishRevision(pending.revision, { id, path, sourceId: `source-${id}`, client: index === 4 ? "claude" : "codex", clientSessionId: id,
        project: index % 2 ? "/synthetic/project-a" : "literal:project-a", title: "合成会话", titleOrigin: "recorded", models: [], messageCount: 12, turnCount: 1, gaps: [] });
      return { path, revision: pending.revision, fingerprint: "synthetic" };
    });
    store.publish(store.createJob().id, revisions, []);
    await run(facts, store.overviewSource());
  } finally { facts.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
}

test("当前证据页与原统计在范围、排序、模型身份和请求上下文上等价", async () => fixture(async (facts, source) => {
  const queries: OverviewQuery[] = [{ window: "all", timezone: "UTC" },
    { window: "custom", from: "2026-01-01", to: "2026-02-02", timezone: "America/New_York", clients: ["codex"] },
    { window: "30", timezone: "UTC", models: ["literal:literal:model-a"] }];
  const cases: OverviewEvidenceQuery[] = [
    { kind: "requests", sort: "tokens" }, { kind: "requests", sort: "ordinal" },
    { kind: "requests", scope: "usage", model: "literal:unknown" }, { kind: "requests", period: "previous" },
    { kind: "requests", project: "literal:literal:project-a" }, { kind: "requests", client: "claude" },
    { kind: "resources" }, { kind: "tools" }, { kind: "tools", sort: "duration" }, { kind: "failures", tool: "read_file" }];
  facts.source = async () => { throw new Error("证据页不能恢复完整来源"); };
  for (const query of queries) {
    const report = buildOverviewReport(source, query, pricing, now); await facts.prepare(report.query, now);
    for (const item of [...cases]) for (const page of [1, 2]) {
      const evidence = { ...item, page, pageSize: 3 };
      const actual = await factEvidence(facts, report, evidence, pricing, now), expected = buildOverviewEvidence(source, report.query, evidence, pricing, now);
      assert.deepEqual(normalized(actual), normalized(expected), JSON.stringify({ query, evidence }));
    }
  }
}));

test("请求成员仅恢复当前页与直接前邻居，不读取其他会话历史", async () => fixture(async (facts, source) => {
  const report = buildOverviewReport(source, { window: "all", timezone: "UTC" }, pricing, now); await facts.prepare(report.query, now);
  let restored = 0; const hydrate = facts.hydrateRequestMembers.bind(facts);
  facts.hydrateRequestMembers = rows => { restored += rows.length; return hydrate(rows); };
  const page = await factEvidence(facts, report, { kind: "requests", sort: "tokens", page: 2, pageSize: 3 }, pricing, now);
  assert.equal(page.total, 60); assert.equal(page.rows.length, 3); assert.ok(restored <= 6);
  assert.ok(page.rows.every(row => row.usage?.requestMessageIds?.length === 2));
}));
