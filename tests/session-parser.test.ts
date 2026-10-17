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
import { completeRoundSource, summarizeRoundMetrics } from "../src/sessions/round-metrics.js";

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

test("CodeFlicker 附件保留为过程记录，不新增对话、模型请求或工具调用", async () => {
  const attachment = (uuid: string, content: unknown) => ({ type: "message", sessionId: "attachment-demo", uuid,
    role: "attachment", content, timestamp, entrypoint: "cli", model: "fixture-inherited-model" });
  const success = attachment("started", { type: "hook_success", hookEvent: "SessionStart", hookName: "fixture-start",
    command: "printf fixture", stdout: "", stderr: "", exitCode: 0, durationMs: 12 });
  const sample = await parsed("codeflicker", [success, success,
    { type: "message", sessionId: "attachment-demo", uuid: "request", role: "user", content: "合成请求" },
    attachment("blocked", { type: "hook_blocking_error", hookEvent: "PreToolUse", stderr: "合成错误", exitCode: 2 }),
    attachment("unknown", { type: "fixture_attachment", value: "原始附件内容" }),
    { type: "message", sessionId: "attachment-demo", uuid: "answer", role: "assistant", content: "合成回答" },
  ]);
  assert.equal(sample.summary.messageCount, 5);
  assert.equal(sample.summary.turnCount, 1);
  assert.deepEqual(sample.summary.models, []);
  assert.equal(sample.usages.length, 0);
  assert.equal(sample.messages.filter(message => message.kind === "tool_call" || message.kind === "tool_result").length, 0);
  const hooks = sample.messages.filter(message => message.contextSource === "hook");
  assert.equal(hooks.length, 2, "相同原始身份的重复附件不增加记录数");
  assert.equal(hooks[0]?.status, "success");
  assert.equal(hooks[0]?.durationMs, 12);
  assert.equal(hooks[0]?.recordLine, 2);
  assert.equal(hooks[1]?.status, "failure");
  assert.ok(hooks[0]?.text.includes("SessionStart"));
  assert.equal(hooks[0]?.textDescriptor?.key, "sessions.body.hook");
  assert.equal(hooks[0]?.textDescriptor?.params, undefined);
  assert.ok(sample.messages.some(message => message.kind === "context" && message.text.includes("原始附件内容")));
  assert.ok(sample.summary.gaps.some(gap => gap.kind === "unsupported_format"));
  assert.equal(sample.messages.filter(message => message.kind === "assistant" && message.final).length, 1);
});

test("IDE 缺失正文按生成来源标记，同名真实正文不附加翻译描述", async () => {
  const messages: SessionMessage[] = [];
  await parseSessionSource({ client: "codeflicker-desktop", format: "codeflicker-ide-sqlite", path: "/synthetic/history.sqlite" }, {
    message: value => messages.push(value), usage: () => {},
  }, { nativeSnapshot: {
    source: { client: "codeflicker-desktop", format: "codeflicker-ide-sqlite", path: "/synthetic/history.sqlite", sessionId: "generated-body" },
    hash: "synthetic-hash", records: [
      { line: 1, raw: "", record: {} },
      { line: 2, raw: "", record: { say: "text", role: "user", text: "未记录内容" } },
    ],
  } });
  const generated = messages.find(message => message.kind === "system");
  const original = messages.find(message => message.kind === "user");
  assert.equal(generated?.text, "未记录内容");
  assert.deepEqual(generated?.textDescriptor, { key: "sessions.body.unrecorded" });
  assert.equal(original?.text, "未记录内容");
  assert.equal(original?.textDescriptor, undefined);
});

test("CodeFlicker CLI 显式压缩摘要是过程记录，不产生用户轮次或额外用量", async () => {
  const sample = await parsed("codeflicker", [
    { type: "message", sessionId: "compact-demo", uuid: "request", role: "user", content: "合成问题" },
    { type: "message", sessionId: "compact-demo", uuid: "answer", role: "assistant", content: "合成回答" },
    { type: "message", sessionId: "compact-demo", uuid: "compact", parentUuid: "answer", role: "user", isCompactSummary: true,
      content: [{ type: "text", text: "## Objective\n合成压缩摘要" }], uiContent: "会话已压缩", timestamp,
      metadata: { compactCheckpoint: { version: 1, recent: [], recentUserTurns: 1, recentTokens: 100 } } },
    { type: "message", sessionId: "compact-demo", uuid: "ordinary", role: "user", isCompactSummary: false, content: "## Objective\n讨论如何压缩数据" },
    { type: "message", sessionId: "compact-demo", uuid: "unmarked", role: "user", content: "这里提到压缩摘要，但仍是普通用户正文" },
  ]);
  assert.equal(sample.messages.filter(message => message.kind === "compression").length, 1);
  const compact = sample.messages.find(message => message.kind === "compression")!;
  assert.equal(compact.recordLine, 3);
  assert.equal(compact.text, "## Objective\n合成压缩摘要");
  assert.equal(compact.turnId, sample.messages[0]?.turnId);
  assert.equal(sample.summary.turnCount, 3);
  assert.equal(sample.messages.length, 5);
  assert.equal(sample.messages.filter(message => message.kind === "user").length, 3);
  assert.equal(sample.usages.length, 0);
});

