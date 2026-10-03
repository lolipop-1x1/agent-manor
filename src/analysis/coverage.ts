import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  AnalysisSnapshot, BaselineFile, CoverageResult, FileCoverage, Filters, Gap, HistoryEvent, Mapping, Repository,
} from "../contracts.js";
import { countRangeLines, mergeRanges, subtractRanges } from "./ranges.js";

/** 这里只处理已经可靠归属的当前 worktree 路径，不猜测其他 clone/worktree。 */
export function eventFilePaths(event: HistoryEvent, repository: Repository): string[] {
  const paths = [event.path, ...event.fragments.map((fragment) => fragment.path)].filter((path): path is string => Boolean(path));
  const result = new Set<string>();
  for (const path of paths) {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(event.cwd ?? repository.path, path);
    const local = relative(repository.path, absolute);
    if (local && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local)) result.add(local.split(sep).join("/"));
  }
  return [...result];
}

function selectedFile(file: BaselineFile, filters: Filters): boolean {
  if (!(filters.categories ?? ["source"]).includes(file.category)) return false;
  const directory = filters.directory?.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return !directory || directory === "." || file.path === directory || file.path.startsWith(`${directory}/`);
}

function selectedEvent(event: HistoryEvent, filters: Filters): boolean {
  if (filters.client && event.client !== filters.client) return false;
  if (filters.from || filters.to) {
    const time = event.occurredAt ? Date.parse(event.occurredAt) : NaN;
    if (!Number.isFinite(time)) return false;
    if (filters.from && time < Date.parse(filters.from)) return false;
    if (filters.to && time > Date.parse(filters.to)) return false;
  }
  return true;
}

export function filterEvents(snapshot: AnalysisSnapshot, filters: Filters = {}): HistoryEvent[] {
  const files = new Set(snapshot.baseline.files.filter((file) => selectedFile(file, filters)).map((file) => file.path));
  const mappings = new Map<string, Set<string>>();
  for (const mapping of snapshot.mappings) {
    if (!mappings.has(mapping.eventId)) mappings.set(mapping.eventId, new Set());
    mappings.get(mapping.eventId)!.add(mapping.filePath);
  }
  const result = new Map<string, HistoryEvent>();
  for (const event of snapshot.events) {
    if (!selectedEvent(event, filters)) continue;
    const paths = [...eventFilePaths(event, snapshot.repository), ...(mappings.get(event.id) ?? [])];
    if (paths.some((path) => files.has(path)) && !result.has(event.id)) result.set(event.id, event);
  }
  return [...result.values()];
}

function emptyCoverage(file: BaselineFile): FileCoverage {
  return { path: file.path, category: file.category, lineCount: file.lineCount, hash: file.hash,
    readExactLines: 0, readNearLines: 0, editExactLines: 0, editNearLines: 0,
    activityCount: 0, readCount: 0, editCount: 0, searchCount: 0, failedCount: 0, unknownCount: 0,
    readExactRanges: [], readNearRanges: [], editExactRanges: [], editNearRanges: [] };
}

function mappingGap(mapping: Mapping, event: HistoryEvent): Gap | undefined {
  if (!mapping.unknownReason) return undefined;
  const kind = mapping.unknownReason.startsWith("ambiguous:") ? "ambiguous"
    : mapping.unknownReason.startsWith("budget_exceeded:") ? "budget_exceeded" : "range_unknown";
  return { kind, message: `${mapping.filePath}: ${mapping.unknownReason}`, sourceId: event.sources[0]?.sourceId, count: 1 };
}

