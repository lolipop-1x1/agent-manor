import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { AnalysisStore } from "../src/index/store.js";
import { SessionStore } from "../src/sessions/store.js";
import { startService } from "../src/server.js";
import type { SessionSourceMeta, SessionUsage } from "../src/session-contracts.js";
import type { PricingStatus, SessionCostSummary } from "../src/usage-contracts.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

test("会话费用按完整自身或递归子会话范围计价，排除复制并随价格版本更新", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-session-cost-"));
  const home = join(directory, "data"); await mkdir(home);
  const path = join(home, "index.sqlite"); new AnalysisStore(path).close();
  const store = new SessionStore(path);
  const request: SessionUsage = { id: "complete", model: "fixture-priced", inputTokens: 100, outputTokens: 20, cachedInputTokens: 40,
    occurredAt: "2026-10-11T01:00:00Z" };
  const source = (id: string, usages: SessionUsage[], extra: Partial<SessionSourceMeta> = {}) => {
    const meta: SessionSourceMeta = { id, client: "codex", clientSessionId: id, title: "合成费用会话", titleOrigin: "recorded",
      sourceId: `codex:${id}`, path: `/synthetic/history/${id}.jsonl`, models: [], messageCount: 0, turnCount: 0, gaps: [], ...extra };
    const pending = store.createRevision(meta.path, "synthetic");
    pending.sink.message({ id: "copied-message", sessionId: id, ordinal: 1, recordLine: 1, turnId: "copied-turn", kind: "assistant", text: "继承正文", copied: true });
    for (const usage of usages) pending.sink.usage(usage);
    pending.flush(); store.finishRevision(pending.revision, meta);
    return { path: meta.path, revision: pending.revision, fingerprint: "synthetic" };
  };
  const sources = [source("fixture-parent", [request, { id: "partial", model: "fixture-priced", outputTokens: 10 },
    { ...request, id: "unknown", model: "fixture-unpriced" }]),
  source("fixture-child", [{ ...request, cacheWriteTokens: 0 }, { ...request, id: "copied", messageId: "copied-message", inputTokens: 10_000 }],
    { client: "claude", parentSessionId: "fixture-parent", relationship: "child" }),
  source("fixture-grandchild", [{ ...request, model: "fixture-zero" }], { parentSessionId: "fixture-child", relationship: "child" }),
  source("fixture-unrelated", [{ ...request, model: "fixture-unpriced" }]), source("fixture-empty", [])];
  const version = store.publish(store.createJob().id, sources, []); store.close();
  const service = await startService({ home, startupRefresh: false, roots: isolatedHistoryRoots(),
    resourceInventory: { userHome: join(directory, "isolated-user"), environment: {} },
    usagePricing: { fetch: (async () => { throw new Error("synthetic offline"); }) as typeof fetch } });
  const base = `http://127.0.0.1:${service.instance.port}/api/v1`;
  const api = async <T>(route: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${base}${route}`, { method: body === undefined ? "GET" : "PUT",
      headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json() as Promise<T>;
  };
  const configuration = (factor: number) => ({ overrides: [
    { model: "fixture-priced", input: 2 * factor, output: 10 * factor, cacheRead: 0.2 * factor, cacheWrite: 3 * factor },
    { model: "fixture-zero", input: 0, output: 0, cacheRead: 0 }], mappings: [] });
  try {
    const initial = await api<PricingStatus>("/usage/pricing", configuration(1));
    const cost = (id: string, extra = "") => api<SessionCostSummary>(`/sessions/${id}/cost?version=${version}${extra}`);
    const self = await cost("fixture-parent");
    assert.equal(self.scope, "self"); assert.deepEqual(self.sessionIds, ["fixture-parent"]);
    assert.equal(self.currency, "USD"); assert.equal(self.totals.requests, 3);
    assert.ok(Math.abs(self.totals.estimatedCost! - 0.000428) < 1e-12);
    assert.deepEqual([self.totals.pricedRequests, self.totals.partiallyPricedRequests, self.totals.unpricedRequests], [1, 1, 1]);
    const tree = await cost("fixture-parent", "&includeChildren=true&stepLimit=1&stepOffset=1");
    assert.equal(tree.scope, "tree"); assert.equal(tree.totals.requests, 5);
    assert.deepEqual(tree.sessionIds.sort(), ["fixture-child", "fixture-grandchild", "fixture-parent"]);
    assert.ok(Math.abs(tree.totals.estimatedCost! - 0.000756) < 1e-12);
    assert.deepEqual([tree.totals.pricedRequests, tree.totals.partiallyPricedRequests, tree.totals.unpricedRequests], [3, 1, 1]);
    assert.equal((await cost("fixture-grandchild")).totals.estimatedCost, 0);
    assert.equal((await cost("fixture-unrelated")).totals.estimatedCost, null);
    assert.equal((await cost("fixture-empty")).totals.estimatedCost, null);
    const updated = await api<PricingStatus>("/usage/pricing", configuration(2));
    const next = await cost("fixture-parent", "&includeChildren=true");
    assert.equal(next.version, version); assert.equal(next.priceVersion, updated.version);
    assert.ok(Math.abs(next.totals.estimatedCost! - 0.001512) < 1e-12);
    const old = await cost("fixture-parent", `&includeChildren=true&priceVersion=${initial.version}`);
    assert.equal(old.priceVersion, initial.version); assert.equal(old.totals.estimatedCost, tree.totals.estimatedCost);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
