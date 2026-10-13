import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startService } from "../dist/server.js";
import { clientIds } from "../dist/clients.js";

// 官网素材只使用此处生成的项目、历史和资源；每个发现入口均显式隔离。
export async function sitePreviewFixture() {
  const directory = await realpath(await mkdtemp("/tmp/agent-manor-preview-"));
  const run = promisify(execFile);
  const home = join(directory, "data"), userHome = join(directory, "example-user");
  const project = join(directory, "workspace", "atlas-workspace");
  const codexHistory = join(directory, "history", "codex"), claudeHistory = join(directory, "history", "claude");
  for (const path of [home, userHome, project, codexHistory, claudeHistory]) await mkdir(path, { recursive: true });
  let service;
  try {
    const skillNames = ["architecture-review", "test-first", "interface-design", "release-checklist", "code-review", "documentation", "accessibility", "performance-audit"];
    for (const [index, name] of skillNames.entries()) {
      const folder = join(userHome, index % 3 ? ".codex" : ".claude", "skills", name);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: Example workflow for ${name.replaceAll("-", " ")}\n---\n# ${name}\nSynthetic project workflow for the public product preview.\n`);
    }
    await writeFile(join(userHome, ".codex", "config.toml"), ["project-docs", "design-library", "test-runner", "repository-tools"].map(name => `\n[mcp_servers.${name}]\ncommand = "example-service"\nargs = ["${name}"]\n`).join(""));
    await writeFile(join(userHome, ".claude.json"), JSON.stringify({ mcpServers: { "project-docs": { url: "https://example.invalid/mcp" }, "design-library": { command: "example-service" } } }));

    const sources = [
      ["src/api/projects.ts", 142], ["src/api/sessions.ts", 180], ["src/api/search.ts", 110], ["src/api/resources.ts", 135],
      ["src/domain/workspace.ts", 205], ["src/domain/session.ts", 154], ["src/domain/resource.ts", 94], ["src/domain/activity.ts", 128],
      ["src/search/index.ts", 195], ["src/search/ranking.ts", 122], ["src/search/query.ts", 87],
      ["web/pages/Overview.tsx", 220], ["web/pages/Sessions.tsx", 252], ["web/pages/Resources.tsx", 182],
      ["web/components/Navigation.tsx", 75], ["web/components/Search.tsx", 104], ["web/components/Dialog.tsx", 88],
      ["web/theme.ts", 90], ["web/format.ts", 72], ["tests/search.test.ts", 120], ["tests/sessions.test.ts", 150],
      ["scripts/verify.ts", 56], ["README.md", 44], ["package.json", 18],
    ];
    const contents = new Map();
    for (const [index, [path, lines]] of sources.entries()) {
      const content = Array.from({ length: lines }, (_, line) => path.endsWith(".md") ? `Example workspace documentation, section ${line + 1}.` : `export const example${index}Value${line + 1} = ${line + 1};`).join("\n") + "\n";
      contents.set(path, content);
      await mkdir(dirname(join(project, path)), { recursive: true });
      await writeFile(join(project, path), content);
    }
    await run("git", ["init", "-q", project]);
    await run("git", ["-C", project, "add", "."]);
    await run("git", ["-C", project, "-c", "user.name=Example Developer", "-c", "user.email=developer@example.invalid", "commit", "-qm", "Create synthetic preview workspace"]);

    const tasks = ["Build the workspace overview", "Improve conversation search", "Review the resource inventory", "Add keyboard navigation", "Refine the activity timeline", "Test the project API", "Document the release workflow"];
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    for (let day = 1; day <= 14; day++) {
      for (let index = 0; index < 3; index++) {
        const id = `example-session-${day}-${index}`;
        const start = new Date(midnight); start.setDate(start.getDate() - day); start.setHours(9 + index * 3, 10 + day, 0, 0);
        const timestamp = seconds => new Date(start.getTime() + seconds * 1000).toISOString();
        const title = tasks[(day + index) % tasks.length];
        if (index === 2) {
          const records = [];
          for (let turn = 0; turn < 3; turn++) {
            records.push({ type: "user", uuid: `${id}-u-${turn}`, sessionId: id, cwd: project, timestamp: timestamp(turn * 160), message: { role: "user", content: `${title}. Please inspect the implementation and describe the next focused improvement.` } });
            records.push({ type: "assistant", uuid: `${id}-a-${turn}`, sessionId: id, cwd: project, timestamp: timestamp(turn * 160 + 38), message: {
              id: `${id}-request-${turn}`, model: "claude-sonnet-4", role: "assistant", stop_reason: "end_turn",
              content: [{ type: "text", text: "## Review complete\n\nThe workspace now keeps the selected project and search query together.\n\n- Checked the query and sorting behavior.\n- Verified keyboard access to the results.\n- Kept the resource scope explicit.\n\nThe example test cases pass." }],
              usage: { input_tokens: 4500 + day * 500, cache_read_input_tokens: 9000 + day * 700, cache_creation_input_tokens: 1200, output_tokens: 680 + turn * 160 },
            } });
          }
          await writeFile(join(claudeHistory, `${id}.jsonl`), records.map(record => JSON.stringify(record)).join("\n") + "\n");
          continue;
        }
        const record = (payload, seconds) => ({ type: "response_item", timestamp: timestamp(seconds), payload });
        const records = [{ type: "session_meta", timestamp: timestamp(0), payload: { id, cwd: project, title } }];
        const total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
        const turnCount = 3 + day % 3;
        for (let turn = 0; turn < turnCount; turn++) {
          const offset = turn * 180;
          records.push({ type: "turn_context", timestamp: timestamp(offset), payload: { turn_id: `${id}-turn-${turn}`, model: "gpt-5", reasoning_effort: index ? "medium" : "high" } });
          records.push(record({ type: "message", role: "user", content: [{ type: "input_text", text: `${title}. ${turn ? "Check the next part and keep existing behavior intact." : "Start with the existing structure, then improve the implementation and verify the result."}` }] }, offset + 1));
          records.push(record({ type: "message", role: "assistant", channel: "commentary", content: [{ type: "output_text", text: "I will inspect the relevant files and follow the existing project conventions." }] }, offset + 4));
          const fileIndex = (day * 3 + index + turn) % (sources.length - 2);
          const [path, lines] = sources[fileIndex];
          const readLines = Math.max(1, Math.floor(lines * [.2, .4, .65, 1][(day + turn) % 4]));
          const callId = `${id}-read-${turn}`;
          records.push(record({ type: "function_call", name: "shell_command", call_id: callId, arguments: JSON.stringify({ command: `sed -n '1,${readLines}p' ${path}`, workdir: project }) }, offset + 7));
          records.push(record({ type: "function_call_output", call_id: callId, output: "Exit code: 0\nOutput:\n" + contents.get(path).split("\n").slice(0, readLines).join("\n") + "\n" }, offset + 9));
          const skill = skillNames[(day + turn) % skillNames.length];
          records.push(record({ type: "function_call", name: "Skill", call_id: `${id}-skill-${turn}`, arguments: JSON.stringify({ skill }) }, offset + 11));
          records.push(record({ type: "function_call_output", call_id: `${id}-skill-${turn}`, output: "Example workflow loaded." }, offset + 12));
          const server = ["project-docs", "design-library", "test-runner", "repository-tools"][(day + turn) % 4];
          records.push(record({ type: "function_call", name: `mcp__${server}__lookup`, call_id: `${id}-mcp-${turn}`, arguments: JSON.stringify({ query: "workspace patterns" }) }, offset + 16));
          records.push(record({ type: "function_call_output", call_id: `${id}-mcp-${turn}`, output: "Example reference found." }, offset + 17));
          records.push(record({ type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "## Implementation reviewed\n\nThe current flow is consistent with the workspace model.\n\n- Verified the selected project and query state.\n- Checked empty results and keyboard navigation.\n- Preserved the existing resource scope.\n\nThe example checks pass." }] }, offset + 58 + day));
          const usage = { input_tokens: 18500 + day * 700 + turn * 1200, cached_input_tokens: 12500 + day * 400, output_tokens: 1200 + turn * 220, reasoning_output_tokens: 300 + turn * 45 };
          for (const key of Object.keys(total)) total[key] += usage[key];
          records.push({ type: "event_msg", timestamp: timestamp(offset + 60 + day), payload: { type: "token_count", info: { total_token_usage: { ...total }, last_token_usage: usage } } });
          records.push({ type: "event_msg", timestamp: timestamp(offset + 61 + day), payload: { type: "task_complete", turn_id: `${id}-turn-${turn}` } });
        }
        await writeFile(join(codexHistory, `${id}.jsonl`), records.map(record => JSON.stringify(record)).join("\n") + "\n");
      }
    }
    service = await startService({
      home, roots: { ...Object.fromEntries(clientIds.map(client => [client, []])), codex: codexHistory, claude: claudeHistory },
      resourceInventory: { userHome, environment: {} }, startupRefresh: true,
      staticRoot: fileURLToPath(new URL("../dist/web", import.meta.url)),
      usagePricing: { fetch: async () => Response.json({ example: { models: {
        "gpt-5": { cost: { input: 1.25, output: 10, cache_read: .125 } },
        "claude-sonnet-4": { cost: { input: 3, output: 15, cache_read: .3, cache_write: 3.75 } },
      } } }) },
    });
    const base = `http://127.0.0.1:${service.instance.port}`;
    const api = async (path, method = "GET", body) => {
      const response = await fetch(`${base}/api/v1${path}`, { method, headers: { "x-agent-manor-instance": service.instance.id, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
    };
    await api("/preferences", "PUT", { language: "zh-CN", appearance: { mode: "light", preset: "blue" } });
    const registration = await api("/repositories", "POST", { path: project });
    const waitFor = async (read, ready, label) => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const value = await read();
        if (value.job?.status === "failed") throw new Error(`${label}: ${JSON.stringify(value)}`);
        if (ready(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`${label} timed out`);
    };
    await waitFor(() => api(`/jobs/${registration.job.id}`), value => value.job.status === "completed", "repository analysis");
    await waitFor(() => api("/sessions/status"), value => value.version && value.job?.status !== "running", "session indexing");
    await api("/resources/refresh", "POST", {});
    await api("/usage/pricing/refresh", "POST", {});
    return { directory, project, base, api, close: async () => { await service.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) {
    await service?.close(); await rm(directory, { recursive: true, force: true }); throw error;
  }
}
