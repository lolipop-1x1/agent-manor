import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";
import { parseSource, resolveSharedHistory } from "../src/history/index.js";
import { HISTORY_ADAPTERS, readHistoryEvidence } from "../src/history/adapters/index.js";
import type { HistoryAdapter } from "../src/history/adapters/types.js";
import { dshAdapter } from "../src/history/adapters/dsh.js";
import { piAdapter } from "../src/history/adapters/pi.js";
import { normalizedRecord, normalizedSnapshot, parseNormalizedSession } from "../src/history/adapters/normalized.js";
import type { NormalizedEvent, NormalizedSnapshot } from "../src/history/adapters/normalized.js";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";

const DSH_FORMAT = "dsh-jsonl";
const PI_FORMAT = "pi-jsonl";
const encode = (records: unknown[]) => records.map(record => `${JSON.stringify(record)}\n`).join("");

function register(adapter: HistoryAdapter) {
  const adapters = HISTORY_ADAPTERS as HistoryAdapter[];
  if (!adapters.some(item => item.id === adapter.id)) adapters.push(adapter);
}

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-native-event-test-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function sink(snapshot: NormalizedSnapshot) {
  const messages: SessionMessage[] = [];
  const usage: SessionUsage[] = [];
  const metadata = parseNormalizedSession(snapshot, { message: message => messages.push(message), usage: value => usage.push(value) });
  return { messages, usage, metadata };
}

test("归一化 Skill 缺失名与真实同名有独立来源描述", () => {
  const source = { path: "/synthetic/skill-history.jsonl", client: "pi" as const, format: "fixture", sessionId: "skill-history" };
  const events = [{ key: "missing", kind: "tool_call" as const, tool: "Skill", input: {} },
    { key: "recorded", kind: "tool_call" as const, tool: "Skill", input: { skill: "未记录名称" } }];
  const parsed = sink(normalizedSnapshot(source, events.map((event, index) => normalizedRecord(event, JSON.stringify(event), index + 1))));
  assert.deepEqual(parsed.messages[0]?.resource, { kind: "skill_call", name: "未记录名称", nameDescriptor: { key: "sessions.resource.nameUnrecorded" } });
  assert.deepEqual(parsed.messages[1]?.resource, { kind: "skill_call", name: "未记录名称" });
});

function dshEvent(type: string, seq: number, data: Record<string, unknown>, time = 1_800_000_000_000, extra = {}) {
  return { type, seq, time, data, ...extra };
}

function dshHeader(version: number, id: string, extra = {}) {
  return { type: "session", version, id, createdAt: 1_800_000_000_000, isSeeded: false, delegationDepth: 0, cwd: "/synthetic/repo", ...extra };
}

