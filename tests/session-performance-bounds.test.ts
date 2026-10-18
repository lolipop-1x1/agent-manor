import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { SessionMessage, SessionSourceMeta, SessionUsage } from "../src/session-contracts.js";
import { summarizeRequestSpeed } from "../src/session-speed.js";
import { refreshSessions } from "../src/sessions/refresh.js";
import { SessionStore } from "../src/sessions/store.js";
import { sessionMessageQuery, sessionProfileQuery, sessionTimelineQuery } from "../src/service/session-input.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

const encode = (value: unknown) => `${JSON.stringify(value)}\n`;
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
async function fixture(run: (store: SessionStore, directory: string) => Promise<void> | void) {
  const directory = await mkdtemp(join(tmpdir(), "manor-bounded-session-"));
  const store = new SessionStore(join(directory, "index.sqlite"));
  try { await run(store, directory); }
  finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}
const refresh = async (store: SessionStore, roots: ReturnType<typeof isolatedHistoryRoots>, clear = false) => {
  const job = store.createJob();
  await refreshSessions(store, job.id, roots, clear);
  return store.getJob(job.id);
};
function canonical(store: SessionStore) {
  const id = store.list().sessions[0]!.id;
  const { version: _messagesVersion, ...messages } = store.messages(id, { mode: "full", pageUnit: "turn", pageSize: 200 });
  const { version: _profileVersion, ...profile } = store.profile(id);
  const { version: _searchVersion, ...search } = store.search({ q: "合成", kinds: ["user", "assistant", "thinking", "system"] });
  return { messages, profile, search };
}

test("无变化检查保留版本、正文和前版，更新检查时间；追加、改写、截断与完整处理一致", async () => fixture(async (store, directory) => {
  const root = join(directory, "sessions"); await mkdir(root);
  const path = join(root, "sample.jsonl");
  const header = encode({ type: "session_meta", payload: { id: "incremental-synthetic", cwd: "/workspace/example" } });
  const message = (id: string, body: string) => encode({ type: "response_item", payload: { type: "message", id, role: "user", content: [{ type: "input_text", text: body }] } });
  const original = header + message("one", "合成原文");
  await writeFile(path, original);
  const roots = isolatedHistoryRoots({ codex: root });
  await refresh(store, roots);
  const first = store.status();
  const db = new Database(store.dbPath);
  try {
    const before = db.prepare("SELECT COUNT(*) AS count FROM session_versions").get();
    const unchanged = await refresh(store, roots);
    assert.equal(unchanged.counts!.quickReused, 1);
    assert.equal(unchanged.version, first.version);
    assert.equal(store.status().createdAt, first.createdAt);
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS count FROM session_versions").get(), before);
    assert.equal(store.status().clientChecks!.find(check => check.client === "codex")!.checkedAt, unchanged.finishedAt);
    for (const input of [original + message("two", "合成追加"), original.replace("合成原文", "合成改写"), original,
      original + '{"type":"response_item"']) {
      await writeFile(path, input);
      await refresh(store, roots);
      const quick = canonical(store);
      await refresh(store, roots, true);
      assert.deepEqual(canonical(store), quick, "快速更新与完整重新解析的消息、用量、缺口和搜索一致");
      const beforeFull = store.status();
      const full = store.createJob({ mode: "full" });
      await refreshSessions(store, full.id, roots);
      assert.equal(store.getJob(full.id).version, beforeFull.version);
    }
  } finally { db.close(); }
}));

