import { isAbsolute, relative, resolve, sep } from "node:path";
import type { EvidenceResponse, HistoryEvent, Repository } from "../contracts.js";
import type { ReplayActivity, ReplayResult, ReplaySessionOption, ReplaySessionsResult, ReplayStep, ReplayTrack } from "../replay-contracts.js";
import { eventFilePaths } from "../analysis/coverage.js";
import { AnalysisStore, StoreError } from "../index/store.js";
import type { SessionStore } from "../sessions/store.js";
import type { ReplayMessageMetadata, ReplaySessionMetadata, ReplaySnapshot } from "./types.js";
import { readEvidence } from "../service/files.js";

interface ProjectedEvent {
  event: Pick<HistoryEvent, "id" | "client" | "sessionId" | "tool" | "kind" | "status" | "occurredAt" | "sources">;
  paths: string[];
}
interface PreparedReplay {
  version: string;
  sessionVersion: string;
  baselineHash: string;
  files: ReplayResult["files"];
  gaps: ReplayResult["gaps"];
  sessions: Map<string, ReplaySessionMetadata>;
  children: Map<string, string[]>;
  events: Map<string, ProjectedEvent[]>;
  eventOwners: Map<string, string>;
  eventParts: Map<string, number>;
  options: ReplaySessionOption[];
  results: Map<string, ReplayResult>;
}
interface OrderedStep extends ReplayStep { source?: string; position?: number; ordinal?: number }
const identity = (client: string, id: string) => JSON.stringify([client, id]);
const positionKey = (path: string, line: number) => JSON.stringify([path, line]);
const validTime = (value: string | undefined) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;

/** 两个版本共同限定回放内容；缓存只保存去正文投影，命中时仍检查版本是否存在。 */
export class ReplayService {
  private readonly prepared = new Map<string, PreparedReplay>();
  private readonly snapshots = new Map<string, ReplaySnapshot>();

  constructor(private readonly analysis: AnalysisStore, private readonly library: SessionStore) {}

  sessions(repositoryId: string, version?: string, sessionVersion?: string): ReplaySessionsResult {
    const prepared = this.prepare(repositoryId, version, sessionVersion);
    return { version: prepared.version, sessionVersion: prepared.sessionVersion, sessions: prepared.options };
  }

  async evidence(repositoryId: string, sessionId: string, eventId: string, version: string, sessionVersion: string): Promise<EvidenceResponse> {
    const prepared = this.prepare(repositoryId, version, sessionVersion);
    if (!prepared.sessions.has(sessionId)) throw new StoreError("SOURCE_NOT_FOUND", "会话不存在于当前索引版本", { key: "diagnostics.sessions.store.m011" });
    let owner = prepared.eventOwners.get(eventId);
    const visited = new Set<string>();
    while (owner && owner !== sessionId && !visited.has(owner)) {
      visited.add(owner);
      owner = prepared.sessions.get(owner)?.parentId;
    }
    const part = prepared.eventParts.get(eventId);
    if (owner !== sessionId || part === undefined) throw new StoreError("EVENT_NOT_FOUND", "活动不在所选分析范围内", { key: "diagnostics.server.m018" });
    const event = this.analysis.getReplayEvent(repositoryId, prepared.version, part, eventId);
    const records: EvidenceResponse["records"] = [];
    const unavailable: EvidenceResponse["unavailable"] = [];
    for (const source of event.sources) {
      const record = await readEvidence(source);
      if (record) records.push(record); else unavailable.push(source);
    }
    return { version: prepared.version, event, records, unavailable };
  }

