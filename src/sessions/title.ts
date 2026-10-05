import type { SessionSummary } from "../session-contracts.js";

/** 正式标题与首条有效请求优先，缺失时使用明确记录的子任务身份。 */
export function sessionTitle<T extends SessionSummary>(summary: T): T {
  if (summary.relationship !== "child" || summary.titleOrigin === "recorded" || summary.titleOrigin === "first_user") return summary;
  if (summary.taskName) return { ...summary, title: summary.taskName, titleOrigin: "task" };
  if (summary.agentName) return { ...summary, title: summary.agentName, titleOrigin: "agent" };
  return { ...summary, title: `子会话 ${summary.clientSessionId.slice(-8)}`, titleOrigin: "fallback" };
}
