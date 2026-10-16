import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverSources, parseSource } from "../src/history/index.js";
import { HISTORY_ADAPTERS, readHistoryEvidence } from "../src/history/adapters/index.js";
import type { HistoryAdapter } from "../src/history/adapters/types.js";
import { DOUBAO_WORK_FORMAT, doubaoWorkAdapter } from "../src/history/adapters/doubao-work.js";
import { normalizedHash } from "../src/history/adapters/normalized.js";
import { parseSessionSource } from "../src/sessions/parser.js";
import { refreshSessions } from "../src/sessions/refresh.js";
import { SessionStore } from "../src/sessions/store.js";
import { deriveRoundFacts } from "../src/sessions/round-metrics.js";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";
import { dialogueMarkdown } from "../web/features/sessions/session-export.js";
import { cacheBatch, cacheLog, cacheManifest, syntheticCacheEntries, writeDoubaoWorkCache } from "./helpers/doubao-work-store.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

const registry = HISTORY_ADAPTERS as HistoryAdapter[];
const textBlock = (id: string, text: string, parent = "0") => ({ block_id: id, block_type: 10000, parent_id: parent, content: { text_block: { text } } });
const message = (id: string, role: number, order: string, blocks: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  message_id: id, user_type: role, index_in_conv: order, create_time: "1700000000", update_time: "1700000001",
  section_id: "shared-section", content_type: 9999, content: "", thinking_content: "", content_block: blocks, ...extra,
});
const response = (values: Record<string, unknown>[]) => ({ downlink_body: { pull_recent_conv_chain_downlink_body: {
  has_more: false, next_conv_version: "7", first_conv_version: "1", cells: values.map(conversation => ({ conversation })),
} } });
const conversation = (messages: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  conversation_id: "9223372036854775807", name: "Synthetic local task", conv_version: "7",
  create_time: "1700000000", update_time: "1700000001", project_reference: { project_id: "synthetic-product-project" }, messages, ...extra,
});

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-doubao-history-"));
  const registered = !registry.some(adapter => adapter.id === DOUBAO_WORK_FORMAT);
  if (registered) registry.push(doubaoWorkAdapter);
  try { await run(directory); }
  finally {
    if (registered) registry.splice(registry.indexOf(doubaoWorkAdapter), 1);
    await rm(directory, { recursive: true, force: true });
  }
}

async function readSession(path: string) {
  const sources = await doubaoWorkAdapter.discoverFile!({ client: "doubao-work", path, format: DOUBAO_WORK_FORMAT });
  assert.equal(sources.length, 1);
  const source = sources[0]!;
  const messages = new Map<string, SessionMessage>();
  const usages: SessionUsage[] = [];
  const meta = await parseSessionSource(source, { message: value => messages.set(value.id, value), usage: value => usages.push(value) });
  return { source, messages: [...messages.values()], usages, meta };
}