test("DSH 解码压缩代际副本、继承边界、失败尝试、工具证据与完整 Token 桶", async () => temporary(async directory => {
  register(dshAdapter);
  const id = "synthetic-dsh-session";
  const v3 = join(directory, "session.v3.jsonl.zstd");
  const v4 = join(directory, "session.v4.jsonl.zstd");
  const oldLog = encode([dshHeader(3, id)]);
  await writeFile(v3, zstdCompressSync(Buffer.from(oldLog)));
  const rows = [
    dshHeader(4, id, { parentSession: "synthetic-parent", origin: "subagent", delegationDepth: 1, isSeeded: true }),
    dshEvent("user/message", 0, { turn: 0, message: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "inherited prompt" }] } }),
    dshEvent("session/end-seed", 1, { inherited: true }),
    dshEvent("user/message", 2, { turn: 1, message: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "current prompt" }] } }),
    dshEvent("assistant/message", 3, { turn: 1, step: 1, message: { role: "assistant", source: { kind: "model", provider: "synthetic", model: "model-a" },
      content: [{ type: "reasoning", text: "considering" }, { type: "tool-call", id: "read-1", name: "read", arguments: JSON.stringify({ file_path: "src/a.ts", offset: 3 }) }] } }),
    dshEvent("tool/call", 4, { turn: 1, step: 1, callId: "read-1", name: "read", arguments: JSON.stringify({ file_path: "src/a.ts", offset: 3 }) }),
    dshEvent("tool/result", 5, { turn: 1, step: 1, message: { role: "tool", toolCallId: "read-1", isError: false,
      content: [{ type: "text", text: "3: gamma\n\n(End of file - total 3 lines)" }] },
      meta: { path: "src/a.ts", offset: 3, lines: [{ number: 3, text: "gamma" }], totalLines: 3 } }),
    dshEvent("assistant/attempt", 6, { turn: 1, step: 2, stream: [{ type: "text", text: "retrying" }] }),
    dshEvent("assistant/message", 7, { turn: 1, step: 2, usage: { inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 5, reasoningTokens: 2 },
      message: { role: "assistant", source: { kind: "model", model: "model-a" }, content: [{ type: "text", text: "finished" }] } }),
    dshEvent("turn/end", 8, { turn: 1, reason: { kind: "completed" } }),
    dshEvent("tool/call", 9, { turn: 1, step: 3, callId: "edit-1", name: "edit", arguments: JSON.stringify({ file_path: "src/a.ts", old_string: "old", new_string: "new" }) }),
    dshEvent("tool/result", 10, { turn: 1, step: 3, message: { role: "tool", toolCallId: "edit-1", isError: false, content: [{ type: "text", text: "updated" }] },
      meta: { diffs: [{ path: "src/a.ts", oldText: "before\nold\nafter", newText: "before\nnew\nafter" }] } }),
    dshEvent("tool/call", 11, { turn: 1, step: 4, callId: "bash-1", name: "bash", arguments: JSON.stringify({ command: "cat src/a.ts" }) }),
    dshEvent("tool/result", 12, { turn: 1, step: 4, message: { role: "tool", toolCallId: "bash-1", isError: false, content: [{ type: "text", text: "alpha\nbeta" }] } }),
    dshEvent("tool/call", 13, { turn: 1, step: 5, callId: "bash-failure", name: "bash", arguments: JSON.stringify({ command: "cat src/a.ts" }) }),
    dshEvent("tool/result", 14, { turn: 1, step: 5, message: { role: "tool", toolCallId: "bash-failure", isError: false, content: [{ type: "text", text: "partial\n[exit code: 1]" }] } }),
    dshEvent("compaction/summary", 15, { summary: [{ type: "text", text: "older context summarized" }], usage: { inputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 1 } }),
  ];
  const frames = [rows.slice(0, 1), rows.slice(1, 9), rows.slice(9)];
  await writeFile(v4, Buffer.concat(frames.map(frame => zstdCompressSync(Buffer.from(encode(frame))))));
  const [oldSource] = await dshAdapter.discoverFile!({ client: "dsh", format: DSH_FORMAT, path: v3 });
  const [newSource] = await dshAdapter.discoverFile!({ client: "dsh", format: DSH_FORMAT, path: v4 });
  assert.ok(oldSource && newSource);
  assert.equal(newSource.sessionId, id);
  assert.deepEqual(dshAdapter.selectSources!([oldSource, newSource]).map(source => source.path), [v4]);

  const parsed = await parseSource(v4, "dsh", undefined, DSH_FORMAT, { location: newSource });
  assert.equal(parsed.sessionId, id);
  assert.equal(parsed.relationships[0]?.kind, "subagent");
  assert.equal(parsed.relationships.find(relationship => relationship.kind === "fork")?.endOrdinalExclusive, 1);
  const parentPath = join(directory, "parent.jsonl");
  await writeFile(parentPath, encode([dshHeader(4, "synthetic-parent"),
    dshEvent("user/message", 0, { turn: 0, message: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "parent prompt" }] } })]));
  const [parentSource] = await dshAdapter.discoverFile!({ client: "dsh", format: DSH_FORMAT, path: parentPath });
  const parent = await parseSource(parentPath, "dsh", undefined, DSH_FORMAT, { location: parentSource });
  const shared = resolveSharedHistory([parent, parsed]);
  assert.equal(shared.relationships.find(item => item.sourceId === parsed.sourceId && item.relationship.kind === "fork")?.resolved, true);
  const snapshot = await dshAdapter.readRecords!({ client: "dsh", format: DSH_FORMAT, path: v4 });
  const session = sink(snapshot as NormalizedSnapshot);
  assert.equal(session.metadata.turnCount, 2);
  const inherited = session.messages.find(message => message.text === "inherited prompt");
  assert.equal(inherited?.copied, true);
  assert.ok(session.messages.some(message => message.kind === "thinking" && message.text === "considering"));
  assert.equal(session.messages.find(message => message.text === "finished")?.final, undefined, "终答后的工具活动撤销早期完成依据");
  assert.equal(session.messages.find(message => message.text === "retrying")?.final, undefined);
  assert.equal(session.usage.length, 4, "两个原生用量加上两个已识别但缺失用量的请求");
  assert.equal(new Set(session.usage.map(value => value.id)).size, 4, "每个请求只发布一次最终用量");
  const response = session.messages.find(message => message.text === "finished")!;
  const compression = session.messages.find(message => message.kind === "compression")!;
  const recordedUsage = [response, compression].map(message => session.usage.find(value => value.messageId === message.id)!);
  assert.deepEqual(recordedUsage.map(value => [value.inputTokens, value.cachedInputTokens, value.cacheWriteTokens, value.outputTokens, value.reasoningOutputTokens]), [
    [13, 2, 1, 5, 2], [2, 0, 0, 1, 1],
  ]);
  assert.equal(recordedUsage[0]?.turnId, response.turnId, "用量仍定位到原生回复及其轮次");
  const missingUsage = session.usage.filter(value => value.outputTokens === undefined);
  assert.equal(missingUsage.length, 2);
  assert.ok(missingUsage.every(value => value.messageId === undefined && value.inputTokens === undefined));
  for (const text of ["considering", "retrying"]) {
    const message = session.messages.find(value => value.text === text)!;
    assert.ok(missingUsage.some(value => value.requestMessageIds?.includes(message.id)), "缺失用量保留对应模型消息组");
  }
  assert.equal(missingUsage.find(value => value.timing?.completion === "partial")?.requestMessageIds?.length, 1,
    "失败尝试保留独立请求和部分响应状态");
  assert.equal(compression.text, "older context summarized");

  const reads = parsed.events.filter(event => event.tool === "read");
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.kind, "read");
  assert.equal(reads[0]!.fragments[0]?.content, "gamma");
  const edits = parsed.events.filter(event => event.tool === "edit");
  assert.equal(edits[0]!.fragments.find(fragment => fragment.kind === "added")?.content, "new\n");
  const bash = parsed.events.find(event => event.tool === "bash");
  assert.equal(bash?.fragments[0]?.content, "alpha\nbeta");
  const failedBash = parsed.events.find(event => event.tool === "bash" && event.fragments.length === 0);
  assert.equal(failedBash?.status, "failure");
  const readRequest = await readHistoryEvidence(reads[0]!.sources[0]!);
  const readResult = await readHistoryEvidence(reads[0]!.sources[1]!);
  assert.ok(readRequest?.raw.includes('"type":"tool/call"'));
  assert.ok(readResult?.raw.includes('"type":"tool/result"'));
}));

