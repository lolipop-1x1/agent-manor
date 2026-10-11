import type { OverviewInsight } from "../overview-contracts.js";

export const nonnegative = (value: number | undefined): value is number => Number.isSafeInteger(value) && value! >= 0;
export const percent = (numerator: number, denominator: number): number | null => denominator > 0 ? numerator * 100 / denominator : null;

/** 对称拆分不偏向任一比较期，两项贡献之和等于总量差。 */
export function decomposeUsage(previousCount: number, previousTokens: number, currentCount: number, currentTokens: number) {
  if (previousCount <= 0 || currentCount <= 0) return null;
  const previousMean = previousTokens / previousCount;
  const currentMean = currentTokens / currentCount;
  return { previousMean, currentMean,
    countContribution: (currentCount - previousCount) * (previousMean + currentMean) / 2,
    meanContribution: (currentMean - previousMean) * (previousCount + currentCount) / 2 };
}

export function quantile(values: number[], probability: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  return sorted[lower]! + (sorted[Math.ceil(index)]! - sorted[lower]!) * (index - lower);
}

/** 各类按规则次序轮流入选，异类指标不组成未经定义的统一分数。 */
export function selectFeaturedInsights(insights: OverviewInsight[]): OverviewInsight[] {
  const queues = (["feature", "change", "investigation"] as const).map(type => insights.filter(insight => insight.type === type));
  const result: OverviewInsight[] = [];
  while (result.length < 5 && queues.some(queue => queue.length)) {
    for (const queue of queues) {
      const insight = queue.shift();
      if (insight && result.length < 5) result.push(insight);
    }
  }
  return result;
}
