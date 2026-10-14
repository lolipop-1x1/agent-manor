import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const jsonl = rows => `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
const time = "2026-10-14T02:00:00.000Z";
const file = async (path, body) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, body); };
const skill = name => `---\nname: ${name}\ndescription: Synthetic native fixture\n---\n\nRead synthetic source files.\n`;

/** 所有数据人工生成；目录、工具结果及注册不需要启动客户端。 */
export async function geminiQwenFixture(directory, project) {
  const userHome = join(directory, "user");
  const geminiRoot = join(userHome, ".gemini"); const geminiHistory = join(geminiRoot, "tmp", "fixture-project", "chats");
  await file(join(geminiRoot, "projects.json"), JSON.stringify({ projects: { [project]: "fixture-project" } }));
  await file(join(geminiRoot, "tmp", "fixture-project", ".project_root"), project);
  const tool = { id: "fixture-gemini-read", name: "read_file", args: { file_path: "src/example.ts", start_line: 1, end_line: 2 }, timestamp: time, status: "success",
    result: [{ functionResponse: { id: "fixture-gemini-read", name: "read_file", response: { output: "export const alpha = 1;\nexport const beta = 2;" } } }] };
  await file(join(geminiHistory, "session-fixture.jsonl"), jsonl([
    { sessionId: "fixture-gemini-session", projectHash: "fixture-project", startTime: time, lastUpdated: time, kind: "main" },
    { id: "fixture-gemini-user", type: "user", content: "Inspect the synthetic example", timestamp: time },
    { id: "fixture-gemini-assistant", type: "gemini", content: "I inspected the synthetic example.", timestamp: time, model: "synthetic-model",
      toolCalls: [tool], tokens: { input: 100, output: 10, thoughts: 2, cached: 20, tool: 0, total: 112 } },
  ]));
  await file(join(geminiRoot, "settings.json"), JSON.stringify({ security: { folderTrust: { enabled: false } }, mcpServers: { "fixture-gemini-mcp": { command: "synthetic-server", args: [] } } }));
  await file(join(geminiRoot, "skills", "fixture-gemini-skill", "SKILL.md"), skill("fixture-gemini-skill"));
  const qwenRoot = join(userHome, ".qwen"); const qwenHistory = join(qwenRoot, "projects", "fixture-project", "chats");
  const record = (uuid, parentUuid, type, extra = {}) => ({ uuid, parentUuid, type, sessionId: "fixture-qwen-session", cwd: project, version: "0.25.1", timestamp: time, ...extra });
  await file(join(qwenHistory, "fixture-qwen-session.jsonl"), jsonl([
    record("fixture-qwen-user", null, "user", { promptId: "fixture-qwen-prompt", executionContext: { authType: "openai" }, message: { role: "user", parts: [{ text: "Inspect the synthetic example" }] } }),
    record("fixture-qwen-assistant", "fixture-qwen-user", "assistant", { model: "synthetic-model", usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 12, thoughtsTokenCount: 2, cachedContentTokenCount: 20 }, message: { role: "model", parts: [{ text: "I will inspect the synthetic example." }, { functionCall: { id: "fixture-qwen-read", name: "read_file", args: { file_path: "src/example.ts", offset: 0, limit: 2 } } }] } }),
    record("fixture-qwen-result", "fixture-qwen-assistant", "tool_result", { toolCallResult: { callId: "fixture-qwen-read", status: "success" }, message: { role: "user", parts: [{ functionResponse: { id: "fixture-qwen-read", name: "read_file", response: { output: "export const alpha = 1;\nexport const beta = 2;" } } }] } }),
    record("fixture-qwen-final", "fixture-qwen-result", "assistant", { model: "synthetic-model", message: { role: "model", parts: [{ text: "I inspected the synthetic example." }] } }),
    record("fixture-qwen-end", "fixture-qwen-final", "system", { subtype: "turn_result", systemPayload: { promptId: "fixture-qwen-prompt", state: "completed", stopReason: "end_turn", endedAt: Date.parse(time) + 1000 } }),
  ]));
  await file(join(qwenRoot, "settings.json"), JSON.stringify({ security: { folderTrust: { enabled: false } }, mcpServers: { "fixture-qwen-mcp": { command: "synthetic-server", args: [] } } }));
  await file(join(qwenRoot, "skills", "fixture-qwen-skill", "SKILL.md"), skill("fixture-qwen-skill"));
  return { roots: { gemini: join(geminiRoot, "tmp"), qwen: join(qwenRoot, "projects") }, userHome };
}