test("豆包工作按原生顺序读取块树、用户轮次和工作目录，不把卡片及上下文占用当请求", async () => temporary(async directory => {
  const blocks = [
    { block_id: "thinking", block_type: 10040, parent_id: "0", content: { thinking_block: { finish_title: "Synthetic process" } } },
    textBlock("thought", "Inspect the synthetic source", "thinking"),
    { block_id: "card", block_type: 10019, parent_id: "thinking", is_finish: true, content: { file_operation_block: {
      operation_type: 1, path: "/synthetic/project/src/missing.ts", content: "File does not exist", header: { summary: "Read file" },
    } } },
    textBlock("answer", "Synthetic answer"),
    { block_id: "unknown", block_type: 12345, parent_id: "0", content: { future_block: { text: "Opaque synthetic block" } } },
  ];
  const ext = { general_task_param: { client_option: { workspace: "/synthetic/project", shared_folder_path: ["/synthetic/allowed"] } },
    context_window_usage: { system_prompt: 1, messages: 20, skills: 10, tools: 2, total_window_size: 1000 },
    commerce_model_data_v1: { label: "Model", value: "Display only" }, tea_tags_time_cost: { first_packet_cost_time: "10" },
    input_skill: { skill_id: "synthetic-skill", skill_type: 0 } };
  const native = conversation([
    message("answer-two", 2, "4", [textBlock("reply-two", "Second answer")], { bot_reply_message_id: "user-two", ext }),
    message("user-two", 1, "3", [textBlock("user-text-two", "Second request")], { ext }),
    message("answer-one", 2, "2", blocks, { bot_reply_message_id: "user-one", ext }),
    message("user-one", 1, "1", [textBlock("user-text-one", "First request"), {
      block_id: "attachment", block_type: 10063, parent_id: "0", content: { local_file_block: {
        name: "input.txt", path: "/synthetic/input.txt", uri: "synthetic://attachment", size: "12",
      } },
    }], { ext }),
  ]);
  const path = await writeDoubaoWorkCache(join(directory, "launcher.leveldb"), [{ account: "DoubaoPC_synthetic", value: response([native]) }]);
  const { source, messages, usages, meta } = await readSession(path);
  assert.deepEqual(JSON.parse(source.selector!), ["DoubaoPC_synthetic", "9223372036854775807"]);
  assert.equal(meta.project, "/synthetic/project");
  assert.equal(meta.projectOrigin, "client_metadata");
  assert.equal(meta.turnCount, 2);
  assert.equal(meta.title, "Synthetic local task");
  assert.equal(meta.startedAt, "2023-11-14T22:13:20.000Z");
  assert.deepEqual(messages.filter(value => value.kind === "user").map(value => value.text), ["First request", "input.txt\n/synthetic/input.txt", "Second request"]);
  assert.deepEqual(messages.filter(value => value.kind === "assistant").map(value => value.text), ["Synthetic answer", "Second answer"]);
  assert.equal(messages.find(value => value.text === "Inspect the synthetic source")?.kind, "thinking");
  const card = messages.find(value => value.text.includes("File does not exist"))!;
  assert.equal(card.kind, "context");
  assert.equal(card.status, undefined);
  assert.deepEqual(card.filePaths, ["/synthetic/project/src/missing.ts"]);
  assert.ok(messages.every(value => !value.tool && !value.resource && !value.final && !value.durationMs));
  assert.deepEqual(usages, []);
  assert.ok(meta.gaps.some(gap => gap.messageDescriptor?.key.endsWith("fileCardUnknown")));
  assert.ok(meta.gaps.some(gap => gap.messageDescriptor?.key.endsWith("measurementUnknown")));
  assert.ok(meta.gaps.some(gap => gap.messageDescriptor?.key.endsWith("unknownBlock")));
  const parsed = await parseSource(path, "doubao-work", undefined, DOUBAO_WORK_FORMAT, { location: source });
  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.relationships.length, 0);
  assert.ok(parsed.gaps.some(gap => gap.messageDescriptor?.key.endsWith("cacheOnly")));
  const repeated = await parseSource(path, "doubao-work", parsed, DOUBAO_WORK_FORMAT, { location: source });
  assert.equal((repeated.cursor as { parsedRecords: number }).parsedRecords, 0);
}));

test("豆包工作同会话多投影只选一个来源，账号分区不会因原生会话身份相同而合并", async () => temporary(async directory => {
  const full = conversation([message("u", 1, "1", [textBlock("u-text", "Synthetic request")])]);
  const summary = conversation([]);
  const launcher = await writeDoubaoWorkCache(join(directory, "launcher.leveldb"), [{ account: "DoubaoPC_first", value: response([full]) }]);
  const chat = await writeDoubaoWorkCache(join(directory, "chat.leveldb"), [
    { account: "DoubaoPC_first", value: response([summary]) },
    { account: "DoubaoPC_second", value: response([summary]) },
  ]);
  const locations = (await Promise.all([launcher, chat].map(path => doubaoWorkAdapter.discoverFile!({ path, client: "doubao-work" })))).flat();
  const selected = doubaoWorkAdapter.selectSources!(locations);
  assert.equal(selected.length, 2);
  assert.equal(selected.find(source => source.selector === JSON.stringify(["DoubaoPC_first", full.conversation_id]))?.path, launcher);
  assert.equal(new Set(selected.map(source => source.sourceId)).size, 2);
  const discovered = await discoverSources(isolatedHistoryRoots({ "doubao-work": directory }));
  assert.equal(discovered.length, 2);
  assert.ok(discovered.every(source => source.format === DOUBAO_WORK_FORMAT));
  await writeDoubaoWorkCache(join(directory, "chat.leveldb"), [{ account: "DoubaoPC_first", value: response([conversation([
    message("u", 1, "1", [textBlock("u-text", "Changed request")]),
    message("a", 2, "2", [textBlock("a-text", "Another answer")], { bot_reply_message_id: "u" }),
  ])]) }]);
  const changed = await discoverSources(isolatedHistoryRoots({ "doubao-work": directory }));
  assert.equal(changed.length, 1);
  assert.equal(changed[0]?.path, chat);
  assert.equal(changed[0]?.adapterGap?.kind, "ambiguous");
  const sessionMessages: SessionMessage[] = [];
  const meta = await parseSessionSource(changed[0]!, { message: value => sessionMessages.push(value), usage: () => {} });
  assert.ok(meta.gaps.some(gap => gap.messageDescriptor?.key.endsWith("projectionConflict")));
  assert.ok(!sessionMessages.some(value => value.text === "Synthetic request"));
}));

