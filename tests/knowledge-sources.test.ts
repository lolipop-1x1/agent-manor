import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionStore } from "../src/sessions/store.js";
import { knowledgeMessageHash, SessionKnowledgeReader } from "../src/knowledge/source-reader.js";
import type { SessionMessage, SessionSourceMeta } from "../src/session-contracts.js";
import type { KnowledgeExtractionScope, KnowledgeSource } from "../src/knowledge-contracts.js";
import { readKnowledgeAddress } from "../web/features/knowledge/knowledge-model.js";
import { defaultKnowledgeConfig } from "../src/knowledge/config.js";

const sessionId = "synthetic-knowledge-session";
const scope = (changes: Partial<KnowledgeExtractionScope> = {}): KnowledgeExtractionScope => ({
  timeRange: "all", recentDays: 30, clients: [], projects: [], models: [], title: "", relationship: "all", executionMode: "all", branch: "current", ...changes,
});
const message = (ordinal: number, turn: number, kind: SessionMessage["kind"], text: string, extra: Partial<SessionMessage> = {}): SessionMessage => ({
  id: `synthetic-message-${ordinal}`, sessionId, ordinal, recordLine: ordinal + 1, turnId: `${sessionId}:turn:${turn}`, kind, text,
  occurredAt: `2026-01-${String(turn || 1).padStart(2, "0")}T10:00:00Z`, ...extra,
});
function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "manor-knowledge-sources-")), store = new SessionStore(join(directory, "index.sqlite"));
  const reader = new SessionKnowledgeReader(store); let publication = 0;
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const publish = (messages: SessionMessage[], extra: Partial<SessionSourceMeta> = {}) => {
    publication++;
    const summary: SessionSourceMeta = { id: sessionId, client: "codex", clientSessionId: "synthetic-native-session", path: "/synthetic/history/conversation.jsonl",
      sourceId: "synthetic-source", title: "人工合成排障会话", titleOrigin: "recorded", project: "/projects/atlas", messageCount: 0, turnCount: 0, models: [], gaps: [],
      startedAt: "2026-01-01T10:00:00Z", updatedAt: "2026-01-31T10:00:00Z", ...extra };
    const fingerprint = `synthetic-fingerprint-${publication}`, pending = store.createRevision(summary.path, fingerprint);
    for (const item of messages) pending.sink.message(item);
    pending.flush(); store.finishRevision(pending.revision, summary);
    return store.publish(store.createJob().id, [{ path: summary.path, revision: pending.revision, fingerprint }], []);
  };
  return { store, reader, publish };
}

test("完整输入跨轮次页与单轮 500 条边界读取，工具调用、结果和长正文不丢失", async t => {
  const { reader, publish } = fixture(t), rows = [message(1, 1, "user", "检查动态配置旧值")];
  for (let index = 0; index < 300; index++) {
    const callId = `synthetic-call-${index}`;
    rows.push(message(rows.length + 1, 1, "tool_call", `读取配置 ${index}`, { callId, tool: "Read" }));
    rows.push(message(rows.length + 1, 1, "tool_result", index === 299 ? `完整结果 ${"合成数据".repeat(5_000)}` : `合成结果 ${index}`, { callId, status: "success" }));
  }
  rows.push(message(rows.length + 1, 1, "assistant", "第一轮验证完成", { final: "explicit" }));
  for (let turn = 2; turn <= 22; turn++) {
    rows.push(message(rows.length + 1, turn, "user", `第 ${turn} 轮补充要求`));
    rows.push(message(rows.length + 1, turn, "assistant", `第 ${turn} 轮结果`, { final: "explicit" }));
  }
  publish(rows);
  const targets = await reader.plan(scope()); assert.equal(targets.length, 1);
  assert.equal(targets[0]!.turnCount, 22); assert.equal(targets[0]!.messageIds.length, rows.length);
  const input = await reader.read(targets[0]!);
  assert.deepEqual(input.messages.map(item => item.id), rows.map(item => item.id));
  assert.equal(input.messages.filter(item => item.kind === "tool_call").length, 300);
  assert.equal(input.messages.filter(item => item.kind === "tool_result").length, 300);
  assert.equal(input.messages[600]?.text, rows[600]?.text); assert.equal(input.messages[600]?.text.length, 20_005);
  assert.ok(input.messages.every(item => item.target && !item.textTruncated));
  assert.equal(input.messages.at(-1)?.turnPosition, 22);
});

