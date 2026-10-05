import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { Client } from "../src/contracts.js";
import type { SessionMessage, SessionUsage } from "../src/session-contracts.js";
import { parseSessionSource, sessionKey } from "../src/sessions/parser.js";

const timestamp = "2026-01-01T00:00:00Z";
const encode = (records: unknown[]) => records.map(record => `${JSON.stringify(record)}\n`).join("");
const meta = (extra = {}) => ({ type: "session_meta", timestamp, payload: { id: "sample-session", cwd: "/synthetic/repo", ...extra } });
const response = (payload: unknown, extra = {}) => ({ type: "response_item", timestamp, payload, ...extra });
const user = (id = "user", text = "检查会话检索") => response({ type: "message", id, role: "user", content: [{ type: "input_text", text }] });
const assistant = (id: string, text: string, extra = {}) => response({ type: "message", id, role: "assistant", content: [{ type: "output_text", text }], ...extra });
const call = (id: string, name: string, input: unknown = {}) => response({ type: "function_call", id: `request-${id}`, call_id: id, name, arguments: JSON.stringify(input) });
const result = (id: string, output: unknown) => response({ type: "function_call_output", id: `result-${id}`, call_id: id, output: typeof output === "string" ? output : JSON.stringify(output) });
const usageValue = (input = 100, output = 20) => ({ input_tokens: input, cached_input_tokens: 60, output_tokens: output, reasoning_output_tokens: 5 });
const counted = (total = usageValue(), last = usageValue()) => ({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } } });
const requestUsage = (responseId: string, total = usageValue(), usage = usageValue()) => ({ type: "token_usage_record", payload: { response_id: responseId, usage, thread_token_usage: total } });

