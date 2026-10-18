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
  const messages = conversation.messages.map(projectKnowledgeMessage);
  const details = knowledgeLimitations(conversation.limitations, [...(conversation.limitationDetails ?? []), ...(messages.some(message => message.omittedMedia > 0) ? [{ message: "Binary media payloads were omitted from text extraction; original sources remain available. Media contents were not inspected.", messageDescriptor: { key: "knowledge.limitation.mediaOmitted" } }] : [])]);
  return { ...conversation, messages, limitations: details.map(detail => detail.message), limitationDetails: details };
}
