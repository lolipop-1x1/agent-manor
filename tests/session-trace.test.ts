import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionMessage } from "../src/session-contracts.ts";
import { timelineCenteredScroll, timelineFraction, timelineNodes, timelinePosition, timelineProjection, timelineVisibleMarks, timelineZoomScroll, traceAnchoredScroll, tracePreview, traceTurns, traceWindow } from "../web/features/sessions/session-trace-model.ts";

const message = (ordinal: number, kind: SessionMessage["kind"], fields: Partial<SessionMessage> = {}): SessionMessage => ({
  id: `message-${ordinal}`, sessionId: "session-example", ordinal, recordLine: ordinal, turnId: "turn-one", kind, text: "合成记录", ...fields,
});

test("并行工具按唯一身份关联，返回结果不占重复节点，原始记录仍完整保留", () => {
  const source = [message(1, "user"), message(2, "tool_call", { callId: "a", tool: "read" }), message(3, "tool_call", { callId: "b", tool: "read" }),
    message(4, "tool_result", { callId: "b" }), message(5, "tool_result", { callId: "a" }), message(6, "assistant")];
  const [turn] = traceTurns(source, [{ id: "usage", messageId: "message-6", inputTokens: 0, outputTokens: 12 }]);
  assert.deepEqual(turn?.records.map(record => [record.message.ordinal, record.result?.ordinal]), [[1, undefined], [2, 5], [3, 4], [6, undefined]]);
  assert.equal(turn?.messages.length, 6);
  assert.equal(turn?.records[3]?.usage[0]?.inputTokens, 0);
});

test("重复身份、反向顺序、工具冲突、跨轮和跨会话不猜测关联", () => {
  const sources = [
    [message(1, "tool_call", { callId: "a" }), message(2, "tool_call", { callId: "a" }), message(3, "tool_result", { callId: "a" })],
    [message(1, "tool_call", { callId: "a" }), message(2, "tool_result", { callId: "a" }), message(3, "tool_result", { callId: "a" })],
    [message(1, "tool_result", { callId: "a" }), message(2, "tool_call", { callId: "a" })],
    [message(1, "tool_call", { callId: "a", tool: "read" }), message(2, "tool_result", { callId: "a", tool: "write" })],
    [message(1, "tool_call", { callId: "a" }), message(2, "tool_result", { callId: "a", turnId: "turn-two" })],
    [message(1, "tool_call", { callId: "a" }), message(2, "tool_result", { callId: "a", sessionId: "another-session" })],
    [message(1, "tool_call"), message(2, "tool_result")],
  ];
  for (const source of sources) {
    const records = traceTurns(source, []).flatMap(turn => turn.records);
    assert.equal(records.length, source.length);
    assert.ok(records.every(record => !record.result));
  }
});

test("用量仅按明确消息身份关联，初始上下文、思考和压缩保留原始顺序", () => {
  const turns = traceTurns([message(4, "compression"), message(3, "thinking"), message(1, "system", { turnId: "initial" }), message(2, "user")],
    [{ id: "a", turnId: "turn-one", inputTokens: 90 }, { id: "b", messageId: "message-3", inputTokens: 100 }]);
  assert.deepEqual(turns.map(turn => turn.records.map(record => record.message.kind)), [["system"], ["user", "thinking", "compression"]]);
  assert.equal(turns[1]?.records[1]?.usage.length, 1);
  assert.equal(turns[1]?.records[0]?.usage.length, 0);
});

test("大轨迹只投影可见窗口，首末边界不丢记录", () => {
  assert.deepEqual(traceWindow(10000, 0, 400), { start: 0, end: 18 });
  assert.deepEqual(traceWindow(10000, 200000, 400), { start: 4992, end: 5018 });
  const last = traceWindow(10000, 399600, 400);
  assert.equal(last.end, 10000);
  assert.ok(last.end - last.start < 40);
  assert.deepEqual(traceWindow(0, 0, 400), { start: 0, end: 0 });
  assert.equal(tracePreview("  第一行\n  第二行 "), "第一行 第二行");
});

test("轨迹补入前文、裁剪远端与跨段配对后保持可见节点及行内位置", () => {
  const previous = Array.from({ length: 300 }, (_, index) => `record-${index}`);
  const prepended = [...Array.from({ length: 300 }, (_, index) => `earlier-${index}`), ...previous];
  assert.equal(traceAnchoredScroll(previous, prepended, 85, 200), 12085);
  assert.equal(traceAnchoredScroll(prepended, previous, 12085, 200), 85);
  assert.equal(traceAnchoredScroll(previous, previous.filter(key => key !== "record-1"), 85, 200), 45);
  assert.equal(traceAnchoredScroll(previous, [...previous, "later"], 85, 200), 85);
  assert.equal(traceAnchoredScroll(["turn:one", "record:last"], ["turn:one", "record:earlier", "record:last"], 0, 400), 40);
});

