import assert from "node:assert/strict";
import test from "node:test";
import type { KnowledgeConversation, KnowledgeInputMessage } from "../src/knowledge-contracts.js";
import { boundedKnowledgeText, projectKnowledgeConversation } from "../src/knowledge/input.js";

function message(id: string, kind: KnowledgeInputMessage["kind"], text: string): KnowledgeInputMessage {
  return { id, sessionId: "synthetic-session", ordinal: Number(id.slice(1)) || 1, recordLine: 1, turnId: "turn-1", turnPosition: 1, kind, text, hash: `original-${id}`, target: true };
}
function conversation(messages: KnowledgeInputMessage[]): KnowledgeConversation {
  return { session: { id: "synthetic-session", client: "codex", clientSessionId: "synthetic", title: "Synthetic evidence", messageCount: messages.length, models: [], gaps: [] }, version: "v1", branch: "current", messages, limitations: [] };
}

test("输入节流保留连续对话，工具正文和重复指令有界且原始身份不变", () => {
  const user = "需要同时考虑前面的要求。".repeat(2000), assistant = "这是尚未验证的排查过程。".repeat(2000);
  const log = `${"ordinary build output\n".repeat(20_000)}Error: permission denied\nTests failed: expected current value\n${"ordinary output\n".repeat(20_000)}`;
  const records = [message("m1", "user", user), message("m2", "tool_result", log), message("m3", "assistant", assistant), message("m4", "system", "Repeated instruction\n".repeat(5000)), message("m5", "tool_result", log)];
  const result = projectKnowledgeConversation(conversation(records));
  assert.equal(result.messages[0]!.text, user); assert.equal(result.messages[2]!.text, assistant);
  assert.ok(result.messages[1]!.text.length < 4096); assert.match(result.messages[1]!.text, /permission denied/); assert.match(result.messages[1]!.text, /Tests failed/); assert.match(result.messages[1]!.text, /body omitted/);
  assert.ok(result.messages[3]!.text.length < 1024); assert.match(result.messages[4]!.text, /same content as message m2/);
  assert.deepEqual(result.messages.map(item => item.hash), records.map(item => item.hash)); assert.equal(records[1]!.text, log);
  assert.ok(result.limitationDetails?.some(detail => detail.messageDescriptor?.key === "knowledge.limitation.inputSummarized"));
});

test("有界工具视图不把失败或未验证改成成功，保留尾部与位置索引", () => {
  const text = `command started\n${"running\n".repeat(10_000)}\nVerification was not performed.\nExit code: 1\n`;
  const projected = boundedKnowledgeText(text, 1536);
  assert.match(projected, /not performed/); assert.match(projected, /Exit code: 1/); assert.match(projected, /offset/); assert.ok(projected.length < 1536);
});
