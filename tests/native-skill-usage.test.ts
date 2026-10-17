import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { Client } from "../src/contracts.js";
import type { SessionMessage } from "../src/session-contracts.js";
import { parseSessionSource } from "../src/sessions/parser.js";
import { messageResources } from "../src/sessions/resources.js";
import { SessionStore } from "../src/sessions/store.js";
import { resourceHistoryIdentity, listResourceUsage, resourceUsageEvidence } from "../src/resources/usage.js";

const at = "2026-01-02T12:00:00Z";
const body = (name = "guide") => `<skill>\n<name>${name}</name>\n<path>/synthetic/skills/${name}/SKILL.md</path>\n---\nname: ${name}\n---\n# 合成指令\n正文\n</skill>`;
const injected = (id: string, text = body(), kinds: unknown = ["skills.selected_skill_instructions"]) => ({ type: "response_item", timestamp: at,
  payload: { type: "message", id, role: "user", content: [{ type: "input_text", text }], internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } });
const codex = (records: unknown[]) => [{ type: "session_meta", payload: { id: "native-demo", cwd: "/synthetic/repo" } }, ...records];
const cli = (id: string, parentUuid: string | undefined, content: string, extra = {}) => ({ type: "message", role: "user", sessionId: "cli-demo", uuid: id, parentUuid, content,
  timestamp: at, entrypoint: "cli", version: "0.3.25", ...extra });
