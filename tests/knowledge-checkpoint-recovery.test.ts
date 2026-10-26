import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KnowledgeConversation, KnowledgeSourceReader } from "../src/knowledge-contracts.js";
import { defaultKnowledgeConfig } from "../src/knowledge/config.js";
import type { ChatMessage, KnowledgeGenerationScheduler } from "../src/knowledge/generation.js";
import { KnowledgeExtractionPipeline, type PipelineCheckpoint } from "../src/knowledge/pipeline.js";
import { KnowledgeStore } from "../src/knowledge/store.js";

const conversation: KnowledgeConversation = {
  session: { id: "synthetic-session", client: "codex", clientSessionId: "synthetic", title: "Synthetic convention", messageCount: 1, models: [], gaps: [] },
  version: "synthetic-version", branch: "current", limitations: [],
  messages: [{ id: "message-1", sessionId: "synthetic-session", ordinal: 1, recordLine: 1, turnId: "turn-1", turnPosition: 1,
    kind: "user", text: "Preserve the stable configuration naming convention.", hash: "synthetic-hash", target: true }],
};
const proposed = { disposition: "knowledge", candidates: [{ topic: "naming", title: "Stable naming", body: "Preserve stable configuration names.",
  type: "constraint", references: ["reread:message-1:0"] }] };

for (const boundary of ["reread", "segment"] as const) test(`补读${boundary === "reread" ? "请求前" : "分片完成后"}的持久检查点可重启恢复，不重置额度`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-checkpoint-recovery-")), path = join(directory, "knowledge.sqlite");
  let store = new KnowledgeStore(path), calls = 0;
  const scheduler = { execute: async (_config: unknown, messages: ChatMessage[]) => {
    calls++;
    const payload = JSON.parse(messages[1]!.content.split("<source_material>\n")[1]!.split("\n</source_material>")[0]!);
    return { value: payload.supplemental ? proposed : { disposition: "needs_context", candidates: [], needsMessageIds: ["message-1"] } };
  } } as unknown as KnowledgeGenerationScheduler;
  const reader = { verify: async value => value } as KnowledgeSourceReader, config = defaultKnowledgeConfig("en");
  let checkpoint: PipelineCheckpoint | undefined;
  try {
    const pipeline = new KnowledgeExtractionPipeline(scheduler, store, reader);
    await assert.rejects(pipeline.run(structuredClone(conversation), config, undefined, undefined, {
      signal: new AbortController().signal, phase() {}, checkpoint: async state => {
        store.setState("synthetic-checkpoint", state);
        if (boundary === "segment" ? state.next === 1 : state.rereadRequests === 1) throw new Error("synthetic interruption");
      },
    }), /synthetic interruption/);
    store.close(); store = new KnowledgeStore(path);
    checkpoint = store.getState<PipelineCheckpoint>("synthetic-checkpoint");
    assert.ok(checkpoint); assert.equal(checkpoint.rereadRequests, 1);
    const usedBytes = checkpoint.rereadBytes;
    const result = await new KnowledgeExtractionPipeline(scheduler, store, reader).run(structuredClone(conversation), config, undefined, checkpoint, {
      signal: new AbortController().signal, phase() {}, checkpoint: async () => {},
    });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.sources![0]!.excerpt, conversation.messages[0]!.text);
    assert.equal(result.candidates[0]!.sources![0]!.sourceVersion, conversation.version);
    assert.equal(result.checkpoint.rereadRequests, 1); assert.equal(result.checkpoint.rereadBytes, usedBytes);
    assert.equal(calls, 2, "恢复已完成分片不重新调用模型，恢复补读请求只使用已保存材料");
    const legacy = structuredClone(result.checkpoint); delete legacy.rereadEvidence;
    await assert.rejects(pipelineFor(store).run(structuredClone(conversation), config, undefined, legacy, hooks()), { code: "preview_stale" });
    const changed = structuredClone(result.checkpoint); changed.rereadEvidence![0]!.hash = "changed";
    await assert.rejects(pipelineFor(store).run(structuredClone(conversation), config, undefined, changed, hooks()), { code: "source_changed" });
    assert.equal(calls, 2, "不可恢复检查点在发起模型调用前明确失败");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  function pipelineFor(next: KnowledgeStore) { return new KnowledgeExtractionPipeline(scheduler, next, reader); }
  function hooks() { return { signal: new AbortController().signal, phase() {}, checkpoint: async () => {} }; }
});
