import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 七客户端验收共用的隔离人工来源，仅写入 Kimi 与 Oh My Pi 的目录。 */
export async function kimiOmpFixture(directory, project) {
  const userHome = join(directory, "user");
  const epoch = Date.UTC(2026, 9, 1, 8);
  const at = seconds => new Date(epoch + seconds * 1000).toISOString();
  const encode = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  const save = async (path, body) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, body); };
  const skill = name => `---\nname: ${name}\ndescription: Synthetic native integration skill\n---\n\nSynthetic skill body.\n`;
  const mcp = { command: "node", args: ["synthetic-server.mjs"], enabled: true };
  const wire = (type, seconds, extra = {}) => ({ type, agentId: "main", time: epoch + seconds * 1000, ...extra });
  const loop = (type, seconds, extra = {}) => wire("context.append_loop_event", seconds, { event: { type, ...extra } });
  const kimiRoot = join(userHome, ".kimi-code", "sessions");
  const sessionDir = join(kimiRoot, "synthetic-workspace", "synthetic-kimi");
  await save(join(sessionDir, "state.json"), JSON.stringify({ id: "synthetic-kimi", version: 2, cwd: project, title: "Synthetic Kimi session", createdAt: epoch, updatedAt: epoch + 6000, archived: false, agents: { main: { type: "main" } } }));
  await save(join(sessionDir, "agents", "main", "wire.jsonl"), encode([
    { type: "metadata", protocol_version: "1.5", created_at: epoch },
    wire("turn.prompt", 0, { promptId: "synthetic-prompt", turnId: 0, origin: { kind: "user" }, input: [{ type: "text", text: "Inspect synthetic native source" }] }),
    wire("context.append_message", 0.1, { message: { id: "synthetic-prompt", role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "Inspect synthetic native source" }] } }),
    loop("step.begin", 1, { uuid: "synthetic-step", turnId: "0" }),
    wire("llm.request", 1.1, { kind: "loop", provider: "synthetic-provider", model: "synthetic-model" }),
    loop("tool.call", 2, { uuid: "synthetic-call-event", stepUuid: "synthetic-step", toolCallId: "synthetic-read", name: "Read", args: { path: "src/example.ts", line_offset: 1, n_lines: 2 } }),
    loop("tool.result", 3, { toolCallId: "synthetic-read", result: { output: "1\texport const alpha = 1;\n2\texport const beta = 2;", note: "<system>2 lines read from file starting from line 1. Total lines in file: 2. Requested range complete. End of file reached.</system>" } }),
    loop("content.part", 4, { uuid: "synthetic-answer", stepUuid: "synthetic-step", part: { type: "text", text: "Synthetic source inspected." } }),
    wire("usage.record", 5, { model: "synthetic-model", usageScope: "turn", usage: { inputOther: 100, inputCacheRead: 20, inputCacheCreation: 5, output: 30 } }),
    loop("step.end", 5.1, { uuid: "synthetic-step", finishReason: "end_turn", usage: { inputOther: 100, inputCacheRead: 20, inputCacheCreation: 5, output: 30 } }),
    wire("turn.ended", 6, { turnId: 0, reason: "completed" }),
  ]));
  await save(join(userHome, ".kimi-code", "skills", "synthetic-kimi", "SKILL.md"), skill("synthetic-kimi"));
  await save(join(userHome, ".kimi-code", "mcp.json"), JSON.stringify({ mcpServers: { "synthetic-kimi": { ...mcp, transport: "stdio" } } }));
  const ompRoot = join(userHome, ".omp", "agent", "sessions");
  const entry = (type, id, parentId, seconds, extra = {}) => ({ type, id, parentId, timestamp: at(seconds), ...extra });
  await save(join(ompRoot, "synthetic-workspace", "synthetic-omp.jsonl"), encode([
    { type: "session", version: 3, id: "synthetic-omp", cwd: project, timestamp: at(0), title: "Synthetic Oh My Pi session" },
    entry("message", "synthetic-user", null, 0, { message: { role: "user", attribution: "user", timestamp: epoch, content: [{ type: "text", text: "Inspect synthetic native source" }] } }),
    entry("message", "synthetic-call", "synthetic-user", 2, { message: { role: "assistant", model: "synthetic-model", provider: "synthetic-provider", timestamp: epoch + 1000, stopReason: "toolUse", content: [{ type: "toolCall", id: "synthetic-read", name: "read", arguments: { path: "src/example.ts" } }], usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 5, totalTokens: 135 } } }),
    entry("message", "synthetic-result", "synthetic-call", 3, { message: { role: "toolResult", toolName: "read", toolCallId: "synthetic-read", isError: false, content: [{ type: "text", text: "1:export const alpha = 1;\n2:export const beta = 2;" }], details: { resolvedPath: join(project, "src", "example.ts"), displayContent: { text: "export const alpha = 1;\nexport const beta = 2;", startLine: 1, lineNumbers: [1, 2] }, totalLines: 2 } } }),
    entry("message", "synthetic-answer", "synthetic-result", 5, { message: { role: "assistant", model: "synthetic-model", provider: "synthetic-provider", timestamp: epoch + 4000, stopReason: "stop", content: [{ type: "text", text: "Synthetic source inspected." }], usage: { input: 110, output: 30, cacheRead: 25, cacheWrite: 0, totalTokens: 165 } } }),
  ]));
  await save(join(userHome, ".omp", "agent", "skills", "synthetic-omp", "SKILL.md"), skill("synthetic-omp"));
  await save(join(userHome, ".omp", "agent", "config.yml"), "disabledExtensions: []\n");
  await save(join(userHome, ".omp", "agent", "mcp.json"), JSON.stringify({ mcpServers: { "synthetic-omp": mcp } }));
  return { roots: { kimi: kimiRoot, omp: ompRoot }, userHome };
}
