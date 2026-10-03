import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AnalysisSnapshot, ApiErrorCode, HistorySource, Job, Mapping, ParsedSource, Repository, SourcesResponse } from "../contracts.js";
import { getRepository } from "../analysis/index.js";

export class StoreError extends Error {
  constructor(public readonly code: ApiErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export interface RefreshStats {
  sourcesParsed: number;
  parsedRecords: number;
  mappingsComputed: number;
  mappingsReused: number;
}

export interface PublishInput {
  snapshot: AnalysisSnapshot;
  sources: SourcesResponse;
  parsed: ParsedSource[];
  mappings: { key: string; mapping: Mapping }[];
  stats: RefreshStats;
  clearCache: boolean;
  jobId: string;
}

interface JsonRow { json: string }
interface RepositoryRow { json: string; version: string | null; stale: number }

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
    this.migrate();
  }

  private migrate(): void {
    const version = this.database.pragma("user_version", { simple: true }) as number;
    if (version > 2) throw new Error(`不支持的索引版本 ${version}`);
    if (version === 2) return;
    this.database.transaction(() => {
      if (version === 0) this.database.exec(`
        CREATE TABLE repositories (id TEXT PRIMARY KEY, json TEXT NOT NULL, version TEXT, stale INTEGER NOT NULL);
        CREATE TABLE manual_associations (repository_id TEXT NOT NULL REFERENCES repositories(id), source_id TEXT NOT NULL, PRIMARY KEY(repository_id, source_id));
        CREATE TABLE jobs (id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES repositories(id), json TEXT NOT NULL);
        CREATE TABLE versions (repository_id TEXT NOT NULL REFERENCES repositories(id), version TEXT NOT NULL, snapshot TEXT NOT NULL, sources TEXT NOT NULL, stats TEXT NOT NULL, PRIMARY KEY(repository_id, version));
        CREATE TABLE source_cache (repository_id TEXT NOT NULL REFERENCES repositories(id), source_id TEXT NOT NULL, path TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(repository_id, source_id, path));
        CREATE INDEX source_cache_path ON source_cache(repository_id, path);
        CREATE TABLE mapping_cache (repository_id TEXT NOT NULL REFERENCES repositories(id), key TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(repository_id, key));
        PRAGMA user_version = 1;
      `);
      this.database.exec("CREATE TABLE tracked_sources (repository_id TEXT NOT NULL REFERENCES repositories(id), source_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(repository_id, source_id));");
      const save = this.database.prepare("INSERT OR REPLACE INTO tracked_sources(repository_id,source_id,json) VALUES(?,?,?)");
      const rows = this.database.prepare("SELECT versions.snapshot AS json FROM versions JOIN repositories ON versions.repository_id=repositories.id AND versions.version=repositories.version").all() as JsonRow[];
      for (const row of rows) {
        const snapshot = JSON.parse(row.json) as AnalysisSnapshot;
        for (const source of snapshot.sources) save.run(snapshot.repository.id, source.sourceId, JSON.stringify(this.sourceMetadata(source)));
      }
      this.database.pragma("user_version = 2");
    })();
  }

  private sourceMetadata(source: HistorySource): HistorySource {
    const { sourceId, client, path, hash, sessionId, cwd, parentSessionId } = source;
    return { sourceId, client, path, hash, sessionId, cwd, parentSessionId };
  }

  async registerRepository(path: string): Promise<Repository> {
    const repository = await getRepository(path);
    this.database.prepare("INSERT OR IGNORE INTO repositories(id,json,stale) VALUES(?,?,1)")
      .run(repository.id, JSON.stringify(repository));
    return this.getRepository(repository.id);
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
    if (!row) throw new StoreError("REPOSITORY_NOT_FOUND", "仓库尚未登记");
    return this.repository(row);
  }

  getSnapshot(repositoryId: string, version?: string): AnalysisSnapshot {
    const repository = this.getRepository(repositoryId);
    const selected = version ?? repository.version;
    if (!selected) throw new StoreError("ANALYSIS_NOT_READY", "仓库尚无完整分析结果");
    const row = this.database.prepare("SELECT snapshot AS json FROM versions WHERE repository_id=? AND version=?")
      .get(repositoryId, selected) as JsonRow | undefined;
    if (!row) throw new StoreError("VERSION_NOT_FOUND", "分析结果版本不存在");
    const snapshot = JSON.parse(row.json) as AnalysisSnapshot;
    snapshot.repository.stale = repository.stale || selected !== repository.version;
    snapshot.baseline.repository = { ...snapshot.repository };
    return snapshot;
  }

  listSources(repositoryId: string, version?: string): SourcesResponse {
    const snapshot = this.getSnapshot(repositoryId, version);
    const row = this.database.prepare("SELECT sources AS json FROM versions WHERE repository_id=? AND version=?")
      .get(repositoryId, snapshot.version) as JsonRow;
    return JSON.parse(row.json) as SourcesResponse;
  }

