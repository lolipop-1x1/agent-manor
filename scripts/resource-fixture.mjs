import { appendFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 人工资源与历史：仅在调用方创建的隔离目录内使用。 */
export async function resourceFixture(directory, count = 45) {
  const userHome = join(directory, "user");
  const project = join(directory, "sample-project");
  const home = join(directory, "data");
  const history = join(directory, "history");
  const guide = join(userHome, ".codex", "skills", "guide");
  const shared = join(userHome, ".agents", "skills", "shared");
  const link = join(userHome, ".claude", "skills", "shared");
  for (const path of [guide, shared, join(userHome, ".claude", "skills"), project, history]) await mkdir(path, { recursive: true });
  await writeFile(join(guide, "SKILL.md"), "---\nname: guide\ndescription: 人工合成指南\n---\n# 指南\n仅用于隔离验收。\n");
  await writeFile(join(guide, "asset.txt"), "保留资源附件\n");
  await writeFile(join(shared, "SKILL.md"), "---\nname: shared\n---\n共享测试资源。\n");
  await symlink(shared, link, "dir");
  await symlink(join(directory, "missing-target"), join(userHome, ".claude", "skills", "broken"), "dir");
  for (let index = 0; index < count; index++) {
    const path = join(userHome, ".codex", "skills", `sample-${String(index).padStart(2, "0")}`);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), `---\nname: sample-${String(index).padStart(2, "0")}\n---\n示例 ${index}。\n`);
  }
  const configPath = join(userHome, ".codex", "config.toml");
  await writeFile(configPath, '# 保留此注释\nmodel = "sample-model"\n[mcp_servers.sample]\ncommand = "example-command"\nargs = ["--sample"]\n[mcp_servers.sample.env]\nTOKEN = "synthetic-secret-keep-private"\n[mcp_servers.other]\nurl = "https://example.invalid/mcp"\nenabled = true\n');
  await writeFile(join(userHome, ".claude.json"), JSON.stringify({ untouched: { value: 42 }, mcpServers: { reference: { command: "example-command", env: { TOKEN: "synthetic-json-secret" } } } }, null, 2));
  let sequence = 0;
  const record = payload => ({ type: "response_item", timestamp: new Date(Date.UTC(2026, 0, 2, 12, 0, sequence++)).toISOString(), payload });
  const messages = [
    { type: "session_meta", timestamp: "2026-01-02T12:00:00Z", payload: { id: "resource-example", cwd: project, title: "资源管理合成会话" } },
    record({ type: "message", role: "user", content: [{ type: "input_text", text: "验证资源使用统计" }] }),
    record({ type: "function_call", name: "Write", call_id: "write-guide", arguments: JSON.stringify({ file_path: join(guide, "SKILL.md"), content: "人工合成资源" }) }),
    record({ type: "function_call_output", call_id: "write-guide", output: JSON.stringify({ success: true, content: "written" }) }),
    record({ type: "function_call", name: "shell_command", call_id: "read-guide", arguments: JSON.stringify({ command: `cat '${join(guide, "SKILL.md")}'`, workdir: project }) }),
    record({ type: "function_call_output", call_id: "read-guide", output: "Exit code: 0\nOutput:\n# 指南\n人工合成资源\n" }),
    record({ type: "function_call", name: "mcp__sample__lookup", call_id: "mcp-lookup", arguments: "{}" }),
    record({ type: "function_call_output", call_id: "mcp-lookup", output: "Exit code: 0\nOutput:\n查询完成\n" }),
    record({ type: "function_call", name: "mcp__sample__search", call_id: "mcp-search", arguments: "{}" }),
    record({ type: "function_call_output", call_id: "mcp-search", output: "Exit code: 1\nOutput:\n合成失败\n" }),
    record({ type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "合成检查完成" }] }),
  ];
  await appendFile(configPath, `\n[[skills.config]]\npath = ${JSON.stringify(join(guide, "SKILL.md"))}\nenabled = true\n`);
  const source = join(history, "example.jsonl");
  await writeFile(source, messages.map(record => `${JSON.stringify(record)}\n`).join(""));
  return { directory, userHome, project, home, history, source, guide, shared, link, configPath };
}