const expansion = (id: string, name = "guide") => [
  cli(`${id}-trigger`, undefined, `/${name} 合成问题`, { metadata: { origin: { kind: "command-input" } } }),
  cli(`${id}-command`, `${id}-trigger`, `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>合成问题</command-args>`, { hidden: true, isMeta: true }),
  cli(`${id}-body`, `${id}-command`, `\nBase directory for this skill: /synthetic/skills/${name}\n\n# 合成指令\n正文`, { hidden: true }),
];
async function parsed(client: Client, records: unknown[], run: (store: SessionStore, messages: SessionMessage[]) => void) {
  const directory = await mkdtemp(join(tmpdir(), "manor-native-skill-"));
  const store = new SessionStore(join(directory, "index.sqlite"));
  try {
    const path = join(directory, "native.jsonl"); await writeFile(path, records.map(row => JSON.stringify(row) + "\n").join(""));
    const pending = store.createRevision(path, "synthetic");
    const messages = new Map<string, SessionMessage>();
    const meta = await parseSessionSource({ client, path }, { message: message => { messages.set(message.id, message); pending.sink.message(message); }, usage: pending.sink.usage });
    pending.flush(); store.finishRevision(pending.revision, meta);
    store.publish(store.createJob().id, [{ path, revision: pending.revision, fingerprint: "synthetic" }], []);
    run(store, [...messages.values()]);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

test("Codex 原生注入保留上下文，排行、详情、证据和画像一致，重复原生身份只计一次", async () => {
  await parsed("codex", codex([injected("load-1"), injected("load-1"), injected("load-2"), injected("multiple", `${body()}\n${body("other")}`)]), (store, messages) => {
    assert.ok(messages.every(message => message.kind === "context"));
    assert.equal(messages.length, 3);
    const events = [...store.resourceEvents().events];
    assert.equal(events.length, 4); assert.equal(new Set(events.map(event => event.id)).size, 4);
    assert.deepEqual(store.resourceClients().skill, ["codex"]);
    const guide = listResourceUsage(store).resources.find(row => row.identity.name === "guide")!;
    assert.equal(guide.stats.events, 3); assert.equal(guide.stats.sessions, 1);
    const identity = resourceHistoryIdentity(events.find(event => event.name === "other")!);
    assert.equal([...store.resourceEvents({}, identity).events].length, 1);
    assert.equal(resourceUsageEvidence(store, identity.id).total, 1);
    assert.equal(store.overviewSource().resources.length, 4);
    assert.equal(store.profile(events[0]!.sessionId).resources.find(row => row.name === "guide")?.count, 3);
    assert.equal(store.profile(events[0]!.sessionId).tools.length, 0);
    assert.equal(store.messages(events[0]!.sessionId, { resourceKind: "skill_read", resourceName: "other", mode: "trace" }).focusMessageId, events[3]!.messageId);
  });
});

test("Codex 普通提及、任意包、混合或未知元数据、空正文不能冒充使用", async () => {
  await parsed("codex", codex([injected("mention", "[$guide](/synthetic/skills/guide/SKILL.md)", ["user.text"]),
    injected("mixed", body(), ["user.text", "skills.selected_skill_instructions"]),
    injected("unknown", body(), ["unknown"]), injected("empty", "<skill><name>guide</name><path>/synthetic/guide/SKILL.md</path></skill>")]), store => {
    assert.equal([...store.resourceEvents().events].length, 0);
  });
  const wrapper = injected("plain"); delete (wrapper.payload as { internal_chat_message_metadata_passthrough?: unknown }).internal_chat_message_metadata_passthrough;
  await parsed("codex", codex([wrapper]), store => assert.equal([...store.resourceEvents().events].length, 0));
});

test("CLI 三条原生链只计正文一次，其他展开同样支持，重复正文不增计", async () => {
  const first = expansion("first"), second = expansion("second", "other");
  await parsed("codeflicker", [...first, first[2], ...second,
    cli("quote", undefined, `引用示例：\n${String((first[2] as { content: string }).content)}`),
    cli("orphan", undefined, "Base directory for this skill: /synthetic/skills/guide\n\n正文", { hidden: true }),
    cli("wrong-parent", "first-trigger", "Base directory for this skill: /synthetic/skills/guide\n\n正文", { hidden: true }),
    cli("extra-body", "first-command", "Base directory for this skill: /synthetic/skills/guide\n\n正文", { hidden: true }),
  ], (store, messages) => {
    assert.deepEqual([...store.resourceEvents().events].map(event => event.name), ["guide", "other"]);
    assert.equal(messages.filter(message => messageResources(message).length).length, 2);
    assert.ok(messages.filter(message => messageResources(message).length).every(message => message.kind === "context" && message.status === "success"));
  });
});

test("CLI Skill 工具结果伴随展开正文不与显式调用重复计数，孤立结果不补造使用", async () => {
  const expanded = "Base directory for this skill: /synthetic/skills/guide\n\n# 合成指令\n正文";
  await parsed("codeflicker", [
    { ...cli("tool-call", undefined, ""), role: "assistant", content: [{ type: "tool_use", id: "load", name: "Skill", input: { skill: "guide" } }] },
    { ...cli("tool-result", "tool-call", ""), content: [{ type: "tool_result", tool_use_id: "load", content: expanded }] },
    { ...cli("orphan-result", undefined, ""), content: [{ type: "tool_result", tool_use_id: "missing", content: expanded }] },
  ], store => {
    const events = [...store.resourceEvents().events];
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "skill_call");
    assert.equal(events[0]?.name, "guide");
    assert.equal(listResourceUsage(store).resources[0]?.stats.events, 1);
  });
});

test("复制的原生 Skill 上下文保留证据正文但不计资源使用", async () => {
  const parent = injected("copied"), own = injected("own");
  await parsed("codex", [{ type: "session_meta", payload: { id: "child", cwd: "/synthetic/repo", parent_thread_id: "parent-demo", subagent_history_start_ordinal: 5 } },
    { ...parent, ordinal: 2 }, { ...own, ordinal: 6 }], (store, messages) => {
    assert.equal(messages.filter(message => message.copied).length, 1);
    assert.equal([...store.resourceEvents().events].length, 1);
  });
});

test("相同原生 UUID 属于不同会话且无复制关系时分别保留，不能按正文全局折叠", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-native-identities-"));
  const store = new SessionStore(join(directory, "index.sqlite"));
  try {
    const revisions = [];
    for (const sessionId of ["session-a", "session-b"]) {
      const path = join(directory, sessionId + ".jsonl");
      await writeFile(path, expansion("shared-uuid").map(record => JSON.stringify({ ...record, sessionId }) + "\n").join(""));
      const pending = store.createRevision(path, "synthetic");
      const summary = await parseSessionSource({ client: "codeflicker", path }, pending.sink);
      pending.flush(); store.finishRevision(pending.revision, summary);
      revisions.push({ path, revision: pending.revision, fingerprint: "synthetic" });
    }
    store.publish(store.createJob().id, revisions, []);
    assert.equal(store.status().sessionCount, 2);
    const events = [...store.resourceEvents().events];
    assert.equal(events.length, 2); assert.equal(new Set(events.map(event => event.id)).size, 2);
    assert.equal(listResourceUsage(store).resources[0]?.stats.sessions, 2);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("允许原生上下文读取不改变 MCP 或 Skill 调用的计数边界", async () => {
  await parsed("codex", codex([injected("load")]), (store, messages) => {
    const original = messages[0]!;
    const source = store.cachedRevisions()[0]!;
    const pending = store.createRevision(source.path, "synthetic-boundary");
    pending.sink.message({ ...original, resources: [original.resource!, { kind: "mcp", name: "lookup", server: "example" }] });
    pending.sink.message({ ...original, id: "context-call", ordinal: 2, resource: { kind: "skill_call", name: "not-a-call" }, resources: undefined });
    pending.sink.message({ ...original, id: "context-mcp", ordinal: 3, resource: { kind: "mcp", name: "lookup", server: "example" }, resources: undefined });
    pending.flush();
    const summary = store.list().sessions[0]!;
    store.finishRevision(pending.revision, { ...summary, sourceId: "synthetic", path: source.path, clientSessionId: "native-demo", gaps: [], models: [] });
    store.publish(store.createJob().id, [{ path: source.path, revision: pending.revision, fingerprint: "synthetic-boundary" }], []);
    assert.deepEqual([...store.resourceEvents().events].map(event => event.kind), ["skill_read"]);
    assert.deepEqual(store.resourceClients(), { skill: ["codex"], mcp: [] });
    assert.deepEqual(store.profile(original.sessionId).resources.map(resource => resource.kind), ["skill_read"]);
  });
});

test("标准刷新使缺少原生 Skill 规则的旧缓存重建一次，后续无变化复用不累计", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-native-cache-")), database = join(directory, "index.sqlite");
  const { refreshSessions } = await import("../src/sessions/refresh.js");
  const { isolatedHistoryRoots } = await import("./helpers/history-roots.js");
  let store = new SessionStore(database);
  try {
    await writeFile(join(directory, "native.jsonl"), codex([injected("load")]).map(row => JSON.stringify(row) + "\n").join(""));
    const refresh = async () => { const job = store.createJob(); await refreshSessions(store, job.id, isolatedHistoryRoots({ codex: [directory] })); return store.getJob(job.id); };
    await refresh();
    assert.ok(store.cachedRevisions()[0]!.fingerprint.includes(":native-skill-v1"));
    store.close();
    // 合成旧缓存：元信息与文件未变，唯独缺少本轮规则指纹及原生资源字段。
    const legacy = new Database(database);
    try {
      legacy.exec("UPDATE session_revisions SET fingerprint=replace(fingerprint,':native-skill-v1',''); UPDATE session_messages SET json=json_remove(json,'$.resource','$.resources','$.status') WHERE kind='context';");
    } finally { legacy.close(); }
    store = new SessionStore(database);
    assert.equal([...store.resourceEvents().events].length, 0);
    assert.equal((await refresh()).counts?.parsed, 1);
    const expected = [...store.resourceEvents().events].map(event => event.id);
    assert.equal(expected.length, 1);
    const warm = await refresh();
    assert.equal(warm.counts?.parsed, 0); assert.equal(warm.counts?.quickReused, 1);
    assert.deepEqual([...store.resourceEvents().events].map(event => event.id), expected);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
