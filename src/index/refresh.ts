import { errorDescriptor } from "../i18n/diagnostics.js";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { AnalysisSnapshot, Gap, HistoryEvent, ParsedSource, SourceSummary } from "../contracts.js";
import { eventFilePaths, getRepository, hashContent, mappingCacheKey, MATCHING_RULE_VERSION, matchEvent, scanRepository } from "../analysis/index.js";
import { associateSource, associationMetadata, canonicalPath, createSourceAssociationCache, discoverSources, historicalWorktrees, normalizeHistoryPath, parseSource, resolveSharedHistory } from "../history/index.js";
import type { DiscoverRoots, ParsedHistorySource, SourceLocation } from "../history/index.js";
import { sourceLocationKey } from "../history/types.js";
import { AnalysisStore, JobCancelledError } from "./store.js";
import type { RefreshStats } from "./store.js";
import { sourceQuickStamp } from "../history/quick-check.js";
import { PARSER_RULE_VERSION } from "../version.js";

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

function inside(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return candidate === "" || (candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
}

function summary(source: ParsedSource, association?: "automatic" | "manual"): SourceSummary {
  const { sourceId, client, format, path, selector, hash, sessionId, cwd, parentSessionId, completeBytes } = source;
  return { sourceId, client, format, path, selector, hash, sessionId, cwd, parentSessionId, completeBytes, eventCount: source.events.length, association };
}

function candidateSummary(location: SourceLocation): SourceSummary {
  return { ...location, sourceId: location.sourceId ?? `${location.client}:unidentified:${hashContent(location.path).slice(0, 24)}`,
    sessionId: location.sessionId ?? `unknown:${hashContent(location.path).slice(0, 16)}`,
    hash: "", eventCount: 0, completeBytes: 0 };
}

function eventsBySource(events: HistoryEvent[]): Map<string, HistoryEvent[]> {
  const grouped = new Map<string, HistoryEvent[]>();
  for (const event of events) for (const sourceId of new Set(event.sources.map(reference => reference.sourceId))) {
    const collection = grouped.get(sourceId);
    if (collection) collection.push(event);
    else grouped.set(sourceId, [event]);
  }
  return grouped;
}

/** 增量计算写入内存；成功后才提交缓存、结果版本和任务完成状态。 */
export async function refreshRepository(store: AnalysisStore, jobId: string, roots?: DiscoverRoots, clearCache = false, isCancelled: () => boolean = () => false): Promise<void> {
  const job = store.findJob(jobId);
  if (!job || job.status !== "queued") return;
  const checkpoint = async () => {
    // 同步映射批次之间接收撤销消息，同时以数据库中的旧任务身份兜底。
    await setImmediate();
    if (isCancelled()) throw new JobCancelledError();
    store.assertRunningJob(jobId, job.repositoryId);
  };
  try {
    const repository = store.getRepository(job.repositoryId);
    store.updateJob(jobId, { status: "running", phase: "盘点当前仓库", phaseDescriptor: { key: "diagnostics.index.refresh.m001" }, progress: 0.05, startedAt: new Date().toISOString() });
    await checkpoint();
    const baseline = await scanRepository(repository.path);
    await checkpoint();
    const discoveryCache = clearCache ? [] : store.getDiscoveryCache(repository.id);
    let locations: SourceLocation[];
    try { locations = await discoverSources(roots, { cachedSources: discoveryCache }); }
    catch (error) {
      // 发现与读取之间来源被移走时重新盘点一次；其他 I/O 错误不视为缺失。
      if (!missing(error)) throw error;
      locations = await discoverSources(roots, { cachedSources: discoveryCache });
    }
    await checkpoint();
    const tracked = store.getTrackedSources(repository.id);
    const cached = clearCache ? [] : store.getParsedSourceLocations(repository.id);
    const manual = store.getManualAssociations(repository.id);
    const byPath = new Map(cached.map((source) => [sourceLocationKey(source), source]));
    const byId = new Map(cached.map((source) => [source.sourceId, source]));
    const parsed: ParsedHistorySource[] = [];
    const parsedPaths = new Set<string>();
    const metadataPaths = new Set<string>();
    const gaps: Gap[] = [];
    const stats: RefreshStats = { sourcesParsed: 0, parsedRecords: 0, mappingsComputed: 0, mappingsReused: 0, sourcesReused: 0 };
    const reusedParsed = new Set<string>();
    const cwdAssociation = new Map<string, boolean>();
    const associationCache = createSourceAssociationCache();
    const monitored = new Set(tracked.map((source) => source.sourceId));

    async function retain(source: ParsedHistorySource): Promise<ParsedHistorySource> {
      if ((source.cursor as { associationOnly?: boolean } | undefined)?.associationOnly) {
        parsed.push(source); metadataPaths.add(sourceLocationKey(source));
      } else if (manual.has(source.sourceId) || monitored.has(source.sourceId) || (await associateSource(source, baseline, [], associationCache)).associated) parsed.push(source);
      else { source = associationMetadata(source); parsed.push(source); metadataPaths.add(sourceLocationKey(source)); }
      return source;
    }

    async function readSource(location: SourceLocation): Promise<ParsedHistorySource> {
      await checkpoint();
      const previous = byPath.get(sourceLocationKey(location)) ?? (location.sourceId ? byId.get(location.sourceId) : undefined);
      const old = previous ? store.getParsedSource(repository.id, previous.sourceId, previous.path) as ParsedHistorySource | undefined : undefined;
      const oldCursor = old?.cursor as { ruleVersion?: string; format?: string; quickStamp?: string; associationOnly?: boolean;
        prefixHash?: string; pending?: unknown[]; recordEnds?: unknown[]; relationships?: unknown[] } | undefined;
      const compatibleCursor = oldCursor?.ruleVersion === PARSER_RULE_VERSION && oldCursor.format === location.format
        && typeof oldCursor.prefixHash === "string" && Array.isArray(oldCursor.pending) && Array.isArray(oldCursor.recordEnds) && Array.isArray(oldCursor.relationships);
      const before = await sourceQuickStamp(location);
      let source: ParsedHistorySource;
      if (!clearCache && old && compatibleCursor && before && before === oldCursor?.quickStamp
        && (!location.discoveryQuickStamp || location.discoveryQuickStamp === before)) {
        source = old;
        source.cursor = { ...oldCursor, parsedRecords: 0 } as ParsedHistorySource["cursor"];
        stats.sourcesReused = (stats.sourcesReused ?? 0) + 1;
      } else {
        source = await parseSource(location.path, location.client, old, location.format,
          { location, allowAssociationMetadata: !old || (!manual.has(old.sourceId) && !monitored.has(old.sourceId)) });
        stats.sourcesParsed++;
        stats.parsedRecords += (source.cursor as { parsedRecords?: number } | undefined)?.parsedRecords ?? 0;
      }
      await checkpoint();
      const after = before && await sourceQuickStamp(location);
      if (source.cursor && typeof source.cursor === "object" && !Array.isArray(source.cursor)) {
        source.cursor = { ...source.cursor, quickStamp: after === before ? before : undefined } as ParsedHistorySource["cursor"];
      }
      const retained = await retain(source);
      // 同一内容和同一解析依赖的游标分块保持不变；快检标记、计数只更新小头部。
      if (!clearCache && old && compatibleCursor && source.hash === old.hash
        && source.sourceId === old.sourceId && source.path === old.path && source.client === old.client && source.format === old.format
        && source.selector === old.selector && source.sessionId === old.sessionId && source.cwd === old.cwd
        && source.parentSessionId === old.parentSessionId
        && Boolean((retained.cursor as { associationOnly?: boolean } | undefined)?.associationOnly) === Boolean(oldCursor?.associationOnly)) {
        reusedParsed.add(JSON.stringify([source.sourceId, source.path]));
      }
      return retained;
    }

    async function possible(location: SourceLocation): Promise<boolean> {
      if (byPath.has(sourceLocationKey(location)) || (location.sourceId && (byId.has(location.sourceId) || manual.has(location.sourceId) || monitored.has(location.sourceId)))) return true;
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
      if (parsedPaths.has(sourceLocationKey(location))) return;
      parsedPaths.add(sourceLocationKey(location));
      try {
        await readSource(location);
      } catch (error) {
        if (!missing(error)) throw error;
        const known = byPath.get(sourceLocationKey(location)) ?? (location.sourceId ? byId.get(location.sourceId) : undefined);
        if (known && monitored.has(known.sourceId)) gaps.push({ kind: "source_missing", sourceId: known.sourceId, message: "已关联来源在读取前缺失；新版已排除该来源", messageDescriptor: { key: "diagnostics.index.refresh.m002" } });
      }
    }

    store.updateJob(jobId, { phase: "解析关联历史", phaseDescriptor: { key: "diagnostics.index.refresh.m003" }, progress: 0.2 });
    for (const [index, location] of locations.entries()) {
      if (index % 32 === 0) await checkpoint();
      if (await possible(location)) await parse(location);
      if ((index + 1) % 32 === 0 || index === locations.length - 1) store.updateJob(jobId, { progress: 0.2 + 0.35 * (index + 1) / locations.length });
    }
    const availableIds = new Set(parsed.map((source) => source.sourceId));
    for (const old of tracked) {
      if (availableIds.has(old.sourceId)) continue;
      const replacement = parsed.find((source) => sourceLocationKey(source) === sourceLocationKey(old));
      if (replacement) {
        gaps.push({ kind: "source_missing", sourceId: old.sourceId, message: "原来源被不同会话替换；新版已排除原来源", messageDescriptor: { key: "diagnostics.index.refresh.m004" } });
        continue;
      }
      if (gaps.some((gap) => gap.sourceId === old.sourceId && gap.kind === "source_missing")) continue;
      try {
        // 已移出发现目录但仍在原路径的来源可续读；真正 ENOENT 才从新版排除。
        const source = await readSource(old);
        availableIds.add(source.sourceId);
      } catch (error) {
        if (!missing(error)) throw error;
        gaps.push({ kind: "source_missing", sourceId: old.sourceId, message: "已关联来源缺失；新版已排除该来源，可对照上一版", messageDescriptor: { key: "diagnostics.index.refresh.m005" } });
      }
    }

    // history_base 不一定出现在发现元数据中，包含已移出发现目录的登记来源后递归补齐父来源。
    for (let index = 0; index < parsed.length; index++) {
      const source = parsed[index]!;
      const parents = new Set([source.parentSessionId, ...source.relationships.map((relationship) => relationship.parentSessionId)].filter(Boolean));
      for (const location of locations) if (location.sessionId && parents.has(location.sessionId)) await parse(location);
    }

    let worktrees = await historicalWorktrees(parsed.flatMap(source => source.events), baseline);
    await checkpoint();
    for (const location of locations) {
      const cwd = normalizeHistoryPath(location.cwd);
      if (!parsedPaths.has(sourceLocationKey(location)) && cwd && isAbsolute(cwd)) {
        const canonical = await canonicalPath(resolve(cwd));
        if (worktrees.some(tree => inside(tree.path, canonical))) await parse(location);
      }
    }
    // 历史 worktree 与跨会话证明可能使先前未知的来源相关；确认后再读完整正文。
    let shared = resolveSharedHistory(parsed);
    let grouped = eventsBySource(shared.events);
    const required = new Set<string>();
    for (const source of parsed) {
      const relevant = grouped.get(source.sourceId) ?? [];
      if (manual.has(source.sourceId) || (await associateSource({ ...source, events: relevant }, baseline, worktrees, associationCache)).associated) required.add(source.sourceId);
    }
    for (;;) {
      const size = required.size;
      for (const relationship of shared.relationships) {
        if (required.has(relationship.sourceId)) for (const parent of parsed) {
          if (parent.sessionId === relationship.relationship.parentSessionId
            && parent.client === parsed.find(source => source.sourceId === relationship.sourceId)?.client) required.add(parent.sourceId);
        }
      }
      if (required.size === size) break;
    }
    let hydrated = false;
    for (let index = 0; index < parsed.length; index++) {
      const source = parsed[index]!;
      if (metadataPaths.has(sourceLocationKey(source)) && required.has(source.sourceId)) {
        const before = await sourceQuickStamp(source);
        parsed[index] = await parseSource(source.path, source.client, undefined, source.format, { location: source });
        await checkpoint();
        reusedParsed.delete(JSON.stringify([source.sourceId, source.path]));
        const after = before && await sourceQuickStamp(source);
        const cursor = parsed[index]!.cursor;
        if (cursor && typeof cursor === "object" && !Array.isArray(cursor)) {
          parsed[index]!.cursor = { ...cursor, quickStamp: after === before ? before : undefined } as ParsedHistorySource["cursor"];
        }
        metadataPaths.delete(sourceLocationKey(source));
        hydrated = true;
        stats.parsedRecords += (parsed[index]!.cursor as { parsedRecords?: number } | undefined)?.parsedRecords ?? 0;
      }
    }
    if (hydrated) { shared = resolveSharedHistory(parsed); grouped = eventsBySource(shared.events); }
    const describedSources = parsed.map(source => {
      if (shared.invalidatedParentSourceIds.includes(source.sourceId)) return { ...source, parentSessionId: undefined };
      const parents = new Set(shared.relationships.filter(item => item.sourceId === source.sourceId && item.resolved && item.relationship.kind === "subagent")
        .map(item => item.relationship.parentSessionId));
      return parents.size === 1 ? { ...source, parentSessionId: [...parents][0] } : source;
    });
    worktrees = await historicalWorktrees(shared.events, baseline);
    await checkpoint();
    const events = new Map<string, HistoryEvent>();
    const associated = new Set<string>();
    const sources: SourceSummary[] = [];
    const unassociated: SourceSummary[] = [];
    for (const source of describedSources) {
      const relevant = grouped.get(source.sourceId) ?? [];
      // 手动关联只补无 cwd 的相对路径，不覆盖已有工作目录或外部绝对路径。
      const constrained = manual.has(source.sourceId) ? relevant.map((event) => ({ ...event, cwd: event.cwd ?? source.cwd ?? repository.path })) : relevant;
      const association = await associateSource({ ...source, events: constrained }, baseline, worktrees, associationCache);
      await checkpoint();
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
      }
    }
    for (const location of locations) {
      if (!parsed.some((source) => sourceLocationKey(source) === sourceLocationKey(location))) unassociated.push(candidateSummary(location));
    }
    const relatedParents = new Set(shared.relationships.filter((relationship) => associated.has(relationship.sourceId))
      .map((relationship) => relationship.relationship.parentSessionId));
    const snapshotSources = describedSources.filter((source) => associated.has(source.sourceId) || relatedParents.has(source.sessionId));
    gaps.push(...shared.gaps.filter((gap) => !gap.sourceId || associated.has(gap.sourceId)));
    const mappingEntries: { key: string; mapping: ReturnType<typeof matchEvent> }[] = [];
    const files = new Map(baseline.files.map((file) => [file.path, file]));
    const selectedEvents = [...events.values()];
    // 归属还受当前路径、worktree 和关系证明影响；正文哈希相同也不能略过这些派生结果。
    const resolvedEventsHash = createHash("sha256");
    for (const event of selectedEvents) resolvedEventsHash.update(JSON.stringify([event.id, event.client, event.sessionId, event.parentSessionId,
      event.cwd, event.path, event.kind, event.status, event.reason, event.reasonDescriptor,
      event.fragments.map(fragment => [fragment.kind, fragment.path, fragment.historicalStart, fragment.completeLines]), event.sources]));
    stats.resultFingerprint = hashContent(JSON.stringify([PARSER_RULE_VERSION, MATCHING_RULE_VERSION,
      baseline.hash, baseline.git, baseline.excluded, describedSources.map(source => summary(source)), sources, unassociated,
      resolvedEventsHash.digest("hex"), [...manual].sort(), [...new Map(gaps.map(gap => [JSON.stringify(gap), gap])).values()]]));
    const reusedVersion = !clearCache && repository.version
      && store.getRefreshStats(repository.id, repository.version).resultFingerprint === stats.resultFingerprint ? repository.version : undefined;
    store.updateJob(jobId, { phase: "对应当前源码", phaseDescriptor: { key: "diagnostics.index.refresh.m006" }, progress: 0.6 });
    for (const [index, event] of selectedEvents.entries()) {
      if (index % 32 === 0) await checkpoint();
      if (event.kind !== "read" && event.kind !== "edit") continue;
      for (const path of eventFilePaths(event, baseline.repository)) {
        const file = files.get(path);
        if (!file) continue;
        if (reusedVersion) { stats.mappingsReused++; continue; }
        const key = mappingCacheKey(event, file);
        const reused = clearCache ? undefined : store.getMapping(repository.id, key);
        const mapping = reused ?? matchEvent(event, file);
        if (reused) stats.mappingsReused++;
        else stats.mappingsComputed++;
        mappingEntries.push({ key, mapping });
      }
    }
    const version = reusedVersion ?? randomUUID();
    const publishedRepository = { ...repository, version, stale: false };
    baseline.repository = { ...publishedRepository };
    const snapshot: AnalysisSnapshot = { repository: publishedRepository, version, baseline,
      sources: snapshotSources, events: selectedEvents, mappings: mappingEntries.map((entry) => entry.mapping),
      gaps: [...new Map(gaps.map((gap) => [JSON.stringify(gap), gap])).values()], createdAt: new Date().toISOString(), previousVersion: repository.version };
    await checkpoint();
    store.updateJob(jobId, { phase: "发布完整结果", phaseDescriptor: { key: "diagnostics.index.refresh.m007" }, progress: 0.95 });
    store.publish({ snapshot, sources: { version, sources, unassociated, gaps: snapshot.gaps },
      parsed, mappings: mappingEntries, stats, clearCache, jobId, reusedParsed, reusedVersion });
  } catch (error) {
    if (error instanceof JobCancelledError || !store.findJob(jobId)) return;
    store.failJob(jobId, error instanceof Error ? error.message : String(error), errorDescriptor(error));
  }
}
