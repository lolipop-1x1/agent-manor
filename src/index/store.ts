import { coordinateIndexWrites } from "./write-gate.js";
import type { MessageDescriptor } from "../i18n/types.js";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AnalysisSnapshot, ApiErrorCode, HistoryEvent, HistorySource, Job, Mapping, ParsedSource, Repository, SourcesResponse } from "../contracts.js";
import { getRepository } from "../analysis/index.js";
import { INDEX_SCHEMA_VERSION, initializeIndexSchema } from "./schema.js";
import { PARSER_RULE_VERSION } from "../version.js";
import type { DiscoverOptions } from "../history/types.js";
import { inactiveClientIds, isSupportedClient } from "../clients.js";
import type { ReplaySnapshot } from "../replay/types.js";

export class StoreError extends Error {
  constructor(public readonly code: ApiErrorCode, message: string, readonly messageDescriptor?: MessageDescriptor) {
    super(message);
    this.name = "StoreError";
  }
}

/** 已撤销的任务不会再发布，也不回写失败记录。 */
export class JobCancelledError extends Error {
  constructor() { super("仓库分析已取消"); this.name = "JobCancelledError"; }
}

export interface RefreshStats {
  sourcesParsed: number;
  parsedRecords: number;
  mappingsComputed: number;
  mappingsReused: number;
  sourcesReused?: number;
  /** 与结果内容和解析、映射依赖绑定，不包含本轮检查时间。 */
  resultFingerprint?: string;
}

export interface PublishInput {
  snapshot: AnalysisSnapshot;
  sources: SourcesResponse;
  parsed: ParsedSource[];
  mappings: { key: string; mapping: Mapping }[];
  stats: RefreshStats;
  clearCache: boolean;
  jobId: string;
  /** 完整依赖快检命中的来源保持解析分块不变。 */
  reusedParsed?: ReadonlySet<string>;
  reusedVersion?: string;
}

interface JsonRow { json: string }
interface RepositoryRow { json: string; version: string | null; stale: number }
interface RefreshJob extends Job { refreshStats?: RefreshStats }
type PayloadKind = "snapshot" | "sources" | "parsed" | "coverage-v1";
const PART_SIZE = 1024 * 1024;

/** 查询只读取完整已发布版本；可复用缓存与版本发布在同一事务提交。 */
export class AnalysisStore {
  readonly dbPath: string;
  private readonly database: Database.Database;
  private readonly readOnly: boolean;

  constructor(dbPath: string, options: { readonly?: boolean; writeGate?: SharedArrayBuffer } = {}) {
    this.readOnly = options.readonly ?? false;
    this.dbPath = resolve(dbPath);
    if (!options.readonly) mkdirSync(dirname(this.dbPath), { recursive: true });
    this.database = new Database(this.dbPath, options.readonly ? { readonly: true, fileMustExist: true } : {});
    if (!options.readonly) this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    if (!options.readonly) coordinateIndexWrites(this.database, options.writeGate);
    try {
      if (options.readonly) {
        const version = this.database.pragma("user_version", { simple: true }) as number;
        if (version !== INDEX_SCHEMA_VERSION) throw new StoreError("ANALYSIS_NOT_READY", `不支持的索引版本 ${version}`,
          { key: "diagnostics.index.store.m001", params: { p0: version } });
      } else this.initialize();
    } catch (error) { this.database.close(); throw error; }
  }

  private initialize(): void {
    initializeIndexSchema(this.database, () => this.database.exec(`
      CREATE TABLE IF NOT EXISTS repositories (id TEXT PRIMARY KEY, json TEXT NOT NULL, version TEXT, stale INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS manual_associations (repository_id TEXT NOT NULL REFERENCES repositories(id), source_id TEXT NOT NULL, PRIMARY KEY(repository_id, source_id));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (publication INTEGER PRIMARY KEY AUTOINCREMENT, repository_id TEXT NOT NULL REFERENCES repositories(id), version TEXT NOT NULL, snapshot TEXT NOT NULL, sources TEXT NOT NULL, stats TEXT NOT NULL, UNIQUE(repository_id, version));
      CREATE TABLE IF NOT EXISTS source_cache (repository_id TEXT NOT NULL REFERENCES repositories(id), source_id TEXT NOT NULL, path TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(repository_id, source_id, path));
      CREATE INDEX IF NOT EXISTS source_cache_path ON source_cache(repository_id, path);
      CREATE TABLE IF NOT EXISTS mapping_cache (repository_id TEXT NOT NULL REFERENCES repositories(id), key TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(repository_id, key));
      CREATE TABLE IF NOT EXISTS tracked_sources (repository_id TEXT NOT NULL REFERENCES repositories(id), source_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(repository_id, source_id));
      CREATE TABLE IF NOT EXISTS payload_parts (repository_id TEXT NOT NULL REFERENCES repositories(id), kind TEXT NOT NULL, owner TEXT NOT NULL, field TEXT NOT NULL, part INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(repository_id,kind,owner,field,part));
    `));
  }

