import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDoubaoWorkCache } from "../src/history/adapters/doubao-work-store.js";
import { doubaoWorkAdapter } from "../src/history/adapters/doubao-work.js";
import { parseNormalizedSession } from "../src/history/adapters/normalized.js";
import { cacheBatch, cacheBlink, cacheLog, cachePrefix, cacheString, cacheVarint, syntheticCacheEntries, writeDoubaoWorkCache } from "./helpers/doubao-work-store.js";

const account = `DoubaoPC_${createHash("md5").update("synthetic").digest("hex")}`;
const conversation = (id = "synthetic-task", messages: unknown[] = []) => ({ conversation_id: id, name: "合成指定模型任务", conv_version: "2",
  create_time: "1792205000", update_time: "1792205100", messages, extra: { model_item_key: "synthetic-model", agent_task_param: JSON.stringify({ workspace: "/synthetic/project" }) } });
const list = (schema: string, data: Record<string, unknown>, uid = "synthetic") => ({ uid, schema: `conversation-list-data-${schema}`, data });

async function fixture(values: Record<string, unknown>[], run: (current: string) => Promise<void>, legacy?: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-doubao-list-"));
  try {
    const current = await writeDoubaoWorkCache(join(directory, "chat.leveldb"), []);
    const { entries } = syntheticCacheEntries([{ account, value: legacy ?? { downlink_body: { pull_recent_conv_chain_downlink_body: { cells: [] } } } }]);
    entries.push({ key: Buffer.concat([cachePrefix(1), Buffer.from([50, 2, 0])]), value: cacheString("conversationListDataSnapshots") });
    for (const [index, value] of values.entries()) {
      const key = Buffer.alloc(9); key[0] = 3; key.writeBigUInt64BE(BigInt(index), 1);
      entries.push({ key: Buffer.concat([cachePrefix(1, 2, 1), key]), value: Buffer.concat([cacheVarint(1), cacheBlink(value)]) });
    }
    await writeFile(join(directory, "chat.leveldb/000002.log"), cacheLog([cacheBatch(entries)]));
    await run(current);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("五种本机会话列表快照发现摘要并按身份去重，不猜测回复模型", async () => {
  const item = conversation();
  await fixture([
    list("device-group-v1", { devices: [{ conversations: [item] }] }),
    list("non-device-v1", { conversations: [] }), list("non-project-v2", { conversations: [item] }),
    list("overall-v2", { conversations: [item] }), list("project-v4", { projects: [{ conversations: [item] }] }),
  ], async current => {
    const cache = await readDoubaoWorkCache(current);
    assert.equal(cache.records.filter(record => record.store === "conversationListDataSnapshots").length, 5);
    const sources = await doubaoWorkAdapter.discoverFile!({ client: "doubao-work", path: current });
    assert.equal(sources.length, 1);
    const snapshot = await doubaoWorkAdapter.readRecords(sources[0]!);
    const meta = parseNormalizedSession(snapshot, { message() { assert.fail("列表摘要不能补造消息"); }, usage() { assert.fail("列表摘要不能补造请求"); } });
    assert.equal(meta.title, "合成指定模型任务");
    assert.equal(meta.project, "/synthetic/project");
    assert.deepEqual(meta.models, []);
    assert.equal(meta.messageCount, 0);
    assert.equal(meta.startedAt, "2026-10-17T02:43:20.000Z");
    assert.equal(meta.updatedAt, "2026-10-17T02:45:00.000Z");
  });
});

test("列表与旧聚合投影并存时选择完整消息，不因列表较新而丢失正文", async () => {
  const full = { ...conversation(), extra: undefined, conv_extra: { agent_task_param: { workspace: "/synthetic/original" } }, messages: [
    { message_id: "u", user_type: 1, index_in_conv: "1", create_time: "1792205000", content: "合成需求" },
  ] };
  const legacy = { downlink_body: { pull_recent_conv_chain_downlink_body: { cells: [{ conversation: full }] } } };
  await fixture([list("overall-v2", { conversations: [{ ...conversation(), conv_version: "999" }] })], async current => {
    const sources = await doubaoWorkAdapter.discoverFile!({ client: "doubao-work", path: current });
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.sourceCompleteness?.version, 1);
    const snapshot = await doubaoWorkAdapter.readRecords(sources[0]!);
    const meta = parseNormalizedSession(snapshot, { message() {}, usage() {} });
    assert.equal(meta.messageCount, 1);
    assert.equal(meta.project, "/synthetic/original");
  }, legacy);
});

test("列表快照拒绝账号错配、未知结构及损坏分组，不发布空来源", async () => {
  for (const value of [list("overall-v2", { conversations: [] }, "other-account"), list("future-v9", { conversations: [] }),
    list("overall-v2", {}), list("project-v4", { projects: [{}] })]) {
    await fixture([value], async current => {
      await assert.rejects(doubaoWorkAdapter.discoverFile!({ client: "doubao-work", path: current }));
    });
  }
});

test("不同列表投影保留单份原生版本与冲突诊断，不拼接同会话正文", async () => {
  const user = (text: string) => ({ message_id: "u", user_type: 1, index_in_conv: "1", create_time: "1792205000", content: text });
  await fixture([
    list("overall-v2", { conversations: [{ ...conversation("synthetic-task", [user("旧投影")]), conv_version: "1" }] }),
    list("non-project-v2", { conversations: [{ ...conversation("synthetic-task", [user("新投影")]), conv_version: "2" }] }),
  ], async current => {
    const sources = await doubaoWorkAdapter.discoverFile!({ client: "doubao-work", path: current });
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.adapterGap?.kind, "ambiguous");
    const texts: string[] = [];
    const snapshot = await doubaoWorkAdapter.readRecords(sources[0]!);
    const meta = parseNormalizedSession(snapshot, { message(value) { texts.push(value.text); }, usage() {} });
    assert.deepEqual(texts, ["新投影"]);
    assert.equal(meta.messageCount, 1);
    assert.ok(meta.gaps.some(gap => gap.messageDescriptor?.key.endsWith("projectionConflict")));
  });
});

test("已核验的空列表可形成空目录，不补造摘要或消息", async () => {
  await fixture([list("overall-v2", { conversations: [] })], async current => {
    assert.deepEqual(await doubaoWorkAdapter.discoverFile!({ client: "doubao-work", path: current }), []);
  });
});

test("跨缓存消息数相同时选择较新原生版本，不按文件路径选旧摘要", async () => {
  const sources = [];
  for (const [version, path] of [["1", "/synthetic/a/CURRENT"], ["2", "/synthetic/z/CURRENT"]]) {
    await fixture([list("overall-v2", { conversations: [{ ...conversation(), conv_version: version }] })], async current => {
      const discovered = await doubaoWorkAdapter.discoverFile!({ client: "doubao-work", path: current });
      sources.push({ ...discovered[0]!, path: path! });
    });
  }
  const selected = doubaoWorkAdapter.selectSources!(sources);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]!.path, "/synthetic/z/CURRENT");
  assert.equal(selected[0]!.sourceCompleteness?.nativeVersion, "2");
});
