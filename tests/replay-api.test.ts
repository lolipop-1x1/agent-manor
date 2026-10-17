import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import test from "node:test";
import Fastify from "fastify";
import type Database from "better-sqlite3";
import type { AnalysisSnapshot, EvidenceResponse, HistoryEvent } from "../src/contracts.js";
import type { SessionMessage, SessionSourceMeta } from "../src/session-contracts.js";
import { scanRepository } from "../src/analysis/baseline.js";
import { eventFilePaths } from "../src/analysis/coverage.js";
import { AnalysisStore, StoreError } from "../src/index/store.js";
import { SessionStore } from "../src/sessions/store.js";
import { ReplayService } from "../src/replay/service.js";
import { ReplayManager } from "../src/replay/manager.js";
import { registerReplayRoutes } from "../src/service/replay-routes.js";
import { ServiceError } from "../src/service/input.js";
import { contentHash } from "../src/service/files.js";

const run = promisify(execFile);
const time = "2026-01-01T00:00:02.000Z";
const sourcePath = (id: string) => `/workspace/history/${id}.jsonl`;
const sourceId = (id: string) => `codex:${id}`;
function meta(id: string, extra: Partial<SessionSourceMeta> = {}): SessionSourceMeta {
  return { id, client: "codex", clientSessionId: `native-${id}`, title: `合成会话 ${id}`, titleOrigin: "recorded",
    path: sourcePath(id), sourceId: sourceId(id), messageCount: 0, turnCount: 0, models: [], gaps: [],
    updatedAt: time, ...extra };
}
function message(sessionId: string, ordinal: number, callId: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { id: `${sessionId}-message-${ordinal}`, sessionId, ordinal, recordLine: ordinal,
    turnId: "turn", kind: "tool_call", tool: "read", callId, text: "不能加载的工具正文", occurredAt: time, ...extra };
}
function revision(store: SessionStore, summary: SessionSourceMeta, messages: SessionMessage[]) {
  const pending = store.createRevision(summary.path, `fixture-${summary.id}-${messages.length}-${summary.title}`);
  for (const item of messages) pending.sink.message(item);
  pending.flush();
  store.finishRevision(pending.revision, { ...summary, messageCount: messages.length });
  return { path: summary.path, revision: pending.revision, fingerprint: `fixture-${pending.revision}` };
}
function event(id: string, session: string, line: number, extra: Partial<HistoryEvent> = {}): HistoryEvent {
  return { id, client: "codex", sessionId: `native-${session}`, tool: "read", kind: "read", status: "success", path: "src/a.ts",
    occurredAt: time, fragments: [{ content: "不能加载的历史片段", kind: "read", completeLines: true }],
    input: "不能加载的工具参数", output: "不能加载的输出",
    sources: [{ sourceId: sourceId(session), path: sourcePath(session), recordLine: line, hash: "synthetic" }], ...extra };
}
function withCall(value: HistoryEvent, callId: string): HistoryEvent {
  return { ...value, sources: [...value.sources, { ...value.sources[0]!, recordLine: value.sources[0]!.recordLine + 1, callId }] };
}