test("总览覆盖全部节点并按事件、轮次和记录时间投影，缺失时间不补造", async () => {
  const { timelineNodes, timelineProjection } = await import("../web/features/sessions/session-trace-model.js");
  const nodes = timelineNodes([
    message(1, "context", { turnId: "initial" }),
    message(2, "user", { occurredAt: "2026-01-01T00:00:00Z" }),
    message(3, "tool_call", { callId: "one", tool: "read", occurredAt: "2026-01-01T00:00:01Z" }),
    message(4, "tool_result", { callId: "one", tool: "read" }),
    message(5, "assistant", { occurredAt: "2026-01-01T00:00:02Z" }),
    message(6, "user", { turnId: "next", occurredAt: "invalid" }),
  ]);
  assert.equal(nodes.length, 5);
  assert.equal(nodes[2]?.result?.ordinal, 4);
  const sequence = timelineProjection(nodes, "sequence");
  assert.deepEqual(sequence.spans.map(span => span.lane), [0, 0, 2, 1, 0]);
  assert.equal(sequence.spans.at(-1)?.x, 1);
  const turns = timelineProjection(nodes, "turn");
  assert.equal(turns.spans.at(-1)?.x, 2 / 3);
  const time = timelineProjection(nodes, "time");
  assert.equal(time.missing, 2);
  assert.deepEqual(time.spans.map(span => span.x), [0, 0.5, 1]);
  assert.equal(time.spans[1]?.event.id, nodes[2]?.event.id);
  assert.equal(timelineProjection([], "time").spans.length, 0);
});

test("缩放绘制与命中使用相同坐标，中心及指针锚点保持，端点不越界", () => {
  for (const width of [320, 1000, 64000]) {
    for (const x of [0, 0.13, 0.5, 0.97, 1]) {
      assert.ok(Math.abs(timelineFraction(timelinePosition(x, width), width) - x) < 1e-12);
    }
    assert.equal(timelineFraction(-10, width), 0);
    assert.equal(timelineFraction(width + 10, width), 1);
  }
  for (const anchor of [100, 500, 900]) {
    const before = timelineFraction(2000 + anchor, 8000);
    const afterScroll = timelineZoomScroll(2000, 1000, 8000, 16000, anchor);
    assert.ok(Math.abs(timelineFraction(afterScroll + anchor, 16000) - before) < 1e-12);
  }
  assert.equal(timelineCenteredScroll(0, 8000, 1000), 0);
  assert.equal(timelineCenteredScroll(1, 8000, 1000), 7000);
  assert.equal(timelineCenteredScroll(0.5, 8000, 1000), 3500);
  assert.equal(timelineZoomScroll(3000, 1000, 8000, 1000), 0);
  assert.equal(timelineZoomScroll(0, 1000, 1000, 2000, 0), 0);
  assert.equal(timelineZoomScroll(0, 1000, 1000, 2000, 1000), 1000);
});

test("长会话仅绘制可见像素，放大拉开标记并保留选中节点及成对结果", () => {
  const nodes = timelineNodes(Array.from({ length: 10000 }, (_, index) => message(index + 1, "assistant")));
  const { spans } = timelineProjection(nodes, "sequence");
  const fitted = timelineVisibleMarks(spans, 1000, 0, 1000);
  const zoomed = timelineVisibleMarks(spans, 64000, 31000, 1000);
  assert.ok(fitted.length <= 1000);
  assert.ok(zoomed.length < 170);
  assert.ok(timelinePosition(spans[1]!.x, 64000) - timelinePosition(spans[0]!.x, 64000) > 5);
  assert.ok(zoomed.every(span => timelinePosition(span.x, 64000) >= 30995 && timelinePosition(span.x, 64000) <= 32005));
  assert.equal(timelineVisibleMarks(spans, 64000, 0, 1000)[0]?.event.id, nodes[0]?.event.id);
  assert.equal(timelineVisibleMarks(spans, 64000, 63000, 1000).at(-1)?.event.id, nodes.at(-1)?.event.id);
  const selected = spans[5]!;
  assert.ok(timelineVisibleMarks(spans, 1000, 0, 1000, selected.event.id).includes(selected));
  const pair = timelineProjection(timelineNodes([
    message(1, "tool_call", { callId: "paired" }), message(2, "tool_result", { callId: "paired" }),
  ]), "sequence").spans;
  assert.equal(timelineVisibleMarks(pair, 1000, 0, 1000, "message-2")[0]?.result?.id, "message-2");
  assert.deepEqual(timelineVisibleMarks([], 1000, 0, 1000), []);
});

test("聚合代表不从采样子集推断工具配对，完整总览仍按唯一身份关联", () => {
  const sampled = [message(1, "tool_call", { callId: "sampled" }), message(3, "tool_result", { callId: "sampled" })];
  assert.equal(timelineNodes(sampled, false).length, 2);
  assert.ok(timelineNodes(sampled, false).every(node => !node.result));
  assert.equal(timelineNodes(sampled).length, 1);
  assert.equal(timelineNodes(sampled)[0]?.result?.id, "message-3");
});