test("CodeFlicker CLI 保留原始入口和版本，去重且不覆盖恢复后的混合入口", async () => {
  const native = (uuid: string, entrypoint?: string, version?: string) => ({ type: "message", sessionId: "entry-demo", uuid,
    role: "user", content: "合成请求", entrypoint, version });
  const sample = await parsed("codeflicker", [native("one", "sdk-cli", "0.3.26"), native("two", "sdk-cli", "0.3.26"),
    native("resumed", "cli", "0.3.26"), native("unknown-version", "sdk-cli"), native("missing")]);
  assert.deepEqual(sample.summary.executionEntries, [
    { entrypoint: "sdk-cli", version: "0.3.26", recordLine: 1 },
    { entrypoint: "cli", version: "0.3.26", recordLine: 3 },
    { entrypoint: "sdk-cli", version: undefined, recordLine: 4 },
  ]);
  assert.equal(sample.summary.parentSessionId, undefined, "执行入口不能推断父身份");
  assert.equal(sample.summary.executionMode, undefined, "混合或未知入口不误归为 Quiet");
  assert.equal((await parsed("codeflicker", [native("quiet", "sdk-cli", "0.3.26")])).summary.executionMode, "quiet");
  assert.equal((await parsed("codeflicker", [native("future", "sdk-cli", "0.3.27")])).summary.executionMode, undefined);
  assert.equal((await parsed("codeflicker", [native("missing")])).summary.executionEntries, undefined);
  assert.equal((await parsed("claude", [native("other", "sdk-cli", "0.3.26")])).summary.executionEntries, undefined);
  assert.equal((await parsed("codeflicker-desktop", [native("desktop", "sdk-cli", "0.3.26")])).summary.executionEntries, undefined);
});

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
  assert.equal(sample.usages.length, 2, "工具响应与终答是两次已识别请求，未保存用量的请求仍保留缺失");
  assert.equal(sample.usages.filter(usage => usage.outputTokens === undefined).length, 1);
  assert.equal(sample.usages[0]?.inputTokens, 100);
  assert.equal(sample.usages[0]?.cachedInputTokens, 60);
  assert.equal(sample.usages[0]?.outputTokens, 20);
  assert.equal(sample.usages[0]?.reasoningOutputTokens, 5);
  assert.equal(sample.usages[0]?.contextTokens, undefined, "输入用量不能冒充来源未记录的上下文峰值");
  assert.ok(sample.messages.some(message => message.id === sample.usages[0]?.messageId));
});

test("子任务标题沿用正式名称或请求，缺失时采用原生任务路径、昵称与编号", async () => {
  const spawn = { parent_thread_id: "synthetic-parent", agent_path: "/root/check_queries", agent_nickname: "Fixture Agent" };
  const context = user("context", "# AGENTS.md instructions\n<INSTRUCTIONS>合成项目规则</INSTRUCTIONS>");
  const native = meta({ source: { subagent: { thread_spawn: spawn } } });
  const task = await parsed("codex", [native, context]);
  assert.equal(task.summary.title, "check_queries");
  assert.equal(task.summary.titleOrigin, "task");
  assert.equal(task.summary.agentName, "Fixture Agent");
  const named = await parsed("codex", [meta({ parent_thread_id: "synthetic-parent", agent_nickname: "Fixture Agent" }), context]);
  assert.equal(named.summary.title, "Fixture Agent");
  assert.equal(named.summary.titleOrigin, "agent");
  const numbered = await parsed("codex", [meta({ parent_thread_id: "synthetic-parent" }), context]);
  assert.equal(numbered.summary.title, "子会话 -session");
  const recorded = await parsed("codex", [{ ...native, payload: { ...native.payload, title: "正式子任务" } }, context]);
  assert.equal(recorded.summary.title, "正式子任务");
  assert.equal(recorded.summary.titleOrigin, "recorded");
  const request = await parsed("codex", [native, user("task", "核对缓存查询")]);
  assert.equal(request.summary.title, "核对缓存查询");
  assert.equal(request.summary.titleOrigin, "first_user");
  const main = await parsed("codex", [meta({ agent_path: "/root", agent_nickname: "Fixture Agent" }), context]);
  assert.equal(main.summary.title, "未命名会话", "没有子关系时不把 Agent 身份当作会话标题");
});

test("Codex 子 Agent 继承父历史仍是子会话，复制头部和用户消息不覆盖任务身份", async () => {
  const header = meta({ id: "child-demo", session_id: "parent-demo", forked_from_id: "parent-demo",
    parent_thread_id: "parent-demo", subagent_history_start_ordinal: 5,
    source: { subagent: { thread_spawn: { parent_thread_id: "parent-demo", agent_path: "/root/check_queries", agent_nickname: "Fixture Agent" } } } });
  const records = [{ ...header, ordinal: 0 }, { ...meta({ id: "parent-demo", title: "父会话标题" }), ordinal: 1 },
    { ...user("copied-request", "父会话请求"), ordinal: 2 }, { ...assistant("copied-answer", "父会话回答"), ordinal: 3 },
    { ...assistant("task", "Message Type: NEW_TASK\nTask name: /root/check_queries\nPayload:\n核对查询"), ordinal: 5 }];
  const sample = await parsed("codex", records);
  assert.equal(sample.summary.clientSessionId, "child-demo");
  assert.equal(sample.summary.parentSessionId, sessionKey("codex", "parent-demo"));
  assert.equal(sample.summary.relationship, "child");
  assert.equal(sample.summary.taskName, "check_queries");
  assert.equal(sample.summary.agentName, "Fixture Agent");
  assert.equal(sample.summary.title, "check_queries");
  assert.equal(sample.summary.titleOrigin, "task");
  assert.equal(sample.messages.find(message => message.kind === "user")?.copied, true);
  const ownRequest = await parsed("codex", [...records, { ...user("own", "子任务补充请求"), ordinal: 6 }]);
  assert.equal(ownRequest.summary.title, "子任务补充请求");
  const fork = await parsed("codex", [{ ...meta({ id: "branch-demo", forked_from_id: "parent-demo", forked_from_ordinal_exclusive: 5 }), ordinal: 0 },
    ...records.slice(1, 4), { ...user("branch-request", "独立分叉请求"), ordinal: 5 }]);
  assert.equal(fork.summary.relationship, "fork", "没有明确子创建来源时保留真正分叉");
  assert.equal(fork.summary.title, "独立分叉请求");
});

