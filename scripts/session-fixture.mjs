// 全部为人工消息；真实历史不得写入公开验收样本。
export function sessionFixture(project) {
  const time = "2026-01-01T00:00:00Z";
  const record = (payload, seconds) => ({ type: "response_item", timestamp: `2026-01-01T00:00:${String(seconds).padStart(2, "0")}Z`, payload });
  return {
    codex: [
      { type: "session_meta", timestamp: time, payload: { id: "demo-codex", cwd: project, title: "实现状态检查" } },
      record({ type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /workspace/example\n<INSTRUCTIONS>注入样本标记：遵循合成项目规则</INSTRUCTIONS>" }, { type: "input_text", text: "<environment_context>合成环境</environment_context>" }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ["agents_md.instructions", "environments.environment_context"] } }, 0),
      record({ type: "message", role: "user", content: [{ type: "input_text", text: '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>' }] }, 0),
      { type: "turn_context", payload: { turn_id: "turn-one", model: "fixture-codex" } },
      record({ type: "message", role: "user", content: [{ type: "input_text", text: "给示例服务增加状态检查" }] }, 1),
      record({ type: "message", role: "assistant", channel: "commentary", content: [{ type: "output_text", text: "先读取当前实现" }] }, 2),
      record({ type: "function_call", call_id: "read-entry", name: "shell_command", arguments: JSON.stringify({ command: "cat src/entry.ts", workdir: project }) }, 3),
      record({ type: "function_call_output", call_id: "read-entry", output: "Exit code: 0\nOutput:\nexport const healthy = true;\n局部轨迹标记\n" }, 4),
      record({ type: "function_call", call_id: "mcp-one", name: "mcp__sample__lookup", arguments: "{}" }, 5),
      record({ type: "function_call_output", call_id: "mcp-one", output: "结果已记录" }, 6),
      record({ type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "已完成状态检查并验证" }] }, 7),
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 5 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 5 } } } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 5 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 5 } } } },
    ],
    claude: [
      { type: "user", uuid: "user-one", sessionId: "demo-claude", cwd: project, timestamp: time, message: { role: "user", content: "检查中文搜索能力" } },
      { type: "assistant", uuid: "assistant-one", sessionId: "demo-claude", cwd: project, timestamp: time, message: { id: "model-request", model: "fixture-claude", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "中文搜索已经验证" }], usage: { input_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 20, output_tokens: 10 } } },
    ],
    codeflicker: [
      { type: "message", role: "user", uuid: "cf-user", sessionId: "demo-flicker", cwd: project, timestamp: time, content: "优化示例代码的结构" },
      { type: "message", role: "assistant", uuid: "cf-assistant", sessionId: "demo-flicker", cwd: project, timestamp: time, metadata: { requestTokenBaseline: { requestId: "cf-request" } }, model: "fixture-flicker", content: [{ type: "text", text: "结构已优化" }], usage: { input_tokens: 100, cache_read_input_tokens: 60, output_tokens: 10 } },
    ],
    orphan: [
      { type: "session_meta", timestamp: time, payload: { id: "demo-orphan" } },
      record({ type: "message", role: "user", content: [{ type: "input_text", text: "无项目会话仍然可见" }] }, 1),
    ],
  };
}

export const encodeSession = records => records.map(record => `${JSON.stringify(record)}\n`).join("");

export function longSessionFixture(project) {
  const records = [{ type: "session_meta", payload: { id: "demo-long", cwd: project, title: "长会话工作区验收" } }];
  const total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  for (let turn = 1; turn <= 35; turn++) {
    records.push({ type: "turn_context", payload: { model: "fixture-model" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `轮次 ${turn}：检查示例服务` }] } });
    for (let request = 1; request <= 6; request++) {
      const call = `demo-call-${turn}-${request}`;
      total.input_tokens += turn * 100 + request; total.cached_input_tokens += turn * 60; total.output_tokens += request * 5;
      records.push({ type: "response_item", payload: { type: "function_call", name: "sample_tool", call_id: call, arguments: JSON.stringify({ turn, request }) } },
        { type: "response_item", payload: { type: "function_call_output", call_id: call, output: `Exit code: 0\nOutput:\n过程标记-${turn}-${request}` } },
        { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { ...total }, last_token_usage: { input_tokens: turn * 100 + request, cached_input_tokens: turn * 60, output_tokens: request * 5 } } } });
    }
    records.push({ type: "response_item", payload: { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: `## 轮次 ${turn} 的结果\n\n**检查完成**，保留可验证的记录。\n\n- 第一项\n- 第二项\n\n| 指标 | 值 |\n| --- | --- |\n| 状态 | 正常 |\n\n\`\`\`ts\nexport const value = ${turn};\n\`\`\`\n\n[安全链接](https://example.invalid)\n<script>window.fixtureUnsafe = true</script>\n![图片](https://example.invalid/image.png)` }] } });
  }
  return records;
}
