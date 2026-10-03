import assert from "node:assert/strict";
import test from "node:test";
import type { BaselineFile, EvidenceFragment, HistoryEvent } from "../src/contracts.js";
import { characterDifference, hashContent, mappingCacheKey, MATCHING_RULE_VERSION, matchEvent, textLines } from "../src/analysis/index.js";

function file(content: string, path = "main.ts"): BaselineFile {
  return { path, content, hash: hashContent(content), lineCount: textLines(content).length, category: "source" };
}

function event(fragments: EvidenceFragment[], kind: "read" | "edit" = "read"): HistoryEvent {
  return { id: "fixture", client: "codex", sessionId: "session", tool: kind === "read" ? "Read" : "Edit",
    kind, status: "success", path: "main.ts", fragments, sources: [] };
}

function fragment(content: string, kind: EvidenceFragment["kind"] = "read", historicalStart?: number): EvidenceFragment {
  return { content, kind, historicalStart, completeLines: true };
}

test("插入行使行号漂移，未改动内容仍精确且不沿用历史行号", () => {
  const result = matchEvent(event([fragment("const existingValue = true;\n", "read", 100)]), file("// 新插入\nconst existingValue = true;\n"));
  assert.deepEqual(result.exactRanges, [{ start: 2, end: 2 }]);
  assert.deepEqual(result.nearRanges, []);
  assert.equal(result.ruleVersion, MATCHING_RULE_VERSION);
});

test("行分隔符不属于行内容，空行保留且不 trim 内容空白", () => {
  const old = "const knownUniqueLongValue = true;\r\n\r\n";
  const current = "const knownUniqueLongValue = true;\n\n";
  assert.deepEqual(matchEvent(event([fragment(old)]), file(current)).exactRanges, [{ start: 1, end: 2 }]);
  assert.deepEqual(matchEvent(event([fragment(current.replace(/\n+$/, ""))]), file(current)).exactRanges, [{ start: 1, end: 1 }]);
  const spaced = old.replace("true;", "true; ");
  const changed = matchEvent(event([fragment(spaced)]), file(current));
  assert.equal(changed.exactRanges.some((range) => range.start <= 1 && range.end >= 1), false);
});

test("读取块内部插入行，只有历史原有行归精确", () => {
  const old = "const firstAnchor = true;\nconst middleValue = true;\nconst lastAnchor = true;\n";
  const current = "const firstAnchor = true;\nconst insertedValue = true;\nconst middleValue = true;\nconst lastAnchor = true;\n";
  const result = matchEvent(event([fragment(old)]), file(current));
  assert.deepEqual(result.exactRanges, [{ start: 1, end: 1 }, { start: 3, end: 4 }]);
  assert.deepEqual(result.nearRanges, []);
});

test("单字符变化按局部行归近似，未变上下文保持精确", () => {
  const old = "const firstAnchor = true;\nconst value = 1;\nconst lastAnchor = true;\n";
  const current = old.replace("value = 1", "value = 2");
  const result = matchEvent(event([fragment(old)]), file(current));
  assert.deepEqual(result.exactRanges, [{ start: 1, end: 1 }, { start: 3, end: 3 }]);
  assert.deepEqual(result.nearRanges, [{ start: 2, end: 2 }]);
});

test("长行唯一不变字符上下文支持独立单字符变化", () => {
  const old = "const previouslyRecordedValue = 1;";
  const result = matchEvent(event([fragment(old)]), file(old.replace("= 1", "= 2")));
  assert.deepEqual(result.exactRanges, []);
  assert.deepEqual(result.nearRanges, [{ start: 1, end: 1 }]);
});

test("重复内容无法凭历史行号消歧", () => {
  const repeated = "const repeatedValue = 1;\n";
  const result = matchEvent(event([fragment(repeated, "read", 2)]), file(`${repeated}// 中间\n${repeated}`));
  assert.deepEqual(result.exactRanges, []);
  assert.deepEqual(result.nearRanges, []);
  assert.match(result.unknownReason!, /^ambiguous:/);
});

test("短片段需要唯一上下文，补丁上下文不计入编辑覆盖", () => {
  const current = "const beforeAnchor = true;\nx=2;\nconst afterAnchor = true;\n";
  const unsupported = matchEvent(event([fragment("x=2;")]), file(current));
  assert.match(unsupported.unknownReason!, /^range_unknown:/);
  const supported = matchEvent(event([
    fragment("const beforeAnchor = true;", "context", 1),
    fragment("x=1;", "added", 2),
    fragment("const afterAnchor = true;", "context", 3),
  ], "edit"), file(current));
  assert.deepEqual(supported.exactRanges, []);
  assert.deepEqual(supported.nearRanges, [{ start: 2, end: 2 }]);
});

