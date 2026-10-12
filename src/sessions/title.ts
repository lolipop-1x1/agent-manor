import type { SessionSummary } from "../session-contracts.js";

/** 正式标题与首条有效请求优先，缺失时使用明确记录的子任务身份。 */
export function sessionTitle<T extends SessionSummary>(summary: T): T {
  if (summary.relationship !== "child" || summary.titleOrigin === "recorded" || summary.titleOrigin === "first_user") return summary;
  if (summary.taskName) return { ...summary, title: summary.taskName, titleOrigin: "task" };
  if (summary.agentName) return { ...summary, title: summary.agentName, titleOrigin: "agent" };
  return { ...summary, title: `子会话 ${summary.clientSessionId.slice(-8)}`, titleOrigin: "fallback" };
}

/** 只清理标题候选中的完整注入包，消息正文与轮次保持原样。 */
export function userTitle(body: string): string {
  let value = body.trim();
  const request = /(?:^|\n)## My request:\s*\n/.exec(value);
  if (request && /(?:^|\n)<in-app-browser-context\b/.test(value.slice(0, request.index))) value = value.slice(request.index + request[0].length).trim();
  while (value) {
    const tag = value.startsWith("# AGENTS.md") ? "INSTRUCTIONS"
      : /^<(INSTRUCTIONS|environment_context|in-app-browser-context|skill|recommended_plugins|turn_aborted)(?:\s[^>]*)?>/.exec(value)?.[1];
    if (!tag) break;
    const end = value.indexOf(`</${tag}>`);
    if (end < 0) break;
    value = value.slice(end + tag.length + 3).trim();
  }
  return value.replace(/\s+/g, " ").slice(0, 120);
}