  associateSource(repositoryId: string, sourceId: string): void {
    this.getRepository(repositoryId);
    const sources = this.listSources(repositoryId);
    if (![...sources.sources, ...sources.unassociated].some((source) => source.sourceId === sourceId)) {
      throw new StoreError("SOURCE_NOT_FOUND", "来源尚未发现");
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
    return (this.database.prepare("SELECT json FROM source_cache WHERE repository_id=? ORDER BY path")
      .all(repositoryId) as JsonRow[]).map((row) => JSON.parse(row.json) as ParsedSource);
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
    const snapshot = this.getSnapshot(repositoryId, version);
    const row = this.database.prepare("SELECT stats AS json FROM versions WHERE repository_id=? AND version=?")
      .get(repositoryId, snapshot.version) as JsonRow;
    return JSON.parse(row.json) as RefreshStats;
  }

  createJob(repositoryId: string): Job {
    this.getRepository(repositoryId);
    const job: Job = { id: randomUUID(), repositoryId, status: "queued", phase: "等待分析", progress: 0 };
    this.database.prepare("INSERT INTO jobs(id,repository_id,json) VALUES(?,?,?)")
      .run(job.id, repositoryId, JSON.stringify(job));
    return job;
  }

  getJob(id: string): Job {
    const row = this.database.prepare("SELECT json FROM jobs WHERE id=?").get(id) as JsonRow | undefined;
    if (!row) throw new StoreError("JOB_NOT_FOUND", "刷新任务不存在");
    return JSON.parse(row.json) as Job;
  }

  listJobs(): Job[] {
    return (this.database.prepare("SELECT json FROM jobs ORDER BY rowid DESC").all() as JsonRow[])
      .map((row) => JSON.parse(row.json) as Job);
  }

  updateJob(id: string, changes: Partial<Job>): Job {
    const job = { ...this.getJob(id), ...changes };
    this.database.prepare("UPDATE jobs SET json=? WHERE id=?").run(JSON.stringify(job), id);
    return job;
  }

  failJob(id: string, error: string): Job {
    return this.database.transaction(() => {
      const job = this.updateJob(id, { status: "failed", phase: "刷新失败", progress: 1, finishedAt: new Date().toISOString(), error });
      this.database.prepare("UPDATE repositories SET stale=1 WHERE id=?").run(job.repositoryId);
      return job;
    })();
  }

  recoverJobs(): void {
    for (const job of this.listJobs()) {
      if (job.status === "queued" || job.status === "running") this.failJob(job.id, "后台上次停止时刷新尚未完成");
    }
  }

  publish(input: PublishInput): void {
    this.database.transaction(() => {
      const { snapshot } = input;
      // 相同 version 不允许覆盖，旧证据与创建时间保持不可变。
      this.database.prepare("INSERT INTO versions(repository_id,version,snapshot,sources,stats) VALUES(?,?,?,?,?)")
        .run(snapshot.repository.id, snapshot.version, JSON.stringify(snapshot), JSON.stringify(input.sources), JSON.stringify(input.stats));
      if (input.clearCache) {
        this.database.prepare("DELETE FROM mapping_cache WHERE repository_id=?").run(snapshot.repository.id);
      }
      const saveSource = this.database.prepare("INSERT OR REPLACE INTO source_cache(repository_id,source_id,path,json) VALUES(?,?,?,?)");
      // 清理移动、替换和缺失来源的旧游标；当前来源才参与下一轮续读。
      this.database.prepare("DELETE FROM source_cache WHERE repository_id=?").run(snapshot.repository.id);
      for (const source of input.parsed) saveSource.run(snapshot.repository.id, source.sourceId, source.path, JSON.stringify(source));
      const trackSource = this.database.prepare("INSERT OR REPLACE INTO tracked_sources(repository_id,source_id,json) VALUES(?,?,?)");
      for (const source of snapshot.sources) trackSource.run(snapshot.repository.id, source.sourceId, JSON.stringify(this.sourceMetadata(source)));
      const saveMapping = this.database.prepare("INSERT OR REPLACE INTO mapping_cache(repository_id,key,json) VALUES(?,?,?)");
      for (const entry of input.mappings) saveMapping.run(snapshot.repository.id, entry.key, JSON.stringify(entry.mapping));
      this.database.prepare("UPDATE repositories SET version=?,stale=0 WHERE id=?").run(snapshot.version, snapshot.repository.id);
      this.updateJob(input.jobId, { status: "completed", phase: "分析完成", progress: 1, finishedAt: new Date().toISOString(), version: snapshot.version });
    })();
  }

  close(): void { this.database.close(); }
}
