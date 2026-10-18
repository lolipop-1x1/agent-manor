import Database from "better-sqlite3";
import { chmodSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { OverviewActivity, OverviewEvent, OverviewPanelData, OverviewQuery, OverviewRange, OverviewReport, OverviewSource } from "../overview-contracts.js";
import type { ResourceUsageEvent } from "../resource-contracts.js";
import type { UsageStatistics } from "../usage-contracts.js";
import type { SessionStore } from "../sessions/store.js";
import { StoreError } from "../index/store.js";
import { buildDelegationSummary, isActivityEvent, knownResourceIdentity, matchesGlobalSession, pairToolCalls, resourceIdentity, toolCategory, validResource } from "./analytics.js";
import { removeStoredRequestTiming, requestMembersWithEnd, withoutRequestTiming } from "./request-projection.js";
import { addDays, localDay, prepareOverviewDateCache, resolveOverviewRange, resolveTimezone } from "./dates.js";

const format = 2;
const maximumBytes = 768 * 1024 * 1024;
export type OverviewFactPurpose = "resources" | "process" | "requests" | "evidence";
export interface OverviewFactOptions { fullSessions?: boolean; sessionIds?: string[]; eventKinds?: OverviewEvent["kind"][]; prepared?: boolean }
export type OverviewCore = Pick<OverviewReport, "summary" | "totals" | "activity" | "coverage"> & Required<Pick<OverviewPanelData, "delegationSummary">>;
interface FactRow { revision: string; id: string; time_ms: number | null; json: string }
interface Bucket { revision: string; day: string; hour: number; events: number; requests: number; tools: number; rhythm: number }
export interface OverviewFactScope {
  source: OverviewSource; range: OverviewRange; timezone: string; revisions: string[];
  bounds: { fromMs: number; toMs: number } | null;
}
interface EventRow extends FactRow { session_id: string; ordinal: number; kind: OverviewEvent["kind"]; turn_id: string; tool: string | null; status: OverviewEvent["status"] | null }
interface RequestRow extends FactRow { session_id: string; ordinal: number; occurred_at: string | null; model: string | null; input_tokens: number | null; output_tokens: number | null; message_id: string | null }
interface ResourceRow extends FactRow { session_id: string; ordinal: number; kind: ResourceUsageEvent["kind"]; name: string; server: string | null; tool: string | null;
  status: ResourceUsageEvent["status"]; turn_id: string; client: ResourceUsageEvent["client"]; project: string | null; resource_source_json: string | null }

/** 可重建窄事实按不可变修订保存；完整版本关系在读取时绑定。 */
export class OverviewFactStore {
  private database!: Database.Database;
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly readonly: boolean;
  private pending = new Map<string, Promise<void>>();
  private verified = new Set<string>();
  private preparedTimes = new Set<string>();
  private preparedScopes = new Set<string>();
  private readonly statements = new Map<string, Database.Statement>();
  private timeFormatter?: { timezone: string; value: Intl.DateTimeFormat };
  private metadata?: { version: string; source: OverviewSource; rows: ReturnType<SessionStore["usageFactSessions"]>["sessions"] };
  private pruneVersion?: string;

  constructor(private readonly sessions: SessionStore, options: { path?: string; maxBytes?: number; repairCorruption?: boolean; readonly?: boolean } = {}) {
    this.path = options.path ?? join(dirname(sessions.dbPath), "overview-facts.sqlite");
    this.maxBytes = options.maxBytes ?? maximumBytes;
    this.readonly = options.readonly ?? false;
    try {
      this.database = new Database(this.path, { readonly: this.readonly, fileMustExist: this.readonly });
      if (!this.readonly) chmodSync(this.path, 0o600);
      this.initialize();
    } catch (error) {
      try { this.database!.close(); } catch { /* 初始化失败时释放已经打开的连接。 */ }
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (!this.readonly && options.repairCorruption && (code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT")) {
        // 仅由协调后的唯一写入者隔离坏库；固定文件名最多保留一份，不复制原索引。
        try {
          renameSync(this.path, `${this.path}.corrupt`);
          this.database = new Database(this.path); chmodSync(this.path, 0o600); this.initialize();
        } catch {
          try { this.database!.close(); } catch { /* 修复失败时释放连接。 */ }
          throw new StoreError("ANALYSIS_NOT_READY", "总览派生缓存无法重建", { key: "diagnostics.overview.cacheUnavailable" });
        }
      } else throw new StoreError("ANALYSIS_NOT_READY", "总览派生缓存无法打开", {
        key: code === "SQLITE_FULL" ? "diagnostics.overview.cacheCapacity" : "diagnostics.overview.cacheUnavailable" });
    }
  }

  private initialize(): void {
    this.database.pragma("foreign_keys=ON");
    this.database.pragma("busy_timeout=5000");
    if (!this.readonly) this.database.pragma("journal_mode=DELETE");
    this.database.pragma("synchronous=NORMAL");
    this.database.pragma("temp_store=FILE");
    this.database.function("overview_local_day", { deterministic: true }, (milliseconds, timezone) =>
      typeof milliseconds === "number" && typeof timezone === "string" ? localDay(milliseconds, timezone) : null);
    this.database.function("overview_tool_category", { deterministic: true }, (tool, resourceKind) =>
      toolCategory(typeof tool === "string" ? tool : undefined, resourceKind === "mcp" ? { kind: "mcp", name: "" } : undefined));
    if (this.readonly) {
      this.statement("SELECT 1 FROM overview_fact_revisions LIMIT 1").get();
      return;
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS overview_fact_revisions (
        revision TEXT PRIMARY KEY, session_id TEXT NOT NULL, format INTEGER NOT NULL, events INTEGER NOT NULL, requests INTEGER NOT NULL,
        resources INTEGER NOT NULL, accessed_at INTEGER NOT NULL, resource_source_json TEXT) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS overview_fact_events (
        revision TEXT NOT NULL REFERENCES overview_fact_revisions(revision) ON DELETE CASCADE,
        id TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL, active INTEGER NOT NULL,
        time_ms REAL, tool TEXT, status TEXT, turn_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(revision,id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS overview_fact_requests (
        revision TEXT NOT NULL REFERENCES overview_fact_revisions(revision) ON DELETE CASCADE,
        id TEXT NOT NULL, ordinal INTEGER NOT NULL, time_ms REAL, occurred_at TEXT, model TEXT,
        input_tokens REAL, output_tokens REAL, message_id TEXT, json TEXT NOT NULL, PRIMARY KEY(revision,id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS overview_fact_resources (
        revision TEXT NOT NULL REFERENCES overview_fact_revisions(revision) ON DELETE CASCADE,
        id TEXT NOT NULL, ordinal INTEGER NOT NULL, time_ms REAL, resource_id TEXT NOT NULL, known INTEGER NOT NULL,
        valid INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, server TEXT, tool TEXT, status TEXT NOT NULL,
        turn_id TEXT NOT NULL, client TEXT NOT NULL, project TEXT, json TEXT NOT NULL, PRIMARY KEY(revision,id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS overview_fact_time_revisions (
        revision TEXT NOT NULL REFERENCES overview_fact_revisions(revision) ON DELETE CASCADE,
        timezone TEXT NOT NULL, PRIMARY KEY(revision,timezone)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS overview_fact_buckets (
        revision TEXT NOT NULL REFERENCES overview_fact_revisions(revision) ON DELETE CASCADE,
        timezone TEXT NOT NULL, day TEXT NOT NULL, hour INTEGER NOT NULL,
        events INTEGER NOT NULL, requests INTEGER NOT NULL, tools INTEGER NOT NULL, rhythm INTEGER NOT NULL,
        PRIMARY KEY(revision,timezone,day,hour)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS overview_fact_cross_links (
        revision TEXT NOT NULL REFERENCES overview_fact_revisions(revision) ON DELETE CASCADE,
        timezone TEXT NOT NULL, request_id TEXT NOT NULL, day TEXT NOT NULL, hour INTEGER NOT NULL, linked_day TEXT NOT NULL,
        PRIMARY KEY(revision,timezone,request_id,linked_day)) WITHOUT ROWID;
    `);
    removeStoredRequestTiming(this.database, "overview_fact_requests");
    const pageSize = this.database.pragma("page_size", { simple: true }) as number;
    this.database.pragma(`max_page_count=${Math.max(1, Math.floor(this.maxBytes / pageSize))}`);
    // 只索引活跃用户轮次和工具日期，避免归属检查与日期筛选反复扫描整段历史。
    this.database.exec(`CREATE INDEX IF NOT EXISTS overview_fact_user_turn ON overview_fact_events(revision,turn_id)
      WHERE active=1 AND kind='user';
      CREATE INDEX IF NOT EXISTS overview_fact_tool_time ON overview_fact_events(revision,time_ms)
      WHERE active=1 AND kind='tool_call'`);
  }

  /** 固定查询复用原生语句，避免按修订编译后等待 GC 才释放大量 SQLite 内存。 */
  private statement(sql: string): Database.Statement {
    const cached = this.statements.get(sql);
    if (cached) return cached.busy ? this.database.prepare(sql) : cached;
    const statement = this.database.prepare(sql);
    if (this.statements.size === 32) this.statements.delete(this.statements.keys().next().value!);
    this.statements.set(sql, statement);
    return statement;
  }

  /** 每个修订事务完成后让出执行，其他前台分区可以合作调度。 */
  async prepare(query: OverviewQuery = {}, now = new Date()): Promise<void> {
    if (this.readonly) throw new StoreError("ANALYSIS_NOT_READY", "总览事实须由写入者准备", { key: "diagnostics.overview.cacheUnavailable" });
    const source = this.meta(query.version), timezone = resolveTimezone(query.timezone);
    // 日期参数在任何派生写入之前校验。
    resolveOverviewRange(source.source,
      { ...query, window: query.window === "all" ? "custom" : query.window, timezone }, now);
    this.limitDisk();
    prepareOverviewDateCache(source.version, timezone);
    if (this.pruneVersion !== source.version) {
      this.statement("DELETE FROM overview_fact_revisions WHERE revision NOT IN (SELECT value FROM json_each(?))")
        .run(JSON.stringify(this.sessions.overviewRetainedRevisions()));
      this.pruneVersion = source.version;
    }
    for (const { revision, session } of source.rows) {
      const key = JSON.stringify([revision, timezone]);
      let operation = this.pending.get(key);
      if (!operation) {
        operation = (async () => {
          try {
            if (!this.ready(revision)) this.prepareRevision(revision, session.id, source.version);
            if (!this.timeReady(revision, timezone)) this.prepareTimes(revision, timezone);
            this.limitDisk();
          } catch (error) {
            const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
            if (code === "SQLITE_FULL") throw new StoreError("ANALYSIS_NOT_READY", "总览派生缓存已超过空间上限", { key: "diagnostics.overview.cacheCapacity" });
            throw error;
          }
          await nextTurn();
        })();
        this.pending.set(key, operation);
      }
      try { await operation; } finally { if (this.pending.get(key) === operation) this.pending.delete(key); }
    }
    // 查询完成前重新检查发布版本，已淘汰版本不能借派生事实继续访问。
    this.sessions.usageVersion(source.version);
    this.limitDisk();
  }

  private ready(revision: string): boolean {
    if (this.verified.has(revision)) return true;
    const row = this.statement(`SELECT format,events,requests,resources,
      (SELECT COUNT(*) FROM overview_fact_events WHERE revision=r.revision) AS event_count,
      (SELECT COUNT(*) FROM overview_fact_requests WHERE revision=r.revision) AS request_count,
      (SELECT COUNT(*) FROM overview_fact_resources WHERE revision=r.revision) AS resource_count
      FROM overview_fact_revisions r WHERE revision=?`).get(revision) as {
        format: number; events: number; requests: number; resources: number; event_count: number; request_count: number; resource_count: number } | undefined;
    const ready = !!row && row.format === format && row.events === row.event_count && row.requests === row.request_count && row.resources === row.resource_count;
    if (ready) this.verified.add(revision);
    return ready;
  }

  private timeReady(revision: string, timezone: string): boolean {
    const key = JSON.stringify([revision, timezone]);
    if (this.preparedTimes.has(key)) return true;
    const ready = !!this.statement("SELECT 1 FROM overview_fact_time_revisions WHERE revision=? AND timezone=?").get(revision, timezone);
    if (ready) this.preparedTimes.add(key);
    return ready;
  }

  private prepareRevision(revision: string, sessionId: string, version: string): void {
    const facts = this.sessions.overviewRevisionFacts(revision, sessionId);
    const resources = [...this.sessions.resourceEvents({ version }, undefined, revision).events];
    const calls = new Map(pairToolCalls(facts.events.filter(isActivityEvent)).map(event => [event.id, event]));
    this.database.transaction(() => {
      if (this.ready(revision)) return;
      this.statement("DELETE FROM overview_fact_revisions WHERE revision=?").run(revision);
      const { recordLine: _recordLine, ...resourceSource } = resources[0]?.source ?? {};
      this.statement("INSERT INTO overview_fact_revisions VALUES(?,?,?,?,?,?,?,?)")
        .run(revision, sessionId, format, facts.events.length, facts.requests.length, resources.length, Date.now(), JSON.stringify(resourceSource));
      const eventWrite = this.statement("INSERT INTO overview_fact_events VALUES(?,?,?,?,?,?,?,?,?,?)");
      for (const raw of facts.events) {
        const event = calls.get(raw.id) ?? raw;
        const { sessionId: _sessionId, id: _id, ordinal: _ordinal, kind: _kind, turnId: _turnId, tool, status, ...projection } = event;
        eventWrite.run(revision, event.id, event.ordinal, event.kind, Number(isActivityEvent(event)),
          time(event.occurredAt), tool ?? null, status ?? null, event.turnId, JSON.stringify(projection));
      }
      const requestWrite = this.statement("INSERT INTO overview_fact_requests VALUES(?,?,?,?,?,?,?,?,?,?)");
      for (const request of facts.requests) {
        const { id: _id, occurredAt, model, inputTokens, outputTokens, messageId, ...usage } = withoutRequestTiming({ ...request.usage, requestMessageIds: undefined });
        requestWrite.run(revision, request.usage.id, request.ordinal!, time(occurredAt), occurredAt ?? null,
          model ?? null, finite(inputTokens), finite(outputTokens), messageId ?? null, JSON.stringify({ usage }));
      }
      const resourceWrite = this.statement("INSERT INTO overview_fact_resources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
      for (const resource of resources) {
        const { sessionId: _sessionId, id: _id, ordinal: _ordinal, kind: _kind, name: _name, server: _server, tool: _tool,
          status: _status, turnId: _turnId, client: _client, project: _project, source, ...projection } = resource;
        resourceWrite.run(revision, resource.id, resource.ordinal, time(resource.occurredAt), resourceIdentity(resource),
          Number(knownResourceIdentity(resource)), Number(validResource(resource)), resource.kind, resource.name, resource.server ?? null,
          resource.tool ?? null, resource.status, resource.turnId, resource.client, resource.project ?? null,
          JSON.stringify({ ...projection, source: { recordLine: source.recordLine } }));
      }
    }).immediate();
    this.verified.add(revision);
  }

  private prepareTimes(revision: string, timezone: string): void {
    const events = this.statement("SELECT id,time_ms,kind,active FROM overview_fact_events WHERE revision=?").all(revision) as {
      id: string; time_ms: number | null; kind: string; active: number }[];
    const requests = this.statement("SELECT id,time_ms FROM overview_fact_requests WHERE revision=? ORDER BY ordinal").all(revision) as FactRow[];
    const members = new Map<string, string[]>();
    for (const row of this.sessions.overviewRequestMembers(revision)) members.set(row.id,
      [...new Set([row.messageId, ...(row.requestMessageIds ?? []), row.endMessageId].filter((id): id is string => id !== undefined))]);
    const buckets = new Map<string, Bucket>(), activeEventDays = new Map<string, string>();
    // 回填只保留当前修订的投影，不把整库事件塞入全局日期缓存。
    if (this.timeFormatter?.timezone !== timezone) this.timeFormatter = { timezone, value: new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hourCycle: "h23", hour: "2-digit" }) };
    const formatter = this.timeFormatter.value;
    const projections = new Map<number, { day: string; hour: number }>();
    const project = (milliseconds: number) => {
      let result = projections.get(milliseconds);
      if (!result) {
        const parts = Object.fromEntries(formatter.formatToParts(milliseconds).map(part => [part.type, part.value]));
        result = { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) }; projections.set(milliseconds, result);
      }
      return result;
    };
    const bucket = (milliseconds: number) => {
      const { day, hour } = project(milliseconds), key = `${day}:${hour}`;
      let row = buckets.get(key);
      if (!row) { row = { revision, day, hour, events: 0, requests: 0, tools: 0, rhythm: 0 }; buckets.set(key, row); }
      return row;
    };
    this.database.transaction(() => {
      if (this.timeReady(revision, timezone)) return;
      for (const row of events) {
        if (!row.active || row.time_ms === null) continue;
        const day = project(row.time_ms).day;
        activeEventDays.set(row.id, day!);
        const group = bucket(row.time_ms); group.events += 1; group.rhythm += 1;
        if (row.kind === "tool_call") group.tools += 1;
      }
      const cross = this.statement("INSERT INTO overview_fact_cross_links VALUES(?,?,?,?,?,?)");
      for (const row of requests) {
        if (row.time_ms === null) continue;
        const group = bucket(row.time_ms); group.requests += 1;
        const linkedDays = new Set((members.get(row.id) ?? []).flatMap(id => activeEventDays.get(id) ?? []));
        if (!linkedDays.has(group.day)) {
          group.rhythm += 1;
          for (const linkedDay of linkedDays) cross.run(revision, timezone, row.id, group.day, group.hour, linkedDay);
        }
      }
      const write = this.statement("INSERT INTO overview_fact_buckets VALUES(?,?,?,?,?,?,?,?)");
      for (const row of buckets.values()) write.run(revision, timezone, row.day, row.hour, row.events, row.requests, row.tools, row.rhythm);
      this.statement("INSERT INTO overview_fact_time_revisions VALUES(?,?)").run(revision, timezone);
    }).immediate();
    this.preparedTimes.add(JSON.stringify([revision, timezone]));
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
    const row = this.statement(`SELECT MIN(time_ms) AS time_ms FROM (
      SELECT MIN(time_ms) AS time_ms FROM overview_fact_events WHERE revision IN (SELECT value FROM json_each(?)) AND active=1
      UNION ALL SELECT MIN(time_ms) FROM overview_fact_requests WHERE revision IN (SELECT value FROM json_each(?)))`)
      .get(ids, ids) as { time_ms: number | null };
    const day = row.time_ms === null ? null : localDay(row.time_ms, timezone);
    const range = resolveOverviewRange(source, { ...query, timezone }, now);
    if (day && day < range.from) range.from = day;
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

  sqlScope(query: OverviewQuery, now = new Date()): OverviewFactScope {
    const timezone = resolveTimezone(query.timezone);
    this.requirePrepared(query, timezone);
    const range = this.range(query, now);
    return { source: this.snapshot(query), range, timezone, revisions: this.revisions(query),
      bounds: range.all ? null : { fromMs: dayStart(range.from, timezone), toMs: dayStart(addDays(range.to, 1), timezone) } };
  }

  /** 详情只执行程序内固定只读 SQL，聚合与分页在数据库完成。 */
  readRows<T>(sql: string, values: (string | number | null)[] = []): T[] {
    return [...this.iterateRows<T>(sql, values)];
  }

  iterateRows<T>(sql: string, values: (string | number | null)[] = []): Iterable<T> {
    const statement = this.statement(sql);
    if (!statement.readonly) throw new TypeError("总览详情只允许只读查询");
    return statement.iterate(...values) as Iterable<T>;
  }

  decodeEvent(row: EventRow): OverviewEvent {
    return { ...JSON.parse(row.json) as OverviewEvent, sessionId: row.session_id, id: row.id, ordinal: row.ordinal,
      kind: row.kind, turnId: row.turn_id, tool: row.tool ?? undefined, status: row.status ?? undefined };
  }

  hydrateActivityEvents(rows: EventRow[]): OverviewEvent[] {
    const byRevision = new Map<string, string[]>(), statuses = new Map<string, OverviewEvent["status"] | null>();
    for (const row of rows) { const ids = byRevision.get(row.revision) ?? []; ids.push(row.id); byRevision.set(row.revision, ids); }
    for (const [revision, ids] of byRevision) for (const row of this.sessions.overviewActivityStatuses(revision, ids)) {
      statuses.set(JSON.stringify([revision, row.id]), row.status);
    }
    return rows.map(row => ({ ...this.decodeEvent(row), status: statuses.get(JSON.stringify([row.revision, row.id])) ?? undefined,
      pairing: undefined, resultMessageId: undefined }));
  }

  decodeRequest(row: RequestRow): OverviewSource["requests"][number] {
    const projection = JSON.parse(row.json) as OverviewSource["requests"][number];
    return { sessionId: row.session_id, ordinal: row.ordinal, usage: { ...projection.usage, id: row.id,
      occurredAt: row.occurred_at ?? undefined, model: row.model ?? undefined, inputTokens: row.input_tokens ?? undefined,
      outputTokens: row.output_tokens ?? undefined, messageId: row.message_id ?? undefined } };
  }

  /** 成员只按当前调查页的请求身份读取，保留来源数组顺序。 */
  hydrateRequestMembers(rows: RequestRow[]): OverviewSource["requests"] {
    const byRevision = new Map<string, string[]>(), members = new Map<string, Map<string, string[]>>();
    for (const row of rows) { const ids = byRevision.get(row.revision) ?? []; ids.push(row.id); byRevision.set(row.revision, ids); }
    for (const [revision, ids] of byRevision) members.set(revision, new Map(
      [...this.sessions.overviewRequestMembers(revision, ids)].flatMap(row => {
        const ids = requestMembersWithEnd(row.requestMessageIds, row.endMessageId);
        return ids === undefined ? [] : [[row.id, ids]];
      })));
    return rows.map(row => {
      const request = this.decodeRequest(row), ids = members.get(row.revision)?.get(row.id);
      if (ids !== undefined) request.usage.requestMessageIds = ids;
      return request;
    });
  }

  decodeResource(row: ResourceRow): ResourceUsageEvent {
    const projection = JSON.parse(row.json) as ResourceUsageEvent;
    return { ...projection, id: row.id, sessionId: row.session_id, ordinal: row.ordinal, kind: row.kind, name: row.name,
      server: row.server ?? undefined, tool: row.tool ?? undefined, status: row.status, turnId: row.turn_id,
      client: row.client, project: row.project ?? undefined,
      source: { ...JSON.parse(row.resource_source_json ?? "{}") as ResourceUsageEvent["source"], recordLine: projection.source.recordLine } };
  }

  private requirePrepared(query: OverviewQuery, timezone: string): void {
    const key = JSON.stringify([this.sessions.usageVersion(query.version), timezone, query.clients, query.projects]);
    if (this.preparedScopes.has(key)) return;
    const revisions = this.revisions(query);
    const count = (this.statement(`SELECT COUNT(*) AS count FROM overview_fact_time_revisions t
      JOIN overview_fact_revisions r ON r.revision=t.revision AND r.format=?
      WHERE timezone=? AND t.revision IN (SELECT value FROM json_each(?))`)
      .get(format, timezone, JSON.stringify(revisions)) as { count: number }).count;
    if (count !== revisions.length) throw new StoreError("ANALYSIS_NOT_READY", "总览事实尚未准备完成", { key: "diagnostics.sessions.store.m009" });
    this.preparedScopes.add(key);
  }

  activitySessions(query: OverviewQuery, now = new Date()): { activeIds: string[]; datedIds: string[] } {
    const { source, range, timezone, revisions } = this.sqlScope(query, now), json = JSON.stringify(revisions);
    const active = new Set((this.statement(`SELECT DISTINCT revision FROM overview_fact_buckets
      WHERE revision IN (SELECT value FROM json_each(?)) AND timezone=? AND day BETWEEN ? AND ?`)
      .all(json, timezone, range.from, range.to) as { revision: string }[]).map(row => row.revision));
    const global = JSON.stringify(this.meta(source.version).rows.map(row => row.revision));
    const dated = new Set((this.statement(`SELECT DISTINCT revision FROM overview_fact_buckets
      WHERE revision IN (SELECT value FROM json_each(?)) AND timezone=?`).all(global, timezone) as { revision: string }[]).map(row => row.revision));
    if (range.all) for (const row of this.statement(`SELECT revision FROM overview_fact_events
      WHERE revision IN (SELECT value FROM json_each(?)) AND active=1 AND time_ms IS NULL
      UNION SELECT revision FROM overview_fact_requests WHERE revision IN (SELECT value FROM json_each(?)) AND time_ms IS NULL`)
      .all(json, json) as { revision: string }[]) active.add(row.revision);
    const byId = new Map(this.meta(source.version).rows.map(row => [row.revision, row.session.id]));
    return { activeIds: [...active].map(revision => byId.get(revision)!), datedIds: [...dated].map(revision => byId.get(revision)!) };
  }

  facets(query: OverviewQuery): OverviewReport["facets"] {
    const source = this.snapshot(query), revisions = JSON.stringify(this.revisions({ version: source.version }));
    this.requirePrepared({ version: source.version }, resolveTimezone(query.timezone));
    const models = (this.statement(`SELECT DISTINCT model FROM overview_fact_requests WHERE revision IN (SELECT value FROM json_each(?))
      AND model IS NOT NULL ORDER BY model`).all(revisions) as { model: string }[]).map(row => row.model);
    return { clients: [...new Set(source.sessions.map(session => session.client))].sort(),
      projects: [...new Set(source.sessions.flatMap(session => session.project ?? []))].sort(), models };
  }

  core(query: OverviewQuery, usage: UsageStatistics, now = new Date()): OverviewCore {
    const { source, range, timezone, revisions, bounds } = this.sqlScope(query, now), json = JSON.stringify(revisions);
    const selectedSessions = source.sessions.filter(session => matchesGlobalSession(session, query));
    const revisionIds = new Map(this.meta(source.version).rows.map(row => [row.revision, row.session.id]));
    const rows = this.statement(`SELECT revision,day,hour,events,requests,tools,rhythm FROM overview_fact_buckets
      WHERE revision IN (SELECT value FROM json_each(?)) AND timezone=? AND day BETWEEN ? AND ? ORDER BY day,hour,revision`)
      .all(json, timezone, range.from, range.to) as Bucket[];
    const adjustments = this.statement(`SELECT revision,day,hour,COUNT(DISTINCT request_id) AS count
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
    const missing = this.statement(`SELECT
      (SELECT COUNT(*) FROM overview_fact_events WHERE revision IN (SELECT value FROM json_each(?)) AND active=1 AND time_ms IS NULL) AS events,
      (SELECT COUNT(*) FROM overview_fact_requests WHERE revision IN (SELECT value FROM json_each(?)) AND time_ms IS NULL) AS requests,
      (SELECT COUNT(*) FROM overview_fact_resources WHERE revision IN (SELECT value FROM json_each(?)) AND valid=1 AND time_ms IS NULL) AS resources`)
      .get(json, json, json) as { events: number; requests: number; resources: number };
    const missingSessions = this.statement(`SELECT revision FROM overview_fact_events
      WHERE revision IN (SELECT value FROM json_each(?)) AND active=1 AND time_ms IS NULL
      UNION SELECT revision FROM overview_fact_requests WHERE revision IN (SELECT value FROM json_each(?)) AND time_ms IS NULL`)
      .all(json, json) as { revision: string }[];
    const tokenRows = this.statement(`SELECT overview_local_day(time_ms,?) AS day,
      SUM(CASE WHEN input_tokens>=0 OR output_tokens>=0 THEN CASE WHEN input_tokens>=0 THEN input_tokens ELSE 0 END
        + CASE WHEN output_tokens>=0 THEN output_tokens ELSE 0 END END) AS tokens
      FROM overview_fact_requests WHERE revision IN (SELECT value FROM json_each(?)) AND time_ms IS NOT NULL
      AND ${bounds ? "time_ms>=? AND time_ms<?" : "1"} GROUP BY day`).all(timezone, json, ...(bounds ? [bounds.fromMs, bounds.toMs] : [])) as { day: string; tokens: number | null }[];
    const tokens = new Map(tokenRows.map(row => [row.day, row.tokens]));
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
    const { activeIds, datedIds } = this.activitySessions(query, now), activeSet = new Set(activeIds), active = selectedSessions.filter(session => activeSet.has(session.id));
    const activeDays = new Set(days.filter(day => day.sessions > 0).map(day => day.day));
    let endpoint = range.to, currentStreak = 0, longestStreak = 0, streak = 0, previous: string | undefined;
    if (endpoint === range.today && !activeDays.has(endpoint) && addDays(endpoint, -1) >= range.from) endpoint = addDays(endpoint, -1);
    for (let day = endpoint; day >= range.from && activeDays.has(day); day = addDays(day, -1)) currentStreak += 1;
    for (const day of [...activeDays].sort()) { streak = previous && addDays(previous, 1) === day ? streak + 1 : 1; longestStreak = Math.max(longestStreak, streak); previous = day; }
    const dateSql = bounds ? "f.time_ms>=? AND f.time_ms<?" : "1", values = bounds ? [bounds.fromMs, bounds.toMs] : [];
    const models = this.statement(`SELECT DISTINCT f.model FROM overview_fact_requests f
      WHERE f.revision IN (SELECT value FROM json_each(?)) AND f.model IS NOT NULL AND ${dateSql}`)
      .all(json, ...values) as { model: string }[];
    const resourceCount = (this.statement(`SELECT COUNT(DISTINCT f.resource_id) AS count FROM overview_fact_resources f
      WHERE f.revision IN (SELECT value FROM json_each(?)) AND f.known=1 AND f.valid=1 AND ${dateSql}`)
      .get(json, ...values) as { count: number }).count;
    const peak = this.statement(`SELECT f.revision,f.id,f.message_id,f.occurred_at,f.input_tokens+f.output_tokens AS tokens
      FROM overview_fact_requests f
      JOIN overview_fact_revisions r ON r.revision=f.revision
      WHERE f.revision IN (SELECT value FROM json_each(?)) AND f.input_tokens>=0 AND f.output_tokens>=0 AND ${dateSql}
      ORDER BY tokens DESC,COALESCE(f.occurred_at,''),r.session_id || ':' || f.id LIMIT 1`)
      .get(json, ...values) as { revision: string; id: string; message_id: string | null; occurred_at: string | null; tokens: number } | undefined;
    const totals = usage.totals;
    return { totals, activity, summary: { sessions: active.length, mainSessions: active.filter(session => session.relationship !== "child" && session.relationship !== "fork").length,
      childSessions: active.filter(session => session.relationship === "child").length, forkSessions: active.filter(session => session.relationship === "fork").length,
      requests: totals.requests, tokens: totals.tokens, estimatedCost: totals.estimatedCost,
      tokenCoverage: totals.tokens === null ? "missing" : totals.partialTokenRequests || totals.missingTokenRequests ? "partial" : "complete",
      costCoverage: totals.estimatedCost === null ? "missing" : totals.partiallyPricedRequests || totals.unpricedRequests ? "partial" : "complete",
      activeDays: activeDays.size, currentStreak, longestStreak, projectCount: new Set(active.flatMap(session => session.project ?? [])).size,
      modelCount: models.length, resourceCount, peak: peak ? { sessionId: revisionIds.get(peak.revision)!, requestId: peak.id,
        messageId: peak.message_id ?? undefined, occurredAt: peak.occurred_at ?? undefined, tokens: peak.tokens } : null },
      delegationSummary: buildDelegationSummary(source, { ...source, sessions: selectedSessions }, activeSet, timezone, undefined, new Set(datedIds)),
      coverage: { gaps: source.gaps.slice(0, 100), gapCount: source.gaps.length, missingTimeEvents: missing.events,
        missingTimeRequests: missing.requests, missingTimeResources: missing.resources } };
  }

  /** 按范围和分区读取必要事实，完整会话只供顺序调查保留边界。 */
  async source(query: OverviewQuery, purpose: OverviewFactPurpose, now = new Date(), options: OverviewFactOptions = {}): Promise<OverviewSource> {
    if (!options.prepared && !this.readonly) await this.prepare(query, now);
    const { source, range, bounds: period } = this.sqlScope(query, now), revisions = this.revisions(query, options.sessionIds), json = JSON.stringify(revisions);
    const bounded = !(options.fullSessions ?? purpose === "evidence"), dateSql = bounded && period ? " AND f.time_ms>=? AND f.time_ms<?" : "";
    const bounds = dateSql && period ? [period.fromMs, period.toMs] : [];
    const events: OverviewEvent[] = [], requests: OverviewSource["requests"] = [], resources: ResourceUsageEvent[] = [];
    let decodingRevision: string | undefined;
    const read = (family: "event" | "request" | "resource", suffix = "", values: (string | number)[] = [], full = false) => {
      const table = family === "event" ? "events" : family === "request" ? "requests" : "resources";
      return this.statement(`SELECT f.*,r.session_id,r.resource_source_json FROM overview_fact_${table} f
        JOIN overview_fact_revisions r ON r.revision=f.revision
        WHERE f.revision IN (SELECT value FROM json_each(?))${full ? "" : dateSql}${suffix} ORDER BY r.session_id,f.ordinal,f.id`)
        .iterate(json, ...(full ? [] : bounds), ...values) as Iterable<EventRow | RequestRow | ResourceRow>;
    };
    try {
      if (purpose !== "requests" || options.eventKinds) {
        const kinds = options.eventKinds ?? (purpose === "resources" ? ["user"] : purpose === "process" ? ["user", "tool_call", "tool_result"] : undefined);
        let suffix = kinds ? " AND f.kind IN (SELECT value FROM json_each(?))" : "";
        const values: (string | number)[] = kinds ? [JSON.stringify(kinds)] : [];
        const fullUsers = purpose === "process" && bounded && !range.all;
        if (fullUsers && period) { suffix += " AND (f.kind='user' OR f.time_ms>=? AND f.time_ms<?)"; values.push(period.fromMs, period.toMs); }
        for (const row of read("event", suffix, values, purpose === "resources" || fullUsers)) {
          decodingRevision = row.revision; events.push(this.decodeEvent(row as EventRow));
        }
      }
      if (purpose !== "resources" && purpose !== "process") {
        const members = new Map<string, Map<string, string[]>>();
        if (purpose === "evidence") for (const revision of revisions) members.set(revision, new Map(
          [...this.sessions.overviewRequestMembers(revision)].flatMap(row => row.requestMessageIds === undefined && !row.endMessageId ? [] : [[row.id, requestMembersWithEnd(row.requestMessageIds, row.endMessageId)!]])));
        for (const row of read("request")) {
          decodingRevision = row.revision;
          const request = this.decodeRequest(row as RequestRow), ids = members.get(row.revision)?.get(row.id);
          if (ids !== undefined) request.usage.requestMessageIds = ids;
          requests.push(request);
        }
      }
      if (purpose === "resources" || purpose === "evidence") {
        const missing = bounded && period ? " AND (f.time_ms IS NULL OR f.time_ms>=? AND f.time_ms<?)" : "";
        for (const row of read("resource", ` AND f.valid=1${missing}`, missing ? [period!.fromMs, period!.toMs] : [], true)) {
          decodingRevision = row.revision; resources.push(this.decodeResource(row as ResourceRow));
        }
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (this.readonly) throw new StoreError("ANALYSIS_NOT_READY", "总览派生事实无法读取", { key: "diagnostics.overview.cacheUnavailable" });
      if (!decodingRevision) throw error;
      this.statement("DELETE FROM overview_fact_revisions WHERE revision=?").run(decodingRevision);
      this.verified.delete(decodingRevision);
      for (const key of this.preparedTimes) if (JSON.parse(key)[0] === decodingRevision) this.preparedTimes.delete(key);
      this.preparedScopes.clear();
      events.length = 0; requests.length = 0; resources.length = 0;
      await this.prepare(query, now);
      return this.source(query, purpose, now, options);
    }
    return { ...source, events, requests, resources };
  }

  /** 超额保留完整修订并显式报错；不复制整库或清空其他读者正在使用的事实。 */
  private limitDisk(): void {
    if (statSync(this.path).size <= this.maxBytes) return;
    throw new StoreError("ANALYSIS_NOT_READY", "总览派生缓存已超过空间上限", { key: "diagnostics.overview.cacheCapacity" });
  }

  close(): void { this.statements.clear(); this.timeFormatter = undefined; this.database.close(); }
}

function time(value?: string): number | null {
  if (value === undefined) return null;
  // 与现有统计共用严格时间投影，无时区或非法日期保留未知。
  const day = localDay(value, "UTC");
  return day === null ? null : Date.parse(value);
}
function finite(value?: number): number | null { return value === undefined || !Number.isFinite(value) ? null : value; }

/** 本地日期的下界；二分时间投影覆盖夏令时的短日、长日及跳过日期。 */
function dayStart(day: string, timezone: string): number {
  const midnight = Date.parse(`${day}T00:00:00Z`);
  let left = midnight - 2 * 86400000, right = midnight + 2 * 86400000;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (localDay(middle, timezone)! < day) left = middle + 1; else right = middle;
  }
  return left;
}