test("豆包工作原始证据重新定位并校验哈希，缓存替换、会话消失和符号链接不会回读旧副本", async () => temporary(async directory => {
  const origin = join(directory, "launcher.leveldb");
  const initial = conversation([message("u", 1, "1", [textBlock("text", "Initial synthetic text")])]);
  const path = await writeDoubaoWorkCache(origin, [{ account: "DoubaoPC_synthetic", value: response([initial]) }]);
  const { source } = await readSession(path);
  const snapshot = await doubaoWorkAdapter.readRecords!(source);
  const row = snapshot.records.find(value => value.line === 1)!;
  const reference = { sourceId: source.sourceId!, format: DOUBAO_WORK_FORMAT, path, selector: source.selector, recordLine: 1, hash: normalizedHash(row.raw) };
  assert.ok((await readHistoryEvidence(reference))?.raw.includes("Initial synthetic text"));
  assert.equal(await readHistoryEvidence({ ...reference, hash: "different" }), undefined);
  const linked = join(directory, "linked-CURRENT"); await symlink(path, linked);
  assert.equal(await readHistoryEvidence({ ...reference, path: linked }), undefined);
  await writeDoubaoWorkCache(origin, [{ account: "DoubaoPC_synthetic", value: response([conversation([
    message("u", 1, "1", [textBlock("text", "Changed synthetic text")]),
  ])]) }]);
  assert.equal(await readHistoryEvidence(reference), undefined);
  await writeDoubaoWorkCache(origin, [{ account: "DoubaoPC_synthetic", value: response([]) }]);
  assert.deepEqual(await doubaoWorkAdapter.discoverFile!({ client: "doubao-work", path }), []);
  await assert.rejects(doubaoWorkAdapter.readRecords!(source), error => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.equal(await readHistoryEvidence(reference), undefined);
}));

test("豆包工作损坏聚合响应和重复消息身份报错，不能伪装成缓存清理", async () => temporary(async directory => {
  const origin = join(directory, "launcher.leveldb");
  const path = await writeDoubaoWorkCache(origin, [{ account: "DoubaoPC_synthetic", value: { unrelated: [] } }]);
  await assert.rejects(doubaoWorkAdapter.discoverFile!({ client: "doubao-work", path }), /缓存结构/);
  await writeDoubaoWorkCache(origin, [{ account: "DoubaoPC_synthetic", value: response([conversation([
    message("same", 1, "1", [textBlock("one", "One")]), message("same", 1, "2", [textBlock("two", "Two")]),
  ])]) }]);
  const sources = await doubaoWorkAdapter.discoverFile!({ client: "doubao-work", path });
  await assert.rejects(parseSessionSource(sources[0]!, { message: () => {}, usage: () => {} }), /缓存结构/);
  await assert.rejects(doubaoWorkAdapter.readRecords!({ client: "doubao-work", path, selector: "invalid" }), /选择器无效/);
  await assert.rejects(doubaoWorkAdapter.readRecords!({ client: "doubao-work", path }), /缺少账号与会话选择器/);
}));

test("豆包工作回复引用跨用户输入关联原轮次，不将共享 section 或新用户输入当作关系证明", async () => temporary(async directory => {
  const path = await writeDoubaoWorkCache(join(directory, "launcher.leveldb"), [{ account: "DoubaoPC_synthetic", value: response([conversation([
    message("u-one", 1, "1", [textBlock("u-one-text", "First request")]),
    message("u-two", 1, "2", [textBlock("u-two-text", "Second request")]),
    message("a-one", 2, "3", [textBlock("a-one-text", "Reply to first")], { bot_reply_message_id: "u-one" }),
    message("a-two", 2, "4", [textBlock("a-two-text", "Reply to second")], { bot_reply_message_id: "u-two" }),
  ])]) }]);
  const { messages, meta } = await readSession(path);
  assert.equal(meta.turnCount, 2);
  assert.equal(messages.find(value => value.text === "Reply to first")?.turnId, messages.find(value => value.text === "First request")?.turnId);
  assert.equal(messages.find(value => value.text === "Reply to second")?.turnId, messages.find(value => value.text === "Second request")?.turnId);
  assert.notEqual(messages.find(value => value.text === "Reply to first")?.turnId, messages.find(value => value.text === "Second request")?.turnId);
}));

for (const reply of [undefined, "missing-user", "a-one"]) {
  test(`豆包工作缺少有效回复引用 ${String(reply)} 时保留正文但不推定用户轮次`, async () => temporary(async directory => {
    await writeDoubaoWorkCache(join(directory, "launcher.leveldb"), [{ account: "DoubaoPC_synthetic", value: response([conversation([
      message("u-one", 1, "1", [textBlock("u-one-text", "First request")]),
      message("a-one", 2, "2", [textBlock("a-one-text", "First reply")], { bot_reply_message_id: "u-one" }),
      message("u-two", 1, "3", [textBlock("u-two-text", "Second request")]),
      message("a-two", 2, "4", [textBlock("a-two-text", "Unlinked reply")], { bot_reply_message_id: reply }),
    ])]) }]);
    const store = new SessionStore(join(directory, "index.sqlite"));
    try {
      const job = store.createJob({ client: "doubao-work", mode: "full" });
      await refreshSessions(store, job.id, isolatedHistoryRoots({ "doubao-work": directory }));
      const session = store.list().sessions[0]!;
      for (const mode of ["brief", "full", "trace"] as const) {
        const messages = store.messages(session.id, { mode }).messages;
        const unlinked = messages.find(value => value.text === "Unlinked reply")!;
        assert.equal(unlinked.kind, "assistant");
        assert.equal(unlinked.turnId, `${session.id}:turn:0`);
        assert.equal(unlinked.final, undefined);
      }
      const messages = store.messages(session.id, { mode: "full" }).messages;
      const { rounds } = deriveRoundFacts(messages, []);
      assert.deepEqual(rounds.map(round => round.eligible), [true, false]);
      assert.equal(rounds[1]!.end, undefined);
      assert.equal(store.profile(session.id).roundMetrics?.completedTurns, 1);
      const brief = store.messages(session.id, { mode: "brief" }).messages;
      for (const language of ["en", "zh-CN"] as const) assert.ok(dialogueMarkdown(brief, language).includes("Unlinked reply"));
    } finally { store.close(); }
  }));
}

test("豆包工作活动 previous log 缺失导致刷新失败，保留已发布会话、搜索与版本", async () => temporary(async directory => {
  const origin = join(directory, "launcher.leveldb");
  const initial = [{ account: "DoubaoPC_synthetic", value: response([conversation([
    message("u", 1, "1", [textBlock("text", "synthetic searchable previous log")]),
  ])]) }];
  await writeDoubaoWorkCache(origin, initial);
  const { entries } = syntheticCacheEntries(initial);
  await writeFile(join(origin, "000003.log"), cacheLog([cacheBatch(entries.slice(2), 10)]));
  await writeFile(join(origin, "000004.log"), cacheLog([cacheBatch(entries.slice(0, 2), 20)]));
  await writeFile(join(origin, "MANIFEST-000001"), cacheManifest(undefined, 4, 3));
  const store = new SessionStore(join(directory, "index.sqlite"));
  const refresh = async () => {
    const job = store.createJob({ client: "doubao-work", mode: "quick" });
    await refreshSessions(store, job.id, isolatedHistoryRoots({ "doubao-work": directory }));
    return store.getJob(job.id);
  };
  try {
    assert.equal((await refresh()).status, "complete");
    assert.equal(store.list().total, 1);
    assert.equal(store.search({ q: "searchable" }).hits.length, 1);
    const version = store.status().version;
    await unlink(join(origin, "000003.log"));
    await assert.rejects(refresh(), /active log is missing/);
    assert.equal(store.status().job?.status, "failed");
    assert.equal(store.status().version, version);
    assert.equal(store.status().stale, true);
    assert.equal(store.list().total, 1);
    assert.equal(store.search({ q: "searchable" }).hits.length, 1);
  } finally { store.close(); }
}));

test("豆包工作工作目录冲突和块父关系缺口可见，产品项目身份不替代本机项目路径", async () => temporary(async directory => {
  await mkdir(join(directory, "launcher.leveldb"), { recursive: true });
  const path = await writeDoubaoWorkCache(join(directory, "launcher.leveldb"), [{ account: "DoubaoPC_synthetic", value: response([conversation([
    message("u", 1, "1", [textBlock("u-text", "First request")], { ext: { general_task_param: { client_option: { workspace: "/synthetic/one" } } } }),
    message("a", 2, "2", [textBlock("a-text", "Detached text", "missing-parent")], {
      bot_reply_message_id: "u", ext: { general_task_param: { client_option: { workspace: "/synthetic/two" } } },
    }),
  ])]) }]);
  const { meta } = await readSession(path);
  assert.equal(meta.project, undefined);
  assert.ok(meta.gaps.some(gap => gap.messageDescriptor?.key.endsWith("workspaceConflict")));
  assert.ok(meta.gaps.some(gap => gap.messageDescriptor?.key.endsWith("blockParent")));
}));

test("豆包工作刷新失败保留完整版本，只有有效空缓存才移除会话与搜索结果", async () => temporary(async directory => {
  const origin = join(directory, "launcher.leveldb");
  const initial = [{ account: "DoubaoPC_synthetic", value: response([conversation([
    message("u", 1, "1", [textBlock("text", "synthetic searchable cache text")]),
  ])]) }];
  await writeDoubaoWorkCache(origin, initial);
  const store = new SessionStore(join(directory, "index.sqlite"));
  const roots = isolatedHistoryRoots({ "doubao-work": directory });
  const refresh = async () => {
    const job = store.createJob({ client: "doubao-work", mode: "quick" });
    await refreshSessions(store, job.id, roots);
    return store.getJob(job.id);
  };
  try {
    assert.equal((await refresh()).status, "complete");
    assert.equal(store.list().total, 1);
    assert.equal(store.search({ q: "searchable" }).hits.length, 1);
    const repeated = await refresh();
    assert.equal(repeated.status, "complete");
    assert.equal(repeated.counts?.verifiedReused, 1);
    const version = store.status().version;
    await writeDoubaoWorkCache(origin, [{ account: "DoubaoPC_synthetic", value: { unsupported_response: true } }]);
    await assert.rejects(refresh(), /缓存结构/);
    assert.equal(store.status().job?.status, "failed");
    assert.equal(store.status().version, version);
    assert.equal(store.status().stale, true);
    assert.equal(store.list().total, 1);
    assert.equal(store.search({ q: "searchable" }).hits.length, 1);
    await writeDoubaoWorkCache(origin, [{ account: "DoubaoPC_synthetic", value: response([]) }]);
    const removed = await refresh();
    assert.equal(removed.status, "complete");
    assert.equal(removed.counts?.missing, 1);
    assert.equal(store.list().total, 0);
    assert.equal(store.search({ q: "searchable" }).hits.length, 0);
    assert.equal(store.status().stale, false);
  } finally { store.close(); }
}));

test("豆包工作容器重写及无关会话更新不使未变会话失效，摘要元信息变动仍重建", async () => temporary(async directory => {
  const origin = join(directory, "launcher.leveldb");
  const selected = conversation([message("u", 1, "1", [textBlock("text", "Stable synthetic message")])]);
  const unrelated = conversation([message("other-u", 1, "1", [textBlock("other-text", "Initial unrelated text")])], { conversation_id: "other-session" });
  const records = (values: Record<string, unknown>[]) => [{ account: "DoubaoPC_synthetic", value: response(values) }];
  const path = await writeDoubaoWorkCache(origin, records([selected, unrelated]));
  const sources = await doubaoWorkAdapter.discoverFile!({ client: "doubao-work", path });
  const source = sources.find(value => value.selector === JSON.stringify(["DoubaoPC_synthetic", selected.conversation_id]))!;
  const initial = await parseSource(path, "doubao-work", undefined, DOUBAO_WORK_FORMAT, { location: source });
  const changedOther = { ...unrelated, name: "Changed unrelated title", messages: [
    message("other-u", 1, "1", [textBlock("other-text", "Changed unrelated text")]),
  ] };
  // 改写成 SST 还会改变物理布局；当前来源只按其完整会话语义决定复用。
  await writeDoubaoWorkCache(origin, records([changedOther, selected]), { table: true });
  const unchanged = await parseSource(path, "doubao-work", initial, DOUBAO_WORK_FORMAT, { location: source });
  assert.equal(unchanged.hash, initial.hash);
  assert.equal((unchanged.cursor as { parsedRecords: number }).parsedRecords, 0);
  await writeDoubaoWorkCache(origin, records([changedOther, { ...selected, name: "Changed selected title" }]));
  const renamed = await parseSource(path, "doubao-work", unchanged, DOUBAO_WORK_FORMAT, { location: source });
  assert.notEqual(renamed.hash, unchanged.hash);
  assert.ok((renamed.cursor as { parsedRecords: number }).parsedRecords > 0);
}));