test("Pi 原生 Skill 展开进入读取统计，普通提及与不完整包装不计使用", async () => temporary(async directory => {
  const path = join(directory, "pi-skill.jsonl");
  const skill = "/synthetic/skills/demo/SKILL.md";
  const expanded = `<skill name="demo" location="${skill}">\nReferences are relative to /synthetic/skills/demo.\n\ninstructions\n</skill>\n\ninspect the example`;
  await writeFile(path, encode([
    { type: "session", version: 3, id: "pi-skill", timestamp: "2026-01-01T00:00:00Z", cwd: "/synthetic/repo" },
    { type: "message", id: "expanded", parentId: null, message: { role: "user", content: [{ type: "text", text: expanded }] } },
    { type: "message", id: "mention", parentId: "expanded", message: { role: "user", content: "/skill:demo" } },
    { type: "message", id: "malformed", parentId: "mention", message: { role: "user", content: expanded.replace("/synthetic/skills/demo.\n", "/synthetic/other.\n") } },
  ]));
  const snapshot = await piAdapter.readRecords!({ path, client: "pi", format: "pi-jsonl" }) as NormalizedSnapshot;
  const parsed = sink(snapshot);
  assert.equal(parsed.metadata.turnCount, 3);
  const resources = parsed.messages.filter(message => message.resource);
  assert.equal(resources.length, 1);
  assert.equal(resources[0]?.kind, "user", "保留原生用户消息，不补造工具调用");
  assert.deepEqual(resources[0]?.resource, { kind: "skill_read", name: "demo", path: skill });
  assert.equal(resources[0]?.status, "success");
}));

test("DSH V3 工具结果包装保留调用配对，缺失缓存桶时不伪造总输入", async () => temporary(async directory => {
  register(dshAdapter);
  const path = join(directory, "session.v3.jsonl");
  await writeFile(path, encode([
    dshHeader(3, "synthetic-v3"),
    dshEvent("tool/call", 0, { turn: 1, step: 1, callId: "call-v3", name: "read", arguments: JSON.stringify({ file_path: "src/old.ts" }) }),
    dshEvent("tool/result", 1, { turn: 1, step: 1, message: { role: "user", content: [{ type: "tool-result", toolCallId: "call-v3", isError: false,
      content: [{ type: "text", text: "old result" }] }] } }),
    dshEvent("assistant/message", 2, { turn: 1, step: 1, usage: { inputTokens: 9, outputTokens: 4, reasoningTokens: 2 },
      message: { role: "assistant", source: { model: "legacy-model" }, content: [{ type: "text", text: "done" }] } }),
  ]));
  const parsed = await parseSource(path, "dsh", undefined, DSH_FORMAT);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0]!.status, "success");
  assert.equal(parsed.events[0]!.output && JSON.stringify(parsed.events[0]!.output).includes("old result"), true);
  const session = sink(await dshAdapter.readRecords!({ client: "dsh", format: DSH_FORMAT, path }) as NormalizedSnapshot);
  assert.equal(session.usage[0]?.inputTokens, undefined);
  assert.equal(session.usage[0]?.outputTokens, 4);
}));

