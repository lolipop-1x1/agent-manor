import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AnalysisStore } from "../src/index/store.js";
import type { OverviewDetailPage, OverviewEvidencePage, OverviewPanelResult, OverviewReport, OverviewSnapshot } from "../src/overview-contracts.js";
import type { SessionSourceMeta } from "../src/session-contracts.js";
import { startService } from "../src/server.js";
import { SessionStore } from "../src/sessions/store.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

test("总览后台 HTTP 保持全局与模型局部范围，证据分页不泄露正文且固定版本", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-overview-service-")), home = join(directory, "data");
  await mkdir(home); new AnalysisStore(join(home, "index.sqlite")).close();
  const store = new SessionStore(join(home, "index.sqlite"));
  const summary: SessionSourceMeta = { id: "synthetic-overview-session", client: "codex", clientSessionId: "synthetic-overview-session",
    title: "合成总览会话", titleOrigin: "recorded", sourceId: "codex:synthetic-overview-session", path: "/synthetic/history/overview.jsonl",
    project: "/synthetic/project", models: ["synthetic-model"], messageCount: 0, turnCount: 0, gaps: [] };
  const revision = store.createRevision(summary.path, "synthetic");
  revision.sink.message({ id: "synthetic-user", sessionId: summary.id, ordinal: 0, recordLine: 1, turnId: "synthetic-turn",
    kind: "user", text: "synthetic-secret-body", occurredAt: "2026-10-11T01:00:00Z" });
  for (let index = 0; index < 31; index++) {
    const messageId = `synthetic-message-${index}`;
    revision.sink.message({ id: messageId, sessionId: summary.id, ordinal: index + 1, recordLine: index + 2, turnId: "synthetic-turn",
      kind: "assistant", text: "synthetic-secret-body", occurredAt: "2026-10-11T01:00:00Z" });
    revision.sink.usage({ id: `synthetic-request-${String(index).padStart(2, "0")}`, messageId, turnId: "synthetic-turn", model: "synthetic-model",
      occurredAt: "2026-10-11T01:00:00Z", inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, cacheWriteTokens: 0 });
  }
  revision.sink.message({ id: "synthetic-copied", sessionId: summary.id, ordinal: 32, recordLine: 33, turnId: "copied-turn",
    kind: "assistant", text: "synthetic-secret-body", copied: true, occurredAt: "2026-10-11T01:00:00Z" });
  revision.sink.usage({ id: "synthetic-copied-request", messageId: "synthetic-copied", model: "synthetic-model", inputTokens: 999999, outputTokens: 999999,
    occurredAt: "2026-10-11T01:00:00Z" });
  revision.sink.message({ id: "synthetic-call", sessionId: summary.id, ordinal: 33, recordLine: 34, turnId: "synthetic-turn", kind: "tool_call",
    text: "synthetic-secret-body", occurredAt: "2026-10-11T01:00:01Z", callId: "synthetic-call-id", tool: "mcp__synthetic__query",
    resource: { kind: "mcp", name: "synthetic", server: "synthetic" } });
  revision.sink.message({ id: "synthetic-result", sessionId: summary.id, ordinal: 34, recordLine: 35, turnId: "synthetic-turn", kind: "tool_result",
    text: "synthetic-secret-body", occurredAt: "2026-10-11T01:00:02Z", callId: "synthetic-call-id", tool: "mcp__synthetic__query", status: "failure" });
  revision.sink.message({ id: "synthetic-followup", sessionId: summary.id, ordinal: 35, recordLine: 36, turnId: "synthetic-turn", kind: "tool_call",
    text: "synthetic-secret-body", occurredAt: "2026-10-11T01:00:03Z", tool: "mcp__synthetic__query", status: "success",
    resource: { kind: "mcp", name: "synthetic", server: "synthetic" } });
  revision.sink.usage({ id: "synthetic-outside-request", model: "synthetic-model", inputTokens: 100, outputTokens: 20, occurredAt: "2026-10-05T01:00:00Z" });
  revision.flush(); store.finishRevision(revision.revision, summary);
  const version = store.publish(store.createJob().id, [{ path: summary.path, revision: revision.revision, fingerprint: "synthetic" }], []);
  store.close();
  const service = await startService({ home, startupRefresh: false, roots: isolatedHistoryRoots(),
    resourceInventory: { userHome: join(directory, "isolated-user"), environment: {} },
    usagePricing: { fetch: (async () => { throw new Error("synthetic network failure"); }) as typeof fetch } });
  const base = `http://127.0.0.1:${service.instance.port}/api/v1`;
  const read = async <T>(path: string): Promise<T> => {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.text(); assert.ok(!body.includes("synthetic-secret-body"));
    return JSON.parse(body) as T;
  };
  try {
    const params = new URLSearchParams({ version, window: "custom", from: "2026-10-11", to: "2026-10-11", timezone: "Asia/Shanghai" });
    const [first, duplicate] = await Promise.all([read<OverviewReport>(`/overview/report?${params}`), read<OverviewReport>(`/overview/report?${params}`)]);
    assert.deepEqual(first, duplicate);
    assert.equal(first.summary.sessions, 1); assert.equal(first.summary.requests, 31); assert.equal(first.summary.tokens, 31 * 120);
    assert.equal(first.summary.activeDays, 1); assert.equal(first.process.failures, 1);
    assert.equal(first.resources.mcp[0]!.uses, 2); assert.equal(first.resources.mcp[0]!.results.failure, 1);
    assert.deepEqual(first.process.failureSequences, []);
    assert.ok(first.insights.length <= 5);
    assert.ok(first.insights.every(insight => !["10", "12", "14", "15"].includes(insight.rule)));
    const fixed = new URLSearchParams(params); fixed.set("priceVersion", first.priceVersion);
    fixed.set("anchorDay", first.query.anchorDay!);
    assert.deepEqual(await read<OverviewReport>(`/overview/report?${fixed}`), first);
    const snapshot = await read<OverviewSnapshot>(`/overview/snapshot?${fixed}`);
    const panels = await Promise.all(["core", "usage", "resources", "process", "repositories", "insights"].map(panel =>
      read<OverviewPanelResult>(`/overview/panel?${fixed}&panel=${panel}`)));
    for (const panel of panels) assert.deepEqual(panel.snapshot, snapshot);
    const [core, usage, resources, process, repositories, insights] = panels;
    assert.deepEqual(core!.data.summary, first.summary); assert.deepEqual(core!.data.activity, first.activity);
    assert.deepEqual(core!.data.totals, first.totals); assert.equal(usage!.data.usage!.totals.requests, 31);
    assert.deepEqual(usage!.data.usage!.groups, []); assert(usage!.data.usage!.days.every(day => day.groups.length === 0));
    assert.equal("sessions" in usage!.data.usage!, false); assert.equal("pricing" in usage!.data.usage!, false);
    assert.equal("distributions" in usage!.data, false); assert.equal("delegation" in usage!.data, false);
    assert.equal(core!.data.delegationSummary!.eligibleMainSessions, first.delegation.eligibleMainSessions);
    const facets = await read<OverviewPanelResult>(`/overview/panel?${fixed}&panel=facets`);
    assert.deepEqual(facets.data.facets, first.facets);
    const distribution = await read<OverviewPanelResult>(`/overview/panel?${fixed}&panel=distribution&dimension=model`);
    assert.deepEqual(distribution.snapshot, snapshot); assert.equal(distribution.dimension, "model");
    assert.deepEqual(distribution.data.distribution, first.distributions.models);
    assert.deepEqual(distribution.counts, { models: 1 });
    const delegation = await read<OverviewPanelResult>(`/overview/panel?${fixed}&panel=delegation`);
    assert.deepEqual(delegation.snapshot, snapshot); assert.deepEqual(delegation.data.delegation, first.delegation);
    assert.equal(resources!.counts!.mcp, 1); assert.equal(resources!.data.resources!.mcp[0]!.uses, 2);
    assert.deepEqual(resources!.data.resources!.mcp[0]!.days, first.resources.mcp[0]!.days);
    assert.deepEqual(resources!.data.resources!.mcp[0]!.tools, []);
    assert.equal(process!.data.process!.failures, 1); assert.equal("timing" in process!.data.process!, false);
    assert.equal("compressions" in process!.data.process!, false);
    assert.deepEqual(repositories!.data.repositories, []); assert.ok(insights!.data.insights!.length <= 5);
    const resourceId = resources!.data.resources!.mcp[0]!.id;
    const detail = await read<OverviewDetailPage>(`/overview/detail?${fixed}&detail=${encodeURIComponent(JSON.stringify({ view: "resource", resourceId, dimension: "tool", pageSize: 1 }))}`);
    assert.deepEqual(detail.snapshot, snapshot); assert.equal(detail.total, 1); assert.equal(detail.rows.length, 1);
    assert.equal(detail.object!.uses, 2); assert.deepEqual(detail.object!.tools, []);
    const ranking = await read<OverviewDetailPage>(`/overview/detail?${fixed}&detail=${encodeURIComponent(JSON.stringify({ view: "ranking", dimension: "model", sort: "cost" }))}`);
    assert.equal(ranking.total, 1); assert.equal((ranking.rows[0] as { requests: number }).requests, 31);
    fixed.set("evidence", JSON.stringify({ kind: "requests", from: "2026-10-01", to: "2026-10-31" }));
    assert.equal((await read<OverviewEvidencePage>(`/overview/evidence?${fixed}`)).total, 31);
    fixed.set("evidence", JSON.stringify({ kind: "sequence", tool: "mcp__synthetic__query", sort: "ordinal", pageSize: 1 }));
    const sequence = await read<OverviewEvidencePage>(`/overview/evidence?${fixed}`);
    assert.equal(sequence.total, 2); assert.equal(sequence.rows.length, 1); assert.equal(sequence.rows[0]!.messageId, "synthetic-call");
    const evidence = { kind: "requests", page: 2, pageSize: 12 };
    fixed.set("evidence", JSON.stringify(evidence));
    const page = await read<OverviewEvidencePage>(`/overview/evidence?${fixed}`);
    assert.equal(page.version, first.version); assert.equal(page.priceVersion, first.priceVersion);
    assert.equal(page.total, 31); assert.equal(page.rows.length, 12);
    params.set("models", '["synthetic-unobserved-model"]');
    const filtered = await read<OverviewReport>(`/overview/report?${params}`);
    assert.equal(filtered.summary.requests, 31); assert.equal(filtered.usage.totals.requests, 0);
    assert.equal(filtered.process.failures, 1); assert.equal(filtered.resources.mcp[0]!.uses, 2);
    assert.equal(filtered.summary.activeDays, 1);
    assert.equal((await fetch(`${base}/overview/report?window=unknown`)).status, 400);
    assert.equal((await fetch(`${base}/overview/report?version=synthetic-unavailable`)).status, 404);
    assert.equal((await fetch(`${base}/overview/report?priceVersion=synthetic-unavailable`)).status, 404);
    assert.equal((await fetch(`${base}/overview/evidence?evidence=${encodeURIComponent('{"kind":"tools","pageSize":201}')}`)).status, 400);
    assert.equal((await fetch(`${base}/overview/panel?panel=unknown`)).status, 400);
    assert.equal((await fetch(`${base}/overview/panel?panel=distribution`)).status, 400);
    assert.equal((await fetch(`${base}/overview/panel?panel=distribution&dimension=tool`)).status, 400);
    assert.equal((await fetch(`${base}/overview/panel?panel=usage&dimension=model`)).status, 400);
    assert.equal((await fetch(`${base}/overview/detail?detail=${encodeURIComponent('{"view":"resource"}')}`)).status, 400);
    for (const view of ["timings", "timing"]) assert.equal((await fetch(`${base}/overview/detail?detail=${encodeURIComponent(JSON.stringify({ view }))}`)).status, 400);
    for (const kind of ["timing", "compressions"]) assert.equal((await fetch(`${base}/overview/evidence?evidence=${encodeURIComponent(JSON.stringify({ kind }))}`)).status, 400);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
