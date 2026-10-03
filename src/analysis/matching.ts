import { diffArrays } from "diff";
import { posix } from "node:path";
import type { BaselineFile, EvidenceFragment, HistoryEvent, LineRange, Mapping } from "../contracts.js";
import { hashContent, textLines } from "./baseline.js";
import { mergeRanges, subtractRanges } from "./ranges.js";

export const MATCHING_RULE_VERSION = "matching-v1";
export const MATCHING_LIMITS = {
  maxFragmentCodePoints: 200_000,
  maxFragmentLines: 3_000,
  maxCandidates: 64,
  maxLineScans: 20_000,
  maxExactComparisons: 1_000_000,
  maxInsertedLines: 32,
  maxContextDistance: 64,
  maxLineCodePoints: 4_096,
  maxLineDiffEdits: 256,
  maxCharDiffEdits: 64,
  shortCodePoints: 24,
  uniqueRunCodePoints: 16,
} as const;

interface Candidate {
  start: number;
  end: number;
}

interface FragmentMatch {
  exact: LineRange[];
  near: LineRange[];
  reason?: string;
}

interface ContextAnchor extends Candidate {
  oldStart?: number;
  oldEnd?: number;
  fragmentIndex: number;
}

const fileIndexes = new WeakMap<BaselineFile, { hash: string; content: string; lines: string[]; index: Map<string, number[]> }>();

function fileIndex(file: BaselineFile) {
  const previous = fileIndexes.get(file);
  if (previous?.hash === file.hash && previous.content === file.content) return previous;
  const lines = textLines(file.content);
  const index = new Map<string, number[]>();
  lines.forEach((line, row) => {
    if (!index.has(line)) index.set(line, []);
    index.get(line)!.push(row);
  });
  const current = { hash: file.hash, content: file.content, lines, index };
  fileIndexes.set(file, current);
  return current;
}

export interface CharacterDifference {
  difference: number;
  similarity: number;
  longestUnchanged: string;
}

/** Unicode 码点增删之和；替换一个字符计 2。计算预算与接受门槛分别处理。 */
export function characterDifference(oldText: string, currentText: string): CharacterDifference | undefined {
  const oldPoints = Array.from(oldText);
  const currentPoints = Array.from(currentText);
  if (Math.max(oldPoints.length, currentPoints.length) > MATCHING_LIMITS.maxLineCodePoints) return undefined;
  const changes = diffArrays(oldPoints, currentPoints, { maxEditLength: MATCHING_LIMITS.maxCharDiffEdits });
  if (!changes) return undefined;
  let difference = 0;
  let longestUnchanged = "";
  for (const change of changes) {
    if (change.added || change.removed) difference += change.count;
    else if (change.value.length > Array.from(longestUnchanged).length) longestUnchanged = change.value.join("");
  }
  const total = oldPoints.length + currentPoints.length;
  return { difference, similarity: total === 0 ? 0 : 1 - difference / total, longestUnchanged };
}

export function mappingCacheKey(event: HistoryEvent, file: BaselineFile): string {
  return hashContent(JSON.stringify([MATCHING_RULE_VERSION, file.path, file.hash, event.id, event.kind,
    event.status, event.path, event.cwd, event.fragments]));
}

function samePath(fragment: EvidenceFragment, file: BaselineFile): boolean {
  if (!fragment.path) return true;
  const path = posix.normalize(fragment.path.replaceAll("\\", "/"));
  if (path === file.path) return true;
  // 调用方先验证仓库归属，绝对路径仍须对应这个文件的相对路径。
  return path.startsWith("/") && path.endsWith(`/${file.path}`);
}

function findOccurrences(lines: string[], target: string[], index: Map<string, number[]>): Candidate[] | undefined {
  if (target.length === 0) return [];
  const starts = index.get(target[0]!) ?? [];
  if (starts.length > MATCHING_LIMITS.maxLineScans) return undefined;
  const result: Candidate[] = [];
  let comparisons = 0;
  for (const start of starts) {
    if (start + target.length > lines.length) continue;
    let identical = true;
    for (let offset = 0; offset < target.length; offset++) {
      if (++comparisons > MATCHING_LIMITS.maxExactComparisons) return undefined;
      if (lines[start + offset] !== target[offset]) {
        identical = false;
        break;
      }
    }
    if (identical) {
      result.push({ start, end: start + target.length - 1 });
      if (result.length > MATCHING_LIMITS.maxCandidates) return undefined;
    }
  }
  return result;
}

