import type { KnowledgeLimitation } from "../knowledge-contracts.js";

/** 原文与来源提供的消息标识一起保留，不根据已有句子猜测其含义。 */
export function knowledgeLimitations(messages: readonly string[], details: readonly KnowledgeLimitation[] = []): KnowledgeLimitation[] {
  const result = [...new Map(details.map(detail => [JSON.stringify(detail), detail])).values()];
  const originals = new Set(result.map(detail => detail.message));
  for (const message of messages) if (!originals.has(message)) { result.push({ message }); originals.add(message); }
  if (result.length <= 64) return result;
  return [...result.slice(0, 63), { message: `${result.length - 63} additional source limitations were omitted from this bounded record.`, messageDescriptor: { key: "knowledge.limitation.additional", params: { count: result.length - 63 } } }];
}