async function parsed(client: Client, records: unknown[], extra = "") {
  const directory = await mkdtemp(join(tmpdir(), "manor-session-parser-"));
  const path = join(directory, "sample.jsonl");
  const messages = new Map<string, SessionMessage>();
  const usages = new Map<string, SessionUsage>();
  try {
    await writeFile(path, encode(records) + extra);
    const summary = await parseSessionSource({ client, path }, {
      message: value => { messages.set(value.id, value); }, usage: value => { usages.set(value.id, value); },
    });
    return { summary, messages: [...messages.values()].sort((a, b) => a.ordinal - b.ordinal), usages: [...usages.values()] };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("Codex 响应正文优先于事件投影，保留明确终答、模型、中文与工具轨迹", async () => {
  const sample = await parsed("codex", [meta(), { type: "turn_context", payload: { model: "fixture-model" } },
    { type: "event_msg", payload: { type: "user_message", message: "检查会话检索" } }, user(),
    assistant("commentary", "先核对轨迹", { phase: "commentary" }),
    call("lookup", "mcp__example__lookup", { query: "中文检索" }), result("lookup", { success: true, result: "中文检索命中" }),
    assistant("final", "核对完成", { phase: "final_answer" }),
    { type: "event_msg", payload: { type: "agent_message", message: "核对完成" } }, counted(), requestUsage("request-one"), counted(),
  ]);
  assert.equal(sample.summary.clientSessionId, "sample-session");
  assert.equal(sample.summary.id, sessionKey("codex", "sample-session"));
  assert.equal(sample.summary.title, "检查会话检索");
  assert.equal(sample.summary.turnCount, 1);
  assert.equal(sample.messages.length, 6);
  assert.equal(sample.messages.find(message => message.kind === "assistant" && message.final)?.final, "explicit");
  assert.equal(sample.messages.filter(message => message.kind === "system").length, 1, "重复用量投影只生成一个可定位记录");
  assert.deepEqual(sample.summary.models, ["fixture-model"]);
  assert.deepEqual(sample.messages.find(message => message.kind === "tool_call")?.resource, { kind: "mcp", name: "lookup", server: "example" });
  assert.equal(sample.usages.length, 1);
  assert.equal(sample.usages[0]?.inputTokens, 100);
  assert.equal(sample.usages[0]?.cachedInputTokens, 60);
  assert.equal(sample.usages[0]?.outputTokens, 20);
  assert.equal(sample.usages[0]?.reasoningOutputTokens, 5);
  assert.equal(sample.usages[0]?.contextTokens, undefined, "输入用量不能冒充来源未记录的上下文峰值");
  assert.ok(sample.messages.some(message => message.id === sample.usages[0]?.messageId));
});

test("Codex 有正文响应时仍保留事件中已记录的思考，不将加密响应当作正文缺失", async () => {
  const sample = await parsed("codex", [meta(), user(),
    { type: "event_msg", payload: { type: "agent_reasoning", text: "实际留存的合成思考" } },
    response({ type: "reasoning", encrypted_content: "synthetic-encrypted" }), assistant("final", "已核对", { channel: "final" })]);
  assert.deepEqual(sample.messages.filter(message => message.kind === "thinking").map(message => message.text), ["实际留存的合成思考"]);
  assert.equal(sample.summary.gaps.filter(gap => gap.kind === "unsupported_format").length, 0);
});

test("Codex 用量投影两个顺序均去重，同值独立 response 身份不能合并", async () => {
  for (const events of [[counted(), requestUsage("one"), counted()], [requestUsage("one"), counted()]]) {
    const sample = await parsed("codex", [meta(), user(), ...events]);
    assert.equal(sample.usages.length, 1);
  }
  const distinct = await parsed("codex", [meta(), user(), requestUsage("one"), requestUsage("two"), requestUsage("two")]);
  assert.equal(distinct.usages.length, 2);
  assert.ok(distinct.summary.gaps.some(gap => gap.kind === "ambiguous"));
  const equalRequests = await parsed("codex", [meta(), user(), counted(), counted(usageValue(200, 40)), counted(usageValue(200, 40))]);
  assert.equal(equalRequests.usages.length, 2);
  assert.equal(equalRequests.usages.reduce((sum, usage) => sum + usage.inputTokens!, 0), 200);
});

test("Claude 同一模型请求流式片段保留过程但用量只计最新，缓存输入归一化", async () => {
  const native = (uuid: string, content: unknown[], usage: unknown, extra = {}) => ({ type: "assistant", uuid, sessionId: "sample-claude", timestamp,
    message: { id: "request-one", role: "assistant", model: "fixture-claude", content, usage, ...extra } });
  const first = native("thinking", [{ type: "thinking", thinking: "先核对" }], { input_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 20, output_tokens: 3 });
  const final = native("answer", [{ type: "text", text: "中文检索已完成" }], { input_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 20, output_tokens: 10 }, { stop_reason: "end_turn" });
  const sample = await parsed("claude", [{ type: "user", sessionId: "sample-claude", uuid: "user", message: { role: "user", content: "验证中文检索" } }, first, final, final]);
  assert.equal(sample.summary.turnCount, 1);
  assert.equal(sample.messages.length, 3);
  assert.equal(sample.messages.at(-1)?.final, "explicit");
  assert.equal(sample.usages.length, 1);
  assert.equal(sample.usages[0]?.inputTokens, 100);
  assert.equal(sample.usages[0]?.cachedInputTokens, 60);
  assert.equal(sample.usages[0]?.cacheWriteTokens, 20);
  assert.equal(sample.usages[0]?.contextTokens, undefined);
  assert.equal(sample.usages[0]?.outputTokens, 10);
});

test("CodeFlicker 原生消息与 requestTokenBaseline 用量身份保留，总输入不再叠加缓存", async () => {
  const native = (uuid: string, role: string, content: unknown, extra = {}) => ({ type: "message", sessionId: "sample-flicker", uuid, role, content, timestamp, ...extra });
  const first = native("assistant", "assistant", [{ type: "reasoning", text: "核对结构" }, { type: "tool_use", id: "read-one", name: "read", input: { file_path: "/synthetic/repo/entry.ts" } }],
    { model: "fixture-flicker", usage: { input_tokens: 100, output_tokens: 4, cache_read_input_tokens: 60 }, metadata: { requestTokenBaseline: { requestId: "request-one" } } });
  const returned = native("result", "tool", [{ type: "tool-result", toolCallId: "read-one", toolName: "read", result: { isError: false, llmContent: "entry content" } }]);
  const sample = await parsed("codeflicker", [native("user", "user", "核对原生结构"), first, first, returned, returned,
    native("final", "assistant", [{ type: "text", text: "原生结构完成" }], { model: "fixture-flicker", usage: { input_tokens: 120, output_tokens: 8 }, metadata: { requestTokenBaseline: { requestId: "request-two" } } })]);
  assert.equal(sample.summary.turnCount, 1);
  assert.equal(sample.messages.filter(message => message.kind === "tool_call").length, 1);
  assert.equal(sample.messages.at(-1)?.final, "inferred");
  assert.equal(sample.usages.length, 2);
  assert.equal(sample.usages[0]?.inputTokens, 100);
  assert.equal(sample.usages[0]?.cachedInputTokens, 60);
  assert.equal(sample.usages[1]?.cachedInputTokens, undefined);
  assert.equal(sample.messages.find(message => message.kind === "tool_call")?.status, "success");
  assert.ok(!sample.summary.gaps.some(gap => gap.kind === "unpaired_call"));
});

test("缺失缓存输入不补零；没有请求身份或累计进度的 Codex 用量不盲计", async () => {
  const claude = await parsed("claude", [{ type: "assistant", sessionId: "partial", uuid: "assistant", message: { id: "request", role: "assistant", content: [{ type: "text", text: "完成" }], usage: { input_tokens: 20, output_tokens: 0 } } }]);
  assert.equal(claude.usages[0]?.inputTokens, undefined);
  assert.equal(claude.usages[0]?.cachedInputTokens, undefined);
  assert.equal(claude.usages[0]?.outputTokens, 0);
  assert.ok(claude.summary.gaps.some(gap => gap.kind === "unsupported_format"));
  const codex = await parsed("codex", [meta(), { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usageValue() } } }]);
  assert.equal(codex.usages.length, 0);
  assert.ok(codex.summary.gaps.some(gap => gap.kind === "ambiguous"));
});

