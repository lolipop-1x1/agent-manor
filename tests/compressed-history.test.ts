import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { zstdCompressSync, constants } from "node:zlib";
import test from "node:test";
import { historyBytes, historyHead } from "../src/history/stream.js";
import { historyRecords, MAX_HISTORY_RECORD_BYTES } from "../src/history/records.js";
import { discoverSources, parseSource } from "../src/history/index.js";
import { parseSessionSource } from "../src/sessions/parser.js";
import { readJsonlEvidence } from "../src/history/adapters/jsonl.js";
import type { SessionMessage } from "../src/session-contracts.js";
import { AnalysisStore } from "../src/index/store.js";
import { refreshRepository } from "../src/index/refresh.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

const encode = (rows: unknown[]) => Buffer.from(rows.map(row => JSON.stringify(row) + "\n").join(""));
const rows = [
  { type: "session_meta", payload: { id: "compressed-demo", cwd: "/synthetic/repo" } },
  { type: "response_item", payload: { type: "message", id: "question", role: "user", content: [{ type: "input_text", text: "合成问题" }] } },
  { type: "response_item", payload: { type: "function_call", call_id: "read", name: "exec_command", arguments: JSON.stringify({ cmd: "cat src/demo.ts" }) } },
  { type: "response_item", payload: { type: "function_call_output", call_id: "read", output: JSON.stringify({ exit_code: 0, output: "export const demo = 1;\n" }) } },
];
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-compressed-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function decoded(input: Buffer, maxDecodedBytes?: number) {
  const parts: Buffer[] = [];
  for await (const part of historyBytes("fixture.jsonl.zst", { input: Readable.from([...input].map(byte => Buffer.from([byte]))), maxDecodedBytes })) parts.push(part);
  return Buffer.concat(parts);
}

test("压缩读取逐帧处理拼接、分块和 skippable 帧，原始哈希保持压缩字节", async () => {
  const first = encode(rows.slice(0, 2)), second = encode(rows.slice(2));
  const skip = Buffer.alloc(11); skip.writeUInt32LE(0x184d2a50); skip.writeUInt32LE(3, 4);
  const bytes = Buffer.concat([zstdCompressSync(first), skip, zstdCompressSync(second)]);
  assert.deepEqual(await decoded(bytes), Buffer.concat([first, second]));
  await fixture(async directory => {
    const path = join(directory, "demo.jsonl.zst"); await writeFile(path, bytes);
    const hash = createHash("sha256");
    for await (const _ of historyBytes(path, { onRead: bytes => { hash.update(bytes); } })) { /* 消费完整来源。 */ }
    assert.equal(hash.digest("hex"), createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(await historyHead(path, 17), first.subarray(0, 17));
  });
});

test("共享分行跨 UTF-8、CRLF 与超限分块仍保留行号和字节边界", async () => {
  const first = Buffer.from('"中文🙂"\r\n'), last = Buffer.from('"之后"\n'), tail = Buffer.from('"未完成');
  const chunks = [first.subarray(0, 3), first.subarray(3), Buffer.alloc(MAX_HISTORY_RECORD_BYTES, 120), Buffer.from("x"), Buffer.from("\n"), last, tail];
  const records = [];
  for await (const record of historyRecords(chunks)) records.push(record);
  assert.equal(records[0]!.raw, '"中文🙂"\r');
  assert.equal(records[0]!.end, first.length);
  assert.equal(records[1]!.oversized, true);
  assert.equal(records[1]!.raw, undefined);
  assert.equal(records[2]!.raw, '"之后"');
  assert.equal(records[2]!.line, 3);
  assert.equal(records[2]!.end, first.length + MAX_HISTORY_RECORD_BYTES + 2 + last.length);
  assert.equal(records[3]!.complete, false);
  assert.equal(records[3]!.line, 4);
  assert.equal(records[3]!.raw, undefined);
});

test("截断、无效帧、损坏校验和解压预算不能发布成功前缀", async () => {
  const frame = zstdCompressSync(encode(rows), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  await assert.rejects(decoded(Buffer.alloc(0)));
  await assert.rejects(async () => { for await (const _ of historyBytes("empty.jsonl.zst", { byteLimit: 0 })) { /* 空快照不能冒充完整帧。 */ } });
  for (const length of [1, 4, 6, frame.length - 1]) await assert.rejects(decoded(frame.subarray(0, length)));
  const corrupt = Buffer.from(frame); corrupt[corrupt.length - 1]! ^= 1;
  await assert.rejects(decoded(corrupt));
  await assert.rejects(decoded(Buffer.concat([frame, Buffer.from("bad")])));
  await assert.rejects(decoded(frame, 8), /预算/);
});

test("Codex 冷历史发现、会话、地图与证据读取使用压缩来源和解压行号", async () => fixture(async directory => {
  const path = join(directory, "demo.jsonl.zst"); await writeFile(path, zstdCompressSync(encode(rows)));
  const sources = await discoverSources({ codex: [directory] }, { clients: ["codex"] });
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.sessionId, "compressed-demo");
  const messages = new Map<string, SessionMessage>();
  const summary = await parseSessionSource(sources[0]!, { message: message => { messages.set(message.id, message); }, usage: () => {} });
  assert.equal(summary.turnCount, 1);
  assert.equal(messages.size, 3);
  const parsed = await parseSource(path, "codex");
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.hash, createHash("sha256").update(zstdCompressSync(encode(rows))).digest("hex"));
  const ref = parsed.events[0]!.sources[0]!;
  assert.equal(ref.path, path); assert.equal(ref.recordLine, 3);
  assert.equal((await readJsonlEvidence(ref))?.raw, JSON.stringify(rows[2]));
  await writeFile(join(directory, "demo.jsonl"), encode(rows));
  const copies = await discoverSources({ codex: [directory] }, { clients: ["codex"] });
  assert.equal(copies.length, 2);
  assert.equal(copies[0]?.sourceId, copies[1]?.sourceId, "同一原生来源保留相同身份，发布时按会话择一");
}));

