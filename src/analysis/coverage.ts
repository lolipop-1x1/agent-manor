import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  AnalysisSnapshot, BaselineFile, CoverageResult, FileCategory, FileCoverage, Filters, Gap, HistoryEvent, HistorySource, Mapping, Repository,
} from "../contracts.js";
import { countRangeLines, mergeRanges, subtractRanges } from "./ranges.js";
import { classifyFile } from "./baseline.js";

/** 这里只处理已经可靠归属的当前 worktree 路径，不猜测其他 clone/worktree。 */
export function eventFilePaths(event: Pick<HistoryEvent, "path" | "cwd"> & { fragments: { path?: string }[] }, repository: Repository): string[] {
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
  if (filters.sessionClient && (event.client !== filters.sessionClient || event.sessionId !== filters.clientSessionId)) return false;
  if (filters.from || filters.to) {
    const time = event.occurredAt ? Date.parse(event.occurredAt) : NaN;
    if (!Number.isFinite(time)) return false;
    if (filters.from && time < Date.parse(filters.from)) return false;
    if (filters.to && time > Date.parse(filters.to)) return false;
  }
  return true;
}

export function selectedSource(source: HistorySource, filters: Filters): boolean {
  return (!filters.client || source.client === filters.client)
    && (!filters.sessionClient || source.client === filters.sessionClient && source.sessionId === filters.clientSessionId);
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

/** 同一完整版本复用路径前缀计数，删除文件和目录活动无需两两扫描路径。 */
export class HistoricalEventIndex {
  readonly events = new Map<string, HistoryEvent>();
  private readonly files: Map<string, FileCategory>;
  private readonly pathsByEvent: Map<string, string[]>;
  private readonly paths: string[];
  private readonly counts: Record<FileCategory, Uint32Array>;

  constructor(private readonly snapshot: AnalysisSnapshot) {
    this.files = new Map(snapshot.baseline.files.map(file => [file.path, file.category]));
    this.pathsByEvent = new Map(snapshot.events.map(event => [event.id, eventFilePaths(event, snapshot.repository)]));
    for (const event of snapshot.events) if (!this.events.has(event.id)) this.events.set(event.id, event);
    for (const mapping of snapshot.mappings) {
      const paths = this.pathsByEvent.get(mapping.eventId);
      if (paths && !paths.includes(mapping.filePath)) paths.push(mapping.filePath);
    }
    this.paths = [...new Set([...this.files.keys(), ...[...this.pathsByEvent.values()].flat()])].sort();
    this.counts = { source: new Uint32Array(this.paths.length + 1), config: new Uint32Array(this.paths.length + 1),
      docs: new Uint32Array(this.paths.length + 1), unknown: new Uint32Array(this.paths.length + 1) };
    for (let index = 0; index < this.paths.length; index++) {
      const category = this.category(this.paths[index]!);
      for (const key of ["source", "config", "docs", "unknown"] as const) {
        this.counts[key][index + 1] = this.counts[key][index]! + Number(key === category);
      }
    }
  }

  private category(path: string): FileCategory { return this.files.get(path) ?? classifyFile(path); }
  private lowerBound(path: string): number {
    let left = 0, right = this.paths.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (this.paths[middle]! < path) left = middle + 1; else right = middle;
    }
    return left;
  }
  private descendants(path: string): [number, number] {
    // '/' 的下一个字符是 '0'，因此此半开区间仅覆盖目录后代，不混入同名前缀。
    return [this.lowerBound(`${path}/`), this.lowerBound(`${path}0`)];
  }

  filter(filters: Filters = {}, candidates: Iterable<HistoryEvent> = this.snapshot.events): HistoryEvent[] {
    const categories = filters.categories ?? ["source"];
    const directory = filters.directory?.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
    const scoped = Boolean(directory && directory !== ".");
    const selectedPath = (path: string) => !scoped || path === directory || path.startsWith(`${directory}/`);
    const [directoryStart, directoryEnd] = scoped ? this.descendants(directory!) : [0, this.paths.length];
    const directoryIndex = scoped ? this.lowerBound(directory!) : -1;
    const selectedCount = (start: number, end: number) => categories.some(category =>
      this.counts[category][end]! > this.counts[category][start]!);
    const selectedDescendants = (start: number, end: number) => {
      const left = Math.max(start, directoryStart), right = Math.min(end, directoryEnd);
      return left < right && selectedCount(left, right)
        || scoped && directoryIndex >= start && directoryIndex < end && this.paths[directoryIndex] === directory
          && categories.includes(this.category(directory!));
    };
    const result = new Map<string, HistoryEvent>();
    for (const event of candidates) {
      if (!selectedEvent(event, filters)) continue;
      const paths = this.pathsByEvent.get(event.id) ?? [];
      let selected = paths.some(path => {
        if (this.files.has(path)) return selectedPath(path) && categories.includes(this.category(path));
        const [start, end] = this.descendants(path);
        return start < end ? selectedDescendants(start, end) : selectedPath(path) && categories.includes(this.category(path));
      });
      if (!paths.length && !event.path && !event.fragments.some(fragment => fragment.path) && event.cwd && isAbsolute(event.cwd) && categories.includes("unknown")) {
        const scope = relative(this.snapshot.repository.path, resolve(event.cwd));
        selected = scope !== ".." && !scope.startsWith(`..${sep}`) && !isAbsolute(scope) && selectedPath(scope.split(sep).join("/"));
      }
      if (selected && !result.has(event.id)) result.set(event.id, event);
    }
    return [...result.values()];
  }
}

/** 历史活动不要求文件仍在分母中；目录搜索按相关文件类别，无路径活动归未知类别。 */
export function filterHistoricalEvents(snapshot: AnalysisSnapshot, filters: Filters = {}): HistoryEvent[] {
  return new HistoricalEventIndex(snapshot).filter(filters);
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
  return { kind, message: `${mapping.filePath}: ${mapping.unknownReason}`, sourceId: event.sources[0]?.sourceId, count: 1,
    ...(mapping.unknownReasonDescriptors?.length ? { messageDescriptor: { key: "diagnostics.analysis.coverage.mappingUnknown", params: { path: mapping.filePath } }, details: mapping.unknownReasonDescriptors } : {}) };
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
    if (!gap.sourceId) return true;
    const source = snapshot.sources.find((source) => source.sourceId === gap.sourceId);
    return !source || selectedSource(source, filters);
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