function usefulLine(line: string): boolean {
  return Array.from(line.trim()).length >= 8;
}

function contextAnchors(event: HistoryEvent, file: BaselineFile, lines: string[], index: Map<string, number[]>): ContextAnchor[] {
  const result: ContextAnchor[] = [];
  event.fragments.forEach((fragment, fragmentIndex) => {
    if (fragment.kind !== "context" || !fragment.completeLines || !samePath(fragment, file)) return;
    const oldLines = textLines(fragment.content);
    if (!oldLines.some(usefulLine)) return;
    const occurrences = findOccurrences(lines, oldLines, index);
    if (occurrences?.length !== 1) return;
    const occurrence = occurrences[0]!;
    result.push({ ...occurrence, oldStart: fragment.historicalStart,
      oldEnd: fragment.historicalStart === undefined ? undefined : fragment.historicalStart + oldLines.length - 1,
      fragmentIndex });
  });
  return result;
}

function surroundingContexts(fragment: EvidenceFragment, fragmentIndex: number, anchors: ContextAnchor[]): { before?: ContextAnchor; after?: ContextAnchor } {
  const end = fragment.historicalStart === undefined ? undefined : fragment.historicalStart + textLines(fragment.content).length - 1;
  const before = anchors.filter((anchor) => fragment.historicalStart !== undefined && anchor.oldEnd !== undefined
    ? anchor.oldEnd < fragment.historicalStart : anchor.fragmentIndex < fragmentIndex)
    .sort((a, b) => b.fragmentIndex - a.fragmentIndex)[0];
  const after = anchors.filter((anchor) => end !== undefined && anchor.oldStart !== undefined
    ? anchor.oldStart > end : anchor.fragmentIndex > fragmentIndex)
    .sort((a, b) => a.fragmentIndex - b.fragmentIndex)[0];
  return { before, after };
}

function respectsContext(candidate: Candidate, context: { before?: ContextAnchor; after?: ContextAnchor }): boolean {
  const { before, after } = context;
  if (before && (candidate.start <= before.end || candidate.start - before.end > MATCHING_LIMITS.maxContextDistance)) return false;
  if (after && (candidate.end >= after.start || after.start - candidate.end > MATCHING_LIMITS.maxContextDistance)) return false;
  return true;
}

function uniqueRun(run: string, lines: string[]): boolean {
  if (Array.from(run).length < MATCHING_LIMITS.uniqueRunCodePoints || run.trim().length === 0) return false;
  let occurrences = 0;
  for (const line of lines) {
    let from = 0;
    while (from <= line.length) {
      const position = line.indexOf(run, from);
      if (position === -1) break;
      if (++occurrences > 1) return false;
      from = position + 1;
    }
  }
  return occurrences === 1;
}

function acceptsNear(oldLine: string, currentLine: string, context: boolean, allLines: string[], budget?: { exceeded: boolean }): boolean {
  const comparison = characterDifference(oldLine, currentLine);
  if (!comparison) {
    if (budget) budget.exceeded = true;
    return false;
  }
  if (comparison.difference === 0) return false;
  const shortest = Math.min(Array.from(oldLine).length, Array.from(currentLine).length);
  if (shortest === 0) return false;
  if (shortest < MATCHING_LIMITS.shortCodePoints) {
    return context && comparison.difference <= 2 && comparison.similarity >= 0.75;
  }
  const maxDifference = shortest >= 256 ? 16 : 8;
  return comparison.difference <= maxDifference && comparison.similarity >= 0.94
    && (context || uniqueRun(comparison.longestUnchanged, allLines));
}

