import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizedRecord, normalizedSnapshot, parseNormalizedSession } from "../src/history/adapters/normalized.js";
import { SessionStore } from "../src/sessions/store.js";
import type { SessionMessage, SessionOperation } from "../src/session-contracts.js";

test("原生操作独立贯通画像、完整及聚合时间线，不生成工具或请求统计", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-operation-records-"));
  const path = join(directory, "index.sqlite");
  let store = new SessionStore(path);
  const types: SessionOperation["type"][] = ["view", "create", "view", "unknown", "view"];
  const records = [normalizedRecord({ key: "user", kind: "user", text: "合成需求", turnKey: "u" }, "{}", 1),
    ...Array.from({ length: 20 }, (_, index) => normalizedRecord({ key: `context-${index}`, kind: "context", text: "合成环境", turnKey: "u" }, "{}", index + 2)),
    ...types.map((type, index) => normalizedRecord({ key: `card-${index}`, kind: "context", text: JSON.stringify({ content: "synthetic card" }),
      operation: { type, label: "Synthetic native card", presentationComplete: true }, turnKey: "u" }, "{}", index + 22))];
  try {
    const snapshots = [normalizedSnapshot({ client: "doubao-work", path: "/synthetic/parent/CURRENT", sessionId: "parent" }, records),
      normalizedSnapshot({ client: "doubao-work", path: "/synthetic/child/CURRENT", sessionId: "child" }, [
        normalizedRecord({ key: "child-card", kind: "context", text: "synthetic child", operation: { type: "edit" } }, "{}", 1),
      ], { parentSessionId: "parent", relationship: "child" })];
    const sources = snapshots.map(snapshot => {
      const pending = store.createRevision(snapshot.source.path, snapshot.hash);
      const meta = parseNormalizedSession(snapshot, pending.sink);
      if (meta.relationship === "child") pending.sink.message({ id: "synthetic-copied", sessionId: meta.id, ordinal: 2, recordLine: 2,
        turnId: "", kind: "context", text: "copied card", operation: { type: "replace" }, copied: true });
      pending.flush(); store.finishRevision(pending.revision, meta);
      return { path: snapshot.source.path, revision: pending.revision, fingerprint: snapshot.hash, meta };
    });
    store.publish(store.createJob().id, sources, []);
    store.close(); store = new SessionStore(path);
    const id = sources[0]!.meta.id;
    const profile = store.profile(id);
    assert.deepEqual(profile.operations?.map(item => [item.type, item.records]), [["view", 3], ["create", 1], ["unknown", 1]]);
    assert.equal(profile.tools.length, 0);
    assert.equal(profile.resources.length, 0);
    assert.equal(profile.usage.requests, 0);
    assert.equal(profile.usage.inputTokens, null);
    assert.equal(profile.steps.length, 0);
    const full = store.timeline(id).events;
    assert.equal(full.filter(event => event.operation).length, 5);
    assert.equal(full.find(event => event.operation)?.operation?.presentationComplete, true);
    assert.ok(full.every(event => !("text" in event)), "时间线不加载卡片正文");
    const grouped = store.timeline(id, { maxEvents: 4 });
    assert.equal(grouped.aggregated, true);
    assert.equal(grouped.events.filter(event => event.operation).reduce((sum, event) => sum + (event.count ?? 1), 0), 5,
      "原生操作不与普通 context 混桶，否则代表节点会丢失操作轨道");
    const event = profile.operations![0]!.firstEvent;
    const detail = store.messages(id, { mode: "full", messageId: event.id });
    assert.ok(detail.messages.some((message: SessionMessage) => message.id === event.id && message.operation?.type === "view"));
    assert.equal(store.profile(id, { includeChildren: true }).operations?.reduce((sum, item) => sum + item.records, 0), 6);
    assert.ok(!store.profile(id, { includeChildren: true }).operations?.some(item => item.type === "replace"), "复制卡不重复计数");
    assert.equal(store.profile(id).operations?.reduce((sum, item) => sum + item.records, 0), 5, "包含子会话不污染自身画像缓存");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
