import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import test from "node:test";
import Database from "better-sqlite3";
import { discoverSources, parseSource } from "../src/history/index.js";
import { readHistoryEvidence } from "../src/history/adapters/index.js";
import { readIdeSnapshot } from "../src/history/adapters/codeflicker-ide.js";
import { SessionStore } from "../src/sessions/store.js";
import { refreshSessions } from "../src/sessions/refresh.js";
import { AnalysisStore } from "../src/index/store.js";
import { refreshRepository } from "../src/index/refresh.js";
import { parseSessionSource } from "../src/sessions/parser.js";
import type { SessionMessage } from "../src/session-contracts.js";
// @ts-ignore 人工样本共用于端到端验收。
import { ideFixture } from "../scripts/ide-fixture.mjs";

const roots = (path: string) => ({ codex: [], claude: [], codeflicker: [], "codeflicker-desktop": path });
async function fixture(run: (directory: string, repository: string, data: ReturnType<typeof ideFixture>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-ide-test-"));
  const repository = join(directory, "repo");
  await mkdir(join(repository, "src"), { recursive: true });
  execFileSync("git", ["init", "-q", repository]);
  await writeFile(join(repository, "src/entry.ts"), "export const healthy = true;\nexport const updated = true;\n");
  const data = ideFixture(directory, repository);
  try { await run(directory, repository, data); }
  finally { data.db.close(); await rm(directory, { recursive: true, force: true }); }
}

test("同库多会话独立发现，迁移副本去重，SQLite 原生键与真实路径保留", async () => fixture(async (directory, repository, data) => {
  const old = new Database(join(directory, "session_data.sqlite"));
  old.exec("CREATE TABLE KwaipilotKV(key TEXT PRIMARY KEY,value BLOB)");
  old.prepare("INSERT INTO KwaipilotKV VALUES(?,?)").run("composerData:ide-main", JSON.stringify({ sessionId: "ide-main", localMessages: [] }));
  old.close();
  const found = await discoverSources(roots(directory));
  assert.equal(found.length, 2);
  assert.ok(found.every(source => source.path.endsWith("composer_data.sqlite") && source.client === "codeflicker-desktop"));
  const source = found.find(item => item.sessionId === "ide-main")!;
  assert.equal(source.cwd, repository);
  const parsed = await parseSource(source.path, source.client, undefined, source.format, { location: source });
  assert.deepEqual(parsed.events.map(event => [event.tool, event.status]), [["readFile", "success"], ["editFile", "success"], ["useMcpTool", "unknown"]]);
  assert.equal(parsed.events[0]!.fragments[0]!.historicalStart, 1);
  assert.equal(parsed.events[0]!.fragments[0]!.content, "export const healthy = true;\nexport const updated = true;\n");
  const reference = parsed.events[0]!.sources[0]!;
  assert.equal(reference.selector, "composerData:ide-main");
  assert.equal(JSON.parse((await readHistoryEvidence(reference))!.raw).toolCallId, "read-one");
  assert.equal(await readHistoryEvidence({ ...reference, hash: "wrong" }), undefined);
  const moved = join(directory, "moved");
  await mkdir(moved);
  await Promise.all([copyFile(source.path, join(moved, "composer_data.sqlite")), copyFile(join(directory, "index.sqlite"), join(moved, "index.sqlite"))]);
  const relocated = await parseSource(join(moved, "composer_data.sqlite"), source.client, parsed, source.format, { location: source });
  assert.equal(relocated.path, join(moved, "composer_data.sqlite"));
  assert.ok(relocated.events.every(event => event.sources.every(item => item.path === relocated.path)));
  assert.ok(await readHistoryEvidence(relocated.events[0]!.sources[0]!));
  data.messages[3].text = "已改写";
  data.write(source.selector, { sessionId: "ide-main", localMessages: data.messages });
  assert.equal(await readHistoryEvidence(reference), undefined);
}));

test("会话缓存按原生键区分，WAL 更新、标题变化和单个键删除分别失效", async () => fixture(async (directory, repository, data) => {
  data.db.pragma("journal_mode = WAL");
  data.db.pragma("wal_autocheckpoint = 0");
  const store = new AnalysisStore(join(directory, "index"));
  const sessions = new SessionStore(join(directory, "sessions.db"));
  const refresh = async () => { const job = sessions.createJob(); await refreshSessions(sessions, job.id, roots(directory)); };
  try {
    await refresh();
    assert.equal(sessions.status().sessionCount, 2);
    const before = sessions.cachedRevisions();
    await refresh();
    assert.deepEqual(sessions.cachedRevisions(), before);
    const found = sessions.list({ client: "codeflicker-desktop" }).sessions.find(item => item.title === "SQLite 入口核对")!;
    assert.equal(found.projectOrigin, "client_metadata");
    assert.deepEqual(found.models, ["sample-model"]);
    const full = sessions.messages(found.id, { mode: "full" });
    assert.ok(!full.messages.find(message => message.kind === "tool_call" && message.callId === "read-one")?.text.includes("export const"));
    assert.equal(full.messages.filter(message => message.kind === "tool_call").length, 3);
    assert.equal(full.messages.find(message => message.resource?.kind === "mcp")?.resource?.server, "sample");
    assert.equal(sessions.messages(found.id, { mode: "brief" }).total, 2);
    data.write("composerData:ide-chat", { sessionId: "ide-chat", localMessages: [{ role: "user", say: "text", text: "WAL 中的新消息" }] });
    assert.ok((await readFile(join(directory, "composer_data.sqlite-wal"))).length > 0);
    await refresh();
    assert.equal(sessions.list({ q: "WAL" }).total, 1);
    assert.equal(sessions.cachedRevisions().filter(item => before.some(old => old.revision === item.revision)).length, 1);
    const index = new Database(join(directory, "index.sqlite"));
    index.prepare("UPDATE KwaipilotKV SET value=? WHERE key=?").run(JSON.stringify({ sessionId: "ide-main", name: "更新标题" }), "composerMeta:ide-main"); index.close();
    await refresh();
    assert.equal(sessions.list({ q: "更新标题" }).total, 1);
    data.db.prepare("DELETE FROM KwaipilotKV WHERE key=?").run("composerData:ide-chat");
    await refresh();
    assert.equal(sessions.status().sessionCount, 1);
    assert.ok(sessions.status().gaps.some(gap => gap.kind === "source_missing"));
  } finally { sessions.close(); store.close(); }
}));

test("地图缓存不吞掉同库其他会话，读取与已接受快照正确计算且来源删除降为零", async () => fixture(async (directory, repository, data) => {
  const store = new AnalysisStore(join(directory, "map"));
  try {
    const repo = await store.registerRepository(repository);
    const refresh = async () => { const job = store.createJob(repo.id); await refreshRepository(store, job.id, roots(directory)); return store.getSnapshot(repo.id); };
    const first = await refresh();
    assert.equal(first.events.length, 3);
    assert.equal(first.baseline.files[0]?.lineCount, 2);
    assert.equal(first.mappings.filter(mapping => mapping.exactRanges.length).length, 2);
    const second = await refresh();
    assert.equal(second.events.length, first.events.length);
    data.db.prepare("DELETE FROM KwaipilotKV WHERE key=?").run("composerData:ide-main");
    const removed = await refresh();
    assert.equal(removed.events.length, 0);
    assert.ok(removed.gaps.some(gap => gap.kind === "source_missing"));
  } finally { store.close(); }
}));

test("工作区缓存地址通过正式 folder 关联，工作区缺失不误认缓存目录", async () => fixture(async (directory, repository, data) => {
  const workspace = join(directory, "workspaceStorage", "sample-id");
  await mkdir(workspace, { recursive: true });
  const uri = pathToFileURL(join(workspace, "public-client-extension")).href;
  data.write("composerData:ide-main", { sessionId: "ide-main", workspaceUri: uri, localMessages: data.messages });
  const location = (await discoverSources(roots(directory))).find(item => item.sessionId === "ide-main")!;
  assert.equal(location.cwd, undefined);
  await writeFile(join(workspace, "workspace.json"), JSON.stringify({ folder: pathToFileURL(repository).href }));
  const snapshot = await readIdeSnapshot(location);
  assert.equal(snapshot.source.cwd, repository);
  await writeFile(join(workspace, "workspace.json"), JSON.stringify({ folder: pathToFileURL(join(repository, "other")).href }));
  assert.notEqual((await readIdeSnapshot(location)).hash, snapshot.hash);
}));

test("IDE 管道编号与末尾包装只提取实际代码；后续失败、拒绝和无编号内容均不抬高覆盖", async () => fixture(async (directory, repository, data) => {
  const read = JSON.parse(data.messages[3].text);
  read.content = "000001|export const healthy = true;\n000002|export const updated = true;\n\n[文件读取结束]";
  data.messages[3].text = JSON.stringify(read);
  data.write("composerData:ide-main", { sessionId: "ide-main", workspaceUri: pathToFileURL(repository).href, localMessages: data.messages });
  const source = (await discoverSources(roots(directory))).find(item => item.sessionId === "ide-main")!;
  const parse = () => parseSource(source.path, source.client, undefined, source.format, { location: source });
  assert.equal((await parse()).events[0]!.fragments[0]!.historicalStart, 1);
  data.messages.splice(4, 0, { ts: 1_780_000_000_003, say: "tool_error", toolCallId: "read-one", text: "读取失败" });
  data.write("composerData:ide-main", { sessionId: "ide-main", localMessages: data.messages });
  const failure = await parse();
  assert.equal(failure.events[0]!.status, "failure");
  assert.deepEqual(failure.events[0]!.fragments, []);
  const messages = new Map<string, SessionMessage>();
  await parseSessionSource(source, { message: value => messages.set(value.id, value), usage: () => {} });
  assert.equal([...messages.values()].find(item => item.callId === "read-one" && item.kind === "tool_call")?.status, "failure");
  data.messages.splice(4, 1);
  read.content = "读取请求已提交";
  data.messages[3].text = JSON.stringify(read);
  data.messages[4].workingSetEffect.status = "rejected";
  data.write("composerData:ide-main", { sessionId: "ide-main", localMessages: data.messages });
  const rejected = await parse();
  assert.equal(rejected.events[0]!.status, "unknown");
  assert.equal(rejected.events[1]!.status, "failure");
  assert.ok(rejected.events.every(item => item.fragments.length === 0));
}));

test("早期关系表的问答历史保留，使用已记录标题及正式项目，不制造工具记录", async () => fixture(async (directory, repository) => {
  const legacy = new Database(join(directory, "session_data.sqlite"));
  legacy.exec("CREATE TABLE session(session_id TEXT,session_name TEXT,extra TEXT); CREATE TABLE message(id INTEGER,session_id TEXT,content TEXT,create_time INTEGER)");
  legacy.prepare("INSERT INTO session VALUES(?,?,?)").run("legacy-chat", "早期问答", JSON.stringify({ workspaceUri: pathToFileURL(repository).href }));
  legacy.prepare("INSERT INTO message VALUES(1,?,?,1)").run("legacy-chat", JSON.stringify({ Q: { plainText: "早期问题" }, A: [{ reply: "早期回答", modelType: "legacy-model" }] }));
  legacy.close();
  const source = (await discoverSources(roots(directory))).find(item => item.sessionId === "legacy-chat")!;
  const messages: SessionMessage[] = [];
  const summary = await parseSessionSource(source, { message: value => messages.push(value), usage: () => {} });
  assert.equal(summary.title, "早期问答");
  assert.equal(summary.project, repository);
  assert.deepEqual(messages.slice(0, 2).map(item => item.kind), ["user", "assistant"]);
  assert.equal(summary.turnCount, 1);
  assert.equal((await parseSource(source.path, source.client, undefined, source.format, { location: source })).events.length, 0);
  const before = await readIdeSnapshot(source);
  const updated = new Database(source.path);
  updated.prepare("UPDATE message SET content=? WHERE session_id=?").run(JSON.stringify({ Q: { plainText: "更新问题" }, A: [{ reply: "更新回答" }] }), "legacy-chat");
  updated.close();
  assert.notEqual((await readIdeSnapshot(source)).hash, before.hash);
}));

test("迁移前会话列表可补充同身份正式标题，其他标题变化不使本会话指纹失效", async () => fixture(async (directory, repository, data) => {
  data.write("composerHistory", [{ sessionId: "ide-chat", name: "旧会话标题" }, { sessionId: "unrelated", name: "无关标题" }]);
  const source = (await discoverSources(roots(directory))).find(item => item.sessionId === "ide-chat")!;
  const before = await readIdeSnapshot(source);
  assert.equal(before.title, "旧会话标题");
  data.write("composerHistory", [{ sessionId: "ide-chat", name: "旧会话标题" }, { sessionId: "unrelated", name: "另一个标题" }]);
  assert.equal((await readIdeSnapshot(source)).hash, before.hash);
}));
