// 人工构造新版桌面缓存；与真实用户数据无关。
export const desktopFixture = (project) => {
  const timestamp = "2026-01-01T00:00:00Z";
  const usage = { inputTokens: 40, outputTokens: 10, cacheReadInputTokens: 60, cacheCreationInputTokens: 0, totalTokens: 110 };
  const msg = (id, role, extra = {}) => ({ id, role, timestamp, kind: "message", ...extra });
  const call = (id, name, input) => ({ id, type: "function", function: { name, arguments: JSON.stringify(input) } });
  const result = (id, toolCallId, toolName, output) => msg(id, "tool", { toolCallId, content: JSON.stringify(output), extra: { toolName } });
  return [
    msg("desktop-user", "user", { turnId: "turn-one", content: [{ type: "text", text: "验证桌面历史检索" }] }),
    msg("desktop-thinking", "reasoning", { content: "先核对示例文件的内容", extra: { turnId: "turn-one" } }),
    msg("desktop-read-request", "assistant", { toolCalls: [call("desktop-read", "read_file", { path: `${project}/src/entry.ts`, start_line: 1, line_count: 2 })], usage: { ...usage },
      extra: { turnId: "turn-one", backend: { type: "CLAUDE_CODE" }, "claude-code": { lastEntryUuid: "native-read" } } }),
    result("desktop-read-result", "desktop-read", "read_file", { content: "1\texport const healthy = true;\n2\texport const updated = true;\n", line_count: 2 }),
    msg("desktop-edit-request", "assistant", { toolCalls: [call("desktop-edit", "replace_in_file", { path: `${project}/src/entry.ts`, old_string: "export const updated = false;\n", new_string: "export const updated = true;\n" })] }),
    result("desktop-edit-result", "desktop-edit", "replace_in_file", { file_path: `${project}/src/entry.ts`, replaced: true }),
    msg("desktop-skill-request", "assistant", { toolCalls: [call("desktop-skill", "use_skill", { skill_directory: "/synthetic/skills/check-example" })] }),
    result("desktop-skill-result", "desktop-skill", "use_skill", { success: true }),
    msg("desktop-final", "assistant", { messageId: "desktop-final", content: "桌面历史核对完成", usage: { ...usage },
      extra: { turnId: "turn-one", backend: { type: "CLAUDE_CODE" }, "claude-code": { lastEntryUuid: "native-final" } } }),
    { op: "turn_terminal", turnId: "turn-one", outcome: "completed", finishedAt: timestamp, lastMessageId: "desktop-final" },
  ];
};
export const desktopNativeFixture = ["read", "final"].map(kind => ({ type: "assistant", uuid: `native-${kind}`,
  sessionId: "engine-session", message: { id: `native-request-${kind}`, role: "assistant", model: "fixture-desktop-model", content: [{ type: "text", text: "重复的原生正文不单独索引" }] } }));
export const encodeDesktop = rows => rows.map(row => `${JSON.stringify(row)}\n`).join("");