  /** 大集合逐项编码，读回也逐块恢复，不拼接整版 JSON 字符串。 */
  private writePayload(value: object, repositoryId: string, kind: PayloadKind, owner: string, fields: string[], writeParts = true, eventParts?: Map<string, number>): string {
    const header = { ...value } as Record<string, unknown>;
    const save = this.database.prepare("INSERT INTO payload_parts(repository_id,kind,owner,field,part,json) VALUES(?,?,?,?,?,?)");
    for (const field of fields) {
      const path = field.split(".");
      let target = header;
      for (const key of path.slice(0, -1)) {
        if (!target[key] || typeof target[key] !== "object") break;
        target[key] = { ...target[key] as object };
        target = target[key] as Record<string, unknown>;
      }
      const key = path.at(-1)!;
      const collection = target[key];
      if (!collection || typeof collection !== "object") continue;
      const array = Array.isArray(collection);
      target[key] = array ? [] : {};
      if (!writeParts) continue;
      let parts: string[] = [];
      let size = 0;
      let part = 0;
      const flush = () => {
        if (!parts.length) return;
        save.run(repositoryId, kind, owner, field, part++, (array ? "[" : "{") + parts.join(",") + (array ? "]" : "}"));
        parts = [];
        size = 0;
      };
      for (const itemKey of Object.keys(collection)) {
        const encoded = JSON.stringify((collection as Record<string, unknown>)[itemKey]);
        if (encoded === undefined && !array) continue;
        const item = array ? encoded ?? "null" : JSON.stringify(itemKey) + ":" + encoded;
        if (size + item.length > PART_SIZE) flush();
        if (eventParts && field === "events") {
          const id = (collection as HistoryEvent[])[Number(itemKey)]!.id;
          if (!eventParts.has(id)) eventParts.set(id, part);
        }
        parts.push(item);
        size += item.length + 1;
      }
      flush();
    }
    return JSON.stringify({ partsFormat: 4, value: header });
  }

  private readPayload<T>(json: string, repositoryId: string, kind: PayloadKind, owner: string, coverageOnly = false, eventParts?: Map<string, number>): T {
    const decoded = JSON.parse(json) as { value: Record<string, unknown> };
    // 覆盖计算只用路径、身份与已算好的映射；在 SQLite 内移除正文，避免读回整仓库及工具输出。
    const projection = coverageOnly ? `CASE field
      WHEN 'baseline.files' THEN (SELECT json_group_array(json_object('path',json_extract(value,'$.path'),
        'category',json_extract(value,'$.category'),'lineCount',json_extract(value,'$.lineCount'),'hash',json_extract(value,'$.hash'),'content','')) FROM jsonb_each(p.json))
      WHEN 'events' THEN (SELECT json_group_array(json_object('id',json_extract(e.value,'$.id'),'client',json_extract(e.value,'$.client'),
        'sessionId',json_extract(e.value,'$.sessionId'),'parentSessionId',json_extract(e.value,'$.parentSessionId'),
        'tool',json_extract(e.value,'$.tool'),'kind',json_extract(e.value,'$.kind'),'status',json_extract(e.value,'$.status'),
        'occurredAt',json_extract(e.value,'$.occurredAt'),'cwd',json_extract(e.value,'$.cwd'),'path',json_extract(e.value,'$.path'),
        'sources',json_extract(e.value,'$.sources'),'reasonDescriptor',json_extract(e.value,'$.reasonDescriptor'),
        'fragments',json(COALESCE((SELECT json_group_array(json_object('content','','kind',json_extract(f.value,'$.kind'),
          'path',json_extract(f.value,'$.path'),'historicalStart',json_extract(f.value,'$.historicalStart'),
          'completeLines',json(f.value -> '$.completeLines'))) FROM jsonb_each(e.value,'$.fragments') f),'[]')))) FROM jsonb_each(p.json) e)
      WHEN 'sources' THEN (SELECT json_group_array(json_object('sourceId',json_extract(value,'$.sourceId'),'client',json_extract(value,'$.client'),
        'format',json_extract(value,'$.format'),'path',json_extract(value,'$.path'),'selector',json_extract(value,'$.selector'),
        'hash',json_extract(value,'$.hash'),'sessionId',json_extract(value,'$.sessionId'),'cwd',json_extract(value,'$.cwd'),
        'parentSessionId',json_extract(value,'$.parentSessionId'))) FROM jsonb_each(p.json))
      ELSE json END` : "json";
    const rows = this.database.prepare(`SELECT field,part,${projection} AS json FROM payload_parts p WHERE repository_id=? AND kind=? AND owner=? AND field<>'$header' ORDER BY field,part`)
      .iterate(repositoryId, kind, owner) as Iterable<{ field: string; part: number; json: string }>;
    for (const row of rows) {
      const path = row.field.split(".");
      let target = decoded.value;
      for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
      const collection = target[path.at(-1)!];
      const part = JSON.parse(row.json) as unknown[] | Record<string, unknown>;
      if (coverageOnly && Array.isArray(part)) {
        for (const value of part as Record<string, unknown>[]) {
          if (row.field === "events" || row.field === "sources") {
            for (const key of Object.keys(value)) if (value[key] === null) delete value[key];
          }
          if (row.field === "events") for (const fragment of value.fragments as HistoryEvent["fragments"]) {
            if (fragment.path === null) delete fragment.path;
            if (fragment.historicalStart === null) delete fragment.historicalStart;
          }
        }
      }
      if (eventParts && row.field === "events" && Array.isArray(part)) {
        for (const event of part as HistoryEvent[]) if (!eventParts.has(event.id)) eventParts.set(event.id, row.part);
      }
      if (Array.isArray(collection) && Array.isArray(part)) {
        for (const item of part) collection.push(item);
      } else Object.assign(collection as object, part);
    }
    return decoded.value as T;
  }