export function buildCoverage(snapshot: AnalysisSnapshot, filters: Filters = {}): CoverageResult {
  const files = snapshot.baseline.files.filter((file) => selectedFile(file, filters)).map(emptyCoverage);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const events = filterEvents(snapshot, filters);
  const eventIds = new Set(events.map((event) => event.id));
  const mappings = new Map<string, Mapping[]>();
  const mappedPaths = new Map<string, Set<string>>();
  for (const mapping of snapshot.mappings) {
    if (!eventIds.has(mapping.eventId) || !byPath.has(mapping.filePath)) continue;
    const key = JSON.stringify([mapping.eventId, mapping.filePath]);
    if (!mappings.has(key)) mappings.set(key, []);
    mappings.get(key)!.push(mapping);
    if (!mappedPaths.has(mapping.eventId)) mappedPaths.set(mapping.eventId, new Set());
    mappedPaths.get(mapping.eventId)!.add(mapping.filePath);
  }
  const gaps = snapshot.gaps.filter((gap) => {
    if (!filters.client || !gap.sourceId) return true;
    const source = snapshot.sources.find((source) => source.sourceId === gap.sourceId);
    return !source || source.client === filters.client;
  });
  const emittedGaps = new Set<string>();
  for (const event of events) {
    const paths = new Set(eventFilePaths(event, snapshot.repository));
    for (const path of mappedPaths.get(event.id) ?? []) paths.add(path);
    for (const path of paths) {
      const file = byPath.get(path);
      if (!file) continue;
      const related = mappings.get(JSON.stringify([event.id, path])) ?? [];
      file.activityCount++;
      if (event.kind === "search") file.searchCount++;
      if (event.status === "failure") file.failedCount++;
      if (event.status === "unknown") file.unknownCount++;
      if (event.status !== "success" || (event.kind !== "read" && event.kind !== "edit")) continue;
      if (event.kind === "read") file.readCount++;
      else file.editCount++;
      const valid = related.filter((mapping) => mapping.kind === event.kind);
      if (valid.length === 0 || valid.some((mapping) => Boolean(mapping.unknownReason))) file.unknownCount++;
      for (const mapping of valid) {
        if (mapping.kind === "read") {
          file.readExactRanges.push(...mapping.exactRanges);
          file.readNearRanges.push(...mapping.nearRanges);
        } else {
          file.editExactRanges.push(...mapping.exactRanges);
          file.editNearRanges.push(...mapping.nearRanges);
        }
        const gap = mappingGap(mapping, event);
        const gapKey = JSON.stringify([event.id, path, gap?.kind, gap?.message]);
        if (gap && !emittedGaps.has(gapKey)) {
          gaps.push(gap);
          emittedGaps.add(gapKey);
        }
      }
    }
  }
  for (const file of files) {
    file.readExactRanges = mergeRanges(file.readExactRanges, file.lineCount);
    file.readNearRanges = subtractRanges(mergeRanges(file.readNearRanges, file.lineCount), file.readExactRanges);
    file.editExactRanges = mergeRanges(file.editExactRanges, file.lineCount);
    file.editNearRanges = subtractRanges(mergeRanges(file.editNearRanges, file.lineCount), file.editExactRanges);
    file.readExactLines = countRangeLines(file.readExactRanges);
    file.readNearLines = countRangeLines(file.readNearRanges);
    file.editExactLines = countRangeLines(file.editExactRanges);
    file.editNearLines = countRangeLines(file.editNearRanges);
  }
  const count = (metric: "readExactLines" | "readNearLines" | "editExactLines" | "editNearLines") => ({
    files: files.filter((file) => file[metric] > 0).length,
    lines: files.reduce((sum, file) => sum + file[metric], 0),
  });
  return {
    repository: snapshot.repository,
    version: snapshot.version,
    baselineHash: snapshot.baseline.hash,
    createdAt: snapshot.createdAt,
    stale: snapshot.repository.stale,
    filters: { ...filters, categories: [...(filters.categories ?? ["source"])] },
    previousVersion: snapshot.previousVersion,
    files,
    summary: {
      fileCount: files.length,
      lineCount: files.reduce((sum, file) => sum + file.lineCount, 0),
      readExact: count("readExactLines"), readNear: count("readNearLines"),
      editExact: count("editExactLines"), editNear: count("editNearLines"),
    },
    gaps,
  };
}

export function getHotspots(coverage: CoverageResult, metric: "read" | "edit" | "activity" = "activity", limit = 20): FileCoverage[] {
  const count = (file: FileCoverage) => metric === "read" ? file.readCount : metric === "edit" ? file.editCount
    : file.activityCount;
  return coverage.files.filter((file) => count(file) > 0).sort((a, b) => count(b) - count(a) || a.path.localeCompare(b.path))
    .slice(0, Math.max(0, limit));
}

export function getUnreadFiles(coverage: CoverageResult): FileCoverage[] {
  return coverage.files.filter((file) => file.readCount === 0);
}
