import assert from "node:assert/strict";
import test from "node:test";
import type { Baseline, HistoryEvent, ParsedSource } from "../src/contracts.js";
import { associateSource, historicalWorktrees, resolveSharedHistory } from "../src/history/index.js";
import { hashContent, matchEvent } from "../src/analysis/index.js";

function event(id = "synthetic-event", extra: Partial<HistoryEvent> = {}): HistoryEvent {
  return { id, client: "codex", sessionId: "synthetic-session", occurredAt: "2026-01-01T00:00:00Z", tool: "read", kind: "read", status: "success",
    cwd: "/workspace/project", path: "src/a.ts", fragments: [{ content: "const value = 1;\n", kind: "read", path: "src/a.ts", completeLines: true }],
    sources: [{ sourceId: "codex:synthetic-source", path: "/workspace/history/synthetic.jsonl", recordLine: 1, hash: "synthetic" }],
    input: { request: { paths: ["src/a.ts"] } }, output: { result: { text: "完整的合成工具结果" } },
    reasonDescriptor: { key: "synthetic.reason", params: { path: "src/a.ts" } }, ...extra };
}
function source(events: HistoryEvent[], id = "synthetic-source"): ParsedSource {
  return { client: "codex", format: "codex-jsonl", sourceId: `codex:${id}`, path: `/workspace/history/${id}.jsonl`, hash: "synthetic",
    sessionId: "synthetic-session", cwd: "/workspace/project", events, gaps: [], completeBytes: 0 };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test("共享历史保留只读大正文引用，事件与可变片段、来源和诊断元数据独立", async () => {
  const input = freeze(source([event("large", { input: { arguments: "a".repeat(1024 * 1024) }, output: { result: "b".repeat(1024 * 1024) } })]));
  const before = JSON.stringify(input);
  const original = input.events[0]!;
  const merged = resolveSharedHistory([input]).events[0]!;
  assert.notEqual(merged, original);
  assert.equal(merged.input, original.input, "只读工具参数不能在共享历史归并时再次深复制");
  assert.equal(merged.output, original.output, "只读工具结果不能在共享历史归并时再次深复制");
  assert.notEqual(merged.fragments, original.fragments);
  assert.notEqual(merged.fragments[0], original.fragments[0]);
  assert.notEqual(merged.sources, original.sources);
  assert.notEqual(merged.sources[0], original.sources[0]);
  assert.notEqual(merged.reasonDescriptor, original.reasonDescriptor);
  assert.notEqual(merged.reasonDescriptor!.params, original.reasonDescriptor!.params);
  const repository = { id: "synthetic-repository", name: "synthetic", path: "/workspace/project", commonDir: "/workspace/project/.git", stale: false };
  const file = { path: "src/a.ts", category: "source" as const, content: "const value = 1;\n", lineCount: 1, hash: hashContent("const value = 1;\n") };
  const baseline: Baseline = { repository, hash: "synthetic", createdAt: "2026-01-01T00:00:00Z", git: { dirty: false }, files: [file], excluded: [] };
  assert.deepEqual(await historicalWorktrees([merged], baseline), []);
  const associated = await associateSource({ ...input, events: [merged] }, baseline);
  assert.equal(associated.events.length, 1);
  assert.equal(matchEvent(associated.events[0]!, file).exactRanges.length, 1);
  merged.status = "failure";
  merged.fragments[0]!.path = "src/changed.ts";
  merged.sources[0]!.path = "/workspace/history/changed.jsonl";
  merged.reasonDescriptor!.params!.path = "src/changed.ts";
  assert.equal(JSON.stringify(input), before, "归并与后续元数据操作不能改写原始来源");
});

test("未知结果升级时保留完整正文，复制新增来源与片段容器，不改写两个原始来源", () => {
  const pending = source([event("same-call", { status: "unknown", fragments: [], output: undefined })], "pending");
  const finished = source([event("same-call", { sources: [{ sourceId: "codex:finished", path: "/workspace/history/finished.jsonl", recordLine: 2, hash: "finished" }] })], "finished");
  const before = JSON.stringify([pending, finished]);
  freeze(pending); freeze(finished);
  const result = resolveSharedHistory([pending, finished]);
  assert.equal(result.events.length, 1);
  const merged = result.events[0]!;
  assert.equal(merged.status, "success");
  assert.equal(merged.output, finished.events[0]!.output);
  assert.equal(merged.fragments[0]!.content, finished.events[0]!.fragments[0]!.content);
  assert.equal(merged.sources.length, 2);
  assert.notEqual(merged.fragments[0], finished.events[0]!.fragments[0]);
  assert.notEqual(merged.sources[1], finished.events[0]!.sources[0]);
  assert.notEqual(merged.reasonDescriptor!.params, finished.events[0]!.reasonDescriptor!.params);
  merged.fragments[0]!.historicalStart = 5;
  merged.sources[1]!.recordLine = 99;
  merged.reasonDescriptor!.params!.path = "src/changed.ts";
  assert.equal(JSON.stringify([pending, finished]), before);
});

test("来源去重、成功失败冲突与真实重复调用继续按事件身份处理", () => {
  const successful = source([event("conflict")], "success");
  const failed = source([event("conflict", { status: "failure" })], "failure");
  const repeated = source([event("independent")], "repeated");
  const before = JSON.stringify([successful, failed, repeated]);
  freeze(successful); freeze(failed); freeze(repeated);
  const result = resolveSharedHistory([successful, successful, failed, repeated]);
  assert.equal(result.events.length, 2, "相同工具正文不合并独立调用身份");
  const conflict = result.events.find(item => item.id === "conflict")!;
  assert.equal(conflict.status, "unknown");
  assert.deepEqual(conflict.fragments, []);
  assert.equal(conflict.sources.length, 1, "相同来源证明不重复附加");
  assert.ok(result.gaps.some(gap => gap.kind === "ambiguous"));
  assert.equal(result.events.find(item => item.id === "independent")!.status, "success");
  assert.equal(JSON.stringify([successful, failed, repeated]), before);
});