  private sourceMetadata(source: HistorySource): HistorySource {
    const { sourceId, client, format, path, selector, hash, sessionId, cwd, parentSessionId } = source;
    return { sourceId, client, format, path, selector, hash, sessionId, cwd, parentSessionId };
  }

  async registerRepository(path: string): Promise<Repository> {
    return (await this.registerRepositoryResult(path)).repository;
  }

  async registerRepositoryResult(path: string): Promise<{ repository: Repository; created: boolean }> {
    const repository = await getRepository(path);
    const result = this.database.prepare("INSERT OR IGNORE INTO repositories(id,json,stale) VALUES(?,?,1)")
      .run(repository.id, JSON.stringify(repository));
    return { repository: this.getRepository(repository.id), created: result.changes > 0 };
  }

  /** 先获得写锁，使发布与删除只能按完整事务的提交顺序生效。 */
  deleteRepository(id: string): Job[] {
    return this.database.transaction(() => {
      this.getRepository(id);
      const jobs = (this.database.prepare("SELECT json FROM jobs WHERE repository_id=?").all(id) as JsonRow[])
        .map(row => JSON.parse(row.json) as Job);
      for (const table of ["manual_associations", "jobs", "versions", "source_cache", "mapping_cache", "tracked_sources", "payload_parts"]) {
        this.database.prepare(`DELETE FROM ${table} WHERE repository_id=?`).run(id);
      }
      this.database.prepare("DELETE FROM repositories WHERE id=?").run(id);
      return jobs;
    }).immediate();
  }

  private repository(row: RepositoryRow): Repository {
    return { ...JSON.parse(row.json) as Repository, version: row.version ?? undefined, stale: Boolean(row.stale) };
  }

  listRepositories(): Repository[] {
    return (this.database.prepare("SELECT json,version,stale FROM repositories ORDER BY id").all() as RepositoryRow[])
      .map((row) => this.repository(row));
  }

  getRepository(id: string): Repository {
    const row = this.database.prepare("SELECT json,version,stale FROM repositories WHERE id=?").get(id) as RepositoryRow | undefined;
    if (!row) throw new StoreError("REPOSITORY_NOT_FOUND", "仓库尚未登记", { key: "diagnostics.index.store.m002" });
    return this.repository(row);
  }

  getSnapshot(repositoryId: string, version?: string): AnalysisSnapshot {
    return this.readSnapshot(repositoryId, version, false);
  }

  /** 缓存命中前也核对版本保留状态，不能让已淘汰的数据继续提供证据。 */
  analysisVersion(repositoryId: string, version?: string): string {
    const selected = this.selectVersion(repositoryId, version);
    if (!this.database.prepare("SELECT 1 FROM versions WHERE repository_id=? AND version=?").get(repositoryId, selected)) {
      throw new StoreError("VERSION_NOT_FOUND", "分析结果版本不可用：不存在或已被淘汰", { key: "diagnostics.index.store.m004" });
    }
    return selected;
  }

  /** 直接在分块内选取回放元数据；JSONB 遍历不反复编码大段输入、输出与历史源码。 */
  getReplaySnapshot(repositoryId: string, version?: string): ReplaySnapshot {
    // 版本检查、头部和全部分块共用 WAL 读取快照，后台淘汰不能截断本次读取。
    return this.database.transaction(() => this.readReplaySnapshot(repositoryId, version)).deferred();
  }

  private readReplaySnapshot(repositoryId: string, version?: string): ReplaySnapshot {
    const selected = this.analysisVersion(repositoryId, version);
    const repository = this.getRepository(repositoryId);
    const row = this.database.prepare("SELECT snapshot AS json FROM versions WHERE repository_id=? AND version=?")
      .get(repositoryId, selected) as JsonRow | undefined;
    if (!row) throw new StoreError("VERSION_NOT_FOUND", "分析结果版本不可用：不存在或已被淘汰", { key: "diagnostics.index.store.m004" });
    const header = (JSON.parse(row.json) as { value: AnalysisSnapshot }).value;
    const result: ReplaySnapshot = { repository: { ...header.repository, version: selected, stale: repository.stale || selected !== repository.version },
      version: selected, baselineHash: header.baseline.hash, files: [], events: [], mappings: [], gaps: [], eventParts: new Map() };
    const parts = this.database.prepare(`SELECT field,part,CASE field
      WHEN 'baseline.files' THEN (SELECT json_group_array(json_object('path',json_extract(value,'$.path'),
        'category',json_extract(value,'$.category'),'lineCount',json_extract(value,'$.lineCount'))) FROM jsonb_each(p.json))
      WHEN 'events' THEN (SELECT json_group_array(json_object('id',json_extract(e.value,'$.id'),'client',json_extract(e.value,'$.client'),
        'sessionId',json_extract(e.value,'$.sessionId'),'tool',json_extract(e.value,'$.tool'),'kind',json_extract(e.value,'$.kind'),
        'status',json_extract(e.value,'$.status'),'occurredAt',json_extract(e.value,'$.occurredAt'),'cwd',json_extract(e.value,'$.cwd'),
        'path',json_extract(e.value,'$.path'),'sources',json_extract(e.value,'$.sources'),
        'fragments',json(COALESCE((SELECT json_group_array(json_object('path',json_extract(f.value,'$.path')))
          FROM jsonb_each(e.value,'$.fragments') f WHERE json_extract(f.value,'$.path') IS NOT NULL),'[]')))) FROM jsonb_each(p.json) e)
      WHEN 'mappings' THEN (SELECT json_group_array(json_object('eventId',json_extract(value,'$.eventId'),
        'filePath',json_extract(value,'$.filePath'))) FROM jsonb_each(p.json))
      ELSE json END AS json FROM payload_parts p WHERE repository_id=? AND kind='snapshot' AND owner=?
        AND field IN ('baseline.files','events','mappings','gaps') ORDER BY field,part`)
      .iterate(repositoryId, selected) as Iterable<{ field: string; part: number; json: string }>;
    for (const part of parts) {
      const field = part.field === "baseline.files" ? "files" : part.field as "events" | "mappings" | "gaps";
      const values = JSON.parse(part.json) as unknown[];
      for (const value of values) {
        if (field === "events") {
          const event = value as ReplaySnapshot["events"][number];
          for (const key of ["occurredAt", "cwd", "path"] as const) if (event[key] == null) delete event[key];
          if (isSupportedClient(event.client) && !result.eventParts.has(event.id)) result.eventParts.set(event.id, part.part);
        }
        (result[field] as unknown[]).push(value);
      }
    }
    const events = result.events.filter(event => isSupportedClient(event.client));
    if (events.length !== result.events.length) {
      const ids = new Set(events.map(event => event.id));
      result.events = events;
      result.mappings = result.mappings.filter(mapping => ids.has(mapping.eventId));
    }
    result.gaps = result.gaps.filter(gap => !inactiveClientIds.some(client => gap.sourceId?.startsWith(`${client}:`)));
    return result;
  }

