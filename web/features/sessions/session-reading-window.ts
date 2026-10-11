import type { SessionMessageResult } from "../../../src/session-contracts";

export type ReadingDirection = "earlier" | "later";
export const READING_SEGMENT_LIMIT = 300;
export const READING_WINDOW_SEGMENTS = 4;

export function readingNeighbor(segment: SessionMessageResult, direction: ReadingDirection): { page: number; offset: number | "last" } | undefined {
  const offset = segment.messageOffset ?? 0;
  if (direction === "earlier") {
    if (offset > 0) return { page: segment.page, offset: Math.max(0, offset - READING_SEGMENT_LIMIT) };
    if (segment.page > 1) return { page: segment.page - 1, offset: "last" };
  } else {
    if (segment.hasMoreMessages) return { page: segment.page, offset: offset + segment.messages.length };
    if (segment.page * segment.pageSize < (segment.totalTurns ?? 0)) return { page: segment.page + 1, offset: 0 };
  }
  return undefined;
}

export function appendReadingSegment(segments: SessionMessageResult[], incoming: SessionMessageResult, direction: ReadingDirection): SessionMessageResult[] {
  const combined = direction === "earlier" ? [incoming, ...segments] : [...segments, incoming];
  return direction === "earlier" ? combined.slice(0, READING_WINDOW_SEGMENTS) : combined.slice(-READING_WINDOW_SEGMENTS);
}

export function mergeReadingSegments(segments: SessionMessageResult[]): SessionMessageResult {
  const first = segments[0]!;
  const last = segments.at(-1)!;
  const unique = <T extends { id: string }>(items: T[]) => [...new Map(items.map(item => [item.id, item])).values()];
  const messages = unique(segments.flatMap(segment => segment.messages));
  const messageIds = new Set(messages.map(message => message.id));
  const pairs = segments.flatMap(segment => segment.toolPairs ?? []);
  return { ...first, messages,
    turns: unique(segments.flatMap(segment => segment.turns ?? [])),
    toolPairs: segments.some(segment => segment.toolPairs !== undefined)
      ? [...new Map(pairs.map(pair => [`${pair.callMessageId}\0${pair.resultMessageId}`, pair])).values()] : undefined,
    relatedMessages: unique(segments.flatMap(segment => segment.relatedMessages ?? [])).filter(message => !messageIds.has(message.id)),
    usages: unique(segments.flatMap(segment => segment.usages ?? [])), hasMoreMessages: last.hasMoreMessages };
}
