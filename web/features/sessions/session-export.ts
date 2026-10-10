import type { SessionMessage, SessionMessageResult } from "../../../src/session-contracts";
import { translate, type Language } from "../../../src/i18n";

export function dialogueMarkdown(messages: SessionMessage[], language: Language): string {
  const lastReplies = new Map<string, SessionMessage>();
  const finished = new Set(messages.filter(message => message.kind === "assistant" && message.final).map(message => message.turnId));
  for (const message of messages) if (message.kind === "assistant" && message.text.trim()) lastReplies.set(message.turnId, message);
  const dialogue = messages.map(message => message.kind === "assistant" && !finished.has(message.turnId) && lastReplies.get(message.turnId)?.id === message.id ? { ...message, unconfirmed: true } : message);
  return dialogue.filter(message => message.kind === "user" || message.kind === "assistant" && (message.final || message.unconfirmed))
    .map(message => `### ${translate(language, message.kind === "user" ? "sessions.kind.user" : "sessions.message.aiReply")}${message.unconfirmed ? ` · ${translate(language, "sessions.message.unconfirmed")}` : ""}\n\n${message.text}`)
    .join("\n\n");
}

/** 固定索引和分支，读齐后才交给下载入口；失败时没有半份文件。 */
export async function collectDialogue(load: (page: number) => Promise<SessionMessageResult>, version: string): Promise<SessionMessage[]> {
  const first = await load(1);
  if (first.version !== version || first.page !== 1) throw new Error("EXPORT_SNAPSHOT_CHANGED");
  const messages = [...first.messages];
  const pages = Math.ceil(first.total / first.pageSize);
  for (let page = 2; page <= pages; page++) {
    const result = await load(page);
    if (result.version !== version || result.session.id !== first.session.id || result.total !== first.total || result.page !== page || result.pageSize !== first.pageSize) throw new Error("EXPORT_SNAPSHOT_CHANGED");
    messages.push(...result.messages);
  }
  if (messages.length !== first.total || new Set(messages.map(message => message.id)).size !== first.total) throw new Error("EXPORT_INCOMPLETE");
  return messages;
}
