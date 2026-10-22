import assert from "node:assert/strict";
import test from "node:test";
import type { HistoryEvent } from "../src/contracts.js";
import { associationMetadata, resolveSharedHistory, type ParsedHistorySource } from "../src/history/index.js";
import { RefreshPayloads } from "../src/index/refresh-payloads.js";

const event = (extra: Partial<HistoryEvent> = {}): HistoryEvent => ({ id: "synthetic-event", client: "codex", sessionId: "synthetic-session",
  tool: "read", kind: "read", status: "success", fragments: [{ kind: "read", content: "alpha\n", completeLines: true }],
  sources: [{ sourceId: "synthetic-source", path: "/workspace/history/source.jsonl", recordLine: 1, hash: "synthetic" }],
  input: { body: "a".repeat(8192) }, output: { body: "b".repeat(8192) }, ...extra });
const source = (events: HistoryEvent[], extra: Partial<ParsedHistorySource> = {}): ParsedHistorySource => ({ sourceId: "synthetic-source", client: "codex",
  format: "codex-jsonl", sessionId: "synthetic-session", path: "/workspace/history/source.jsonl", hash: "synthetic", events, gaps: [], completeBytes: 0,
  relationships: [], ...extra });

test("临时正文经归并和投影后逐项恢复，未知升级与冲突不换错工具结果", () => {
  const inputs = [source([event({ status: "unknown", output: undefined, fragments: [] })]), source([event()]),
    source([event({ id: "conflict" })]), source([event({ id: "conflict", status: "failure", output: { body: "failure".repeat(8192) } })])];
  const expected = JSON.parse(JSON.stringify(resolveSharedHistory(inputs)));
  const payloads = new RefreshPayloads();
  try {
    const retained = inputs.map(value => payloads.retain(structuredClone(value)));
    assert.deepEqual(JSON.parse(JSON.stringify(resolveSharedHistory(retained))), expected);
    assert.equal(retained[1]!.events[0]!.fragments[0]!.content, "alpha\n", "映射所需片段不能截断");
    assert.ok(!("body" in retained[1]!.events[0]!.output as object), "大正文不继续驻留投影中");
  } finally { payloads.close(); }
});

test("大正文暂存后保留 worktree 与客户端子会话证明，发布仍编码完整输入输出", () => {
  const examples = [source([event({ tool: "CommandExecution", input: { command: ["sh", "-lc", "git worktree list --porcelain"], padding: "a".repeat(8192) },
    output: { formatted_output: "worktree /workspace/project\n", padding: "b".repeat(8192) } })]),
  source([event({ client: "codeflicker", tool: "Agent", output: { agentId: "synthetic-child", body: "b".repeat(8192) } })], { client: "codeflicker", format: "codeflicker-jsonl" })];
  const payloads = new RefreshPayloads();
  try {
    for (const original of examples) {
      const expected = associationMetadata(original);
      const retained = payloads.retain(structuredClone(original));
      if (original.events[0]!.tool === "CommandExecution") {
        assert.deepEqual((retained.events[0]!.input as { command: unknown }).command, (expected.events[0]!.input as { command: unknown }).command);
        assert.equal((retained.events[0]!.output as { formatted_output: string }).formatted_output, "worktree /workspace/project\n");
        assert.ok(!("padding" in retained.events[0]!.input as object) && !("padding" in retained.events[0]!.output as object));
      } else assert.deepEqual(associationMetadata(retained), expected);
      assert.deepEqual(JSON.parse(JSON.stringify(retained)), original, "持久结果不能包含临时投影或丢失原始字段");
    }
  } finally { payloads.close(); }
});
