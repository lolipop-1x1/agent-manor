import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisSnapshot, HistoryEvent, Repository } from "../src/contracts.js";
import { StoreError, type AnalysisStore } from "../src/index/store.js";
import type { OverviewRange, OverviewSource } from "../src/overview-contracts.js";
import { buildOverviewRepositories } from "../src/overview/repositories.js";

const repository: Repository = { id: "synthetic-repo", path: "/synthetic/project", commonDir: "/synthetic/project/.git", name: "Synthetic", version: "synthetic-version", stale: false };
const event = (id: string, occurredAt: string, client: "codex" | "claude" = "codex"): HistoryEvent => ({ id, occurredAt, client,
  sessionId: client === "codex" ? "synthetic-session" : "synthetic-other-session", tool: "read", kind: "read", status: "success",
  cwd: repository.path, path: "src/a.ts", fragments: [], sources: [] });
const snapshot: AnalysisSnapshot = { repository, version: "synthetic-version", createdAt: "2026-10-12T00:00:00Z", sources: [], gaps: [], mappings: [],
  baseline: { repository, hash: "synthetic-baseline", createdAt: "2026-10-12T00:00:00Z", git: { dirty: false }, excluded: [],
    files: [{ path: "src/a.ts", category: "source", lineCount: 3, hash: "synthetic-file", content: "a\nb\nc\n" }] },
  events: [event("previous", "2026-10-10T15:59:59Z"), event("current", "2026-10-10T16:00:00Z"),
    event("today", "2026-10-11T16:00:00Z"), event("other", "2026-10-11T01:00:00Z", "claude")] };
const source: OverviewSource = { version: "synthetic-index", events: [], requests: [], resources: [], gaps: [], sessions: [
  { id: "synthetic-normalized-session", client: "codex", clientSessionId: "synthetic-session", title: "Synthetic", titleOrigin: "recorded",
    project: repository.path, models: [], messageCount: 0, turnCount: 0, gaps: [] },
  { id: "synthetic-normalized-other", client: "claude", clientSessionId: "synthetic-other-session", title: "Synthetic other", titleOrigin: "recorded",
    project: "/synthetic/other", models: [], messageCount: 0, turnCount: 0, gaps: [] },
] };
const range: OverviewRange = { from: "2026-10-11", to: "2026-10-12", all: false, today: "2026-10-12", includesToday: true,
  comparison: { current: { from: "2026-10-11", to: "2026-10-11" }, previous: { from: "2026-10-10", to: "2026-10-10" } }, recent: null };

test("仓库摘要固定同一基线，完整日比较不混入今天，模型局部条件不筛代码", () => {
  const calls: string[] = [];
  const store = { getSnapshot: (_id: string, version: string) => { calls.push(version); return snapshot; } } as unknown as AnalysisStore;
  const [row] = buildOverviewRepositories(store, [repository], source, { projects: [repository.path], clients: ["codex"], models: ["unknown-model"] }, range, "Asia/Shanghai");
  assert.deepEqual(calls, ["synthetic-version"]);
  assert.equal(row!.baselineHash, "synthetic-baseline");
  assert.equal(row!.summary!.fileCount, row!.previousSummary!.fileCount);
  assert.equal(row!.summary!.lineCount, 3);
  assert.equal(row!.activity!.read, 2);
  assert.equal(row!.comparisonActivity!.read, 1);
  assert.equal(row!.previousActivity!.read, 1);
  assert.deepEqual(row!.hotspots[0], { path: "src/a.ts", read: 2, edit: 0, failure: 0,
    comparison: { read: 1, edit: 0, failure: 0 }, previous: { read: 1, edit: 0, failure: 0 } });
});

test("未就绪、失效和过期仓库独立呈现，不自动分析或换成新版本", () => {
  const store = { getSnapshot: () => { throw new StoreError("VERSION_NOT_FOUND", "Synthetic unavailable"); } } as unknown as AnalysisStore;
  const rows = buildOverviewRepositories(store, [{ ...repository, version: undefined }, { ...repository, stale: true }], source, {}, range, "UTC");
  assert.deepEqual(rows.map(row => row.state), ["unready", "unavailable"]);
  assert.equal(rows[1]!.version, "synthetic-version");
  assert.equal(rows[1]!.repository.stale, true);
  assert.deepEqual(buildOverviewRepositories(store, [{ ...repository, version: undefined }], source,
    { projects: ["/synthetic/other"] }, range, "UTC"), []);
});

test("同一文件兼有精确和近似范围时，读取覆盖文件数只计一次", () => {
  const mixed = { ...snapshot, mappings: [{ eventId: "current", filePath: "src/a.ts", kind: "read" as const,
    exactRanges: [{ start: 1, end: 1 }], nearRanges: [{ start: 2, end: 2 }], ruleVersion: "synthetic-rule" }] };
  const store = { getSnapshot: () => mixed } as unknown as AnalysisStore;
  const [row] = buildOverviewRepositories(store, [repository], source, {}, range, "Asia/Shanghai");
  assert.equal(row!.summary!.readExact.files, 1); assert.equal(row!.summary!.readNear.files, 1);
  assert.equal(row!.readCoveredFiles, 1); assert.equal(row!.editCoveredFiles, 0);
});