  /** 固定版本和已知分块只回读一个完整活动，不恢复整个仓库正文。 */
  getReplayEvent(repositoryId: string, version: string, part: number, eventId: string): HistoryEvent {
    return this.database.transaction(() => {
      const selected = this.analysisVersion(repositoryId, version);
      const row = this.database.prepare(`SELECT json(e.value) AS json FROM payload_parts p,jsonb_each(p.json) e
        WHERE p.repository_id=? AND p.kind='snapshot' AND p.owner=? AND p.field='events' AND p.part=?
          AND json_extract(e.value,'$.id')=? LIMIT 1`).get(repositoryId, selected, part, eventId) as JsonRow | undefined;
      if (!row) throw new StoreError("EVENT_NOT_FOUND", "活动不在所选分析范围内", { key: "diagnostics.server.m018" });
      const event = JSON.parse(row.json) as HistoryEvent;
      if (!isSupportedClient(event.client)) throw new StoreError("EVENT_NOT_FOUND", "活动不在所选分析范围内", { key: "diagnostics.server.m018" });
      return event;
    }).deferred();
  }

  /** 总览覆盖摘要省略基线正文、事件正文与工具参数，原证据仍由完整快照接口读取。 */
  getCoverageSnapshot(repositoryId: string, version?: string, eventParts?: Map<string, number>): AnalysisSnapshot {
    const parts = eventParts ?? new Map<string, number>();
    let missing = false;
    const snapshot = this.database.transaction(() => {
      const selected = this.analysisVersion(repositoryId, version);
      const row = this.database.prepare("SELECT json FROM payload_parts WHERE repository_id=? AND kind='coverage-v1' AND owner=? AND field='$header' AND part=0")
        .get(repositoryId, selected) as JsonRow | undefined;
      if (row) {
        const cached = this.readPayload<{ snapshot: AnalysisSnapshot; eventParts: Record<string, number> }>(row.json, repositoryId, "coverage-v1", selected);
        for (const [id, part] of Object.entries(cached.eventParts)) parts.set(id, part);
        return this.normalizeSnapshot(cached.snapshot, this.getRepository(repositoryId), selected);
      }
      missing = true;
      return this.readSnapshot(repositoryId, selected, true, parts);
    }).deferred();
    // 老版本首次读取后补齐派生缓存，不改分析版本或原始证据；只读消费者不写入。
    if (missing && !this.readOnly) this.cacheCoverageSnapshot(snapshot, parts);
    return snapshot;
  }

