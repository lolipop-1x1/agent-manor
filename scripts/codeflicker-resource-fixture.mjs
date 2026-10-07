import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodeDesktop } from "./desktop-fixture.mjs";

/** 两种客户端的合成来源；不执行客户端、插件或 MCP 服务。 */
export async function codeflickerResourceFixture(directory) {
  const userHome = join(directory, "user");
  const home = join(directory, "data");
  const project = join(directory, "sample-project");
  const cliRoot = join(userHome, ".codeflicker");
  const desktopRoot = join(userHome, ".myflicker");
  const cliHistory = join(directory, "cli-history");
  const desktopHistory = join(directory, "desktop-history");
  const skill = async (path, name) => {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: Artificial verification resource\n---\n# Guide\nSynthetic content.\n`);
    return path;
  };
  const cliSkill = await skill(join(cliRoot, "skills", "cli-guide"), "cli-guide");
  await skill(join(cliRoot, "skills", "user-guide"), "user-guide");
  await skill(join(cliRoot, "skills", "shadow-guide"), "shadow-guide");
  await skill(join(project, ".codeflicker", "skills", "shadow-guide"), "shadow-guide");
  const desktopSkill = await skill(join(desktopRoot, "skills", "desktop-guide"), "desktop-guide");
  for (let index = 0; index < 25; index++) {
    const name = `z-sample-${String(index).padStart(2, "0")}`;
    await skill(join(cliRoot, "skills", name), name);
    await skill(join(desktopRoot, "skills", name), name);
  }
  await skill(join(desktopRoot, "internal", "skills", "builtin-guide"), "builtin-guide");
  await skill(join(desktopRoot, "remote-personal-skills", "market-guide"), "market-guide");
  await mkdir(join(desktopRoot, "config"), { recursive: true });
  const cliConfig = join(cliRoot, "config.json");
  await writeFile(cliConfig, JSON.stringify({ claudeImport: false, remoteSkills: false,
    skills: { userOnly: ["user-guide"] }, untouched: { value: 42 },
    mcpServers: { "cli-service": { command: "example-service", env: { TOKEN: "synthetic-private-token" } },
      "other-service": { type: "http", url: "https://example.invalid/mcp" } },
  }, null, 2));
  const desktopConfig = join(desktopRoot, "config", "mcp.json");
  await writeFile(desktopConfig, JSON.stringify({ mcpServers: {
    "desktop-service": { command: "example-service", disabled: true, env: { TOKEN: "synthetic-desktop-private" } },
  } }, null, 2));
  const plugin = join(cliRoot, "plugins", "cache", "example", "1.0.0");
  await skill(join(plugin, "skills", "plugin-guide"), "plugin-guide");
  await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
  await writeFile(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "example", skills: "./skills" }));
  await writeFile(join(cliRoot, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2,
    plugins: { "example@market": [{ scope: "user", installPath: plugin }] },
  }));
  await skill(join(cliRoot, "plugins", "cache", "example", "0.9.0", "skills", "old-guide"), "old-guide");
  await mkdir(join(cliRoot, "plugins", "cache", "example", "0.9.0", ".claude-plugin"), { recursive: true });
  await writeFile(join(cliRoot, "plugins", "cache", "example", "0.9.0", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "example" }));
  await mkdir(cliHistory, { recursive: true });
  await mkdir(join(desktopHistory, "synthetic-desktop", "message"), { recursive: true });
  const timestamp = "2026-01-01T00:00:00Z";
  const file = join(cliSkill, "SKILL.md");
  const text = "# Guide\nSynthetic content.";
  const input = { file_path: file };
  const cliRecords = [
    { type: "config", sessionId: "synthetic-cli", cwd: project },
    { type: "message", role: "user", uuid: "user", timestamp, sessionId: "synthetic-cli", content: [{ type: "text", text: "Verify artificial resources" }] },
    { type: "message", role: "assistant", uuid: "read-request", timestamp, sessionId: "synthetic-cli", content: [{ type: "tool_use", id: "read", name: "read", input }] },
    { type: "message", role: "tool", uuid: "read-result", timestamp, sessionId: "synthetic-cli", content: [{ type: "tool-result", toolCallId: "read", toolName: "read", input,
      result: { llmContent: JSON.stringify({ type: "text", filePath: file, content: text, totalLines: 2, offset: 1, limit: 2, actualLinesRead: 2 }), truncated: false } }] },
    { type: "message", role: "assistant", uuid: "mcp-request", timestamp, sessionId: "synthetic-cli", content: [{ type: "tool_use", id: "mcp", name: "mcp__cli-service__lookup", input: {} }] },
    { type: "message", role: "tool", uuid: "mcp-result", timestamp, sessionId: "synthetic-cli", content: [{ type: "tool-result", toolCallId: "mcp", toolName: "mcp__cli-service__lookup", result: { isError: false, llmContent: "Artificial result" } }] },
    { type: "message", role: "assistant", uuid: "final", timestamp, sessionId: "synthetic-cli", content: [{ type: "text", text: "Complete" }] },
  ];
  await writeFile(join(cliHistory, "synthetic-cli.jsonl"), cliRecords.map(record => JSON.stringify(record)).join("\n") + "\n");
  const desktopRecords = [
    { id: "user", kind: "message", role: "user", timestamp, turnId: "turn", content: [{ type: "text", text: "Verify artificial desktop resource" }] },
    { id: "request", kind: "message", role: "assistant", timestamp, extra: { turnId: "turn" }, toolCalls: [{ id: "skill", type: "function",
      function: { name: "use_skill", arguments: JSON.stringify({ skill_directory: desktopSkill }) } }] },
    { id: "result", kind: "message", role: "tool", timestamp, toolCallId: "skill", content: JSON.stringify({ success: true }), extra: { toolName: "use_skill" } },
    { id: "mcp-request", kind: "message", role: "assistant", timestamp, extra: { turnId: "turn" }, toolCalls: [{ id: "mcp", type: "function",
      function: { name: "mcp__desktop-service__lookup", arguments: "{}" } }] },
    { id: "mcp-result", kind: "message", role: "tool", timestamp, toolCallId: "mcp", content: JSON.stringify({ success: true }), extra: { toolName: "mcp__desktop-service__lookup" } },
    { id: "final", kind: "message", role: "assistant", timestamp, messageId: "final", content: "Complete", extra: { turnId: "turn" } },
    { op: "turn_terminal", turnId: "turn", outcome: "completed", finishedAt: timestamp, lastMessageId: "final" },
  ];
  await mkdir(join(desktopHistory, "synthetic-desktop", "checkpoints"), { recursive: true });
  await writeFile(join(desktopHistory, "synthetic-desktop", "checkpoints", "registry.json"), JSON.stringify({ sessionId: "synthetic-desktop", cwd: project }));
  await writeFile(join(desktopHistory, "synthetic-desktop", "message", "cache.jsonl"), encodeDesktop(desktopRecords));
  return { home, userHome, project, cliHistory, desktopHistory, cliSkill, desktopSkill, cliConfig, desktopConfig };
}