test("有界消息、画像与轨迹保持完整统计、定位、正文与搜索，旧调用仍返回完整数据", async context => fixture(store => {
  const id = "bounded-synthetic";
  const meta: SessionSourceMeta = { id, client: "codex", clientSessionId: id, title: "合成超长轮次", titleOrigin: "recorded",
    path: "/workspace/history/bounded.jsonl", sourceId: "codex:bounded", messageCount: 0, turnCount: 0, models: [], gaps: [] };
  const pending = store.createRevision(meta.path, "synthetic");
  const messages: SessionMessage[] = Array.from({ length: 1300 }, (_, index) => ({ id: `message-${index}`, sessionId: id,
    ordinal: index + 1, recordLine: index + 1, turnId: "turn-one", kind: index === 0 ? "user" : index % 2 ? "assistant" : "thinking",
    text: `合成正文 ${index} ` + "🙂正文".repeat(300), model: "fixture-model", ...(index === 1299 ? { final: "explicit" as const } : {}) }));
  messages[120]!.text = "合成 NUL\0之后的完整正文🙂";
  for (const message of messages) pending.sink.message(message);
  const usage: SessionUsage[] = Array.from({ length: 300 }, (_, index) => ({ id: `request-${index}`, messageId: `message-${index + 1}`,
    turnId: "turn-one", inputTokens: index + 100, outputTokens: 400, cachedInputTokens: index < 150 ? 10 : undefined,
    timing: { basis: "estimated", method: "codex_event_boundary", completion: "inferred", durationMs: 4000 } }));
  for (const request of usage) pending.sink.usage(request);
  pending.flush(); store.finishRevision(pending.revision, meta);
  store.publish(store.createJob().id, [{ path: meta.path, fingerprint: "synthetic", revision: pending.revision }], []);
  const full = store.messages(id, { mode: "full", pageUnit: "turn" });
  assert.equal(full.messages.length, 1300);
  const bounded = store.messages(id, { mode: "full", pageUnit: "turn", messageLimit: 40, maxTextChars: 120 });
  assert.equal(bounded.messages.length, 40);
  assert.equal(bounded.turns![0]!.messageCount, 1300);
  assert.equal(bounded.usages!.length, 300, "同轮请求不会随消息块截断");
  assert.ok(bounded.messages.every(message => message.textTruncated && [...message.text].length === 120 && message.textLength! > 120));
  assert.ok(JSON.stringify(bounded).length < JSON.stringify(full).length / 10);
  const readIds: string[] = [];
  for (let offset = 0; offset < 1300; offset += 40) {
    const result = store.messages(id, { mode: "full", pageUnit: "turn", messageLimit: 40, messageOffset: offset, maxTextChars: 120 });
    readIds.push(...result.messages.map(message => message.id));
    assert.equal(result.hasMoreMessages, offset + result.messages.length < 1300);
  }
  assert.deepEqual(readIds, messages.map(message => message.id));
  const focused = store.messages(id, { mode: "full", pageUnit: "turn", messageLimit: 40, messageId: "message-905" });
  assert.equal(focused.messageOffset, 880);
  assert.ok(focused.messages.some(message => message.id === "message-905"));
  const moved = store.messages(id, { mode: "full", pageUnit: "turn", messageLimit: 40, messageId: "message-905", messageOffset: 40 });
  assert.equal(moved.messageOffset, 40, "显式翻页不被定位消息强制回跳");
  assert.deepEqual(store.messages(id, { mode: "full", pageSize: 1, messageId: "message-905" }).messages[0], messages[905]);
  const nulPreview = store.messages(id, { mode: "full", pageSize: 1, messageId: "message-120", maxTextChars: 120 }).messages[0]!;
  assert.equal(nulPreview.text, messages[120]!.text, "有界预览需完整返回 NUL 后正文");
  assert.equal(nulPreview.textTruncated, false, "完整正文小于预览上限，不应标记截断");
  assert.equal(nulPreview.textLength, [...messages[120]!.text].length);
  const nulStart = store.messages(id, { response: "summary", mode: "full", pageSize: 1, messageId: "message-120", maxTextChars: 7 }).messages[0]!;
  assert.equal(nulStart.text, [...messages[120]!.text].slice(0, 7).join(""));
  assert.equal(nulStart.textTruncated, true); assert.equal(nulStart.nextTextOffset, 7);
  const nulTail = store.messages(id, { response: "summary", version: full.version, mode: "full", pageSize: 1, messageId: "message-120", textOffset: nulStart.nextTextOffset, maxTextChars: 120 }).messages[0]!;
  assert.equal(nulTail.textOffset, 7); assert.equal(nulTail.nextTextOffset, undefined);
  assert.equal(nulStart.text + nulTail.text, messages[120]!.text, "按字符位置回读需跨 NUL 无损恢复全文");
  assert.equal(store.messages(id, { mode: "full", pageSize: 1, messageId: "message-120" }).messages[0]!.text, messages[120]!.text);
  const fullProfileStarted = performance.now();
  const profile = store.profile(id);
  const fullProfileMs = performance.now() - fullProfileStarted;
  const summary = store.profile(id, { summary: true });
  const pageStarted = performance.now();
  const page = store.profile(id, { stepOffset: 200, stepLimit: 50 });
  const pageMs = performance.now() - pageStarted;
  assert.equal(summary.steps.length, 0);
  assert.equal(summary.stepsTotal, 300);
  assert.deepEqual(summary.usage, profile.usage);
  assert.deepEqual(summary.outputSpeed, profile.outputSpeed);
  assert.equal(summary.usage.recordedRequests!.cachedInputTokens, 150);
  assert.equal(summary.peakInputRequest!.id, "request-299");
  assert.deepEqual(page.steps, profile.steps.slice(200, 250));
  assert.deepEqual(page.outputSpeed, profile.outputSpeed, "分页请求仍返回全范围速度统计");
  const parse = JSON.parse;
  let decodedRequests = 0;
  JSON.parse = ((value: string, ...args: unknown[]) => {
    if (value.startsWith('{"id":"request-')) decodedRequests += 1;
    return parse(value, ...args as []);
  }) as typeof JSON.parse;
  try {
    assert.deepEqual(store.profile(id, { stepOffset: 200, stepLimit: 50 }).steps, profile.steps.slice(200, 250));
    assert.equal(decodedRequests, 50, "摘要缓存后只解码本页请求，不重读全部用量和消息");
  } finally { JSON.parse = parse; }
  const db = new Database(store.dbPath);
  try {
    const indexed = db.prepare("EXPLAIN QUERY PLAN SELECT json FROM session_usage WHERE revision=? ORDER BY rowid LIMIT 50 OFFSET 200").all(pending.revision) as { detail: string }[];
    const previous = db.prepare("EXPLAIN QUERY PLAN SELECT json FROM session_usage INDEXED BY sqlite_autoindex_session_usage_1 WHERE revision=? ORDER BY rowid LIMIT 50 OFFSET 200").all(pending.revision) as { detail: string }[];
    assert.ok(indexed.some(row => row.detail.includes("session_usage_order")));
    assert.ok(!indexed.some(row => row.detail.includes("TEMP B-TREE")));
    assert.ok(previous.some(row => row.detail.includes("TEMP B-TREE")), "行顺序索引消除旧分页的临时排序");
  } finally { db.close(); }
  summary.models[0]!.count = -1;
  assert.notEqual(store.profile(id, { summary: true }).models[0]!.count, -1, "摘要缓存不会泄漏可变对象");
  const timeline = store.timeline(id, { maxEvents: 64, messageId: "message-905" });
  assert.equal(timeline.total, 1300);
  assert.equal(timeline.aggregated, true);
  assert.ok(timeline.events.length <= 64);
  assert.equal(timeline.events.reduce((sum, event) => sum + event.count!, 0), 1300);
  assert.ok(timeline.events.some(event => event.id === "message-905"));
  assert.ok(timeline.events.every(event => !Object.hasOwn(event, "text") && event.rangeStartOrdinal! <= event.ordinal && event.rangeEndOrdinal! >= event.ordinal));
  assert.equal(store.timeline(id).events.length, 1300);
  assert.equal(store.search({ q: "合成正文 1299", kinds: ["assistant"] }).total, 1);
  context.diagnostic(`固定 1300 消息/300 请求：完整轮正文 ${Buffer.byteLength(JSON.stringify(full))} B，有界轮正文 ${Buffer.byteLength(JSON.stringify(bounded))} B；画像摘要 ${Buffer.byteLength(JSON.stringify(summary))} B；完整画像 ${fullProfileMs.toFixed(1)} ms，缓存后 50 请求分页 ${pageMs.toFixed(1)} ms`);
}));

