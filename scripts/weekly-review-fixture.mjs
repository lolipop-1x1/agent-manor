import { mkdir, mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalysisStore } from "../dist/index/store.js";
import { SessionStore } from "../dist/sessions/store.js";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";
import { writePreferences } from "../dist/service/preferences.js";

// 用户需求、时间、项目、价格和缺口均为隔离合成记录。
export async function weeklyReviewFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "manor-weekly-review-")));
  const home = join(directory, "data"); await mkdir(home);
  const path = join(home, "index.sqlite"); new AnalysisStore(path).close();
  const store = new SessionStore(path), sources = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let sessionIndex = 0; sessionIndex < 5; sessionIndex++) {
    const id = `review-session-${sessionIndex}`, child = sessionIndex === 4, sourcePath = `/synthetic/history/${id}.jsonl`;
    const pending = store.createRevision(sourcePath, "synthetic");
    let ordinal = 0;
    const message = (turnId, kind, text, date, extra = {}) => {
      const value = { id: `${id}:message:${ordinal}`, sessionId: id, ordinal: ordinal++, recordLine: ordinal,
        turnId, kind, text, occurredAt: date.toISOString(), ...extra };
      pending.sink.message(value); return value.id;
    };
    for (let day = 1; day <= 8; day++) {
      for (let round = 0; round < 6; round++) {
        const start = new Date(today); start.setDate(start.getDate() - day); start.setHours(9 + round, 5 * sessionIndex, 0, 0);
        const turn = `${day}-${round}`;
        message(turn, "user", `请检查合成项目 ${sessionIndex + 1} 的第 ${round + 1} 项功能，并修复查询结果。`, start);
        const requestCount = 1 + round % 3;
        for (let step = 0; step < requestCount; step++) {
          const at = new Date(start.getTime() + (step + 1) * 12_000);
          const final = step === requestCount - 1;
          const messageId = message(turn, "assistant", final ? "合成检查完成。" : "检查合成数据。", at,
            final ? { final: sessionIndex === 3 && round === 5 ? "inferred" : "explicit" } : {});
          const input = 1000 + sessionIndex * 500 + round * 300 + step * 100;
          pending.sink.usage({ id: `${id}:usage:${turn}:${step}`, messageId, turnId: turn, occurredAt: at.toISOString(),
            model: round % 2 ? "review-large" : "review-fast", reasoningEffort: round % 3 ? "high" : "medium",
            inputTokens: input, outputTokens: 100 + step * 20,
            ...(round === 4 ? {} : { cachedInputTokens: round === 0 ? 0 : round === 1 ? input : Math.round(input * .7) }), cacheWriteTokens: 0 });
        }
        if (round === 2) {
          const at = new Date(start.getTime() + 5_000);
          message(turn, "tool_call", "合成读取", at, { callId: `call-${turn}`, tool: "synthetic_read" });
          message(turn, "tool_result", "合成失败", at, { callId: `call-${turn}`, tool: "synthetic_read", status: "failure" });
          message(turn, "tool_call", "合成后续读取", at, { callId: `retry-${turn}`, tool: "synthetic_read" });
          message(turn, "tool_result", "合成结果", at, { callId: `retry-${turn}`, tool: "synthetic_read", status: "success" });
        }
        if (sessionIndex === 1 && day === 4 && round === 3) message(turn, "compression", "合成压缩事件", new Date(start.getTime() + 8_000));
      }
    }
    pending.flush();
    store.finishRevision(pending.revision, { id, client: sessionIndex === 2 ? "claude" : "codex", clientSessionId: id,
      path: sourcePath, sourceId: `synthetic:${id}`, title: `合成复盘会话 ${sessionIndex + 1}`, titleOrigin: "recorded",
      project: `/synthetic/projects/${sessionIndex % 2 ? "beta" : "atlas"}`, models: ["review-fast", "review-large"],
      messageCount: ordinal, turnCount: 48, gaps: [], ...(child ? { relationship: "child", parentSessionId: "review-session-0" } : {}) });
    sources.push({ path: sourcePath, revision: pending.revision, fingerprint: "synthetic" });
  }
  store.publish(store.createJob().id, sources, []); store.close();
  await writePreferences(home, "zh-CN");
  const service = await startService({ home, startupRefresh: false, roots: Object.fromEntries(clientIds.map(client => [client, []])),
    resourceInventory: { userHome: join(directory, "isolated-user"), environment: {} },
    usagePricing: { fetch: async () => Response.json({ synthetic: { models: {
      "review-fast": { cost: { input: 1, output: 3, cache_read: .1, cache_write: 1.25 } },
      "review-large": { cost: { input: 3, output: 10, cache_read: .3, cache_write: 3.75 } },
    } } }) } });
  const base = `http://127.0.0.1:${service.instance.port}`;
  await fetch(`${base}/api/v1/usage/pricing/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return { directory, home, service, base, close: async () => { await service.close(); await rm(directory, { recursive: true, force: true }); } };
}
