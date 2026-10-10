import assert from "node:assert/strict";
import test from "node:test";
import type { SessionMessageResult } from "../src/session-contracts";
import { appendReadingSegment, mergeReadingSegments, readingNeighbor } from "../web/features/sessions/session-reading-window";

const segment = (page: number, offset = 0, count = 300, more = false): SessionMessageResult => ({
  version: "synthetic-version", session: { id: "synthetic-session" } as SessionMessageResult["session"],
  page, pageSize: 10, totalTurns: 21, total: 2100, messageOffset: offset, hasMoreMessages: more,
  messages: Array.from({ length: count }, (_, index) => ({ id: `${page}-${offset + index}`, turnId: `turn-${page}` } as SessionMessageResult["messages"][number])),
  turns: [{ id: `turn-${page}`, position: page * 10 - 9, messageCount: 650 }],
});

test("末页一轮仍可读取上一页的末分段，并从页内分段连续向前", () => {
  assert.deepEqual(readingNeighbor(segment(3, 0, 2), "earlier"), { page: 2, offset: "last" });
  assert.deepEqual(readingNeighbor(segment(2, 600, 50), "earlier"), { page: 2, offset: 300 });
  assert.deepEqual(readingNeighbor(segment(2, 300, 300, true), "later"), { page: 2, offset: 600 });
  assert.deepEqual(readingNeighbor(segment(2, 600, 50), "later"), { page: 3, offset: 0 });
  assert.equal(readingNeighbor(segment(1), "earlier"), undefined);
  assert.equal(readingNeighbor(segment(3, 0, 2), "later"), undefined);
});

test("同轮跨分段合并不重复，保留所有记录", () => {
  const result = mergeReadingSegments([segment(1, 0, 300, true), segment(1, 300, 300, true), segment(1, 600, 50)]);
  assert.equal(result.messages.length, 650);
  assert.equal(new Set(result.messages.map(message => message.id)).size, 650);
  assert.equal(result.turns?.length, 1);
  assert.equal(result.hasMoreMessages, false);
});

test("驻留裁剪后仍可向被裁掉的一侧重新读取", () => {
  const original = [segment(1, 0, 300, true), segment(1, 300, 300, true), segment(1, 600, 50), segment(2, 0, 300, true)];
  const forward = appendReadingSegment(original, segment(2, 300, 300, true), "later");
  assert.equal(forward.length, 4);
  assert.deepEqual(readingNeighbor(forward[0]!, "earlier"), { page: 1, offset: 0 });
  const backward = appendReadingSegment(forward, original[0]!, "earlier");
  assert.equal(backward.length, 4);
  assert.deepEqual(readingNeighbor(backward.at(-1)!, "later"), { page: 2, offset: 300 });
});