test("Skill 只有明确调用或成功返回的读取证据，失败、缺结果及正文提及不计读取", async () => {
  const sample = await parsed("codex", [meta(), user("user", "可以使用 sample-skill 吗"),
    call("read", "Read", { file_path: "/synthetic/skills/read-skill/SKILL.md" }), result("read", { success: true, content: "skill instructions" }),
    call("failed", "Read", { file_path: "/synthetic/skills/failed-skill/SKILL.md" }), result("failed", { success: false, content: "error" }),
    call("empty", "Read", { file_path: "/synthetic/skills/empty-skill/SKILL.md" }), result("empty", ""),
    call("shell", "shell_command", { command: "cat /synthetic/skills/shell-skill/SKILL.md" }), result("shell", "Exit code: 0\nOutput:\n# Skill instructions\n"),
    call("invoke", "Skill", { skill: "invoked-skill" }), result("invoke", { success: true }),
    call("missing", "Read", { file_path: "/synthetic/skills/missing-skill/SKILL.md" }),
  ]);
  const resources = sample.messages.filter(message => message.resource).map(message => message.resource!);
  assert.deepEqual(resources.map(resource => [resource.kind, resource.name]).sort(), [["skill_call", "invoked-skill"], ["skill_read", "read-skill"], ["skill_read", "shell-skill"]]);
  assert.ok(sample.summary.gaps.some(gap => gap.kind === "unpaired_call"));
});