test("DSH 总量恒等式核验缺省缓存桶，缺失或冲突总量仍保持未知", async () => temporary(async directory => {
  const path = join(directory, "session.v4.jsonl");
  const usages = [{ inputTokens: 100, cacheReadTokens: 80, outputTokens: 10, totalTokens: 190 },
    { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    { inputTokens: 100, cacheReadTokens: 80, outputTokens: 10, totalTokens: 110 },
    { inputTokens: 100, outputTokens: 10 },
    { inputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: -1, outputTokens: 10, totalTokens: 190 }];
  await writeFile(path, encode([dshHeader(4, "synthetic-total-usage"), ...usages.map((usage, seq) =>
    dshEvent("assistant/message", seq, { turn: 1, step: seq + 1, usage,
      message: { role: "assistant", source: { kind: "model", model: "synthetic-model" }, content: [{ type: "text", text: "合成响应" }] } }))]));
  const session = sink(await dshAdapter.readRecords!({ path, client: "dsh", format: DSH_FORMAT }) as NormalizedSnapshot);
  assert.deepEqual(session.usage.map(item => item.inputTokens), [180, 100, undefined, undefined, undefined]);
  assert.deepEqual(session.usage.map(item => item.cachedInputTokens), [80, 0, 80, undefined, 80]);
  assert.deepEqual(session.usage.map(item => item.cacheWriteTokens), [0, 0, undefined, undefined, undefined]);
}));

test("DSH 官方过程事件与未知语义 gap 不令完整 V3 输给损坏 V4", async () => temporary(async directory => {
  register(dshAdapter);
  const id = "synthetic-dsh-boundaries";
  const v3 = join(directory, "session.v3.jsonl");
  const v4 = join(directory, "session.v4.jsonl");
  await writeFile(v3, encode([
    dshHeader(3, id),
    dshEvent("turn/start", 0, { turn: 1 }),
    dshEvent("step/start", 1, { turn: 1, step: 1 }),
    dshEvent("request/header", 2, { turn: 1, reason: "synthetic" }),
    dshEvent("request/context", 3, { turn: 1, route: "synthetic" }),
    dshEvent("user/message", 4, { turn: 1, message: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "synthetic prompt" }] } }),
    dshEvent("assistant/message", 5, { turn: 1, step: 1, message: { role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "synthetic answer" }] } }),
    dshEvent("step/end", 6, { turn: 1, step: 1 }),
    dshEvent("turn/end", 7, { turn: 1, reason: { kind: "completed" } }),
    dshEvent("future/native-event", 8, { turn: 1, payload: "unknown semantic event" }),
  ]));
  await writeFile(v4, `${JSON.stringify(dshHeader(4, id))}\n{invalid}\n`);
  const [sourceV3] = await dshAdapter.discoverFile!({ client: "dsh", format: DSH_FORMAT, path: v3 });
  const [sourceV4] = await dshAdapter.discoverFile!({ client: "dsh", format: DSH_FORMAT, path: v4 });
  assert.equal(sourceV3?.sourceCompleteness?.complete, true);
  assert.equal(sourceV4?.sourceCompleteness?.complete, false);
  assert.deepEqual(dshAdapter.selectSources!([sourceV4!, sourceV3!]).map(source => source.path), [v3]);
  const snapshot = await dshAdapter.readRecords!({ ...sourceV3! });
  const processEvents = snapshot.records.flatMap(row => row.record.normalizedEvent ? [row.record.normalizedEvent] : [])
    .filter(event => event.text?.startsWith("DSH 过程事件"));
  assert.deepEqual(processEvents.map(event => event.text), [
    "DSH 过程事件 turn/start turn=1",
    "DSH 过程事件 step/start turn=1 step=1",
    "DSH 过程事件 request/header",
    "DSH 过程事件 request/context",
    "DSH 过程事件 step/end turn=1 step=1",
  ]);
  assert.ok(processEvents.every(event => event.textDescriptor?.key === "sessions.body.dshEvent"));
  assert.ok(snapshot.meta.gaps?.some(gap => gap.kind === "unsupported_format" && gap.message.includes("future/native-event")));
  assert.ok(snapshot.records.some(row => row.record.normalizedEvent?.text === "未适配事件 future/native-event"
    && JSON.parse(row.raw).type === "future/native-event"));
  assert.equal(sink(snapshot as NormalizedSnapshot).metadata.turnCount, 1);
  const localized = sink(snapshot as NormalizedSnapshot).messages;
  assert.equal(localized.find(message => message.text === "synthetic prompt")?.textDescriptor, undefined);
  assert.equal(localized.find(message => message.text === "synthetic answer")?.textDescriptor, undefined);
  assert.deepEqual(localized.find(message => message.text === "未适配事件 future/native-event")?.textDescriptor,
    { key: "sessions.body.unsupportedEvent", params: { type: "future/native-event" } });
}));

test("DSH 未知代际仍保留来源并显式标记 unsupported_format", async () => temporary(async directory => {
  register(dshAdapter);
  const path = join(directory, "session.v5.jsonl");
  await writeFile(path, encode([
    dshHeader(5, "synthetic-v5"),
    dshEvent("user/message", 0, { turn: 0, message: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "future format" }] } }),
    dshEvent("future/native-event", 1, { turn: 0, payload: "unknown but retained" }),
  ]));
  const [source] = await dshAdapter.discoverFile!({ client: "dsh", format: DSH_FORMAT, path });
  assert.equal(source?.sessionId, "synthetic-v5");
  assert.equal(source?.selector, "v5");
  assert.equal(source?.sourceCompleteness?.supported, false);
  assert.equal(source?.sourceCompleteness?.complete, true);
  assert.equal(dshAdapter.selectSources!([source!]).length, 1);
  const supportedCopy = { ...source!, selector: "v4", path: join(directory, "session.v4.jsonl"),
    sourceCompleteness: { version: 4, supported: true, complete: true, fingerprint: "synthetic-complete" } };
  assert.deepEqual(dshAdapter.selectSources!([source!, supportedCopy])
    .map(selected => selected.selector), ["v4"]);
  const snapshot = await dshAdapter.readRecords!({ client: "dsh", format: DSH_FORMAT, path });
  assert.ok((snapshot as NormalizedSnapshot).meta.gaps?.some(gap => gap.kind === "unsupported_format"));
  assert.ok((snapshot as NormalizedSnapshot).records.some(row => row.record.normalizedEvent?.kind === "context"
    && row.record.normalizedEvent.text === "未适配事件 future/native-event"));
}));

