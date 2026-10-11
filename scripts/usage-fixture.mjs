import { mkdir, mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalysisStore } from "../dist/index/store.js";
import { SessionStore } from "../dist/sessions/store.js";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";
import { writePreferences } from "../dist/service/preferences.js";
import { historicalPriceSourceUrl } from "../dist/usage/historical-prices.js";
import { priceSourceUrl } from "../dist/usage/price-catalog.js";

// 全部为隔离合成数据，价格写入只影响临时数据目录。
export async function usageFixture({ failHistoricalPrices = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-usage-e2e-")));
  const home = join(directory, "data"); await mkdir(home);
  const path = join(home, "index.sqlite"); new AnalysisStore(path).close();
  const store = new SessionStore(path), sources = [];
  const models = ["fixture-fast", "fixture-reasoning", "fixture-large"];
  const prices = Object.fromEntries(models.map((model, index) => [model, { id: model, name: model,
    cost: { input: 1 + index * 2, output: 5 + index * 5, cache_read: 0.1 + index * 0.2, cache_write: 1.25 + index * 2.5 },
    limit: { context: 100_000, output: 16_000 } }]));
  prices["fixture-large"].cost.tiers = [{ tier: { type: "context", size: 20_000 }, input: 7.5, output: 22.5, cache_read: 0.75, cache_write: 9.375 }];
  const changedAt = new Date(); changedAt.setUTCDate(changedAt.getUTCDate() - 14);
  const historicalPrices = [{ id: "fixture", models: [{ id: "fixture-fast", prices: [
    { prices: { input_mtok: 0.5, output_mtok: 2, cache_read_mtok: 0.05, cache_write_mtok: 0.625 } },
    { constraint: { start_date: changedAt.toISOString().slice(0, 10) }, prices: { input_mtok: 1.5, output_mtok: 6, cache_read_mtok: 0.15, cache_write_mtok: 1.875 } },
  ] }] }];
  for (let sessionIndex = 0; sessionIndex < 36; sessionIndex++) {
    const id = `fixture-session-${String(sessionIndex).padStart(2, "0")}`;
    const child = sessionIndex > 0 && sessionIndex % 6 === 0;
    const summary = { id, client: sessionIndex % 2 ? "claude" : "codex", clientSessionId: id,
      sourceId: `synthetic:${id}`, path: `/synthetic/history/${id}.jsonl`, title: `合成项目任务 ${String(sessionIndex + 1).padStart(2, "0")}`,
      titleOrigin: "recorded", project: sessionIndex === 35 ? undefined : `/synthetic/projects/${["atlas", "workbench", "index", "atlas-copy"][sessionIndex % 4]}`,
      models: sessionIndex === 34 ? ["fixture-unpriced"] : sessionIndex === 0 ? [...models, "gpt-fixture", "deepseek-chat", "gpt-codex-fixture", "gateway/claude-77.6-sonnet", "alternate/deepseek-fixture-v77-flash-0731", "gateway/gpt-plan-fixture:free"] : models, messageCount: 0, turnCount: 0, gaps: [],
      ...(child ? { relationship: "child", parentSessionId: "fixture-session-00" } : {}),
      ...(sessionIndex === 33 ? { executionMode: "quiet" } : {}) };
    const pending = store.createRevision(summary.path, "synthetic");
    let ordinal = 0;
    for (let day = 0; day < 28; day++) {
      const time = new Date(); time.setDate(time.getDate() - day); time.setHours(12 + sessionIndex % 5, sessionIndex, 0, 0);
      const messageId = `${id}:message:${day}`;
      pending.sink.message({ id: messageId, sessionId: id, ordinal: ordinal++, recordLine: day + 1, turnId: `turn-${day}`,
        kind: "assistant", final: "explicit", occurredAt: time.toISOString(), text: `合成请求记录 ${day + 1}：用量定位验证。` });
      const input = Math.round((12000 + sessionIndex * 1100) * (1 + 0.45 * Math.sin(day * 0.7 + sessionIndex)));
      pending.sink.usage({ id: `${id}:usage:${day}`, messageId, turnId: `turn-${day}`, occurredAt: time.toISOString(),
        model: sessionIndex === 34 ? "fixture-unpriced" : sessionIndex === 0 && day < 6 ? ["gpt-fixture", "deepseek-chat", "gpt-codex-fixture", "gateway/claude-77.6-sonnet", "alternate/deepseek-fixture-v77-flash-0731", "gateway/gpt-plan-fixture:free"][day] : models[(day + sessionIndex) % 3],
        ...(sessionIndex === 0 && day === 1 ? { provider: "deepseek-official" } : sessionIndex === 0 && day === 2 ? { provider: "openai-codex" } : sessionIndex === 0 && day === 5 ? { provider: "token-plan" } : {}),
        inputTokens: input, outputTokens: 500 + day * 30 + sessionIndex * 20, cachedInputTokens: Math.round(input * 0.6), cacheWriteTokens: 0 });
    }
    if (sessionIndex === 35) {
      pending.sink.usage({ id: `${id}:undated`, model: "fixture-unpriced", inputTokens: 500, outputTokens: 50 });
      pending.sink.usage({ id: `${id}:known-unknown`, model: "unknown", inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 0 });
      pending.sink.usage({ id: `${id}:missing-model`, inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0 });
    }
    pending.flush(); store.finishRevision(pending.revision, summary);
    sources.push({ path: summary.path, revision: pending.revision, fingerprint: "synthetic" });
  }
  const missing = { id: "fixture-no-usage", client: "codex", clientSessionId: "fixture-no-usage", title: "合成未记录用量", titleOrigin: "recorded",
    sourceId: "synthetic:no-usage", path: "/synthetic/history/no-usage.jsonl", models: [], messageCount: 0, turnCount: 0, gaps: [] };
  const pending = store.createRevision(missing.path, "synthetic"); pending.flush(); store.finishRevision(pending.revision, missing);
  sources.push({ path: missing.path, revision: pending.revision, fingerprint: "synthetic" });
  store.publish(store.createJob().id, sources, []); store.close();
  await writePreferences(home, "zh-CN");
  const service = await startService({ home, startupRefresh: false,
    roots: Object.fromEntries(clientIds.map(client => [client, []])),
    resourceInventory: { userHome: join(directory, "isolated-user"), environment: {} },
    usagePricing: { fetch: async url => {
      if (url === historicalPriceSourceUrl) return failHistoricalPrices ? new Response("synthetic price failure", { status: 503 }) : Response.json(historicalPrices);
      if (url !== priceSourceUrl) throw new Error("unexpected synthetic price source");
      return Response.json({ fixture: { id: "fixture", name: "Synthetic prices", models: prices },
      openai: { models: { "gpt-fixture": { cost: { input: 2, output: 5, cache_read: 0.1 } }, "gpt-codex-fixture": { cost: { input: 3, output: 6, cache_read: 0.3 } }, "gpt-plan-fixture": { cost: { input: 2, output: 5, cache_read: 0.1 } } } },
      anthropic: { models: { "claude-sonnet-77-6": { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } },
      openrouter: { models: { "deepseek/deepseek-fixture-v77-flash-0731": { cost: { input: 0.02, output: 0.6, cache_read: 0.01 } } } },
      "token-plan": { models: { "gpt-plan-fixture": { cost: { input: 0, output: 0, cache_read: 0 } } } },
      deepseek: { models: { "deepseek-chat": { cost: { input: 0.3, output: 1.2, cache_read: 0.03 } } } },
      reseller: { models: { "gpt-fixture": { cost: { input: 20, output: 50, cache_read: 1 } } } } });
    } } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  await fetch(`${base}/api/v1/usage/pricing/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return { directory, home, service, base, close: async () => { await service.close(); await rm(directory, { recursive: true, force: true }); } };
}
