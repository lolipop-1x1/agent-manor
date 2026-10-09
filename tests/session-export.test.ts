import assert from "node:assert/strict";
import test from "node:test";
import type { SessionMessage, SessionMessageResult } from "../src/session-contracts.js";
import { collectDialogue, dialogueMarkdown } from "../web/session-export.js";
import { readSessionFilters, writeSessionFilters } from "../web/session-address.js";

const summary = { id: "synthetic", client: "codex" as const, clientSessionId: "synthetic", title: "合成标题", titleOrigin: "recorded" as const, messageCount: 205, turnCount: 103, models: [], gaps: [] };
const messages: SessionMessage[] = Array.from({ length: 205 }, (_, index) => ({ id: `message-${index}`, sessionId: summary.id, ordinal: index, recordLine: index + 1, turnId: `turn-${Math.floor(index / 2)}`, kind: index % 2 ? "assistant" : "user", text: `完整正文 ${index}`, ...(index % 2 ? { final: "explicit" as const } : {}) }));
const page = (number: number): SessionMessageResult => ({ version: "fixed", session: summary, messages: messages.slice((number - 1) * 200, number * 200), total: messages.length, page: number, pageSize: 200 });

test("导出取齐跨页正文并固定版本，读取失败或重复记录拒绝部分导出", async () => {
  const calls: number[] = [];
  assert.deepEqual(await collectDialogue(async number => { calls.push(number); return page(number); }, "fixed"), messages);
  assert.deepEqual(calls, [1, 2]);
  await assert.rejects(collectDialogue(async number => ({ ...page(number), version: number === 2 ? "changed" : "fixed" }), "fixed"), /SNAPSHOT_CHANGED/);
  await assert.rejects(collectDialogue(async number => { if (number === 2) throw new Error("source unavailable"); return page(number); }, "fixed"), /unavailable/);
  await assert.rejects(collectDialogue(async number => ({ ...page(number), messages: number === 2 ? messages.slice(0, 5) : page(number).messages }), "fixed"), /INCOMPLETE/);
});

test("复制和导出省略过程，保留完整正文和未确认结束状态，不把中间回复当终答", () => {
  const user = { ...messages[0]!, turnId: "turn-a" };
  const reply = { ...messages[1]!, turnId: "turn-a", final: undefined, text: "长正文".repeat(5000) };
  const markdown = dialogueMarkdown([user, { ...reply, id: "intermediate", text: "中间回复" }, { ...reply, id: "tool", kind: "tool_result", text: "工具过程" }, reply], "zh-CN");
  assert.ok(markdown.includes(reply.text)); assert.ok(markdown.includes("未确认结束"));
  assert.ok(!markdown.includes("中间回复")); assert.ok(!markdown.includes("工具过程")); assert.equal(reply.final, undefined);
  const final = dialogueMarkdown([user, { ...reply, final: "explicit" }], "en");
  assert.ok(!final.includes("End not confirmed")); assert.ok(final.includes("AI reply"));
});

test("查找地址无损编码中文、路径和过程筛选，兼容旧定位地址", () => {
  const filters = { client: "codex" as const, project: "/synthetic/a b", from: "2026-01-01", to: "2026-02-01", q: "缓存 & 输出", process: true, subagents: true, execution: "quiet" as const };
  const params = new URLSearchParams({ id: "session-a", message: "message-a", page: "3" });
  writeSessionFilters(params, filters);
  assert.deepEqual(readSessionFilters(`#sessions?${params}`), filters);
  assert.equal(params.get("message"), "message-a");
  assert.equal(readSessionFilters("#sessions?id=session-a&turn=35").execution, "regular");
  assert.equal(readSessionFilters("#sessions?client=invalid&execution=invalid").client, "all");
  assert.equal(readSessionFilters("#sessions?from=2026-02-30&to=2026-99-99").from, "");
});

test("代码复制从完整 Markdown 取正文，预览截止不会截断长代码或带入后文", async () => {
  const { completeCodeBlocks } = await import("../web/session-code.js");
  const code = "const value = 1;\n".repeat(1000);
  const source = `开头\n\n\`\`\`ts\n${code}\`\`\`\n后面的说明`;
  assert.equal(completeCodeBlocks(source).get(source.indexOf("```")), code);
  assert.equal(completeCodeBlocks("~~~~txt\n内容\n~~~~~~\n其他").get(0), "内容\n");
  assert.equal(completeCodeBlocks("    first\n    second\n\n后文").get(0), "first\nsecond\n");
  assert.equal(completeCodeBlocks(`> \`\`\`ts\n${code.split("\n").slice(0, -1).map(line => `> ${line}`).join("\n")}\n> \`\`\`\n后文`).get(2), code);
  assert.equal(completeCodeBlocks("- 示例\n\n  ```ts\n  const value = 1;\n  ```\n后文").get(8), "const value = 1;\n");
});
