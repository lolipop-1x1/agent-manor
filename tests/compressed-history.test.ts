import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { zstdCompressSync, constants } from "node:zlib";
import test from "node:test";
import { historyBytes, historyHead } from "../src/history/stream.js";
import { discoverSources, parseSource } from "../src/history/index.js";
import { parseSessionSource } from "../src/sessions/parser.js";
import { readJsonlEvidence } from "../src/history/adapters/jsonl.js";
import type { SessionMessage } from "../src/session-contracts.js";

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