test("压缩源 worker 导入、重复副本、暖刷新与坏帧回退保持计数幂等", async () => fixture(async directory => {
  const { SessionStore } = await import("../src/sessions/store.js");
  const { refreshSessions } = await import("../src/sessions/refresh.js");
  const { isolatedHistoryRoots } = await import("./helpers/history-roots.js");
  const { mkdir } = await import("node:fs/promises");
  const root = join(directory, "sources"); await mkdir(root);
  const path = join(root, "demo.jsonl.zst");
  const content = encode([...rows, { type: "response_item", timestamp: "2026-01-02T12:00:00Z", payload: { type: "function_call", name: "Skill", call_id: "skill", arguments: JSON.stringify({ skill: "guide" }) } }]);
  await writeFile(path, zstdCompressSync(content));
  await writeFile(join(root, "demo.jsonl"), content);
  const store = new SessionStore(join(directory, "index.sqlite"));
  try {
    const refresh = async () => {
      const job = store.createJob(); await refreshSessions(store, job.id, isolatedHistoryRoots({ codex: [root] }), false, { concurrency: 2 });
      return store.getJob(job.id);
    };
    assert.equal((await refresh()).status, "complete");
    const expected = [...store.resourceEvents().events].map(event => event.id);
    assert.equal(expected.length, 1, "明文和压缩副本只发布一个原生会话");
    assert.equal(store.status().sessionCount, 1);
    const event = [...store.resourceEvents().events][0]!;
    assert.equal(event.source.path, join(root, "demo.jsonl"), "相同内容的明文路径稳定优先");
    const profile = store.profile(event.sessionId);
    assert.equal(profile.messageCount, 4); assert.equal(profile.turnCount, 1);
    assert.equal(profile.usage.requests, 2);
    assert.equal(profile.tools.reduce((sum, tool) => sum + tool.calls, 0), 2);
    assert.ok(store.cachedRevisions().find(source => source.path === path)?.fingerprint.includes(createHash("sha256").update(zstdCompressSync(content)).digest("hex")));
    const warm = await refresh();
    assert.equal(warm.counts?.quickReused, 2); assert.equal(warm.counts?.parsed, 0);
    assert.deepEqual([...store.resourceEvents().events].map(event => event.id), expected);
    const version = store.currentVersion();
    await writeFile(path, zstdCompressSync(content).subarray(0, -1));
    await assert.rejects(refresh(), /不完整/);
    assert.equal(store.currentVersion(), version);
    assert.deepEqual([...store.resourceEvents().events].map(event => event.id), expected);
  } finally { store.close(); }
}));

