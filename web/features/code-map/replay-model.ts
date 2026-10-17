import type { ReplayStep } from "../../../src/replay-contracts";

export interface ReplaySegment { start: number; end: number; from: number; to: number; collapsed: boolean }
export interface PositionedStep { step: ReplayStep; position: number }
export interface ReplayIndex {
  timed: PositionedStep[];
  untimed: Map<string, ReplayStep[]>;
  segments: ReplaySegment[];
  duration: number;
  start: number;
  end: number;
  paths: Map<string, { index: number; step: ReplayStep }[]>;
}

/** 仅折叠全部轨道都没有文件活动的空档，所有轨道共用一份映射。 */
export function buildReplayIndex(steps: ReplayStep[], threshold = 15_000, gapDuration = 900): ReplayIndex {
  const ordered = steps.filter(step => Number.isFinite(step.time)).sort((a, b) => a.time! - b.time! || a.trackId.localeCompare(b.trackId) || a.order - b.order);
  const untimed = new Map<string, ReplayStep[]>();
  for (const step of steps) if (!Number.isFinite(step.time)) {
    const track = untimed.get(step.trackId) ?? [];
    track.push(step); untimed.set(step.trackId, track);
  }
  for (const values of untimed.values()) values.sort((a, b) => a.order - b.order);
  const start = ordered[0]?.time ?? 0, end = ordered.at(-1)?.time ?? start;
  const segments: ReplaySegment[] = [];
  const timed: PositionedStep[] = [];
  const paths: ReplayIndex["paths"] = new Map();
  let previous = start, position = 0;
  for (const step of ordered) {
    const time = step.time!, delta = time - previous;
    if (delta > 0) {
      const length = delta > threshold ? gapDuration : delta;
      segments.push({ start: previous, end: time, from: position, to: position + length, collapsed: delta > threshold });
      position += length;
    }
    const index = timed.length;
    timed.push({ step, position });
    for (const path of new Set(step.activities.flatMap(activity => activity.paths))) {
      const values = paths.get(path) ?? [];
      values.push({ index, step }); paths.set(path, values);
    }
    previous = time;
  }
  // 最后一个活动保留可辨认的停留时间；它不代表真实执行时长。
  return { timed, untimed, segments, duration: ordered.length ? position + 1200 : 0, start, end, paths };
}

export function upperBound<T>(values: readonly T[], target: number, value: (entry: T) => number): number {
  let left = 0, right = values.length;
  while (left < right) { const middle = (left + right) >>> 1; if (value(values[middle]!) <= target) left = middle + 1; else right = middle; }
  return left;
}

export const replayEndIndex = (index: ReplayIndex, position: number) => upperBound(index.timed, position, entry => entry.position);
export function replayOriginalTime(index: ReplayIndex, position: number): number {
  const segmentIndex = upperBound(index.segments, position, segment => segment.from) - 1;
  const segment = index.segments[segmentIndex];
  if (!segment) return index.start;
  const fraction = Math.max(0, Math.min(1, (position - segment.from) / (segment.to - segment.from)));
  return segment.start + fraction * (segment.end - segment.start);
}
export function replayCurrentRange(index: ReplayIndex, position: number): [number, number] {
  const end = replayEndIndex(index, position);
  const start = upperBound(index.timed, position - 1200, entry => entry.position);
  return [start, end];
}
export function replayPrevious(index: ReplayIndex, position: number): number {
  const before = upperBound(index.timed, position - 1, entry => entry.position) - 1;
  return index.timed[Math.max(0, before)]?.position ?? 0;
}
export function replayNext(index: ReplayIndex, position: number): number {
  return index.timed[upperBound(index.timed, position, entry => entry.position)]?.position ?? index.duration;
}
export function replayPathSteps(index: ReplayIndex, path: string, endIndex: number): ReplayStep[] {
  const values = index.paths.get(path) ?? [];
  return values.slice(0, upperBound(values, endIndex - 1, value => value.index)).map(value => value.step).reverse();
}

/** 同轨同坐标的点可能重叠；点选时完整提供所有调用，不能只留下最上层命中点。 */
export function replaySimultaneousSteps(index: ReplayIndex, step: ReplayStep): ReplayStep[] {
  const item = index.timed.find(item => item.step === step);
  if (!item) return [step];
  const start = upperBound(index.timed, item.position - 1, value => value.position);
  const end = upperBound(index.timed, item.position, value => value.position);
  return index.timed.slice(start, end).flatMap(item => item.step.trackId === step.trackId ? [item.step] : []);
}

/** 前后定位只增减跨过的活动，不在动画帧中扫描所有活动和文件。 */
export class ReplayAccumulator {
  private end = 0;
  readonly counts = new Map<string, number>();
  constructor(private readonly index: ReplayIndex) {}
  seek(end: number): ReadonlyMap<string, number> {
    const next = Math.max(0, Math.min(this.index.timed.length, end));
    const direction = next >= this.end ? 1 : -1;
    for (let i = direction > 0 ? this.end : this.end - 1; direction > 0 ? i < next : i >= next; i += direction) {
      const step = this.index.timed[i]!.step;
      for (const path of new Set(step.activities.flatMap(activity => activity.paths))) {
        const count = (this.counts.get(path) ?? 0) + direction;
        if (count) this.counts.set(path, count); else this.counts.delete(path);
      }
    }
    this.end = next;
    return this.counts;
  }
}
