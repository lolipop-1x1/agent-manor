import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionMessage, SessionOperation, SessionProfile } from "../src/session-contracts.ts";
import { isMessageDescriptorKnown, translate } from "../src/i18n/index.ts";
import { sessionOperationLabel, sessionOperationType, sessionProfileHasCalls } from "../web/features/sessions/session-model.ts";
import { timelineNodes, timelineProjection, traceRecordPreview, traceTurns } from "../web/features/sessions/session-trace-model.ts";

const message = (id: string, ordinal: number, fields: Partial<SessionMessage> = {}): SessionMessage => ({
  id, ordinal, sessionId: "synthetic-session", turnId: "turn-one", recordLine: ordinal, kind: "context", text: "Synthetic context", ...fields,
});
const operation: SessionOperation = { type: "view", label: "Run a synthetic check", presentationComplete: true };

test("原生操作卡进入第三轨道，普通上下文仍在输入轨道，类别不替代工具配对", () => {
  const source = [message("context", 1), message("card", 2, { operation }),
    message("call", 3, { kind: "tool_call", callId: "call-a", tool: "read" }),
    message("result", 4, { kind: "tool_result", callId: "call-a", tool: "read", status: "success" }),
    message("assistant", 5, { kind: "assistant" })];
  const nodes = timelineNodes(source);
  assert.deepEqual(timelineProjection(nodes, "sequence").spans.map(span => span.lane), [0, 2, 2, 1]);
  assert.equal(nodes[1]?.event.operation?.type, "view");
  assert.equal(nodes[1]?.event.kind, "context");
  assert.equal(nodes[1]?.result, undefined);
  assert.equal(nodes[2]?.result?.id, "result");
  const aggregated = timelineNodes(source, false);
  assert.deepEqual(timelineProjection(aggregated, "turn").spans.map(span => span.lane), [0, 2, 2, 2, 1]);
});

test("卡片标题与正文分别展示，正文不拆成工具参数或结果，展示完成不补成成功", () => {
  const raw = JSON.stringify({ block_type: 10019, is_finish: true, content: { file_operation_block: { operation_type: 1, content: "synthetic output" } } });
  for (const presentationComplete of [true, false, undefined]) {
    const card = message("card", 2, { text: raw, operation: { ...operation, presentationComplete } });
    const [turn] = traceTurns([card], []);
    const record = turn!.records[0]!;
    assert.deepEqual(traceRecordPreview(record), { input: "Run a synthetic check", output: `Card content · ${raw}` });
    assert.equal(record.result, undefined);
    assert.equal(record.message.status, undefined);
    assert.equal(record.message.tool, undefined);
    assert.equal(record.message.text, raw);
    assert.deepEqual(record.usage, []);
  }
  const unknown = message("unknown", 3, { text: raw, operation: { type: "unknown" } });
  assert.equal(traceRecordPreview({ message: unknown, usage: [] }).input, "—");
});

test("既有工具和模型预览保持输入结果语义，缺结果不从正文补造", () => {
  const call = message("call", 1, { kind: "tool_call", tool: "read", text: '{"path":"src/example.ts"}' });
  assert.deepEqual(traceRecordPreview({ message: call, usage: [] }), { input: call.text, output: "Result not recorded" });
  assert.deepEqual(traceRecordPreview({ message: call, result: message("result", 2, { kind: "tool_result", text: "Recorded result" }), usage: [] }),
    { input: call.text, output: "Recorded result" });
  assert.deepEqual(traceRecordPreview({ message: message("assistant", 3, { kind: "assistant", text: "Recorded answer" }), usage: [] }),
    { input: "—", output: "Recorded answer" });
});

test("调用页签支持只有原生操作的画像，不为普通上下文或空字段增加页签", () => {
  const empty: Pick<SessionProfile, "tools" | "resources" | "operations"> = { tools: [], resources: [] };
  assert.equal(sessionProfileHasCalls(undefined), false);
  assert.equal(sessionProfileHasCalls(null), false);
  assert.equal(sessionProfileHasCalls(empty), false);
  assert.equal(sessionProfileHasCalls({ ...empty, operations: [] }), false);
  const native = { ...empty, operations: [{ type: "view" as const, records: 12, firstEvent: message("first", 1, { operation }) }] };
  assert.equal(sessionProfileHasCalls(native), true);
  assert.deepEqual(native.tools, []);
  assert.deepEqual(native.resources, []);
  assert.equal(sessionProfileHasCalls({ ...empty, tools: [{ name: "read", calls: 1, success: 1, failure: 0, unknown: 0, durationMs: 1 }] }), true);
});

test("原生类别、未知结果与卡片说明具备中英文文案，标题原文不参与类别推断", () => {
  const types: SessionOperation["type"][] = ["view", "create", "edit", "list", "replace", "unknown"];
  for (const language of ["en", "zh-CN"] as const) {
    for (const type of types) {
      const key = `sessions.operation.type.${type}`;
      assert.ok(isMessageDescriptorKnown({ key }));
      assert.equal(sessionOperationType(type, language), translate(language, key));
      assert.equal(sessionOperationLabel({ type, label: "Run synthetic command" }, language), translate(language, "sessions.operation.event", { type: translate(language, key) }));
    }
    for (const key of ["sessions.operation.title", "sessions.operation.content", "sessions.operation.resultUnknown", "sessions.operation.helpText", "sessions.timeline.toolsOperations"]) {
      assert.ok(isMessageDescriptorKnown({ key }));
      assert.ok(translate(language, key).length > 0);
    }
  }
  assert.equal(sessionOperationLabel(operation, "en"), "Native operation · View");
  assert.equal(sessionOperationLabel(operation, "zh-CN"), "原生操作 · 查看");
});