test("Codex 后备标题跳过自动注入的项目说明，保留原始消息", async () => {
  const instructions = "# AGENTS.md instructions for /workspace/demo\n\n<INSTRUCTIONS>\n使用中文回答\n</INSTRUCTIONS>";
  const sample = await parsed("codex", [meta(), user("instructions", instructions), user("request", "检查标题显示")]);
  assert.equal(sample.summary.title, "检查标题显示");
  assert.equal(sample.summary.titleOrigin, "first_user");
  assert.equal(sample.messages[0]?.text, instructions);
  assert.equal(sample.messages[0]?.kind, "context");
  assert.equal(sample.messages[0]?.contextSource, "agents_md");
  assert.equal(sample.messages[0]?.contextEvidence, "wrapper");
  assert.equal(sample.summary.turnCount, 1);
});

test("Codex 内容分类元信息优先于正文格式，未知类型和真实文本不误判为注入", async () => {
  const marked = (id: string, body: string, kinds: unknown) => response({ type: "message", id, role: "user",
    content: [{ type: "input_text", text: body }], internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } });
  const instructions = "# AGENTS.md instructions\n<INSTRUCTIONS>合成规则</INSTRUCTIONS>";
  const sample = await parsed("codex", [meta(), marked("agents", "客户端保存的指令正文", ["agents_md.instructions", "environments.environment_context"]),
    marked("page", "客户端保存的页面上下文", ["additional_content.codex_apps_open_page"]),
    marked("skill", "<skill><name>demo</name>合成技能指令</skill>", ["skills.selected_skill_instructions"]),
    marked("human", "真实请求", ["user.text"])]);
  assert.deepEqual(sample.messages.map(message => message.kind), ["context", "context", "context", "user"]);
  assert.deepEqual(sample.messages.slice(0, 3).map(message => message.contextEvidence), ["client_metadata", "client_metadata", "client_metadata"]);
  assert.equal(sample.messages[2]?.contextSource, "client");
  assert.equal(sample.messages[0]?.contextSource, "agents_md");
  assert.equal(sample.messages[0]?.text, "客户端保存的指令正文");
  assert.equal(sample.summary.turnCount, 1);
  for (const kinds of [["user.text"], ["agents_md.instructions", "user.text"], ["skills.selected_skill_instructions", "user.text"], ["unknown.kind"], ["constructor"], [], null, "agents_md.instructions"]) {
    const human = await parsed("codex", [meta(), marked("human", instructions, kinds)]);
    assert.equal(human.messages[0]?.kind, "user", JSON.stringify(kinds));
    assert.equal(human.messages[0]?.text, instructions);
    assert.equal(human.summary.turnCount, 1);
  }
});

test("Codex 完整注入包不占用户轮次，混合请求、引用与未闭合内容仍为用户消息", async () => {
  const agents = "# AGENTS.md instructions for /workspace/demo\n<INSTRUCTIONS>合成规则</INSTRUCTIONS>\n<environment_context>合成环境</environment_context>";
  const page = '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>';
  const sample = await parsed("codex", [meta(), user("agents", agents), user("page", page), user("human", "请检查示例服务"),
    user("runtime", "<environment_context>新的环境</environment_context>"), assistant("answer", "完成", { channel: "final" })]);
  assert.deepEqual(sample.messages.map(message => message.kind), ["context", "context", "user", "context", "assistant"]);
  assert.equal(sample.summary.turnCount, 1);
  assert.equal(sample.summary.title, "请检查示例服务");
  assert.ok(sample.messages.slice(0, 2).every(message => message.turnId.endsWith(":turn:0")));
  assert.ok(sample.messages.slice(2).every(message => message.turnId.endsWith(":turn:1")));
  for (const body of ["请解释 AGENTS.md 的用途", `请解释以下规则：\n${agents}`, `\`\`\`text\n${agents}\n\`\`\``,
    `${agents}\n真实提问`, "<INSTRUCTIONS>未闭合", `${page}\n这个是什么意思？`, '<send_user_message_question_reply>人工回答</send_user_message_question_reply>']) {
    const human = await parsed("codex", [meta(), user("human", body)]);
    assert.equal(human.messages[0]?.kind, "user", body);
    assert.equal(human.summary.turnCount, 1);
    assert.equal(human.messages[0]?.text, body);
  }
  const fallback = await parsed("codex", [meta(), { type: "event_msg", payload: { type: "user_message", message: agents } },
    { type: "event_msg", payload: { type: "user_message", message: "真实请求" } }]);
  assert.deepEqual(fallback.messages.map(message => message.kind), ["context", "user"]);
  assert.equal(fallback.summary.turnCount, 1);
});

test("Codex 后备标题提取浏览器包装中的真实请求，跳过环境与 Skill 内容", async () => {
  const request = '<in-app-browser-context source="ambient-ui-state">\n当前浏览器上下文\n</in-app-browser-context>\n\n## My request:\n检查中文标题';
  const sample = await parsed("codex", [meta(), user("environment", "<environment_context>\n工作环境\n</environment_context>"),
    user("skill", "<skill>\n技能说明\n</skill>"), user("request", request)]);
  assert.equal(sample.summary.title, "检查中文标题");
  assert.equal(sample.messages.at(-1)?.text, request);
  assert.equal((await parsed("codex", [meta({ title: "明确保存的标题" }), user("request", request)])).summary.title, "明确保存的标题");
});