test("显式会话手动入口可处理Quiet子会话，自动策略继续默认排除", async t => {
  const { reader, publish } = fixture(t);
  publish([message(1, 1, "user", "明确选择这条会话"), message(2, 1, "assistant", "保留可复用结果")], { executionMode: "quiet", relationship: "child", parentSessionId: "synthetic-parent" });
  const manual = readKnowledgeAddress(`#knowledge?page=tasks&sessionId=${sessionId}`).scope!;
  assert.equal(manual.executionMode, "all"); assert.equal(manual.relationship, "all");
  assert.equal((await reader.plan(manual)).length, 1);
  const automatic = defaultKnowledgeConfig().automatic.scope; automatic.timeRange = "all";
  assert.equal(automatic.executionMode, "exclude_quiet"); assert.equal(automatic.relationship, "exclude_children"); assert.equal((await reader.plan(automatic)).length, 0);
});

test("产品来源限制携带稳定消息标识，保留外部缺口原诊断", async t => {
  const { reader, publish } = fixture(t);
  publish([message(1, 1, "compression", "Only retained summary")], { gaps: [{ kind: "unsupported_format", message: "Synthetic external detail" }] });
  const [target] = await reader.plan(scope()); const input = await reader.read(target!);
  assert.ok(target!.limitationDetails?.some(item => item.messageDescriptor?.key === "knowledge.limitation.compressedOnly"));
  assert.ok(input.limitationDetails?.some(item => item.messageDescriptor?.key === "knowledge.limitation.compressedOnly"));
  assert.ok(input.limitationDetails?.some(item => item.message === "Synthetic external detail" && item.messageDescriptor === undefined));
});

test("时间窗口只目标化窗口消息，较早上下文保留且不纳入覆盖，选定轮次包含人和助手全过程", async t => {
  const { reader, publish } = fixture(t), rows = [
    message(1, 1, "user", "最初要求"), message(2, 1, "assistant", "第一次方案"),
    message(3, 2, "user", "更正：保留原始证据"), message(4, 2, "tool_call", "读取证据", { callId: "synthetic-read", tool: "Read" }),
    message(5, 2, "tool_result", "验证日志", { callId: "synthetic-read", status: "success" }), message(6, 2, "assistant", "更正后的结果"),
    message(7, 3, "user", "之后新增要求"), message(8, 3, "assistant", "之后执行结果"),
  ];
  publish(rows);
  const [window] = await reader.plan(scope({ from: "2026-01-02T00:00:00Z", to: "2026-01-02T23:59:59Z" }));
  assert.deepEqual(window?.messageIds, rows.slice(2, 6).map(item => item.id)); assert.equal(window?.turnCount, 1);
  const input = await reader.read(window!);
  assert.deepEqual(input.messages.filter(item => item.target).map(item => item.id), window?.messageIds);
  assert.deepEqual(input.messages.filter(item => !item.target).map(item => item.id), rows.slice(0, 2).map(item => item.id));
  assert.equal(input.messages.some(item => item.turnPosition === 3), false);
  const [selected] = await reader.plan(scope({ turnStart: 2, turnEnd: 2 }));
  assert.deepEqual(selected?.messageIds, window?.messageIds); assert.equal(selected?.turnCount, 1);
  assert.deepEqual((await reader.read(selected!)).messages.filter(item => item.target).map(item => item.kind), ["user", "tool_call", "tool_result", "assistant"]);
  assert.deepEqual(await reader.plan(scope({ turnStart: 4 })), [], "空窗口不能静默扩张为整会话");
});

test("全部分支分别形成目标，共同祖先保留身份，互斥回答不混合", async t => {
  const { reader, publish } = fixture(t), rows = [
    message(1, 1, "user", "共同要求", { branchIds: ["attempt", "current-path"], currentBranch: true }),
    message(2, 1, "assistant", "旧方案失败", { branchIds: ["attempt"], currentBranch: false, final: "explicit" }),
    message(3, 1, "assistant", "新方案验证通过", { branchIds: ["current-path"], currentBranch: true, final: "explicit" }),
  ];
  publish(rows, { branches: [{ id: "attempt", label: "尝试", current: false }, { id: "current-path", label: "当前", current: true }] });
  const targets = await reader.plan(scope({ branch: "all" })); assert.equal(targets.length, 2);
  const attempts = targets.find(item => item.branch === "attempt")!, current = targets.find(item => item.branch === "current-path")!;
  assert.deepEqual(attempts.messageIds, [rows[0]!.id, rows[1]!.id]); assert.deepEqual(current.messageIds, [rows[2]!.id]);
  assert.equal(new Set(targets.flatMap(target => target.messageIds)).size, 3, "共同祖先只计一次目标，其他分支仍保留上下文");
  assert.deepEqual((await reader.read(attempts)).messages.map(item => item.text), ["共同要求", "旧方案失败"]);
  assert.deepEqual((await reader.read(current)).messages.map(item => item.text), ["共同要求", "新方案验证通过"]);
  const [defaultTarget] = await reader.plan(scope());
  assert.deepEqual(defaultTarget?.messageIds, [rows[0]!.id, rows[2]!.id]);
});

