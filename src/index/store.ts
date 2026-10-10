import type { MessageDescriptor } from "../i18n/types.js";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AnalysisSnapshot, ApiErrorCode, HistorySource, Job, Mapping, ParsedSource, Repository, SourcesResponse } from "../contracts.js";
import { getRepository } from "../analysis/index.js";
import { initializeIndexSchema } from "./schema.js";
import { PARSER_RULE_VERSION } from "../version.js";
import type { DiscoverOptions } from "../history/types.js";

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
type PayloadKind = "snapshot" | "sources" | "parsed";
const PART_SIZE = 1024 * 1024;

/** 查询只读取完整已发布版本；可复用缓存与版本发布在同一事务提交。 */
export class AnalysisStore {
  readonly dbPath: string;
  private readonly database: Database.Database;

  constructor(dbPath: string) {
    this.dbPath = resolve(dbPath);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.database = new Database(this.dbPath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    try { this.initialize(); } catch (error) { this.database.close(); throw error; }
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
  private writePayload(value: object, repositoryId: string, kind: PayloadKind, owner: string, fields: string[], writeParts = true): string {
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
        parts.push(item);
        size += item.length + 1;
      }
      flush();
    }
    return JSON.stringify({ partsFormat: 4, value: header });
  }

  private readPayload<T>(json: string, repositoryId: string, kind: PayloadKind, owner: string): T {
    const decoded = JSON.parse(json) as { value: Record<string, unknown> };
    const rows = this.database.prepare("SELECT field,json FROM payload_parts WHERE repository_id=? AND kind=? AND owner=? ORDER BY field,part")
      .iterate(repositoryId, kind, owner) as Iterable<{ field: string; json: string }>;
    for (const row of rows) {
      const path = row.field.split(".");
      let target = decoded.value;
      for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>;
      const collection = target[path.at(-1)!];
      const part = JSON.parse(row.json) as unknown[] | Record<string, unknown>;
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
    const repository = this.getRepository(repositoryId);
    const selected = version ?? repository.version;
    if (!selected) throw new StoreError("ANALYSIS_NOT_READY", "仓库尚无完整分析结果", { key: "diagnostics.index.store.m003" });
    const row = this.database.prepare("SELECT snapshot AS json FROM versions WHERE repository_id=? AND version=?")
      .get(repositoryId, selected) as JsonRow | undefined;
    if (!row) throw new StoreError("VERSION_NOT_FOUND", "分析结果版本不可用：不存在或已被淘汰", { key: "diagnostics.index.store.m004" });
    const snapshot = this.readPayload<AnalysisSnapshot>(row.json, repositoryId, "snapshot", selected);
    snapshot.sources = snapshot.sources.map((source) => this.sourceMetadata(source));
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
    return { ...sources, gaps };
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
    return Array.from(rows, (row) => this.readPayload<ParsedSource>(row.json, repositoryId, "parsed", JSON.stringify([row.source_id, row.path])));
  }

  getParsedSourceLocations(repositoryId: string): HistorySource[] {
    const rows = this.database.prepare("SELECT json FROM source_cache WHERE repository_id=? ORDER BY path").iterate(repositoryId) as Iterable<JsonRow>;
    return Array.from(rows, row => {
      const decoded = JSON.parse(row.json) as { value: ParsedSource };
      return this.sourceMetadata(decoded.value);
    });
  }

  getDiscoveryCache(repositoryId: string): NonNullable<DiscoverOptions["cachedSources"]> {
    const rows = this.database.prepare("SELECT json FROM source_cache WHERE repository_id=? ORDER BY path").iterate(repositoryId) as Iterable<JsonRow>;
    const cached: NonNullable<DiscoverOptions["cachedSources"]>[number][] = [];
    for (const row of rows) {
      const source = (JSON.parse(row.json) as { value: ParsedSource }).value;
      const cursor = source.cursor as { ruleVersion?: string; quickStamp?: string } | undefined;
      if (cursor?.ruleVersion === PARSER_RULE_VERSION && cursor.quickStamp) cached.push({ location: this.sourceMetadata(source), stamp: cursor.quickStamp });
    }
    return cached;
  }

  getParsedSource(repositoryId: string, sourceId: string, path: string): ParsedSource | undefined {
    const row = this.database.prepare("SELECT json FROM source_cache WHERE repository_id=? AND source_id=? AND path=?")
      .get(repositoryId, sourceId, path) as JsonRow | undefined;
    return row ? this.readPayload<ParsedSource>(row.json, repositoryId, "parsed", JSON.stringify([sourceId, path])) : undefined;
  }

  getTrackedSources(repositoryId: string): HistorySource[] {
    return (this.database.prepare("SELECT json FROM tracked_sources WHERE repository_id=? ORDER BY source_id")
      .all(repositoryId) as JsonRow[]).map((row) => JSON.parse(row.json) as HistorySource);
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
      // 无变化检查沿用完整旧版；发布时统计和创建时间保持不可变。
      if (input.reusedVersion) {
        if (this.getRepository(repositoryId).version !== input.reusedVersion) throw new StoreError("VERSION_NOT_FOUND", "分析结果版本不可用：不存在或已被淘汰", { key: "diagnostics.index.store.m004" });
      } else this.database.prepare("INSERT INTO versions(repository_id,version,snapshot,sources,stats) VALUES(?,?,?,?,?)")
        .run(repositoryId, snapshot.version,
          this.writePayload(savedSnapshot, repositoryId, "snapshot", snapshot.version, ["baseline.files", "baseline.excluded", "sources", "events", "mappings", "gaps"]),
          this.writePayload(savedSources, repositoryId, "sources", snapshot.version, ["sources", "unassociated"]), JSON.stringify(input.stats));
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
      for (const source of snapshot.sources) trackSource.run(snapshot.repository.id, source.sourceId, JSON.stringify(this.sourceMetadata(source)));
      const saveMapping = this.database.prepare("INSERT INTO mapping_cache(repository_id,key,json) VALUES(?,?,?) ON CONFLICT(repository_id,key) DO UPDATE SET json=excluded.json WHERE json<>excluded.json");
      for (const entry of input.mappings) saveMapping.run(snapshot.repository.id, entry.key, JSON.stringify(entry.mapping));
      this.database.prepare("UPDATE repositories SET version=?,stale=0 WHERE id=?").run(snapshot.version, snapshot.repository.id);
      this.updateJob(input.jobId, { status: "completed", phase: "分析完成", phaseDescriptor: { key: "diagnostics.index.store.m009" }, progress: 1, finishedAt: new Date().toISOString(), version: snapshot.version,
        refreshStats: input.stats });
      // 发布序号独立于版本名称、创建时间及普通 rowid；淘汰与发布一同提交。
      const expired = "SELECT version FROM versions WHERE repository_id=? ORDER BY publication DESC LIMIT -1 OFFSET 2";
      this.database.prepare(`DELETE FROM payload_parts WHERE repository_id=? AND kind IN ('snapshot','sources') AND owner IN (${expired})`)
        .run(repositoryId, repositoryId);
      this.database.prepare(`DELETE FROM versions WHERE repository_id=? AND version IN (${expired})`)
        .run(repositoryId, repositoryId);
    }).immediate();
  }

  close(): void { this.database.close(); }
}