  /** 仓库摘要只需活动身份、路径与首来源；不能恢复用于证据的全部来源副本及正文。 */
  getOverviewSnapshot(repositoryId: string, version?: string): AnalysisSnapshot {
    return this.database.transaction(() => {
      const selected = this.analysisVersion(repositoryId, version), repository = this.getRepository(repositoryId);
      const row = this.database.prepare("SELECT snapshot AS json FROM versions WHERE repository_id=? AND version=?")
        .get(repositoryId, selected) as JsonRow;
      const snapshot = (JSON.parse(row.json) as { value: AnalysisSnapshot }).value;
      const cached = this.database.prepare("SELECT 1 FROM payload_parts WHERE repository_id=? AND kind='coverage-v1' AND owner=? AND field='$header'")
        .get(repositoryId, selected);
      const prefix = cached ? "snapshot." : "", kind = cached ? "coverage-v1" : "snapshot";
      const fields = ["baseline.files", "events", "sources", "mappings", "gaps"].map(field => prefix + field);
      const rows = this.database.prepare(`SELECT replace(field,?,'') AS field,CASE
        WHEN field=? THEN (SELECT json_group_array(json_object('path',json_extract(value,'$.path'),
          'category',json_extract(value,'$.category'),'lineCount',json_extract(value,'$.lineCount'),'hash',json_extract(value,'$.hash'),'content','')) FROM jsonb_each(p.json))
        WHEN field=? THEN (SELECT json_group_array(json_object('id',json_extract(e.value,'$.id'),'client',json_extract(e.value,'$.client'),
          'sessionId',json_extract(e.value,'$.sessionId'),'tool',json_extract(e.value,'$.tool'),'kind',json_extract(e.value,'$.kind'),
          'status',json_extract(e.value,'$.status'),'occurredAt',json_extract(e.value,'$.occurredAt'),
          'cwd',json_extract(e.value,'$.cwd'),'path',json_extract(e.value,'$.path'),
          'sources',json(CASE WHEN json_array_length(e.value,'$.sources')>0 THEN json_array(json_extract(e.value,'$.sources[0]')) ELSE '[]' END),
          'fragments',json(COALESCE((SELECT json_group_array(json_object('content','','kind',json_extract(f.value,'$.kind'),
            'path',json_extract(f.value,'$.path'),'historicalStart',json_extract(f.value,'$.historicalStart'),
            'completeLines',json(f.value -> '$.completeLines'))) FROM jsonb_each(e.value,'$.fragments') f),'[]')))) FROM jsonb_each(p.json) e)
        ELSE json END AS json FROM payload_parts p WHERE repository_id=? AND kind=? AND owner=?
          AND field IN (SELECT value FROM json_each(?)) ORDER BY field,part`)
        .iterate(prefix, prefix + "baseline.files", prefix + "events", repositoryId, kind, selected, JSON.stringify(fields)) as Iterable<{ field: string; json: string }>;
      for (const part of rows) {
        const values = JSON.parse(part.json) as unknown[];
        const target = part.field === "baseline.files" ? snapshot.baseline.files : snapshot[part.field as "events" | "sources" | "mappings" | "gaps"];
        for (const value of values) target.push(value as never);
      }
      return this.normalizeSnapshot(snapshot, repository, selected);
    }).deferred();
  }

  private coverageMetadata(snapshot: AnalysisSnapshot): AnalysisSnapshot {
    return { ...snapshot, baseline: { ...snapshot.baseline, files: snapshot.baseline.files.map(file => ({ ...file, content: "" })) },
      sources: snapshot.sources.map(source => this.sourceMetadata(source)), events: snapshot.events.map(event => {
        const { input: _input, output: _output, reason: _reason, ...metadata } = event;
        return { ...metadata, fragments: event.fragments.map(fragment => ({ ...fragment, content: "" })) };
      }) };
  }

  private cacheCoverageSnapshot(snapshot: AnalysisSnapshot, eventParts: ReadonlyMap<string, number>): void {
    try {
      this.database.transaction(() => {
        const repositoryId = snapshot.repository.id, version = snapshot.version;
        // 等待写锁期间版本可能已淘汰；不能重新插入已过期的缓存。
        if (!this.database.prepare("SELECT 1 FROM versions WHERE repository_id=? AND version=?").get(repositoryId, version)) return;
        if (this.database.prepare("SELECT 1 FROM payload_parts WHERE repository_id=? AND kind='coverage-v1' AND owner=? AND field='$header'").get(repositoryId, version)) return;
        const json = this.writePayload({ snapshot, eventParts: Object.fromEntries(eventParts) }, repositoryId, "coverage-v1", version,
          ["snapshot.baseline.files", "snapshot.baseline.excluded", "snapshot.sources", "snapshot.events", "snapshot.mappings", "snapshot.gaps", "eventParts"]);
        this.database.prepare("INSERT INTO payload_parts(repository_id,kind,owner,field,part,json) VALUES(?,'coverage-v1',?,'$header',0,?)")
          .run(repositoryId, version, json);
      }).immediate();
    } catch (error) {
      // 缓存写锁争用或空间不足时仍返回完整结果，下一次未命中可以重试。
      if (!["SQLITE_BUSY", "SQLITE_FULL"].includes((error as { code?: string }).code ?? "")) throw error;
    }
  }

  /** 详情只恢复选中活动所在的分块；同一分块内多条活动一次读取，避免重读整仓正文。 */
  getSnapshotEvents(repositoryId: string, version: string, eventParts: ReadonlyMap<string, number>): HistoryEvent[] {
    return this.database.transaction(() => {
      const selected = this.analysisVersion(repositoryId, version);
      const groups = new Map<number, string[]>();
      for (const [id, part] of eventParts) {
        if (!groups.has(part)) groups.set(part, []);
        groups.get(part)!.push(id);
      }
      const query = this.database.prepare(`SELECT json(e.value) AS json FROM payload_parts p,jsonb_each(p.json) e
        WHERE p.repository_id=? AND p.kind='snapshot' AND p.owner=? AND p.field='events' AND p.part=?
          AND json_extract(e.value,'$.id') IN (SELECT value FROM json_each(?))`);
      const events: HistoryEvent[] = [];
      for (const [part, ids] of groups) {
        for (const row of query.iterate(repositoryId, selected, part, JSON.stringify(ids)) as Iterable<JsonRow>) {
          const event = JSON.parse(row.json) as HistoryEvent;
          if (isSupportedClient(event.client)) events.push(event);
        }
      }
      return events;
    }).deferred();
  }