test("Codex 没有真实请求时保留未命名，普通用户正文不误删", async () => {
  const environment = "<environment_context>\n工作环境\n</environment_context>";
  assert.equal((await parsed("codex", [meta(), user("environment", environment)])).summary.titleOrigin, "fallback");
  assert.equal((await parsed("codex", [meta(), user("request", "请解释 AGENTS.md 的用途")])).summary.title, "请解释 AGENTS.md 的用途");
});

test("Codex 有正文响应时仍保留事件中已记录的思考，不将加密响应当作正文缺失", async () => {
  const sample = await parsed("codex", [meta(), user(),
    { type: "event_msg", payload: { type: "agent_reasoning", text: "实际留存的合成思考" } },
    response({ type: "reasoning", encrypted_content: "synthetic-encrypted" }), assistant("final", "已核对", { channel: "final" })]);
  assert.deepEqual(sample.messages.filter(message => message.kind === "thinking").map(message => message.text), ["实际留存的合成思考"]);
  assert.equal(sample.summary.gaps.filter(gap => gap.kind === "unsupported_format").length, 0);
});

test("Codex 可读压缩摘要优先于加密字段，空正文回退摘要且不误报缺失", async () => {
  for (const fields of [{ content: "合成压缩摘要" }, { summary: "合成压缩摘要" },
    { content: [], summary: "合成压缩摘要" }, { content: "  ", summary: [{ type: "text", text: "合成压缩摘要" }] },
    { content: [{ type: "text", text: "合成压缩摘要" }], summary: "其他合成摘要" }]) {
    const sample = await parsed("codex", [meta(), user(), response({ type: "compaction", ...fields, encrypted_content: "synthetic-encrypted" })]);
    assert.equal(sample.messages.find(message => message.kind === "compression")?.text, "合成压缩摘要");
    assert.ok(!sample.summary.gaps.some(gap => gap.messageDescriptor?.key === "diagnostics.sessions.parser.m013"));
  }
  const encrypted = await parsed("codex", [meta(), user(), response({ type: "compaction", content: "  ", encrypted_content: "synthetic-encrypted" })]);
  assert.ok(encrypted.summary.gaps.some(gap => gap.messageDescriptor?.key === "diagnostics.sessions.parser.m013"));
});

