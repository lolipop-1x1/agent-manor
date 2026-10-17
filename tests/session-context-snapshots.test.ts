import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionUsage } from "../src/session-contracts.js";
import { parseSessionSource } from "../src/sessions/parser.js";
import { SessionStore } from "../src/sessions/store.js";

const timestamp = "2026-01-01T00:00:00Z";
const event = (type: string, payload: unknown) => ({ type, timestamp, payload });
const header = event("session_meta", { id: "synthetic-context", cwd: "/synthetic/project" });
const counted = (used: number, extra = {}) => event("event_msg", { type: "token_count", info: {
  last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: used },
  total_token_usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 }, ...extra,
} });

async function parsed(records: unknown[]) {
  const directory = await mkdtemp(join(tmpdir(), "manor-context-snapshots-"));
  const path = join(directory, "fixture.jsonl");
  const usages = new Map<string, SessionUsage>();
  try {
    await writeFile(path, records.map(value => JSON.stringify(value)).join("\n") + "\n");
    const meta = await parseSessionSource({ client: "codex", path, sessionId: "synthetic-context" }, {
      message() {}, usage: value => { usages.set(value.id, value); },
    });
    return { meta, usages: [...usages.values()] };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("Codex 当次上下文进入共享快照，缺容量和分项仍保留未知，累计用量不作占用", async () => {
  const { meta, usages } = await parsed([header, counted(120)]);
  assert.deepEqual(meta.contextSnapshots?.map(({ id: _id, ...value }) => value), [{ occurredAt: timestamp, usedTokens: 120 }]);
  assert.equal(usages.length, 1);
  assert.equal(usages[0]?.inputTokens, 100);
  assert.equal(usages[0]?.outputTokens, 20);
  assert.equal(usages[0]?.contextTokens, 120);
});

test("新版 Codex 只接受明确 context_tokens，不能把 total_tokens 作为上下文", async () => {
  const native = (response: string, usage: unknown) => event("token_usage_record", { response_id: response, usage,
    thread_token_usage: { input_tokens: 1000, output_tokens: 200 } });
  const { meta, usages } = await parsed([header,
    native("synthetic-response", { input_tokens: 100, output_tokens: 20, context_tokens: 115 }),
    native("synthetic-other", { input_tokens: 50, output_tokens: 10, total_tokens: 60 })]);
  assert.deepEqual(meta.contextSnapshots?.map(value => value.usedTokens), [115]);
  assert.equal(usages.length, 2);
});

test("Codex 容量与占用只能取自同一事件，缺失或无效容量不继承上一条", async () => {
  const { meta } = await parsed([header, counted(120, { model_context_window: 1000 }),
    counted(140), counted(150, { model_context_window: 0 }), counted(160, { model_context_window: "2000" }),
    counted(0, { last_token_usage: { total_tokens: 0 }, model_context_window: 2000 })]);
  assert.deepEqual(meta.contextSnapshots?.map(({ usedTokens, capacityTokens }) => ({ usedTokens, capacityTokens })), [
    { usedTokens: 120, capacityTokens: 1000 }, { usedTokens: 140, capacityTokens: undefined },
    { usedTokens: 150, capacityTokens: undefined }, { usedTokens: 160, capacityTokens: undefined },
    { usedTokens: 0, capacityTokens: 2000 },
  ]);
  assert.ok(meta.contextSnapshots?.every(snapshot => snapshot.systemPromptTokens === undefined));
});

test("Codex 压缩内的自身原生上下文快照不丢失，不借用压缩时刻或窗口容量", async () => {
  const native = event("token_usage_record", { response_id: "synthetic-first", usage: { input_tokens: 80, output_tokens: 20, context_tokens: 100 } });
  const compressed = event("compacted", { message: "合成摘要", latest_token_usage_record: {
    thread_id: "synthetic-context", response_id: "synthetic-saved", usage: { input_tokens: 480, output_tokens: 20, context_tokens: 500 },
  } });
  const { meta, usages } = await parsed([header, native, compressed]);
  assert.deepEqual(meta.contextSnapshots?.map(snapshot => snapshot.usedTokens), [100, 500]);
  assert.equal(meta.contextSnapshots?.[1]?.occurredAt, undefined);
  assert.equal(meta.contextSnapshots?.[1]?.capacityTokens, undefined);
  assert.equal(Math.max(...usages.map(usage => usage.contextTokens ?? 0)), 500);
});

test("压缩副本按响应身份去重，不覆盖原始时间或随当前轮次生成重复上下文", async () => {
  const native = (response_id: string, context_tokens: number, at: string) => ({ ...event("token_usage_record", {
    response_id, usage: { input_tokens: context_tokens - 20, output_tokens: 20, context_tokens },
  }), timestamp: at });
  const { meta } = await parsed([header, native("synthetic-old", 100, timestamp),
    native("synthetic-latest", 200, "2026-01-02T00:00:00Z"), event("turn_context", { turn_id: "synthetic-next" }),
    event("compacted", { message: "合成摘要", latest_token_usage_record: { thread_id: "synthetic-context", response_id: "synthetic-latest",
      usage: { input_tokens: 180, output_tokens: 20, context_tokens: 200 } } })]);
  assert.deepEqual(meta.contextSnapshots?.map(({ usedTokens, occurredAt }) => ({ usedTokens, occurredAt })), [
    { usedTokens: 100, occurredAt: timestamp }, { usedTokens: 200, occurredAt: "2026-01-02T00:00:00Z" },
  ]);
});

test("重复原生上下文投影不增加快照，仅上下文状态不补成请求", async () => {
  const zero = counted(0, { last_token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 40 },
    total_token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
  const sample = await parsed([header, counted(120), counted(120), zero]);
  assert.deepEqual(sample.meta.contextSnapshots?.map(value => value.usedTokens), [120, 40]);
  assert.equal(sample.usages.length, 1);
  const invalid = await parsed([header, counted(-1), counted(120, { last_token_usage: { total_tokens: "120" } })]);
  assert.equal(invalid.meta.contextSnapshots, undefined);
});

test("共享存储接受缺容量和分项的上下文快照，子会话范围不改变请求统计", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-context-profile-"));
  const store = new SessionStore(join(directory, "index.sqlite"));
  try {
    const parent = await parsed([header, counted(120)]);
    const sources = [parent.meta, { ...parent.meta, id: "synthetic-child", clientSessionId: "child", path: "/synthetic/child.jsonl",
      parentSessionId: parent.meta.id, relationship: "child" as const, contextSnapshots: [{ id: "child-context", usedTokens: 30 }] }].map(meta => {
      const pending = store.createRevision(meta.path, meta.id);
      store.finishRevision(pending.revision, meta);
      return { path: meta.path, revision: pending.revision, fingerprint: meta.id, meta };
    });
    store.publish(store.createJob().id, sources, []);
    const own = store.profile(parent.meta.id);
    assert.equal(own.contextSnapshots?.length, 1);
    assert.equal(own.contextSnapshots?.[0]?.capacityTokens, undefined);
    assert.equal(own.usage.requests, 0);
    assert.equal(own.usage.inputTokens, null);
    assert.equal(store.profile(parent.meta.id, { includeChildren: true }).contextSnapshots?.length, 2);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
