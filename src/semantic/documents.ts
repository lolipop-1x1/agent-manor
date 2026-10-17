import { estimateTokens } from "./tokens.js";
import { createHash } from "node:crypto";
import type { SessionMessage, SessionSourceMeta } from "../session-contracts.js";
import type { SemanticConfig } from "../semantic-contracts.js";

export interface SemanticDocument {
  key: string;
  text: string;
  estimatedTokens: number;
  messageId: string;
  turnId: string;
  kind: "user" | "assistant";
  branchId?: string;
  currentBranch?: boolean;
  start: number;
  end: number;
  snippet: string;
  anchors: { messageId: string; turnId: string; kind: "user" | "assistant"; inputStart: number; inputEnd: number; sourceStart: number; sourceEnd: number; sourceHash: string }[];
}


export function isSemanticTurnKnown(turnId: string): boolean {
  return Boolean(turnId && !/(?:^|:)turn:0$/.test(turnId) && turnId !== "unknown");
}

export function sourceMessageHash(message: Pick<SessionMessage, "kind" | "text" | "contextSource">): string {
  return createHash("sha256").update(JSON.stringify([message.kind, message.text, message.contextSource ?? null])).digest("hex");
}

export function contentKey(fingerprint: string, text: string): string {
  return createHash("sha256").update(JSON.stringify([fingerprint, "document", text])).digest("hex");
}

interface Span { message: SessionMessage; start: number; end: number }

/** 保留原始空白及代码内容，只在段落或行边界附近选择切块位置。 */
function* chunks(text: string, maximum: number, overlap: number): Generator<{ text: string; start: number; end: number }> {
  const characters = Array.from(text);
  let start = 0;
  while (start < characters.length) {
    let end = Math.min(characters.length, start + maximum);
    if (end < characters.length) {
      const half = start + Math.floor(maximum / 2);
      for (let cursor = end - 1; cursor > half; cursor--) {
        if (characters[cursor] === "\n") { end = cursor + 1; break; }
      }
    }
    yield { text: characters.slice(start, end).join(""), start, end };
    if (end === characters.length) break;
    start = Math.max(start + 1, end - overlap);
  }
}

/** 每个叶分支独立组织真实轮次；未知轮次不拼接，副本保留定位并通过输入摘要复用。 */
export function* buildDocuments(messages: SessionMessage[], session: SessionSourceMeta, config: SemanticConfig, fingerprint: string): Generator<SemanticDocument> {
  const eligible = messages.filter(message => (message.kind === "user" || message.kind === "assistant")
    && !message.contextSource && message.text.trim().length > 0);
  const branchIds = [...new Set([...(session.branches?.map(branch => branch.id) ?? []), ...eligible.flatMap(message => message.branchIds ?? [])])];
  const current = session.branches?.find(branch => branch.current)?.id;
  const branches: (string | undefined)[] = branchIds.length ? config.scope.branch === "current" && current ? [current] : branchIds : [undefined];
  const maximum = Math.max(100, Math.floor(config.strategy.chunkChars));
  const overlap = Math.max(0, Math.min(maximum - 1, Math.floor(config.strategy.overlapChars)));
  const emitted = new Set<string>();
  for (const branchId of branches) {
    const selected = eligible.filter(message => (!branchId || !message.branchIds?.length || message.branchIds.includes(branchId))
      && (config.scope.branch !== "current" || current !== undefined || message.currentBranch !== false));
    let turn: SessionMessage[] = [];
    const groups: SessionMessage[][] = [];
    for (const message of selected) {
      const known = isSemanticTurnKnown(message.turnId);
      if (!known) {
        if (turn.length) groups.push(turn);
        turn = []; groups.push([message]);
      } else if (turn.length && (turn[0]!.turnId !== message.turnId || (turn[0]!.currentBranch === false) !== (message.currentBranch === false))) {
        groups.push(turn); turn = [message];
      } else turn.push(message);
    }
    if (turn.length) groups.push(turn);
    for (const group of groups) {
      let body = "";
      let length = 0;
      const spans: Span[] = [];
      for (const message of group) {
        const separator = `${body ? "\n\n" : ""}${message.kind === "user" ? "User" : "Assistant"}:\n`;
        body += separator; length += Array.from(separator).length;
        const start = length;
        body += message.text; length += Array.from(message.text).length;
        spans.push({ message, start, end: length });
      }
      for (const chunk of chunks(body, maximum, overlap)) {
        const span = spans.find(item => item.end > chunk.start && item.start < chunk.end);
        if (!span) continue;
        const text = config.connection.documentPrefix + chunk.text;
        const start = Math.max(0, chunk.start - span.start);
        const end = Math.max(start, Math.min(span.end, chunk.end) - span.start);
        const unique = JSON.stringify([branchId, span.message.id, start, end, text]);
        if (emitted.has(unique)) continue;
        emitted.add(unique);
        const snippet = spans.filter(item => item.end > chunk.start && item.start < chunk.end).map(item =>
          Array.from(item.message.text).slice(Math.max(0, chunk.start - item.start), Math.min(item.end, chunk.end) - item.start).join("")).join("\n\n");
        const prefixLength = Array.from(config.connection.documentPrefix).length;
        const anchors: SemanticDocument["anchors"] = spans.filter(item => item.end > chunk.start && item.start < chunk.end).map(item => ({
          messageId: item.message.id, turnId: item.message.turnId, kind: item.message.kind as "user" | "assistant",
          inputStart: prefixLength + Math.max(0, item.start - chunk.start), inputEnd: prefixLength + Math.min(item.end, chunk.end) - chunk.start,
          sourceStart: Math.max(0, chunk.start - item.start), sourceEnd: Math.min(item.end, chunk.end) - item.start, sourceHash: sourceMessageHash(item.message),
        }));
        yield { key: contentKey(fingerprint, text), text, estimatedTokens: estimateTokens(text), messageId: span.message.id,
          turnId: span.message.turnId, kind: span.message.kind as "user" | "assistant", branchId, currentBranch: spans.filter(item => item.end > chunk.start && item.start < chunk.end).every(item => item.message.currentBranch !== false), start, end,
          snippet: Array.from(snippet).slice(0, 480).join("") + (Array.from(snippet).length > 480 ? "…" : ""), anchors };
      }
    }
  }
}

