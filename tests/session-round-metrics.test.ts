import assert from "node:assert/strict";
import test from "node:test";
import type { SessionMessage } from "../src/session-contracts.js";
import { promptCharacterCount, summarizeRoundMetrics } from "../src/sessions/round-metrics.js";

const message = (ordinal: number, turnId: string, extra: Partial<SessionMessage> = {}): SessionMessage => ({
  id: `message-${ordinal}`, sessionId: "synthetic-session", ordinal, recordLine: ordinal + 1, turnId, kind: "user", text: "合成需求", ...extra,
});
const final = (ordinal: number, turnId: string, occurredAt?: string) => message(ordinal, turnId, { kind: "assistant", final: "explicit", occurredAt });

test("提示词字符统一排除 Unicode 空白并按码点计算", () => {
  assert.equal(promptCharacterCount("你\u3000好\u00a0🙂\nA\tB\r\f"), 5);
});

test("平均步骤按明确结束的用户轮次计请求，提示词合并同一来源输入的多个文本块", () => {
  const result = summarizeRoundMetrics([
    message(0, "a", { text: "需求 ", occurredAt: "2026-10-05T09:00:00Z" }),
    message(1, "a", { recordLine: 1, text: "一" }),
    final(3, "a", "2026-10-05T09:01:00Z"),
    message(4, "b", { text: "改ABC🙂", occurredAt: "2026-10-05T09:03:00Z" }),
    final(9, "b", "2026-10-05T09:05:00Z"),
    message(10, "ongoing", { text: "继续" }),
  ], [
    { id: "a-1", turnId: "a" }, { id: "a-2", turnId: "a" }, { id: "a-2", turnId: "a" },
    ...[1, 2, 3].map(index => ({ id: `b-${index}`, turnId: "b" })),
    { id: "ongoing-1", turnId: "ongoing" }, { id: "unassociated" },
  ]);
  assert.deepEqual(result, { userTurns: 3, completedTurns: 2, stepTurns: 2, timedTurns: 2, promptInputs: 3,
    averageSteps: 2.5, averageDurationMs: 90_000, averagePromptCharacters: 10 / 3 });
});

test("推断终答和无真实用户请求的明确终答不进入已结束轮次", () => {
  const result = summarizeRoundMetrics([
    message(0, "inferred"), message(1, "inferred", { kind: "assistant", final: "inferred" }),
    final(2, "orphan"), message(3, "pending"), message(4, "pending", { kind: "assistant" }),
  ], [{ id: "inferred-request", turnId: "inferred" }]);
  assert.equal(result.userTurns, 2);
  assert.equal(result.completedTurns, 0);
  assert.equal(result.averageSteps, null);
  assert.equal(result.averageDurationMs, null);
  assert.equal(result.promptInputs, 2);
});

test("复制记录、明确注入、技能读取和工具结果不计用户轮次或提示词", () => {
  const result = summarizeRoundMetrics([
    message(0, "copied", { copied: true }), final(1, "copied"),
    message(2, "context", { contextSource: "client" }), final(3, "context"),
    message(4, "skill", { resource: { kind: "skill_read", name: "synthetic" } }),
    message(5, "tool", { kind: "tool_result" }), message(6, "system", { kind: "context" }),
  ], [{ id: "copied-request", turnId: "copied" }]);
  assert.deepEqual(result, { userTurns: 0, completedTurns: 0, stepTurns: 0, timedTurns: 0, promptInputs: 0,
    averageSteps: null, averageDurationMs: null, averagePromptCharacters: null });
});

test("明确结束但缺少请求关联不当作零步骤，缺失或倒序时间不当作零耗时", () => {
  const result = summarizeRoundMetrics([
    message(0, "missing"), final(1, "missing", "2026-10-05T09:00:00Z"),
    message(2, "invalid", { occurredAt: "invalid" }), final(3, "invalid", "2026-10-05T09:00:00Z"),
    message(4, "reversed", { occurredAt: "2026-10-05T10:00:00Z" }), final(5, "reversed", "2026-10-05T09:00:00Z"),
  ], []);
  assert.equal(result.completedTurns, 3);
  assert.equal(result.stepTurns, 0);
  assert.equal(result.timedTurns, 0);
  assert.equal(result.averageSteps, null);
  assert.equal(result.averageDurationMs, null);
});

test("实际零耗时与零文字长度保留，请求即使用量缺失也可计一个已识别步骤", () => {
  const result = summarizeRoundMetrics([
    message(0, "zero", { text: " \n\t", occurredAt: "2026-10-05T09:00:00Z" }),
    final(1, "zero", "2026-10-05T09:00:00Z"),
  ], [{ id: "known-request", turnId: "zero" }]);
  assert.equal(result.averageSteps, 1);
  assert.equal(result.averageDurationMs, 0);
  assert.equal(result.averagePromptCharacters, 0);
});

test("同一轮中独立输入分别计提示词，不按消息轮次数平均", () => {
  const result = summarizeRoundMetrics([
    message(0, "a", { text: "A B" }), message(1, "a", { text: "你好🙂" }),
  ], []);
  assert.equal(result.userTurns, 1);
  assert.equal(result.promptInputs, 2);
  assert.equal(result.averagePromptCharacters, 2.5);
});

test("无法确认边界的混合正文保留原文，不靠关键词删除用户输入", () => {
  const text = "请分析 <skill><name>demo</name>引用</skill>";
  const result = summarizeRoundMetrics([message(0, "a", { text })], []);
  assert.equal(result.averagePromptCharacters, [...text.replace(/\s/gu, "")].length);
});

test("结束边界取最后明确终答，早于用户请求的结束记录不能确认本轮", () => {
  const result = summarizeRoundMetrics([
    message(0, "a", { occurredAt: "2026-10-05T09:00:00Z" }),
    final(1, "a", "2026-10-05T09:01:00Z"), final(2, "a", "2026-10-05T09:02:00Z"),
    final(3, "early", "2026-10-05T09:00:00Z"), message(4, "early", { occurredAt: "2026-10-05T09:01:00Z" }),
  ], [{ id: "request", turnId: "a" }]);
  assert.equal(result.completedTurns, 1);
  assert.equal(result.averageDurationMs, 120_000);
});
