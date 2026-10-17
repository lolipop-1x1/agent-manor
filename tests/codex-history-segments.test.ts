import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";
import Database from "better-sqlite3";
import { discoverSources } from "../src/history/index.js";
import { sourceQuickStamp } from "../src/history/quick-check.js";
import { refreshSessions } from "../src/sessions/refresh.js";
import { SessionStore } from "../src/sessions/store.js";
import { parseSessionSource } from "../src/sessions/parser.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

const encode = (rows: unknown[]) => Buffer.from(rows.map(row => JSON.stringify(row) + "\n").join(""));
const skill = (ordinal: number, id: string, name: string) => ({ ordinal, type: "response_item", timestamp: "2026-01-02T12:00:00Z", payload: {
  id, type: "message", role: "user", content: [{ type: "input_text", text: `<skill><name>${name}</name><path>/synthetic/skills/${name}/SKILL.md</path>正文</skill>` }],
  internal_chat_message_metadata_passthrough: { content_item_kinds: ["skills.selected_skill_instructions"] } } });
const prefix = () => [
  { ordinal: 5, type: "session_meta", payload: { id: "segmented", cwd: "/synthetic/repo", history_base: { thread_id: "ancestor", end_ordinal_exclusive: 5 } } },
  skill(6, "before-cut", "guide-a"),
  { ordinal: 7, type: "response_item", payload: { id: "question", type: "message", role: "user", content: [{ type: "input_text", text: "合成问题" }] } },
];
const continuation = (offset: number, ordinal = 8) => [
  { ordinal, type: "session_meta", payload: { id: "segmented", cwd: "/synthetic/repo", history_base: { thread_id: "segmented", end_byte_offset: offset, end_ordinal_exclusive: ordinal } } },
  skill(9, "after-cut", "guide-b"),
  ...Array.from({ length: 5 }, (_, index) => ({ ordinal: 10 + index, type: "response_item", payload: { id: "answer-" + index, type: "message", role: "assistant", content: [{ type: "output_text", text: "合成回复" }] } })),
];
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-codex-segments-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("同线程压缩续段拼接精确前缀，排除分叉尾部，证据保留原文件与行号，暖刷新不重计", async () => fixture(async directory => {
  const root = join(directory, "before.jsonl.zst"), next = join(directory, "after.jsonl.zst"), content = encode(prefix());
  await writeFile(root, zstdCompressSync(Buffer.concat([content, encode([skill(8, "discarded-tail", "discarded")])])));
  await writeFile(next, zstdCompressSync(encode(continuation(content.length))));
  const store = new SessionStore(join(directory, "index.sqlite"));
  try {
    const refresh = async () => { const job = store.createJob(); await refreshSessions(store, job.id, isolatedHistoryRoots({ codex: [directory] })); return store.getJob(job.id); };
    await refresh();
    const events = [...store.resourceEvents().events];
    assert.deepEqual(events.map(event => event.name), ["guide-a", "guide-b"]);
    assert.equal(store.status().sessionCount, 1);
    assert.equal(events[0]?.source.path, root); assert.equal(events[0]?.source.recordLine, 2);
    assert.equal(events[1]?.source.path, next); assert.equal(events[1]?.source.recordLine, 2);
    const message = store.messages(events[0]!.sessionId, { mode: "trace", messageId: events[0]!.messageId }).messages.find(message => message.id === events[0]!.messageId)!;
    assert.equal(message.sourcePath, root); assert.ok(message.text.includes("guide-a")); assert.notEqual(message.copied, true);
    assert.notEqual(store.list().sessions[0]?.parentSessionId, events[0]!.sessionId);
    const warm = await refresh();
    assert.equal(warm.counts?.parsed, 0); assert.equal(warm.counts?.quickReused, 2);
    assert.deepEqual([...store.resourceEvents().events].map(event => event.id), events.map(event => event.id));
    const changed = prefix(); changed[1] = skill(6, "before-cut", "guide-c");
    await writeFile(root, zstdCompressSync(Buffer.concat([encode(changed), encode([skill(8, "discarded-tail", "discarded")])])));
    await refresh();
    assert.deepEqual([...store.resourceEvents().events].map(event => event.name), ["guide-c", "guide-b"], "前缀文件变化必须使续段缓存失效");
  } finally { store.close(); }
}));

