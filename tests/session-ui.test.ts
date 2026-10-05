import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client } from "../src/clients.ts";
import type { SessionMessage, SessionSearchHit } from "../src/session-contracts.ts";
import { panelSemantics } from "../web/workspace-layout.ts";
import { displayRecorded, groupedTurns, searchHitMode, searchKinds, sessionParams, turnTitle, usageSegments, workspaceSessionSemantics } from "../web/session-model.ts";

const summary = {
  id: "session-a", client: "codex" as Client, clientSessionId: "external-a", title: "合成会话", titleOrigin: "recorded" as const,
  messageCount: 3, turnCount: 2, models: [], gaps: [],
};

const message = (id: string, ordinal: number, turnId: string, kind: SessionMessage["kind"] = "assistant"): SessionMessage => ({
  id, sessionId: summary.id, ordinal, recordLine: ordinal, turnId, kind, text: id,
});

test("会话查询编码保留筛选、类型列表和消息精确定位", () => {
  const params = new URLSearchParams(sessionParams({ client: "codex", project: "none", q: "缓存 命中&模型", kinds: ["user", "tool_call"],
    page: 3, pageSize: 40, version: "version-7", mode: "trace", messageId: "message / 9", sessionId: summary.id }));
  assert.equal(params.get("client"), "codex");
  assert.equal(params.get("project"), "none");
  assert.equal(params.get("q"), "缓存 命中&模型");
  assert.equal(params.get("kinds"), "user,tool_call");
  assert.equal(params.get("page"), "3");
  assert.equal(params.get("pageSize"), "40");
  assert.equal(params.get("version"), "version-7");
  assert.equal(params.get("mode"), "trace");
  assert.equal(params.get("messageId"), "message / 9");
  assert.equal(params.get("sessionId"), summary.id);
});

test("默认搜索只包含用户与 AI 正文，过程选项加入完整记录类型", () => {
  assert.deepEqual(searchKinds(false), ["user", "assistant"]);
  assert.deepEqual(searchKinds(true), ["user", "assistant", "thinking", "tool_call", "tool_result", "system", "compression"]);
});

test("消息命中强制打开轨迹视图，标题命中保留当前模式", () => {
  const hit: SessionSearchHit = { session: summary, messageId: "tool-result-1", kind: "tool_result", snippet: "合成工具结果" };
  assert.equal(searchHitMode(hit, "brief"), "trace");
  assert.equal(searchHitMode({ ...hit, messageId: undefined, kind: "title" }, "full"), "full");
});

test("轮次按消息序号排序并保留明确轮次，未知轮次不推断编号", () => {
  const turns = groupedTurns([
    message("b", 4, "turn-b", "tool_result"),
    message("a2", 2, "turn-a"),
    message("a1", 1, "turn-a", "user"),
    message("unknown-2", 6, ""),
    message("unknown-1", 5, ""),
  ]);
  assert.deepEqual(turns.map(turn => turn.id), ["turn-a", "turn-b", "unknown"]);
  assert.deepEqual(turns[0]?.messages.map(item => item.id), ["a1", "a2"]);
  assert.deepEqual(turns[2]?.messages.map(item => item.id), ["unknown-1", "unknown-2"]);
});

test("缺失用量显示未记录，已记录零值保持为零", () => {
  assert.equal(displayRecorded(null), "未记录");
  assert.equal(displayRecorded(undefined), "未记录");
  assert.equal(displayRecorded(0), "0");
});

test("用量趋势保留零值，并在缺失记录处断开曲线", () => {
  assert.deepEqual(usageSegments([{ id: "a", inputTokens: 0 }, { id: "b" }, { id: "c", inputTokens: 100 }], "inputTokens", 100), ["0,100", "100,0"]);
  assert.deepEqual(usageSegments([{ id: "a" }], "inputTokens", 0), []);
  assert.deepEqual(usageSegments([{ id: "a", inputTokens: 10 }], "inputTokens", 10), ["50,0"]);
});

test("轮次分页和画像定位参数保留精确查询", () => {
  const params = new URLSearchParams(sessionParams({ pageUnit: "turn", turnPosition: 31, pageSize: 10, toolName: "sample tool", resourceKind: "mcp", resourceServer: "sample", resourceName: "lookup" }));
  assert.equal(params.get("pageUnit"), "turn");
  assert.equal(params.get("turnPosition"), "31");
  assert.equal(params.get("toolName"), "sample tool");
  assert.equal(params.get("resourceKind"), "mcp");
});

test("会话工作区语义覆盖列表与画像名称，地图默认语义保持兼容", () => {
  const semantics = workspaceSessionSemantics();
  assert.deepEqual(panelSemantics("sidebar", semantics), { label: "调整会话列表宽度", controls: "session-list-content" });
  assert.deepEqual(panelSemantics("details", semantics), { label: "调整会话画像宽度", controls: "session-profile-content" });
  assert.deepEqual(panelSemantics("sidebar"), { label: "调整仓库导航宽度", controls: "repository-navigation-content" });
  assert.deepEqual(panelSemantics("details"), { label: "调整文件详情宽度", controls: "file-details-content" });
});


test("分页消息仍显示来源的真实轮次编号，不按当前页从1重新编号", () => {
  assert.equal(turnTitle("session:turn:19", 1), "第 19 轮");
  assert.equal(turnTitle("session:turn:0", 1), "初始上下文");
  assert.equal(turnTitle("unknown", 1), "轮次未记录");
});
