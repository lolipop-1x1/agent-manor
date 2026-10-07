import { appendFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resourceFixture } from "./resource-fixture.mjs";

/** 地图人工夹具：完整历史、零指标、新发现资源及共享入口，不运行 MCP。 */
export async function resourceMapFixture(directory, count = 215) {
  const fixture = await resourceFixture(directory, 0);
  const claudeHistory = join(directory, "history-claude");
  await mkdir(claudeHistory);
  const now = new Date();
  const time = (days = 0) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const skill = async name => {
    const path = join(fixture.userHome, ".codex", "skills", name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\n---\n人工地图资源。\n`);
    return path;
  };
  const records = [{ type: "session_meta", timestamp: time(), payload: { id: "map-codex-example", cwd: fixture.project, title: "资源地图人工数据" } }];
  const record = (payload, days = 0) => ({ type: "response_item", timestamp: time(days), payload });
  records.push(record({ type: "message", role: "user", content: [{ type: "input_text", text: "使用人工资源测试地图" }] }));
  let calls = 0;
  const call = (name, args, days = 0) => {
    const id = `map-call-${calls++}`;
    records.push(record({ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }, days));
    records.push(record({ type: "function_call_output", call_id: id, output: "Exit code: 0\nOutput:\n人工成功结果。\n" }, days));
  };
  let config = "";
  for (let index = 0; index < count; index++) {
    const suffix = String(index).padStart(3, "0");
    await skill(`map-skill-${suffix}`);
    config += `\n[mcp_servers.map-mcp-${suffix}]\ncommand = "example-service"\n`;
    const uses = index === 0 ? 100 : index === 1 ? 10 : 1;
    const days = index % 3 === 0 ? 0 : index % 3 === 1 ? 60 : 120;
    for (let use = 0; use < uses; use++) {
      call("Skill", { skill: `map-skill-${suffix}` }, days);
      call(`mcp__map-mcp-${suffix}__lookup`, {}, days);
    }
  }
  for (let index = 0; index < 45; index++) {
    const suffix = String(index).padStart(3, "0");
    const path = await skill(`map-read-${suffix}`);
    call("shell_command", { command: `cat '${join(path, "SKILL.md")}'`, workdir: fixture.project });
    await skill(`map-zero-${suffix}`);
    await skill(`map-review-${suffix}`);
    config += `\n[mcp_servers.map-zero-${suffix}]\ncommand = "example-zero-service"\n[mcp_servers.map-review-${suffix}]\ncommand = "example-review-service"\n`;
  }
  call("mcp__map-history-only__lookup", {});
  records.push({ type: "response_item", payload: { type: "function_call", name: "Skill", call_id: "map-undated", arguments: JSON.stringify({ skill: "map-undated" }) } });
  records.push({ type: "response_item", payload: { type: "function_call_output", call_id: "map-undated", output: "Exit code: 0\nOutput:\n人工无时间记录。\n" } });
  records.push(record({ type: "reasoning", encrypted_content: "synthetic-encrypted-thinking" }));
  records.push(record({ type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "人工资源调用完成" }] }));
  await appendFile(fixture.configPath, config);
  const claudeConfigPath = join(fixture.userHome, ".claude.json");
  const claudeConfig = JSON.parse(await readFile(claudeConfigPath, "utf8"));
  claudeConfig.mcpServers["map-mcp-001"] = { url: "https://example.invalid/map-mcp", headers: { Authorization: "synthetic-map-secret" } };
  await writeFile(claudeConfigPath, JSON.stringify(claudeConfig, null, 2));
  await writeFile(join(fixture.history, "map.jsonl"), records.map(value => JSON.stringify(value)).join("\n") + "\n");
  const shared = join(fixture.userHome, ".claude", "skills", "map-skill-001");
  await symlink(join(fixture.userHome, ".codex", "skills", "map-skill-001"), shared, "dir");
  const claude = [
    { type: "user", uuid: "map-claude-user", timestamp: time(), sessionId: "map-claude-example", cwd: fixture.project,
      message: { content: [{ type: "text", text: "成功读取同一个 Skill" }] } },
    { type: "assistant", uuid: "map-claude-read", timestamp: time(), sessionId: "map-claude-example", cwd: fixture.project,
      message: { content: [{ type: "tool_use", id: "map-claude-read", name: "Read", input: { file_path: join(shared, "SKILL.md") } }] } },
    { type: "user", uuid: "map-claude-result", sourceToolAssistantUUID: "map-claude-read", timestamp: time(), sessionId: "map-claude-example", cwd: fixture.project,
      message: { content: [{ type: "tool_result", tool_use_id: "map-claude-read", content: "人工共享资源。", is_error: false }] },
      toolUseResult: { type: "text", file: { filePath: join(shared, "SKILL.md"), content: "人工共享资源。", numLines: 1, startLine: 1, totalLines: 1 } } },
    { type: "assistant", uuid: "map-claude-final", timestamp: time(), sessionId: "map-claude-example", cwd: fixture.project,
      message: { content: [{ type: "text", text: "人工读取完成" }] } },
  ];
  await writeFile(join(claudeHistory, "map.jsonl"), claude.map(value => JSON.stringify(value)).join("\n") + "\n");
  const system = join(fixture.userHome, ".codex", "skills", ".system", "map-system");
  await mkdir(system, { recursive: true });
  await writeFile(join(system, "SKILL.md"), "---\nname: map-system\n---\n人工系统资源。\n");
  return { ...fixture, claudeHistory, claudeConfigPath, sharedMapLink: shared, count };
}
