import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client } from "../src/clients.ts";
import type { SessionMessage, SessionSearchHit } from "../src/session-contracts.ts";
import { translate } from "../src/i18n/index.ts";
import { panelSemantics } from "../web/shared/layout/workspace-layout.ts";
import { sessionDisplayTitle, sessionParentTitle, sessionResourceName, sessionMessageText, displayRecorded, groupedTurns, searchHitMode, searchKinds, sessionParams, turnTitle, usageAxis, usageIndexAt, usageSegments, workspaceSessionSemantics } from "../web/features/sessions/session-model.ts";

const summary = {
  id: "session-a", client: "codex" as Client, clientSessionId: "external-a", title: "合成会话", titleOrigin: "recorded" as const,
  messageCount: 3, turnCount: 2, models: [], gaps: [],
};

const message = (id: string, ordinal: number, turnId: string, kind: SessionMessage["kind"] = "assistant"): SessionMessage => ({
  id, sessionId: summary.id, ordinal, recordLine: ordinal, turnId, kind, text: id,
});

test("产品过程标题按描述切换语言，原始详情只引用完整正文", () => {
  const details = '{"stdout":"原始输出\\n第二行","command":"printf fixture"}';
  for (const key of ["sessions.body.hook", "sessions.body.attachment", "sessions.body.usage"]) {
    const record = { ...message("process", 1, "turn-a", "context"), text: `产品标题\n${details}`, textDescriptor: { key } };
    for (const language of ["zh-CN", "en"] as const) assert.equal(sessionMessageText(record, language), translate(language, key, { details }));
    assert.ok(!JSON.stringify(record.textDescriptor).includes(details));
  }
});

test("父标题和资源名称仅按来源描述翻译，未知正文描述保留原文", () => {
  const parent = { ...summary, parentTitle: "未命名会话" };
  const resource = { kind: "skill_call" as const, name: "未记录名称" };
  for (const language of ["en", "zh-CN"] as const) {
    assert.equal(sessionParentTitle(parent, language), "未命名会话");
    assert.equal(sessionResourceName(resource, language), "未记录名称");
    assert.equal(sessionMessageText({ ...message("original", 1, "turn-a"), text: "原始正文", textDescriptor: { key: "sessions.synthetic.obsolete" } }, language), "原始正文");
  }
  assert.equal(sessionParentTitle({ ...parent, parentTitleDescriptor: { key: "sessions.title.unnamed" } }, "en"), "Unnamed session");
  assert.equal(sessionParentTitle({ ...parent, parentTitleDescriptor: { key: "sessions.title.childFallback", params: { id: "child-01" } } }, "en"), "Child session child-01");
  assert.equal(sessionResourceName({ ...resource, nameDescriptor: { key: "sessions.resource.nameUnrecorded" } }, "en"), "Name not recorded");
  assert.equal(sessionResourceName({ ...resource, nameDescriptor: { key: "sessions.resource.nameUnrecorded" } }, "zh-CN"), "未记录名称");
  assert.equal(sessionResourceName({ ...resource, nameDescriptor: { key: "sessions.synthetic.obsolete" } }, "en"), "未记录名称");
});

test("会话查询编码保留筛选、类型列表和消息精确定位", () => {
  const params = new URLSearchParams(sessionParams({ client: "codex", project: "none", q: "缓存 命中&模型", kinds: ["user", "tool_call"],
    page: 3, pageSize: 40, version: "version-7", mode: "trace", messageId: "message / 9", sessionId: summary.id, includeSubagents: true, executionMode: "quiet" }));
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
  assert.equal(params.get("includeSubagents"), "true");
  assert.equal(params.get("executionMode"), "quiet");
});

test("默认搜索只包含用户与 AI 正文，过程选项加入完整记录类型", () => {
  assert.deepEqual(searchKinds(false), ["user", "assistant"]);
  assert.deepEqual(searchKinds(true), ["user", "assistant", "thinking", "tool_call", "tool_result", "system", "context", "compression"]);
});

