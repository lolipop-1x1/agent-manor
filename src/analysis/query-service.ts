import type { AnalysisSnapshot, CoverageQuery, FileDetail, Filters, HistoryEvent } from "../contracts.js";
import { AnalysisStore, StoreError } from "../index/store.js";
import type { SessionStore } from "../sessions/store.js";
import { contentHash, readCurrentFile, readEvidence } from "../service/files.js";
import { buildCoverage, eventFilePaths, filterEvents, filterHistoricalEvents, getHotspots, getUnreadFiles, selectedSource } from "./coverage.js";
import { mapClientOptions, mapSessions } from "./sessions.js";

export type MapOperation = "coverage" | "gaps" | "sessions" | "hotspots" | "unobserved" | "file" | "events" | "evidence" | "sources";
export interface MapQuery extends CoverageQuery {
  repositoryId: string; summary?: boolean; path?: string; eventId?: string; kind?: string; page?: number; pageSize?: number;
  metric?: "read" | "edit" | "activity"; limit?: number;
}
interface PreparedMap { snapshot: AnalysisSnapshot; eventParts: Map<string, number>; mappedPaths: Map<string, Set<string>> }

/** 仅缓存去正文元数据，原始工具输入输出在详情请求中按选中活动回读。 */
export class MapQueryService {
  private readonly snapshots = new Map<string, PreparedMap>();
  constructor(private readonly analysis: AnalysisStore, private readonly sessions: SessionStore) {}

  async execute(type: MapOperation, query: MapQuery) {
    const { repositoryId, version, summary, path, eventId, kind, page = 1, pageSize = 50, metric = "activity", limit = 20, ...filters } = query;
    if (type === "sources") {
      const result = this.analysis.listSources(repositoryId, version);
      if (!filters.client && !filters.sessionClient) return result;
      const sources = result.sources.filter(source => selectedSource(source, filters));
      const unassociated = result.unassociated.filter(source => selectedSource(source, filters));
      const ids = new Set([...sources, ...unassociated].map(source => source.sourceId));
      return { ...result, sources, unassociated, gaps: result.gaps.filter(gap => !gap.sourceId || ids.has(gap.sourceId)) };
    }
    const prepared = this.prepare(repositoryId, version);
    const snapshot = prepared.snapshot;
    if (type === "sessions") return { version: snapshot.version, clients: mapClientOptions(snapshot),
      sessions: mapSessions(snapshot, this.sessions.summariesByIdentity([...snapshot.sources, ...snapshot.events])) };
    if (type === "events" || type === "evidence") {
      const selected = filterHistoricalEvents(snapshot, filters).filter(event => (!kind || event.kind === kind)
        && (!path || this.hasPath(prepared, event, path)));
      if (type === "events") return { version: snapshot.version, events: this.events(prepared, selected.slice((page - 1) * pageSize, page * pageSize)), total: selected.length, page, pageSize };
      const event = selected.find(candidate => candidate.id === eventId);
      if (!event) throw new StoreError("EVENT_NOT_FOUND", "活动不在所选分析范围内", { key: "diagnostics.server.m018" });
      const full = this.events(prepared, [event])[0]!;
      const records = [], unavailable = [];
      for (const source of full.sources) {
        const record = await readEvidence(source);
        if (record) records.push(record); else unavailable.push(source);
      }
      return { version: snapshot.version, event: full, records, unavailable };
    }
    const coverage = buildCoverage(snapshot, filters as Filters);
    if (type === "coverage") return summary ? { ...coverage, gaps: [], gapCount: coverage.gaps.length } : coverage;
    if (type === "gaps") return { version: coverage.version, gaps: coverage.gaps };
    if (type === "hotspots") return { ...coverage, files: getHotspots(coverage, metric, limit) };
    if (type === "unobserved") return { ...coverage, files: getUnreadFiles(coverage) };
    const file = coverage.files.find(candidate => candidate.path === path);
    if (!file) throw new StoreError("FILE_NOT_FOUND", "文件不在所选分析范围内", { key: "diagnostics.server.m017" });
    let content: string | null = null, hash: string | undefined;
    try {
      const bytes = await readCurrentFile(snapshot.repository.path, path!);
      hash = contentHash(bytes);
      if (hash === file.hash) content = bytes.toString("utf8");
    } catch (error) {
      if (error instanceof StoreError || !["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    const events = this.events(prepared, filterEvents(snapshot, filters).filter(event => this.hasPath(prepared, event, path!)))
      .map(event => ({ ...event, mapping: content === null ? undefined : snapshot.mappings.find(mapping => mapping.eventId === event.id && mapping.filePath === path) }));
    return { repository: coverage.repository, version: coverage.version, baselineHash: coverage.baselineHash,
      createdAt: coverage.createdAt, stale: coverage.stale || content === null, filters: coverage.filters,
      previousVersion: coverage.previousVersion, file, content, contentHash: hash, contentStale: content === null, events } satisfies FileDetail;
  }

  private prepare(repositoryId: string, requested?: string): PreparedMap {
    const version = this.analysis.analysisVersion(repositoryId, requested);
    const key = JSON.stringify([repositoryId, version]);
    let prepared = this.snapshots.get(key);
    if (!prepared) {
      const eventParts = new Map<string, number>();
      const snapshot = this.analysis.getCoverageSnapshot(repositoryId, version, eventParts);
      const mappedPaths = new Map<string, Set<string>>();
      for (const mapping of snapshot.mappings) {
        if (!mappedPaths.has(mapping.eventId)) mappedPaths.set(mapping.eventId, new Set());
        mappedPaths.get(mapping.eventId)!.add(mapping.filePath);
      }
      prepared = { snapshot, eventParts, mappedPaths };
      if (this.snapshots.size >= 2) this.snapshots.delete(this.snapshots.keys().next().value!);
      this.snapshots.set(key, prepared);
    }
    const current = this.analysis.getRepository(repositoryId);
    const repository = { ...prepared.snapshot.repository, stale: current.stale || version !== current.version };
    return { ...prepared, snapshot: { ...prepared.snapshot, repository } };
  }

  private hasPath({ snapshot, mappedPaths }: PreparedMap, event: HistoryEvent, path: string): boolean {
    return eventFilePaths(event, snapshot.repository).includes(path)
      || mappedPaths.get(event.id)?.has(path) === true;
  }

  private events({ snapshot, eventParts }: PreparedMap, selected: HistoryEvent[]): HistoryEvent[] {
    const targets = new Map(selected.map(event => [event.id, eventParts.get(event.id)!]));
    const full = new Map(this.analysis.getSnapshotEvents(snapshot.repository.id, snapshot.version, targets).map(event => [event.id, event]));
    return selected.map(event => full.get(event.id)!);
  }
}
