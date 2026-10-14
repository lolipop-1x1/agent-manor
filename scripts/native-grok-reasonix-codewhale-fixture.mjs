import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const when = "2026-10-13T04:00:00.000Z";
const jsonl = records => records.map(record => JSON.stringify(record)).join("\n") + "\n";
async function file(path, text) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); }
async function json(path, value) { await file(path, JSON.stringify(value)); }
const skill = name => `---\nname: ${name}\ndescription: 合成验收技能\n---\n# 合成指令\n检查示例代码。\n`;

/** 构造固定原生 schema 的隔离来源，供 API、CLI 与浏览器验收共用。 */
export async function grokReasonixCodewhaleFixture(directory, project) {
  const userHome = join(directory, "user");
  const roots = { grok: join(userHome, ".grok", "sessions"), reasonix: join(userHome, ".reasonix", "sessions"), codewhale: join(userHome, ".codewhale", "sessions") };
  const grokSource = join(project, "src", "example.ts"); const grokContent = await readFile(grokSource, "utf8");
  const reasonixSource = grokSource; const reasonixContent = grokContent;
  const whaleSource = grokSource; const whaleContent = grokContent;
  const numbered = reasonixContent.trimEnd().split("\n").map((line, index) => `${index + 1}→${line}`).join("\n") + "\n";
  const grokDir = join(roots.grok, "synthetic-workspace", "grok-native-session");
  let sequence = 0;
  const update = (value, extension = false) => ({ timestamp: Math.floor(Date.parse(when) / 1000), method: extension ? "_x.ai/session/update" : "session/update",
    params: { sessionId: "grok-native-session", update: value, _meta: { eventId: `grok-native-event-${++sequence}`, promptId: "grok-native-prompt", agentTimestampMs: Date.parse(when) } } });
  const grokRows = [update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Grok 合成验收：检查示例代码" } }),
    update({ sessionUpdate: "response_started", message_id: "grok-native-response", model: "synthetic-model", input_tokens: 70, cache_read_input_tokens: 30, cache_creation_input_tokens: 0 }, true),
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "读取代码。" } }),
    update({ sessionUpdate: "tool_call", toolCallId: "grok-native-read", title: "读取示例", rawInput: { target_file: grokSource }, _meta: { "x.ai/tool": { name: "read_file" } } }),
    update({ sessionUpdate: "tool_call_update", toolCallId: "grok-native-read", status: "completed", content: [{ type: "content", content: { type: "text", text: numbered } }],
      rawOutput: { FileContent: { absolute_path: grokSource, offset: 1, raw_output: grokContent, total_lines: 1 } } }),
    update({ sessionUpdate: "response_completed", message_id: "grok-native-response", stop_reason: "tool_use", usage: { input_tokens: 70, cache_read_input_tokens: 30, cache_creation_input_tokens: 0, output_tokens: 20, reasoning_tokens: 5 } }, true),
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "示例检查完成。" } }),
    update({ sessionUpdate: "turn_completed", prompt_id: "grok-native-prompt", stop_reason: "end_turn", usage: { totals: { input_tokens: 100, output_tokens: 20, cached_read_tokens: 30, reasoning_tokens: 5, model_calls: 1 } } }, true)];
  await file(join(grokDir, "updates.jsonl"), jsonl(grokRows));
  await json(join(grokDir, "summary.json"), { info: { id: "grok-native-session", cwd: project }, session_summary: "Grok 合成验收", current_model_id: "synthetic-model" });
  await json(join(grokDir, "usage.json"), { sessionId: "grok-native-session", updatedAt: when, session: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 30, modelCalls: 1 } });
  await file(join(userHome, ".grok", "skills", "native-grok-check", "SKILL.md"), skill("native-grok-check"));
  await file(join(userHome, ".grok", "config.toml"), '[mcp_servers.native-grok-server]\ncommand = "example-server"\nenabled = true\n');

  const reasonixPath = join(roots.reasonix, "reasonix-native-session.jsonl");
  const reasonixMessages = [{ role: "user", content: "Reasonix 合成验收：检查示例代码", createdAt: Date.parse(when) },
    { role: "assistant", content: "读取代码。", modelRef: "synthetic-model", createdAt: Date.parse(when), tool_calls: [{ id: "reasonix-native-read", name: "read_file", arguments: JSON.stringify({ path: reasonixSource, offset: 0 }) }] },
    { role: "tool", name: "read_file", tool_call_id: "reasonix-native-read", content: numbered, createdAt: Date.parse(when) },
    { role: "assistant", content: "示例检查完成。", modelRef: "synthetic-model", createdAt: Date.parse(when) }];
  await file(reasonixPath, jsonl(reasonixMessages));
  await file(reasonixPath.replace(".jsonl", ".events.jsonl"), jsonl([{ schema_version: 1, type: "replace", revision: 1, messages: reasonixMessages, created_at: when }]));
  await json(`${reasonixPath}.meta`, { id: "reasonix-native-session", name: "Reasonix 合成验收", workspace_root: project, model: "synthetic-model" });
  await file(reasonixPath.replace(".jsonl", ".wire.jsonl"), jsonl([{ kind: "turn_started", msgIndex: 0, authoredTurn: 1 },
    { kind: "usage", modelRef: "synthetic-model", usage: { attemptId: "reasonix-native-attempt", promptTokens: 100, completionTokens: 20, totalTokens: 120, cacheHitTokens: 30, cacheMissTokens: 70, reasoningTokens: 5 } },
    { kind: "turn_done", outcome: "completed" }]));
  await file(join(userHome, ".reasonix", "skills", "native-reasonix-check", "SKILL.md"), skill("native-reasonix-check"));
  await file(join(userHome, ".reasonix", "config.toml"), '[[plugins]]\nname = "native-reasonix-server"\ncommand = "example-server"\nauto_start = true\n');

  const entry = (id, parent_id, role, content) => ({ id, parent_id, kind: "message", created_at: when, message: { role, content } });
  const whaleEntries = [entry("codewhale-native-user", null, "user", [{ type: "text", text: "Codewhale 合成验收：检查示例代码" }]),
    entry("codewhale-native-call", "codewhale-native-user", "assistant", [{ type: "tool_use", id: "codewhale-native-read", execution_id: "codewhale-native-execution", name: "bash", input: { command: `cat '${whaleSource}'` } }]),
    entry("codewhale-native-result", "codewhale-native-call", "user", [{ type: "tool_result", tool_use_id: "codewhale-native-read", execution_id: "codewhale-native-execution", content: whaleContent, is_error: false }]),
    entry("codewhale-native-answer", "codewhale-native-result", "assistant", [{ type: "text", text: "示例检查完成。" }])];
  await json(join(roots.codewhale, "codewhale-native-session.json"), { schema_version: 1,
    metadata: { id: "codewhale-native-session", title: "Codewhale 合成验收", workspace: project, model: "synthetic-model", total_tokens: 120, updated_at: when, cost: { session_cost_usd: 0.002, coverage_recorded: true, priced_turns: 1 } },
    journal: { schema_version: 1, leaf_id: "codewhale-native-answer", entries: whaleEntries }, leaf_id: "codewhale-native-answer", messages: whaleEntries.map(entry => entry.message) });
  await file(join(userHome, ".codewhale", "skills", "native-codewhale-check", "SKILL.md"), skill("native-codewhale-check"));
  await json(join(userHome, ".codewhale", "mcp.json"), { servers: { "native-codewhale-server": { command: "example-server", enabled: true } } });
  return { roots, userHome };
}
