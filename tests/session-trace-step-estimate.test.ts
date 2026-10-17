import assert from "node:assert/strict";
import test from "node:test";
import type { SessionMessage } from "../src/session-contracts.js";
import { deriveRoundFacts, summarizeRoundMetrics, type RoundMessage } from "../src/sessions/round-metrics.js";

const event = (ordinal: number, kind: SessionMessage["kind"], extra: Partial<RoundMessage> = {}): RoundMessage => ({
  id: `event-${ordinal}`, ordinal, recordLine: ordinal + 1, turnId: "turn", kind, text: "合成内容", ...extra,
});
const trace = () => [
  event(0, "user"), event(1, "thinking"), event(2, "thinking"), event(3, "context"), event(4, "assistant"),
  event(5, "context", { operation: { type: "view" } }), event(6, "thinking"),
  event(7, "tool_call"), event(8, "tool_call"), event(9, "tool_result"), event(10, "tool_result"),
  event(11, "thinking"), event(12, "assistant", { final: "explicit" }),
];

test("缺请求时按连续模型输出段估算，思考与回复合并、并行工具和操作仅划分边界", () => {
  const rows = trace();
  const fact = deriveRoundFacts(rows, [], false).rounds[0]!;
  assert.equal(fact.steps, 3);
  assert.equal(fact.stepsEstimated, true);
  assert.equal(fact.tokens, null);
  assert.equal(fact.toolCalls, 2);
  const metrics = summarizeRoundMetrics(rows, [], false);
  assert.equal(metrics.averageSteps, 3);
  assert.equal(metrics.estimatedStepTurns, 1);
  assert.equal(metrics.inferredStepTurns, undefined, "明确终答与步骤估算分别记录");
});

test("原生请求优先，缺少 Token 不改按请求计步，也不叠加轨迹段", () => {
  const rows = trace();
  const requests = [{ id: "native-a", turnId: "turn" }, { id: "native-b", messageId: "event-12" }];
  const fact = deriveRoundFacts(rows, requests).rounds[0]!;
  assert.equal(fact.steps, 2);
  assert.equal(fact.stepsEstimated, undefined);
  assert.equal(fact.tokens, null);
  assert.equal(summarizeRoundMetrics(rows, requests).estimatedStepTurns, undefined);
  const incomplete = deriveRoundFacts(rows, requests, false).rounds[0]!;
  assert.equal(incomplete.steps, null, "存在原生请求时不以轨迹覆盖已知边界缺口");
  assert.equal(incomplete.stepsEstimated, undefined);
});

test("原生与估算轮次可共同汇总，复制、注入、空白及没有回复的轮次不增加样本", () => {
  const rows = [...trace(), event(13, "user", { turnId: "native" }), event(14, "assistant", { turnId: "native", final: "explicit" }),
    event(15, "user", { turnId: "pending" }), event(16, "thinking", { turnId: "pending" }),
    event(17, "assistant", { turnId: "pending", text: "\u3000\n" }),
    event(18, "user", { turnId: "copied", copied: true }), event(19, "assistant", { turnId: "copied", copied: true }),
    event(20, "user", { turnId: "injected", contextSource: "client" }), event(21, "assistant", { turnId: "injected" })];
  const result = summarizeRoundMetrics(rows, [{ id: "native-1", turnId: "native" }, { id: "native-2", turnId: "native" }]);
  assert.equal(result.userTurns, 3);
  assert.equal(result.completedTurns, 2);
  assert.equal(result.stepTurns, 2);
  assert.equal(result.averageSteps, 2.5);
  assert.equal(result.estimatedStepTurns, 1);
});

test("窄投影的非空标记与完整正文得到相同估算，输入顺序和重复投影不改变结果", () => {
  const full = trace();
  const projected = full.map(({ text, ...row }) => ({ ...row, hasReply: row.kind === "assistant",
    hasModelContent: ["assistant", "thinking"].includes(row.kind) && Boolean(text?.trim()) }));
  const rows = [projected[6]!, ...projected.slice().reverse(), projected[5]!];
  assert.equal(deriveRoundFacts(rows, []).rounds[0]?.steps, 3);
  assert.equal(deriveRoundFacts(full, []).rounds[0]?.steps, 3);
});

test("普通上下文和注入不拆分模型段，真实后续输入及孤立工具结果会拆分", () => {
  const rows = [event(0, "user"), event(1, "thinking"), event(2, "context"),
    event(3, "user", { contextSource: "client" }), event(4, "assistant"),
    event(5, "user"), event(6, "assistant"), event(7, "tool_result"), event(8, "assistant")];
  assert.equal(deriveRoundFacts(rows, []).rounds[0]?.steps, 3);
});
