import { createHash } from "node:crypto";
import type { KnowledgeConversation, KnowledgeInputMessage } from "../knowledge-contracts.js";
import { knowledgeLimitations } from "./diagnostics.js";

const mediaTypes = new Set(["image", "input_image", "image_url", "audio", "input_audio", "file", "input_file"]);

/** 只生成抽取用的文本视图，原始正文与内容哈希始终保留在会话库。 */
export function projectKnowledgeMessage(message: KnowledgeInputMessage): KnowledgeInputMessage & { omittedMedia: number } {
  let omittedMedia = message.omittedMedia ?? 0;
  const scrub = (text: string): string => text.replace(/data:((?:image|audio|video)\/[a-z0-9.+-]+|application\/(?:octet-stream|pdf|zip))(?:;[^,\s"'<>]*)?;base64,[a-z0-9+/_=-]+/gi, (_value, mime: string) => {
    omittedMedia++; return `[${mime} payload omitted; source retained]`;
  });
  let text = message.text;
  // 已序列化的工具内容块需要按结构展开；普通业务 JSON、代码及用户示例保持原文。
  if (message.kind === "tool_result" && /^[\[{]/.test(text.trimStart())) {
    try {
      const payloadKeys = new Set(["data", "image_url", "audio_url", "file_data", "input_audio", "source"]);
      const removeMedia = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(removeMedia);
        if (!value || typeof value !== "object") return value;
        const object = value as Record<string, unknown>;
        if (mediaTypes.has(object.type as string) && [...payloadKeys].some(key => object[key] !== undefined)) {
          omittedMedia++;
          return { ...Object.fromEntries(Object.entries(object).filter(([key]) => !payloadKeys.has(key))), note: `[${typeof object.mimeType === "string" ? object.mimeType : object.type} content omitted; source retained; contents not inspected]` };
        }
        return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, removeMedia(item)]));
      };
      const before = omittedMedia, value = removeMedia(JSON.parse(text));
      if (Array.isArray(value) && value.length && value.every(item => item && typeof item === "object" && typeof item.type === "string")) {
        text = value.map((item: Record<string, unknown>) => {
          if (mediaTypes.has(item.type as string)) {
            return typeof item.note === "string" ? item.note : JSON.stringify(item);
          }
          return ["text", "input_text", "output_text"].includes(item.type as string) && typeof item.text === "string" ? item.text : JSON.stringify(item);
        }).join("\n");
      } else if (omittedMedia !== before) text = JSON.stringify(value);
    } catch { /* 无法识别的正文保持原文，仅移除明确的 data URL 载荷。 */ }
  }
  return { ...message, text: scrub(text), omittedMedia };
}

export function projectKnowledgeConversation(conversation: KnowledgeConversation): KnowledgeConversation {
  const messages = knowledgeInputViews(conversation.messages.map(projectKnowledgeMessage));
  const details = knowledgeLimitations(conversation.limitations, [...(conversation.limitationDetails ?? []), ...(messages.some(message => message.inputView?.omitted) ? [{ message: "Long tool records and repeated instructions use bounded text views. Omitted bodies remain available for limited rereading; summaries do not prove execution outcomes.", messageDescriptor: { key: "knowledge.limitation.inputSummarized" } }] : []), ...(messages.some(message => (message.omittedMedia ?? 0) > 0) ? [{ message: "Binary media payloads were omitted from text extraction; original sources remain available. Media contents were not inspected.", messageDescriptor: { key: "knowledge.limitation.mediaOmitted" } }] : [])]);
  return { ...conversation, messages, limitations: details.map(detail => detail.message), limitationDetails: details };
}

export interface KnowledgeInputView {
  omitted: boolean;
  reason: "tool_summary" | "instruction_summary" | "duplicate";
  originalChars: number;
  retainedChars: number;
}
export type ProjectedKnowledgeMessage = KnowledgeInputMessage & { inputView?: KnowledgeInputView };
const outcomeLine = /\b(?:error|fail(?:ed|ure)?|exception|assert|denied|exit\s*(?:code|status)|tests?\s*(?:passed|failed)|pass(?:ed)?|not\s+verified|verification)\b|错误|失败|异常|测试|验证|未验证|通过|纠正|根因/iu;

/** 摘录只用于定位证据，不能把省略的正文当作已经阅读或验证。 */
export function boundedKnowledgeText(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  const edge = Math.min(512, Math.floor(maximum / 4));
  const excerpts: string[] = [];
  let offset = 0, remaining = maximum - edge * 2 - 180;
  for (const line of text.split(/\n/)) {
    if (remaining <= 80 || excerpts.length >= 6) break;
    if (outcomeLine.test(line)) {
      const excerpt = line.slice(0, Math.min(remaining - 40, 420));
      excerpts.push(`[offset ${offset}] ${excerpt}`); remaining -= excerpt.length + 40;
    }
    offset += line.length + 1;
  }
  return `${text.slice(0, edge)}\n[body omitted; ${text.length} chars; excerpts are navigation, not full evidence]\n${excerpts.join("\n")}\n[tail offset ${text.length - edge}] ${text.slice(-edge)}`;
}

export function knowledgeInputViews(messages: KnowledgeInputMessage[]): ProjectedKnowledgeMessage[] {
  const seen = new Map<string, string>();
  return messages.map(message => {
    // 连续用户与助手正文保持完整，不能按消息截断来节省输入。
    if (["user", "assistant", "compression"].includes(message.kind)) return message;
    const maximum = message.kind === "tool_result" ? 2048 : 1024;
    const signature = `${message.kind}:${message.tool ?? ""}:${message.status ?? ""}:${createHash("sha256").update(message.text).digest("hex")}`;
    const prior = seen.get(signature); seen.set(signature, message.id);
    let text = prior ? `[duplicate body omitted; same content as message ${prior}]` : boundedKnowledgeText(message.text, maximum);
    if (text === message.text) return message;
    const reason = prior ? "duplicate" : ["tool_call", "tool_result"].includes(message.kind) ? "tool_summary" : "instruction_summary";
    // 身份、原始哈希和状态来自原记录，摘要不改写来源事实。
    return { ...message, text, inputView: { omitted: true, reason, originalChars: message.text.length, retainedChars: text.length } };
  });
}
