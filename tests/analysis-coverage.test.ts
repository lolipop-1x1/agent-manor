import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisSnapshot, BaselineFile, HistoryEvent, Mapping } from "../src/contracts.js";
import {
  buildCoverage, countRangeLines, eventFilePaths, filterEvents, getHotspots, getUnreadFiles, hashContent,
  MATCHING_RULE_VERSION, mergeRanges, subtractRanges,
} from "../src/analysis/index.js";
import { filterHistoricalEvents } from "../src/analysis/coverage.js";

function fixture(): AnalysisSnapshot {
  const files: BaselineFile[] = [
    { path: "src/main.ts", category: "source", content: "a\nb\nc\nd\ne\n", lineCount: 5, hash: "main" },
    { path: "src/unread.ts", category: "source", content: "a\nb\n", lineCount: 2, hash: "unread" },
    { path: "config.json", category: "config", content: "{}\n", lineCount: 1, hash: "config" },
    { path: "README.md", category: "docs", content: "说明\n", lineCount: 1, hash: "docs" },
  ];
  const activity = (id: string, client: "codex" | "claude", kind: HistoryEvent["kind"], status: HistoryEvent["status"] = "success", path = "src/main.ts"): HistoryEvent => ({
    id, client, kind, status, path, tool: "fixture", sessionId: "session", fragments: [],
    sources: [{ sourceId: "source", path: "/tmp/source.jsonl", recordLine: 1, hash: hashContent(id) }],
    occurredAt: client === "codex" ? "2026-10-01T00:00:00Z" : "2026-10-02T00:00:00Z",
  });
  const events = [
    activity("read-exact", "codex", "read"), activity("read-near", "claude", "read"),
    activity("edit", "codex", "edit"), activity("search", "codex", "search"),
    activity("failed-search", "codex", "search", "failure"), activity("unknown-read", "claude", "read", "unknown"),
    activity("unknown-range", "codex", "read", "success", "src/unread.ts"),
    activity("config", "codex", "read", "success", "config.json"),
  ];
  // 重复来源呈现、多个片段与多份 Mapping 都不能增加同一次活动的次数。
  events.push({ ...events[0]!, sources: [...events[0]!.sources, { ...events[0]!.sources[0]!, recordLine: 2 }] });
  const mapping = (eventId: string, kind: "read" | "edit", exactRanges: Mapping["exactRanges"], nearRanges: Mapping["nearRanges"], filePath = "src/main.ts"): Mapping => ({
    eventId, kind, exactRanges, nearRanges, filePath, ruleVersion: MATCHING_RULE_VERSION,
  });
  const mappings = [
    mapping("read-exact", "read", [{ start: 1, end: 2 }], []),
    mapping("read-exact", "read", [{ start: 2, end: 3 }], []),
    mapping("read-near", "read", [], [{ start: 2, end: 4 }]),
    mapping("edit", "edit", [{ start: 4, end: 5 }], [{ start: 3, end: 4 }]),
    { ...mapping("unknown-range", "read", [], [], "src/unread.ts"), unknownReason: "range_unknown: 缺少源码" },
    mapping("config", "read", [{ start: 1, end: 1 }], [], "config.json"),
  ];
  const repository = { id: "repo", path: "/tmp/repository", commonDir: "/tmp/repository/.git", name: "repository", stale: false };
  return { repository, version: "version-1", createdAt: "2026-10-03T00:00:00Z", previousVersion: "version-0",
    baseline: { repository, hash: "baseline", createdAt: "2026-10-03T00:00:00Z", git: { dirty: true }, files, excluded: [] },
    events, mappings, sources: [], gaps: [] };
}

test("范围并集去重，一基闭区间且近似排除精确", () => {
  assert.deepEqual(mergeRanges([{ start: 4, end: 6 }, { start: 1, end: 2 }, { start: 2, end: 3 }], 5), [{ start: 1, end: 5 }]);
  assert.deepEqual(subtractRanges([{ start: 1, end: 7 }], [{ start: 2, end: 3 }, { start: 5, end: 5 }]), [
    { start: 1, end: 1 }, { start: 4, end: 4 }, { start: 6, end: 7 },
  ]);
  assert.equal(countRangeLines([{ start: 1, end: 3 }, { start: 2, end: 5 }]), 5);
});

test("默认源码分母可核对，重复事件来源和重叠片段只增加一次活动", () => {
  const result = buildCoverage(fixture());
  assert.equal(result.version, "version-1");
  assert.equal(result.previousVersion, "version-0");
  assert.equal(result.baselineHash, "baseline");
  assert.equal(result.summary.fileCount, 2);
  assert.equal(result.summary.lineCount, 7);
  assert.deepEqual(result.summary.readExact, { files: 1, lines: 3 });
  assert.deepEqual(result.summary.readNear, { files: 1, lines: 1 });
  const main = result.files.find((file) => file.path === "src/main.ts")!;
  assert.equal(main.activityCount, 6);
  assert.equal(main.readCount, 2);
  assert.equal(main.editCount, 1);
  assert.equal(main.searchCount, 2);
  assert.equal(main.failedCount, 1);
  assert.equal(main.unknownCount, 1);
  assert.deepEqual(main.readNearRanges, [{ start: 4, end: 4 }]);
  assert.deepEqual(main.editNearRanges, [{ start: 3, end: 3 }]);
  assert.equal(getHotspots(result, "activity")[0]?.activityCount, 6);
  assert.equal(result.gaps[0]?.kind, "range_unknown");
  assert.deepEqual(getUnreadFiles(result), []);
});

