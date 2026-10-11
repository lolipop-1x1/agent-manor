import { buildCoverage, filterHistoricalEvents, getHotspots } from "../analysis/coverage.js";
import type { AnalysisSnapshot, CoverageResult, HistoryEvent, Repository } from "../contracts.js";
import { StoreError, type AnalysisStore } from "../index/store.js";
import type { OverviewPeriod, OverviewQuery, OverviewRange, OverviewRepository, OverviewSource } from "../overview-contracts.js";
import { localDay } from "./dates.js";

function activity(snapshot: AnalysisSnapshot): NonNullable<OverviewRepository["activity"]> {
  const events = filterHistoricalEvents(snapshot);
  return { read: events.filter(event => event.kind === "read" && event.status === "success").length,
    edit: events.filter(event => event.kind === "edit" && event.status === "success").length,
    failure: events.filter(event => event.status === "failure").length };
}

function periodSnapshot(snapshot: AnalysisSnapshot, period: OverviewPeriod, timezone: string, all = false): AnalysisSnapshot {
  return { ...snapshot, events: snapshot.events.filter(event => {
    if (all) return true;
    const day = localDay(event.occurredAt, timezone);
    return day !== null && day >= period.from && day <= period.to;
  }) };
}

/** 两期共用一次读取的完整快照，文件分母与映射规则不会随比较日期改变。 */
export function buildOverviewRepositories(store: AnalysisStore, repositories: Repository[], source: OverviewSource,
  query: OverviewQuery, range: OverviewRange, timezone: string): OverviewRepository[] {
  const projects = query.projects?.length ? new Set(query.projects) : null;
  const clients = query.clients?.length ? new Set(query.clients) : null;
  const identities = new Map(source.sessions.map(session => [JSON.stringify([session.client, session.clientSessionId]), session]));
  const result: OverviewRepository[] = [];
  for (const repository of repositories) {
    if (!repository.version) {
      if (!projects || projects.has(repository.path)) result.push({ repository, state: "unready", hotspots: [], gapCount: 0 });
      continue;
    }
    let snapshot: AnalysisSnapshot;
    try { snapshot = store.getSnapshot(repository.id, repository.version); }
    catch (error) {
      if (!(error instanceof StoreError)) throw error;
      if (!projects || projects.has(repository.path)) result.push({ repository, version: repository.version,
        state: "unavailable", hotspots: [], gapCount: 0 });
      continue;
    }
    const matches = (event: Pick<HistoryEvent, "client" | "sessionId">) => {
      if (clients && !clients.has(event.client)) return false;
      if (!projects) return true;
      const summary = identities.get(JSON.stringify([event.client, event.sessionId]));
      return summary?.project !== undefined && projects.has(summary.project);
    };
    if (projects && !projects.has(repository.path) && !snapshot.events.some(matches)) continue;
    const sources = snapshot.sources.filter(matches), sourceIds = new Set(sources.map(item => item.sourceId));
    snapshot = { ...snapshot, repository: { ...snapshot.repository, stale: repository.stale || snapshot.repository.stale },
      events: snapshot.events.filter(matches), sources,
      gaps: snapshot.gaps.filter(gap => !gap.sourceId || sourceIds.has(gap.sourceId)) };
    const selected = periodSnapshot(snapshot, range, timezone, range.all), coverage = buildCoverage(selected);
    let current: AnalysisSnapshot | undefined, previous: AnalysisSnapshot | undefined;
    let currentCoverage: CoverageResult | undefined, previousCoverage: CoverageResult | undefined;
    if (range.comparison) {
      current = periodSnapshot(snapshot, range.comparison.current, timezone);
      previous = periodSnapshot(snapshot, range.comparison.previous, timezone);
      currentCoverage = buildCoverage(current); previousCoverage = buildCoverage(previous);
    }
    const paths = new Set([coverage, currentCoverage, previousCoverage].flatMap(item => item ? getHotspots(item, "activity", 5).map(file => file.path) : []));
    const byPath = new Map(coverage.files.map(file => [file.path, file]));
    const currentByPath = new Map(currentCoverage?.files.map(file => [file.path, file]));
    const previousByPath = new Map(previousCoverage?.files.map(file => [file.path, file]));
    const counts = (file: CoverageResult["files"][number]) => ({ read: file.readCount, edit: file.editCount, failure: file.failedCount });
    result.push({ repository: snapshot.repository, state: "ready", version: snapshot.version,
      baselineHash: snapshot.baseline.hash, createdAt: snapshot.createdAt, summary: coverage.summary,
      readCoveredFiles: coverage.files.filter(file => file.readExactLines + file.readNearLines > 0).length,
      editCoveredFiles: coverage.files.filter(file => file.editExactLines + file.editNearLines > 0).length,
      activity: activity(selected), comparisonSummary: currentCoverage?.summary, previousSummary: previousCoverage?.summary,
      comparisonActivity: current && activity(current), previousActivity: previous && activity(previous),
      hotspots: [...paths].map(path => ({ path, ...counts(byPath.get(path)!),
        ...(currentByPath.has(path) ? { comparison: counts(currentByPath.get(path)!) } : {}),
        ...(previousByPath.has(path) ? { previous: counts(previousByPath.get(path)!) } : {}) })),
      gapCount: coverage.gaps.length });
  }
  return result;
}