test("Codex 空白思考摘要回退已保存正文，不把明文漏成加密内容", async () => {
  const sample = await parsed("codex", [meta(), user(), response({ type: "reasoning", summary: "  ", content: [{ type: "text", text: "合成思考正文" }], encrypted_content: "synthetic-encrypted" })]);
  assert.equal(sample.messages.find(message => message.kind === "thinking")?.text, "合成思考正文");
  assert.ok(!sample.summary.gaps.some(gap => gap.messageDescriptor?.key === "diagnostics.sessions.parser.m012"));
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

test("Codex 原生响应后的不同累计基数投影去重，独立同值请求仍分别计数", async () => {
  const native = requestUsage("one", usageValue(1000, 100), usageValue(100, 10));
  const legacy = counted(usageValue(900, 80), usageValue(100, 10));
  const sample = await parsed("codex", [meta(), user(), native, legacy, legacy]);
  assert.equal(sample.usages.length, 1);
  assert.equal(sample.usages.reduce((sum, item) => sum + item.inputTokens! + item.outputTokens!, 0), 110);
  const distinct = await parsed("codex", [meta(), user(), native, legacy,
    requestUsage("two", usageValue(1100, 110), usageValue(100, 10)), counted(usageValue(1000, 90), usageValue(100, 10))]);
  assert.equal(distinct.usages.length, 2);
  const legacyOnlyNext = await parsed("codex", [meta(), user(), assistant("first", "首次响应"), native,
    assistant("second", "独立响应"), counted(usageValue(1100, 110), usageValue(100, 10))]);
  assert.equal(legacyOnlyNext.usages.length, 2, "新的助手事件组不能与之前的原生响应按同值配对");
});

test("Codex 旧式进度不同于后续原生响应时保留明确身份，缺少新助手事件也不能按同值吞掉请求", async () => {
  for (const prefix of [[], [assistant("legacy", "合成旧式响应")]]) {
    const sample = await parsed("codex", [meta(), user(), ...prefix,
      counted(usageValue(900, 80), usageValue(100, 10)),
      requestUsage("new-response", usageValue(1000, 100), usageValue(100, 10))]);
    assert.equal(sample.usages.length, 2);
    assert.equal(sample.usages.reduce((sum, item) => sum + item.inputTokens! + item.outputTokens!, 0), 220);
  }
});

test("Codex 压缩后保留压缩请求，忽略零状态投影，之后的双记录仍去重", async () => {
  const sample = await parsed("codex", [meta(), user(), requestUsage("compression", usageValue(1000, 100), usageValue(200, 40)),
    { type: "compacted", payload: { message: "合成压缩摘要" } },
    counted(usageValue(800, 60), { ...usageValue(0, 0), cached_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 50 }),
    call("next", "read"), requestUsage("next", usageValue(1100, 110), usageValue(100, 10)), result("next", "结果"),
    counted(usageValue(900, 70), usageValue(100, 10))]);
  assert.equal(sample.usages.length, 2);
  assert.equal(sample.usages.reduce((sum, item) => sum + item.inputTokens! + item.outputTokens!, 0), 350);
});

test("Codex 压缩元数据中的最近用量是已记录响应的副本，原生与旧式投影仍只计一次", async () => {
  const native = requestUsage("compression-response", usageValue(1000, 100), usageValue(200, 40));
  const sample = await parsed("codex", [meta({ model_provider: "synthetic-provider" }), user(), native,
    { type: "compacted", payload: { message: "合成压缩摘要", latest_token_usage_record: native.payload } },
    counted(usageValue(1000, 100), usageValue(200, 40))]);
  assert.equal(sample.usages.length, 1);
  assert.equal(sample.usages[0]?.inputTokens, 200);
  assert.equal(sample.usages[0]?.outputTokens, 40);
  assert.equal(sample.usages[0]?.provider, "synthetic-provider");
  assert.equal(sample.messages.filter(message => message.kind === "compression").length, 1);
});

test("Codex 旧的未记录事件组不阻止当前响应镜像配对，重复零上下文状态不计请求", async () => {
  const sample = await parsed("codex", [meta(), user(), call("earlier", "read"), result("earlier", "合成结果"),
    call("current", "read"), requestUsage("current", usageValue(1000, 100), usageValue(100, 10)),
    result("current", "合成结果"), counted(usageValue(900, 90), usageValue(100, 10)),
    counted(usageValue(900, 90), { ...usageValue(0, 0), total_tokens: 50 }),
    counted(usageValue(900, 90), { ...usageValue(0, 0), total_tokens: 50 })]);
  assert.equal(sample.usages.filter(item => item.inputTokens !== undefined).length, 1);
  assert.equal(sample.usages.find(item => item.inputTokens !== undefined)?.inputTokens, 100);
  const legacy = await parsed("codex", [meta(), user(), counted(),
    counted(usageValue(), { ...usageValue(0, 0), total_tokens: 50 }), counted()]);
  assert.equal(legacy.usages.length, 1, "没有累计回退的零状态不能使已计请求重新计数");
  const boundary = await parsed("codex", [meta(), user(), assistant("legacy", "独立旧式请求"), counted(),
    assistant("native", "独立原生请求"), requestUsage("new-response")]);
  assert.equal(boundary.usages.length, 2, "不同助手事件组不因跨投影累计值相同而合并");
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

test("CodeFlicker 旧版嵌套消息保留客户端，按原生请求去重并统一工具及轮次", async () => {
  const native = (type: string, uuid: string, message: object, at: string) => ({ type, uuid,
    sessionId: "legacy-cli", timestamp: at, message });
  const first = native("assistant", "first", { id: "request-one", role: "assistant", model: "fixture-model",
    content: [{ type: "thinking", thinking: "合成思考" }, { type: "tool_use", id: "read-one", name: "Read", input: {} }],
    usage: { input_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 20, output_tokens: 4 },
    stop_reason: "tool_use" }, "2026-01-01T00:00:20Z");
  const sample = await parsed("codeflicker", [
    native("user", "user", { role: "user", content: "合成需求" }, timestamp), first, first,
    native("user", "result", { role: "user", content: [{ type: "tool_result", tool_use_id: "read-one",
      content: "合成结果", is_error: false }] }, "2026-01-01T00:00:30Z"),
    native("assistant", "answer", { id: "request-two", role: "assistant", model: "fixture-model",
      content: [{ type: "text", text: "合成回复" }], usage: { input_tokens: 40, output_tokens: 8 }, stop_reason: "end_turn" },
    "2026-01-01T00:01:00Z"),
  ]);
  assert.equal(sample.summary.client, "codeflicker");
  assert.equal(sample.summary.turnCount, 1);
  assert.equal(sample.messages.length, 5);
  assert.equal(sample.messages.find(value => value.kind === "tool_call")?.status, "success");
  assert.equal(sample.messages.at(-1)?.final, "explicit");
  assert.equal(sample.usages.length, 2);
  assert.ok(sample.usages.every(value => value.id.startsWith("codeflicker:")));
  assert.equal(sample.usages[0]?.inputTokens, 100);
  assert.equal(sample.usages[0]?.cachedInputTokens, 60);
  assert.equal(sample.usages[1]?.inputTokens, undefined);
  assert.equal(sample.usages[1]?.cachedInputTokens, undefined);
  assert.equal(sample.usages[1]?.cacheWriteTokens, undefined);
  assert.equal(sample.usages[1]?.outputTokens, 8);
  assert.ok(sample.summary.gaps.some(value => value.messageDescriptor?.key === "diagnostics.sessions.parserUsage.m001"));
  const metrics = summarizeRoundMetrics(sample.messages, sample.usages, completeRoundSource(sample.summary.gaps));
  assert.equal(metrics.completedTurns, 1);
  assert.equal(metrics.averageSteps, 2);
  assert.equal(metrics.averageDurationMs, 60_000);
});

test("CodeFlicker 旧版包装只接受对应角色，不从任意嵌套字段提取请求", async () => {
  const sample = await parsed("codeflicker", [{ type: "assistant", sessionId: "legacy-mismatch", uuid: "unknown", timestamp,
    message: { role: "user", content: "合成上下文", usage: { input_tokens: 100, output_tokens: 10 } } }]);
  assert.equal(sample.messages.length, 0);
  assert.equal(sample.usages.length, 0);
});

test("CLI 完整持久化格式省略缓存零值，缺依据与显式无效字段仍未知", async () => {
  const native = (id: string, usage: object, baseline: object = { requestId: id, requestContextKey: "synthetic-context", historyRevision: 0 }) => ({
    type: "message", sessionId: "cache-zero", uuid: id, role: "assistant", timestamp, model: "synthetic-model",
    content: [{ type: "text", text: "合成回复" }], usage, metadata: { requestTokenBaseline: baseline },
  });
  const sample = await parsed("codeflicker", [
    native("zero", { input_tokens: 100, output_tokens: 10 }),
    native("positive", { input_tokens: 120, output_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 }),
    native("unmarked", { input_tokens: 100, output_tokens: 10 }, { requestId: "unmarked" }),
    native("invalid", { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: null }),
  ]);
  assert.equal(sample.usages[0]!.cachedInputTokens, 0);
  assert.equal(sample.usages[0]!.cacheWriteTokens, 0);
  assert.equal(sample.usages[0]!.inputTokens, 100);
  assert.equal(sample.usages[1]!.cachedInputTokens, 80);
  assert.equal(sample.usages[1]!.cacheWriteTokens, 20);
  assert.equal(sample.usages[2]!.cachedInputTokens, undefined);
  assert.equal(sample.usages[2]!.cacheWriteTokens, undefined);
  assert.equal(sample.usages[3]!.cachedInputTokens, undefined);
  const claude = await parsed("claude", [{ type: "assistant", timestamp, message: { id: "claude-unknown", role: "assistant", model: "synthetic-model",
    content: [{ type: "text", text: "合成回复" }], usage: { input_tokens: 100, output_tokens: 10 } } }]);
  assert.equal(claude.usages[0]!.cachedInputTokens, undefined);
  assert.equal(claude.usages[0]!.cacheWriteTokens, undefined);
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

test("写入、搜索、任意 command 参数及空 Shell 返回不能冒充 Skill 读取", async () => {
  const path = "/synthetic/skills/demo/SKILL.md";
  const sample = await parsed("codex", [meta(), user(),
    call("write", "Write", { file_path: path, content: "instructions" }), result("write", { success: true, content: "written" }),
    call("edit", "Edit", { path, old_string: "before", new_string: "after" }), result("edit", { success: true }),
    call("search", "Grep", { path, pattern: "skill" }), result("search", { success: true, content: "match" }),
    call("other", "custom_tool", { command: `cat ${path}` }), result("other", "Exit code: 0\nOutput:\ninstructions"),
    call("empty-shell", "functions.exec_command", { cmd: `cat ${path}` }), result("empty-shell", "Exit code: 0\nOutput:\n"),
    call("read-shell", "functions.exec_command", { cmd: "cat skills/actual/SKILL.md", workdir: "/synthetic/repo" }), result("read-shell", "Exit code: 0\nOutput:\ninstructions"),
  ]);
  assert.deepEqual(sample.messages.filter(message => message.resource).map(message => message.resource),
    [{ kind: "skill_read", name: "actual", path: "/synthetic/repo/skills/actual/SKILL.md" }]);
});

test("Codex 命令的兼容输出字段保留 Skill 正文，重复原生事件只计一次调用", async () => {
  for (const field of ["formatted_output", "aggregated_output"]) {
    const completed = { type: "event_msg", timestamp, payload: { type: "item_completed", item: {
      type: "CommandExecution", id: "native-read", command: ["/bin/sh", "-c", "cat /synthetic/skills/demo/SKILL.md"],
      status: "completed", exit_code: 0, [field]: "---\nname: demo\n---\n人工读取正文。\n",
    } } };
    const sample = await parsed("codex", [meta(), user(), completed, completed]);
    const calls = sample.messages.filter(message => message.kind === "tool_call");
    assert.equal(calls.length, 1, field);
    assert.deepEqual(calls[0]?.resource, { kind: "skill_read", name: "demo", path: "/synthetic/skills/demo/SKILL.md" }, field);
    assert.match(sample.messages.find(message => message.kind === "tool_result")!.text, /人工读取正文/, field);
    assert.equal(sample.summary.turnCount, 1);
  }
});

test("多 Skill 的单次命令保留一次调用，失败或明确空的优先输出不补使用", async () => {
  const paths = ["/synthetic/skills/first/SKILL.md", "/synthetic/skills/second/SKILL.md"];
  const body = "---\nname: first\n---\n第一份正文\n---\nname: second\n---\n第二份正文\n";
  const completed = (id: string, fields = {}) => ({ type: "event_msg", timestamp, payload: { type: "item_completed", item: {
    type: "CommandExecution", id, command: ["/bin/sh", "-c", `cat ${paths.join(" ")} ${paths[0]}`], status: "completed", exit_code: 0, aggregated_output: body, ...fields,
  } } });
  const sample = await parsed("codex", [meta(), user(), completed("read"), completed("failed", { exit_code: 1 }), completed("empty", { formatted_output: "" }),
    completed("stdout-only", { aggregated_output: undefined, stdout: body })]);
  const calls = sample.messages.filter(message => message.kind === "tool_call");
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0]?.resources?.map(resource => resource.name), ["first", "second"]);
  assert.equal(calls[1]?.resource, undefined);
  assert.equal(calls[2]?.resource, undefined);
  assert.equal(calls[3]?.resource, undefined);
  assert.equal(sample.summary.turnCount, 1);
});

test("Claude 结构化 Read 省略 is_error 仍确认读取，多结果不共享旁路元信息", async () => {
  const path = "/synthetic/skills/demo/SKILL.md";
  const read = (id: string) => ({ type: "assistant", uuid: `a-${id}`, sessionId: "claude-demo", cwd: "/synthetic/repo",
    message: { role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file_path: path } }] } });
  const block = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "1\tinstructions" });
  const file = { content: "instructions", filePath: path, startLine: 1, numLines: 1, totalLines: 1 };
  const sample = await parsed("claude", [read("single"), { type: "user", uuid: "r-single", sessionId: "claude-demo",
    message: { role: "user", content: [block("single")] }, toolUseResult: { type: "text", file } },
  read("one"), read("two"), { type: "user", uuid: "r-many", sessionId: "claude-demo",
    message: { role: "user", content: [block("one"), block("two")] }, toolUseResult: { type: "text", file } }]);
  const calls = sample.messages.filter(message => message.kind === "tool_call");
  assert.equal(calls[0]?.status, "success");
  assert.deepEqual(calls[0]?.resource, { kind: "skill_read", name: "demo", path });
  assert.ok(calls.slice(1).every(message => message.status === "unknown" && !message.resource));
});

