import type { UsageSpeedBucket, UsageSpeedReport } from "../../../src/usage-contracts";

/** 缺失日期切断曲线；孤立有效点仍保留给绘制和键盘选择。 */
export function speedLineModel(buckets: Pick<UsageSpeedBucket, "tokensPerSecond">[]) {
  const segments: { index: number; value: number }[][] = [];
  let segment: { index: number; value: number }[] = [];
  for (const [index, bucket] of buckets.entries()) {
    if (bucket.tokensPerSecond === null) { segment = []; continue; }
    if (!segment.length) segments.push(segment);
    segment.push({ index, value: bucket.tokensPerSecond });
  }
  const points = segments.flat();
  return { segments, points, maximum: Math.max(1, ...points.map(point => point.value)), lastEligibleIndex: points.at(-1)?.index ?? -1 };
}

/** 颜色按完整分组固定；同色的已选组分别分配短线型，避免稀疏选择撞色型。 */
export function speedSeriesStyles(keys: string[], selectedKeys = keys) {
  const selected = new Set(selectedKeys);
  const counts = new Map<string, number>();
  return new Map([...new Set(keys)].sort().map((key, index) => {
    const color = `var(--usage-series-${index % 6})`;
    const sameColorIndex = counts.get(color) ?? 0;
    if (selected.has(key)) counts.set(color, sameColorIndex + 1);
    // 支持的500组内，线段与间隔都不超过11；高位不取模，避免色型循环碰撞。
    const dash = sameColorIndex === 0 ? undefined : `${2 + (sameColorIndex - 1) % 10} 3 2 ${3 + Math.floor((sameColorIndex - 1) / 10)}`;
    return [key, { color, dash }];
  }));
}

/** 所有曲线共用日期轴与纵轴，每组分别保留缺失、单点和原始明细。 */
export function speedComparisonModel(speed?: UsageSpeedReport) {
  // 小时桶按真实时刻排序，避免夏令时回拨的正时区偏移被字符串顺序反转。
  const dates = [...new Set(speed?.series.flatMap(series => series.buckets.map(bucket => bucket.key)) ?? [])]
    .sort((left, right) => left.includes("T") ? Date.parse(left) - Date.parse(right) : left.localeCompare(right));
  const styles = speedSeriesStyles(speed?.groups.map(group => group.key) ?? [], speed?.selectedGroups ?? []);
  const series = (speed?.series ?? []).flatMap(series => {
    const group = speed?.groups.find(group => group.key === series.group);
    if (!group) return [];
    const buckets = new Map(series.buckets.map(bucket => [bucket.key, bucket]));
    const model = speedLineModel(dates.map(key => ({ tokensPerSecond: buckets.get(key)?.tokensPerSecond ?? null })));
    return [{ group, buckets, model, ...styles.get(group.key)! }];
  });
  return { dates, series, maximum: Math.max(1, ...series.map(series => series.model.maximum)),
    lastEligibleIndex: Math.max(-1, ...series.map(series => series.model.lastEligibleIndex)) };
}