test("唯一上下文可消除短片段重复，其他位置仍不覆盖", () => {
  const current = "x=1;\nconst beforeAnchor = true;\nx=1;\nconst afterAnchor = true;\n";
  const result = matchEvent(event([
    fragment("const beforeAnchor = true;", "context", 10),
    fragment("x=1;", "added", 11),
    fragment("const afterAnchor = true;", "context", 12),
  ], "edit"), file(current));
  assert.deepEqual(result.exactRanges, [{ start: 3, end: 3 }]);
});

test("新增重复行不靠 diff 任意选择旧行位置", () => {
  const old = "const beforeAnchor = true;\n}\nconst afterAnchor = true;\n";
  const current = "const beforeAnchor = true;\n}\n}\nconst afterAnchor = true;\n";
  const result = matchEvent(event([fragment(old)]), file(current));
  assert.deepEqual(result.exactRanges, [{ start: 1, end: 1 }, { start: 4, end: 4 }]);
  assert.match(result.unknownReason!, /^range_unknown:/);
});

test("纯删除不映射邻接当前行，撤销编辑仍对应恢复的改变行", () => {
  const deleted = matchEvent(event([
    fragment("const beforeAnchor = true;", "context", 1),
    fragment("const oldValue = true;", "deleted", 2),
    fragment("const afterAnchor = true;", "context", 3),
  ], "edit"), file("const beforeAnchor = true;\nconst afterAnchor = true;\n"));
  assert.deepEqual(deleted.exactRanges, []);
  assert.deepEqual(deleted.nearRanges, []);
  assert.match(deleted.unknownReason!, /删除行/);
  const restored = matchEvent(event([
    fragment("const restoredValue = 1;", "deleted"),
    fragment("const restoredValue = 2;", "added"),
  ], "edit"), file("const restoredValue = 1;\n"));
  assert.deepEqual(restored.exactRanges, [{ start: 1, end: 1 }]);
  assert.deepEqual(restored.nearRanges, []);
});

test("缺内容、失败、不完整行保持未知，多文件片段不串入另一个文件", () => {
  const current = file("const existingValue = true;\n");
  assert.match(matchEvent(event([]), current).unknownReason!, /^range_unknown:/);
  const failed = { ...event([fragment(current.content)]), status: "failure" as const };
  assert.deepEqual(matchEvent(failed, current).exactRanges, []);
  const partial = { ...fragment(current.content), completeLines: false };
  assert.deepEqual(matchEvent(event([partial]), current).exactRanges, []);
  const multi = event([{ ...fragment(current.content, "added"), path: "main.ts" },
    { ...fragment("const otherValue = true;", "added"), path: "other.ts" }], "edit");
  assert.deepEqual(matchEvent(multi, file("const existingValue = true;\n", "other.ts")).exactRanges, []);
});

test("Unicode 码点替换计2，局部差异不被整块长上下文稀释", () => {
  assert.equal(characterDifference("😀", "😎")?.difference, 2);
  assert.equal(characterDifference("a😀b", "a😀xb")?.difference, 1);
  const old = "const firstAnchor = true;\nconst changedValue = 'small';\nconst lastAnchor = true;\n";
  const current = old.replace("const changedValue = 'small';", "completelyDifferentLongStatement();");
  const result = matchEvent(event([fragment(old)]), file(current));
  assert.deepEqual(result.exactRanges, [{ start: 1, end: 1 }, { start: 3, end: 3 }]);
  assert.deepEqual(result.nearRanges, []);
  assert.match(result.unknownReason!, /^range_unknown:/);
});

test("近似计算预算显式返回未知，缓存随内容和规则关联字段失效", () => {
  const old = `const firstAnchor = true;\n${"x".repeat(200_001)}\nconst lastAnchor = true;`;
  const result = matchEvent(event([fragment(old)]), file(old.replace("x", "y")));
  assert.match(result.unknownReason!, /^budget_exceeded:/);
  const current = file("const existingValue = true;\n");
  const activity = event([fragment(current.content)]);
  assert.equal(mappingCacheKey(activity, current), mappingCacheKey(activity, current));
  assert.notEqual(mappingCacheKey(activity, current), mappingCacheKey(activity, file("const existingValue = false;\n")));
  assert.notEqual(mappingCacheKey(activity, current), mappingCacheKey({ ...activity, status: "failure" }, current));
});
