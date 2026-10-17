import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("原始用量规则升级使未变来源重新解析，范围外客户端修订保持不变", async () => fixture(async (store, directory) => {
  const codex = join(directory, "codex");
  const claude = join(directory, "claude");
  await mkdir(codex); await mkdir(claude);
  await writeFile(join(codex, "source.jsonl"), codexSource("source-demo", "合成需求"));
  await writeFile(join(claude, "source.jsonl"), encode({ type: "user", uuid: "user", sessionId: "other-demo",
    message: { role: "user", content: "其他客户端" } }));
  const roots = isolatedHistoryRoots({ codex, claude });
  await refresh(store, roots);
  const before = store.cachedRevisions();
  const original = before.find(item => item.client === "codex")!;
  const untouched = before.find(item => item.client === "claude")!;
  assert.ok(original.fingerprint.includes(":usage-source-v1"));
  assert.ok(!untouched.fingerprint.includes(":usage-source-v1"));
  const db = new Database(store.dbPath);
  db.prepare("UPDATE session_revisions SET fingerprint=replace(fingerprint,':usage-source-v1',''),metadata_fingerprint='old-usage-rule' WHERE id=?").run(original.revision);
  db.close();
  const job = await refresh(store, roots, { client: "codex", mode: "quick" });
  assert.equal(job.counts?.parsed, 1);
  const current = store.cachedRevisions();
  assert.notEqual(current.find(item => item.client === "codex")?.revision, original.revision);
  assert.equal(current.find(item => item.client === "claude")?.revision, untouched.revision);
  const reused = await refresh(store, roots, { client: "codex", mode: "quick" });
  assert.equal(reused.counts?.parsed, 0);
  assert.equal(reused.counts?.quickReused, 1);
}));

test("可读正文规则升级修复旧诊断并保留摘要，其他客户端不重建", async () => fixture(async (store, directory) => {
  const codex = join(directory, "codex"), claude = join(directory, "claude");
  await mkdir(codex); await mkdir(claude);
  await writeFile(join(codex, "source.jsonl"), codexSource("readable-summary", "合成需求")
    + encode({ type: "response_item", payload: { type: "compaction", content: [], summary: "合成压缩摘要", encrypted_content: "synthetic" } }));
  await writeFile(join(claude, "source.jsonl"), encode({ type: "user", uuid: "user", sessionId: "other-demo", message: { content: "其他客户端" } }));
  const roots = isolatedHistoryRoots({ codex, claude });
  await refresh(store, roots);
  const previous = store.cachedRevisions().find(item => item.client === "codex")!;
  const other = store.cachedRevisions().find(item => item.client === "claude")!;
  assert.ok(previous.fingerprint.includes(":readable-content-v1"));
  const session = store.list({ client: "codex" }).sessions[0]!;
  const db = new Database(store.dbPath);
  try {
    db.prepare("UPDATE session_revisions SET fingerprint=replace(fingerprint,':readable-content-v1',''),metadata_fingerprint=NULL,json=json_set(json,'$.gaps',json(?)) WHERE id=?")
      .run(JSON.stringify([{ kind: "unsupported_format", message: "合成旧诊断", messageDescriptor: { key: "diagnostics.sessions.parser.m013" } }]), previous.revision);
  } finally { db.close(); }
  assert.ok(store.profile(session.id).gaps.some(gap => gap.messageDescriptor?.key === "diagnostics.sessions.parser.m013"));
  const upgraded = await refresh(store, roots, { client: "codex", mode: "quick" });
  assert.equal(upgraded.counts?.parsed, 1);
  assert.ok(!store.profile(session.id).gaps.some(gap => gap.messageDescriptor?.key === "diagnostics.sessions.parser.m013"));
  assert.ok(store.messages(session.id, { mode: "full" }).messages.some(message => message.kind === "compression" && message.text === "合成压缩摘要"));
  assert.equal(store.cachedRevisions().find(item => item.client === "claude")!.revision, other.revision);
  assert.equal((await refresh(store, roots, { client: "codex", mode: "quick" })).counts?.quickReused, 1);
}));

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

