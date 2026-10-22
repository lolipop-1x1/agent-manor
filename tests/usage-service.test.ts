import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { AnalysisStore } from "../src/index/store.js";
import { SessionStore } from "../src/sessions/store.js";
import { startService } from "../src/server.js";
import type { SessionSourceMeta, SessionUsage } from "../src/session-contracts.js";
import type { PricingStatus, UsageReport, UsageRequestPage } from "../src/usage-contracts.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

test("用量 HTTP 固定索引与价格版本，覆盖多页请求、手动价、未知和网络失败", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-usage-service-"));
  const home = join(directory, "data"); await mkdir(home);
  const path = join(home, "index.sqlite");
  new AnalysisStore(path).close();
  const store = new SessionStore(path);
  const summary: SessionSourceMeta = { id: "synthetic-usage-session", client: "codex", clientSessionId: "synthetic-usage-session",
    title: "合成用量会话", titleOrigin: "recorded", sourceId: "codex:synthetic-usage-session", path: "/synthetic/history/usage.jsonl",
    project: "/synthetic/project", models: ["synthetic-model"], messageCount: 0, turnCount: 0, gaps: [] };
  const revision = store.createRevision(summary.path, "synthetic");
  for (let index = 0; index < 31; index++) {
    const usage: SessionUsage = { id: `synthetic-request-${String(index).padStart(2, "0")}`, model: "synthetic-model", occurredAt: "2026-10-11T01:00:00Z",
      inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, cacheWriteTokens: 0,
      timing: { basis: "recorded", window: index % 2 ? "generation" : "response", method: "codex_event_boundary",
        completion: "explicit", durationMs: 2000 } };
    revision.sink.usage(usage);
  }
  revision.flush(); store.finishRevision(revision.revision, summary);
  const version = store.publish(store.createJob().id, [{ path: summary.path, revision: revision.revision, fingerprint: "synthetic" }], []);
  store.close();
  let networkFail = false;
  const remote = { synthetic: { id: "synthetic", name: "Synthetic", models: { "synthetic-model": {
    id: "synthetic-model", name: "Synthetic Model", cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 3 }, limit: { context: 100_000, output: 10_000 },
  } } } };
  const service = await startService({ home, startupRefresh: false, roots: isolatedHistoryRoots(),
    resourceInventory: { userHome: join(directory, "isolated-user"), environment: {} },
    usagePricing: { fetch: (async () => { if (networkFail) throw new Error("synthetic network failure"); return Response.json(remote); }) as typeof fetch } });
  const base = `http://127.0.0.1:${service.instance.port}/api/v1`;
  const api = async <T>(route: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(`${base}${route}`, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json() as Promise<T>;
  };
  try {
    const automatic = await api<PricingStatus>("/usage/pricing/refresh", "POST", {});
    const configuration = { overrides: [{ model: "synthetic-model", input: 4, output: 20, cacheRead: 0.4, cacheWrite: 6 }], mappings: [] };
    const custom = await api<PricingStatus>("/usage/pricing", "PUT", configuration);
    assert.notEqual(custom.version, automatic.version);
    const params = new URLSearchParams({ version, priceVersion: custom.version, timezone: "Asia/Shanghai", from: "2026-10-11", to: "2026-10-11" });
    const report = await api<UsageReport>(`/usage?${params}`);
    const posted = await api<UsageReport>("/usage", "POST", { version, priceVersion: custom.version, timezone: "Asia/Shanghai",
      from: "2026-10-11", to: "2026-10-11" });
    assert.deepEqual(posted, report);
    assert.equal(report.totals.requests, 31);
    assert.equal(report.speed, undefined);
    const speed = await api<UsageReport>(`/usage?${params}&includeSpeed=true`);
    assert.equal(speed.speed!.requests, 31); assert.equal(speed.speed!.eligibleRequests, 0);
    assert.equal(speed.speed!.groups.length, 2);
    assert.deepEqual(speed.speed!.selectedGroups, speed.speed!.groups.map(group => group.key));
    const selectedGroups = speed.speed!.groups.map(group => group.key).reverse();
    const multiParams = new URLSearchParams(params);
    multiParams.set("includeSpeed", "true"); multiParams.set("speedGroup", selectedGroups[1]!);
    multiParams.set("speedGroups", JSON.stringify([...selectedGroups, selectedGroups[0]]));
    const multi = await api<UsageReport>(`/usage?${multiParams}`);
    assert.deepEqual(multi.speed!.selectedGroups, selectedGroups);
    assert.deepEqual(multi.speed!.series.map(series => series.group), selectedGroups);
    assert.equal(multi.speed!.selectedGroup, selectedGroups[0]);
    multiParams.set("speedGroups", "[]");
    const cleared = await api<UsageReport>(`/usage?${multiParams}`);
    assert.deepEqual(cleared.speed!.selectedGroups, []); assert.deepEqual(cleared.speed!.series, []);
    assert.equal(cleared.speed!.selectedGroup, null); assert.equal(cleared.totals.requests, 31);
    multiParams.set("speedGroups", "[null]");
    assert.equal((await fetch(`${base}/usage?${multiParams}`)).status, 400);
    const badSpeed = await fetch(`${base}/usage?${params}&speedGroup=missing`);
    assert.equal(badSpeed.status, 400);
    assert.equal(report.totals.tokens, 31 * 120);
    assert.equal(report.totals.pricedRequests, 31);
    assert.ok(Math.abs(report.totals.estimatedCost! - 31 * (60 * 4 + 40 * 0.4 + 20 * 20) / 1_000_000) < 1e-10);
    assert.equal(report.buckets.reduce((sum, bucket) => sum + bucket.totals.tokens!, 0), report.totals.tokens);
    const sessionCost = await api<{ version: string; priceVersion: string; totals: UsageReport["totals"] }>(`/sessions/${summary.id}/cost?version=${version}&priceVersion=${custom.version}`);
    assert.equal(sessionCost.version, version);
    assert.equal(sessionCost.priceVersion, custom.version);
    assert.equal(sessionCost.totals.requests, 31);
    assert.equal(sessionCost.totals.estimatedCost, report.totals.estimatedCost);
    assert.equal(sessionCost.totals.pricedRequests, 31);
    const page = await api<UsageRequestPage>(`/usage/requests?${params}&sessionId=${summary.id}&requestPage=2&requestPageSize=12`);
    assert.equal(page.total, 31); assert.equal(page.requests.length, 12);
    assert.equal(page.requests[0]!.usage.id, "synthetic-request-12");
    const postedPage = await api<UsageRequestPage>("/usage/requests", "POST", { ...Object.fromEntries(params),
      sessionId: summary.id, requestPage: 2, requestPageSize: 12 });
    assert.deepEqual(postedPage, page);
    const postedSummary = await api<Record<string, unknown>>("/usage?response=summary", "POST", Object.fromEntries(params));
    assert.equal((postedSummary.sessions as Record<string, unknown>[])[0]!.requests, undefined);
    assert.equal((postedSummary.totals as UsageReport["totals"]).tokens, report.totals.tokens);
    for (const body of [null, [], { arbitrary: true }, { includeSpeed: true, speedGroups: [null] }, { page: true }, { version: 1 }]) {
      const invalidPost = await fetch(`${base}/usage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(invalidPost.status, 400);
    }
    networkFail = true;
    const fallback = await api<PricingStatus>("/usage/pricing/refresh", "POST", {});
    assert.deepEqual(fallback.configuration, configuration);
    const after = await api<UsageReport>(`/usage?${params}`);
    assert.equal(after.totals.estimatedCost, report.totals.estimatedCost);
    assert.equal(after.priceVersion, custom.version);
    const invalid = await fetch(`${base}/usage?from=2026-02-31`);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.messageDescriptor.key, "diagnostics.usage.input.invalid");
    const stale = await fetch(`${base}/usage?priceVersion=synthetic-unavailable`);
    assert.ok([404, 409].includes(stale.status));
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