/** 仅对失败输入缩小计划，不改写来源正文；切片后的每个部分保留对应消息偏移。 */
export function splitDocument(document: SemanticDocument, config: SemanticConfig, fingerprint: string): SemanticDocument[] {
  const prefix = config.connection.documentPrefix, prefixLength = Array.from(prefix).length;
  if (!document.text.startsWith(prefix)) return [];
  const body = Array.from(document.text.slice(prefix.length));
  if (body.length < 128) return [];
  const middle = Math.ceil(body.length / 2), overlap = Math.min(config.strategy.overlapChars, Math.floor(body.length / 8));
  const inputs = Array.from(document.text);
  const results: SemanticDocument[] = [];
  for (const [left, right] of [[0, Math.min(body.length, middle + Math.floor(overlap / 2))], [Math.max(0, middle - Math.ceil(overlap / 2)), body.length]] as const) {
    const from = prefixLength + left, to = prefixLength + right;
    const anchors = document.anchors.filter(anchor => anchor.inputEnd > from && anchor.inputStart < to).map(anchor => {
      const start = Math.max(anchor.inputStart, from), end = Math.min(anchor.inputEnd, to);
      return { ...anchor, inputStart: prefixLength + start - from, inputEnd: prefixLength + end - from,
        sourceStart: anchor.sourceStart + start - anchor.inputStart, sourceEnd: anchor.sourceStart + end - anchor.inputStart };
    });
    if (!anchors.length) continue;
    const text = prefix + body.slice(left, right).join("");
    const first = anchors[0]!;
    const snippet = document.anchors.filter(anchor => anchor.inputEnd > from && anchor.inputStart < to)
      .map(anchor => inputs.slice(Math.max(anchor.inputStart, from), Math.min(anchor.inputEnd, to)).join("")).join("\n\n");
    results.push({ ...document, key: contentKey(fingerprint, text), text, estimatedTokens: estimateTokens(text), messageId: first.messageId,
      turnId: first.turnId, kind: first.kind, start: first.sourceStart, end: first.sourceEnd,
      snippet: Array.from(snippet).slice(0, 480).join("") + (Array.from(snippet).length > 480 ? "…" : ""), anchors });
  }
  return results;
}
