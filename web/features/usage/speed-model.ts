import type { UsageSpeedBucket } from "../../../src/usage-contracts";

/** 缺失日期切断曲线；孤立有效点仍保留给绘制和键盘选择。 */
export function speedLineModel(buckets: UsageSpeedBucket[]) {
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