async function fixture(body: (context: { analysis: AnalysisStore; sessions: SessionStore; replay: ReplayService;
  snapshot: AnalysisSnapshot; publish: (snapshot: AnalysisSnapshot) => void; repositoryPath: string }) => Promise<void> | void) {
  const directory = await mkdtemp(join(tmpdir(), "manor-replay-"));
  const repositoryPath = join(directory, "repo");
  await mkdir(join(repositoryPath, "src"), { recursive: true });
  await run("git", ["init", "-q", repositoryPath]);
  await writeFile(join(repositoryPath, "src/a.ts"), "export const a = 1;\n");
  await writeFile(join(repositoryPath, "src/b.ts"), "export const b = 2;\n");
  await writeFile(join(repositoryPath, "zero.ts"), "");
  const analysis = new AnalysisStore(join(directory, "index.sqlite"));
  const sessions = new SessionStore(analysis.dbPath);
  try {
    const repository = await analysis.registerRepository(repositoryPath);
    const baseline = await scanRepository(repositoryPath);
    const snapshot: AnalysisSnapshot = { repository, version: "map-v1", baseline, events: [], sources: [], mappings: [], gaps: [], createdAt: time };
    const publish = (value: AnalysisSnapshot) => {
      const job = analysis.createJob(repository.id);
      analysis.updateJob(job.id, { status: "running" });
      analysis.publish({ snapshot: value, sources: { version: value.version, sources: [], unassociated: [], gaps: value.gaps },
        parsed: [], mappings: [], stats: { sourcesParsed: 0, parsedRecords: 0, mappingsComputed: 0, mappingsReused: 0 }, clearCache: false, jobId: job.id });
    };
    await body({ analysis, sessions, replay: new ReplayService(analysis, sessions), snapshot, publish, repositoryPath: repository.path });
  } finally { sessions.close(); analysis.close(); await rm(directory, { recursive: true, force: true }); }
}

test("回放候选包含只有子会话活动的主会话，递归明确子树但不合并 fork", async () => fixture(({ sessions, replay, snapshot, publish }) => {
  const revisions = [
    revision(sessions, meta("root", { childSessionIds: ["child", "parallel", "missing"] }), []),
    revision(sessions, meta("child", { relationship: "child", parentSessionId: "root", childSessionIds: ["grand"] }), [message("child", 10, "batch"), message("child", 20, "other")]),
    revision(sessions, meta("parallel", { relationship: "child", parentSessionId: "root" }), [message("parallel", 5, "parallel")]),
    revision(sessions, meta("grand", { relationship: "child", parentSessionId: "child" }), []),
    revision(sessions, meta("fork", { relationship: "fork", parentSessionId: "root" }), [message("fork", 2, "fork")]),
  ];
  const sessionVersion = sessions.publish(sessions.createJob().id, revisions, []);
  snapshot.events = [withCall(event("batch-a", "child", 10), "batch"), withCall(event("batch-b", "child", 10, { path: "src/b.ts", kind: "edit" }), "batch"),
    withCall(event("same-time-separate", "child", 20, { status: "failure", path: "deleted.ts" }), "other"),
    event("untimed", "child", 30, { occurredAt: undefined, status: "unknown", path: "zero.ts" }),
    event("parallel", "parallel", 5, { occurredAt: "2026-01-01T00:00:01.000Z" }),
    event("grand", "grand", 2, { kind: "search", path: "src" }), event("fork", "fork", 2)];
  publish(snapshot);
  const options = replay.sessions(snapshot.repository.id);
  assert.equal(options.version, snapshot.version);
  assert.equal(options.sessionVersion, sessionVersion);
  assert.equal(options.sessions.find(item => item.id === "root")?.eventCount, 6);
  assert.equal(options.sessions.find(item => item.id === "root")?.trackCount, 4);
  assert.ok(options.sessions.some(item => item.id === "fork"));
  const result = replay.replay(snapshot.repository.id, "root", snapshot.version, sessionVersion);
  assert.deepEqual(new Set(result.tracks.map(track => track.id)), new Set(["root", "child", "parallel", "grand"]));
  assert.deepEqual(result.tracks.map(track => track.id), ["root", "child", "grand", "parallel"]);
  assert.equal(result.tracks.find(track => track.id === "grand")!.depth, 2);
  assert.equal(result.totalActivities, 6);
  assert.equal(result.steps.length, 5);
  assert.equal(result.steps.find(step => step.activities.some(activity => activity.id === "batch-a"))!.activities.length, 2);
  assert.equal(result.steps.find(step => step.activities.some(activity => activity.id === "same-time-separate"))!.activities.length, 1);
  assert.equal(result.steps.find(step => step.activities.some(activity => activity.id === "untimed"))!.time, undefined);
  assert.equal(result.tracks.find(track => track.id === "child")!.untimedCount, 1);
  assert.deepEqual(result.steps.flatMap(step => step.activities).find(activity => activity.id === "same-time-separate")!.paths, ["deleted.ts"]);
  assert.equal(result.steps.flatMap(step => step.activities).find(activity => activity.id === "same-time-separate")!.status, "failure");
  assert.ok(result.files.some(file => file.path === "zero.ts" && file.lineCount === 0));
  assert.equal(result.missingChildren, 1);
  assert.deepEqual(result.range, { start: Date.parse("2026-01-01T00:00:01.000Z"), end: Date.parse(time) });
  assert.ok(!JSON.stringify(result).includes("不能加载"));
}));

