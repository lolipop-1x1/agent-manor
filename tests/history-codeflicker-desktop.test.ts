import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";
import { discoverSources, parseSource } from "../src/history/index.js";
import { readHistoryEvidence } from "../src/history/adapters/index.js";
import { parseSessionSource, sessionKey } from "../src/sessions/parser.js";
import { desktopModels } from "../src/sessions/codeflicker-desktop.js";
import { AnalysisStore } from "../src/index/store.js";
import { SessionStore } from "../src/sessions/store.js";
import { refreshSessions } from "../src/sessions/refresh.js";
import { scanResourceInventory } from "../src/resources/inventory.js";
import { listResourceUsage } from "../src/resources/usage.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";
// @ts-ignore 人工样例共用于真实 CLI／浏览器验收。
import { desktopFixture, desktopNativeFixture, encodeDesktop } from "../scripts/desktop-fixture.mjs";

async function fixture(run: (directory: string, path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-desktop-test-"));
  const path = join(directory, "sessions", "desktop-session", "message", "cache.jsonl");
  try {
    await mkdir(dirname(path), { recursive: true });
    await mkdir(join(directory, "sessions/desktop-session/checkpoints"));
    await mkdir(join(directory, "sessions/desktop-session/claude-session"));
    await writeFile(join(directory, "sessions/desktop-session/checkpoints/registry.json"), JSON.stringify({ sessionId: "desktop-session", cwd: "/synthetic/repo" }));
    await writeFile(path, encodeDesktop(desktopFixture("/synthetic/repo")));
    await writeFile(join(directory, "sessions/desktop-session/claude-session/native.jsonl"), encodeDesktop(desktopNativeFixture));
    await run(directory, path);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const roots = (directory: string) => isolatedHistoryRoots({ "codeflicker-desktop": join(directory, "sessions") });

async function session(path: string) {
  const metadata = (await discoverSources(roots(dirname(dirname(dirname(dirname(path)))))))[0]!;
  const messages = new Map<string, SessionMessage>();
  const usage = new Map<string, SessionUsage>();
  const models = await desktopModels(path);
  const summary = await parseSessionSource(metadata, { message: value => { messages.set(value.id, value); }, usage: value => { usage.set(value.id, value); } }, { desktopModels: models.entries });
  return { summary, messages: [...messages.values()], usage: [...usage.values()] };
}

test("桌面只发现统一缓存，独立身份与正式 cwd，不重复索引底层 Claude 轨迹", async () => fixture(async (directory, path) => {
  const sources = await discoverSources(roots(directory));
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.sessionId, "desktop-session");
  assert.equal(sources[0]?.client, "codeflicker-desktop");
  assert.equal(sources[0]?.cwd, "/synthetic/repo");
  const parsed = await parseSource(path, "codeflicker-desktop");
  assert.equal(parsed.sessionId, "desktop-session");
  assert.equal(parsed.events.length, 3);
  assert.ok(parsed.events.every(event => event.client === "codeflicker-desktop"));
  assert.deepEqual(parsed.events.map(event => [event.tool, event.kind, event.status]), [["read_file", "read", "success"], ["replace_in_file", "edit", "success"], ["use_skill", "other", "success"]]);
  assert.equal(parsed.events[0]?.fragments[0]?.content, "export const healthy = true;\nexport const updated = true;\n");
  assert.equal(parsed.events[1]?.fragments.filter(part => part.kind === "added").length, 1);
  const reference = parsed.events[0]!.sources[1]!;
  assert.equal(reference.format, "codeflicker-desktop-jsonl");
  assert.equal(JSON.parse((await readHistoryEvidence(reference))!.raw).id, "desktop-read-result");
  assert.equal(await readHistoryEvidence({ ...reference, hash: "changed" }), undefined);
  const continued = await parseSource(path, "codeflicker-desktop", parsed);
  assert.equal((continued.cursor as { parsedRecords: number }).parsedRecords, 0);
}));

test("完整与简易消息、正式模型、总输入与缓存分项、Skill 调用均保持可回查", async () => fixture(async (_directory, path) => {
  const parsed = await session(path);
  assert.equal(parsed.summary.id, sessionKey("codeflicker-desktop", "desktop-session"));
  assert.notEqual(parsed.summary.id, sessionKey("codeflicker", "desktop-session"));
  assert.equal(parsed.summary.turnCount, 1);
  assert.equal(parsed.summary.messageCount, 9);
  assert.deepEqual(parsed.summary.models, ["fixture-desktop-model"]);
  assert.equal(parsed.messages.find(message => message.text === "桌面历史核对完成")?.final, "explicit");
  assert.equal(parsed.messages.filter(message => message.kind === "tool_call").length, 3);
  assert.deepEqual(parsed.messages.find(message => message.tool === "use_skill" && message.kind === "tool_call")?.resource,
    { kind: "skill_call", name: "check-example", path: "/synthetic/skills/check-example" });
  assert.equal(parsed.usage.length, 2);
  assert.ok(parsed.usage.every(value => value.inputTokens === 100 && value.cachedInputTokens === 60 && value.outputTokens === 10));
  assert.ok(parsed.usage.every(value => parsed.messages.some(message => message.id === value.messageId)));
  assert.ok(parsed.messages.every(message => message.durationMs === undefined));
}));

test("桌面原生 Skill 目录贯通历史关联，旧解析缓存刷新后补齐路径且不改变调用名称和统计", async () => fixture(async (directory, path) => {
  const project = join(directory, "synthetic-project"); const userHome = join(directory, "synthetic-user");
  const skillPath = join(project, ".myflicker", "skills", "fixture-skill");
  await mkdir(skillPath, { recursive: true }); await writeFile(join(skillPath, "SKILL.md"), "---\nname: declared-skill\ndescription: 人工合成说明\n---\n人工正文\n");
  await writeFile(join(directory, "sessions/desktop-session/checkpoints/registry.json"), JSON.stringify({ sessionId: "desktop-session", cwd: project }));
  const records = desktopFixture(project);
  records[6].toolCalls[0].function.arguments = JSON.stringify({ skill_directory: ".myflicker/skills/fixture-skill" });
  await writeFile(path, encodeDesktop(records));
  const dbPath = join(directory, "index.sqlite"); new AnalysisStore(dbPath).close(); const store = new SessionStore(dbPath);
  try {
    const refresh = async () => { const job = store.createJob({ client: "codeflicker-desktop", mode: "quick" }); await refreshSessions(store, job.id, roots(directory)); return store.getJob(job.id); };
    assert.equal((await refresh()).counts?.parsed, 1);
    const inventory = await scanResourceInventory({ userHome, projects: [project], environment: {} });
    const first = listResourceUsage(store, { kind: "skill", client: "codeflicker-desktop" }, inventory.entries).resources[0]!;
    assert.equal(first.identity.name, "fixture-skill"); assert.equal(first.stats.explicitCalls, 1); assert.equal(first.stats.sessions, 1); assert.equal(first.association.state, "linked");
    const cached = store.cachedRevisions()[0]!; assert.ok(cached.fingerprint.includes(":skill-directory-v1"));
    const oldFingerprint = cached.fingerprint.replace(":skill-directory-v1", "");
    const oldSuffix = /^[^:]+:[^:]+:\d+:[a-f0-9]{64}(.*)$/.exec(oldFingerprint)?.[1]; assert.ok(oldSuffix);
    const oldMetadata = createHash("sha256").update(JSON.stringify({ rule: "6", source: cached.location, metadataSuffix: oldSuffix })).digest("hex");
    const database = new Database(dbPath);
    database.prepare("UPDATE session_revisions SET fingerprint=?,metadata_fingerprint=? WHERE id=?").run(oldFingerprint, oldMetadata, cached.revision);
    database.prepare("UPDATE session_messages SET json=json_remove(json,'$.resource.path') WHERE revision=?").run(cached.revision); database.close();
    const old = listResourceUsage(store, { kind: "skill", client: "codeflicker-desktop" }, inventory.entries).resources[0]!;
    assert.equal(old.association.reason, "missing_path");
    const rebuilt = await refresh(); assert.equal(rebuilt.counts?.parsed, 1); assert.notEqual(store.cachedRevisions()[0]?.revision, cached.revision);
    const current = listResourceUsage(store, { kind: "skill", client: "codeflicker-desktop" }, inventory.entries).resources[0]!;
    assert.equal(current.identity.name, old.identity.name); assert.deepEqual(current.stats, old.stats); assert.equal(current.association.state, "linked");
    assert.equal([...store.resourceEvents({ client: "codeflicker-desktop", kind: "skill" }).events][0]?.path, skillPath);
    assert.equal((await refresh()).counts?.quickReused, 1);
  } finally { store.close(); }
}));

test("工具失败、行计数或请求范围矛盾不抬高覆盖，终态中断不认定最终回答", async () => fixture(async (_directory, path) => {
  const records = desktopFixture("/synthetic/repo");
  records[3].content = JSON.stringify({ content: "1\texport const healthy = true;\n", line_count: 3 });
  records[5].content = JSON.stringify({ success: false });
  records[9].outcome = "cancelled";
  await writeFile(path, encodeDesktop(records));
  const parsed = await parseSource(path, "codeflicker-desktop");
  assert.equal(parsed.events[0]?.status, "unknown");
  assert.equal(parsed.events[0]?.fragments.length, 0);
  assert.equal(parsed.events[1]?.status, "failure");
  assert.equal(parsed.events[1]?.fragments.length, 0);
  assert.ok((await session(path)).messages.every(message => !message.final));
  records[3].content = JSON.stringify({ content: "2\texport const healthy = true;\n", line_count: 1 });
  await writeFile(path, encodeDesktop(records));
  const wrongRange = await parseSource(path, "codeflicker-desktop");
  assert.equal(wrongRange.events[0]?.status, "success");
  assert.equal(wrongRange.events[0]?.fragments.length, 0);
  assert.ok(wrongRange.gaps.some(gap => gap.kind === "range_unknown"));
}));

test("桌面旁路 cwd 更新重建相对路径归属，JSONL 追加保持调用身份", async () => fixture(async (directory, path) => {
  const initial = await parseSource(path, "codeflicker-desktop");
  const registry = join(directory, "sessions/desktop-session/checkpoints/registry.json");
  await writeFile(registry, JSON.stringify({ sessionId: "desktop-session", cwd: "/synthetic/another" }));
  const changed = await parseSource(path, "codeflicker-desktop", initial);
  assert.equal(changed.cwd, "/synthetic/another");
  assert.ok((changed.cursor as { parsedRecords: number }).parsedRecords > 0);
  await appendFile(path, encodeDesktop([{ id: "user-next", role: "user", kind: "message", turnId: "next", content: "下一轮" }]));
  const appended = await parseSource(path, "codeflicker-desktop", changed);
  assert.deepEqual(appended.events.map(event => event.id), initial.events.map(event => event.id));
  assert.equal((appended.cursor as { parsedRecords: number }).parsedRecords, 1);
}));

test("标题及原生模型旁路变更只失效对应会话，来源删除从新版排除", async () => fixture(async (directory, path) => {
  const dbPath = join(directory, "index.sqlite");
  new AnalysisStore(dbPath).close();
  const store = new SessionStore(dbPath);
  const metadataPath = join(directory, "desktop.sqlite");
  const db = new Database(metadataPath);
  db.exec("CREATE TABLE kv(ns TEXT,key TEXT,value TEXT,updated_at INTEGER)");
  const title = (value: string) => { db.prepare("DELETE FROM kv").run(); db.prepare("INSERT INTO kv VALUES(?,?,?,?)").run("u/synthetic/session-list-cache-v2", "slot:00", JSON.stringify({ items: [{ id: "desktop-session", title: value }] }), 1); };
  const previous = process.env.AGENT_MANOR_CODEFLICKER_DESKTOP_DB;
  process.env.AGENT_MANOR_CODEFLICKER_DESKTOP_DB = metadataPath;
  try {
    title("桌面正式标题");
    const refresh = async () => { const job = store.createJob(); await refreshSessions(store, job.id, roots(directory)); return store.getJob(job.id); };
    await refresh();
    assert.equal(store.list({ client: "codeflicker-desktop" }).sessions[0]?.title, "桌面正式标题");
    const oldRevision = store.cachedRevisions()[0]?.revision;
    await refresh();
    assert.equal(store.cachedRevisions()[0]?.revision, oldRevision);
    title("更新后的标题");
    await refresh();
    assert.equal(store.list({}).sessions[0]?.title, "更新后的标题");
    assert.notEqual(store.cachedRevisions()[0]?.revision, oldRevision);
    const titleRevision = store.cachedRevisions()[0]?.revision;
    const nativePath = join(directory, "sessions/desktop-session/claude-session/native.jsonl");
    await writeFile(nativePath, encodeDesktop(desktopNativeFixture.map((record: { message: Record<string, unknown> }) => ({ ...record,
      message: { ...record.message, model: "updated-desktop-model" } }))));
    await refresh();
    assert.notEqual(store.cachedRevisions()[0]?.revision, titleRevision);
    assert.deepEqual(store.list({}).sessions[0]?.models, ["updated-desktop-model"]);
    await rm(path);
    await refresh();
    assert.equal(store.list({}).total, 0);
    assert.ok(store.status().gaps.some(gap => gap.kind === "source_missing"));
    assert.ok(await readFile(join(directory, "sessions/desktop-session/claude-session/native.jsonl")));
  } finally {
    store.close(); db.close();
    if (previous === undefined) delete process.env.AGENT_MANOR_CODEFLICKER_DESKTOP_DB;
    else process.env.AGENT_MANOR_CODEFLICKER_DESKTOP_DB = previous;
  }
}));

test("桌面用量按后端归一化，压缩的上下文估算不冒充模型请求用量", async () => fixture(async (_directory, path) => {
  const records = desktopFixture("/synthetic/repo");
  records[2].extra.backend.type = "DEEPSEEK_HARNESS";
  records[8].extra.backend.type = "MY_FLICKER";
  records[8].usage.inputTokens = 100;
  records.splice(8, 0, { id: "compaction", role: "activity", kind: "activity", content: "已压缩",
    extra: { compaction: { summary: "保留任务目标", preTokens: 1000, postTokens: 100 } }, usage: { inputTokens: 100, outputTokens: 0 } });
  await writeFile(path, encodeDesktop(records));
  const parsed = await session(path);
  assert.equal(parsed.usage.length, 2);
  assert.ok(parsed.usage.every(value => value.inputTokens === 100 && value.cachedInputTokens === 60));
  assert.equal(parsed.messages.filter(message => message.kind === "compression").length, 1);
  assert.ok(parsed.messages.find(message => message.kind === "compression")?.text.includes("保留任务目标"));
  delete records[2].extra.backend;
  await writeFile(path, encodeDesktop(records));
  const unknown = await session(path);
  assert.equal(unknown.usage[0]?.inputTokens, undefined);
  assert.ok(unknown.summary.gaps.some(gap => gap.message.includes("执行后端")));
}));

test("桌面原生普通编号与结构化读取、写入快照和替换终态分别校验", async () => fixture(async (_directory, path) => {
  const records = desktopFixture("/synthetic/repo");
  records[3].content = JSON.stringify({ content: "export const healthy = true;\nexport const updated = true;\n", start_line: 1, end_line: 2, line_count: 2, total_lines: 2 });
  records.splice(8, 0,
    { id: "write-request", role: "assistant", kind: "message", toolCalls: [{ id: "write", type: "function", function: { name: "write_to_file", arguments: JSON.stringify({ path: "/synthetic/repo/src/new.ts", content: "export const created = true;\n" }) } }] },
    { id: "write-result", role: "tool", kind: "message", toolCallId: "write", extra: { toolName: "write_to_file" }, content: JSON.stringify({ path: "/synthetic/repo/src/new.ts", success: true }) });
  await writeFile(path, encodeDesktop(records));
  const parsed = await parseSource(path, "codeflicker-desktop");
  assert.equal(parsed.events[0]?.fragments[0]?.historicalStart, 1);
  assert.equal(parsed.events[0]?.fragments[0]?.content, "export const healthy = true;\nexport const updated = true;\n");
  assert.equal(parsed.events[1]?.status, "success");
  assert.equal(parsed.events.at(-1)?.fragments[0]?.content, "export const created = true;\n");
  records[9].content = JSON.stringify({ path: "/synthetic/repo/src/other.ts", success: true });
  await writeFile(path, encodeDesktop(records));
  assert.equal((await parseSource(path, "codeflicker-desktop")).events.at(-1)?.fragments.length, 0);
}));

test("桌面数值消息 ID 去重并精确关联轮次终态，不凭完成状态认定错误引用", async () => fixture(async (_directory, path) => {
  const records = desktopFixture("/synthetic/repo");
  records.forEach((record: Record<string, unknown>, index: number) => { if (record.id !== undefined) record.id = index + 1; });
  records[9].lastMessageId = 9;
  await writeFile(path, encodeDesktop(records));
  const initial = await session(path);
  assert.equal(initial.summary.messageCount, 9);
  assert.equal(initial.messages.find(message => message.kind === "assistant")?.final, "explicit");
  records.splice(9, 0, structuredClone(records[8]));
  await writeFile(path, encodeDesktop(records));
  const repeated = await session(path);
  assert.equal(repeated.summary.messageCount, initial.summary.messageCount);
  assert.equal(repeated.usage.length, initial.usage.length);
  records.splice(9, 1);
  records[9].lastMessageId = 1;
  await writeFile(path, encodeDesktop(records));
  assert.ok((await session(path)).messages.every(message => !message.final));
  assert.ok((await session(path)).summary.gaps.some(gap => gap.kind === "ambiguous"));
}));