test("DSH 同身份副本优先选择完整旧代际，记录不完整新副本缺口", async () => temporary(async directory => {
  register(dshAdapter);
  const id = "synthetic-duplicate";
  const v3 = join(directory, "session.v3.jsonl");
  const v4 = join(directory, "session.v4.jsonl");
  await writeFile(v3, encode([dshHeader(3, id), dshEvent("user/message", 0,
    { turn: 0, message: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "complete v3" }] } })]));
  await writeFile(v4, `${encode([dshHeader(4, id)])}{"type":"user/message","seq":1,"data":`);
  const [oldSource] = await dshAdapter.discoverFile!({ client: "dsh", format: DSH_FORMAT, path: v3 });
  const [newSource] = await dshAdapter.discoverFile!({ client: "dsh", format: DSH_FORMAT, path: v4 });
  const [selected] = dshAdapter.selectSources!([newSource!, oldSource!]);
  assert.equal(selected?.path, v3);
  assert.match(selected?.adapterGap?.message ?? "", /v4.*v3/);
  assert.match(selected?.adapterGap?.message ?? "", /不完整副本未用于覆盖完整来源/);
  assert.equal(selected?.adapterGap?.messageDescriptor?.key, "diagnostics.history.adapters.dsh.copies");
  assert.ok(selected?.adapterGap?.details?.some(detail => detail.key === "diagnostics.history.adapters.dsh.incompleteExcluded"));
  const parsedCopy = await dshAdapter.readRecords!(selected!);
  const copyGap = (parsedCopy as NormalizedSnapshot).records[0]?.record.normalizedMeta?.gaps?.find(gap => gap.messageDescriptor?.key === "diagnostics.history.adapters.dsh.copies");
  assert.deepEqual(copyGap?.details, selected?.adapterGap?.details);

  const conflictV3 = join(directory, "conflict.v3.jsonl");
  const conflictV4 = join(directory, "conflict.v4.jsonl");
  await writeFile(conflictV3, encode([dshHeader(3, "synthetic-conflict"), dshEvent("user/message", 0,
    { turn: 0, message: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "version three" }] } })]));
  await writeFile(conflictV4, encode([dshHeader(4, "synthetic-conflict"), dshEvent("user/message", 0,
    { turn: 0, message: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "version four" }] } })]));
  const [conflictSourceV3] = await dshAdapter.discoverFile!({ client: "dsh", format: DSH_FORMAT, path: conflictV3 });
  const [conflictSourceV4] = await dshAdapter.discoverFile!({ client: "dsh", format: DSH_FORMAT, path: conflictV4 });
  const [conflictSelected] = dshAdapter.selectSources!([conflictSourceV3!, conflictSourceV4!]);
  assert.equal(conflictSelected?.path, conflictV4);
  assert.equal(conflictSelected?.adapterGap?.kind, "ambiguous");
  assert.match(conflictSelected?.adapterGap?.message ?? "", /完整副本的规范化事件存在冲突/);
  assert.ok(conflictSelected?.adapterGap?.details?.some(detail => detail.key === "diagnostics.history.adapters.dsh.copiesConflict"));
  assert.match(conflictSelected?.adapterGap?.message ?? "", /选择完整且已适配的来源 v4/);
}));

test("DSH 完整 V3 与 V4 同身份副本只选择一份，并保留明确服务商", async () => temporary(async directory => {
  const paths = [join(directory, "same.v3.jsonl"), join(directory, "same.v4.jsonl")];
  const sources = [];
  for (const [index, path] of paths.entries()) {
    await writeFile(path, encode([dshHeader(index + 3, "same-synthetic-session"),
      dshEvent("assistant/message", 1, { turn: 1, step: 1,
        message: { role: "assistant", source: { kind: "model", model: "synthetic-model", provider: "synthetic-provider" }, content: [] },
        usage: { inputTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 4, reasoningTokens: 1 } }),
    ]));
    sources.push(...await dshAdapter.discoverFile!({ client: "dsh", format: DSH_FORMAT, path }));
  }
  const selected = dshAdapter.selectSources!(sources);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.path, paths[1]);
  const session = sink(await dshAdapter.readRecords!(selected[0]!) as NormalizedSnapshot);
  assert.equal(session.usage.length, 1);
  assert.equal(session.usage[0]?.inputTokens, 11);
  assert.equal(session.usage[0]?.outputTokens, 4);
  assert.equal(session.usage[0]?.provider, "synthetic-provider");
}));

test("DSH 和 Pi 来源缺失时传播 I/O 错误，不返回空快照", async () => temporary(async directory => {
  register(dshAdapter);
  register(piAdapter);
  const missing = join(directory, "missing.jsonl");
  await assert.rejects(dshAdapter.readRecords!({ client: "dsh", format: DSH_FORMAT, path: missing }));
  await assert.rejects(piAdapter.readRecords!({ client: "pi", format: PI_FORMAT, path: missing }));
  const child = join(directory, "2026-10-06T01-00-00-000Z_pi-child-synthetic.jsonl");
  await writeFile(child, encode([{ type: "session", version: 3, id: "pi-child-synthetic", cwd: "/synthetic/repo",
    parentSession: join(directory, "2026-10-06T00-00-00-000Z_pi-missing-parent.jsonl") }]));
  const snapshot = await piAdapter.readRecords!({ client: "pi", format: PI_FORMAT, path: child });
  assert.ok((snapshot as NormalizedSnapshot).meta.gaps?.some(gap => gap.kind === "source_missing"));
}));

test("DSH 未完成、错误或中断的原生轮次不推断最终回答", async () => temporary(async directory => {
  register(dshAdapter);
  const path = join(directory, "session.v4.jsonl");
  await writeFile(path, encode([
    dshHeader(4, "synthetic-incomplete"),
    dshEvent("user/message", 0, { turn: 0, message: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "prompt" }] } }),
    dshEvent("assistant/message", 1, { turn: 0, message: { role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "failed attempt" }] } }),
    dshEvent("turn/end", 2, { turn: 0, reason: { kind: "error" } }),
    dshEvent("assistant/message", 3, { turn: 0, interrupted: true,
      message: { role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "interrupted attempt" }] } }),
  ]));
  const session = sink(await dshAdapter.readRecords!({ client: "dsh", format: DSH_FORMAT, path }) as NormalizedSnapshot);
  assert.ok(session.messages.filter(message => message.kind === "assistant").every(message => message.final === undefined));
}));