test("可见对话命中使用简易对话，过程与隐藏回复使用轨迹，标题保留模式", () => {
  const hit: SessionSearchHit = { session: summary, messageId: "tool-result-1", kind: "tool_result", snippet: "合成工具结果" };
  assert.equal(searchHitMode(hit, "brief"), "trace");
  for (const kind of ["user", "assistant"] as const) {
    assert.equal(searchHitMode({ ...hit, kind, briefVisible: true }, "trace"), "brief");
    assert.equal(searchHitMode({ ...hit, kind, briefVisible: false }, "brief"), "trace");
    assert.equal(searchHitMode({ ...hit, kind }, "brief"), "trace");
  }
  for (const kind of searchKinds(true).filter(kind => kind !== "user" && kind !== "assistant")) {
    assert.equal(searchHitMode({ ...hit, kind, briefVisible: true }, "brief"), "trace");
  }
  for (const mode of ["brief", "full", "trace"] as const) {
    assert.equal(searchHitMode({ ...hit, messageId: undefined, kind: "title" }, mode), mode);
  }
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
  assert.equal(displayRecorded(null, "zh-CN"), "未记录");
  assert.equal(displayRecorded(undefined, "zh-CN"), "未记录");
  assert.equal(displayRecorded(0, "zh-CN"), "0");
});

test("用量趋势保留零值，并在缺失记录处断开曲线", () => {
  assert.deepEqual(usageSegments([{ id: "a", inputTokens: 0 }, { id: "b" }, { id: "c", inputTokens: 100 }], "inputTokens", 100), ["0,100", "100,0"]);
  assert.deepEqual(usageSegments([{ id: "a" }], "inputTokens", 0), []);
  assert.deepEqual(usageSegments([{ id: "a", inputTokens: 10 }], "inputTokens", 10), ["50,0"]);
});

test("用量纵轴覆盖最大值，以零为起点并使用整数 Token 刻度", () => {
  assert.deepEqual(usageAxis(224776), { max: 250000, ticks: [0, 50000, 100000, 150000, 200000, 250000] });
  assert.deepEqual(usageAxis(0), { max: 1, ticks: [0, 1] });
  for (const value of [1, 7, 999, 1000000]) {
    const axis = usageAxis(value);
    assert.ok(axis.max >= value);
    assert.equal(axis.ticks[0], 0);
    assert.equal(axis.ticks.at(-1), axis.max);
    assert.ok(axis.ticks.every(tick => Number.isInteger(tick)));
  }
});

test("长用量曲线保留全部请求，包括末尾峰值与中途缺失", () => {
  const steps = Array.from({ length: 513 }, (_, index) => ({ id: `request-${index}`, ...(index === 256 ? {} : { inputTokens: index === 512 ? 1000 : 0 }) }));
  const segments = usageSegments(steps, "inputTokens", 1000);
  assert.equal(segments.length, 2);
  assert.equal(segments.reduce((count, points) => count + points.split(" ").length, 0), 512);
  assert.equal(segments[0]?.split(" ")[0], "0,100");
  assert.equal(segments.at(-1)?.split(" ").at(-1), "100,0");
});

test("共用图表交互层按横轴定位全部请求，首末边界与单请求正确", () => {
  assert.equal(usageIndexAt(0, 5369), 0);
  assert.equal(usageIndexAt(1, 5369), 5368);
  assert.equal(usageIndexAt(0.5, 5369), 2684);
  assert.equal(usageIndexAt(201 / 5368, 5369), 201);
  assert.equal(usageIndexAt(-0.1, 5369), 0);
  assert.equal(usageIndexAt(1.1, 5369), 5368);
  assert.equal(usageIndexAt(0.7, 1), 0);
});