test("统一轮次规则升级一次覆盖全部旧客户端，后续恢复局部快速刷新", async () => fixture(async (store, directory) => {
  const codex = join(directory, "codex"); const claude = join(directory, "claude");
  await mkdir(codex); await mkdir(claude);
  await writeFile(join(codex, "sample.jsonl"), codexSource("upgrade-codex", "合成请求"));
  await writeFile(join(claude, "sample.jsonl"), encode({ type: "user", sessionId: "upgrade-claude", uuid: "request", message: { role: "user", content: "合成请求" } }));
  const roots = isolatedHistoryRoots({ codex, claude });
  await refresh(store, roots);
  const before = store.cachedRevisions();
  const db = new Database(store.dbPath);
  try {
    db.exec("UPDATE session_revisions SET fingerprint=replace(fingerprint,':round-rules-v1',''),metadata_fingerprint=NULL");
  } finally { db.close(); }
  const upgraded = await refresh(store, roots, { client: "codex" });
  assert.equal(upgraded.client, undefined, "规则升级的发布范围必须覆盖全部来源");
  assert.equal(upgraded.counts!.parsed, 2);
  assert.ok(store.cachedRevisions().every(item => item.fingerprint.includes(":round-rules-v1") && !before.some(old => old.revision === item.revision)));
  const claudeRevision = store.cachedRevisions().find(item => item.client === "claude")!.revision;
  const quick = await refresh(store, { ...roots, claude: store.dbPath }, { client: "codex" });
  assert.equal(quick.client, "codex");
  assert.equal(quick.counts!.quickReused, 1);
  assert.equal(quick.counts!.parsed, 0);
  assert.equal(store.cachedRevisions().find(item => item.client === "claude")!.revision, claudeRevision);
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

test("CLI 缓存零值规则只升级 CLI 修订，旧未知用量重算后恢复快检", async () => fixture(async (store, directory) => {
  const cli = join(directory, "cli"), codex = join(directory, "codex"); await mkdir(cli); await mkdir(codex);
  await writeFile(join(cli, "cache.jsonl"), encode({ type: "message", sessionId: "cache-demo", uuid: "u", role: "user", content: "合成请求" })
    + encode({ type: "message", sessionId: "cache-demo", uuid: "a", role: "assistant", content: "合成回复", model: "synthetic-model",
      usage: { input_tokens: 100, output_tokens: 10 }, metadata: { requestTokenBaseline: { requestId: "r", requestContextKey: "synthetic", historyRevision: 0 } } }));
  await writeFile(join(codex, "sample.jsonl"), codexSource("other-cache", "其他客户端"));
  const roots = isolatedHistoryRoots({ codeflicker: cli, codex }); await refresh(store, roots);
  const before = store.cachedRevisions().find(item => item.client === "codeflicker")!, other = store.cachedRevisions().find(item => item.client === "codex")!;
  const session = store.list({ client: "codeflicker" }).sessions[0]!;
  const db = new Database(store.dbPath);
  try {
    db.prepare("UPDATE session_revisions SET fingerprint=replace(fingerprint,':cli-cache-zero-v1','') WHERE id=?").run(before.revision);
    db.prepare("UPDATE session_usage SET json=json_remove(json,'$.cachedInputTokens','$.cacheWriteTokens') WHERE revision=?").run(before.revision);
  } finally { db.close(); }
  const upgraded = await refresh(store, roots, { client: "codeflicker" });
  assert.equal(upgraded.status, "complete");
  assert.equal(upgraded.counts!.parsed, 1);
  assert.notEqual(store.cachedRevisions().find(item => item.client === "codeflicker")!.revision, before.revision);
  assert.equal(store.cachedRevisions().find(item => item.client === "codex")!.revision, other.revision);
  assert.equal(store.profile(session.id).usage.cachedInputTokens, 0);
  assert.equal(store.profile(session.id).usage.cacheWriteTokens, 0);
  assert.equal((await refresh(store, roots, { client: "codeflicker" })).counts!.quickReused, 1);
}));

test("服务商规则升级重解析原始来源并保留用量事实，之后恢复快速复用", async () => fixture(async (store, directory) => {
  const root = join(directory, "sessions"); await mkdir(root);
  await writeFile(join(root, "provider.jsonl"), encode({ type: "session_meta", payload: {
    id: "provider-demo", cwd: "/workspace/demo", model_provider: "synthetic-provider",
  } }) + encode({ type: "token_usage_record", payload: { response_id: "request", usage: {
    input_tokens: 100, output_tokens: 10, cached_input_tokens: 80,
  } } }));
  const roots = isolatedHistoryRoots({ codex: root });
  await refresh(store, roots, { client: "codex" });
  const previous = store.cachedRevisions()[0]!;
  const database = new Database(store.dbPath);
  try {
    database.prepare("UPDATE session_revisions SET fingerprint=replace(fingerprint, ':usage-provider-v1', ''),metadata_fingerprint='previous-provider-rule' WHERE id=?").run(previous.revision);
  } finally { database.close(); }
  assert.equal((await refresh(store, roots, { client: "codex" })).counts!.parsed, 1);
  const current = store.cachedRevisions()[0]!;
  assert.notEqual(current.revision, previous.revision);
  assert.equal(store.usageFacts(current.revision)[0]?.provider, "synthetic-provider");
  assert.equal(store.usageFacts(current.revision)[0]?.inputTokens, 100);
  assert.equal((await refresh(store, roots, { client: "codex" })).counts!.quickReused, 1);
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

test("无版本标记但已有旧表的索引明确拒绝，不迁移或假造来源检查记录", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-refresh-unsupported-"));
  const path = join(directory, "index.sqlite");
  const db = new Database(path);
  db.exec(`CREATE TABLE session_revisions (id TEXT PRIMARY KEY,path TEXT NOT NULL,fingerprint TEXT NOT NULL,
    session_id TEXT,client TEXT,project TEXT,title TEXT,started_at TEXT,updated_at TEXT,json TEXT NOT NULL)`);
  db.close();
  try {
    assert.throws(() => new SessionStore(path), /不支持的索引版本/);
    const original = new Database(path);
    try {
      const columns = (original.prepare("PRAGMA table_info(session_revisions)").all() as { name: string }[]).map(column => column.name);
      assert.ok(["source_location", "quick_fingerprint", "metadata_fingerprint"].every(column => !columns.includes(column)));
      assert.equal(original.pragma("user_version", { simple: true }), 0);
      assert.equal((original.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get() as { count: number }).count, 1);
    } finally { original.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("新库重开保留来源快检记录，不重新解析未变化正文", async () => fixture(async (store, directory) => {
  const root = join(directory, "sessions");
  await mkdir(root);
  await writeFile(join(root, "main.jsonl"), codexSource("reopen-demo", "重开来源检查"));
  const roots = isolatedHistoryRoots({ codex: root });
  await refresh(store, roots, { client: "codex" });
  const before = store.cachedRevisions();
  const checks = store.status().clientChecks;
  const search = store.search({ q: "重开来源" });
  const reopened = new SessionStore(store.dbPath);
  try {
    assert.deepEqual(reopened.cachedRevisions(), before);
    assert.deepEqual(reopened.status().clientChecks, checks);
    const result = await refresh(reopened, roots, { client: "codex" });
    assert.equal(result.counts!.quickReused, 1);
    assert.equal(result.counts!.parsed, 0);
    assert.deepEqual(reopened.cachedRevisions(), before);
    const after = reopened.search({ q: "重开来源" });
    assert.deepEqual({ ...after, version: search.version }, search);
    assert.equal(after.version, reopened.status().version);
  } finally { reopened.close(); }
}));

test("计时规则升级回填旧缓存，旧 JSON 可查，失败保持前版且未变化来源复用", async () => fixture(async (store, directory) => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
  const codex = join(directory, "codex"); const claude = join(directory, "claude"); const codeflicker = join(directory, "cli");
  const desktop = join(directory, "desktop");
  for (const root of [codex, claude, codeflicker]) await mkdir(root);
  await mkdir(join(desktop, "desktop-example", "message"), { recursive: true });
  await writeFile(join(codex, "request.jsonl"), encode({ type: "session_meta", payload: { id: "speed-codex" } })
    + encode({ ...codexMessage("user", "合成速度请求"), timestamp: at(0) })
    + encode({ type: "response_item", timestamp: at(10), payload: { type: "message", id: "assistant", role: "assistant", phase: "final_answer",
      content: [{ type: "output_text", text: "合成响应" }] } })
    + encode({ type: "token_usage_record", timestamp: at(10), payload: { response_id: "model-request", usage: { output_tokens: 400, input_tokens: 100 } } }));
  await writeFile(join(claude, "request.jsonl"), encode({ type: "user", uuid: "user", sessionId: "speed-claude", timestamp: at(0), message: { role: "user", content: "合成速度请求" } })
    + encode({ type: "assistant", uuid: "assistant", sessionId: "speed-claude", timestamp: at(10), message: { role: "assistant", id: "model-request",
      content: [{ type: "text", text: "合成响应" }], stop_reason: "end_turn", usage: { output_tokens: 400, input_tokens: 100 } } }));
  await writeFile(join(codeflicker, "request.jsonl"), encode({ type: "message", uuid: "user", sessionId: "speed-cli", timestamp: at(0), role: "user", content: "合成速度请求" })
    + encode({ type: "message", uuid: "assistant", sessionId: "speed-cli", timestamp: at(10), role: "assistant", model: "fixture-model", content: [{ type: "text", text: "合成响应" }],
      metadata: { requestTokenBaseline: { requestId: "model-request" } }, usage: { output_tokens: 400, input_tokens: 100 } }));
  await writeFile(join(desktop, "desktop-example", "message", "cache.jsonl"), encode({ kind: "message", id: "user", role: "user", content: "未核验来源保留" }));
  const roots = isolatedHistoryRoots({ codex, claude, codeflicker, "codeflicker-desktop": desktop });
  await refresh(store, roots);
  const oldVersion = store.status().version!;
  const revisions = store.cachedRevisions();
  const desktopRevision = revisions.find(item => item.client === "codeflicker-desktop")!;
  const db = new Database(store.dbPath);
  try {
    for (const revision of revisions.filter(item => item.client !== "codeflicker-desktop")) {
      assert.ok(revision.fingerprint.includes(":request-timing-v2"));
      const metadataSuffix = revision.fingerprint.split(":request-timing-v2")[1]!;
      const oldMetadata = createHash("sha256").update(JSON.stringify({ rule: "6", source: revision.location, metadataSuffix })).digest("hex");
      db.prepare("UPDATE session_revisions SET fingerprint=?,metadata_fingerprint=? WHERE id=?")
        .run(revision.fingerprint.replace(":request-timing-v2", ""), oldMetadata, revision.revision);
      db.prepare("UPDATE session_usage SET json=json_remove(json,'$.timing','$.requestMessageIds') WHERE revision=?").run(revision.revision);
    }
  } finally { db.close(); }
  const sessions = store.list().sessions;
  for (const session of sessions.filter(item => item.client !== "codeflicker-desktop")) {
    assert.equal(store.profile(session.id).outputSpeed?.tokensPerSecond, null, "旧字段缺失不阻断查询");
    assert.equal(store.profile(session.id).usage.outputTokens, 400);
  }
  const originalFinish = store.finishRevision.bind(store);
  store.finishRevision = () => { throw new Error("合成回填发布失败"); };
  try { await assert.rejects(refresh(store, roots, { client: "codex" }), /回填发布失败/); }
  finally { store.finishRevision = originalFinish; }
  assert.equal(store.status().version, oldVersion);
  assert.deepEqual(store.cachedRevisions().map(item => item.revision), revisions.map(item => item.revision));
  const checked = await refresh(store, roots);
  assert.equal(checked.counts!.parsed, 3);
  assert.equal(checked.counts!.quickReused, 1);
  assert.equal(store.cachedRevisions().find(item => item.client === "codeflicker-desktop")!.revision, desktopRevision.revision);
  for (const session of sessions.filter(item => item.client !== "codeflicker-desktop")) {
    const profile = store.profile(session.id);
    assert.equal(profile.outputSpeed?.tokensPerSecond, 40, JSON.stringify({ client: session.client, steps: profile.steps }));
    assert.equal(profile.version, store.status().version);
    assert.equal(store.profile(session.id, { version: oldVersion }).outputSpeed?.tokensPerSecond, null);
  }
  assert.equal((await refresh(store, roots)).counts!.quickReused, 4, "新规则回填后恢复日常复用");
}));