test("共享 final 推断在工具请求或结果后使更早 assistant 候选失效", () => {
  const source = { path: "/synthetic/tool-history.jsonl", client: "codex" as const, format: "fixture", sessionId: "tool-history" };
  const events = [
    { key: "user", kind: "user" as const, text: "inspect file" },
    { key: "early-answer", kind: "assistant" as const, text: "I will inspect it first." },
    { key: "call", kind: "tool_call" as const, callId: "call-1", tool: "Read", input: { filePath: "src/a.ts" } },
    { key: "result", kind: "tool_result" as const, callId: "call-1", status: "success" as const, result: { content: "alpha" } },
  ];
  const snapshot = normalizedSnapshot(source, events.map((event, index) => normalizedRecord(event, JSON.stringify(event), index + 1)));
  const session = sink(snapshot);
  assert.equal(session.messages.find(message => message.kind === "assistant")?.final, undefined);
  assert.equal(session.metadata.turnCount, 1);

  const retrySnapshot = normalizedSnapshot(source, [
    normalizedRecord({ key: "retry-user", kind: "user", text: "retry this" }, "user", 1),
    normalizedRecord({ key: "failed-attempt", kind: "assistant", text: "failed attempt", interrupted: true }, "failed", 2),
    normalizedRecord({ key: "successful-retry", kind: "assistant", text: "successful retry", finalEvidence: "normal_stop" }, "success", 3),
  ]);
  const retry = sink(retrySnapshot);
  assert.equal(retry.messages.filter(message => message.text === "successful retry").at(-1)?.final, "inferred");
  assert.equal(retry.messages.filter(message => message.text === "successful retry").at(-1)?.finalEvidence, "normal_stop");
});

test("共享管道撤销中断、后续工具及未完成工具冲突的已有终答", () => {
  const source = { path: "/synthetic/final-conflict.jsonl", client: "pi" as const, format: "fixture", sessionId: "final-conflict" };
  const cases: NormalizedEvent[][] = [
    [{ key: "answer", kind: "assistant", text: "answer", final: "explicit", finalEvidence: "normal_stop", interrupted: true }],
    [{ key: "answer", kind: "assistant", text: "answer", final: "explicit", finalEvidence: "normal_stop" },
      { key: "abort", kind: "context", interrupted: true }],
    [{ key: "answer", kind: "assistant", text: "answer", final: "inferred", finalEvidence: "response_completed" },
      { key: "call", kind: "tool_call", callId: "call", tool: "Read", input: {} },
      { key: "result", kind: "tool_result", callId: "call", status: "success" }],
    [{ key: "call", kind: "tool_call", callId: "call", tool: "Read", input: {} },
      { key: "answer", kind: "assistant", text: "answer", final: "explicit", finalEvidence: "normal_stop" }],
    [{ key: "answer", kind: "assistant", text: "answer", final: "explicit", finalEvidence: "normal_stop",
      requestTiming: { basis: "recorded", method: "fixture", completion: "partial" } }],
    [{ key: "answer", kind: "assistant", text: "answer", final: "explicit", finalEvidence: "normal_stop" },
      { key: "continued", kind: "assistant", text: "unfinished continuation", allowInferredFinal: false }],
  ];
  for (const events of cases) {
    const messages = new Map<string, SessionMessage>();
    const rows = [{ key: "user", kind: "user" as const, text: "prompt" }, ...events];
    parseNormalizedSession(normalizedSnapshot(source, rows.map((event, index) => normalizedRecord(event, JSON.stringify(event), index + 1))),
      { message: value => messages.set(value.id, value), usage: () => {} });
    const answer = [...messages.values()].find(message => message.text === "answer");
    assert.equal(answer?.final, undefined);
    assert.equal(answer?.finalEvidence, undefined);
  }
});

test("共享末条回复兜底保留推断状态，用量持久化不提供强终答依据", () => {
  const source = { path: "/synthetic/weak-final.jsonl", client: "pi" as const, format: "fixture", sessionId: "weak-final" };
  const session = sink(normalizedSnapshot(source, [
    normalizedRecord({ key: "user", kind: "user", text: "prompt" }, "user", 1),
    normalizedRecord({ key: "answer", kind: "assistant", text: "persisted answer", usage: { inputTokens: 10, outputTokens: 4 },
      requestKey: "request", requestTiming: { basis: "recorded", method: "fixture", completion: "explicit", completionEvidence: "request_completed" } }, "answer", 2),
  ]));
  const answer = session.messages.filter(message => message.text === "persisted answer").at(-1);
  assert.equal(answer?.final, "inferred");
  assert.equal(answer?.finalEvidence, undefined);
  assert.equal(answer?.finalAt, undefined);
});

