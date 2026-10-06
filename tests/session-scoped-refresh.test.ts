import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { SessionRefreshOptions } from "../src/session-contracts.js";
import { historyAdapter } from "../src/history/adapters/index.js";
import { refreshSessions } from "../src/sessions/refresh.js";
import { sourceQuickStamp } from "../src/sessions/quick-check.js";
import { SessionStore } from "../src/sessions/store.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

const encode = (value: unknown) => JSON.stringify(value) + "\n";
const codexMessage = (id: string, text: string) => ({ type: "response_item", payload: { type: "message", id, role: "user", content: [{ type: "input_text", text }] } });
const codexSource = (id: string, text: string) => encode({ type: "session_meta", payload: { id, cwd: "/workspace/demo" } }) + encode(codexMessage("first", text));

async function fixture(run: (store: SessionStore, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "manor-scoped-refresh-"));
  const store = new SessionStore(join(directory, "index.sqlite"));
  try { await run(store, directory); }
  finally { store.close(); await rm(directory, { recursive: true, force: true }); }
}

const refresh = async (store: SessionStore, roots: ReturnType<typeof isolatedHistoryRoots>, options: SessionRefreshOptions = {}, clearCache = false) => {
  const job = store.createJob(options);
  await refreshSessions(store, job.id, roots, clearCache);
  return store.getJob(job.id);
};

test("局部刷新只访问所选 Agent，连续发布保留其他来源与检查时间", async () => fixture(async (store, directory) => {
  const codex = join(directory, "codex", "sessions");
  const claude = join(directory, "claude");
  await mkdir(codex, { recursive: true }); await mkdir(claude);
  const codexPath = join(codex, "main.jsonl");
  const claudePath = join(claude, "main.jsonl");
  await writeFile(codexPath, codexSource("codex-demo", "初始请求"));
  await writeFile(claudePath, encode({ type: "user", sessionId: "claude-demo", cwd: "/workspace/other", uuid: "first", message: { role: "user", content: "其他客户端的请求" } }));
  const roots = isolatedHistoryRoots({ codex, claude });
  await refresh(store, roots);
  const before = store.status();
  const claudeCheck = before.clientChecks!.find(check => check.client === "claude");
  const claudeRevision = store.cachedRevisions().find(item => item.client === "claude")!;
  const claudeSession = store.list({ client: "claude" }).sessions[0]!;
  await rm(claudePath);
  await appendFile(codexPath, encode(codexMessage("second", "新的范围内请求")));
  // 无关根即使无法作为目录读取，也不能影响所选范围任务。
  const selected = await refresh(store, { ...roots, claude: store.dbPath }, { client: "codex" });
  assert.equal(selected.counts!.discovered, 1);
  assert.equal(selected.counts!.parsed, 1);
  assert.equal(selected.counts!.missing, 0);
  assert.equal(store.list().total, 2);
  assert.equal(store.cachedRevisions().find(item => item.client === "claude")!.revision, claudeRevision.revision);
  assert.deepEqual(store.status().clientChecks!.find(check => check.client === "claude"), claudeCheck);
  assert.ok(store.search({ q: "其他客户端" }).hits.every(hit => hit.session.id === claudeSession.id));
  assert.equal(store.profile(claudeSession.id).messageCount, 1);
  const codexRevision = store.cachedRevisions().find(item => item.client === "codex")!.revision;
  const codexCheck = store.status().clientChecks!.find(check => check.client === "codex");
  const removed = await refresh(store, roots, { client: "claude", mode: "full" });
  assert.equal(removed.counts!.missing, 1);
  assert.equal(removed.counts!.discovered, 0);
  assert.equal(store.list().total, 1);
  assert.equal(store.cachedRevisions()[0]!.revision, codexRevision);
  assert.deepEqual(store.status().clientChecks!.find(check => check.client === "codex"), codexCheck);
  assert.equal(store.status().clientChecks!.find(check => check.client === "claude")!.mode, "full");
}));

