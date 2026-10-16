/** 按真实日期间距选择最近的观测点，不把缺少观测的日期补成零。 */
export function resourceTrendIndexAt(dates: readonly number[], position: number): number | undefined {
  if (!dates.length) return undefined;
  const target = dates[0]! + Math.max(0, Math.min(1, position)) * (dates.at(-1)! - dates[0]!);
  let low = 0, high = dates.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (dates[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low > 0 && target - dates[low - 1]! <= dates[low]! - target ? low - 1 : low;
}
