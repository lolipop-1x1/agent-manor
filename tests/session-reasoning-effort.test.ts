import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Client } from "../src/clients.js";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";
import { parseSessionSource } from "../src/sessions/parser.js";
import { desktopModels } from "../src/sessions/codeflicker-desktop.js";
import { refreshSessions } from "../src/sessions/refresh.js";
import { SessionStore } from "../src/sessions/store.js";
import { isolatedHistoryRoots } from "./helpers/history-roots.js";

const at = "2026-10-06T00:00:00.000Z";
const encode = (records: unknown[]) => `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
const usage = { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5 };
const codexContext = (effort: unknown, field = "effort") => ({ type: "turn_context", timestamp: at,
  payload: { model: "synthetic-model", [field]: effort } });
const codexMessage = (id: string, role: string) => ({ type: "response_item", timestamp: at,
  payload: { type: "message", id, role, phase: role === "assistant" ? "final" : undefined,
    content: [{ type: role === "user" ? "input_text" : "output_text", text: id }] } });
const codexUsage = (id: string, total = 100) => ({ type: "token_usage_record", timestamp: at,
  payload: { response_id: id, usage, thread_token_usage: { ...usage, input_tokens: total } } });

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "manor-reasoning-effort-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function parsed(client: Client, records: unknown[], path: string, options: Parameters<typeof parseSessionSource>[2] = {}) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encode(records));
  const messages = new Map<string, SessionMessage>();
  const usages = new Map<string, SessionUsage>();
  const summary = await parseSessionSource({ client, path,
    format: client === "codeflicker-desktop" ? "codeflicker-desktop-jsonl" : undefined }, {
    message: value => messages.set(value.id, value), usage: value => usages.set(value.id, value),
  }, options);
  return { summary, messages: [...messages.values()], usages: [...usages.values()] };
}

test("Codex 请求采用生效档位，后续配置不回写旧请求，缺失或 null 保持未知", async () => temporary(async directory => {
  const result = await parsed("codex", [
    { type: "session_meta", payload: { id: "synthetic-effort" } },
    codexContext("high"), codexMessage("user-a", "user"), codexMessage("answer-a", "assistant"),
    codexContext("low", "reasoning_effort"), codexUsage("request-a"), codexUsage("request-a"),
    codexMessage("user-b", "user"), codexMessage("answer-b", "assistant"), codexUsage("request-b", 200),
    codexContext(null), codexMessage("user-c", "user"), codexMessage("answer-c", "assistant"), codexUsage("request-c", 300),
    codexContext("future-precise"), codexMessage("user-d", "user"), codexMessage("answer-d", "assistant"),
    { type: "turn_context", payload: { model: "synthetic-model" } },
    codexMessage("user-e", "user"), codexMessage("answer-e", "assistant"), codexUsage("request-e", 400),
  ], join(directory, "codex.jsonl"));
  const steps = new Map(result.usages.map(value => [value.turnId, value.reasoningEffort]));
  assert.deepEqual(result.messages.filter(value => value.kind === "assistant").map(value => value.reasoningEffort),
    ["high", "low", undefined, "future-precise", undefined]);
  assert.deepEqual([...steps.values()], ["high", "low", undefined, undefined, "future-precise"]);
  assert.equal(result.usages.find(value => value.reasoningEffort === "future-precise")?.inputTokens, undefined,
    "缺失用量的已识别请求仍保留其生效档位");
  assert.ok(result.messages.filter(value => value.kind === "user").every(value => value.reasoningEffort === undefined));
}));

test("Claude 与 CodeFlicker 只保留助手请求的明确设置，不用推理用量补档位", async () => temporary(async directory => {
  for (const client of ["claude", "codeflicker"] as const) {
    const native = (id: string, effort?: string) => client === "claude"
      ? { type: "assistant", uuid: id, sessionId: "synthetic-effort", timestamp: at, effort,
        message: { id, role: "assistant", model: "synthetic-model", content: [{ type: "text", text: id }],
          stop_reason: "end_turn", usage: { input_tokens: 80, cache_read_input_tokens: 10, cache_creation_input_tokens: 0,
            output_tokens: 20, reasoning_output_tokens: 19 } } }
      : { type: "message", uuid: id, sessionId: "synthetic-effort", timestamp: at, reasoningEffort: effort,
        role: "assistant", model: "synthetic-model", content: [{ type: "text", text: id }], stop_reason: "end_turn",
        metadata: { requestTokenBaseline: { requestId: id } },
        usage: { input_tokens: 90, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 19 } };
    const result = await parsed(client, [native("request-a", "high"), native("request-b")], join(directory, `${client}.jsonl`));
    assert.deepEqual(result.usages.map(value => value.reasoningEffort), ["high", undefined]);
    assert.deepEqual(result.messages.filter(value => value.kind === "assistant").map(value => value.reasoningEffort), ["high", undefined]);
  }
}));

test("Claude 同一请求保留首次明确档位，后续快照仅补齐原先缺失的设置", async () => temporary(async directory => {
  const snapshot = (uuid: string, request: string, effort?: string) => ({ type: "assistant", uuid, sessionId: "synthetic-effort",
    timestamp: at, effort, message: { id: request, role: "assistant", model: "synthetic-model",
      content: [{ type: "text", text: uuid }], stop_reason: "end_turn",
      usage: { input_tokens: 80, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 20 } } });
  const result = await parsed("claude", [
    snapshot("known-first", "known-request", "high"), snapshot("known-later", "known-request", "low"),
    snapshot("missing-first", "missing-request"), snapshot("missing-filled", "missing-request", "high"),
    snapshot("missing-later", "missing-request", "low"),
  ], join(directory, "claude-snapshots.jsonl"));
  assert.equal(result.usages.length, 2);
  assert.deepEqual(result.usages.map(value => value.reasoningEffort), ["high", "high"]);
}));

test("Pi 思考程度沿分支祖先配置绑定，各分支及 off 值互不覆盖", async () => temporary(async directory => {
  const entry = (id: string, parentId: string | null, type: string, extra: Record<string, unknown>) => ({ id, parentId, type, timestamp: at, ...extra });
  const answer = (id: string, parentId: string) => entry(id, parentId, "message", { message: { role: "assistant", model: "synthetic-model",
    content: [{ type: "text", text: id }], stopReason: "stop", usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 20 } } });
  const result = await parsed("pi", [
    { type: "session", version: 3, id: "synthetic-pi-effort", timestamp: at, cwd: "/synthetic/repo" },
    entry("user", null, "message", { message: { role: "user", content: [{ type: "text", text: "synthetic prompt" }] } }),
    entry("config-high", "user", "thinking_level_change", { thinkingLevel: "high" }), answer("high-answer", "config-high"),
    entry("config-low", "user", "thinking_level_change", { thinkingLevel: "low" }), answer("low-answer", "config-low"),
    answer("high-again", "high-answer"), answer("unknown-answer", "user"),
    entry("config-off", "low-answer", "thinking_level_change", { thinkingLevel: "off" }), answer("off-answer", "config-off"),
  ], join(directory, "pi.jsonl"));
  assert.deepEqual(result.messages.filter(value => value.kind === "assistant").map(value => value.reasoningEffort),
    ["high", "low", "high", undefined, "off"]);
  assert.deepEqual(result.usages.map(value => value.reasoningEffort), ["high", "low", "high", undefined, "off"]);
}));

test("Qoder 运行配置按请求生效，流式快照不因后续配置而改档位", async () => temporary(async directory => {
  const answer = (id: string, text = id) => ({ type: "assistant", sessionId: "synthetic-qoder-effort", uuid: id, timestamp: at,
    message: { id, role: "assistant", content: [{ type: "text", text }], model: "synthetic-model", usage } });
  const config = (reasoningEffort: unknown) => ({ type: "runtime-config", sessionId: "synthetic-qoder-effort", reasoningEffort });
  const result = await parsed("qoder", [config("medium"), answer("request-a"), config("high"), answer("request-a", "stream-final"),
    answer("request-b"), config(null), answer("request-c")], join(directory, "qoder.jsonl"));
  assert.deepEqual(result.usages.map(value => value.reasoningEffort), ["medium", "high", undefined]);
  assert.deepEqual(result.messages.filter(value => value.kind === "assistant").map(value => value.reasoningEffort), ["medium", "high", undefined]);
}));

test("桌面明确镜像请求保留思考程度并通过请求身份绑定用量", async () => temporary(async directory => {
  const path = join(directory, "sessions", "synthetic-desktop", "message", "cache.jsonl");
  const mirror = join(dirname(dirname(path)), "claude-session", "native.jsonl");
  await mkdir(dirname(mirror), { recursive: true });
  await writeFile(mirror, encode([
    { type: "user", uuid: "native-user", timestamp: at },
    { type: "assistant", uuid: "native-answer", parentUuid: "native-user", timestamp: at, effort: "high",
      message: { id: "native-request", model: "synthetic-model", stop_reason: "end_turn", usage: { output_tokens: 20 } } },
  ]));
  const models = await desktopModels(path);
  assert.equal(models.entries.get("native-answer")?.reasoningEffort, "high");
  const result = await parsed("codeflicker-desktop", [{ kind: "message", id: "desktop-answer", role: "assistant", content: "synthetic answer",
    timestamp: at, extra: { "claude-code": { lastEntryUuid: "native-answer" }, backend: { type: "CLAUDE_CODE" } },
    usage: { inputTokens: 90, cacheReadInputTokens: 10, cacheCreationInputTokens: 0, outputTokens: 20 } }], path,
  { desktopModels: models.entries });
  assert.equal(result.messages.find(value => value.kind === "assistant")?.reasoningEffort, "high");
  assert.equal(result.usages[0]?.reasoningEffort, "high");
}));

test("桌面同一镜像请求的所有 UUID 沿用首次明确档位，缺失设置仍可补齐", async () => temporary(async directory => {
  const path = join(directory, "sessions", "synthetic-desktop", "message", "cache.jsonl");
  const mirror = join(dirname(dirname(path)), "claude-session", "native.jsonl");
  const snapshot = (uuid: string, request: string, effort?: string) => ({ type: "assistant", uuid, timestamp: at, effort,
    message: { id: request, model: "synthetic-model", stop_reason: "end_turn", usage: { output_tokens: 20 } } });
  await mkdir(dirname(mirror), { recursive: true });
  await writeFile(mirror, encode([
    snapshot("known-first", "known-request", "high"), snapshot("known-later", "known-request", "low"),
    snapshot("missing-first", "missing-request"), snapshot("missing-filled", "missing-request", "high"),
    snapshot("missing-later", "missing-request", "low"),
  ]));
  const models = await desktopModels(path);
  assert.equal(models.entries.size, 5);
  assert.ok([...models.entries.values()].every(value => value.reasoningEffort === "high"));
}));

test("思考规则升级通过普通快刷补齐旧索引，其他已解析来源继续复用", async () => temporary(async directory => {
  const roots = isolatedHistoryRoots({ codex: join(directory, "codex"), codebuddy: join(directory, "codebuddy") });
  await mkdir(roots.codex as string); await mkdir(roots.codebuddy as string);
  await writeFile(join(roots.codex as string, "sample.jsonl"), encode([
    { type: "session_meta", payload: { id: "synthetic-refresh-effort" } }, codexContext("high"),
    codexMessage("user", "user"), codexMessage("answer", "assistant"), codexUsage("request"),
  ]));
  await writeFile(join(roots.codebuddy as string, "sample.jsonl"), encode([
    { type: "message", id: "user", sessionId: "synthetic-codebuddy", role: "user", content: "synthetic prompt" },
  ]));
  const path = join(directory, "index.sqlite");
  const store = new SessionStore(path);
  const database = new Database(path);
  try {
    await refreshSessions(store, store.createJob().id, roots);
    const before = store.cachedRevisions();
    const codex = before.find(value => value.client === "codex")!;
    const buddy = before.find(value => value.client === "codebuddy")!;
    database.prepare("UPDATE session_revisions SET fingerprint=replace(fingerprint, ':reasoning-effort-v2', ''),metadata_fingerprint='old-rule' WHERE id=?").run(codex.revision);
    database.prepare("UPDATE session_usage SET json=json_remove(json,'$.reasoningEffort') WHERE revision=?").run(codex.revision);
    const job = store.createJob();
    await refreshSessions(store, job.id, roots);
    assert.equal(store.getJob(job.id).counts?.parsed, 1);
    assert.equal(store.getJob(job.id).counts?.quickReused, 1);
    const after = store.cachedRevisions();
    assert.equal(after.find(value => value.client === "codebuddy")?.revision, buddy.revision);
    const current = after.find(value => value.client === "codex")!;
    assert.notEqual(current.revision, codex.revision);
    const settings = database.prepare("SELECT json_extract(json,'$.reasoningEffort') AS effort FROM session_usage WHERE revision=?").all(current.revision);
    assert.deepEqual(settings, [{ effort: "high" }]);
  } finally { database.close(); store.close(); }
}));

test("本次解析修正只升级受影响来源，已有 Pi 与 Qoder v1 解析缓存继续复用", async () => temporary(async directory => {
  const clients = ["codex", "claude", "codeflicker", "codeflicker-desktop", "pi", "qoder"] as const;
  const roots = isolatedHistoryRoots(Object.fromEntries(clients.map(client => [client, join(directory, client)])));
  for (const client of clients) await mkdir(roots[client] as string);
  await writeFile(join(roots.codex as string, "sample.jsonl"), encode([
    { type: "session_meta", payload: { id: "synthetic-codex-version" } }, codexContext("high"),
    codexMessage("user", "user"), codexMessage("answer", "assistant"), codexUsage("request"),
  ]));
  await writeFile(join(roots.claude as string, "sample.jsonl"), encode([
    { type: "assistant", uuid: "answer", sessionId: "synthetic-claude-version", timestamp: at, effort: "high",
      message: { id: "request", role: "assistant", model: "synthetic-model", content: [{ type: "text", text: "synthetic answer" }],
        usage: { input_tokens: 80, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 20 } } },
  ]));
  await writeFile(join(roots.codeflicker as string, "sample.jsonl"), encode([
    { type: "message", uuid: "answer", sessionId: "synthetic-cli-version", timestamp: at, reasoningEffort: "high", role: "assistant",
      model: "synthetic-model", content: [{ type: "text", text: "synthetic answer" }], metadata: { requestTokenBaseline: { requestId: "request" } },
      usage: { input_tokens: 90, output_tokens: 20 } },
  ]));
  await writeFile(join(roots.pi as string, "sample.jsonl"), encode([
    { type: "session", version: 3, id: "synthetic-pi-version", timestamp: at, cwd: "/synthetic/repo" },
  ]));
  await writeFile(join(roots.qoder as string, "sample.jsonl"), encode([
    { type: "runtime-config", sessionId: "synthetic-qoder-version", timestamp: at, reasoningEffort: "high" },
  ]));
  const desktopRoot = join(roots["codeflicker-desktop"] as string, "synthetic-session");
  await mkdir(join(desktopRoot, "checkpoints"), { recursive: true }); await mkdir(join(desktopRoot, "message"));
  await writeFile(join(desktopRoot, "checkpoints", "registry.json"), JSON.stringify({ sessionId: "synthetic-desktop-version", cwd: "/synthetic/repo" }));
  await writeFile(join(desktopRoot, "message", "cache.jsonl"), encode([
    { kind: "message", id: "answer", role: "assistant", timestamp: at, content: "synthetic answer", effort: "high",
      extra: { backend: { type: "MY_FLICKER" } }, usage: { inputTokens: 90, outputTokens: 20 } },
  ]));
  const path = join(directory, "index.sqlite");
  const store = new SessionStore(path); const database = new Database(path);
  try {
    await refreshSessions(store, store.createJob().id, roots);
    const before = store.cachedRevisions();
    assert.equal(before.length, 6);
    for (const revision of before) {
      const affected = !["pi", "qoder"].includes(revision.client!);
      assert.ok(revision.fingerprint.includes(affected ? ":reasoning-effort-v2" : ":reasoning-effort-v1"));
      if (!affected) continue;
      database.prepare("UPDATE session_revisions SET fingerprint=replace(fingerprint, ':reasoning-effort-v2', ':reasoning-effort-v1') WHERE id=?").run(revision.revision);
      database.prepare("UPDATE session_usage SET json=json_set(json,'$.reasoningEffort','low') WHERE revision=?").run(revision.revision);
    }
    const job = store.createJob(); await refreshSessions(store, job.id, roots);
    assert.equal(store.getJob(job.id).counts?.parsed, 4);
    const counts = store.getJob(job.id).counts!;
    assert.equal(counts.quickReused + counts.verifiedReused, 2);
    const after = store.cachedRevisions();
    for (const previous of before) {
      const current = after.find(value => value.client === previous.client)!;
      if (["pi", "qoder"].includes(current.client!)) assert.equal(current.revision, previous.revision);
      else {
        assert.notEqual(current.revision, previous.revision);
        assert.deepEqual(database.prepare("SELECT json_extract(json,'$.reasoningEffort') AS effort FROM session_usage WHERE revision=?").all(current.revision), [{ effort: "high" }]);
      }
    }
  } finally { database.close(); store.close(); }
}));
