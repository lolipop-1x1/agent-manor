import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { KnowledgeConversation, KnowledgeInputMessage, KnowledgeSourceReader } from "../src/knowledge-contracts.js";
import { defaultKnowledgeConfig } from "../src/knowledge/config.js";
import type { ChatMessage, KnowledgeGenerationScheduler } from "../src/knowledge/generation.js";
import { KnowledgeExtractionPipeline, type PipelineOptions } from "../src/knowledge/pipeline.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

const empty = { disposition: "no_value", candidates: [], carry: [], needsMessageIds: [], limitations: [] };
const proposal = (reference: string, topic = "configuration", extra: Record<string, unknown> = {}) => ({ ...empty, disposition: "knowledge", candidates: [{ topic, title: "Dynamic configuration", body: "Read runtime configuration when it is used.", type: "procedure", tags: ["configuration"], references: [reference], ...extra }] });
function record(id: string, kind: KnowledgeInputMessage["kind"], text: string, extra: Partial<KnowledgeInputMessage> = {}): KnowledgeInputMessage {
  return { id, sessionId: "synthetic-session", ordinal: Number(id.slice(1)) || 1, recordLine: 1, turnId: "turn-1", turnPosition: 1, kind, text, hash: `hash-${id}`, target: true, ...extra };
}
function source(messages: KnowledgeInputMessage[]): KnowledgeConversation {
  return { session: { id: "synthetic-session", client: "codex", clientSessionId: "synthetic", title: "Synthetic topic routing", project: "/workspace/demo", messageCount: messages.length, models: [], gaps: [] }, version: "v1", branch: "current", messages, limitations: [] };
}
function material(messages: ChatMessage[]): any { return JSON.parse(messages[1]!.content.split("<source_material>\n")[1]!.split("\n</source_material>")[0]!); }
async function run(records: KnowledgeInputMessage[], handler: (payload: any) => unknown, options: PipelineOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-topics-")), store = new KnowledgeStore(join(directory, "knowledge.sqlite"));
  const requests: { payload: any; purpose: string }[] = [];
  const scheduler = { execute: async (_config: unknown, messages: ChatMessage[], _key: unknown, _signal: unknown, _usage: unknown, purpose: string) => { const payload = material(messages); requests.push({ payload, purpose }); return { value: handler(payload) }; } } as unknown as KnowledgeGenerationScheduler;
  const reader = { verify: async (value: unknown) => value } as KnowledgeSourceReader;
  const config = defaultKnowledgeConfig("en"); config.generation.contextTokens = 16_384; config.generation.outputTokens = 512;
  if (options.similarity) config.embedding.mode = "reuse";
  const pipeline = new KnowledgeExtractionPipeline(scheduler, store, reader, options), conversation = source(records), plan = pipeline.plan(conversation, config);
  try {
    const result = await pipeline.run(conversation, config, undefined, undefined, { checkpoint: async () => {}, phase: () => {}, signal: new AbortController().signal });
    return { result, requests, plan };
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}
const longRecords = () => [record("m1", "user", "Investigate configuration behavior. ".repeat(500)), record("m2", "assistant", "Runtime values need careful handling. ".repeat(500))];

test("后续分片可选程序主题卡，主题同义改名仍复用稳定ID，重复关系不额外归并", async () => {
  let extracts = 0;
  const { result, requests } = await run(longRecords(), payload => {
    if (!payload.evidence) throw new Error("No merge call expected for a routed duplicate");
    extracts++;
    if (extracts === 1) return proposal(payload.evidence[0].reference, "dynamic-read");
    if (extracts === 2) { const card = payload.topicCards[0]; assert.equal(card.id, "t1"); assert.equal(card.candidates[0].id, "c1"); return proposal(payload.evidence[0].reference, "runtime-refresh", { topicId: card.id, relatedCandidateId: card.candidates[0].id, relation: "duplicate" }); }
    return empty;
  });
  assert.equal(result.candidates.length, 1); assert.equal(result.checkpoint.candidates[0]!.topicId, "t1"); assert.equal(requests.length, result.checkpoint.next); assert.ok(result.candidates[0]!.sources!.length >= 2);
});

test("语义相似度只召回，模型判断冲突时保留双方而非覆盖", async () => {
  let extracts = 0, compared = 0;
  const { result } = await run(longRecords(), payload => {
    if (payload.earlier) { compared++; return { ...empty, relation: "conflict" }; }
    extracts++; if (extracts > 2) return empty;
    return proposal(payload.evidence[0].reference, extracts === 1 ? "alpha" : "beta", { title: extracts === 1 ? "Startup snapshot" : "Runtime refresh", body: extracts === 1 ? "Retain an initial snapshot for this scenario." : "Resolve values repeatedly for this scenario." });
  }, { similarity: async (_candidate, others) => others.map(() => 0.99) });
  assert.equal(compared, 1); assert.equal(result.candidates.length, 2); assert.ok(result.limitationDetails?.some(detail => detail.messageDescriptor?.key === "knowledge.limitation.topicConflict"));
});

test("明确纠正通过关系判断形成完整候选，未声明关系不能默认覆盖", async () => {
  for (const relation of ["correction", undefined]) {
    let extracts = 0;
    const { result } = await run(longRecords(), payload => {
      if (payload.earlier) return { ...proposal(payload.later.references[0], "configuration", { body: "Explicit correction: use runtime reads after the snapshot approach failed." }), ...(relation ? { relation } : {}) };
      extracts++; return extracts <= 2 ? proposal(payload.evidence[0].reference) : empty;
    });
    assert.equal(result.candidates.length, relation ? 1 : 2);
  }
});

test("不接受模型伪造主题ID；无Embedding时独立知识仍分别保留", async () => {
  await assert.rejects(run(longRecords(), payload => proposal(payload.evidence[0].reference, "configuration", { topicId: "invented-topic" })), /主题标识/);
  let extracts = 0;
  const { result, requests } = await run(longRecords(), payload => { extracts++; return extracts <= 2 ? proposal(payload.evidence[0].reference, "configuration", extracts === 2 ? { topicId: payload.topicCards[0].id, relatedCandidateId: payload.topicCards[0].candidates[0].id, relation: "independent", body: "A separate operational decision." } : {}) : empty; });
  assert.equal(result.candidates.length, 2); assert.notEqual(result.checkpoint.candidates[0]!.topicId, result.checkpoint.candidates[1]!.topicId); assert.ok(requests.every(item => item.purpose === "extract"));
});

test("按位置回读被省略的工具正文，限制回读体量并记录独立用途", async () => {
  const raw = "ordinary output\n".repeat(10_000) + "UNIQUE_DETAIL permission requires explicit scope\n";
  const start = raw.indexOf("UNIQUE_DETAIL");
  const { result, requests } = await run([record("m1", "user", "What constraint applies?"), record("m2", "tool_result", raw)], payload => {
    if (!payload.supplemental) { assert.ok(payload.evidence[1].text.length < 4096); return { ...empty, disposition: "needs_context", needsMessageRanges: [{ messageId: "m2", start, length: 100 }] }; }
    assert.match(payload.supplemental[0].text, /UNIQUE_DETAIL/);
    return proposal(payload.supplemental[0].reference, "permission", { body: "Permission requires an explicit scope." });
  });
  assert.equal(result.needsContext, false); assert.equal(requests.length, 2); assert.equal(requests[1]!.purpose, "reread"); assert.ok(result.checkpoint.rereadBytes! <= 4096); assert.equal(result.candidates[0]!.sources![0]!.hash, "hash-m2");
});

test("只有助手宣称测试通过、工具结果仍失败时，不保存为已验证知识", async () => {
  const records = [record("m1", "assistant", "Tests passed."), record("m2", "tool_result", "Tests failed: incorrect value", { status: "failure" })];
  const { result, requests } = await run(records, payload => proposal(payload.evidence[0].reference, "verification", { body: "Tests passed; this behavior was verified that the value updates." }));
  assert.equal(result.needsContext, true); assert.equal(result.candidates.length, 0); assert.ok(requests.length <= 3); assert.ok(result.limitationDetails?.some(detail => detail.messageDescriptor?.key === "knowledge.limitation.rereadLimit"));
});

test("暂停检查点保留全会话回读额度，恢复后不能重新读取无限正文", async () => {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-reread-resume-")), store = new KnowledgeStore(join(directory, "knowledge.sqlite"));
  const purposes: string[] = [];
  const scheduler = { execute: async (_config: unknown, _messages: unknown, _key: unknown, _signal: unknown, _usage: unknown, purpose: string) => { purposes.push(purpose); return { value: { ...empty, disposition: "needs_context", needsMessageRanges: [{ messageId: "m3", start: 1000, length: 4096 }] } }; } } as unknown as KnowledgeGenerationScheduler;
  const pipeline = new KnowledgeExtractionPipeline(scheduler, store, { verify: async value => value } as KnowledgeSourceReader);
  const config = defaultKnowledgeConfig("en"); config.generation.contextTokens = 16_384; config.generation.outputTokens = 512;
  const conversation = source([...longRecords(), record("m3", "tool_result", "ordinary output\n".repeat(3000))]);
  let saved: import("../src/knowledge/pipeline.js").PipelineCheckpoint | undefined;
  try {
    await assert.rejects(pipeline.run(conversation, config, undefined, undefined, { signal: new AbortController().signal, phase: () => {}, checkpoint: async state => { saved = state; if (state.rereadRequests === 2) throw new Error("synthetic pause"); } }), /synthetic pause/);
    assert.equal(saved?.rereadRequests, 2); assert.equal(purposes.filter(purpose => purpose === "reread").length, 1);
    const resumed = await pipeline.run(conversation, config, undefined, saved, { signal: new AbortController().signal, phase: () => {}, checkpoint: async () => {} });
    assert.equal(resumed.needsContext, true); assert.ok(resumed.checkpoint.rereadRequests! <= 4); assert.ok(resumed.checkpoint.rereadBytes! <= 16_384); assert.ok(purposes.filter(purpose => purpose === "reread").length <= 3);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("旧知识比较出现冲突或没有明确更新关系时，不覆盖原有条目", async () => {
  for (const relation of ["conflict", undefined]) {
    const directory = await mkdtemp(join(tmpdir(), "knowledge-existing-conflict-")), store = new KnowledgeStore(join(directory, "knowledge.sqlite"));
    const old = store.create({ title: "Dynamic configuration", body: "Keep the startup snapshot.", type: "procedure", tags: ["configuration"], scope: { kind: "project", project: "/workspace/demo" }, language: "en" });
    store.review(old.id, { action: "approve", revisionId: old.latestRevisionId });
    const scheduler = { execute: async (_config: unknown, messages: ChatMessage[]) => { const payload = material(messages); return { value: payload.existing ? { ...proposal(payload.incoming.references[0], "configuration", { targetKnowledgeId: old.id }), ...(relation ? { relation } : {}) } : proposal(payload.evidence[0].reference) }; } } as unknown as KnowledgeGenerationScheduler;
    const pipeline = new KnowledgeExtractionPipeline(scheduler, store, { verify: async value => value } as KnowledgeSourceReader);
    try {
      const result = await pipeline.run(source([record("m1", "user", "Use the runtime configuration rather than a startup snapshot.")]), defaultKnowledgeConfig("en"), undefined, undefined, { signal: new AbortController().signal, phase: () => {}, checkpoint: async () => {} });
      assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0]!.targetKnowledgeId, undefined); assert.equal(store.get(old.id).revision.body, "Keep the startup snapshot.");
      if (relation) assert.ok(result.candidates[0]!.sources?.some(item => item.limitationDetails?.some(detail => detail.messageDescriptor?.key === "knowledge.limitation.topicConflict")));
    } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test("duplicate没有明确候选ID时必须核对关系，不能按词法目标直接丢弃正文", async () => {
  let extracts = 0, compared = 0;
  const records = [...longRecords(), record("m3", "assistant", "Review further configuration decisions. ".repeat(500))];
  const { result } = await run(records, payload => {
    if (payload.earlier) { compared++; assert.equal(payload.later.body, "A separate configuration rule must be retained."); return { ...empty, relation: "related" }; }
    extracts++;
    if (extracts === 1) return proposal(payload.evidence[0].reference, "configuration", { body: "The first configuration rule." });
    if (extracts === 2) return proposal(payload.evidence[0].reference, "configuration", { relation: "independent", body: "The second configuration rule." });
    if (extracts === 3) return proposal(payload.evidence[0].reference, "configuration", { relation: "duplicate", body: "A separate configuration rule must be retained." });
    return empty;
  });
  assert.equal(compared, 1); assert.equal(result.candidates.length, 3); assert.ok(result.candidates.some(candidate => candidate.body === "A separate configuration rule must be retained."));
});

test("安装成功不能背书测试通过，标题/摘要/适用条件里的验证断言同样受检查", async () => {
  for (const field of ["title", "summary", "body", "applicability"]) {
    const { result, requests } = await run([record("m1", "user", "Inspect verification evidence."), record("m2", "tool_result", "npm install success", { status: "success", tool: "shell", callId: "install-call" })], payload => proposal(payload.evidence[1].reference, "verification", { [field]: "Tests passed." }));
    assert.equal(result.needsContext, true, field); assert.equal(result.candidates.length, 0, field); assert.equal(requests.length, 1, "No unrelated tool should be reread");
  }
});

test("缺少同轮验证证据时不回读其他轮次的任意成功工具", async () => {
  const records = [record("m1", "tool_result", "npm install success", { status: "success", turnId: "turn-1", turnPosition: 1 }), record("m2", "assistant", "Tests passed.", { turnId: "turn-2", turnPosition: 2 })];
  const { result, requests } = await run(records, payload => proposal(payload.evidence[1].reference, "verification", { body: "Tests passed." }));
  assert.equal(result.needsContext, true); assert.equal(requests.length, 1); assert.equal(result.checkpoint.rereadRequests ?? 0, 0);
});

test("测试断言只补读相关测试记录，不能借同轮安装结果跳过回读", async () => {
  const raw = `${"ordinary output\n".repeat(3000)}Tests passed: cache.test.ts\n`;
  const records = [record("m1", "assistant", "Tests passed: cache.test.ts"), record("m2", "tool_result", "npm install success", { status: "success", callId: "install" }), record("m3", "tool_result", raw, { status: "success", callId: "tests" })];
  let rereads = 0;
  const { result, requests } = await run(records, payload => {
    if (!payload.supplemental) return proposal(payload.evidence[1].reference, "verification", { body: "Tests passed for `cache.test.ts`." });
    rereads++; assert.equal(payload.supplemental[0].messageId, "m3"); assert.match(payload.supplemental[0].text, /Tests passed: cache.test.ts/);
    return proposal(payload.supplemental[0].reference, "verification", { body: "Tests passed for `cache.test.ts`." });
  });
  assert.equal(rereads, 1); assert.equal(result.needsContext, false); assert.equal(result.candidates.length, 1); assert.equal(requests[1]!.purpose, "reread");
});