test("轮次分页和画像定位参数保留精确查询", () => {
  const params = new URLSearchParams(sessionParams({ pageUnit: "turn", turnPosition: 31, pageSize: 10, toolName: "sample tool", resourceKind: "mcp", resourceServer: "sample", resourceName: "lookup" }));
  assert.equal(params.get("pageUnit"), "turn");
  assert.equal(params.get("turnPosition"), "31");
  assert.equal(params.get("toolName"), "sample tool");
  assert.equal(params.get("resourceKind"), "mcp");
});

test("会话工作区语义覆盖列表与画像名称，地图默认语义保持兼容", () => {
  const semantics = workspaceSessionSemantics("zh-CN");
  assert.deepEqual(panelSemantics("sidebar", semantics), { label: "调整会话列表宽度", controls: "session-list-content" });
  assert.deepEqual(panelSemantics("details", semantics), { label: "调整会话画像宽度", controls: "session-profile-content" });
  assert.deepEqual(panelSemantics("sidebar"), { label: translate("en", "common.workspace.sidebarWidth"), controls: "repository-navigation-content" });
  assert.deepEqual(panelSemantics("details"), { label: translate("en", "common.workspace.detailsWidth"), controls: "file-details-content" });
});


test("分页消息仍显示来源的真实轮次编号，不按当前页从1重新编号", () => {
  assert.equal(turnTitle("session:turn:19", 1, "zh-CN"), "第 19 轮");
  assert.equal(turnTitle("session:turn:0", 1, "zh-CN"), "初始上下文");
  assert.equal(turnTitle("unknown", 1, "zh-CN"), "轮次未记录");
  assert.equal(turnTitle("session:unassigned:4:turn:0", 0, "zh-CN"), "轮次未记录");
  assert.equal(turnTitle("session:unassigned:4:turn:0", 0, "en"), "Turn not recorded");
});


test("会话标签按指定语言呈现，真实同名标题、正文、入口与标识保持原文", () => {
  assert.equal(sessionDisplayTitle({ ...summary, title: "未命名会话" }, "en"), "未命名会话");
  assert.equal(sessionDisplayTitle({ ...summary, title: "未命名会话", titleOrigin: "first_user" }, "en"), "未命名会话");
  assert.equal(sessionDisplayTitle({ ...summary, titleOrigin: "fallback" }, "en"), "Unnamed session");
  assert.equal(sessionDisplayTitle({ ...summary, titleOrigin: "fallback", relationship: "child" }, "en"), "Child session ternal-a");
  const original = message("未记录内容", 1, "turn-a");
  assert.equal(sessionMessageText(original, "en"), "未记录内容");
  const generated = { ...original, textDescriptor: { key: "sessions.body.unrecorded" } };
  assert.equal(sessionMessageText(generated, "en"), "Content not recorded");
  assert.equal(sessionMessageText(generated, "zh-CN"), "未记录内容");
  assert.equal(original.text, "未记录内容");
  assert.equal(turnTitle("session:turn:19", 1, "en"), "Turn 19");
  assert.equal(turnTitle("session:turn:0", 1, "en"), "Initial context");
  assert.equal(displayRecorded(undefined, "en"), "Not recorded");
  assert.equal(displayRecorded(0, "en"), "0");
  assert.equal(workspaceSessionSemantics("en").sidebar.label, "Resize session list");
});

test("会话目录的数量复数与生成正文参数保留原始内容", () => {
  assert.equal(translate("en", "sessions.recordCount", { count: 1 }), "1 record");
  assert.equal(translate("en", "sessions.recordCount", { count: 2 }), "2 records");
  assert.equal(translate("zh-CN", "sessions.recordCount", { count: 2 }), "2 条记录");
  const detail = "request/header turn=1 model=合成模型";
  assert.equal(translate("en", "sessions.body.dshEvent", { detail }), `DSH process event ${detail}`);
  assert.equal(translate("zh-CN", "sessions.body.dshEvent", { detail }), `DSH 过程事件 ${detail}`);
  assert.equal(translate("en", "sessions.profile.chartValueLinked", { number: "1", input: "0", output: "Not recorded", cache: "0" }), "Request 1, input 0, output Not recorded, cache read 0; press Enter to locate the record");
});
