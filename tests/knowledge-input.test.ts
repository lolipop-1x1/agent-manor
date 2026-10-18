import test from "node:test";
import assert from "node:assert/strict";
import { projectKnowledgeMessage } from "../src/knowledge/input.js";
import type { KnowledgeInputMessage } from "../src/knowledge-contracts.js";

const message = (text: string, kind: KnowledgeInputMessage["kind"] = "tool_result"): KnowledgeInputMessage => ({ id: "synthetic-message", sessionId: "synthetic-session", ordinal: 1, recordLine: 1, turnId: "synthetic-turn", turnPosition: 1, kind, text, hash: "original-source-hash", target: true, callId: "synthetic-call", tool: "Test", status: "failure" });

test("抽取展开文本内容块并移除图片载荷，保留错误、工具身份与原始哈希", () => {
  const encoded = "a".repeat(2_000_000);
  const raw = message(JSON.stringify([{ type: "input_text", text: 'Exit code: 1\nAssertion failed: "cache" should refresh.\n修复需要回读配置。' }, { type: "input_image", image_url: `data:image/png;base64,${encoded}` }, { type: "text", text: "Do not claim verification succeeded." }]));
  const result = projectKnowledgeMessage(raw);
  assert.ok(result.text.includes('Assertion failed: "cache"')); assert.ok(result.text.includes("修复需要回读配置")); assert.ok(result.text.includes("Do not claim verification succeeded."));
  assert.equal(result.text.includes(encoded), false); assert.equal(result.omittedMedia, 1); assert.equal(result.hash, raw.hash); assert.equal(result.callId, raw.callId); assert.equal(result.status, "failure"); assert.equal(raw.text.includes(encoded), true);
});

test("原生MCP媒体内容只留下类型说明，不将二进制数据当文字或伪造图像内容", () => {
  const encoded = "b".repeat(10_000);
  const result = projectKnowledgeMessage(message(JSON.stringify([{ type: "text", text: "Screenshot captured; visual correctness is unknown." }, { type: "image", mimeType: "image/png", data: encoded }])));
  assert.ok(result.text.includes("visual correctness is unknown")); assert.equal(result.text.includes(encoded), false); assert.equal(result.omittedMedia, 1);
  assert.ok(result.text.includes("image"));
});

test("只清理明确媒体载荷，普通长文本、代码、JSON业务字段和非媒体编码保持原文", () => {
  const plain = '\\"\n中文🙂'.repeat(12_000);
  assert.equal(projectKnowledgeMessage(message(plain)).text, plain);
  const json = JSON.stringify({ error: "permission denied", token: "c".repeat(12_000), output: "Tests failed", file: "/synthetic/a.ts" });
  assert.equal(projectKnowledgeMessage(message(json)).text, json);
  const user = '[{"type":"text","text":"This is a JSON example"}]'; assert.equal(projectKnowledgeMessage(message(user, "user")).text, user);
});

test("嵌在工具JSON里的data URL不泄漏进抽取文本，文本字段和Unicode仍保留", () => {
  const result = projectKnowledgeMessage(message(JSON.stringify({ output: "Failed: 错误", image: "data:image/png;base64," + "d".repeat(10_000) })));
  assert.equal(result.omittedMedia, 1); assert.ok(result.text.includes("Failed: 错误")); assert.equal(result.text.includes("d".repeat(10_000)), false); assert.doesNotThrow(() => JSON.parse(result.text));
});


test("嵌套MCP内容保留状态和正文，只移除结构明确的媒体数据", () => {
  const raw = JSON.stringify({ isError: true, content: [{ type: "text", text: "Visual verification was not performed." }, { type: "image", mimeType: "image/png", data: "e".repeat(100_000) }] });
  const projected = projectKnowledgeMessage(message(raw)); const value = JSON.parse(projected.text);
  assert.equal(value.isError, true); assert.equal(value.content[0].text, "Visual verification was not performed."); assert.equal(projected.omittedMedia, 1); assert.equal(projected.text.includes("e".repeat(100_000)), false);
  const encodedText = "data:text/plain;base64,SGVsbG8="; assert.equal(projectKnowledgeMessage(message(encodedText, "user")).text, encodedText);
});