test("分段记录没有原生消息身份时，相同行号仍保留两条独立 Skill 证据", async () => fixture(async directory => {
  const before = prefix();
  for (const row of before) if (row.type === "response_item") delete (row.payload as { id?: string }).id;
  const content = encode(before), after = continuation(content.length);
  for (const row of after) if (row.type === "response_item") delete (row.payload as { id?: string }).id;
  const root = join(directory, "before.jsonl.zst"), next = join(directory, "after.jsonl.zst");
  await writeFile(root, zstdCompressSync(Buffer.concat([content, encode([skill(8, "discarded-tail", "discarded")])])));
  await writeFile(next, zstdCompressSync(encode(after)));
  const database = join(directory, "index.sqlite");
  let store = new SessionStore(database);
  try {
    const refresh = async () => { const job = store.createJob(); await refreshSessions(store, job.id, isolatedHistoryRoots({ codex: [directory] })); return store.getJob(job.id); };
    await refresh();
    const events = [...store.resourceEvents().events];
    assert.deepEqual(events.map(event => event.name), ["guide-a", "guide-b"]);
    assert.equal(new Set(events.map(event => event.messageId)).size, 2);
    assert.deepEqual(events.map(event => [event.source.path, event.source.recordLine]), [[root, 2], [next, 2]]);
    assert.ok(store.cachedRevisions().find(source => source.path === next)!.fingerprint.includes(":history-prefix-v2:"));
    store.close();
    const legacy = new Database(database);
    try {
      legacy.prepare("UPDATE session_revisions SET fingerprint=replace(fingerprint,':history-prefix-v2:',':history-prefix-v1:') WHERE path=?").run(next);
    } finally { legacy.close(); }
    store = new SessionStore(database);
    assert.equal((await refresh()).counts?.parsed, 1, "分段身份规则升级只重建受影响的续段缓存");
    assert.deepEqual([...store.resourceEvents().events].map(event => event.id), events.map(event => event.id));
    const warm = await refresh();
    assert.equal(warm.counts?.parsed, 0);
    assert.deepEqual([...store.resourceEvents().events].map(event => event.id), events.map(event => event.id));
  } finally { store.close(); }
}));

test("分段字节或 ordinal 不匹配、来源缺失与前缀歧义均不能猜测拼接", async () => fixture(async directory => {
  const content = encode(prefix()), root = join(directory, "before.jsonl.zst"), next = join(directory, "after.jsonl.zst");
  await writeFile(root, zstdCompressSync(Buffer.concat([content, encode([skill(8, "discarded-tail", "discarded")])])));
  for (const rows of [continuation(content.length - 1), continuation(content.length, 9)]) {
    await writeFile(next, zstdCompressSync(encode(rows)));
    await assert.rejects(discoverSources({ codex: [directory] }, { clients: ["codex"] }), /前缀/);
  }
  await writeFile(next, zstdCompressSync(encode(continuation(content.length))));
  await writeFile(root, Buffer.concat([zstdCompressSync(Buffer.concat([content, encode([skill(8, "discarded-tail", "discarded")])])), Buffer.from("bad")]));
  await assert.rejects(discoverSources({ codex: [directory] }, { clients: ["codex"] }), /帧/, "可读前缀之后的坏帧也必须核验，不能复用成功前缀");
  await writeFile(root, zstdCompressSync(Buffer.concat([content, encode([skill(8, "discarded-tail", "discarded")])])));
  const selected = (await discoverSources({ codex: [directory] }, { clients: ["codex"] })).find(source => source.historyPrefix)!;
  await writeFile(next, zstdCompressSync(encode(continuation(content.length - 1))));
  await assert.rejects(parseSessionSource(selected, { message: () => {}, usage: () => {} }), /前缀/, "续段头改写不能沿用发现时的绑定");
  await writeFile(next, zstdCompressSync(encode(continuation(content.length))));
  const changed = prefix(); changed[1] = skill(6, "before-cut", "guide-c");
  await writeFile(root, zstdCompressSync(Buffer.concat([encode(changed), encode([skill(8, "discarded-tail", "discarded")])])));
  await assert.rejects(parseSessionSource(selected, { message: () => {}, usage: () => {} }), /前缀/, "发现之后的前缀改写不能用旧依赖哈希发布");
  await writeFile(root, zstdCompressSync(Buffer.concat([content, encode([skill(8, "discarded-tail", "discarded")])])));
  const conflicting = join(directory, "conflict.jsonl.zst");
  await writeFile(conflicting, zstdCompressSync(Buffer.concat([encode(changed), encode([skill(8, "discarded-tail", "discarded")])])));
  await assert.rejects(discoverSources({ codex: [directory] }, { clients: ["codex"] }), /前缀/);
  await rm(conflicting); await rm(root);
  await assert.rejects(discoverSources({ codex: [directory] }, { clients: ["codex"] }), /前缀/);
  await writeFile(root, zstdCompressSync(content));
  await assert.rejects(discoverSources({ codex: [directory] }, { clients: ["codex"] }), /前缀/, "EOF 缺少后续 ordinal 时不猜测前缀边界");
}));

test("同内容的明文及压缩前缀副本不形成歧义，缓存发现升级仍核验原生边界", async () => fixture(async directory => {
  const content = encode(prefix()), raw = Buffer.concat([content, encode([skill(8, "tail", "discarded")])]);
  await writeFile(join(directory, "before.jsonl"), raw);
  await writeFile(join(directory, "before.jsonl.zst"), zstdCompressSync(raw));
  await writeFile(join(directory, "after.jsonl.zst"), zstdCompressSync(encode(continuation(content.length))));
  const sources = await discoverSources({ codex: [directory] }, { clients: ["codex"] });
  const source = sources.find(source => source.historyPrefix)!;
  assert.equal(source.historyPrefix?.path, join(directory, "before.jsonl"));
  assert.equal(source.parentSessionId, undefined, "同线程 history_base 不建立父关系自环");
  const cachedSources = [];
  for (const value of sources) {
    const { historyPrefix: _prefix, historyContinuation: _continuation, discoveryQuickStamp: _stamp, ...location } = value;
    cachedSources.push({ location, stamp: (await sourceQuickStamp(location))! });
  }
  const upgraded = await discoverSources({ codex: [directory] }, { clients: ["codex"], cachedSources });
  assert.deepEqual(upgraded.find(value => value.path === source.path)?.historyPrefix, source.historyPrefix);
}));
