import Database from "better-sqlite3";
import { chmodSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { OverviewActivity, OverviewEvent, OverviewQuery, OverviewRange, OverviewReport, OverviewSource } from "../overview-contracts.js";
import type { ResourceUsageEvent } from "../resource-contracts.js";
import type { UsageReport } from "../usage-contracts.js";
import type { SessionStore } from "../sessions/store.js";
import { StoreError } from "../index/store.js";
import { isActivityEvent, knownResourceIdentity, matchesGlobalSession, pairToolCalls, resourceIdentity, validResource } from "./analytics.js";
import { activityTime, addDays, localDay, prepareOverviewDateCache, resolveOverviewRange, resolveTimezone } from "./dates.js";

const format = 1;
const maximumBytes = 768 * 1024 * 1024;
export type OverviewFactPurpose = "resources" | "process" | "requests" | "evidence";
export interface OverviewFactOptions { fullSessions?: boolean; sessionIds?: string[]; eventKinds?: OverviewEvent["kind"][] }
export type OverviewCore = Pick<OverviewReport, "summary" | "totals" | "activity" | "facets" | "coverage">;
interface FactRow { id: string; time_ms: number | null; json: string }
interface Bucket { revision: string; day: string; hour: number; events: number; requests: number; tools: number; rhythm: number }
interface Scope { source: OverviewSource; range: OverviewRange; timezone: string; revisions: string[] }

/** 可重建窄事实按不可变修订保存；完整版本关系在读取时绑定。 */
export class OverviewFactStore {
  private database!: Database.Database;
  private readonly path: string;
  private readonly maxBytes: number;
  private memory = false;
  private pending = new Map<string, Promise<void>>();
  private metadata?: { version: string; source: OverviewSource; rows: ReturnType<SessionStore["usageFactSessions"]>["sessions"] };
  private pruneVersion?: string;

  constructor(private readonly sessions: SessionStore, options: { path?: string; maxBytes?: number } = {}) {
    this.path = options.path ?? join(dirname(sessions.dbPath), "overview-facts.sqlite");
    this.maxBytes = options.maxBytes ?? maximumBytes;
    try {
      this.database = new Database(this.path);
      chmodSync(this.path, 0o600);
      this.initialize();
      this.limitDisk();
    } catch {
      try { this.database!.close(); } catch { /* 不可写或损坏的派生库使用内存回退。 */ }
      this.memory = true; this.database = new Database(":memory:"); this.initialize();
    }
  }

  private initialize(): void {
    this.database.pragma("foreign_keys=ON");
    this.database.pragma("busy_timeout=5000");
    this.database.pragma("journal_mode=DELETE");
    this.database.pragma("synchronous=NORMAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS overview_fact_revisions (
        revision TEXT PRIMARY KEY, session_id TEXT NOT NULL, format INTEGER NOT NULL, events INTEGER NOT NULL, requests INTEGER NOT NULL,
        resources INTEGER NOT NULL, accessed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS overview_fact_events (
        revision TEXT NOT NULL REFERENCES overview_fact_revisions(revision) ON DELETE CASCADE,
        id TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL, active INTEGER NOT NULL,
        time_ms REAL, json TEXT NOT NULL, PRIMARY KEY(revision,id));
      CREATE TABLE IF NOT EXISTS overview_fact_requests (
        revision TEXT NOT NULL REFERENCES overview_fact_revisions(revision) ON DELETE CASCADE,
        id TEXT NOT NULL, ordinal INTEGER NOT NULL, time_ms REAL, occurred_at TEXT, model TEXT,
        input_tokens REAL, output_tokens REAL, message_id TEXT, members_json TEXT, json TEXT NOT NULL, PRIMARY KEY(revision,id));
      CREATE TABLE IF NOT EXISTS overview_fact_resources (
        revision TEXT NOT NULL REFERENCES overview_fact_revisions(revision) ON DELETE CASCADE,
        id TEXT NOT NULL, ordinal INTEGER NOT NULL, time_ms REAL, resource_id TEXT NOT NULL, known INTEGER NOT NULL,
        valid INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(revision,id));
      CREATE TABLE IF NOT EXISTS overview_fact_members (
        revision TEXT NOT NULL REFERENCES overview_fact_revisions(revision) ON DELETE CASCADE,
        request_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(revision,request_id,event_id));
      CREATE TABLE IF NOT EXISTS overview_fact_time_revisions (
        revision TEXT NOT NULL REFERENCES overview_fact_revisions(revision) ON DELETE CASCADE,
        timezone TEXT NOT NULL, PRIMARY KEY(revision,timezone));
      CREATE TABLE IF NOT EXISTS overview_fact_buckets (
        revision TEXT NOT NULL REFERENCES overview_fact_revisions(revision) ON DELETE CASCADE,
        timezone TEXT NOT NULL, day TEXT NOT NULL, hour INTEGER NOT NULL,
        events INTEGER NOT NULL, requests INTEGER NOT NULL, tools INTEGER NOT NULL, rhythm INTEGER NOT NULL,
        PRIMARY KEY(revision,timezone,day,hour));
      CREATE TABLE IF NOT EXISTS overview_fact_times (
        revision TEXT NOT NULL REFERENCES overview_fact_revisions(revision) ON DELETE CASCADE,
        timezone TEXT NOT NULL, family TEXT NOT NULL, id TEXT NOT NULL, day TEXT,
        PRIMARY KEY(revision,timezone,family,id));
      CREATE INDEX IF NOT EXISTS overview_fact_time_range ON overview_fact_times(timezone,family,day,revision);
      CREATE TABLE IF NOT EXISTS overview_fact_cross_links (
        revision TEXT NOT NULL REFERENCES overview_fact_revisions(revision) ON DELETE CASCADE,
        timezone TEXT NOT NULL, request_id TEXT NOT NULL, day TEXT NOT NULL, hour INTEGER NOT NULL, linked_day TEXT NOT NULL,
        PRIMARY KEY(revision,timezone,request_id,linked_day));
    `);
  }

  /** 每个修订事务完成后让出执行，其他前台分区可以合作调度。 */
  async prepare(query: OverviewQuery = {}, now = new Date()): Promise<void> {
    const source = this.meta(query.version), timezone = resolveTimezone(query.timezone);
    // 日期参数在任何派生写入之前校验。
    resolveOverviewRange(source.source,
      { ...query, window: query.window === "all" ? "custom" : query.window, timezone }, now);
    prepareOverviewDateCache(source.version, timezone);
    if (this.pruneVersion !== source.version) {
      this.database.prepare("DELETE FROM overview_fact_revisions WHERE revision NOT IN (SELECT value FROM json_each(?))")
        .run(JSON.stringify(this.sessions.overviewRetainedRevisions()));
      this.pruneVersion = source.version;
    }
    for (const { revision, session } of source.rows) {
      const key = JSON.stringify([revision, timezone]);
      let operation = this.pending.get(key);
      if (!operation) {
        operation = (async () => {
          if (!this.ready(revision)) this.prepareRevision(revision, session.id, source.version);
          if (!this.database.prepare("SELECT 1 FROM overview_fact_time_revisions WHERE revision=? AND timezone=?").get(revision, timezone)) {
            this.prepareTimes(revision, timezone);
          }
          this.limitDisk();
          await nextTurn();
        })();
        this.pending.set(key, operation);
      }
      try { await operation; } finally { if (this.pending.get(key) === operation) this.pending.delete(key); }
    }
    // 查询完成前重新检查发布版本，已淘汰版本不能借派生事实继续访问。
    this.sessions.usageVersion(source.version);
  }

  private ready(revision: string): boolean {
    const row = this.database.prepare(`SELECT format,events,requests,resources,
      (SELECT COUNT(*) FROM overview_fact_events WHERE revision=r.revision) AS event_count,
      (SELECT COUNT(*) FROM overview_fact_requests WHERE revision=r.revision) AS request_count,
      (SELECT COUNT(*) FROM overview_fact_resources WHERE revision=r.revision) AS resource_count
      FROM overview_fact_revisions r WHERE revision=?`).get(revision) as {
        format: number; events: number; requests: number; resources: number; event_count: number; request_count: number; resource_count: number } | undefined;
    return !!row && row.format === format && row.events === row.event_count && row.requests === row.request_count && row.resources === row.resource_count;
  }

  private prepareRevision(revision: string, sessionId: string, version: string): void {
    const facts = this.sessions.overviewRevisionFacts(revision, sessionId);
    const resources = [...this.sessions.resourceEvents({ version }, undefined, revision).events];
    const calls = new Map(pairToolCalls(facts.events.filter(isActivityEvent)).map(event => [event.id, event]));
    this.database.transaction(() => {
      if (this.ready(revision)) return;
      this.database.prepare("DELETE FROM overview_fact_revisions WHERE revision=?").run(revision);
      this.database.prepare("INSERT INTO overview_fact_revisions VALUES(?,?,?,?,?,?,?)")
        .run(revision, sessionId, format, facts.events.length, facts.requests.length, resources.length, Date.now());
      const eventWrite = this.database.prepare("INSERT INTO overview_fact_events VALUES(?,?,?,?,?,?,?)");
      for (const raw of facts.events) {
        const event = calls.get(raw.id) ?? raw;
        eventWrite.run(revision, event.id, event.ordinal, event.kind, Number(isActivityEvent(event)),
          time(event.occurredAt), JSON.stringify(event));
      }
      const requestWrite = this.database.prepare("INSERT INTO overview_fact_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)");
      const memberWrite = this.database.prepare("INSERT OR IGNORE INTO overview_fact_members VALUES(?,?,?)");
      for (const request of facts.requests) {
        const { requestMessageIds, ...usage } = request.usage;
        requestWrite.run(revision, usage.id, request.ordinal!, time(usage.occurredAt), usage.occurredAt ?? null,
          usage.model ?? null, finite(usage.inputTokens), finite(usage.outputTokens), usage.messageId ?? null,
          requestMessageIds === undefined ? null : JSON.stringify(requestMessageIds),
          JSON.stringify({ ...request, usage }));
        for (const id of new Set([usage.messageId, ...(requestMessageIds ?? []),
          usage.timing?.end?.source !== "mirror" ? usage.timing?.end?.messageId : undefined])) {
          if (id !== undefined) memberWrite.run(revision, usage.id, id);
        }
      }
      const resourceWrite = this.database.prepare("INSERT INTO overview_fact_resources VALUES(?,?,?,?,?,?,?,?)");
      for (const resource of resources) resourceWrite.run(revision, resource.id, resource.ordinal, time(resource.occurredAt),
        resourceIdentity(resource), Number(knownResourceIdentity(resource)), Number(validResource(resource)), JSON.stringify(resource));
    }).immediate();
  }

  private prepareTimes(revision: string, timezone: string): void {
    const events = this.database.prepare("SELECT id,time_ms,kind,active FROM overview_fact_events WHERE revision=?").all(revision) as {
      id: string; time_ms: number | null; kind: string; active: number }[];
    const requests = this.database.prepare("SELECT id,time_ms FROM overview_fact_requests WHERE revision=? ORDER BY ordinal").all(revision) as FactRow[];
    const resources = this.database.prepare("SELECT id,time_ms FROM overview_fact_resources WHERE revision=?").all(revision) as FactRow[];
    const members = new Map<string, string[]>();
    for (const row of this.database.prepare("SELECT request_id,event_id FROM overview_fact_members WHERE revision=?").all(revision) as { request_id: string; event_id: string }[]) {
      const group = members.get(row.request_id) ?? []; group.push(row.event_id); members.set(row.request_id, group);
    }
    const buckets = new Map<string, Bucket>(), activeEventDays = new Map<string, string>();
    const bucket = (milliseconds: number) => {
      const { weekday: _weekday, hour } = activityTime(new Date(milliseconds).toISOString(), timezone)!;
      const day = localDay(milliseconds, timezone)!, key = `${day}:${hour}`;
      let row = buckets.get(key);
      if (!row) { row = { revision, day, hour, events: 0, requests: 0, tools: 0, rhythm: 0 }; buckets.set(key, row); }
      return row;
    };
    this.database.transaction(() => {
      if (this.database.prepare("SELECT 1 FROM overview_fact_time_revisions WHERE revision=? AND timezone=?").get(revision, timezone)) return;
      const times = this.database.prepare("INSERT INTO overview_fact_times VALUES(?,?,?,?,?)");
      for (const row of events) {
        const day = row.time_ms === null ? null : localDay(row.time_ms, timezone);
        times.run(revision, timezone, "event", row.id, day);
        if (!row.active || row.time_ms === null) continue;
        activeEventDays.set(row.id, day!);
        const group = bucket(row.time_ms); group.events += 1; group.rhythm += 1;
        if (row.kind === "tool_call") group.tools += 1;
      }
      const cross = this.database.prepare("INSERT INTO overview_fact_cross_links VALUES(?,?,?,?,?,?)");
      for (const row of requests) {
        const day = row.time_ms === null ? null : localDay(row.time_ms, timezone);
        times.run(revision, timezone, "request", row.id, day);
        if (row.time_ms === null) continue;
        const group = bucket(row.time_ms); group.requests += 1;
        const linkedDays = new Set((members.get(row.id) ?? []).flatMap(id => activeEventDays.get(id) ?? []));
        if (!linkedDays.has(group.day)) {
          group.rhythm += 1;
          for (const linkedDay of linkedDays) cross.run(revision, timezone, row.id, group.day, group.hour, linkedDay);
        }
      }
      for (const row of resources) times.run(revision, timezone, "resource", row.id, row.time_ms === null ? null : localDay(row.time_ms, timezone));
      const write = this.database.prepare("INSERT INTO overview_fact_buckets VALUES(?,?,?,?,?,?,?,?)");
      for (const row of buckets.values()) write.run(revision, timezone, row.day, row.hour, row.events, row.requests, row.tools, row.rhythm);
      this.database.prepare("INSERT INTO overview_fact_time_revisions VALUES(?,?)").run(revision, timezone);
    }).immediate();
  }

  snapshot(query: OverviewQuery = {}): OverviewSource {
    return this.meta(query.version).source;
  }

  private meta(requested?: string) {
    const version = this.sessions.usageVersion(requested);
    if (this.metadata?.version === version) return this.metadata;
    const rows = this.sessions.usageFactSessions(version).sessions;
    this.metadata = { version, rows, source: { version, sessions: rows.map(row => row.session),
      events: [], requests: [], resources: [], gaps: this.sessions.overviewGaps(version) } };
    return this.metadata;
  }

  range(query: OverviewQuery = {}, now = new Date()): OverviewRange {
    const source = this.snapshot(query), timezone = resolveTimezone(query.timezone);
    if (query.window !== "all" || query.from) return resolveOverviewRange(source, { ...query, timezone }, now);
    this.requirePrepared(query, timezone);
    const revisions = this.revisions(query), ids = JSON.stringify(revisions);
    const row = this.database.prepare(`SELECT MIN(t.day) AS day FROM overview_fact_times t
      WHERE t.revision IN (SELECT value FROM json_each(?)) AND t.timezone=? AND t.day IS NOT NULL
      AND (t.family='request' OR t.family='event' AND EXISTS
        (SELECT 1 FROM overview_fact_events e WHERE e.revision=t.revision AND e.id=t.id AND e.active=1))`)
      .get(ids, timezone) as { day: string | null };
    const range = resolveOverviewRange(source, { ...query, timezone }, now);
    if (row.day && row.day < range.from) range.from = row.day;
    range.includesToday = range.from <= range.today && range.to >= range.today;
    range.recent = range.includesToday && range.from <= addDays(range.today, -60)
      ? { current: { from: addDays(range.today, -30), to: addDays(range.today, -1) },
        previous: { from: addDays(range.today, -60), to: addDays(range.today, -31) } } : null;
    return range;
  }

  private revisions(query: OverviewQuery, sessionIds?: string[]): string[] {
    return this.meta(query.version).rows
      .filter(row => matchesGlobalSession(row.session, query) && (!sessionIds || sessionIds.includes(row.session.id))).map(row => row.revision);
  }

  private scope(query: OverviewQuery, now: Date): Scope {
    const timezone = resolveTimezone(query.timezone);
    this.requirePrepared(query, timezone);
    return { source: this.snapshot(query), range: this.range(query, now), timezone, revisions: this.revisions(query) };
  }

  private requirePrepared(query: OverviewQuery, timezone: string): void {
    const revisions = this.revisions(query);
    const count = (this.database.prepare(`SELECT COUNT(*) AS count FROM overview_fact_time_revisions t
      JOIN overview_fact_revisions r ON r.revision=t.revision AND r.format=?
      WHERE timezone=? AND t.revision IN (SELECT value FROM json_each(?))`)
      .get(format, timezone, JSON.stringify(revisions)) as { count: number }).count;
    if (count !== revisions.length) throw new StoreError("ANALYSIS_NOT_READY", "总览事实尚未准备完成", { key: "diagnostics.sessions.store.m009" });
  }

  activitySessions(query: OverviewQuery, now = new Date()): { activeIds: string[]; datedIds: string[] } {
    const { source, range, timezone, revisions } = this.scope(query, now), json = JSON.stringify(revisions);
    const active = new Set((this.database.prepare(`SELECT DISTINCT revision FROM overview_fact_buckets
      WHERE revision IN (SELECT value FROM json_each(?)) AND timezone=? AND day BETWEEN ? AND ?`)
      .all(json, timezone, range.from, range.to) as { revision: string }[]).map(row => row.revision));
    const global = JSON.stringify(this.meta(source.version).rows.map(row => row.revision));
    const dated = new Set((this.database.prepare(`SELECT DISTINCT revision FROM overview_fact_buckets
      WHERE revision IN (SELECT value FROM json_each(?)) AND timezone=?`).all(global, timezone) as { revision: string }[]).map(row => row.revision));
    if (range.all) for (const row of this.database.prepare(`SELECT revision FROM overview_fact_events
      WHERE revision IN (SELECT value FROM json_each(?)) AND active=1 AND time_ms IS NULL
      UNION SELECT revision FROM overview_fact_requests WHERE revision IN (SELECT value FROM json_each(?)) AND time_ms IS NULL`)
      .all(json, json) as { revision: string }[]) active.add(row.revision);
    const byId = new Map(this.meta(source.version).rows.map(row => [row.revision, row.session.id]));
    return { activeIds: [...active].map(revision => byId.get(revision)!), datedIds: [...dated].map(revision => byId.get(revision)!) };
  }

  core(query: OverviewQuery, usage: UsageReport, now = new Date()): OverviewCore {
    const { source, range, timezone, revisions } = this.scope(query, now), json = JSON.stringify(revisions);
    const selectedSessions = source.sessions.filter(session => matchesGlobalSession(session, query));
    const revisionIds = new Map(this.meta(source.version).rows.map(row => [row.revision, row.session.id]));
    const rows = this.database.prepare(`SELECT revision,day,hour,events,requests,tools,rhythm FROM overview_fact_buckets
      WHERE revision IN (SELECT value FROM json_each(?)) AND timezone=? AND day BETWEEN ? AND ? ORDER BY day,hour,revision`)
      .all(json, timezone, range.from, range.to) as Bucket[];
    const adjustments = this.database.prepare(`SELECT revision,day,hour,COUNT(DISTINCT request_id) AS count
      FROM overview_fact_cross_links WHERE revision IN (SELECT value FROM json_each(?)) AND timezone=?
      AND day BETWEEN ? AND ? AND linked_day BETWEEN ? AND ? GROUP BY revision,day,hour`)
      .all(json, timezone, range.from, range.to, range.from, range.to) as { revision: string; day: string; hour: number; count: number }[];
    const adjustmentMap = new Map(adjustments.map(row => [JSON.stringify([row.revision, row.day, row.hour]), row.count]));
    const points = new Map<string, { sessions: Set<string>; events: number; requests: number; toolCalls: number }>();
    const sessionDates = new Map<string, Set<string>>();
    const weekdays = Array.from({ length: 7 }, () => ({ events: 0, sessions: new Set<string>() }));
    const hours = Array.from({ length: 24 }, () => ({ events: 0, sessions: new Set<string>() }));
    const weekdayHours = new Map<string, { weekday: number; hour: number; events: number; sessions: Set<string> }>();
    for (const row of rows) {
      const id = revisionIds.get(row.revision)!, point = points.get(row.day) ?? { sessions: new Set<string>(), events: 0, requests: 0, toolCalls: 0 };
      point.sessions.add(id); point.events += row.events; point.requests += row.requests; point.toolCalls += row.tools; points.set(row.day, point);
      const dates = sessionDates.get(id) ?? new Set<string>(); dates.add(row.day); sessionDates.set(id, dates);
      const rhythm = row.rhythm - (adjustmentMap.get(JSON.stringify([row.revision, row.day, row.hour])) ?? 0);
      if (!rhythm) continue;
      const weekday = new Date(`${row.day}T00:00:00Z`).getUTCDay(), key = `${weekday}:${row.hour}`;
      const cell = weekdayHours.get(key) ?? { weekday, hour: row.hour, events: 0, sessions: new Set<string>() };
      cell.events += rhythm; cell.sessions.add(id); weekdayHours.set(key, cell);
      weekdays[weekday]!.events += rhythm; weekdays[weekday]!.sessions.add(id);
      hours[row.hour]!.events += rhythm; hours[row.hour]!.sessions.add(id);
    }
    const missing = this.database.prepare(`SELECT
      (SELECT COUNT(*) FROM overview_fact_events WHERE revision IN (SELECT value FROM json_each(?)) AND active=1 AND time_ms IS NULL) AS events,
      (SELECT COUNT(*) FROM overview_fact_requests WHERE revision IN (SELECT value FROM json_each(?)) AND time_ms IS NULL) AS requests,
      (SELECT COUNT(*) FROM overview_fact_resources WHERE revision IN (SELECT value FROM json_each(?)) AND valid=1 AND time_ms IS NULL) AS resources`)
      .get(json, json, json) as { events: number; requests: number; resources: number };
    const missingSessions = this.database.prepare(`SELECT revision FROM overview_fact_events
      WHERE revision IN (SELECT value FROM json_each(?)) AND active=1 AND time_ms IS NULL
      UNION SELECT revision FROM overview_fact_requests WHERE revision IN (SELECT value FROM json_each(?)) AND time_ms IS NULL`)
      .all(json, json) as { revision: string }[];
    const tokens = new Map(usage.days.map(day => [day.key, day.totals.tokens]));
    const days: OverviewActivity["days"] = [];
    for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
      const point = points.get(day);
      days.push({ day, sessions: point?.sessions.size ?? 0, events: point?.events ?? 0, requests: point?.requests ?? 0,
        toolCalls: point?.toolCalls ?? 0, tokens: tokens.get(day) ?? (point?.requests ? null : 0) });
    }
    const activity: OverviewActivity = { days,
      weekdays: weekdays.map((row, weekday) => ({ weekday, events: row.events, sessions: row.sessions.size })),
      hours: hours.map((row, hour) => ({ hour, events: row.events, sessions: row.sessions.size })),
      weekdayHours: [...weekdayHours.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour)
        .map(row => ({ ...row, sessions: row.sessions.size })),
      missingTimeEvents: missing.events, missingTimeSessions: missingSessions.length,
      datedSessions: sessionDates.size, crossDaySessions: [...sessionDates.values()].filter(dates => dates.size >= 2).length };
    const { activeIds } = this.activitySessions(query, now), activeSet = new Set(activeIds), active = selectedSessions.filter(session => activeSet.has(session.id));
    const activeDays = new Set(days.filter(day => day.sessions > 0).map(day => day.day));
    let endpoint = range.to, currentStreak = 0, longestStreak = 0, streak = 0, previous: string | undefined;
    if (endpoint === range.today && !activeDays.has(endpoint) && addDays(endpoint, -1) >= range.from) endpoint = addDays(endpoint, -1);
    for (let day = endpoint; day >= range.from && activeDays.has(day); day = addDays(day, -1)) currentStreak += 1;
    for (const day of [...activeDays].sort()) { streak = previous && addDays(previous, 1) === day ? streak + 1 : 1; longestStreak = Math.max(longestStreak, streak); previous = day; }
    const dateSql = range.all ? "1" : "t.day BETWEEN ? AND ?", bounds = range.all ? [] : [range.from, range.to];
    const models = this.database.prepare(`SELECT DISTINCT f.model FROM overview_fact_requests f JOIN overview_fact_times t
      ON t.revision=f.revision AND t.id=f.id AND t.family='request' AND t.timezone=?
      WHERE f.revision IN (SELECT value FROM json_each(?)) AND f.model IS NOT NULL AND ${dateSql}`)
      .all(timezone, json, ...bounds) as { model: string }[];
    const resourceCount = (this.database.prepare(`SELECT COUNT(DISTINCT f.resource_id) AS count FROM overview_fact_resources f JOIN overview_fact_times t
      ON t.revision=f.revision AND t.id=f.id AND t.family='resource' AND t.timezone=?
      WHERE f.revision IN (SELECT value FROM json_each(?)) AND f.known=1 AND f.valid=1 AND ${dateSql}`)
      .get(timezone, json, ...bounds) as { count: number }).count;
    const peak = this.database.prepare(`SELECT f.revision,f.id,f.message_id,f.occurred_at,f.input_tokens+f.output_tokens AS tokens
      FROM overview_fact_requests f JOIN overview_fact_times t ON t.revision=f.revision AND t.id=f.id AND t.family='request' AND t.timezone=?
      JOIN overview_fact_revisions r ON r.revision=f.revision
      WHERE f.revision IN (SELECT value FROM json_each(?)) AND f.input_tokens>=0 AND f.output_tokens>=0 AND ${dateSql}
      ORDER BY tokens DESC,COALESCE(f.occurred_at,''),r.session_id || ':' || f.id LIMIT 1`)
      .get(timezone, json, ...bounds) as { revision: string; id: string; message_id: string | null; occurred_at: string | null; tokens: number } | undefined;
    const globalRevisions = JSON.stringify(this.revisions({ version: source.version }));
    const facetModels = (this.database.prepare(`SELECT DISTINCT model FROM overview_fact_requests WHERE revision IN (SELECT value FROM json_each(?))
      AND model IS NOT NULL ORDER BY model`).all(globalRevisions) as { model: string }[]).map(row => row.model);
    const totals = usage.totals;
    return { totals, activity, summary: { sessions: active.length, mainSessions: active.filter(session => session.relationship !== "child" && session.relationship !== "fork").length,
      childSessions: active.filter(session => session.relationship === "child").length, forkSessions: active.filter(session => session.relationship === "fork").length,
      requests: totals.requests, tokens: totals.tokens, estimatedCost: totals.estimatedCost,
      tokenCoverage: totals.tokens === null ? "missing" : totals.partialTokenRequests || totals.missingTokenRequests ? "partial" : "complete",
      costCoverage: totals.estimatedCost === null ? "missing" : totals.partiallyPricedRequests || totals.unpricedRequests ? "partial" : "complete",
      activeDays: activeDays.size, currentStreak, longestStreak, projectCount: new Set(active.flatMap(session => session.project ?? [])).size,
      modelCount: models.length, resourceCount, peak: peak ? { sessionId: revisionIds.get(peak.revision)!, requestId: peak.id,
        messageId: peak.message_id ?? undefined, occurredAt: peak.occurred_at ?? undefined, tokens: peak.tokens } : null },
      facets: { clients: [...new Set(source.sessions.map(session => session.client))].sort(),
        projects: [...new Set(source.sessions.flatMap(session => session.project ?? []))].sort(), models: facetModels },
      coverage: { gaps: source.gaps.slice(0, 100), gapCount: source.gaps.length, missingTimeEvents: missing.events,
        missingTimeRequests: missing.requests, missingTimeResources: missing.resources } };
  }

  /** 按范围和分区读取必要事实，完整会话只供顺序调查保留边界。 */
  async source(query: OverviewQuery, purpose: OverviewFactPurpose, now = new Date(), options: OverviewFactOptions = {}): Promise<OverviewSource> {
    await this.prepare(query, now);
    const { source, range, timezone } = this.scope(query, now), revisions = this.revisions(query, options.sessionIds), json = JSON.stringify(revisions);
    const bounded = !(options.fullSessions ?? purpose === "evidence"), dateSql = bounded && !range.all ? " AND t.day BETWEEN ? AND ?" : "";
    const bounds = dateSql ? [range.from, range.to] : [];
    const events: OverviewEvent[] = [], requests: OverviewSource["requests"] = [], resources: ResourceUsageEvent[] = [];
    const read = (family: "event" | "request" | "resource", suffix = "", values: (string | number)[] = [], full = false) => {
      const table = family === "event" ? "events" : family === "request" ? "requests" : "resources";
      return this.database.prepare(`SELECT f.json${family === "request" && purpose === "evidence" ? ",f.members_json" : ""} FROM overview_fact_${table} f JOIN overview_fact_times t
        ON t.revision=f.revision AND t.id=f.id AND t.family=? AND t.timezone=?
        JOIN overview_fact_revisions r ON r.revision=f.revision
        WHERE f.revision IN (SELECT value FROM json_each(?))${full ? "" : dateSql}${suffix} ORDER BY r.session_id,f.ordinal,f.id`)
        .all(family, timezone, json, ...(full ? [] : bounds), ...values) as { json: string; members_json?: string | null }[];
    };
    try {
      if (purpose !== "requests" || options.eventKinds) {
        const kinds = options.eventKinds ?? (purpose === "resources" ? ["user"] : purpose === "process" ? ["user", "tool_call", "tool_result", "compression"] : undefined);
        let suffix = kinds ? " AND f.kind IN (SELECT value FROM json_each(?))" : "";
        const values: (string | number)[] = kinds ? [JSON.stringify(kinds)] : [];
        const fullUsers = purpose === "process" && bounded && !range.all;
        if (fullUsers) { suffix += " AND (f.kind='user' OR t.day BETWEEN ? AND ?)"; values.push(range.from, range.to); }
        for (const row of read("event", suffix, values, purpose === "resources" || fullUsers)) events.push(JSON.parse(row.json) as OverviewEvent);
      }
      if (purpose !== "resources") {
        for (const row of read("request")) {
          const request = JSON.parse(row.json) as OverviewSource["requests"][number];
          if (row.members_json !== undefined && row.members_json !== null) request.usage.requestMessageIds = JSON.parse(row.members_json) as string[];
          requests.push(request);
        }
      }
      if (purpose === "resources" || purpose === "evidence") for (const row of read("resource", " AND f.valid=1")) resources.push(JSON.parse(row.json) as ResourceUsageEvent);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      for (const revision of revisions) this.database.prepare("DELETE FROM overview_fact_revisions WHERE revision=?").run(revision);
      await this.prepare(query, now);
      return this.source(query, purpose, now, options);
    }
    return { ...source, events, requests, resources };
  }

  /** 派生库超额后改用内存，磁盘不随历史持续增长。 */
  private limitDisk(): void {
    if (this.memory) return;
    if (statSync(this.path).size <= this.maxBytes) return;
    const bytes = this.database.serialize();
    this.database.exec("DELETE FROM overview_fact_revisions; VACUUM;");
    this.database.close();
    this.memory = true; this.database = new Database(bytes); this.initialize();
  }

  close(): void { this.database.close(); }
}

function time(value?: string): number | null {
  if (value === undefined) return null;
  // 与现有统计共用严格时间投影，无时区或非法日期保留未知。
  const day = localDay(value, "UTC");
  return day === null ? null : Date.parse(value);
}
function finite(value?: number): number | null { return value === undefined || !Number.isFinite(value) ? null : value; }