test("回放专用投影保留完整身份、来源和路径，省略基线正文、片段范围与覆盖区间", async () => fixture(({ analysis, snapshot, publish }) => {
  snapshot.events = [event("projected", "single", 10, { fragments: [
    { content: "不能加载的片段", path: "src/b.ts", kind: "read", historicalStart: 12, completeLines: true },
    { content: "没有路径的片段", kind: "context", completeLines: false },
  ] }), event("inactive", "single", 20, { client: "doubao-work" })];
  snapshot.mappings = snapshot.events.map(item => ({ eventId: item.id, filePath: "src/b.ts", kind: "read", exactRanges: [{ start: 1, end: 20 }],
    nearRanges: [{ start: 30, end: 40 }], ruleVersion: "synthetic" }));
  snapshot.gaps = [{ kind: "range_unknown", message: "保留的合成缺口" }, { kind: "source_missing", message: "停用来源缺口", sourceId: "doubao-work:synthetic" }];
  publish(snapshot);
  const previous = analysis.getCoverageSnapshot(snapshot.repository.id);
  const projection = analysis.getReplaySnapshot(snapshot.repository.id);
  assert.equal(projection.version, previous.version);
  assert.equal(projection.baselineHash, previous.baseline.hash);
  assert.deepEqual(projection.files, previous.baseline.files.map(({ path, category, lineCount }) => ({ path, category, lineCount })));
  assert.equal(projection.events.length, 1);
  for (const [index, item] of projection.events.entries()) {
    assert.deepEqual(eventFilePaths(item, projection.repository), eventFilePaths(previous.events[index]!, previous.repository));
    assert.deepEqual(item.sources, previous.events[index]!.sources);
    assert.ok(item.fragments.every(fragment => Object.keys(fragment).length === 1 && "path" in fragment));
  }
  assert.deepEqual(projection.mappings, previous.mappings.map(({ eventId, filePath }) => ({ eventId, filePath })));
  assert.deepEqual(projection.gaps, previous.gaps);
  assert.ok(!JSON.stringify(projection).includes("不能加载"));
  assert.ok(!JSON.stringify(projection).includes("exactRanges"));
}));