  private readSnapshot(repositoryId: string, version: string | undefined, coverageOnly: boolean, eventParts?: Map<string, number>): AnalysisSnapshot {
    const repository = this.getRepository(repositoryId);
    const selected = version ?? repository.version;
    if (!selected) throw new StoreError("ANALYSIS_NOT_READY", "仓库尚无完整分析结果", { key: "diagnostics.index.store.m003" });
    const row = this.database.prepare("SELECT snapshot AS json FROM versions WHERE repository_id=? AND version=?")
      .get(repositoryId, selected) as JsonRow | undefined;
    if (!row) throw new StoreError("VERSION_NOT_FOUND", "分析结果版本不可用：不存在或已被淘汰", { key: "diagnostics.index.store.m004" });
    const snapshot = this.readPayload<AnalysisSnapshot>(row.json, repositoryId, "snapshot", selected, coverageOnly, eventParts);
    return this.normalizeSnapshot(snapshot, repository, selected);
  }

  private normalizeSnapshot(snapshot: AnalysisSnapshot, repository: Repository, selected: string): AnalysisSnapshot {
    snapshot.sources = snapshot.sources.filter(source => isSupportedClient(source.client)).map(source => this.sourceMetadata(source));
    const events = snapshot.events.filter(event => isSupportedClient(event.client));
    if (events.length !== snapshot.events.length) {
      const eventIds = new Set(events.map(event => event.id));
      snapshot.mappings = snapshot.mappings.filter(mapping => eventIds.has(mapping.eventId));
      snapshot.events = events;
    }
    snapshot.gaps = snapshot.gaps.filter(gap => !inactiveClientIds.some(client => gap.sourceId?.startsWith(`${client}:`)));
    snapshot.repository.stale = repository.stale || selected !== repository.version;
    snapshot.baseline.repository = { ...snapshot.repository };
    return snapshot;
  }

  listSources(repositoryId: string, version?: string): SourcesResponse {
    const selected = this.selectVersion(repositoryId, version);
    const row = this.database.prepare("SELECT sources AS json FROM versions WHERE repository_id=? AND version=?")
      .get(repositoryId, selected) as JsonRow | undefined;
    if (!row) throw new StoreError("VERSION_NOT_FOUND", "分析结果版本不可用：不存在或已被淘汰", { key: "diagnostics.index.store.m004" });
    const sources = this.readPayload<Omit<SourcesResponse, "gaps">>(row.json, repositoryId, "sources", selected);
    const gaps: SourcesResponse["gaps"] = [];
    // 缺口只在快照保存；这里仅读取该字段分块，不加载事件和代码正文。
    for (const part of this.database.prepare("SELECT json FROM payload_parts WHERE repository_id=? AND kind='snapshot' AND owner=? AND field='gaps' ORDER BY part")
      .iterate(repositoryId, selected) as Iterable<JsonRow>) {
      for (const gap of JSON.parse(part.json) as SourcesResponse["gaps"]) gaps.push(gap);
    }
    return { ...sources, sources: sources.sources.filter(source => isSupportedClient(source.client)),
      unassociated: sources.unassociated.filter(source => isSupportedClient(source.client)),
      gaps: gaps.filter(gap => !inactiveClientIds.some(client => gap.sourceId?.startsWith(`${client}:`))) };
  }

  associateSource(repositoryId: string, sourceId: string): void {
    this.getRepository(repositoryId);
    const sources = this.listSources(repositoryId);
    if (![...sources.sources, ...sources.unassociated].some((source) => source.sourceId === sourceId)) {
      throw new StoreError("SOURCE_NOT_FOUND", "来源尚未发现", { key: "diagnostics.index.store.m005" });
    }
    this.database.prepare("INSERT OR IGNORE INTO manual_associations(repository_id,source_id) VALUES(?,?)")
      .run(repositoryId, sourceId);
  }

  getManualAssociations(repositoryId: string): Set<string> {
    this.getRepository(repositoryId);
    return new Set((this.database.prepare("SELECT source_id FROM manual_associations WHERE repository_id=?")
      .all(repositoryId) as { source_id: string }[]).map((row) => row.source_id));
  }

  getParsedSources(repositoryId: string): ParsedSource[] {
    const rows = this.database.prepare("SELECT source_id,path,json FROM source_cache WHERE repository_id=? ORDER BY path")
      .iterate(repositoryId) as Iterable<JsonRow & { source_id: string; path: string }>;
    return Array.from(rows).filter(row => isSupportedClient((JSON.parse(row.json) as { value: ParsedSource }).value.client))
      .map(row => this.readPayload<ParsedSource>(row.json, repositoryId, "parsed", JSON.stringify([row.source_id, row.path])));
  }

  getParsedSourceLocations(repositoryId: string): HistorySource[] {
    const rows = this.database.prepare("SELECT json FROM source_cache WHERE repository_id=? ORDER BY path").iterate(repositoryId) as Iterable<JsonRow>;
    return Array.from(rows, row => {
      const decoded = JSON.parse(row.json) as { value: ParsedSource };
      return this.sourceMetadata(decoded.value);
    }).filter(source => isSupportedClient(source.client));
  }

  getDiscoveryCache(repositoryId: string): NonNullable<DiscoverOptions["cachedSources"]> {
    const rows = this.database.prepare("SELECT json FROM source_cache WHERE repository_id=? ORDER BY path").iterate(repositoryId) as Iterable<JsonRow>;
    const cached: NonNullable<DiscoverOptions["cachedSources"]>[number][] = [];
    for (const row of rows) {
      const source = (JSON.parse(row.json) as { value: ParsedSource }).value;
      if (!isSupportedClient(source.client)) continue;
      const cursor = source.cursor as { ruleVersion?: string; quickStamp?: string } | undefined;
      if (cursor?.ruleVersion === PARSER_RULE_VERSION && cursor.quickStamp) cached.push({ location: this.sourceMetadata(source), stamp: cursor.quickStamp });
    }
    return cached;
  }

