import { mkdir, symlink, writeFile } from "node:fs/promises";
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
    record({ type: "function_call", name: "shell_command", call_id: "read-guide", arguments: JSON.stringify({ command: `cat '${join(guide, "SKILL.md")}'`, workdir: project }) }),
    record({ type: "function_call_output", call_id: "read-guide", output: "Exit code: 0\nOutput:\n# 指南\n人工合成资源\n" }),
    record({ type: "function_call", name: "mcp__sample__lookup", call_id: "mcp-lookup", arguments: "{}" }),
    record({ type: "function_call_output", call_id: "mcp-lookup", output: "Exit code: 0\nOutput:\n查询完成\n" }),
    record({ type: "function_call", name: "mcp__sample__search", call_id: "mcp-search", arguments: "{}" }),
    record({ type: "function_call_output", call_id: "mcp-search", output: "Exit code: 1\nOutput:\n合成失败\n" }),
    record({ type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "合成检查完成" }] }),
  ];
  const source = join(history, "example.jsonl");
  await writeFile(source, messages.map(record => `${JSON.stringify(record)}\n`).join(""));
  return { directory, userHome, project, home, history, source, guide, shared, link, configPath };
}