for (const stage of ["版本检查后", "头部读取后"] as const) {
  test(`回放${stage}其他连接淘汰版本，读取事务仍返回完整旧快照`, async () => fixture(({ analysis, snapshot, publish }) => {
    snapshot.events = [event("retained", "single", 10)];
    snapshot.mappings = [{ eventId: "retained", filePath: "src/a.ts", kind: "read", exactRanges: [{ start: 1, end: 1 }], nearRanges: [], ruleVersion: "synthetic" }];
    publish(snapshot);
    const expected = analysis.getReplaySnapshot(snapshot.repository.id, snapshot.version);
    const writer = new AnalysisStore(analysis.dbPath);
    let expired = false;
    const expire = () => {
      if (expired) return;
      expired = true;
      for (const version of ["map-v2", "map-v3"]) {
        const job = writer.createJob(snapshot.repository.id);
        writer.updateJob(job.id, { status: "running" });
        writer.publish({ snapshot: { ...snapshot, version, events: [], mappings: [] },
          sources: { version, sources: [], unassociated: [], gaps: [] }, parsed: [], mappings: [],
          stats: { sourcesParsed: 0, parsedRecords: 0, mappingsComputed: 0, mappingsReused: 0 }, clearCache: false, jobId: job.id });
      }
      assert.throws(() => writer.analysisVersion(snapshot.repository.id, snapshot.version), error => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
    };
    try {
      if (stage === "版本检查后") {
        const selectVersion = analysis.analysisVersion.bind(analysis);
        analysis.analysisVersion = (...args) => { const selected = selectVersion(...args); expire(); return selected; };
      } else {
        const database = (analysis as unknown as { database: Database.Database }).database;
        const prepare = database.prepare.bind(database);
        database.prepare = ((sql: string) => {
          if (sql.startsWith("SELECT field,part,CASE field")) expire();
          return prepare(sql);
        }) as typeof database.prepare;
      }
      const result = analysis.getReplaySnapshot(snapshot.repository.id, snapshot.version);
      assert.ok(expired);
      assert.deepEqual(result, expected, "头部、文件、活动与映射必须来自完整旧版本");
      assert.throws(() => analysis.getReplaySnapshot(snapshot.repository.id, snapshot.version), error => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
    } finally { writer.close(); }
  }));
}

test("请求元数据版本检查后其他连接淘汰会话版本，仍保留完整消息关联", async () => fixture(({ analysis, sessions }) => {
  const initial = revision(sessions, meta("single"), [message("single", 1, "initial")]);
  const version = sessions.publish(sessions.createJob().id, [initial], []);
  const expected = sessions.replayMessages(version, ["single"]);
  const writer = new SessionStore(analysis.dbPath);
  const internal = sessions as unknown as { version: (requested?: string) => string };
  const selectVersion = internal.version.bind(sessions);
  let expired = false;
  internal.version = requested => {
    const selected = selectVersion(requested);
    if (!expired) {
      expired = true;
      for (const title of ["第二版", "第三版"]) {
        const next = revision(writer, meta("single", { title }), [message("single", 2, "changed")]);
        writer.publish(writer.createJob().id, [next], []);
      }
      assert.throws(() => writer.usageVersion(version), error => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
    }
    return selected;
  };
  try {
    assert.deepEqual(sessions.replayMessages(version, ["single"]), expected);
    assert.ok(expired);
    assert.throws(() => sessions.replayMessages(version, ["single"]), error => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
  } finally { writer.close(); }
}));

test("调用分组使用原生消息或调用与来源位置；相同时间、复用调用ID和不同源不会被误合并", async () => fixture(({ sessions, replay, snapshot, publish }) => {
  sessions.publish(sessions.createJob().id, [revision(sessions, meta("single"), [message("single", 10, "reused"), message("single", 20, "reused")])], []);
  snapshot.events = [withCall(event("first", "single", 10, { occurredAt: undefined }), "reused"), withCall(event("first-file", "single", 10, { path: "src/b.ts" }), "reused"),
    withCall(event("second", "single", 20), "reused"), event("no-call-one", "single", 25), event("no-call-two", "single", 25),
    event("missing-source-position", "single", 50, { sources: [], occurredAt: undefined }),
    event("other-source", "single", 1, { sources: [{ sourceId: "codex:other", path: "/workspace/other.jsonl", recordLine: 1, hash: "synthetic" }] })];
  publish(snapshot);
  const result = replay.replay(snapshot.repository.id, "single");
  assert.equal(result.steps.length, 6);
  assert.equal(result.steps.find(step => step.activities.some(activity => activity.id === "first"))!.activities.length, 2);
  assert.equal(result.steps.find(step => step.activities.some(activity => activity.id === "first"))!.activities[0]!.messageId, "single-message-10");
  assert.equal(result.steps.find(step => step.activities.some(activity => activity.id === "first"))!.time, Date.parse(time), "精确关联的原生请求时间可补充同一调用的缺失时间");
  assert.equal(result.steps.find(step => step.activities.some(activity => activity.id === "second"))!.activities[0]!.messageId, "single-message-20");
  assert.equal(result.steps.find(step => step.activities.some(activity => activity.id === "missing-source-position"))!.orderKnown, false);
  assert.ok(result.steps.some(step => step.activities[0]?.id === "no-call-one"));
  assert.ok(result.steps.some(step => step.activities[0]?.id === "no-call-two"));
}));

test("缺消息时按同源位置保留顺序，可靠调用多文件仍分组；搜索及基线外路径不截断", async () => fixture(({ sessions, replay, snapshot, publish, repositoryPath }) => {
  sessions.publish(sessions.createJob().id, [revision(sessions, meta("single"), [])], []);
  snapshot.events = [event("later", "single", 40, { occurredAt: undefined }),
    withCall(event("batch-a", "single", 10, { occurredAt: undefined }), "native-call"),
    withCall(event("batch-b", "single", 10, { occurredAt: undefined, path: "removed.md" }), "native-call"),
    event("search-root", "single", 50, { kind: "search", path: undefined, cwd: repositoryPath }),
    event("search-directory", "single", 55, { kind: "search", path: undefined, cwd: join(repositoryPath, "src") }),
    event("external", "single", 60, { path: "/outside/a.ts" }),
    event("duplicate", "single", 70), event("duplicate", "single", 70)];
  publish(snapshot);
  const result = replay.replay(snapshot.repository.id, "single");
  assert.equal(result.totalActivities, 6);
  assert.deepEqual(result.steps.slice().sort((a, b) => a.order - b.order).map(step => step.activities[0]!.id), ["batch-a", "later", "search-root", "search-directory", "duplicate"]);
  assert.ok(result.steps.every(step => step.orderKnown));
  assert.deepEqual(result.steps.find(step => step.activities[0]?.id === "search-root")!.activities[0]!.paths, ["."]);
  assert.deepEqual(result.steps.find(step => step.activities[0]?.id === "search-directory")!.activities[0]!.paths, ["src"]);
  assert.equal(result.steps.find(step => step.activities[0]?.id === "batch-a")!.activities.length, 2);
}));

test("缓存分别绑定两个版本，旧版淘汰及仓库删除后明确失败，暖请求不重读快照或正文", async () => fixture(({ analysis, sessions, replay, snapshot, publish }) => {
  const first = revision(sessions, meta("single"), [message("single", 1, "first")]);
  const sessionVersion = sessions.publish(sessions.createJob().id, [first], []);
  snapshot.events = [withCall(event("first", "single", 1), "first")];
  publish(snapshot);
  let reads = 0;
  const originalSnapshot = analysis.getReplaySnapshot.bind(analysis);
  analysis.getReplaySnapshot = (...args) => { reads++; return originalSnapshot(...args); };
  analysis.getCoverageSnapshot = () => { throw new Error("回放不得加载覆盖范围与未使用的片段元数据"); };
  analysis.getSnapshot = () => { throw new Error("回放不得加载完整快照"); };
  sessions.profile = () => { throw new Error("回放不得构建完整画像"); };
  replay.sessions(snapshot.repository.id);
  replay.replay(snapshot.repository.id, "single");
  replay.replay(snapshot.repository.id, "single");
  assert.equal(reads, 1);
  publish({ ...snapshot, version: "map-v2", events: [] });
  assert.equal(replay.replay(snapshot.repository.id, "single", "map-v1", sessionVersion).stale, true);
  assert.equal(replay.replay(snapshot.repository.id, "single", "map-v1", sessionVersion).totalActivities, 1);
  assert.equal(replay.replay(snapshot.repository.id, "single").totalActivities, 0);
  publish({ ...snapshot, version: "map-v3" });
  assert.throws(() => replay.replay(snapshot.repository.id, "single", "map-v1", sessionVersion), error => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
  const second = revision(sessions, meta("single", { title: "第二版" }), [message("single", 2, "second")]);
  sessions.publish(sessions.createJob().id, [second], []);
  assert.equal(replay.replay(snapshot.repository.id, "single", "map-v3", sessionVersion).tracks[0]!.title, "合成会话 single");
  const third = revision(sessions, meta("single", { title: "第三版" }), [message("single", 3, "third")]);
  sessions.publish(sessions.createJob().id, [third], []);
  assert.throws(() => replay.replay(snapshot.repository.id, "single", "map-v3", sessionVersion), error => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
  analysis.deleteRepository(snapshot.repository.id);
  assert.throws(() => replay.sessions(snapshot.repository.id), error => error instanceof StoreError && error.code === "REPOSITORY_NOT_FOUND");
}));

test("会话版本更新复用同一仓库最小快照，分析版本更新重读且淘汰仍明确失败", async () => fixture(({ analysis, sessions, replay, snapshot, publish }) => {
  const first = revision(sessions, meta("single"), [message("single", 1, "first")]);
  const sessionVersion = sessions.publish(sessions.createJob().id, [first], []);
  snapshot.events = [event("first", "single", 1)];
  publish(snapshot);
  let reads = 0;
  const read = analysis.getReplaySnapshot.bind(analysis);
  analysis.getReplaySnapshot = (...args) => { reads++; return read(...args); };
  assert.equal(replay.sessions(snapshot.repository.id, snapshot.version, sessionVersion).sessions[0]!.title, "合成会话 single");
  assert.equal(reads, 1);
  const changed = revision(sessions, meta("single", { title: "更新的标题" }), [message("single", 2, "changed")]);
  const nextSessionVersion = sessions.publish(sessions.createJob().id, [changed], []);
  assert.equal(replay.sessions(snapshot.repository.id, snapshot.version, nextSessionVersion).sessions[0]!.title, "更新的标题");
  assert.equal(reads, 1, "不同会话版本的准备数据应复用同一分析快照");
  publish({ ...snapshot, version: "map-v2", events: [] });
  assert.equal(replay.sessions(snapshot.repository.id, "map-v2", nextSessionVersion).sessions.length, 0);
  assert.equal(reads, 2, "新分析版本必须读取自己的完整快照");
  publish({ ...snapshot, version: "map-v3" });
  assert.throws(() => replay.sessions(snapshot.repository.id, snapshot.version, nextSessionVersion), error => error instanceof StoreError && error.code === "VERSION_NOT_FOUND");
  assert.equal(reads, 2, "已淘汰分析版本必须在缓存命中前拒绝");
}));

test("HTTP接口检查目标与双版本参数，未发布、无会话和不存在版本保留明确错误", async () => fixture(async ({ analysis, sessions, snapshot, publish }) => {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const known = error instanceof StoreError || error instanceof ServiceError;
    reply.code(known && error.code === "INVALID_INPUT" ? 400 : known && error.code === "ANALYSIS_NOT_READY" ? 409 : 404)
      .send({ error: { code: known ? error.code : "INTERNAL_ERROR" } });
  });
  const manager = new ReplayManager(analysis, sessions);
  app.addHook("onClose", () => manager.close());
  registerReplayRoutes(app, manager);
  const base = `/api/v1/repositories/${snapshot.repository.id}/replay`;
  try {
    assert.equal((await app.inject(`${base}?sessionId=single`)).json().error.code, "ANALYSIS_NOT_READY");
    sessions.publish(sessions.createJob().id, [revision(sessions, meta("single"), [])], []);
    publish(snapshot);
    assert.equal((await app.inject(base)).statusCode, 400);
    assert.equal((await app.inject(`${base}?sessionId=absent`)).json().error.code, "SOURCE_NOT_FOUND");
    assert.equal((await app.inject(`${base}/sessions?version=absent`)).json().error.code, "VERSION_NOT_FOUND");
    assert.equal((await app.inject(`${base}/sessions?sessionVersion=absent`)).json().error.code, "VERSION_NOT_FOUND");
    const result = await app.inject(`${base}?sessionId=single`);
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().totalActivities, 0);
    assert.equal(result.json().range, null);
    assert.deepEqual((await app.inject(`${base}/sessions`)).json().sessions, []);
  } finally { await app.close(); }
}));

test("回放证据只读取首出现分块的单个活动，核对子树与双版本并保留原始来源缺失", async () => fixture(async ({ analysis, sessions, snapshot, publish }) => {
  const revisions = [revision(sessions, meta("root", { childSessionIds: ["child"] }), []),
    revision(sessions, meta("child", { relationship: "child", parentSessionId: "root" }), [message("child", 1, "read")]),
    revision(sessions, meta("fork", { relationship: "fork", parentSessionId: "root" }), [])];
  const sessionVersion = sessions.publish(sessions.createJob().id, revisions, []);
  const raw = JSON.stringify({ synthetic: "原始证据" });
  const path = join(analysis.dbPath, "..", "replay-evidence.jsonl");
  await writeFile(path, `${raw}\n`);
  const selected = event("selected", "child", 1, { input: { requested: "src/a.ts" }, output: "首份完整工具结果" });
  selected.sources = [{ ...selected.sources[0]!, path, hash: contentHash(raw), format: "codex-jsonl" }];
  snapshot.events = [event("outside", "fork", 1, { output: "x".repeat(1_100_000) }), selected,
    event("large-unrelated", "fork", 2, { output: "y".repeat(1_100_000) }), { ...selected, output: "同ID的后一份结果不能覆盖首份" }];
  publish(snapshot);
  const projection = analysis.getReplaySnapshot(snapshot.repository.id);
  const part = projection.eventParts.get(selected.id)!;
  assert.ok(part > 0, "目标活动应位于独立的后续分块，不能从默认首块碰巧读到");
  assert.equal(analysis.getReplayEvent(snapshot.repository.id, snapshot.version, part, selected.id).output, selected.output);
  assert.throws(() => analysis.getReplayEvent(snapshot.repository.id, snapshot.version, 0, selected.id), error => error instanceof StoreError && error.code === "EVENT_NOT_FOUND");
  analysis.getSnapshot = () => { throw new Error("单活动证据不得加载完整仓库快照"); };
  analysis.getCoverageSnapshot = () => { throw new Error("单活动证据不得加载覆盖快照"); };
  let minimalReads = 0;
  const readProjection = analysis.getReplaySnapshot.bind(analysis);
  analysis.getReplaySnapshot = (...args) => { minimalReads++; return readProjection(...args); };
  let singleReads = 0;
  let queryPlan: { detail: string }[] = [];
  const database = (analysis as unknown as { database: Database.Database }).database;
  const prepare = database.prepare.bind(database);
  database.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith("SELECT json(e.value)")) {
      const get = statement.get.bind(statement);
      statement.get = (...parameters: unknown[]) => {
        singleReads++;
        queryPlan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as { detail: string }[];
        return get(...parameters);
      };
    }
    return statement;
  }) as typeof database.prepare;
  const direct = new ReplayService(analysis, sessions);
  assert.equal(direct.replay(snapshot.repository.id, "root", snapshot.version, sessionVersion).totalActivities, 1);
  assert.deepEqual((await direct.evidence(snapshot.repository.id, "root", selected.id, snapshot.version, sessionVersion)).event, selected);
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    const known = error instanceof StoreError || error instanceof ServiceError;
    reply.code(known && error.code === "INVALID_INPUT" ? 400 : 404).send({ error: { code: known ? error.code : "INTERNAL_ERROR" } });
  });
  const manager = new ReplayManager(analysis, sessions);
  app.addHook("onClose", () => manager.close());
  registerReplayRoutes(app, manager);
  const base = `/api/v1/repositories/${snapshot.repository.id}/replay`;
  const query = new URLSearchParams({ sessionId: "root", version: snapshot.version, sessionVersion });
  try {
    const playback = await app.inject(`${base}?${query}`);
    assert.equal(playback.statusCode, 200);
    assert.equal(playback.json().totalActivities, 1);
    assert.equal(playback.json().eventParts, undefined, "分块定位不得进入公开回放JSON");
    assert.equal(minimalReads, 1);
    const response = await app.inject(`${base}/evidence/${selected.id}?${query}`);
    assert.equal(response.statusCode, 200);
    const evidence = response.json<EvidenceResponse>();
    assert.deepEqual(evidence.event, selected);
    assert.equal(evidence.records[0]!.raw, raw);
    assert.deepEqual(evidence.unavailable, []);
    assert.equal(singleReads, 1);
    assert.equal(minimalReads, 1, "播放后点击证据不能再次投影全部事件");
    assert.ok(queryPlan.some(row => row.detail.includes("part=?")), "单活动查询必须定位已知分块主键");
    assert.equal((await app.inject(`${base}/evidence/outside?${query}`)).json().error.code, "EVENT_NOT_FOUND", "fork活动不属于根目标子树");
    assert.equal((await app.inject(`${base}/evidence/${selected.id}?sessionId=root&version=${snapshot.version}`)).statusCode, 400);
    await rm(path);
    const missing = (await app.inject(`${base}/evidence/${selected.id}?${query}`)).json<EvidenceResponse>();
    assert.deepEqual(missing.records, []);
    assert.deepEqual(missing.unavailable, selected.sources);
    publish({ ...snapshot, version: "map-v2" });
    publish({ ...snapshot, version: "map-v3" });
    assert.equal((await app.inject(`${base}/evidence/${selected.id}?${query}`)).json().error.code, "VERSION_NOT_FOUND");
  } finally { await app.close(); }
}));

