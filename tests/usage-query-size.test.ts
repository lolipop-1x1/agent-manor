import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AnalysisStore } from "../src/index/store.js";
import { SessionStore } from "../src/sessions/store.js";
import { startService } from "../src/server.js";
import { usageReadRequest } from "../src/usage/query-request.js";
import type { UsageReport, UsageRequestPage } from "../src/usage-contracts.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

test("500 个长模型分组通过实际 HTTP 请求体读取报告、状态与明细，不触发请求头限制", async () => {
  const home = await mkdtemp(join(tmpdir(), "manor-usage-query-size-")), path = join(home, "index.sqlite");
  new AnalysisStore(path).close();
  const store = new SessionStore(path), id = "synthetic-large-query";
  const models = Array.from({ length: 500 }, (_, index) => `synthetic-model-${index}-${"variant-".repeat(12)}`);
  const source = "/synthetic/history/large-query.jsonl", revision = store.createRevision(source, "synthetic");
  for (const [index, model] of models.entries()) revision.sink.usage({ id: `request-${index}`, model,
    occurredAt: "2026-10-22T01:00:00Z", inputTokens: 1000, outputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0,
    timing: { basis: "estimated", window: "response", method: "codex_event_boundary", completion: "explicit", durationMs: 2000 } });
  revision.flush(); store.finishRevision(revision.revision, { id, client: "codex", clientSessionId: id, sourceId: `synthetic:${id}`,
    path: source, title: "合成长查询", titleOrigin: "recorded", models, messageCount: 0, turnCount: 0, gaps: [] });
  store.publish(store.createJob().id, [{ path: source, revision: revision.revision, fingerprint: "synthetic" }], []); store.close();
  const service = await startService({ home, startupRefresh: false, roots: isolatedHistoryRoots(),
    resourceInventory: { userHome: join(home, "isolated-user"), environment: {} }, usagePricing: { fetch: async () => { throw new Error("synthetic offline"); } } });
  try {
    const base = `http://127.0.0.1:${service.instance.port}/api/v1`;
    const initial = await fetch(`${base}/usage?includeSpeed=true&timezone=UTC`);
    assert.equal(initial.status, 200);
    const report = await initial.json() as UsageReport;
    assert.equal(report.speed!.selectedGroups.length, 500);
    const parameters = new URLSearchParams({ includeSpeed: "true", timezone: "UTC", version: report.version,
      priceVersion: report.priceVersion, speedGroups: JSON.stringify(report.speed!.selectedGroups), interval: "week" });
    assert.ok(parameters.toString().length > 16_384);
    for (const route of ["/usage", "/usage/requests", "/usage/status"]) {
      const query = new URLSearchParams(parameters);
      if (route === "/usage/requests") { query.set("sessionId", id); query.set("requestPage", "2"); query.set("requestPageSize", "7"); }
      const read = usageReadRequest(route, query.toString());
      assert.equal(read.method, "POST");
      const response = await fetch(`${base}${read.path}`, { method: read.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(read.body) });
      assert.equal(response.status, 200, await response.clone().text());
      if (route === "/usage") {
        const actual = await response.json() as UsageReport;
        assert.deepEqual(actual.totals, report.totals); assert.equal(actual.speed!.series.length, 500);
        assert.deepEqual(actual.speed!.selectedGroups, report.speed!.selectedGroups);
      } else if (route === "/usage/requests") {
        const page = await response.json() as UsageRequestPage;
        assert.equal(page.total, 500); assert.equal(page.page, 2); assert.equal(page.requests.length, 7);
      }
    }
  } finally { await service.close(); await rm(home, { recursive: true, force: true }); }
});