test("客户端和时间筛选在范围并集前，保留实际当前行号", () => {
  const snapshot = fixture();
  const claude = buildCoverage(snapshot, { client: "claude" });
  assert.deepEqual(claude.summary.readExact, { files: 0, lines: 0 });
  assert.deepEqual(claude.summary.readNear, { files: 1, lines: 3 });
  assert.deepEqual(claude.files[0]?.readNearRanges, [{ start: 2, end: 4 }]);
  assert.equal(claude.files[0]?.activityCount, 2);
  const codex = buildCoverage(snapshot, { from: "2026-10-01T00:00:00Z", to: "2026-10-01T00:00:00Z" });
  assert.equal(codex.files[0]?.readNearLines, 0);
  assert.equal(codex.files[0]?.readExactLines, 3);
  const missingTime = { ...snapshot.events[0]!, id: "missing-time", occurredAt: undefined };
  snapshot.events.push(missingTime);
  assert.equal(filterEvents(snapshot, { from: "2026-10-01T00:00:00Z" }).some((event) => event.id === "missing-time"), false);
});

test("目录和类别筛选改变分母，未知范围成功读取不称为未观察读取", () => {
  const snapshot = fixture();
  const config = buildCoverage(snapshot, { categories: ["config", "docs"] });
  assert.equal(config.summary.fileCount, 2);
  assert.equal(config.summary.lineCount, 2);
  assert.equal(config.files.find((file) => file.path === "config.json")?.readCount, 1);
  assert.deepEqual(getUnreadFiles(config).map((file) => file.path), ["README.md"]);
  const unknownRange = buildCoverage(snapshot, { directory: "src/unread.ts" });
  assert.equal(unknownRange.summary.fileCount, 1);
  assert.equal(unknownRange.summary.readExact.files, 0);
  assert.equal(unknownRange.files[0]?.readCount, 1);
  assert.equal(unknownRange.files[0]?.unknownCount, 1);
  assert.deepEqual(getUnreadFiles(unknownRange), []);
});

test("事件路径仅可归属已登记根目录，相对路径依赖cwd，拒绝逃逸", () => {
  const snapshot = fixture();
  const activity = snapshot.events[0]!;
  assert.deepEqual(eventFilePaths({ ...activity, cwd: "/tmp/repository/src", path: "main.ts" }, snapshot.repository), ["src/main.ts"]);
  assert.deepEqual(eventFilePaths({ ...activity, path: "/tmp/repository/src/main.ts" }, snapshot.repository), ["src/main.ts"]);
  assert.deepEqual(eventFilePaths({ ...activity, cwd: "/tmp/other-clone", path: "src/main.ts" }, snapshot.repository), []);
  assert.deepEqual(eventFilePaths({ ...activity, path: "../escape.ts" }, snapshot.repository), []);
});

test("失败与未配对结果即使有伪造映射也不覆盖当前行", () => {
  const snapshot = fixture();
  snapshot.events = snapshot.events.filter((event) => event.status !== "success");
  snapshot.mappings = snapshot.events.map((event) => ({ eventId: event.id, filePath: "src/main.ts", kind: "read", ruleVersion: MATCHING_RULE_VERSION,
    exactRanges: [{ start: 1, end: 5 }], nearRanges: [] }));
  const result = buildCoverage(snapshot);
  assert.equal(result.summary.readExact.lines, 0);
  assert.equal(result.files[0]?.activityCount, 2);
  assert.equal(result.files[0]?.readCount, 0);
  assert.deepEqual(getUnreadFiles(result).map((file) => file.path), ["src/main.ts", "src/unread.ts"]);
});

test("历史查询保留已删文件和目录／无路径搜索，类别与目录筛选不制造当前覆盖", () => {
  const snapshot = fixture();
  const common = { ...snapshot.events[0]!, fragments: [], cwd: snapshot.repository.path };
  snapshot.events = [
    { ...common, id: "deleted", kind: "edit", path: "deleted.ts" },
    { ...common, id: "directory-search", kind: "search", path: "src" },
    { ...common, id: "pathless-search", kind: "search", path: undefined, cwd: "/tmp/repository/src" },
  ];
  snapshot.mappings = [];
  const all = { categories: ["source", "config", "docs", "unknown"] as const };
  assert.deepEqual(filterHistoricalEvents(snapshot, { categories: [...all.categories] }).map(event => event.id), ["deleted", "directory-search", "pathless-search"]);
  assert.deepEqual(filterHistoricalEvents(snapshot).map(event => event.id), ["deleted", "directory-search"]);
  assert.deepEqual(filterHistoricalEvents(snapshot, { categories: ["unknown"], directory: "src" }).map(event => event.id), ["pathless-search"]);
  assert.deepEqual(filterHistoricalEvents(snapshot, { categories: ["unknown"], directory: "docs" }), []);
  snapshot.events.push({ ...common, id: "deleted-doc", kind: "edit", path: "docs/deleted.md" });
  assert.deepEqual(filterHistoricalEvents(snapshot, { categories: ["docs"] }).map(event => event.id), ["deleted-doc"]);
  const coverage = buildCoverage(snapshot, { categories: [...all.categories] });
  assert.equal(coverage.summary.fileCount, 4);
  assert.equal(coverage.summary.lineCount, 9);
  assert.equal(coverage.summary.readExact.lines, 0);
  assert.equal(coverage.summary.editExact.lines, 0);
  assert.ok(coverage.files.every(file => file.activityCount === 0));
});
