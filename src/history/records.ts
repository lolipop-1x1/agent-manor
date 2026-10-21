export const MAX_HISTORY_RECORD_BYTES = 16 * 1024 * 1024;

export interface HistoryRecord {
  line: number;
  end: number;
  complete: boolean;
  oversized: boolean;
  raw?: string;
}

/** 超限后释放正文缓冲，继续消费至换行；行号与字节边界仍来自完整原始记录。 */
export async function* historyRecords(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  start: { line?: number; offset?: number } = {}): AsyncGenerator<HistoryRecord> {
  let parts: Buffer[] = [], size = 0, oversized = false;
  let line = start.line ?? 0, position = start.offset ?? 0;
  for await (const bytes of chunks) {
    const chunk = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    let from = 0;
    while (from < chunk.length) {
      const newline = chunk.indexOf(10, from), end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(from, end);
      size += part.length; position += part.length;
      if (!oversized && size <= MAX_HISTORY_RECORD_BYTES) parts.push(part);
      else { oversized = true; parts = []; }
      if (newline < 0) break;
      position += 1;
      yield { line: ++line, end: position, complete: true, oversized, raw: oversized ? undefined : (parts.length === 1 ? parts[0]! : Buffer.concat(parts, size)).toString("utf8") };
      parts = []; size = 0; oversized = false; from = newline + 1;
    }
  }
  if (size) yield { line: line + 1, end: position, complete: false, oversized };
}