function localCorrespondence(oldLines: string[], lines: string[], candidate: Candidate, hasContext: boolean): FragmentMatch | undefined {
  const currentLines = lines.slice(candidate.start, candidate.end + 1);
  const changes = diffArrays(oldLines, currentLines, { maxEditLength: MATCHING_LIMITS.maxLineDiffEdits });
  if (!changes) return undefined;
  const exact: LineRange[] = [];
  const near: LineRange[] = [];
  let currentOffset = 0;
  let unresolved = false;
  const budget = { exceeded: false };
  const oldCounts = new Map<string, number>();
  const currentCounts = new Map<string, number>();
  oldLines.forEach((line) => oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1));
  currentLines.forEach((line) => currentCounts.set(line, (currentCounts.get(line) ?? 0) + 1));
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]!;
    if (!change.added && !change.removed) {
      change.value.forEach((line, offset) => {
        if (oldCounts.get(line) === currentCounts.get(line)) {
          const row = candidate.start + currentOffset + offset + 1;
          exact.push({ start: row, end: row });
        } else unresolved = true;
      });
      currentOffset += change.count;
      continue;
    }
    if (change.added) {
      currentOffset += change.count;
      continue;
    }
    const added = changes[i + 1]?.added ? changes[i + 1] : undefined;
    if (!added) {
      unresolved = true;
      continue;
    }
    // 变化组内仅建立双向唯一的一行对应，新插入行没有历史对应。
    const pairs = change.value.map((oldLine) => added.value.flatMap((currentLine, offset) =>
      acceptsNear(oldLine, currentLine, hasContext, lines, budget) ? [offset] : []));
    pairs.forEach((matches) => {
      if (matches.length === 1 && pairs.filter((other) => other.includes(matches[0]!)).length === 1) {
        const row = candidate.start + currentOffset + matches[0]! + 1;
        near.push({ start: row, end: row });
      } else unresolved = true;
    });
    currentOffset += added.count;
    i++;
  }
  return { exact: mergeRanges(exact), near: mergeRanges(near),
    reason: budget.exceeded ? "budget_exceeded: 局部字符差异计算超限"
      : unresolved ? "range_unknown: 部分历史行无法唯一对应当前内容" : undefined };
}

function approximateCandidates(oldLines: string[], lines: string[], index: Map<string, number[]>, context: { before?: ContextAnchor; after?: ContextAnchor }): Candidate[] | undefined {
  const candidates = new Map<string, Candidate>();
  const add = (start: number, end: number) => {
    const candidate = { start, end };
    if (start < 0 || end < start || end >= lines.length || Math.abs(end - start + 1 - oldLines.length) > MATCHING_LIMITS.maxInsertedLines) return;
    if (respectsContext(candidate, context)) candidates.set(`${start}:${end}`, candidate);
  };
  const anchorRows = oldLines.flatMap((line, offset) => usefulLine(line) && (index.get(line)?.length ?? 0) > 0
    ? [{ offset, positions: index.get(line)! }] : []);
  const first = anchorRows[0];
  const last = anchorRows.at(-1);
  if (first && last && first.offset !== last.offset) {
    if (first.positions.length * last.positions.length > MATCHING_LIMITS.maxCandidates) return undefined;
    for (const start of first.positions) {
      for (const end of last.positions) {
        if (start < end) add(start - first.offset, end + oldLines.length - 1 - last.offset);
      }
    }
  }
  if (context.before && context.after) add(context.before.end + 1, context.after.start - 1);
  if (oldLines.length === 1) {
    if (lines.length > MATCHING_LIMITS.maxLineScans) return undefined;
    lines.forEach((line, row) => {
      if (respectsContext({ start: row, end: row }, context)
        && acceptsNear(oldLines[0]!, line, Boolean(context.before || context.after), lines)) add(row, row);
    });
  }
  if (candidates.size > MATCHING_LIMITS.maxCandidates) return undefined;
  return [...candidates.values()];
}