test("DSH completed 轮次提供终态依据，失败后完整响应可以恢复", async () => temporary(async directory => {
  const path = join(directory, "complete.v4.jsonl");
  await writeFile(path, encode([
    dshHeader(4, "synthetic-completed"),
    dshEvent("user/message", 0, { turn: 0, message: { source: { kind: "user" }, content: "prompt" } }),
    dshEvent("assistant/message", 1, { turn: 0, interrupted: true, message: { content: [{ type: "text", text: "failed" }] } }),
    dshEvent("turn/end", 2, { turn: 0, reason: { kind: "error" } }),
    dshEvent("assistant/message", 3, { turn: 0, message: { content: [{ type: "text", text: "complete answer" }] } }),
    dshEvent("turn/end", 4, { turn: 0, reason: { kind: "completed" } }, 1_800_000_004_000),
  ]));
  const session = sink(await dshAdapter.readRecords!({ client: "dsh", format: DSH_FORMAT, path }) as NormalizedSnapshot);
  assert.equal(session.messages.find(message => message.text === "failed")?.final, undefined);
  assert.equal(session.messages.find(message => message.text === "complete answer")?.final, "inferred");
  assert.equal(session.messages.find(message => message.text === "complete answer")?.finalEvidence, "turn_terminal");
  assert.equal(session.messages.find(message => message.text === "complete answer")?.finalAt, new Date(1_800_000_004_000).toISOString());
}));

function piEntry(type: string, id: string, parentId: string | null, body: Record<string, unknown> = {}) {
  return { type, id, parentId, timestamp: "2026-10-06T01:00:00.000Z", ...body };
}

function piAssistant(id: string, parentId: string, text: string, stopReason: string, usage = { input: 8, output: 4, cacheRead: 2, cacheWrite: 1, reasoning: 1 }, contentExtra: unknown[] = []) {
  return piEntry("message", id, parentId, { message: { role: "assistant", content: [{ type: "text", text }, ...contentExtra], provider: "synthetic-provider", model: "model-pi", stopReason, usage, timestamp: 1_800_000_000_000 } });
}