test("解压量和原始输入的预算边界包含等号，超出一字节即失败", async () => {
  const raw = encode(rows), bytes = zstdCompressSync(raw);
  assert.deepEqual(await decoded(bytes, raw.length), raw);
  await assert.rejects(decoded(bytes, raw.length - 1), /预算/);
  const read = async (limit: number) => {
    const parts = [];
    for await (const chunk of historyBytes("demo.jsonl.zst", { input: Readable.from([bytes]), maxInputBytes: limit })) parts.push(chunk);
    return Buffer.concat(parts);
  };
  assert.deepEqual(await read(bytes.length), raw);
  await assert.rejects(read(bytes.length - 1), /原始输入/);
});

test("明文与压缩证据的 16 MiB 限额包含行尾片段，超一字节不回读", async () => fixture(async directory => {
  for (const extra of [0, 1]) {
    const raw = "x".repeat(16 * 1024 * 1024 + extra), hash = createHash("sha256").update(raw).digest("hex");
    for (const compressed of [false, true]) {
      const path = join(directory, `line-${extra}.jsonl${compressed ? ".zst" : ""}`);
      await writeFile(path, compressed ? zstdCompressSync(raw + "\n") : raw + "\n");
      const result = await readJsonlEvidence({ path, recordLine: 1, hash, sourceId: "synthetic", format: "codex-jsonl" });
      assert.equal(result?.raw.length, extra ? undefined : raw.length);
    }
  }
}));