function matchFragment(fragment: EvidenceFragment, fragmentIndex: number, lines: string[], index: Map<string, number[]>, anchors: ContextAnchor[]): FragmentMatch {
  if (!fragment.completeLines) return { exact: [], near: [], reason: "range_unknown: 片段包含不完整行" };
  const oldLines = textLines(fragment.content);
  if (oldLines.length === 0) return { exact: [], near: [], reason: "range_unknown: 没有历史源码内容" };
  const context = surroundingContexts(fragment, fragmentIndex, anchors);
  const occurrences = findOccurrences(lines, oldLines, index);
  if (!occurrences) return { exact: [], near: [], reason: "budget_exceeded: 精确候选过多" };
  const located = occurrences.filter((candidate) => respectsContext(candidate, context));
  const informative = Array.from(oldLines.join("\n").trim()).length >= MATCHING_LIMITS.uniqueRunCodePoints
    || Boolean(context.before || context.after) || oldLines.length === lines.length;
  if (located.length === 1 && informative) {
    const candidate = located[0]!;
    return { exact: [{ start: candidate.start + 1, end: candidate.end + 1 }], near: [] };
  }
  if (located.length > 1) return { exact: [], near: [], reason: "ambiguous: 内容对应多个当前位置" };
  if (located.length === 1) return { exact: [], near: [], reason: "range_unknown: 短片段缺少唯一上下文" };
  // 删除片段只可精确对应被撤销后恢复的原行，不借相似邻行制造当前编辑范围。
  if (fragment.kind === "deleted") return { exact: [], near: [], reason: "range_unknown: 删除行在当前基线不存在" };
  if (oldLines.length > MATCHING_LIMITS.maxFragmentLines || Array.from(fragment.content).length > MATCHING_LIMITS.maxFragmentCodePoints) {
    return { exact: [], near: [], reason: "budget_exceeded: 近似片段超过计算预算" };
  }
  if (oldLines.length === 1 && Array.from(oldLines[0]!).length > MATCHING_LIMITS.maxLineCodePoints) {
    return { exact: [], near: [], reason: "budget_exceeded: 局部字符差异计算超限" };
  }
  const candidates = approximateCandidates(oldLines, lines, index, context);
  if (!candidates) return { exact: [], near: [], reason: "budget_exceeded: 近似候选超过计算预算" };
  const accepted: FragmentMatch[] = [];
  let exceeded = false;
  for (const candidate of candidates) {
    const internalAnchors = oldLines.filter((line) => usefulLine(line) && lines.slice(candidate.start, candidate.end + 1).includes(line));
    const hasContext = Boolean(context.before || context.after) || new Set(internalAnchors).size >= 2;
    const mapped = localCorrespondence(oldLines, lines, candidate, hasContext);
    if (!mapped) exceeded = true;
    else if (mapped.exact.length > 0 || mapped.near.length > 0) accepted.push(mapped);
  }
  if (accepted.length > 1) return { exact: [], near: [], reason: "ambiguous: 多个局部候选满足对应门槛" };
  if (accepted.length === 1) return accepted[0]!;
  return { exact: [], near: [], reason: exceeded ? "budget_exceeded: 局部差异超限" : "range_unknown: 缺少唯一上下文或局部差异超过近似门槛" };
}

export function matchEvent(event: HistoryEvent, file: BaselineFile): Mapping {
  const mapping: Mapping = { eventId: event.id, filePath: file.path, kind: event.kind === "edit" ? "edit" : "read",
    exactRanges: [], nearRanges: [], ruleVersion: MATCHING_RULE_VERSION };
  if ((event.kind !== "read" && event.kind !== "edit") || event.status !== "success") {
    return { ...mapping, unknownReason: "range_unknown: 非成功读取或编辑事件不进入覆盖" };
  }
  const { lines, index } = fileIndex(file);
  const anchors = contextAnchors(event, file, lines, index);
  const reasons = new Set<string>();
  let targets = 0;
  event.fragments.forEach((fragment, fragmentIndex) => {
    if (!samePath(fragment, file) || (event.kind === "read" ? fragment.kind !== "read" : fragment.kind !== "added" && fragment.kind !== "deleted")) return;
    targets++;
    const result = matchFragment(fragment, fragmentIndex, lines, index, anchors);
    mapping.exactRanges.push(...result.exact);
    mapping.nearRanges.push(...result.near);
    if (result.reason) reasons.add(result.reason);
  });
  if (targets === 0) reasons.add("range_unknown: 没有可覆盖的实际源码片段");
  mapping.exactRanges = mergeRanges(mapping.exactRanges, file.lineCount);
  mapping.nearRanges = subtractRanges(mergeRanges(mapping.nearRanges, file.lineCount), mapping.exactRanges);
  if (reasons.size > 0) {
    const priority = (reason: string) => reason.startsWith("ambiguous:") ? 0 : reason.startsWith("budget_exceeded:") ? 1 : 2;
    mapping.unknownReason = [...reasons].sort((a, b) => priority(a) - priority(b)).join("；");
  }
  return mapping;
}
