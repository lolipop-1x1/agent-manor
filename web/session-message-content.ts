import type { SessionMessage, SessionMessageResult } from "../src/session-contracts";
import { ApiError, request } from "./api";
import { dialogueMarkdown } from "./session-export";
import type { Language } from "../src/i18n";
import { sessionParams } from "./session-model";

/** 完整正文按稳定消息身份读取；不能把预览内容复制成完整回复。 */
export async function completeMessage(message: SessionMessage, version?: string, signal?: AbortSignal): Promise<SessionMessage> {
  if (!message.textTruncated) return message;
  const result = await request<SessionMessageResult>(`/sessions/${encodeURIComponent(message.sessionId)}/messages${sessionParams({ version, mode: "full", branch: "all", messageId: message.id, pageSize: 1 })}`, { signal });
  const complete = result.messages.find(item => item.id === message.id);
  if (result.version !== version || !complete) throw new ApiError("VERSION_MISMATCH", "结果版本发生变化，请重试。", { key: "sessions.reading.versionChanged" });
  return complete;
}

/** 轮次复制沿用当前视图与分支；整页额外包含的上下文不能混进该轮。 */
export async function completeTurnMarkdown(sessionId: string, turnId: string, position: number | undefined,
  query: { version?: string; mode?: "brief" | "full" | "trace"; branch?: string }, language: Language): Promise<string> {
  const result = await request<SessionMessageResult>(`/sessions/${encodeURIComponent(sessionId)}/messages${sessionParams({ ...query, pageUnit: "turn", pageSize: 1, turnPosition: position })}`);
  if (result.version !== query.version) throw new ApiError("VERSION_MISMATCH", "结果版本发生变化，请重试。", { key: "sessions.reading.versionChanged" });
  return dialogueMarkdown(result.messages.filter(message => message.turnId === turnId), language);
}
