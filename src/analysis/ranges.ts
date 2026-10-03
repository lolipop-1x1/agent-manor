import type { LineRange } from "../contracts.js";

export function mergeRanges(ranges: LineRange[], lineCount = Number.MAX_SAFE_INTEGER): LineRange[] {
  const sorted = ranges.filter(({ start, end }) => Number.isInteger(start) && Number.isInteger(end) && end >= start)
    .map(({ start, end }) => ({ start: Math.max(1, start), end: Math.min(lineCount, end) }))
    .filter(({ start, end }) => start <= end).sort((a, b) => a.start - b.start || a.end - b.end);
  const result: LineRange[] = [];
  for (const range of sorted) {
    const last = result.at(-1);
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

export function subtractRanges(ranges: LineRange[], excluded: LineRange[]): LineRange[] {
  const masks = mergeRanges(excluded);
  const result: LineRange[] = [];
  for (const range of mergeRanges(ranges)) {
    let start = range.start;
    for (const mask of masks) {
      if (mask.end < start) continue;
      if (mask.start > range.end) break;
      if (mask.start > start) result.push({ start, end: mask.start - 1 });
      start = Math.max(start, mask.end + 1);
      if (start > range.end) break;
    }
    if (start <= range.end) result.push({ start, end: range.end });
  }
  return result;
}

export function countRangeLines(ranges: LineRange[]): number {
  return mergeRanges(ranges).reduce((sum, range) => sum + range.end - range.start + 1, 0);
}
