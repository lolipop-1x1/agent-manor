import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionMessage } from "../src/session-contracts.ts";
import { isMessageDescriptorKnown, translate } from "../src/i18n/index.ts";
import { formatRequestSpeed, messageSpeedRequest, requestLocation, sessionSpeedMap, type SpeedStep } from "../web/session-speed-model.ts";

const step = (id: string, fields: Partial<SpeedStep> = {}): SpeedStep => ({
  id, sessionId: "synthetic-session", turnId: "round-one", outputTokens: 400,
  timing: { basis: "estimated", method: "codex_event_boundary", completion: "explicit", durationMs: 10000 }, ...fields,
});
const message = (id: string, kind: SessionMessage["kind"], fields: Partial<SessionMessage> = {}): SessionMessage => ({
  id, kind, sessionId: "synthetic-session", turnId: "round-one", ordinal: 1, recordLine: 1, text: "合成记录", ...fields,
});

test("完整请求映射让同请求思考和正文共享值；轮均值包括未显示的过程请求且去重", () => {
  const first = step("request-one", { messageId: "usage-one", requestMessageIds: ["thinking-one", "answer-one"] });
  const second = step("request-two", { messageId: "usage-two", outputTokens: 200, timing: { ...first.timing!, durationMs: 10000 } });
  const mapping = sessionSpeedMap([first, first, second, step("child-request", { sessionId: "child-session" })], "synthetic-session");
  assert.equal(messageSpeedRequest(message("thinking-one", "thinking"), mapping), first);
  assert.equal(messageSpeedRequest(message("answer-one", "assistant"), mapping), first);
  assert.equal(messageSpeedRequest(message("usage-one", "system"), mapping), first);
  assert.equal(mapping.byTurn.get("round-one")?.requests, 2);
  assert.equal(mapping.byTurn.get("round-one")?.tokensPerSecond, 30);
  for (const kind of ["user", "tool_call", "tool_result", "context", "compression"] as const) assert.equal(messageSpeedRequest(message("thinking-one", kind), mapping), undefined);
  assert.equal(messageSpeedRequest(message("answer-one", "assistant", { copied: true }), mapping), undefined);
});

test("消息身份关联冲突不猜测速度；缺失请求仍进入轮级覆盖分母", () => {
  const mapping = sessionSpeedMap([step("one", { requestMessageIds: ["ambiguous"] }), step("two", { requestMessageIds: ["ambiguous"] }), step("missing", { outputTokens: undefined })], "synthetic-session");
  assert.equal(messageSpeedRequest(message("ambiguous", "assistant"), mapping), undefined);
  assert.equal(messageSpeedRequest(message("unlinked", "assistant"), mapping), undefined);
  assert.equal(mapping.summary.requests, 3);
  assert.equal(mapping.summary.eligibleRequests, 2);
});

test("轮平均遵循当前、全部与指定分支；旧分支字段缺失保留未知范围", () => {
  const records = [step("old", { outputTokens: 200, branchIds: ["branch-a"], currentBranch: false }), step("live", { branchIds: ["branch-b"], currentBranch: true }), step("unscoped")];
  const current = sessionSpeedMap(records, "synthetic-session", "current", true);
  assert.equal(current.summary.tokensPerSecond, 40);
  assert.equal(current.summary.requests, 1);
  assert.equal(current.scopeUnknown, true);
  assert.equal(sessionSpeedMap(records, "synthetic-session", "branch-a", true).summary.tokensPerSecond, 20);
  assert.equal(sessionSpeedMap(records, "synthetic-session", "all", true).summary.requests, 3);
  assert.equal(sessionSpeedMap(records, "synthetic-session", "current", false).summary.requests, 3);
});

test("请求定位保留用量标记优先，缺失用量可回到明确模型消息或结束边界", () => {
  assert.equal(requestLocation(step("one", { messageId: "usage", requestMessageIds: ["assistant"] })), "usage");
  assert.equal(requestLocation(step("one", { requestMessageIds: ["assistant"] })), "assistant");
  assert.equal(requestLocation(step("one", { timing: { basis: "estimated", method: "codex_event_boundary", completion: "unknown", end: { recordLine: 5, messageId: "response" } } })), "response");
  assert.equal(requestLocation(step("unknown")), undefined);
});

test("速度格式沿用显示语言，小于一时一位小数；动态原因与证据文案两种语言齐全", () => {
  for (const language of ["en", "zh-CN"] as const) {
    assert.equal(formatRequestSpeed(39.7, language), "40");
    assert.equal(formatRequestSpeed(0.63, language), "0.6");
    for (const [category, names] of [
      ["reason", ["output_missing", "output_below_threshold", "timing_missing", "invalid_timing", "duration_below_threshold", "partial_response", "end_unconfirmed"]],
      ["completion", ["explicit", "inferred", "partial", "unknown"]],
      ["method", ["codex_event_boundary", "claude_message_boundary", "codeflicker_message_boundary"]],
      ["evidence", ["stop_reason", "tool_result", "tool_response_snapshot", "final_response_snapshot", "persisted_stream_result", "request_interrupted"]],
    ] as const) for (const name of names) {
      const key = `sessions.speed.${category}.${name}`;
      assert.ok(isMessageDescriptorKnown({ key }), key);
      assert.ok(translate(language, key).length > 0);
    }
    const formula = translate(language, "sessions.speed.formula", { output: "480", seconds: "12.0", speed: "40" });
    assert.ok(formula.includes("480") && formula.includes("12.0") && formula.includes("≈ 40 tok/s"));
  }
  assert.equal(translate("zh-CN", "sessions.mode.trace"), "执行轨迹");
  assert.equal(translate("en", "sessions.mode.trace"), "Execution trace");
});