test("轮次用量集合查找与旧关联语义等价，跨轮引用、复制优先级和分支平均不被正文分页裁剪", async context => fixture(store => {
  const id = "bounded-usage-membership";
  const meta: SessionSourceMeta = { id, client: "codex", clientSessionId: id, title: "人工合成轮次关联",
    path: "/workspace/history/usage-membership.jsonl", sourceId: "codex:usage-membership", messageCount: 0, turnCount: 0, models: [], gaps: [],
    branches: [{ id: "a", label: "a", current: true }, { id: "b", label: "b", current: false }] };
  const pending = store.createRevision(meta.path, "synthetic");
  const messages: SessionMessage[] = [
    { id: "shared", sessionId: id, ordinal: 0, recordLine: 1, turnId: "selected", kind: "user", text: "合成问题", branchIds: ["a", "b"], currentBranch: true },
    { id: "selected-a", sessionId: id, ordinal: 1, recordLine: 2, turnId: "selected", kind: "assistant", text: "分支 A", branchIds: ["a"], currentBranch: true },
    { id: "selected-b", sessionId: id, ordinal: 2, recordLine: 3, turnId: "selected", kind: "assistant", text: "分支 B", branchIds: ["b"], currentBranch: false },
    { id: "copied", sessionId: id, ordinal: 3, recordLine: 4, turnId: "selected", kind: "context", text: "复制记录", copied: true },
    { id: "clean", sessionId: id, ordinal: 4, recordLine: 5, turnId: "clean-selected", kind: "user", text: "合成第二轮", branchIds: ["a", "b"], currentBranch: true },
    ...Array.from({ length: 2000 }, (_, index): SessionMessage => ({ id: `selected-context-${index}`, sessionId: id, ordinal: index + 5,
      recordLine: index + 6, turnId: "selected", kind: "context", text: "目标轮合成上下文", branchIds: ["a", "b"], currentBranch: true })),
    ...Array.from({ length: 12_000 }, (_, index): SessionMessage => ({ id: `outside-${index}`, sessionId: id, ordinal: index + 2005,
      recordLine: index + 2006, turnId: `outside-turn-${index % 12}`, kind: "assistant", text: "其他轮合成正文", branchIds: ["a"], currentBranch: true })),
  ];
  for (const message of messages) pending.sink.message(message);
  const timing: NonNullable<SessionUsage["timing"]> = { basis: "estimated", method: "codex_event_boundary", completion: "inferred", durationMs: 5000 };
  const cases: SessionUsage[] = [
    { id: "legacy-clean", turnId: "clean-selected" },
    { id: "direct-cross-turn", turnId: "outside-turn-0", messageId: "selected-a" },
    { id: "end-cross-turn", turnId: "outside-turn-1", timing: { ...timing, end: { messageId: "selected-b" } } },
    { id: "array-cross-turn", turnId: "outside-turn-2", requestMessageIds: ["shared", "selected-a", "selected-a"] },
    { id: "without-turn", messageId: "shared" },
    { id: "turn-arm", turnId: "selected", messageId: "outside-0" },
    { id: "missing-explicit", turnId: "selected", messageId: "not-saved" },
    { id: "direct-precedes-copied-array", turnId: "outside-turn-3", messageId: "outside-0", requestMessageIds: ["selected-a", "copied"] },
    { id: "mixed-branches", requestMessageIds: ["selected-a", "selected-b"] },
    { id: "partial", messageId: "selected-a", timing: { ...timing, completion: "partial" } },
    { id: "copied-direct", messageId: "copied" },
    { id: "copied-array", requestMessageIds: ["selected-a", "copied"] },
    { id: "copied-end", requestMessageIds: ["selected-a"], timing: { ...timing, end: { messageId: "copied" } } },
    { id: "copied-legacy", turnId: "selected" },
    { id: "copied-empty-array", turnId: "selected", requestMessageIds: [] },
    { id: "unknown-link", requestMessageIds: ["not-saved"] },
  ].map((usage, index) => ({ outputTokens: 300 + index * 20, timing, ...usage }));
  // 无关轮请求穿插在目标请求之间，防止按身份排序掩盖原始请求顺序。
  for (let index = 0; index < 1200; index += 1) {
    pending.sink.usage({ id: `outside-request-${index}`, messageId: `outside-${index}`, turnId: `outside-turn-${index % 12}`, outputTokens: 400, timing });
    if (index < cases.length) pending.sink.usage(cases[index]!);
  }
  pending.flush(); store.finishRevision(pending.revision, meta);
  store.publish(store.createJob().id, [{ path: meta.path, fingerprint: "synthetic", revision: pending.revision }], []);
  const db = new Database(store.dbPath, { readonly: true });
  let expected: SessionUsage[];
  const started = performance.now();
  try {
    // 固定旧查询作为语义对照；不复用新的候选集合实现。
    const rows = db.prepare(`SELECT u.json FROM session_usage u WHERE u.revision=?
      AND NOT EXISTS (SELECT 1 FROM session_messages m WHERE m.revision=u.revision AND m.copied=1 AND m.id=u.message_id)
      AND (u.message_id IS NOT NULL OR
        ((json_array_length(u.json,'$.requestMessageIds')>0 OR json_extract(u.json,'$.timing.end.messageId') IS NOT NULL) AND NOT EXISTS
          (SELECT 1 FROM session_messages m WHERE m.revision=u.revision AND m.copied=1 AND m.id IN
            (SELECT value FROM json_each(u.json,'$.requestMessageIds') UNION SELECT json_extract(u.json,'$.timing.end.messageId')))) OR
        (COALESCE(json_array_length(u.json,'$.requestMessageIds'),0)=0 AND json_extract(u.json,'$.timing.end.messageId') IS NULL AND NOT EXISTS
          (SELECT 1 FROM session_messages m WHERE m.revision=u.revision AND m.copied=1 AND m.turn_id=u.turn_id)))
      AND (u.turn_id IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM session_messages m WHERE m.revision=u.revision
        AND m.turn_id IN (SELECT value FROM json_each(?)) AND (m.id=u.message_id OR m.id=json_extract(u.json,'$.timing.end.messageId')
          OR m.id IN (SELECT value FROM json_each(u.json,'$.requestMessageIds'))))) ORDER BY u.rowid`)
      .all(pending.revision, JSON.stringify(["selected", "clean-selected"]), JSON.stringify(["selected", "clean-selected"])) as { json: string }[];
    expected = rows.map(row => JSON.parse(row.json) as SessionUsage);
  } finally { db.close(); }
  const oldMs = performance.now() - started;
  const profile = store.profile(id);
  const expectedSteps = expected.map(usage => profile.steps.find(step => step.id === usage.id)!);
  assert.equal(expected.length, 10);
  for (const branch of [undefined, "a", "b"] as const) {
    const before = performance.now();
    const bounded = store.messages(id, { mode: "full", pageUnit: "turn", pageSize: 2, messageLimit: 1, maxTextChars: 4, branch });
    assert.deepEqual(bounded.usages, expectedSteps, "目标轮全量请求、源顺序与分支身份不依赖正文分页或所选分支");
    assert.deepEqual(summarizeRequestSpeed(bounded.usages!), summarizeRequestSpeed(expectedSteps));
    for (const member of ["a", "b"]) {
      const scoped = (usages: typeof expectedSteps) => usages.filter(usage => usage.branchIds?.includes(member));
      assert.deepEqual(summarizeRequestSpeed(scoped(bounded.usages!)), summarizeRequestSpeed(scoped(expectedSteps)), "各分支平均仍使用完整合格请求");
    }
    assert.equal(bounded.usages!.find(usage => usage.id === "end-cross-turn")!.currentBranch, false);
    assert.deepEqual(bounded.usages!.find(usage => usage.id === "mixed-branches")!.branchIds, []);
    context.diagnostic(`14005 条消息/1216 个请求：旧关联查询 ${oldMs.toFixed(1)} ms，分支 ${branch ?? "默认"} 的有界读取 ${(performance.now() - before).toFixed(1)} ms；完整轮请求 ${bounded.usages!.length} 条`);
  }
}));