  getParsedSource(repositoryId: string, sourceId: string, path: string): ParsedSource | undefined {
    if (inactiveClientIds.some(client => sourceId.startsWith(`${client}:`))) return undefined;
    const row = this.database.prepare("SELECT json FROM source_cache WHERE repository_id=? AND source_id=? AND path=?")
      .get(repositoryId, sourceId, path) as JsonRow | undefined;
    return row ? this.readPayload<ParsedSource>(row.json, repositoryId, "parsed", JSON.stringify([sourceId, path])) : undefined;
  }

  getTrackedSources(repositoryId: string): HistorySource[] {
    return (this.database.prepare("SELECT json FROM tracked_sources WHERE repository_id=? ORDER BY source_id")
      .all(repositoryId) as JsonRow[]).map((row) => JSON.parse(row.json) as HistorySource)
      .filter(source => isSupportedClient(source.client));
  }

  getMapping(repositoryId: string, key: string): Mapping | undefined {
    const row = this.database.prepare("SELECT json FROM mapping_cache WHERE repository_id=? AND key=?")
      .get(repositoryId, key) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as Mapping : undefined;
  }

  getRefreshStats(repositoryId: string, version?: string): RefreshStats {
    const selected = this.selectVersion(repositoryId, version);
    if (!version) {
      const latest = this.database.prepare("SELECT json FROM jobs WHERE repository_id=? AND json_extract(json,'$.status')='completed' AND json_extract(json,'$.version')=? AND json_type(json,'$.refreshStats')='object' ORDER BY rowid DESC LIMIT 1")
        .get(repositoryId, selected) as JsonRow | undefined;
      if (latest) return (JSON.parse(latest.json) as RefreshJob).refreshStats!;
    }
    const row = this.database.prepare("SELECT stats AS json FROM versions WHERE repository_id=? AND version=?")
      .get(repositoryId, selected) as JsonRow | undefined;
    if (!row) throw new StoreError("VERSION_NOT_FOUND", "分析结果版本不可用：不存在或已被淘汰", { key: "diagnostics.index.store.m004" });
    return JSON.parse(row.json) as RefreshStats;
  }

  private selectVersion(repositoryId: string, version?: string): string {
    const selected = version ?? this.getRepository(repositoryId).version;
    if (!selected) throw new StoreError("ANALYSIS_NOT_READY", "仓库尚无完整分析结果", { key: "diagnostics.index.store.m003" });
    this.getRepository(repositoryId);
    return selected;
  }

  createJob(repositoryId: string): Job {
    this.getRepository(repositoryId);
    const job: Job = { id: randomUUID(), repositoryId, status: "queued", phase: "等待分析", phaseDescriptor: { key: "diagnostics.index.store.m006" }, progress: 0 };
    this.database.prepare("INSERT INTO jobs(id,repository_id,json) VALUES(?,?,?)")
      .run(job.id, repositoryId, JSON.stringify(job));
    return job;
  }

  getJob(id: string): RefreshJob {
    const job = this.findJob(id);
    if (!job) throw new StoreError("JOB_NOT_FOUND", "刷新任务不存在", { key: "diagnostics.index.store.m007" });
    return job;
  }

  findJob(id: string): RefreshJob | undefined {
    const row = this.database.prepare("SELECT json FROM jobs WHERE id=?").get(id) as JsonRow | undefined;
    return row ? JSON.parse(row.json) as RefreshJob : undefined;
  }

  assertRunningJob(id: string, repositoryId: string): void {
    const job = this.findJob(id);
    if (!job || job.repositoryId !== repositoryId || job.status !== "running") throw new JobCancelledError();
  }

  listJobs(): RefreshJob[] {
    return (this.database.prepare("SELECT json FROM jobs ORDER BY rowid DESC").all() as JsonRow[])
      .map((row) => JSON.parse(row.json) as RefreshJob);
  }

  statusCounts(): { repositoryCount: number; jobCount: number } {
    return this.database.prepare("SELECT (SELECT COUNT(*) FROM repositories) AS repositoryCount,(SELECT COUNT(*) FROM jobs) AS jobCount")
      .get() as { repositoryCount: number; jobCount: number };
  }

  updateJob(id: string, changes: Partial<RefreshJob>): RefreshJob {
    const job = { ...this.getJob(id), ...changes };
    this.database.prepare("UPDATE jobs SET json=? WHERE id=?").run(JSON.stringify(job), id);
    return job;
  }

  failJob(id: string, error: string, errorDescriptor?: MessageDescriptor): Job | undefined {
    return this.database.transaction(() => {
      const existing = this.findJob(id);
      if (!existing || existing.status === "failed" || existing.status === "completed") return existing;
      const job = this.updateJob(id, { status: "failed", phase: "刷新失败", phaseDescriptor: { key: "diagnostics.index.store.m008" }, progress: 1, finishedAt: new Date().toISOString(), error, errorDescriptor });
      this.database.prepare("UPDATE repositories SET stale=1 WHERE id=?").run(job.repositoryId);
      return job;
    }).immediate();
  }

  recoverJobs(): void {
    for (const job of this.listJobs()) {
      if (job.status === "queued" || job.status === "running") this.failJob(job.id, "后台上次停止时刷新尚未完成", { key: "diagnostics.index.store.interrupted" });
    }
  }

