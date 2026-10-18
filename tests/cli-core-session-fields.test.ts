import assert from "node:assert/strict";
import test from "node:test";
import { searchSummaryResponse, sessionSummaryResponse } from "../src/service/summary-response.js";
import { summarizeResponse } from "../packages/cli/src/output/summary.js";
import type { SessionSummary } from "../src/session-contracts.js";
import { humanOutput } from "../packages/cli/src/output/format.js";

const core = { id: "synthetic-session", title: "Synthetic task", client: "codex", project: "/workspace/example",
  updatedAt: "2026-01-01T01:00:00Z" };
const session = { ...core, clientSessionId: "native-id", titleOrigin: "recorded", projectOrigin: "cwd", models: ["synthetic-model"],
  messageCount: 12, turnCount: 3, startedAt: "2026-01-01T00:00:00Z", gaps: [], childSessionIds: ["child"], contextSnapshots: [{ id: "snapshot", usedTokens: 42 }],
  futureMetadata: { longBody: "opaque metadata" } } as unknown as SessionSummary;

test("会话列表摘要只返回核心白名单，未来新增字段不会自动泄漏", () => {
  assert.deepEqual(sessionSummaryResponse(session), core);
  const result = { version: "v1", total: 1, page: 1, pageSize: 20, sessions: [session] };
  assert.deepEqual(searchSummaryResponse(result), { ...result, sessions: [core], hasMore: false });
});

test("生成标题保留稳定翻译描述，原始会话标题不被翻译", () => {
  const fallback = sessionSummaryResponse({ ...session, titleOrigin: "fallback" });
  assert.match(humanOutput({ sessions: [fallback] }, "en"), /Unnamed session/);
  assert.match(humanOutput({ sessions: [fallback] }, "zh-CN"), /未命名会话/);
  assert.match(humanOutput({ sessions: [sessionSummaryResponse(session)] }, "zh-CN"), /Synthetic task/);
  assert.deepEqual(sessionSummaryResponse(fallback as unknown as SessionSummary), fallback);
});

test("CLI 对旧后台完整响应同样执行核心字段投影，重复投影保持结果一致", () => {
  const full = { version: "v1", total: 1, page: 1, pageSize: 20, sessions: [session] };
  const result = summarizeResponse("/sessions", "GET", full);
  assert.deepEqual(result, { ...full, sessions: [core], hasMore: false });
  assert.deepEqual(summarizeResponse("/sessions", "GET", result), result);
  const search = { version: "v1", total: 1, page: 1, pageSize: 20, hits: [{ session, messageId: "message", snippet: "Synthetic hit" }] };
  const hits = summarizeResponse("/sessions/search", "GET", search) as { sessions: unknown[]; hits: unknown[] };
  assert.deepEqual(hits.sessions, [core]);
  assert.deepEqual(hits.hits, [{ sessionId: core.id, messageId: "message", snippet: "Synthetic hit" }]);
  assert.deepEqual(summarizeResponse("/sessions/search", "GET", hits), hits);
});