test("桌面镜像未变时零正文读取，旁路变化、消失与解析期间改写可靠回退", async () => fixture(async (store, directory) => {
  const root = join(directory, "desktop"); const session = join(root, "example");
  await mkdir(join(session, "message"), { recursive: true }); await mkdir(join(session, "claude-session"));
  const main = join(session, "message/cache.jsonl"); const mirror = join(session, "claude-session/native.jsonl");
  await writeFile(main, encode({ id: "user", kind: "message", role: "user", content: "合成问题", timestamp: at(0) })
    + encode({ id: "answer", kind: "message", role: "assistant", content: "合成回复", timestamp: at(5), usage: { inputTokens: 100, outputTokens: 400 },
      extra: { backend: { type: "CLAUDE_CODE" }, "claude-code": { lastEntryUuid: "a1" } } }));
  const native = (model: string, seconds: number) => encode({ type: "user", uuid: "u0", timestamp: at(0), message: { role: "user" } })
    + encode({ type: "assistant", uuid: "a1", parentUuid: "u0", timestamp: at(seconds), message: { id: "request", model, usage: { output_tokens: 400 }, stop_reason: "end_turn" } });
  await writeFile(mirror, native("model-one", 4));
  const roots = isolatedHistoryRoots({ "codeflicker-desktop": root });
  await refresh(store, roots);
  const first = store.status().version;
  const originalStream = fs.createReadStream; let reads = 0;
  fs.createReadStream = ((...args: Parameters<typeof originalStream>) => {
    if ([main, mirror].includes(String(args[0]))) reads += 1;
    return originalStream(...args);
  }) as typeof originalStream;
  syncBuiltinESMExports();
  try {
    const unchanged = await refresh(store, roots);
    assert.equal(unchanged.counts!.quickReused, 1);
    assert.equal(reads, 0);
    assert.equal(store.status().version, first);
    for (const update of [async () => writeFile(mirror, native("model-two", 8)), async () => rm(mirror),
      async () => writeFile(mirror, native("model-three", 12))]) {
      await update();
      const result = await refresh(store, roots);
      assert.equal(result.counts!.parsed, 1);
      const quick = canonical(store);
      await refresh(store, roots, true);
      assert.deepEqual(canonical(store), quick);
    }
  } finally { fs.createReadStream = originalStream; syncBuiltinESMExports(); }
  await appendFile(main, encode({ id: "second-user", kind: "message", role: "user", content: "合成第二问", timestamp: at(20) }));
  const before = store.status();
  const originalRevision = store.createRevision.bind(store); let changed = false;
  store.createRevision = (path, fingerprint) => {
    const pending = originalRevision(path, fingerprint);
    return { ...pending, sink: { usage: pending.sink.usage, message: value => {
      pending.sink.message(value);
      if (!changed) { changed = true; fs.writeFileSync(mirror, native("model-four", 16)); }
    } } };
  };
  await assert.rejects(refresh(store, roots), /被改写/);
  assert.equal(store.status().version, before.version);
  assert.deepEqual(store.status().clientChecks, before.clientChecks);
  store.createRevision = originalRevision;
}));

test("有界查询参数保留缺省语义并拒绝非法、越界和负偏移", () => {
  assert.equal(sessionMessageQuery({}).messageLimit, undefined);
  assert.equal(sessionMessageQuery({ messageLimit: "40", messageOffset: "0", maxTextChars: "120" }).messageOffset, 0);
  assert.equal(sessionProfileQuery({ summary: "true", stepOffset: "200", stepLimit: "50" }).stepLimit, 50);
  assert.deepEqual(sessionTimelineQuery({ maxEvents: "64", messageId: "message-905" }), { version: undefined, messageId: "message-905", maxEvents: 64 });
  for (const raw of [{ messageLimit: "2001" }, { maxTextChars: "100001" }, { messageOffset: "-1" }]) assert.throws(() => sessionMessageQuery(raw));
  for (const raw of [{ stepLimit: "2001" }, { summary: "yes" }, { stepOffset: "-1" }]) assert.throws(() => sessionProfileQuery(raw));
  assert.throws(() => sessionTimelineQuery({ maxEvents: "5001" }));
});