test("快速刷新跳过正文读取，完整校验读取正文并复用相同修订", async () => fixture(async (store, directory) => {
  const root = join(directory, "sessions"); await mkdir(root);
  const path = join(root, "sample.jsonl"); await writeFile(path, codexSource("read-demo", "读取验证"));
  const roots = isolatedHistoryRoots({ codex: root });
  const first = await refresh(store, roots, { client: "codex" });
  assert.equal(first.counts!.parsed, 1);
  assert.deepEqual(first.counts!.fallbacks, [{ reason: "cache_missing", count: 1 }]);
  const revision = store.cachedRevisions()[0]!;
  assert.ok(revision.location && revision.quickFingerprint && revision.metadataFingerprint);
  const original = fs.createReadStream;
  let sourceReads = 0;
  fs.createReadStream = ((...args: Parameters<typeof original>) => {
    if (String(args[0]) === path) sourceReads += 1;
    return original(...args);
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    const quick = await refresh(store, roots, { client: "codex" });
    assert.equal(quick.counts!.quickReused, 1);
    assert.equal(sourceReads, 0, "日常复用不读取正文哈希或重新解析");
    const full = await refresh(store, roots, { client: "codex", mode: "full" });
    assert.equal(full.counts!.quickReused, 0);
    assert.equal(full.counts!.verifiedReused, 1);
    assert.ok(sourceReads > 0, "完整校验实际读取正文");
    assert.equal(store.cachedRevisions()[0]!.revision, revision.revision);
    assert.deepEqual(full.counts!.fallbacks, []);
  } finally { fs.createReadStream = original; syncBuiltinESMExports(); }
}));

test("旧快检记录缺失时退回内容检查，旧成功时间不由版本时间推造", async () => fixture(async (store, directory) => {
  const root = join(directory, "sessions"); await mkdir(root);
  await writeFile(join(root, "sample.jsonl"), codexSource("legacy-demo", "旧缓存验证"));
  const roots = isolatedHistoryRoots({ codex: root });
  await refresh(store, roots, { client: "codex" });
  const revision = store.cachedRevisions()[0]!.revision;
  const db = new Database(store.dbPath);
  try {
    db.exec("UPDATE session_revisions SET source_location=NULL,quick_fingerprint=NULL,metadata_fingerprint=NULL");
    const state = JSON.parse((db.prepare("SELECT json FROM session_state WHERE id=1").get() as { json: string }).json);
    delete state.clientChecks;
    db.prepare("UPDATE session_state SET json=? WHERE id=1").run(JSON.stringify(state));
  } finally { db.close(); }
  assert.equal(store.status().clientChecks, undefined);
  const checked = await refresh(store, roots, { client: "codex" });
  assert.equal(checked.counts!.quickReused, 0);
  assert.equal(checked.counts!.verifiedReused, 1);
  assert.deepEqual(checked.counts!.fallbacks, [{ reason: "check_record_missing", count: 1 }]);
  assert.equal(store.cachedRevisions()[0]!.revision, revision);
  assert.deepEqual(store.status().clientChecks!.map(check => check.client), ["codex"]);
  assert.equal((await refresh(store, roots, { client: "codex" })).counts!.quickReused, 1);
}));

test("CLI 压缩规则升级重解析旧分类，之后恢复快检且保留其他客户端", async () => fixture(async (store, directory) => {
  const root = join(directory, "sessions"); await mkdir(root);
  const cli = join(root, "compact.jsonl");
  const codex = join(directory, "codex"); await mkdir(codex);
  await writeFile(cli, encode({ type: "message", sessionId: "compact-demo", uuid: "request", role: "user", content: "合成请求" })
    + encode({ type: "message", sessionId: "compact-demo", uuid: "compact", role: "user", isCompactSummary: true, content: "合成压缩摘要" }));
  await writeFile(join(codex, "sample.jsonl"), codexSource("other-demo", "其他客户端"));
  const roots = isolatedHistoryRoots({ codeflicker: root, codex });
  await refresh(store, roots);
  const previous = store.cachedRevisions().find(item => item.client === "codeflicker")!;
  const other = store.cachedRevisions().find(item => item.client === "codex")!;
  const session = store.list({ client: "codeflicker" }).sessions[0]!;
  // 模拟旧解析器把原生压缩标记当成用户消息，来源正文保持不变。
  const db = new Database(store.dbPath);
  try {
    db.prepare("UPDATE session_messages SET kind='user',json=json_set(json,'$.kind','user') WHERE revision=? AND kind='compression'").run(previous.revision);
    db.prepare("UPDATE session_revisions SET fingerprint=replace(fingerprint,':compression-v1',''),metadata_fingerprint=NULL WHERE id=?").run(previous.revision);
  } finally { db.close(); }
  assert.equal(store.profile(session.id).compressions, 0);
  const upgraded = await refresh(store, roots, { client: "codeflicker" });
  assert.equal(upgraded.status, "complete");
  assert.equal(upgraded.counts!.parsed, 1);
  assert.equal(upgraded.counts!.verifiedReused, 0);
  assert.equal(store.profile(session.id).compressions, 1);
  assert.notEqual(store.cachedRevisions().find(item => item.client === "codeflicker")!.revision, previous.revision);
  assert.equal(store.cachedRevisions().find(item => item.client === "codex")!.revision, other.revision);
  assert.equal((await refresh(store, roots, { client: "codeflicker" })).counts!.quickReused, 1);
}));

test("正文、标题及规则变化使快检失效，完整校验能发现错误变化指示", async () => fixture(async (store, directory) => {
  const home = join(directory, "client"); const root = join(home, "sessions"); await mkdir(root, { recursive: true });
  const path = join(root, "sample.jsonl");
  await writeFile(path, codexSource("change-demo", "原始请求"));
  const roots = isolatedHistoryRoots({ codex: root });
  await refresh(store, roots, { client: "codex" });
  await writeFile(path, codexSource("change-demo", "变化请求"));
  const changed = await refresh(store, roots, { client: "codex" });
  assert.equal(changed.counts!.parsed, 1);
  assert.equal(changed.counts!.fallbacks[0]!.reason, "source_changed");
  await writeFile(join(home, "session_index.jsonl"), encode({ id: "change-demo", thread_name: "旁路正式标题" }));
  const title = await refresh(store, roots, { client: "codex" });
  assert.equal(title.counts!.parsed, 1);
  assert.equal(title.counts!.fallbacks[0]!.reason, "metadata_changed");
  assert.equal(store.list().sessions[0]!.title, "旁路正式标题");
  const db = new Database(store.dbPath);
  try { db.exec("UPDATE session_revisions SET metadata_fingerprint='old-rule'"); }
  finally { db.close(); }
  const rule = await refresh(store, roots, { client: "codex" });
  assert.equal(rule.counts!.parsed, 1);
  const cached = store.cachedRevisions()[0]!;
  await writeFile(path, codexSource("change-demo", "完整核对"));
  // 模拟变化指示碰撞；该指示本身不能当成内容证明。
  const stamp = await sourceQuickStamp(cached.location!);
  const collision = new Database(store.dbPath);
  try { collision.prepare("UPDATE session_revisions SET quick_fingerprint=? WHERE id=?").run(stamp, cached.revision); }
  finally { collision.close(); }
  assert.equal((await refresh(store, roots, { client: "codex" })).counts!.quickReused, 1);
  const full = await refresh(store, roots, { client: "codex", mode: "full" });
  assert.equal(full.counts!.parsed, 1);
  assert.equal(store.messages(store.list().sessions[0]!.id).messages[0]!.text, "完整核对");
}));

test("来源解析期间追加不保存新快检标记，失败不更新版本与客户端时间", async () => fixture(async (store, directory) => {
  const root = join(directory, "sessions"); await mkdir(root);
  const path = join(root, "sample.jsonl"); await writeFile(path, codexSource("active-demo", "活动请求"));
  const roots = isolatedHistoryRoots({ codex: root });
  const original = store.createRevision.bind(store);
  let appended = false;
  store.createRevision = (key, fingerprint) => {
    const pending = original(key, fingerprint);
    return { ...pending, sink: { usage: pending.sink.usage, message: message => {
      pending.sink.message(message);
      if (!appended) { appended = true; fs.appendFileSync(path, encode(codexMessage("second", "追加请求"))); }
    } } };
  };
  await refresh(store, roots, { client: "codex" });
  assert.equal(store.cachedRevisions()[0]!.quickFingerprint, undefined);
  assert.equal(store.messages(store.list().sessions[0]!.id).total, 1);
  store.createRevision = original;
  await refresh(store, roots, { client: "codex" });
  assert.equal(store.messages(store.list().sessions[0]!.id).total, 2);
  const before = store.status();
  const failed = store.createJob({ client: "codex", mode: "full" });
  await assert.rejects(refreshSessions(store, failed.id, { ...roots, codex: path }));
  assert.equal(store.status().version, before.version);
  assert.deepEqual(store.status().clientChecks, before.clientChecks);
  assert.equal(store.getJob(failed.id).status, "failed");
}));

test("发现后首次检查前旁路元信息变化，不把旧项目绑定到新快检标记", async () => fixture(async (store, directory) => {
  const root = join(directory, "desktop");
  const session = join(root, "desktop-example");
  await mkdir(join(session, "message"), { recursive: true });
  await mkdir(join(session, "checkpoints"));
  const registry = join(session, "checkpoints", "registry.json");
  const oldRegistry = { sessionId: "desktop-example", cwd: "/workspace/old-project" };
  const newRegistry = { sessionId: "desktop-example", cwd: "/workspace/new-project" };
  await writeFile(registry, JSON.stringify(oldRegistry));
  await writeFile(join(session, "message", "cache.jsonl"), encode({ kind: "message", id: "message-example", role: "user", content: "项目切换验证" }));
  const roots = isolatedHistoryRoots({ "codeflicker-desktop": root });
  const originalUpdate = store.updateJob.bind(store);
  let changed = false;
  store.updateJob = (jobId, update) => {
    if (!changed && update.phase === "index") {
      changed = true;
      fs.writeFileSync(registry, JSON.stringify(newRegistry));
    }
    return originalUpdate(jobId, update);
  };
  try { await refresh(store, roots, { client: "codeflicker-desktop" }); }
  finally { store.updateJob = originalUpdate; }
  assert.equal(changed, true);
  assert.equal(store.cachedRevisions()[0]!.quickFingerprint, undefined, "元信息发现与快检之间变动，禁止保存新标记");
  assert.equal(store.cachedRevisions()[0]!.location!.discoveryQuickStamp, undefined, "瞬态发现标记不落入缓存位置");
  const next = await refresh(store, roots, { client: "codeflicker-desktop" });
  assert.equal(next.counts!.quickReused, 0);
  assert.equal(store.list().sessions[0]!.project, newRegistry.cwd);
  assert.equal(store.cachedRevisions()[0]!.location!.cwd, newRegistry.cwd);
  assert.ok(store.cachedRevisions()[0]!.quickFingerprint);
  assert.equal((await refresh(store, roots, { client: "codeflicker-desktop" })).counts!.quickReused, 1);
}));

test("发现读取旁路元信息期间变化，也不把旧元信息绑定到新标记", async () => fixture(async (store, directory) => {
  const root = join(directory, "desktop");
  const session = join(root, "desktop-example");
  await mkdir(join(session, "message"), { recursive: true });
  await mkdir(join(session, "checkpoints"));
  const registry = join(session, "checkpoints", "registry.json");
  await writeFile(registry, JSON.stringify({ sessionId: "desktop-example", cwd: "/workspace/old-project" }));
  await writeFile(join(session, "message", "cache.jsonl"), encode({ kind: "message", id: "message-example", role: "user", content: "发现窗口验证" }));
  const adapter = historyAdapter("codeflicker-desktop-jsonl")!;
  const originalMetadata = adapter.readSourceMetadata!;
  adapter.readSourceMetadata = async location => {
    const metadata = await originalMetadata(location);
    await writeFile(registry, JSON.stringify({ sessionId: "desktop-example", cwd: "/workspace/new-project" }));
    return metadata;
  };
  const roots = isolatedHistoryRoots({ "codeflicker-desktop": root });
  try { await refresh(store, roots, { client: "codeflicker-desktop" }); }
  finally { adapter.readSourceMetadata = originalMetadata; }
  assert.equal(store.cachedRevisions()[0]!.quickFingerprint, undefined);
  const next = await refresh(store, roots, { client: "codeflicker-desktop" });
  assert.equal(next.counts!.quickReused, 0);
  assert.equal(store.list().sessions[0]!.project, "/workspace/new-project");
  assert.equal((await refresh(store, roots, { client: "codeflicker-desktop" })).counts!.quickReused, 1);
}));

test("不支持快检的来源仍完整检查，清缓存强制全部客户端重建", async () => fixture(async (store, directory) => {
  const piRoot = join(directory, "pi"); const codexRoot = join(directory, "sessions");
  await mkdir(piRoot); await mkdir(codexRoot);
  await writeFile(join(codexRoot, "main.jsonl"), codexSource("rebuild-demo", "全局重建验证"));
  await writeFile(join(piRoot, "main.jsonl"), encode({ type: "session", version: 3, id: "pi-demo", cwd: "/workspace/pi", timestamp: "2026-01-01T00:00:00Z" })
    + encode({ type: "message", id: "user", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "事件树验证" }] } }));
  const roots = isolatedHistoryRoots({ codex: codexRoot, pi: piRoot });
  await refresh(store, roots);
  const pi = await refresh(store, roots, { client: "pi" });
  assert.equal(pi.counts!.quickReused, 0);
  assert.equal(pi.counts!.verifiedReused, 1);
  assert.deepEqual(pi.counts!.fallbacks, [{ reason: "unsupported_source", count: 1 }]);
  const revisions = store.cachedRevisions().map(item => item.revision);
  const rebuilt = await refresh(store, roots, { client: "codex", mode: "quick" }, true);
  assert.equal(rebuilt.client, undefined);
  assert.equal(rebuilt.mode, "full");
  assert.equal(rebuilt.counts!.discovered, 2);
  assert.equal(rebuilt.counts!.parsed, 2);
  assert.ok(store.cachedRevisions().every(item => !revisions.includes(item.revision)));
  const before = store.status();
  const adapter = historyAdapter("pi-jsonl")!;
  const read = adapter.readRecords;
  adapter.readRecords = async () => { throw Object.assign(new Error("合成的旁路读取失败"), { code: "ENOENT" }); };
  const failed = store.createJob({ client: "pi" });
  try { await assert.rejects(refreshSessions(store, failed.id, roots), /旁路读取失败/); }
  finally { adapter.readRecords = read; }
  assert.equal(store.status().version, before.version, "来源仍存在的旁路错误不能发布来源删除");
  assert.deepEqual(store.status().clientChecks, before.clientChecks);
}));

test("已存在的会话修订表迁移为可空检查字段，不假造来源检查记录", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-refresh-migration-"));
  const path = join(directory, "index.sqlite");
  const db = new Database(path);
  db.exec(`CREATE TABLE session_revisions (id TEXT PRIMARY KEY,path TEXT NOT NULL,fingerprint TEXT NOT NULL,
    session_id TEXT,client TEXT,project TEXT,title TEXT,started_at TEXT,updated_at TEXT,json TEXT NOT NULL)`);
  db.close();
  const store = new SessionStore(path);
  try {
    const migrated = new Database(path);
    try {
      const columns = (migrated.prepare("PRAGMA table_info(session_revisions)").all() as { name: string }[]).map(column => column.name);
      assert.ok(["source_location", "quick_fingerprint", "metadata_fingerprint"].every(column => columns.includes(column)));
    } finally { migrated.close(); }
    assert.equal(store.status().clientChecks, undefined);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