test("Pi 分支各自保留 final、当前叶定位、复制继承、注入与完整模型 usage", async () => temporary(async directory => {
  register(piAdapter);
  const parentPath = join(directory, "2026-10-06T00-00-00-000Z_pi-parent-synthetic.jsonl");
  const childPath = join(directory, "2026-10-06T01-00-00-000Z_pi-child-synthetic.jsonl");
  const sharedUser = piEntry("message", "shared-user-id", null, { message: { role: "user", content: [{ type: "text", text: "shared question" }], timestamp: 1_800_000_000_000 } });
  await writeFile(parentPath, encode([{ type: "session", version: 3, id: "pi-parent-synthetic", timestamp: "2026-10-06T00:00:00.000Z", cwd: "/synthetic/repo" }, sharedUser]));
  const entries = [
    { type: "session", version: 3, id: "pi-child-synthetic", timestamp: "2026-10-06T01:00:00.000Z", cwd: "/synthetic/repo", parentSession: parentPath },
    sharedUser,
    piEntry("message", "assistant-read", "shared-user-id", { message: { role: "assistant", content: [{ type: "toolCall", id: "pi-read-call", name: "read", arguments: { path: "src/a.ts", offset: 2 } }], model: "model-pi", stopReason: "toolUse", usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } }),
    piEntry("message", "read-result", "assistant-read", { message: { role: "toolResult", toolCallId: "pi-read-call", toolName: "read", isError: false,
      content: [{ type: "text", text: "alpha\nbeta\n\n[2 more lines in file. Use offset=4 to continue.]" }],
      details: { truncation: { truncated: false } }, usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, totalTokens: 1998, cost: {} } } }),
    piEntry("message", "assistant-edit", "read-result", { message: { role: "assistant", content: [{ type: "toolCall", id: "pi-edit-call", name: "edit", arguments: { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] } }], model: "model-pi", stopReason: "toolUse", usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } }),
    piEntry("message", "edit-result", "assistant-edit", { message: { role: "toolResult", toolCallId: "pi-edit-call", toolName: "edit", isError: false,
      content: [{ type: "text", text: "Successfully replaced 1 block(s)." }], details: { patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n before\n-old\n+new\n after" } } }),
    piEntry("message", "assistant-bash", "edit-result", { message: { role: "assistant", content: [{ type: "toolCall", id: "pi-bash-call", name: "bash", arguments: { command: "cat src/a.ts" } }], model: "model-pi", stopReason: "toolUse", usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 } } }),
    piEntry("message", "bash-result", "assistant-bash", { message: { role: "toolResult", toolCallId: "pi-bash-call", toolName: "bash", isError: false, content: [{ type: "text", text: "one\ntwo" }] } }),
    piAssistant("final-a", "bash-result", "branch A final", "stop"),
    piEntry("branch_summary", "branch-summary", "final-a", { fromId: "read-result", summary: "branch summary", usage: { input: 2, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 1 } }),
    piEntry("compaction", "compaction", "branch-summary", { summary: "compact summary", firstKeptEntryId: "shared-user-id", tokensBefore: 500,
      usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 1, reasoning: 1 } }),
    piAssistant("final-b", "read-result", "branch B final", "stop"),
    piEntry("custom_message", "injected-context", "final-b", { customType: "fixture", display: false, content: "injected context" }),
    piEntry("context_edit", "context-edit", "injected-context", { targetId: "shared-user-id", replacement: { content: "revised context" } }),
    piEntry("usage", "extra-usage", "context-edit", { kind: "cache_warm", provider: "synthetic", model: "model-pi",
      usage: { input: 4, output: 1, cacheRead: 2, cacheWrite: 1, reasoning: 0 } }),
  ];
  await writeFile(childPath, encode(entries));
  const discovered = await piAdapter.discover!({ type: "session", id: "pi-child-synthetic", cwd: "/synthetic/repo", parentSession: parentPath },
    { client: "pi", format: PI_FORMAT, path: childPath });
  assert.equal(discovered?.source.parentSessionId, "pi-parent-synthetic");
  const parsed = await parseSource(childPath, "pi", undefined, PI_FORMAT, { location: discovered?.source });
  const parent = await parseSource(parentPath, "pi", undefined, PI_FORMAT, { location: {
    client: "pi", format: PI_FORMAT, path: parentPath, sessionId: "pi-parent-synthetic", cwd: "/synthetic/repo",
  } });
  const shared = resolveSharedHistory([parent, parsed]);
  assert.equal(shared.relationships.find(item => item.sourceId === parsed.sourceId)?.resolved, true);
  const session = sink(await piAdapter.readRecords!({ client: "pi", format: PI_FORMAT, path: childPath }) as NormalizedSnapshot);
  assert.equal(session.metadata.turnCount, 1);
  assert.equal(session.messages.find(message => message.text === "shared question")?.copied, true);
  assert.ok(session.messages.some(message => message.kind === "context" && message.text === "injected context"));
  assert.ok(session.messages.some(message => message.kind === "compression" && message.text === "compact summary"));
  const finals = session.messages.filter(message => message.final === "inferred");
  assert.deepEqual(finals.map(message => message.text).sort(), ["branch A final", "branch B final"]);
  assert.ok(finals.every(message => message.finalEvidence === "normal_stop"));
  assert.equal(finals.find(message => message.text === "branch A final")?.currentBranch, false);
  assert.equal(finals.find(message => message.text === "branch B final")?.currentBranch, true);
  assert.deepEqual(finals.find(message => message.text === "branch A final")?.branchIds, ["compaction"]);
  assert.deepEqual(finals.find(message => message.text === "branch B final")?.branchIds, ["extra-usage"]);
  assert.equal(session.metadata.branches?.find(branch => branch.current)?.id, "extra-usage");
  assert.equal(session.metadata.branches?.find(branch => branch.current)?.labelDescriptor?.key, "sessions.branch.current");
  assert.ok(session.metadata.branches?.filter(branch => !branch.current).every(branch => branch.labelDescriptor?.key === "sessions.branch.number"));
  assert.equal(session.usage.length, 8);
  assert.equal(session.usage.some(value => value.inputTokens === 1998), false);
  const finalUsage = session.usage.find(value => value.messageId === finals.find(message => message.text === "branch A final")?.id)!;
  assert.equal(finalUsage.provider, "synthetic-provider");
  const compactionMessage = session.messages.find(message => message.text === "compact summary")!;
  const compactionUsage = session.usage.filter(value => value.messageId === compactionMessage.id);
  assert.equal(compactionUsage.length, 1, "压缩请求自身用量只计一次");
  assert.deepEqual([compactionUsage[0]?.inputTokens, compactionUsage[0]?.outputTokens, compactionUsage[0]?.reasoningOutputTokens], [5, 2, 1]);
  assert.equal(compactionUsage[0]?.provider, undefined, "压缩记录未声明服务商时不借用助手的服务商");
  const extraUsageMessage = session.messages.find(message => message.text === "cache_warm")!;
  const extraUsage = session.usage.find(value => value.messageId === extraUsageMessage.id)!;
  assert.deepEqual([extraUsage.inputTokens, extraUsage.cachedInputTokens, extraUsage.cacheWriteTokens], [7, 2, 1]);
  assert.equal(extraUsage.provider, "synthetic");
  assert.equal(extraUsageMessage.recordLine, entries.findIndex(entry => "id" in entry && entry.id === "extra-usage") + 1);
  assert.equal(extraUsage.turnId, extraUsageMessage.turnId, "用量位置不依赖最终发布顺序");
  const read = parsed.events.find(event => event.tool === "read");
  assert.equal(read?.fragments[0]?.content, "alpha\nbeta\n");
  assert.equal(read?.fragments[0]?.historicalStart, 2);
  const edit = parsed.events.find(event => event.tool === "edit");
  assert.equal(edit?.fragments.find(fragment => fragment.kind === "added")?.historicalStart, 2);
  const bash = parsed.events.find(event => event.tool === "bash");
  assert.equal(bash?.fragments[0]?.content, "one\ntwo");
  const evidence = await readHistoryEvidence(read!.sources[0]!);
  assert.ok(evidence?.raw.includes('"type":"toolCall"'));
  const evidenceResult = await readHistoryEvidence(read!.sources[1]!);
  assert.ok(evidenceResult?.raw.includes('"role":"toolResult"'));
}));

test("Pi length 与 error stopReason 不成为分支最终回答", async () => temporary(async directory => {
  register(piAdapter);
  const path = join(directory, "2026-10-06T01-00-00-000Z_pi-failure-synthetic.jsonl");
  await writeFile(path, encode([
    { type: "session", version: 3, id: "pi-failure-synthetic", timestamp: "2026-10-06T01:00:00.000Z", cwd: "/synthetic/repo" },
    piEntry("message", "user", null, { message: { role: "user", content: [{ type: "text", text: "prompt" }] } }),
    piAssistant("error", "user", "error attempt", "error"),
    piAssistant("length", "error", "truncated attempt", "length"),
  ]));
  const session = sink(await piAdapter.readRecords!({ client: "pi", format: PI_FORMAT, path }) as NormalizedSnapshot);
  assert.ok(session.messages.filter(message => message.kind === "assistant").every(message => message.final === undefined));
}));
