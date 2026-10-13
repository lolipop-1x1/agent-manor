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

/** 按完整可选分组分配色阶，不随已选列表的增减或顺序变化。 */
export function speedSeriesStyles(keys: string[]) {
  return new Map([...new Set(keys)].sort().map((key, index) => [key, {
    color: `var(--usage-series-${index % 6})`, dash: [undefined, "6 3", "2 3", "8 3 2 3"][Math.floor(index / 6) % 4],
  }]));
}

/** 所有曲线共用日期轴与纵轴，每组分别保留缺失、单点和原始明细。 */
export function speedComparisonModel(speed?: UsageSpeedReport) {
  const dates = [...new Set(speed?.series.flatMap(series => series.buckets.map(bucket => bucket.key)) ?? [])].sort();
  const styles = speedSeriesStyles(speed?.groups.map(group => group.key) ?? []);
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