  replay(repositoryId: string, sessionId: string, version?: string, sessionVersion?: string): ReplayResult {
    const prepared = this.prepare(repositoryId, version, sessionVersion);
    if (!prepared.sessions.has(sessionId)) throw new StoreError("SOURCE_NOT_FOUND", "会话不存在于当前索引版本", { key: "diagnostics.sessions.store.m011" });
    const repository = this.analysis.getRepository(repositoryId);
    const cached = prepared.results.get(sessionId);
    if (cached) return { ...cached, repository: { ...cached.repository, version: prepared.version, stale: repository.stale || prepared.version !== repository.version },
      stale: repository.stale || prepared.version !== repository.version };
    const members: { session: ReplaySessionMetadata; depth: number }[] = [];
    const pending = [{ session: prepared.sessions.get(sessionId)!, depth: 0 }];
    const included = new Set<string>();
    while (pending.length) {
      const member = pending.pop()!;
      if (included.has(member.session.id)) continue;
      included.add(member.session.id);
      members.push(member);
      const children = prepared.children.get(member.session.id) ?? [];
      for (let index = children.length - 1; index >= 0; index--) {
        pending.push({ session: prepared.sessions.get(children[index]!)!, depth: member.depth + 1 });
      }
    }
    const messages = this.library.replayMessages(prepared.sessionVersion, [...included].filter(id => prepared.events.get(id)?.length));
    const bySession = new Map<string, ReplayMessageMetadata[]>();
    for (const message of messages) {
      if (!bySession.has(message.sessionId)) bySession.set(message.sessionId, []);
      bySession.get(message.sessionId)!.push(message);
    }
    const tracks: ReplayTrack[] = [];
    const steps: ReplayStep[] = [];
    const gaps = [...prepared.gaps];
    let missingChildren = 0;
    for (const { session, depth } of members) {
      const events = prepared.events.get(session.id) ?? [];
      const trackSteps = projectSteps(session.id, events, bySession.get(session.id) ?? []);
      steps.push(...trackSteps);
      const confirmed = new Set(prepared.children.get(session.id) ?? []);
      missingChildren += new Set(session.childSessionIds.filter(child => !confirmed.has(child))).size;
      gaps.push(...session.gaps);
      tracks.push({ id: session.id, client: session.client, clientSessionId: session.clientSessionId, title: session.title,
        titleOrigin: session.titleOrigin, ...(depth ? { parentId: session.parentId } : {}), depth,
        eventCount: events.length, untimedCount: trackSteps.filter(step => step.time === undefined).length });
    }
    if (missingChildren) gaps.push({ kind: "unassociated", message: "明确子会话目标缺少来源或父子关联尚未确认，未纳入汇总",
      messageDescriptor: { key: "diagnostics.sessions.store.m017" }, count: missingChildren });
    // 同时刻不决定调用身份，也不补出跨轨先后；轨道内 order 保留来源顺序。
    steps.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || a.trackId.localeCompare(b.trackId) || a.order - b.order);
    let start = Infinity;
    let end = -Infinity;
    for (const step of steps) if (step.time !== undefined) { start = Math.min(start, step.time); end = Math.max(end, step.time); }
    const result: ReplayResult = { repository: { ...repository, version: prepared.version, stale: repository.stale || prepared.version !== repository.version },
      version: prepared.version, sessionVersion: prepared.sessionVersion, baselineHash: prepared.baselineHash,
      stale: repository.stale || prepared.version !== repository.version, sessionId, tracks, steps, files: prepared.files,
      range: start === Infinity ? null : { start, end }, missingChildren,
      totalActivities: tracks.reduce((count, track) => count + track.eventCount, 0), gaps };
    // 保留完整长回放；仅限制缓存数量，不截断实际活动。
    if (prepared.results.size >= 8) prepared.results.delete(prepared.results.keys().next().value!);
    prepared.results.set(sessionId, result);
    return result;
  }

  private prepare(repositoryId: string, requestedVersion?: string, requestedSessionVersion?: string): PreparedReplay {
    const version = this.analysis.analysisVersion(repositoryId, requestedVersion);
    const sessionVersion = this.library.usageVersion(requestedSessionVersion);
    const key = JSON.stringify([repositoryId, version, sessionVersion, 1]);
    const cached = this.prepared.get(key);
    if (cached) return cached;
    // 会话索引更新不改变仓库活动快照，避免为同一分析版本再次读取大段历史正文所在分块。
    const snapshotKey = JSON.stringify([repositoryId, version, 1]);
    let snapshot = this.snapshots.get(snapshotKey);
    if (!snapshot) {
      snapshot = this.analysis.getReplaySnapshot(repositoryId, version);
      if (this.snapshots.size >= 2) this.snapshots.delete(this.snapshots.keys().next().value!);
      this.snapshots.set(snapshotKey, snapshot);
    }
    const directory = this.library.replayDirectory(sessionVersion);
    const sessions = new Map(directory.sessions.map(session => [session.id, session]));
    const identities = new Map<string, string[]>();
    const children = new Map<string, string[]>();
    for (const session of directory.sessions) {
      const native = identity(session.client, session.clientSessionId);
      if (!identities.has(native)) identities.set(native, []);
      identities.get(native)!.push(session.id);
      if (session.parentId && sessions.has(session.parentId)) {
        if (!children.has(session.parentId)) children.set(session.parentId, []);
        children.get(session.parentId)!.push(session.id);
      }
    }
    const events = new Map<string, ProjectedEvent[]>();
    const eventOwners = new Map<string, string>();
    const mappingPaths = new Map<string, Set<string>>();
    for (const mapping of snapshot.mappings) {
      if (!mappingPaths.has(mapping.eventId)) mappingPaths.set(mapping.eventId, new Set());
      mappingPaths.get(mapping.eventId)!.add(mapping.filePath);
    }
    const seen = new Set<string>();
    for (const event of snapshot.events) {
      if (seen.has(event.id) || !["read", "edit", "search"].includes(event.kind)) continue;
      seen.add(event.id);
      const candidates = identities.get(identity(event.client, event.sessionId));
      // 原生身份出现多个索引目标时只接受明确的来源身份，不随意选取副本。
      const target = candidates?.length === 1 ? candidates[0] : candidates?.filter(id => event.sources.some(reference => reference.sourceId === sessions.get(id)!.sourceId));
      const id = typeof target === "string" ? target : target?.length === 1 ? target[0] : undefined;
      if (!id) continue;
      const paths = [...new Set([...eventFilePaths(event, snapshot.repository), ...(mappingPaths.get(event.id) ?? [])])];
      if (!paths.length && event.kind === "search" && event.cwd && withinRepository(event.cwd, snapshot.repository)) {
        paths.push(relative(snapshot.repository.path, resolve(event.cwd)).split(sep).join("/") || ".");
      }
      if (!paths.length) continue;
      const { id: eventId, client, sessionId, tool, kind, status, occurredAt, sources } = event;
      if (!events.has(id)) events.set(id, []);
      events.get(id)!.push({ event: { id: eventId, client, sessionId, tool, kind, status, occurredAt, sources }, paths });
      eventOwners.set(eventId, id);
    }
    const aggregate = new Map(directory.sessions.map(session => [session.id, { events: events.get(session.id)?.length ?? 0, tracks: 1, remaining: children.get(session.id)?.length ?? 0 }]));
    const queue = [...aggregate].filter(([, item]) => !item.remaining).map(([id]) => id);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!;
      const parentId = sessions.get(id)!.parentId;
      const parent = parentId ? aggregate.get(parentId) : undefined;
      if (!parent) continue;
      const child = aggregate.get(id)!;
      parent.events += child.events;
      parent.tracks += child.tracks;
      parent.remaining--;
      if (!parent.remaining) queue.push(parentId!);
    }
    const options = directory.sessions.filter(session => aggregate.get(session.id)!.events > 0).map(session => ({
      id: session.id, client: session.client, clientSessionId: session.clientSessionId, title: session.title, titleOrigin: session.titleOrigin,
      relationship: session.relationship, updatedAt: session.updatedAt,
      eventCount: aggregate.get(session.id)!.events, trackCount: aggregate.get(session.id)!.tracks,
    })).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.id.localeCompare(b.id));
    const prepared: PreparedReplay = { version, sessionVersion, baselineHash: snapshot.baselineHash,
      files: snapshot.files, gaps: snapshot.gaps,
      sessions, children, events, eventOwners, eventParts: snapshot.eventParts, options, results: new Map() };
    if (this.prepared.size >= 2) this.prepared.delete(this.prepared.keys().next().value!);
    this.prepared.set(key, prepared);
    return prepared;
  }
}