  publish(input: PublishInput): void {
    this.database.transaction(() => {
      const { snapshot } = input;
      const repositoryId = snapshot.repository.id;
      // 检查与全部写入共享写锁；同路径重登也不会恢复旧任务身份。
      this.assertRunningJob(input.jobId, repositoryId);
      const { gaps: _sourceGaps, ...savedSources } = input.sources;
      const savedSnapshot = { ...snapshot, sources: snapshot.sources.map((source) => this.sourceMetadata(source)) };
      const eventParts = new Map<string, number>();
      // 无变化检查沿用完整旧版；发布时统计和创建时间保持不可变。
      if (input.reusedVersion) {
        if (this.getRepository(repositoryId).version !== input.reusedVersion) throw new StoreError("VERSION_NOT_FOUND", "分析结果版本不可用：不存在或已被淘汰", { key: "diagnostics.index.store.m004" });
      } else this.database.prepare("INSERT INTO versions(repository_id,version,snapshot,sources,stats) VALUES(?,?,?,?,?)")
        .run(repositoryId, snapshot.version,
          this.writePayload(savedSnapshot, repositoryId, "snapshot", snapshot.version, ["baseline.files", "baseline.excluded", "sources", "events", "mappings", "gaps"], true, eventParts),
          this.writePayload(savedSources, repositoryId, "sources", snapshot.version, ["sources", "unassociated"]), JSON.stringify(input.stats));
      if (!input.reusedVersion) this.cacheCoverageSnapshot(this.coverageMetadata(savedSnapshot), eventParts);
      if (input.clearCache) {
        this.database.prepare("DELETE FROM mapping_cache WHERE repository_id=?").run(snapshot.repository.id);
      }
      const saveSource = this.database.prepare("INSERT INTO source_cache(repository_id,source_id,path,json) VALUES(?,?,?,?) ON CONFLICT(repository_id,source_id,path) DO UPDATE SET json=excluded.json WHERE json<>excluded.json");
      const removeSource = this.database.prepare("DELETE FROM source_cache WHERE repository_id=? AND source_id=? AND path=?");
      const removeParts = this.database.prepare("DELETE FROM payload_parts WHERE repository_id=? AND kind='parsed' AND owner=?");
      const currentSources = new Set(input.parsed.map(source => JSON.stringify([source.sourceId, source.path])));
      // 只清理确认移走、替换或缺失的缓存；未变来源不重新编码、删除和写入正文。
      for (const old of this.database.prepare("SELECT source_id,path FROM source_cache WHERE repository_id=?").all(repositoryId) as { source_id: string; path: string }[]) {
        const owner = JSON.stringify([old.source_id, old.path]);
        if (currentSources.has(owner)) continue;
        removeParts.run(repositoryId, owner);
        removeSource.run(repositoryId, old.source_id, old.path);
      }
      for (const source of input.parsed) {
        const owner = JSON.stringify([source.sourceId, source.path]);
        const reused = !input.clearCache && input.reusedParsed?.has(owner);
        if (!reused) removeParts.run(repositoryId, owner);
        saveSource.run(repositoryId, source.sourceId, source.path,
          this.writePayload(source, repositoryId, "parsed", owner,
            ["events", "gaps", "relationships", "cursor.pending", "cursor.recordEnds", "cursor.relationships", "cursor.seen", "cursor.occurrences"], !reused));
      }
      const trackSource = this.database.prepare("INSERT INTO tracked_sources(repository_id,source_id,json) VALUES(?,?,?) ON CONFLICT(repository_id,source_id) DO UPDATE SET json=excluded.json WHERE json<>excluded.json");
      this.database.prepare("DELETE FROM tracked_sources WHERE repository_id=? AND json_extract(json,'$.client') IN (SELECT value FROM json_each(?))")
        .run(repositoryId, JSON.stringify(inactiveClientIds));
      for (const source of snapshot.sources.filter(source => isSupportedClient(source.client))) trackSource.run(snapshot.repository.id, source.sourceId, JSON.stringify(this.sourceMetadata(source)));
      const saveMapping = this.database.prepare("INSERT INTO mapping_cache(repository_id,key,json) VALUES(?,?,?) ON CONFLICT(repository_id,key) DO UPDATE SET json=excluded.json WHERE json<>excluded.json");
      for (const entry of input.mappings) saveMapping.run(snapshot.repository.id, entry.key, JSON.stringify(entry.mapping));
      this.database.prepare("UPDATE repositories SET version=?,stale=0 WHERE id=?").run(snapshot.version, snapshot.repository.id);
      this.updateJob(input.jobId, { status: "completed", phase: "分析完成", phaseDescriptor: { key: "diagnostics.index.store.m009" }, progress: 1, finishedAt: new Date().toISOString(), version: snapshot.version,
        refreshStats: input.stats });
      // 发布序号独立于版本名称、创建时间及普通 rowid；淘汰与发布一同提交。
      const expired = "SELECT version FROM versions WHERE repository_id=? ORDER BY publication DESC LIMIT -1 OFFSET 2";
      this.database.prepare(`DELETE FROM payload_parts WHERE repository_id=? AND kind IN ('snapshot','sources','coverage-v1') AND owner IN (${expired})`)
        .run(repositoryId, repositoryId);
      this.database.prepare(`DELETE FROM versions WHERE repository_id=? AND version IN (${expired})`)
        .run(repositoryId, repositoryId);
    }).immediate();
  }

  close(): void { this.database.close(); }
}
