import type { SessionMessage, SessionMessageResult, SessionTimelineEvent } from "../../../src/session-contracts";
import { ApiError, request } from "../../shared/api";
import { sessionMessageText, sessionParams, sessionResourceName } from "./session-model";

export const EVIDENCE_PAGE_SIZE = 8;

/** 浮层只取当前页的有界原始记录，摘要不推断失败原因。 */
export async function evidencePreviews(events: SessionTimelineEvent[], version: string, signal: AbortSignal): Promise<SessionMessage[]> {
  return Promise.all(events.map(async event => {
    const result = await request<SessionMessageResult>(`/sessions/${encodeURIComponent(event.sessionId)}/messages${sessionParams({ version, mode: "full", branch: "all", messageId: event.id, pageSize: 1, maxTextChars: 320 })}`, { signal });
    signal.throwIfAborted();
    const message = result.messages.find(item => item.id === event.id && item.sessionId === event.sessionId);
    if (result.version !== version || !message) throw new ApiError("VERSION_MISMATCH", "结果版本发生变化，请重试。", { key: "sessions.reading.versionChanged" });
    return message;
  }));
}

export function evidenceSummary(message: SessionMessage): string {
  const subject = message.filePaths?.[0] ?? message.resource?.path ?? (message.resource ? sessionResourceName(message.resource) : undefined);
  return (subject || sessionMessageText(message)).replace(/\s+/g, " ").trim();
}
