/** 尾部窗口滑动时只输出新内容；找不到重叠部分时明确标记日志重置。 */
export function logDelta(previous: string, next: string): { text: string; reset: boolean } {
  if (!previous) return { text: next, reset: false };
  if (next.startsWith(previous)) return { text: next.slice(previous.length), reset: false };
  const oldLines = previous.split("\n"), newLines = next.split("\n");
  for (let count = Math.min(oldLines.length, newLines.length); count > 0; count--) {
    if (oldLines.slice(-count).join("\n") === newLines.slice(0, count).join("\n")) return { text: newLines.slice(count).join("\n"), reset: false };
  }
  return { text: next, reset: true };
}
