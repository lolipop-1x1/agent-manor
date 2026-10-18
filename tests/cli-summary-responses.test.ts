import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AnalysisStore } from "../src/index/store.js";
import { SessionStore } from "../src/sessions/store.js";
import { startService } from "../src/server.js";
import type { SessionSourceMeta } from "../src/session-contracts.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

test("画像轻量投影保留来源完整性，不能把缺失记录推断成完整轮次", async t => {
  const directory = await mkdtemp(join(tmpdir(), "manor-incomplete-summary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "index.sqlite"); new AnalysisStore(path).close();
  const store = new SessionStore(path); t.after(() => store.close());
  const meta: SessionSourceMeta = { id: "fixture-incomplete", client: "codex", clientSessionId: "fixture-incomplete", title: "合成不完整会话",
    titleOrigin: "recorded", sourceId: "fixture-source", path: "/synthetic/incomplete.jsonl", models: [], messageCount: 2, turnCount: 1,
    gaps: [{ kind: "incomplete_record", message: "synthetic" }] };
  const revision = store.createRevision(meta.path, "synthetic");
  revision.sink.message({ id: "user", sessionId: meta.id, ordinal: 1, recordLine: 1, turnId: "fixture-turn", kind: "user", text: "合成问题" });
  revision.sink.message({ id: "assistant", sessionId: meta.id, ordinal: 2, recordLine: 2, turnId: "fixture-turn", kind: "assistant", final: "explicit", text: "合成回复" });
  revision.sink.usage({ id: "request", messageId: "assistant", turnId: "fixture-turn", inputTokens: 2, outputTokens: 3 });
  revision.flush(); store.finishRevision(revision.revision, meta);
  const version = store.publish(store.createJob().id, [{ path: meta.path, revision: revision.revision, fingerprint: "synthetic" }], []);
  const full = store.profile(meta.id, { version });
  const summary = store.profileSection(meta.id, { version, response: "summary" }) as { roundMetrics: unknown; gapCount: number; gaps?: unknown };
  assert.equal(full.roundMetrics?.stepTurns, 0); assert.equal(full.roundMetrics?.averageSteps, null);
  assert.deepEqual(summary.roundMetrics, full.roundMetrics);
  assert.equal(summary.gapCount, 1); assert.equal(summary.gaps, undefined);
});

test("CLI 摘要限制大字段，正文与画像明细按固定版本分页回读，完整 Web 响应保留", async t => {
  const directory = await mkdtemp(join(tmpdir(), "manor-cli-summary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "data"); await mkdir(home);
  const path = join(home, "index.sqlite"); new AnalysisStore(path).close();
  const store = new SessionStore(path);
  const meta: SessionSourceMeta = { id: "fixture-summary", client: "codex", clientSessionId: "fixture-summary", title: "合成摘要测试",
    titleOrigin: "recorded", sourceId: "fixture-source", path: "/synthetic/summary.jsonl", models: [], messageCount: 2, turnCount: 1, gaps: [],
    contextSnapshots: Array.from({ length: 4000 }, (_, index) => ({ id: `snapshot-${index}`, usedTokens: index })),
    usageReports: Array.from({ length: 4000 }, (_, index) => ({ scope: "session", inputTokens: index })) };
  const revision = store.createRevision(meta.path, "synthetic");
  const body = "中文😀\u0000".repeat(3000);
  revision.sink.message({ id: "fixture-user", sessionId: meta.id, ordinal: 1, recordLine: 1, turnId: "fixture-turn", kind: "user", text: body });
  revision.sink.message({ id: "fixture-assistant", sessionId: meta.id, ordinal: 2, recordLine: 2, turnId: "fixture-turn", kind: "assistant", final: "explicit", text: "合成摘要测试答案" });
  revision.sink.usage({ id: "fixture-request", inputTokens: 12, outputTokens: 3 });
  revision.flush(); store.finishRevision(revision.revision, meta);
  const gaps = Array.from({ length: 53 }, (_, index) => ({ kind: "source_unavailable" as const, sourceId: `fixture-gap-${index}`, message: "合成诊断" }));
  const version = store.publish(store.createJob().id, [{ path: meta.path, revision: revision.revision, fingerprint: "synthetic" }], gaps); store.close();
  const service = await startService({ home, startupRefresh: false, roots: isolatedHistoryRoots(),
    resourceInventory: { userHome: join(directory, "user"), environment: {} }, usagePricing: { fetch: async () => new Response("offline", { status: 503 }) } });
  t.after(() => service.close());
  const api = async (route: string, method = "GET", body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${service.instance.port}/api/v1${route}`, { method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<any>;
  };
  const full = await api("/sessions?pageSize=1");
  assert.equal(full.sessions[0].contextSnapshots.length, 4000);
  const list = await api("/sessions?response=summary&pageSize=1");
  assert.equal("contextSnapshots" in list.sessions[0], false);
  assert.ok(JSON.stringify(list).length < 3000);
  const groups = await api("/sessions/search/groups?q=合成摘要测试&response=summary");
  assert.equal(groups.groups[0].hits[0].session, undefined);
  assert.equal(groups.groups[0].hits[0].sessionId, meta.id);
  assert.ok(JSON.stringify(groups).length < 5000);
  const records = await api("/sessions/search?q=合成摘要测试&response=summary");
  assert.equal(records.sessions.length, 1); assert.equal(records.hits[0].sessionId, meta.id);
  assert.equal("session" in records.hits[0], false); assert.ok(JSON.stringify(records).length < 5000);
  const first = await api(`/sessions/${meta.id}/messages?response=summary&messageId=fixture-user&maxTextChars=7`);
  assert.equal(first.session.contextSnapshots, undefined);
  assert.equal(first.messages[0].text, Array.from(body).slice(0, 7).join(""));
  assert.equal(first.messages[0].nextTextOffset, 7);
  const next = await api(`/sessions/${meta.id}/messages?response=summary&messageId=fixture-user&version=${version}&textOffset=7&maxTextChars=7`);
  assert.equal(next.messages[0].text, Array.from(body).slice(7, 14).join(""));
  assert.equal(next.messages[0].textOffset, 7);
  const end = await api(`/sessions/${meta.id}/messages?response=summary&messageId=fixture-user&version=${version}&textOffset=${Array.from(body).length - 3}&maxTextChars=7`);
  assert.equal(end.messages[0].text, Array.from(body).slice(-3).join("")); assert.equal(end.messages[0].nextTextOffset, undefined);
  const profile = await api(`/sessions/${meta.id}/profile?response=summary`);
  assert.equal(profile.contextSnapshots, undefined); assert.equal(profile.usageReports, undefined);
  assert.equal(profile.sections.context, 4000); assert.ok(JSON.stringify(profile).length < 5000);
  const context = await api(`/sessions/${meta.id}/profile?response=summary&section=context&page=2&pageSize=3&version=${version}`);
  assert.equal(context.total, 4000); assert.equal(context.items.length, 3); assert.equal(context.items[0].id, "snapshot-3"); assert.equal(context.version, version);
  const reports = await api(`/sessions/${meta.id}/profile?response=summary&section=reports&page=2&pageSize=3&version=${version}`);
  assert.equal(reports.total, 4000); assert.equal(reports.items[0].inputTokens, 3);
  const steps = await api(`/sessions/${meta.id}/profile?response=summary&section=steps&version=${version}`);
  assert.equal(steps.total, 1); assert.equal(steps.items[0].id, "fixture-request");
  const diagnostics = await api(`/sessions/gaps?response=summary&page=2&pageSize=3&version=${version}`);
  assert.equal(diagnostics.total, 53); assert.equal(diagnostics.gaps.length, 3); assert.equal(diagnostics.hasMore, true);
  const status = await api("/status?response=summary");
  assert.equal(status.sessions.gaps, undefined); assert.equal(status.sessions.gapCount, 53);
  assert.equal(status.jobs, undefined); assert.equal(status.jobCount, 0);
  const prices = await api("/usage/pricing?response=summary");
  assert.equal(prices.prices, undefined); assert.ok(prices.priceCount > 0); assert.ok(JSON.stringify(prices).length < 10000);
  const page = await api(`/usage/pricing/prices?pageSize=2&version=${prices.version}`);
  assert.equal(page.prices.length, 2); assert.equal(page.total, prices.priceCount);
  const configured = await api("/usage/pricing?response=summary", "PUT", { overrides: [{ model: "fixture-pricing", input: 2, output: 3 }], mappings: [] });
  assert.equal(configured.prices, undefined); assert.equal(configured.configuration.overrides[0].model, "fixture-pricing");
  const filtered = await api(`/usage/pricing/prices?model=fixture-pricing&version=${configured.version}`);
  assert.equal(filtered.total, 1); assert.equal(filtered.prices[0].input, 2);
  const usage = await api(`/usage?response=summary&version=${version}`);
  assert.equal(usage.sessions[0].session.contextSnapshots, undefined); assert.equal(usage.sessions[0].requests, undefined);
  assert.equal(usage.sessions[0].requestsTotal, 1); assert.ok(JSON.stringify(usage).length < 15000);
  const skipped = await api("/sessions/auto-refresh", "POST", {});
  assert.equal(skipped.job, null); assert.equal(skipped.status, "skipped"); assert.equal(skipped.reason, "disabled");
});