test("超大上下文快照保留缺口，明文与压缩地图均能回查前后活动及原始会话", async () => fixture(async directory => {
  const snapshot = { type: "compacted", replacement_history: [{ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${"x".repeat(16 * 1024 * 1024)}` }] }] };
  const later = [
    { type: "response_item", payload: { type: "function_call", call_id: "after", name: "exec_command", arguments: JSON.stringify({ cmd: "cat src/after.ts" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "after", output: JSON.stringify({ exit_code: 0, output: "export const after = 2;\n" }) } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "压缩前后记录均保留" }] } },
  ];
  const content = encode([...rows, snapshot, ...later]);
  for (const compressed of [true, false]) {
    const path = join(directory, `large.jsonl${compressed ? ".zst" : ""}`);
    const original = compressed ? zstdCompressSync(content) : content;
    await writeFile(path, original);
    const parsed = await parseSource(path, "codex");
    assert.equal(parsed.events.length, 2);
    assert.equal(parsed.events[0]!.status, "success");
    assert.equal(parsed.events[1]!.status, "success");
    assert.deepEqual(parsed.events.map(event => event.sources.map(ref => ref.recordLine)), [[3, 4], [6, 7]]);
    assert.equal(parsed.gaps.filter(gap => gap.kind === "budget_exceeded").length, 1);
    assert.equal(parsed.hash, createHash("sha256").update(original).digest("hex"));
    for (const event of parsed.events) for (const ref of event.sources) {
      const evidence = await readJsonlEvidence(ref);
      assert.ok(evidence, `第 ${ref.recordLine} 行仍可回查`);
      assert.equal(createHash("sha256").update(evidence.raw).digest("hex"), ref.hash);
    }
    const messages: SessionMessage[] = [];
    const summary = await parseSessionSource({ path, client: "codex", format: "codex-jsonl" }, { message: message => { messages.push(message); }, usage: () => {} });
    assert.ok(messages.some(message => message.text === "合成问题"));
    assert.ok(messages.some(message => message.recordLine === 4 && message.text.includes("export const demo")));
    assert.ok(messages.some(message => message.recordLine === 7 && message.text.includes("export const after")));
    assert.ok(messages.some(message => message.text === "压缩前后记录均保留"));
    assert.equal(summary.gaps.filter(gap => gap.kind === "budget_exceeded").length, 1);
    assert.deepEqual(await readFile(path), original, "解析与回查不改写原始历史");
    const repeated = await parseSource(path, "codex", parsed);
    assert.deepEqual(repeated.events, parsed.events);
    assert.deepEqual(repeated.gaps, parsed.gaps);
    if (!compressed) {
      await appendFile(path, encode([{ type: "turn_context", payload: { cwd: "/synthetic/repo" } }]));
      const appended = await parseSource(path, "codex", repeated);
      assert.equal((appended.cursor as { parsedRecords: number }).parsedRecords, 1);
      assert.deepEqual(appended.events, parsed.events);
      assert.deepEqual(appended.gaps, parsed.gaps);
    }
  }
}));

test("地图单行预算包含等号，超限结果保持未知，未换行的尾部留待追加", async () => fixture(async directory => {
  const template = JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "read", output: "" } });
  for (const extra of [0, 1]) {
    const raw = template.replace('"output":""', `"output":"${"x".repeat(16 * 1024 * 1024 - Buffer.byteLength(template) + extra)}"`);
    assert.equal(Buffer.byteLength(raw), 16 * 1024 * 1024 + extra);
    const content = Buffer.concat([encode(rows.slice(0, 3)), Buffer.from(raw + "\n"), encode([rows[1]])]);
    for (const compressed of [false, true]) {
      const path = join(directory, `boundary-${extra}.jsonl${compressed ? ".zst" : ""}`);
      await writeFile(path, compressed ? zstdCompressSync(content) : content);
      const source = await parseSource(path, "codex");
      assert.equal(source.gaps.filter(gap => gap.kind === "budget_exceeded").length, extra);
      assert.equal(source.events[0]!.status, "unknown", "没有已确认成功终态的结果不能当作成功");
      assert.equal(source.events[0]!.sources.length, extra ? 1 : 2);
      assert.equal((source.cursor as { recordLine: number }).recordLine, 5);
    }
  }
  const path = join(directory, "tail.jsonl");
  const tail = Buffer.from(JSON.stringify({ type: "compacted", message: "x".repeat(16 * 1024 * 1024) }));
  const prefix = encode(rows);
  await writeFile(path, Buffer.concat([prefix, tail]));
  const first = await parseSource(path, "codex");
  assert.equal(first.completeBytes, prefix.length);
  assert.ok(first.gaps.some(gap => gap.kind === "incomplete_record"));
  assert.ok(!first.gaps.some(gap => gap.kind === "budget_exceeded"));
  await appendFile(path, "\n");
  const completed = await parseSource(path, "codex", first);
  assert.equal(completed.gaps.filter(gap => gap.kind === "budget_exceeded").length, 1);
  assert.ok(!completed.gaps.some(gap => gap.kind === "incomplete_record"));
  assert.deepEqual(completed.events, first.events);
}));

test("地图刷新发布超限缺口且暖刷新幂等，坏压缩帧仍保留上一完整版本", async () => fixture(async directory => {
  const root = join(directory, "history"), repo = join(directory, "repo");
  await mkdir(root); await mkdir(join(repo, "src"), { recursive: true });
  await promisify(execFile)("git", ["init", "-q", repo]);
  await writeFile(join(repo, "src/demo.ts"), "export const demo = 1;\n");
  const path = join(root, "demo.jsonl.zst");
  const content = encode([
    { type: "session_meta", payload: { id: "large-map-demo", cwd: repo } }, ...rows.slice(1),
    { type: "compacted", replacement_history: [{ role: "user", content: "x".repeat(16 * 1024 * 1024) }] },
    ...rows.slice(2).map(row => ({ ...row, payload: { ...row.payload, call_id: "after" } })),
  ]);
  const frame = zstdCompressSync(content, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  await writeFile(path, frame);
  const store = new AnalysisStore(join(directory, "index.sqlite"));
  try {
    const repository = await store.registerRepository(repo);
    const refresh = async () => { const job = store.createJob(repository.id); await refreshRepository(store, job.id, isolatedHistoryRoots({ codex: [root] })); return store.getJob(job.id); };
    const first = await refresh();
    assert.equal(first.status, "completed", first.error);
    const published = store.getSnapshot(repository.id);
    assert.equal(published.events.length, 2);
    assert.equal(published.gaps.filter(gap => gap.kind === "budget_exceeded").length, 1);
    assert.equal(store.getRepository(repository.id).stale, false);
    assert.equal((await refresh()).status, "completed");
    assert.equal(store.getSnapshot(repository.id).version, published.version);
    assert.deepEqual(store.getSnapshot(repository.id).events, published.events);
    await writeFile(path, frame.subarray(0, -1));
    const failed = await refresh();
    assert.equal(failed.status, "failed");
    assert.equal(store.getSnapshot(repository.id).version, published.version);
    assert.deepEqual(store.getSnapshot(repository.id).events, published.events);
    assert.equal(store.getRepository(repository.id).stale, true);
  } finally { store.close(); }
}));