function withinRepository(path: string, repository: Repository): boolean {
  if (!isAbsolute(path)) return false;
  const local = relative(repository.path, resolve(path));
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function projectSteps(trackId: string, events: ProjectedEvent[], messages: ReplayMessageMetadata[]): ReplayStep[] {
  const calls = new Map<string, ReplayMessageMetadata[]>();
  const positions = new Map<string, ReplayMessageMetadata[]>();
  for (const message of messages) if (message.kind === "tool_call") {
    if (message.callId) {
      if (!calls.has(message.callId)) calls.set(message.callId, []);
      calls.get(message.callId)!.push(message);
    }
    const key = positionKey(message.sourcePath, message.recordLine);
    if (!positions.has(key)) positions.set(key, []);
    positions.get(key)!.push(message);
  }
  const groups = new Map<string, OrderedStep>();
  for (const { event, paths } of events) {
    const ids = [...new Set(event.sources.map(source => source.callId).filter((id): id is string => Boolean(id)))];
    const direct = new Map<string, ReplayMessageMetadata>();
    // 事件首引用是请求位置，后续结果和 fork 证明不能抢占另一条调用的请求顺序。
    const first = event.sources[0];
    for (const message of first ? positions.get(positionKey(first.path, first.recordLine)) ?? [] : []) {
      if ((!ids.length || message.callId && ids.includes(message.callId)) && (!message.tool || message.tool === event.tool)) direct.set(message.id, message);
    }
    // 重用的原生调用 ID 只靠精确来源位置消歧，不逐事件扫描全部同名调用。
    const native = ids.length === 1 ? calls.get(ids[0]!) : undefined;
    const unique = native?.length === 1 && (!native[0]!.tool || native[0]!.tool === event.tool) ? native[0] : undefined;
    const message = direct.size === 1 ? [...direct.values()][0] : !direct.size ? unique : undefined;
    const nativeKey = ids.length === 1 && first ? JSON.stringify([ids[0], first.sourceId, first.path, first.recordLine]) : undefined;
    const key = message ? `message:${message.id}` : nativeKey ? `call:${nativeKey}` : `event:${event.id}`;
    let step = groups.get(key);
    if (!step) {
      const occurredAt = validTime(event.occurredAt) !== undefined ? event.occurredAt : message?.occurredAt;
      const time = validTime(occurredAt);
      step = { id: `${trackId}:${key}`, trackId, order: groups.size, ...(time !== undefined ? { time, occurredAt } : {}),
        source: first?.path, position: first?.recordOrdinal ?? first?.recordLine, ordinal: message?.ordinal,
        ...(message?.durationMs !== undefined && Number.isFinite(message.durationMs) && message.durationMs >= 0 ? { durationMs: message.durationMs } : {}), activities: [] };
      groups.set(key, step);
    }
    const activity: ReplayActivity = { id: event.id, kind: event.kind, status: event.status, tool: event.tool, paths,
      ...(message ? { messageId: message.id } : {}) };
    step.activities.push(activity);
  }
  const steps = [...groups.values()];
  const allOrdinals = steps.every(step => step.ordinal !== undefined);
  const sources = new Set(steps.map(step => step.source));
  const oneSource = sources.size === 1 && !sources.has(undefined) && steps.every(step => step.position !== undefined);
  if (allOrdinals) steps.sort((a, b) => a.ordinal! - b.ordinal!);
  else if (oneSource) steps.sort((a, b) => a.position! - b.position!);
  return steps.map(({ source: _source, position: _position, ordinal: _ordinal, ...step }, index) => ({ ...step, order: index,
    orderKnown: allOrdinals || oneSource }));
}