test("固定输入哈希和版本必须可核验，新版本不静默替换旧输入，旧版清理后要求重规划", async t => {
  const { reader, publish } = fixture(t), rows = [message(1, 1, "user", "初始正文"), message(2, 1, "assistant", "初始结果")];
  publish(rows); const [target] = await reader.plan(scope());
  await assert.rejects(reader.read({ ...target!, hashes: ["synthetic-wrong-hash", target!.hashes[1]!] }), /changed/);
  await assert.rejects(reader.read({ ...target!, version: "synthetic-missing-version" }), /版本/);
  publish([rows[0]!, { ...rows[1]!, text: "新版本更正" }]);
  assert.equal((await reader.read(target!)).messages.at(-1)?.text, "初始结果", "旧版尚存时读取固定旧输入");
  publish([...rows, message(3, 2, "user", "再次更新")]);
  await assert.rejects(reader.read(target!), /版本/);
});

test("旧输入版本清理后按当前消息身份和内容核验，变化或消失明确分开且不改写证据", async t => {
  const { reader, publish } = fixture(t), rows = [message(1, 1, "user", "保持不变的请求"), message(2, 1, "assistant", "先前结果")];
  const version = publish(rows);
  const source: KnowledgeSource = { kind: "extraction", sessionId, messageId: rows[0]!.id, sourceVersion: version, branch: "current", hash: knowledgeMessageHash(rows[0]!), excerpt: "保存的必要证据" };
  publish([...rows, message(3, 2, "user", "新增要求")]);
  const currentVersion = publish([...rows, message(3, 2, "user", "再次新增要求")]);
  assert.equal((await reader.verify(source)).status, "available"); assert.equal((await reader.verify(source)).currentVersion, currentVersion);
  assert.equal((await reader.verify(source)).sourceVersion, version); assert.equal((await reader.verify(source)).excerpt, source.excerpt);
  publish([{ ...rows[0]!, text: "同身份改写" }, rows[1]!]);
  assert.equal((await reader.verify(source)).status, "changed");
  publish([rows[1]!]); assert.equal((await reader.verify(source)).status, "missing");
  assert.deepEqual(await reader.verify({ kind: "manual" }), { kind: "manual" });
});

test("注入上下文、原生复制与轮次零记录保留为上下文，不伪装为新的抽取目标", async t => {
  const { reader, publish } = fixture(t), rows = [
    message(1, 0, "system", "启动约定"),
    message(2, 1, "context", "注入项目说明", { contextSource: "agents_md", contextEvidence: "client_metadata" }),
    message(3, 1, "user", "已确认复制的旧要求", { copied: true }),
    message(4, 1, "user", "本次实际要求"), message(5, 1, "assistant", "本次实际结果"),
  ];
  publish(rows); const [target] = await reader.plan(scope());
  assert.deepEqual(target?.messageIds, rows.slice(3).map(item => item.id));
  const input = await reader.read(target!);
  assert.deepEqual(input.messages.filter(item => !item.target).map(item => item.id), rows.slice(0, 3).map(item => item.id));
  assert.equal(input.messages.find(item => item.id === rows[0]!.id)?.turnPosition, 0);
});

test("两次模型压缩后仍读取保留的原始对话和工具证据，压缩摘要不替换此前历史", async t => {
  const { reader, publish } = fixture(t), rows = [
    message(1, 1, "user", "最初问题"), message(2, 1, "tool_call", "第一次尝试", { callId: "synthetic-failed", tool: "Test" }),
    message(3, 1, "tool_result", "第一次尝试失败", { callId: "synthetic-failed", status: "failure" }), message(4, 1, "assistant", "需要更换方案"),
    message(5, 1, "compression", "压缩一：曾经尝试方案一"),
    message(6, 2, "user", "采用第二种方案"), message(7, 2, "tool_call", "执行第二种方案", { callId: "synthetic-passed", tool: "Test" }),
    message(8, 2, "tool_result", "第二种方案验证通过", { callId: "synthetic-passed", status: "success" }), message(9, 2, "assistant", "第二种方案完成"),
    message(10, 2, "compression", "压缩二：方案二最终通过"), message(11, 3, "user", "总结可复用方法"), message(12, 3, "assistant", "基于验证结果总结"),
  ];
  publish(rows); const [target] = await reader.plan(scope()); const input = await reader.read(target!);
  assert.deepEqual(input.messages.map(item => item.id), rows.map(item => item.id));
  assert.equal(input.messages.filter(item => item.kind === "compression").length, 2);
  assert.equal(input.messages.find(item => item.id === rows[2]!.id)?.status, "failure");
  assert.equal(input.messages.find(item => item.id === rows[7]!.id)?.status, "success");
  assert.equal(input.limitations.some(item => item.includes("Only compressed")), false);
});