/** 同名 Skill 的多个真实来源，其中一份历史资源已不在本地。 */
export async function skillRankingFixture(fixture, claudeHistory, secondProject) {
  const codexGuide = join(fixture.project, ".agents", "skills", "guide");
  const claudeGuide = join(secondProject, ".claude", "skills", "guide");
  const retiredGuide = join(fixture.directory, "retired", "guide");
  for (const path of [codexGuide, claudeGuide]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), "---\nname: guide\n---\n另一份人工指南。\n");
  }
  const records = [
    { type: "session_meta", timestamp: "2026-01-05T12:00:00Z", payload: { id: "ranking-codex-example", cwd: fixture.project, title: "同名资源来源合并" } },
    { type: "response_item", timestamp: "2026-01-05T12:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "使用不同路径的同名人工指南" }] } },
  ];
  let sequence = 2;
  for (const [index, path] of [fixture.guide, codexGuide, retiredGuide].entries()) {
    const timestamp = () => new Date(Date.UTC(2026, 0, 5, 12, 0, sequence++)).toISOString();
    records.push({ type: "response_item", timestamp: timestamp(), payload: { type: "function_call", name: "shell_command", call_id: `ranking-read-${index}`, arguments: JSON.stringify({ command: `cat '${join(path, "SKILL.md")}'`, workdir: fixture.project }) } });
    records.push({ type: "response_item", timestamp: timestamp(), payload: { type: "function_call_output", call_id: `ranking-read-${index}`, output: "Exit code: 0\nOutput:\n人工指南内容。\n" } });
  }
  records.push({ type: "response_item", timestamp: "2026-01-05T12:00:10Z", payload: { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "人工指南已使用" }] } });
  const claudeRecords = [
    { type: "user", uuid: "ranking-claude-user", timestamp: "2026-01-06T12:00:00Z", sessionId: "ranking-claude-example", cwd: secondProject, message: { content: [{ type: "text", text: "使用另一份人工指南" }] } },
    { type: "assistant", uuid: "ranking-claude-request", timestamp: "2026-01-06T12:00:01Z", sessionId: "ranking-claude-example", cwd: secondProject, message: { content: [{ type: "tool_use", id: "ranking-claude-read", name: "Read", input: { file_path: join(claudeGuide, "SKILL.md") } }] } },
    { type: "user", uuid: "ranking-claude-result", timestamp: "2026-01-06T12:00:02Z", sourceToolAssistantUUID: "ranking-claude-request", sessionId: "ranking-claude-example", cwd: secondProject, message: { content: [{ type: "tool_result", tool_use_id: "ranking-claude-read", content: "另一份人工指南。\n" }] }, toolUseResult: { type: "text", file: { filePath: join(claudeGuide, "SKILL.md"), content: "另一份人工指南。\n", numLines: 1, startLine: 1, totalLines: 1 } } },
    { type: "assistant", uuid: "ranking-claude-final", timestamp: "2026-01-06T12:00:03Z", sessionId: "ranking-claude-example", cwd: secondProject, message: { content: [{ type: "text", text: "人工指南已使用" }] } },
  ];
  await writeFile(join(fixture.history, "ranking-guide.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
  await writeFile(join(claudeHistory, "ranking-guide.jsonl"), claudeRecords.map(record => JSON.stringify(record)).join("\n") + "\n");
  return { codexGuide, claudeGuide, retiredGuide };
}

/** 同名 MCP 的不同客户端注册与调用，不启动实际服务。 */
export async function mcpOverviewFixture(fixture, claudeHistory, secondProject, count = 105) {
  const claudeConfig = join(fixture.userHome, ".claude.json");
  const config = JSON.parse(await readFile(claudeConfig, "utf8"));
  config.mcpServers.sample = { command: "example-claude-service", env: { TOKEN: "synthetic-mcp-secret" } };
  await writeFile(claudeConfig, JSON.stringify(config, null, 2));
  for (const project of [fixture.project, secondProject]) {
    await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { sample: { url: "https://example.invalid/project-mcp" } } }, null, 2));
  }
  let additions = '\n[mcp_servers.mcp-unused]\ncommand = "example-unused-service"\n[mcp_servers.mcp-new]\ncommand = "example-new-service"\n';
  for (let index = 0; index < count; index++) additions += `\n[mcp_servers.mcp-sample-${String(index).padStart(3, "0")}]\ncommand = "example-service-${index}"\n`;
  await appendFile(fixture.configPath, additions);
  const records = [
    { type: "session_meta", timestamp: "2026-01-08T12:00:00Z", payload: { id: "mcp-codex-example", cwd: fixture.project, title: "MCP 总览人工调用" } },
    { type: "response_item", timestamp: "2026-01-08T12:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "检查人工 MCP 使用" }] } },
  ];
  for (let index = 0; index < 26; index++) {
    const server = index < 25 ? "sample" : "retired-service";
    const tool = index < 20 ? "lookup" : "search";
    const timestamp = second => new Date(Date.UTC(2026, 0, 8, 12, 0, second)).toISOString();
    records.push({ type: "response_item", timestamp: timestamp(index * 2 + 2), payload: { type: "function_call", name: `mcp__${server}__${tool}`, call_id: `mcp-overview-${index}`, arguments: "{}" } });
    records.push({ type: "response_item", timestamp: timestamp(index * 2 + 3), payload: { type: "function_call_output", call_id: `mcp-overview-${index}`, output: `Exit code: ${index === 4 ? 1 : 0}\nOutput:\n人工 MCP 结果。\n` } });
  }
  records.push({ type: "response_item", timestamp: "2026-01-08T12:01:00Z", payload: { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "人工 MCP 调用完成" }] } });
  const claudeRecords = [
    { type: "user", uuid: "mcp-claude-user", timestamp: "2026-01-09T12:00:00Z", sessionId: "mcp-claude-example", cwd: secondProject, message: { content: [{ type: "text", text: "使用人工 MCP" }] } },
  ];
  for (const [index, tool] of ["lookup", "search"].entries()) {
    const timestamp = second => new Date(Date.UTC(2026, 0, 9, 12, 0, second)).toISOString();
    const requestId = `mcp-claude-request-${index}`;
    claudeRecords.push({ type: "assistant", uuid: requestId, timestamp: timestamp(index * 2 + 1), sessionId: "mcp-claude-example", cwd: secondProject,
      message: { content: [{ type: "tool_use", id: `mcp-claude-call-${index}`, name: `mcp__sample__${tool}`, input: {} }] } });
    claudeRecords.push({ type: "user", uuid: `mcp-claude-result-${index}`, sourceToolAssistantUUID: requestId, timestamp: timestamp(index * 2 + 2), sessionId: "mcp-claude-example", cwd: secondProject,
      message: { content: [{ type: "tool_result", tool_use_id: `mcp-claude-call-${index}`, content: "人工 MCP 返回。", is_error: index === 1 }] } });
  }
  claudeRecords.push({ type: "assistant", uuid: "mcp-claude-final", timestamp: "2026-01-09T12:00:06Z", sessionId: "mcp-claude-example", cwd: secondProject,
    message: { content: [{ type: "text", text: "人工 MCP 已使用" }] } });
  await writeFile(join(fixture.history, "mcp-overview.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
  await writeFile(join(claudeHistory, "mcp-overview.jsonl"), claudeRecords.map(record => JSON.stringify(record)).join("\n") + "\n");
  return { claudeConfig };
}
