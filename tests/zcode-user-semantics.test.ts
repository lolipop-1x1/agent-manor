import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";
import { parseNormalizedSession } from "../src/history/adapters/normalized.js";
import { zcodeAdapter, ZCODE_FORMAT } from "../src/history/adapters/zcode.js";
import { completeRoundSource, summarizeRoundMetrics } from "../src/sessions/round-metrics.js";

async function sample(injected: Record<string, unknown>, parts: Record<string, unknown>[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "manor-zcode-user-semantics-"));
  await mkdir(join(directory, "cli/db"), { recursive: true });
  const path = join(directory, "cli/db/history.sqlite");
  const database = new Database(path);
  try {
    database.exec(`
      CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,parent_id TEXT);
      CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
      CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
      CREATE TABLE model_usage(id TEXT PRIMARY KEY,logical_request_id TEXT,attempt_index INTEGER,session_id TEXT,turn_id TEXT,
        assistant_message_id TEXT,parent_user_message_id TEXT,provider_id TEXT,model_id TEXT,status TEXT,started_at TEXT,
        input_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER,cache_creation_input_tokens INTEGER,
        cache_read_input_tokens INTEGER,computed_total_tokens INTEGER,raw_usage_json TEXT,provider_metadata_json TEXT);
    `);
    database.prepare("INSERT INTO session VALUES(?,?,?,?)").run("sample", "/synthetic/repo", "Synthetic semantics", null);
    const message = database.prepare("INSERT INTO message VALUES(?,?,?,?,?)");
    message.run("human", "sample", 1000, 1000, JSON.stringify({ role: "user", content: "合成用户请求",
      semantics: { origin: "real_user", kind: "user_prompt" }, time: { created: 1000 } }));
    message.run("first", "sample", 2000, 3000, JSON.stringify({ role: "assistant", content: "合成中间回复", parentID: "human",
      finish: "stop", model: { modelID: "fixture-model" }, time: { created: 2000, completed: 3000 } }));
    message.run("injected", "sample", 4000, 4000, JSON.stringify({ role: "user", time: { created: 4000 }, ...injected }));
    for (const [index, part] of parts.entries()) {
      database.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run(`part-${index}`, "injected", "sample", 4000, 4000, JSON.stringify(part));
    }
    message.run("last", "sample", 5000, 6000, JSON.stringify({ role: "assistant", content: "合成最终回复", parentID: "human",
      finish: "stop", model: { modelID: "fixture-model" }, time: { created: 5000, completed: 6000 } }));
    for (const [index, id] of ["first", "last"].entries()) {
      database.prepare("INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`request-${index}`, `request-${index}`, 0,
        "sample", "native-turn", id, "human", "example-provider", "fixture-model", "completed", new Date(1500 + index * 3000).toISOString(),
        100, 10, null, 0, 0, 110, JSON.stringify({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }), "{}");
    }
    const snapshot = await zcodeAdapter.readRecords!({ path, client: "zcode", format: ZCODE_FORMAT, selector: "sample" });
    const messages = new Map<string, SessionMessage>(), usages = new Map<string, SessionUsage>();
    const summary = parseNormalizedSession(snapshot, { message: value => messages.set(value.id, value), usage: value => usages.set(value.id, value) });
    return { summary, messages: [...messages.values()], usages: [...usages.values()] };
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("ZCode 明确消息级 synthetic 和 runtime 通知归上下文，请求仍关联真实用户轮次", async () => {
  for (const extra of [{ synthetic: true },
    { semantics: { origin: "agent_runtime", kind: "todo_reminder", uiVisibility: "hidden" } },
    { semantics: { origin: "agent_runtime", kind: "background_notification", transcriptVisibility: "hidden" } }]) {
    const result = await sample({ content: "合成注入正文", ...extra });
    assert.equal(result.summary.turnCount, 1);
    assert.equal(result.messages.filter(value => value.kind === "user").length, 1);
    assert.equal(result.messages.filter(value => value.kind === "context" && value.text === "合成注入正文").length, 1);
    assert.equal(result.usages.length, 2);
    for (const usage of result.usages) {
      assert.equal(usage.turnId, result.messages.find(value => value.id === usage.messageId)?.turnId);
    }
    const metrics = summarizeRoundMetrics(result.messages, result.usages, completeRoundSource(result.summary.gaps));
    assert.equal(metrics.userTurns, 1);
    assert.equal(metrics.averageSteps, 2);
    assert.equal(metrics.averageDurationMs, 5000);
  }
});

test("ZCode 纯 synthetic parts 归上下文，混合用户正文和无标记内容仍是用户需求", async () => {
  const injected = await sample({}, [{ type: "text", text: "合成注入一", synthetic: true },
    { type: "text", text: "合成注入二", synthetic: true }]);
  assert.equal(injected.summary.turnCount, 1);
  assert.equal(injected.messages.find(value => value.text === "合成注入一\n合成注入二")?.kind, "context");
  for (const [data, parts] of [
    [{}, [{ type: "text", text: "合成真实输入" }, { type: "text", text: "合成注入", synthetic: true }]],
    [{ content: "合成真实输入" }, [{ type: "text", text: "合成注入", synthetic: true }]],
    [{ content: "todo_reminder background_notification" }, []],
    [{ synthetic: true, content: "合成真实输入", semantics: { origin: "real_user", kind: "user_prompt" } }, []],
  ] as [Record<string, unknown>, Record<string, unknown>[]][]) {
    assert.equal((await sample(data, parts)).summary.turnCount, 2);
  }
});
