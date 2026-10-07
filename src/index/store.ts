import { DiagnosticError } from "../i18n/diagnostics.js";
import type { MessageDescriptor } from "../i18n/types.js";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AnalysisSnapshot, ApiErrorCode, HistorySource, Job, Mapping, ParsedSource, Repository, SourcesResponse } from "../contracts.js";
import { getRepository } from "../analysis/index.js";

export class StoreError extends Error {
  constructor(public readonly code: ApiErrorCode, message: string, readonly messageDescriptor?: MessageDescriptor) {
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
    this.migrate();
  }

  private migrate(): void {
    const version = this.database.pragma("user_version", { simple: true }) as number;
    if (version > 3) throw new DiagnosticError(`不支持的索引版本 ${version}`, { key: "diagnostics.index.store.m001", params: { p0: version } });
    if (version === 3) return;
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
      if (version < 2) {
        this.database.exec("CREATE TABLE tracked_sources (repository_id TEXT NOT NULL REFERENCES repositories(id), source_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(repository_id, source_id));");
        const save = this.database.prepare("INSERT OR REPLACE INTO tracked_sources(repository_id,source_id,json) VALUES(?,?,?)");
        const rows = this.database.prepare("SELECT versions.snapshot AS json FROM versions JOIN repositories ON versions.repository_id=repositories.id AND versions.version=repositories.version").all() as JsonRow[];
        for (const row of rows) {
          const snapshot = JSON.parse(row.json) as AnalysisSnapshot;
          for (const source of snapshot.sources) save.run(snapshot.repository.id, source.sourceId, JSON.stringify(this.sourceMetadata(source)));
        }
      }
      this.database.exec("CREATE TABLE payload_parts (repository_id TEXT NOT NULL REFERENCES repositories(id), kind TEXT NOT NULL, owner TEXT NOT NULL, field TEXT NOT NULL, part INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(repository_id,kind,owner,field,part));");
      this.database.pragma("user_version = 3");
    })();
  }

  /** 大集合逐项编码，读回也逐块恢复，不拼接整版 JSON 字符串。 */
  private writePayload(value: object, repositoryId: string, kind: PayloadKind, owner: string, fields: string[]): string {
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
    return JSON.stringify({ partsFormat: 3, value: header });
  }

  private readPayload<T>(json: string, repositoryId: string, kind: PayloadKind, owner: string): T {
    const decoded = JSON.parse(json) as { partsFormat?: number; value: Record<string, unknown> };
    if (decoded.partsFormat !== 3) return decoded as T;
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
    if (!row) throw new StoreError("REPOSITORY_NOT_FOUND", "仓库尚未登记", { key: "diagnostics.index.store.m002" });
    return this.repository(row);
  }

  getSnapshot(repositoryId: string, version?: string): AnalysisSnapshot {
    const repository = this.getRepository(repositoryId);
    const selected = version ?? repository.version;
    if (!selected) throw new StoreError("ANALYSIS_NOT_READY", "仓库尚无完整分析结果", { key: "diagnostics.index.store.m003" });
    const row = this.database.prepare("SELECT snapshot AS json FROM versions WHERE repository_id=? AND version=?")
      .get(repositoryId, selected) as JsonRow | undefined;
    if (!row) throw new StoreError("VERSION_NOT_FOUND", "分析结果版本不存在", { key: "diagnostics.index.store.m004" });
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
    if (!row) throw new StoreError("VERSION_NOT_FOUND", "分析结果版本不存在", { key: "diagnostics.index.store.m004" });
    return this.readPayload<SourcesResponse>(row.json, repositoryId, "sources", selected);
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
      const decoded = JSON.parse(row.json) as ParsedSource & { partsFormat?: number; value: ParsedSource };
      return this.sourceMetadata(decoded.partsFormat === 3 ? decoded.value : decoded);
    });
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
    const row = this.database.prepare("SELECT stats AS json FROM versions WHERE repository_id=? AND version=?")
      .get(repositoryId, selected) as JsonRow | undefined;
    if (!row) throw new StoreError("VERSION_NOT_FOUND", "分析结果版本不存在", { key: "diagnostics.index.store.m004" });
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

  getJob(id: string): Job {
    const row = this.database.prepare("SELECT json FROM jobs WHERE id=?").get(id) as JsonRow | undefined;
    if (!row) throw new StoreError("JOB_NOT_FOUND", "刷新任务不存在", { key: "diagnostics.index.store.m007" });
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

  failJob(id: string, error: string, errorDescriptor?: MessageDescriptor): Job {
    const existing = this.getJob(id);
    if (existing.status === "failed") return existing;
    return this.database.transaction(() => {
      const job = this.updateJob(id, { status: "failed", phase: "刷新失败", phaseDescriptor: { key: "diagnostics.index.store.m008" }, progress: 1, finishedAt: new Date().toISOString(), error, errorDescriptor });
      this.database.prepare("UPDATE repositories SET stale=1 WHERE id=?").run(job.repositoryId);
      return job;
    })();
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
      const savedSnapshot = { ...snapshot, sources: snapshot.sources.map((source) => this.sourceMetadata(source)) };
      // 相同 version 不允许覆盖，旧证据与创建时间保持不可变。
      this.database.prepare("INSERT INTO versions(repository_id,version,snapshot,sources,stats) VALUES(?,?,?,?,?)")
        .run(repositoryId, snapshot.version,
          this.writePayload(savedSnapshot, repositoryId, "snapshot", snapshot.version, ["baseline.files", "baseline.excluded", "sources", "events", "mappings", "gaps"]),
          this.writePayload(input.sources, repositoryId, "sources", snapshot.version, ["sources", "unassociated", "gaps"]), JSON.stringify(input.stats));
      if (input.clearCache) {
        this.database.prepare("DELETE FROM mapping_cache WHERE repository_id=?").run(snapshot.repository.id);
      }
      const saveSource = this.database.prepare("INSERT OR REPLACE INTO source_cache(repository_id,source_id,path,json) VALUES(?,?,?,?)");
      // 清理移动、替换和缺失来源的旧游标；当前来源才参与下一轮续读。
      this.database.prepare("DELETE FROM source_cache WHERE repository_id=?").run(snapshot.repository.id);
      this.database.prepare("DELETE FROM payload_parts WHERE repository_id=? AND kind='parsed'").run(repositoryId);
      for (const source of input.parsed) saveSource.run(repositoryId, source.sourceId, source.path,
        this.writePayload(source, repositoryId, "parsed", JSON.stringify([source.sourceId, source.path]),
          ["events", "gaps", "relationships", "cursor.pending", "cursor.recordEnds", "cursor.relationships", "cursor.seen", "cursor.occurrences"]));
      const trackSource = this.database.prepare("INSERT OR REPLACE INTO tracked_sources(repository_id,source_id,json) VALUES(?,?,?)");
      for (const source of snapshot.sources) trackSource.run(snapshot.repository.id, source.sourceId, JSON.stringify(this.sourceMetadata(source)));
      const saveMapping = this.database.prepare("INSERT OR REPLACE INTO mapping_cache(repository_id,key,json) VALUES(?,?,?)");
      for (const entry of input.mappings) saveMapping.run(snapshot.repository.id, entry.key, JSON.stringify(entry.mapping));
      this.database.prepare("UPDATE repositories SET version=?,stale=0 WHERE id=?").run(snapshot.version, snapshot.repository.id);
      this.updateJob(input.jobId, { status: "completed", phase: "分析完成", phaseDescriptor: { key: "diagnostics.index.store.m009" }, progress: 1, finishedAt: new Date().toISOString(), version: snapshot.version });
    })();
  }

  close(): void { this.database.close(); }
}
