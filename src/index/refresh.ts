import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AnalysisSnapshot, Gap, HistoryEvent, ParsedSource, SourceSummary } from "../contracts.js";
import { eventFilePaths, getRepository, hashContent, mappingCacheKey, matchEvent, scanRepository } from "../analysis/index.js";
import { associateSource, canonicalPath, discoverSources, historicalWorktrees, normalizeHistoryPath, parseSource, resolveSharedHistory } from "../history/index.js";
import type { DiscoverRoots, ParsedHistorySource, SourceLocation } from "../history/index.js";
import { AnalysisStore } from "./store.js";
import type { RefreshStats } from "./store.js";

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

function inside(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return candidate === "" || (candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
}

function summary(source: ParsedSource, association?: "automatic" | "manual"): SourceSummary {
  const { sourceId, client, format, path, hash, sessionId, cwd, parentSessionId, completeBytes } = source;
  return { sourceId, client, format, path, hash, sessionId, cwd, parentSessionId, completeBytes, eventCount: source.events.length, association };
}

function candidateSummary(location: SourceLocation): SourceSummary {
  return { ...location, sourceId: location.sourceId ?? `${location.client}:unidentified:${hashContent(location.path).slice(0, 24)}`,
    sessionId: location.sessionId ?? `unknown:${hashContent(location.path).slice(0, 16)}`,
    hash: "", eventCount: 0, completeBytes: 0 };
}

/** 增量计算写入内存；成功后才提交缓存、结果版本和任务完成状态。 */
export async function refreshRepository(store: AnalysisStore, jobId: string, roots?: DiscoverRoots, clearCache = false): Promise<void> {
  const job = store.getJob(jobId);
  const repository = store.getRepository(job.repositoryId);
  store.updateJob(jobId, { status: "running", phase: "盘点当前仓库", progress: 0.05, startedAt: new Date().toISOString() });
  try {
    const baseline = await scanRepository(repository.path);
    let locations: SourceLocation[];
    try { locations = await discoverSources(roots); }
    catch (error) {
      // 发现与读取之间来源被移走时重新盘点一次；其他 I/O 错误不视为缺失。
      if (!missing(error)) throw error;
      locations = await discoverSources(roots);
    }
    const tracked = store.getTrackedSources(repository.id);
    const cached = clearCache ? [] : store.getParsedSources(repository.id);
    const manual = store.getManualAssociations(repository.id);
    const byPath = new Map(cached.map((source) => [source.path, source]));
    const byId = new Map(cached.map((source) => [source.sourceId, source]));
    const parsed: ParsedHistorySource[] = [];
    const parsedPaths = new Set<string>();
    const gaps: Gap[] = [];
    const stats: RefreshStats = { sourcesParsed: 0, parsedRecords: 0, mappingsComputed: 0, mappingsReused: 0 };
    const cwdAssociation = new Map<string, boolean>();
    const monitored = new Set(tracked.map((source) => source.sourceId));

    async function possible(location: SourceLocation): Promise<boolean> {
      if (byPath.has(location.path) || (location.sourceId && (byId.has(location.sourceId) || manual.has(location.sourceId) || monitored.has(location.sourceId)))) return true;
      const cwd = normalizeHistoryPath(location.cwd);
      if (!cwd || !isAbsolute(cwd)) return true;
      if (!cwdAssociation.has(cwd)) {
        let canonical = resolve(cwd);
        try { canonical = await realpath(cwd); } catch { /* 已删除目录仍能通过仓库内路径识别。 */ }
        let belongs = inside(repository.path, canonical);
        if (!belongs) {
          try { belongs = (await getRepository(cwd)).commonDir === repository.commonDir; }
          catch { /* 不可靠的 Git 关系不能自动跨仓库关联。 */ }
        }
        cwdAssociation.set(cwd, belongs);
      }
      return cwdAssociation.get(cwd)!;
    }

    async function parse(location: SourceLocation): Promise<void> {
      if (parsedPaths.has(location.path)) return;
      parsedPaths.add(location.path);
      try {
        const old = byPath.get(location.path) ?? (location.sourceId ? byId.get(location.sourceId) : undefined);
        const source = await parseSource(location.path, location.client, old, location.format);
        parsed.push(source);
        stats.sourcesParsed++;
        const cursor = source.cursor as { parsedRecords?: number } | undefined;
        stats.parsedRecords += cursor?.parsedRecords ?? 0;
      } catch (error) {
        if (!missing(error)) throw error;
        const known = byPath.get(location.path) ?? (location.sourceId ? byId.get(location.sourceId) : undefined);
        if (known && monitored.has(known.sourceId)) gaps.push({ kind: "source_missing", sourceId: known.sourceId, message: "已关联来源在读取前缺失；新版已排除该来源" });
      }
    }

    store.updateJob(jobId, { phase: "解析关联历史", progress: 0.2 });
    for (const location of locations) if (await possible(location)) await parse(location);
    const availableIds = new Set(parsed.map((source) => source.sourceId));
    for (const old of tracked) {
      if (availableIds.has(old.sourceId)) continue;
      const replacement = parsed.find((source) => source.path === old.path);
      if (replacement) {
        gaps.push({ kind: "source_missing", sourceId: old.sourceId, message: "原来源被不同会话替换；新版已排除原来源" });
        continue;
      }
      if (gaps.some((gap) => gap.sourceId === old.sourceId && gap.kind === "source_missing")) continue;
      try {
        // 已移出发现目录但仍在原路径的来源可续读；真正 ENOENT 才从新版排除。
        const source = await parseSource(old.path, old.client, clearCache ? undefined : byPath.get(old.path), old.format);
        parsed.push(source);
        availableIds.add(source.sourceId);
        stats.sourcesParsed++;
        stats.parsedRecords += (source.cursor as { parsedRecords?: number } | undefined)?.parsedRecords ?? 0;
      } catch (error) {
        if (!missing(error)) throw error;
        gaps.push({ kind: "source_missing", sourceId: old.sourceId, message: "已关联来源缺失；新版已排除该来源，可对照上一版" });
      }
    }

    // history_base 不一定出现在发现元数据中，包含已移出发现目录的登记来源后递归补齐父来源。
    for (let index = 0; index < parsed.length; index++) {
      const source = parsed[index]!;
      const parents = new Set([source.parentSessionId, ...source.relationships.map((relationship) => relationship.parentSessionId)].filter(Boolean));
      for (const location of locations) if (location.sessionId && parents.has(location.sessionId)) await parse(location);
    }

    let worktrees = await historicalWorktrees(parsed.flatMap(source => source.events), baseline);
    for (const location of locations) {
      const cwd = normalizeHistoryPath(location.cwd);
      if (!parsedPaths.has(location.path) && cwd && isAbsolute(cwd)) {
        const canonical = await canonicalPath(resolve(cwd));
        if (worktrees.some(tree => inside(tree.path, canonical))) await parse(location);
      }
    }
    const shared = resolveSharedHistory(parsed);
    const describedSources = parsed.map(source => {
      if (shared.invalidatedParentSourceIds.includes(source.sourceId)) return { ...source, parentSessionId: undefined };
      const parents = new Set(shared.relationships.filter(item => item.sourceId === source.sourceId && item.resolved && item.relationship.kind === "subagent")
        .map(item => item.relationship.parentSessionId));
      return parents.size === 1 ? { ...source, parentSessionId: [...parents][0] } : source;
    });
    worktrees = await historicalWorktrees(shared.events, baseline);
    const events = new Map<string, HistoryEvent>();
    const associated = new Set<string>();
    const sources: SourceSummary[] = [];
    const unassociated: SourceSummary[] = [];
    for (const source of describedSources) {
      const relevant = shared.events.filter((event) => event.sources.some((reference) => reference.sourceId === source.sourceId));
      // 手动关联只补无 cwd 的相对路径，不覆盖已有工作目录或外部绝对路径。
      const constrained = manual.has(source.sourceId) ? relevant.map((event) => ({ ...event, cwd: event.cwd ?? source.cwd ?? repository.path })) : relevant;
      const association = await associateSource({ ...source, events: constrained }, baseline, worktrees);
      if (association.associated || manual.has(source.sourceId)) {
        associated.add(source.sourceId);
        sources.push(summary(source, manual.has(source.sourceId) ? "manual" : "automatic"));
        gaps.push(...source.gaps, ...association.gaps.filter((gap) => gap.kind !== "unassociated"));
        for (const event of association.events) {
          // 文件路径已相对仓库；无路径活动保留已验证 cwd，供历史目录筛选。
          events.set(event.id, { ...event, cwd: event.path ? repository.path : event.cwd });
        }
      } else {
        unassociated.push(summary(source));
        gaps.push(...source.gaps, ...association.gaps);
      }
    }
    for (const location of locations) {
      if (!parsed.some((source) => source.path === location.path)) unassociated.push(candidateSummary(location));
    }
    const relatedParents = new Set(shared.relationships.filter((relationship) => associated.has(relationship.sourceId))
      .map((relationship) => relationship.relationship.parentSessionId));
    const snapshotSources = describedSources.filter((source) => associated.has(source.sourceId) || relatedParents.has(source.sessionId));
    gaps.push(...shared.gaps.filter((gap) => !gap.sourceId || associated.has(gap.sourceId)));
    const mappingEntries: { key: string; mapping: ReturnType<typeof matchEvent> }[] = [];
    const files = new Map(baseline.files.map((file) => [file.path, file]));
    const selectedEvents = [...events.values()];
    store.updateJob(jobId, { phase: "对应当前源码", progress: 0.6 });
    for (const event of selectedEvents) {
      if (event.kind !== "read" && event.kind !== "edit") continue;
      for (const path of eventFilePaths(event, baseline.repository)) {
        const file = files.get(path);
        if (!file) continue;
        const key = mappingCacheKey(event, file);
        const reused = clearCache ? undefined : store.getMapping(repository.id, key);
        const mapping = reused ?? matchEvent(event, file);
        if (reused) stats.mappingsReused++;
        else stats.mappingsComputed++;
        mappingEntries.push({ key, mapping });
      }
    }
    const version = randomUUID();
    const publishedRepository = { ...repository, version, stale: false };
    baseline.repository = { ...publishedRepository };
    const snapshot: AnalysisSnapshot = { repository: publishedRepository, version, baseline,
      sources: snapshotSources, events: selectedEvents, mappings: mappingEntries.map((entry) => entry.mapping),
      gaps: [...new Map(gaps.map((gap) => [JSON.stringify(gap), gap])).values()], createdAt: new Date().toISOString(), previousVersion: repository.version };
    store.updateJob(jobId, { phase: "发布完整结果", progress: 0.95 });
    store.publish({ snapshot, sources: { version, sources, unassociated, gaps: snapshot.gaps }, parsed, mappings: mappingEntries, stats, clearCache, jobId });
  } catch (error) {
    store.failJob(jobId, error instanceof Error ? error.message : String(error));
  }
}