test("未完成工具与中断不推断终答，尾部半条记录保留缺口", async () => {
  const pending = await parsed("codex", [meta(), user(), assistant("commentary", "马上检查"), call("missing", "shell_command")]);
  assert.ok(pending.messages.every(message => !message.final));
  const interrupted = await parsed("codex", [meta(), user(), assistant("commentary", "检查中"), { type: "event_msg", payload: { type: "task_aborted" } }], '{"type":');
  assert.ok(interrupted.messages.every(message => !message.final));
  assert.ok(interrupted.summary.gaps.some(gap => gap.kind === "incomplete_record"));
});

test("明确父子与分叉边界保留身份，复制用量不再次计入，缺边界说明缺口", async () => {
  const sample = await parsed("codex", [meta({ id: "child", history_base: { thread_id: "parent", end_ordinal_exclusive: 10 } }),
    { ...user("copied", "旧轮次"), ordinal: 5 }, { ...requestUsage("copied-usage"), ordinal: 6 },
    { ...user("own", "新轮次"), ordinal: 10 }, { ...requestUsage("own-usage"), ordinal: 11 },
    call("spawn", "spawn_agent"), result("spawn", { agent_id: "grandchild" }),
  ]);
  assert.equal(sample.summary.parentSessionId, sessionKey("codex", "parent"));
  assert.equal(sample.summary.relationship, "fork");
  assert.equal(sample.messages[0]?.copied, true);
  assert.equal(sample.messages[1]?.copied, undefined);
  assert.equal(sample.usages.length, 1);
  assert.deepEqual(sample.summary.childSessionIds, [sessionKey("codex", "grandchild")]);
  const unknown = await parsed("codex", [meta({ forked_from_id: "parent" }), user()]);
  assert.ok(unknown.summary.gaps.some(gap => gap.kind === "ambiguous"));
});

test("来源移动时消息身份稳定，系统内容与加密思考保留可见缺口，不占用户轮次", async () => {
  const records = [meta({ base_instructions: { text: "合成系统指令" } }), response({ type: "reasoning", id: "thinking", encrypted_content: "synthetic-encrypted" }), user(), assistant("final", "完成", { channel: "final" })];
  const one = await parsed("codex", records);
  const two = await parsed("codex", records);
  assert.deepEqual(one.messages.map(message => message.id), two.messages.map(message => message.id));
  assert.equal(one.summary.turnCount, 1);
  assert.equal(one.messages[0]?.turnId, `${one.summary.id}:turn:0`);
  assert.equal(one.messages[1]?.text, "");
  assert.ok(one.summary.gaps.some(gap => gap.kind === "unsupported_format"));
});

test("没有 cwd 时仅现存工具目标可确认关联 Git 项目，多根冲突保持未知", async () => {
  const directory = await mkdtemp(join(tmpdir(), "manor-session-project-"));
  try {
    const roots = [join(directory, "one"), join(directory, "two")];
    for (const root of roots) {
      await mkdir(root);
      await promisify(execFile)("git", ["init", "--quiet", root]);
      await writeFile(join(root, "entry.ts"), "export const healthy = true;\n");
    }
    const native = (uuid: string, path: string) => ({ type: "message", sessionId: "tool-associated", uuid, role: "assistant",
      content: [{ type: "tool_use", id: uuid, name: "read", input: { file_path: path } }] });
    const one = await parsed("codeflicker", [native("one", join(roots[0]!, "entry.ts")), native("deleted", "/synthetic/deleted/entry.ts")]);
    assert.equal(one.summary.project, await realpath(roots[0]!));
    assert.equal(one.summary.projectOrigin, "tool_path");
    const multiple = await parsed("codeflicker", roots.map((root, index) => native(`read-${index}`, join(root, "entry.ts"))));
    assert.equal(multiple.summary.project, undefined);
    assert.ok(multiple.summary.gaps.some(gap => gap.kind === "ambiguous"));
    const absent = await parsed("codeflicker", [native("deleted", "/synthetic/deleted/entry.ts")]);
    assert.equal(absent.summary.project, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