test("缺失 Skill 名标记生成来源，真实同名和目录名保留原文", async () => {
  const sample = await parsed("codex", [meta(), user(),
    call("missing-name", "Skill", {}), result("missing-name", { success: true }),
    call("recorded-name", "Skill", { skill: "未记录名称" }), result("recorded-name", { success: true }),
    call("directory-name", "Skill", { skill_directory: "/synthetic/skills/未记录名称" }), result("directory-name", { success: true }),
  ]);
  const resources = sample.messages.filter(message => message.resource).map(message => message.resource!);
  assert.equal(resources.length, 3);
  assert.ok(resources.every(resource => resource.name === "未记录名称"));
  assert.deepEqual(resources[0]?.nameDescriptor, { key: "sessions.resource.nameUnrecorded" });
  assert.equal(resources[1]?.nameDescriptor, undefined);
  assert.equal(resources[2]?.nameDescriptor, undefined);
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
  assert.equal(sample.usages.length, 2, "保留自己的用量与缺少用量的委派请求，复制前缀不新增请求");
  assert.equal(sample.usages.filter(usage => usage.outputTokens !== undefined).length, 1);
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

test("CodeFlicker 原生隐藏注入保留为上下文，不产生用户轮次", async () => {
  const records = [{ type: "message", sessionId: "hidden-context", uuid: "u", role: "user", content: "真实问题", timestamp },
    { type: "message", sessionId: "hidden-context", uuid: "injection", role: "user", hidden: true, content: "Base directory for this skill: /synthetic/skill", timestamp },
    { type: "message", sessionId: "hidden-context", uuid: "a", role: "assistant", content: "最终回答", stop_reason: "end_turn", timestamp }];
  const result = await parsed("codeflicker", records);
  assert.equal(result.summary.turnCount, 1);
  const injected = result.messages.find(message => message.text.startsWith("Base directory"));
  assert.equal(injected?.kind, "context"); assert.equal(injected?.contextEvidence, "client_metadata");
});

test("CodeFlicker 后台注入保留原始依据，明确用户来源的排队注入仍创建需求", async () => {
  const native = (uuid: string, content: unknown, metadata = {}, extra = {}) => ({ type: "message", sessionId: "injected-demo", uuid,
    role: "user", content, timestamp, metadata, ...extra });
  const sample = await parsed("codeflicker", [native("first", "真实问题"),
    native("background", "后台通知", { injected: true }),
    native("task", "任务通知", { origin: { kind: "task-notification" } }),
    native("recent", "压缩后的历史上下文", { origin: { kind: "post-compact-recent-user-context" } }),
    native("queued", "排队的真实需求", { injected: true, origin: { kind: "user" } }),
    native("command", "命令输入", { injected: true, origin: { kind: "command-input" } }),
    native("unknown", "未知来源仍保留需求", { origin: { kind: "future-origin" } }),
    native("hidden-user", "明确隐藏的上下文", { injected: true, origin: { kind: "user" } }, { hidden: true })]);
  assert.equal(sample.summary.turnCount, 4);
  assert.deepEqual(sample.messages.filter(message => message.kind === "user").map(message => message.text),
    ["真实问题", "排队的真实需求", "命令输入", "未知来源仍保留需求"]);
  assert.ok(sample.messages.filter(message => message.kind === "context").every(message => message.contextEvidence === "client_metadata"));
  assert.equal(sample.messages.find(message => message.text === "后台通知")?.turnId, sample.messages[0]?.turnId);
});

test("CodeFlicker 严格原生取消控制记录不造需求，并撤销已有终答", async () => {
  const native = (uuid: string, role: string, content: unknown, extra = {}) => ({ type: "message", sessionId: "cancel-demo", uuid,
    role, content, timestamp, ...extra });
  const control = [{ type: "text", text: "[Request interrupted by user]" }];
  const cancelled = await parsed("codeflicker", [native("user", "user", "真实需求"),
    native("answer", "assistant", "已保存的响应", { stop_reason: "end_turn", model: "fixture-model", usage: { input_tokens: 20, output_tokens: 10 } }),
    native("cancel", "user", control)]);
  assert.equal(cancelled.summary.turnCount, 1);
  assert.equal(cancelled.messages.at(-1)?.kind, "system");
  assert.equal(cancelled.messages.at(-1)?.text, "[Request interrupted by user]");
  assert.equal(cancelled.messages.at(-1)?.interrupted, true);
  assert.equal(cancelled.messages.find(message => message.kind === "assistant")?.interrupted, true);
  assert.ok(cancelled.messages.every(message => !message.final && !message.finalEvidence));
  assert.equal(cancelled.usages[0]?.timing?.completion, "partial");
  const ordinary = await parsed("codeflicker", [native("string", "user", "[Request interrupted by user]"),
    native("quoted", "user", [{ type: "text", text: "请解释 [Request interrupted by user]" }]),
    native("multiple", "user", [...control, { type: "text", text: "另一条用户内容" }])]);
  assert.equal(ordinary.summary.turnCount, 3, "普通正文或多个内容块不能被识别成客户端取消事件");
});

test("Codex 已标 final 的响应遇到取消时撤销终答，失败后恢复的响应可以结束", async () => {
  const aborted = { type: "event_msg", timestamp, payload: { type: "task_aborted" } };
  const cancelled = await parsed("codex", [meta(), user(), assistant("answer", "已保存的响应", { channel: "final" }), requestUsage("answer"), aborted]);
  assert.ok(cancelled.messages.every(message => !message.final && !message.finalEvidence));
  assert.equal(cancelled.messages.find(message => message.kind === "assistant")?.interrupted, true);
  assert.equal(cancelled.usages[0]?.timing?.completion, "partial");
  const repeated = await parsed("codex", [meta(), user(), assistant("answer", "已保存的响应", { channel: "final" }), requestUsage("answer"), aborted,
    assistant("answer", "已保存的响应", { channel: "final" })]);
  assert.ok(repeated.messages.every(message => !message.final && !message.finalEvidence), "重放已取消的原生快照不能恢复终答");
  const recovered = await parsed("codex", [meta(), user(), assistant("partial", "失败的响应"), aborted,
    assistant("recovered", "恢复后结束", { channel: "final" })]);
  assert.equal(recovered.messages.find(message => message.text === "恢复后结束")?.final, "explicit");
  assert.equal(recovered.messages.find(message => message.text === "恢复后结束")?.finalEvidence, "response_completed");
});

test("Claude 原生响应中断标志覆盖结束原因，后续正常响应保留结束依据", async () => {
  const native = (uuid: string, request: string, extra = {}) => ({ type: "assistant", sessionId: "claude-cancel", uuid, timestamp, ...extra,
    message: { id: request, role: "assistant", model: "fixture-model", content: [{ type: "text", text: uuid }],
      stop_reason: "end_turn", usage: { input_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 } } });
  for (const flags of [{ isInterrupted: true }, { isApiErrorMessage: true }, { interrupted: true }]) {
    const cancelled = await parsed("claude", [native("partial", "partial", flags)]);
    assert.ok(cancelled.messages.every(message => !message.final && !message.finalEvidence));
    assert.equal(cancelled.messages[0]?.interrupted, true);
    assert.equal(cancelled.usages[0]?.timing?.completion, "partial");
    const recovered = await parsed("claude", [native("partial", "partial", flags), native("recovered", "recovered")]);
    assert.equal(recovered.messages.at(-1)?.final, "explicit");
    assert.equal(recovered.messages.at(-1)?.finalEvidence, "normal_stop");
  }
  const earlyTarget = await parsed("claude", [native("earlier", "earlier"), native("answer", "answer"),
    { type: "system", uuid: "cancel", interruptedMessageId: "earlier", timestamp }]);
  assert.equal(earlyTarget.messages.find(message => message.text === "answer")?.final, "explicit");
  assert.equal(earlyTarget.messages.find(message => message.text === "earlier")?.final, undefined);
  const finalTarget = await parsed("claude", [native("answer", "answer"),
    { type: "system", uuid: "cancel", interruptedMessageId: "answer", timestamp }]);
  assert.ok(finalTarget.messages.every(message => !message.final && !message.finalEvidence));
  const repeated = await parsed("claude", [native("answer", "answer"),
    { type: "system", uuid: "cancel", interruptedMessageId: "answer", timestamp }, native("answer", "answer")]);
  assert.ok(repeated.messages.every(message => !message.final && !message.finalEvidence), "重复快照不能清除已确认的请求中断");
  const untargeted = await parsed("claude", [native("answer", "answer"),
    { type: "system", uuid: "error", isApiErrorMessage: true, timestamp }]);
  assert.equal(untargeted.messages.find(message => message.text === "answer")?.final, "explicit", "无法关联到已完成请求的后续错误不撤销确定证据");
});

test("原生正常终态提供结束依据，CodeFlicker 缺结束原因的持久化用量不提供强证据", async () => {
  const native = (uuid: string, extra = {}) => ({ type: "message", sessionId: "terminal-demo", uuid, role: "assistant", timestamp,
    model: "fixture-model", content: "合成响应", usage: { input_tokens: 20, output_tokens: 10 },
    metadata: { requestTokenBaseline: { requestId: uuid } }, ...extra });
  const completed = await parsed("codeflicker", [native("normal", { stop_reason: "end_turn" })]);
  assert.equal(completed.messages[0]?.finalEvidence, "normal_stop");
  const saved = await parsed("codeflicker", [native("saved")]);
  assert.equal(saved.messages[0]?.final, "inferred");
  assert.equal(saved.messages[0]?.finalEvidence, undefined);
  assert.equal(saved.usages[0]?.timing?.completionEvidence, "persisted_stream_result");
});

test("旧 Codex token_count 只用当次 total_tokens 补上下文，不读取累计总量", async () => {
  const result = await parsed("codex", [meta(), user(), assistant("a", "已保存回复"),
    counted({ ...usageValue(500), total_tokens: 9000 }, { ...usageValue(100), total_tokens: 123 }),
    requestUsage("new-record", { ...usageValue(800), total_tokens: 15000 }, { ...usageValue(80), total_tokens: 999 })]);
  assert.equal(result.usages[0]?.contextTokens, 123);
  assert.equal(result.usages[1]?.contextTokens, undefined);
});