test("长回放保留全部活动且批量定位，重复调用ID不会退化为逐事件扫描全部消息", async t => fixture(({ sessions, replay, snapshot, publish }) => {
  const count = 12000;
  const messages = Array.from({ length: count }, (_, index) => message("long", index + 1, "reused"));
  sessions.publish(sessions.createJob().id, [revision(sessions, meta("long"), messages)], []);
  snapshot.events = Array.from({ length: count }, (_, index) => withCall(event(`activity-${index}`, "long", index + 1), "reused"));
  publish(snapshot);
  let batches = 0;
  let queryPlan: { detail: string }[] = [];
  const database = (sessions as unknown as { database: Database.Database }).database;
  const prepare = database.prepare.bind(database);
  // 检查实际执行语句的计划，防止 JSON 数组 JOIN 被排到全版本消息扫描之后。
  database.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.includes("AS source_path")) {
      const all = statement.all.bind(statement);
      statement.all = (...parameters: unknown[]) => {
        queryPlan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as { detail: string }[];
        return all(...parameters);
      };
    }
    return statement;
  }) as typeof database.prepare;
  const original = sessions.replayMessages.bind(sessions);
  sessions.replayMessages = (...args) => { batches++; return original(...args); };
  const started = performance.now();
  const result = replay.replay(snapshot.repository.id, "long");
  const elapsed = performance.now() - started;
  assert.equal(result.steps.length, count);
  assert.equal(result.totalActivities, count);
  assert.equal(result.steps.filter(step => step.activities[0]!.messageId).length, count);
  assert.equal(batches, 1);
  assert.ok(queryPlan.some(row => row.detail.includes("version=? AND session_id=?")), "会话版本必须按目标身份点查，不能遍历全版本消息");
  const warmStarted = performance.now();
  assert.equal(replay.replay(snapshot.repository.id, "long").steps.length, count);
  const warmElapsed = performance.now() - warmStarted;
  assert.equal(batches, 1);
  assert.ok(elapsed < 8000, `12000步投影耗时 ${elapsed.toFixed(0)}ms`);
  t.diagnostic(`12000步完整投影：冷读取 ${elapsed.toFixed(1)}ms，暖读取 ${warmElapsed.toFixed(1)}ms`);
}));
