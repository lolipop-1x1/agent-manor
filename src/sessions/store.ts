import type { MessageDescriptor } from "../i18n/types.js";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Gap, HistoryEvent } from "../contracts.js";
import { clientIds } from "../clients.js";
import type { Client } from "../clients.js";
import type { SourceLocation } from "../history/types.js";
import type { ResourceEventStream, ResourceHistoryIdentity, ResourceUsageIdentity, ResourceUsageEvent, ResourceUsageQuery, ResourceKind } from "../resource-contracts.js";
import type { UsageSource } from "../usage-contracts.js";
import type { OverviewEvent, OverviewSource, WeeklyReviewEvent } from "../overview-contracts.js";
import type { SessionGroupedSearchResult, SessionTurnDirectory, SessionIndexStatus, SessionJob, SessionListResult, SessionMessage, SessionMessageQuery, SessionMessageResult, SessionProfile, SessionProfileQuery, SessionQuery, SessionRefreshOptions, SessionSearchResult, SessionSink, SessionSourceMeta, SessionSummary, SessionTimelineEvent, SessionTimelineQuery, SessionTimelineResult, SessionUsage } from "../session-contracts.js";
import { StoreError } from "../index/store.js";
import { summarizeRequestSpeed } from "../session-speed.js";
import { INDEX_SCHEMA_VERSION, initializeIndexSchema } from "../index/schema.js";
import { resourceGapRelevant } from "../resources/coverage.js";
import { sessionTitle, userTitle } from "./title.js";
import { messageResources } from "./resources.js";
import { localDay } from "../overview/dates.js";
import { instant } from "../usage/analytics.js";
import { pairToolCalls } from "../overview/analytics.js";
import { promptCharacterCount, summarizeRoundMetrics, completeRoundSource, replyObservedAt, type RoundMessage } from "./round-metrics.js";
import { initializeSearchIndex, prepareSearchIndex, registerSearchFunctions, searchCandidateIndex, withCharacterTerms } from "./search-index.js";
import type { ImportItem } from "./import-pool.js";
import { initializeUsageFacts, prepareUsageFacts, readUsageFactMetadata, readUsageFacts, usageFactsReady, USAGE_FACT_FORMAT_VERSION } from "./usage-facts.js";
import type { UsageFactMetadata } from "./usage-facts.js";

interface JsonRow { json: string }
interface SearchMessageRow extends JsonRow {
  revision: string; message_id?: string; turn_id?: string; kind: SessionSearchResult["hits"][number]["kind"];
}
interface MessageMetadataRow extends JsonRow {
  id: string; ordinal: number; record_line: number; turn_id: string; kind: SessionMessage["kind"];
  final: SessionMessage["final"] | null; call_id: string | null; copied: number | null;
}
interface MessageRow extends MessageMetadataRow { text: string }
interface PreviewMessageRow extends MessageRow { text_length?: number; text_bytes?: number }
interface RevisionRow extends JsonRow { id: string; path: string; fingerprint: string }
type SqlValue = string | number;
/** path 沿用 SQL 列名但表示来源缓存键；真实文件路径保存在 SessionSourceMeta.path。 */
export interface SessionRevision {
  path: string;
  revision: string;
  fingerprint: string;
  client?: Client;
  location?: SourceLocation;
  quickFingerprint?: string;
  metadataFingerprint?: string;
}
const decode = <T>(row: JsonRow): T => JSON.parse(row.json) as T;
const MESSAGE_COLUMNS = "id,ordinal,record_line,turn_id,kind,final,call_id,copied,json";
const decodeMessageMetadata = (row: MessageMetadataRow): Omit<SessionMessage, "text"> => ({
  ...decode<Omit<SessionMessage, "text">>(row), id: row.id, ordinal: row.ordinal, recordLine: row.record_line,
  turnId: row.turn_id, kind: row.kind,
  ...(row.final !== null ? { final: row.final } : {}),
  ...(row.call_id !== null ? { callId: row.call_id } : {}),
  ...(row.copied !== null ? { copied: Boolean(row.copied) } : {}),
});
const decodeMessage = (row: MessageRow): SessionMessage => ({ ...decodeMessageMetadata(row), text: row.text });
const decodePreview = (row: PreviewMessageRow): SessionMessage => ({ ...decodeMessage(row), ...(row.text_length !== undefined
  ? { textLength: row.text_length, textTruncated: row.text_bytes! > Buffer.byteLength(row.text, "utf8") } : {}) });
const literal = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;
const paging = (query: SessionQuery) => ({ page: Math.max(1, Math.floor(query.page ?? 1)), pageSize: Math.min(200, Math.max(1, Math.floor(query.pageSize ?? 50))) });
const kindsOf = (query: SessionQuery) => (query.kinds?.length ? query.kinds : ["user", "assistant"])
  .filter(kind => ["user", "assistant", "tool_call", "tool_result", "thinking", "system", "context", "compression"].includes(kind));
const replyBodySql = `length(trim(text,${[9, 10, 11, 12, 13, 32, 160, 5760, ...Array.from({ length: 11 }, (_, i) => 8192 + i), 8232, 8233, 8239, 8287, 12288, 65279].map(code => `char(${code})`).join("||")}))>0`;
const replyWhere = `kind='assistant' AND copied IS NOT 1 AND json_extract(json,'$.contextSource') IS NULL AND ${replyBodySql}`;
const sessionQueryIndexes = `
      CREATE INDEX IF NOT EXISTS session_message_order ON session_messages(revision,ordinal,id);
      CREATE INDEX IF NOT EXISTS session_message_call ON session_messages(revision,call_id);
      CREATE INDEX IF NOT EXISTS session_message_turn ON session_messages(revision,turn_id,ordinal,id);
      CREATE INDEX IF NOT EXISTS session_message_round_boundary ON session_messages(revision,ordinal,id)
        WHERE copied IS NOT 1 AND (kind='user' OR kind='assistant' AND final IS NOT NULL);
      CREATE INDEX IF NOT EXISTS session_message_reply_boundary ON session_messages(revision,turn_id,ordinal DESC,id DESC)
        WHERE ${replyWhere};
      CREATE INDEX IF NOT EXISTS session_message_overview_projection_v2 ON session_messages(revision,ordinal,id,turn_id,record_line,kind,final,call_id,copied,
        json_extract(json,'$.occurredAt'),json_extract(json,'$.tool'),json_extract(json,'$.status'),json_extract(json,'$.contextSource'),
        json_extract(json,'$.resource'),json_extract(json,'$.resource.kind'),json_extract(json,'$.finalEvidence'),json_extract(json,'$.finalAt'),json_extract(json,'$.interrupted'));
      CREATE INDEX IF NOT EXISTS session_message_resource_event_v2
        ON session_messages(revision,json_extract(json,'$.resource.kind'),ordinal,id)
        WHERE kind IN ('tool_call','user') AND copied IS NOT 1 AND json_extract(json,'$.resource.kind') IN ('mcp','skill_call','skill_read');
      CREATE INDEX IF NOT EXISTS session_message_resource_call ON session_messages(revision,call_id,kind,copied)
        WHERE kind='tool_call' AND copied IS NOT 1;
      CREATE INDEX IF NOT EXISTS session_usage_order ON session_usage(revision);
`;

/** 全局正文按来源修订保存，读者只访问最后完整发布的版本。 */
export class SessionStore {
  readonly dbPath: string;
  private searchCancellation?: Int32Array;
  private readonly database: Database.Database;
  private readonly profileSummaries = new Map<string, SessionProfile>();
  private readonly revisionUsageCounts = new Map<string, number>();
  private readonly overviewStatements = new Map<string, Database.Statement>();
  private resourceGapSourceClients?: Map<string, Set<Client>>;
  private readonly overviewMessageTable: string;
  private readonly replyMessageTable: string;
  private statusMetadata?: Pick<SessionIndexStatus, "version" | "sessionCount" | "sourceCount" | "projects" | "clients">;
  private resourceClientMetadata?: { version: string; clients: Record<ResourceKind, Client[]> };

  constructor(dbPath: string, options: { readonly?: boolean } = {}) {
    this.dbPath = resolve(dbPath);
    if (!options.readonly) mkdirSync(dirname(this.dbPath), { recursive: true });
    this.database = new Database(this.dbPath, options.readonly ? { readonly: true, fileMustExist: true } : {});
    if (!options.readonly) this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    registerSearchFunctions(this.database);
    this.database.function("session_search_active", () => {
      if (this.searchCancellation && Atomics.load(this.searchCancellation, 0)) throw new Error("Search cancelled");
      return 1;
    });
    // SQLite 的文本 length 遇到 NUL 会提前结束，预览仍须明确保留完整正文的长度和截断状态。
    this.database.function("session_text_length", { deterministic: true }, value => {
      let count = 0;
      for (const _character of String(value)) count += 1;
      return count;
    });
    this.database.function("session_user_title", { deterministic: true }, value => userTitle(String(value)));
    this.database.function("session_local_day", { deterministic: true }, (value, timezone) =>
      typeof value === "string" && typeof timezone === "string" ? localDay(value, timezone) : null);
    this.database.function("session_prompt_characters", { deterministic: true }, value => promptCharacterCount(String(value)));
    this.database.function("session_time_ms", { deterministic: true }, value => {
      const time = typeof value === "string" ? Date.parse(value) : NaN;
      return Number.isFinite(time) ? time : null;
    });
    try {
      if (options.readonly) {
        if (this.database.pragma("user_version", { simple: true }) !== INDEX_SCHEMA_VERSION) {
          throw new StoreError("ANALYSIS_NOT_READY", "会话索引尚未完成", { key: "diagnostics.sessions.store.m009" });
        }
        this.database.function("usage_time_ms", { deterministic: true }, value => typeof value === "string" ? instant(value) ?? null : null);
      } else initializeIndexSchema(this.database, () => {
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS session_state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_jobs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_revisions (id TEXT PRIMARY KEY, path TEXT NOT NULL, fingerprint TEXT NOT NULL,
        session_id TEXT, client TEXT, project TEXT, title TEXT, started_at TEXT, updated_at TEXT,
        source_location TEXT, quick_fingerprint TEXT, metadata_fingerprint TEXT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_messages (message_key INTEGER PRIMARY KEY, revision TEXT NOT NULL REFERENCES session_revisions(id) ON DELETE CASCADE,
        id TEXT NOT NULL, ordinal INTEGER NOT NULL, record_line INTEGER NOT NULL, turn_id TEXT NOT NULL, kind TEXT NOT NULL,
        final TEXT, call_id TEXT, copied INTEGER, text TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(revision,id));
      CREATE TABLE IF NOT EXISTS session_usage (revision TEXT NOT NULL REFERENCES session_revisions(id) ON DELETE CASCADE,
        id TEXT NOT NULL, message_id TEXT, turn_id TEXT, json TEXT NOT NULL, PRIMARY KEY(revision,id));
      CREATE TABLE IF NOT EXISTS session_versions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, gaps TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_version_sources (version TEXT NOT NULL REFERENCES session_versions(id) ON DELETE CASCADE,
        path TEXT NOT NULL, revision TEXT NOT NULL REFERENCES session_revisions(id), PRIMARY KEY(version,path));
      CREATE TABLE IF NOT EXISTS session_version_sessions (version TEXT NOT NULL REFERENCES session_versions(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL, revision TEXT NOT NULL REFERENCES session_revisions(id), PRIMARY KEY(version,session_id));
      CREATE TABLE IF NOT EXISTS session_version_relations (version TEXT NOT NULL REFERENCES session_versions(id) ON DELETE CASCADE,
        child TEXT NOT NULL, parent TEXT NOT NULL, PRIMARY KEY(version,child));
      CREATE INDEX IF NOT EXISTS session_relation_parent ON session_version_relations(version,parent);
      CREATE TABLE IF NOT EXISTS session_source_auxiliary_checks (path TEXT PRIMARY KEY, stamp TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_import_checkpoints (path TEXT PRIMARY KEY,
        revision TEXT NOT NULL REFERENCES session_revisions(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS session_version_publication_inputs (version TEXT PRIMARY KEY REFERENCES session_versions(id) ON DELETE CASCADE, gaps TEXT NOT NULL);
    `);
        this.database.prepare("INSERT OR IGNORE INTO session_state(id,json) VALUES(1,?)").run(JSON.stringify({ stale: false }));
        initializeUsageFacts(this.database);
        initializeSearchIndex(this.database);
        // 首次导入的其他连接不抢先重建已暂缓的辅助索引；完整发布前统一恢复。
        if (this.currentVersion() || !this.database.prepare("SELECT 1 FROM session_jobs WHERE json_extract(json,'$.status')='running' LIMIT 1").get()) {
          this.database.exec(sessionQueryIndexes);
        }
      });
      this.overviewMessageTable = !this.currentVersion() || this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='session_message_overview_projection_v2'").get()
        ? "session_messages INDEXED BY session_message_overview_projection_v2" : "session_messages";
      this.replyMessageTable = !this.currentVersion() || this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='session_message_reply_boundary'").get()
        ? "session_messages INDEXED BY session_message_reply_boundary" : "session_messages";
    } catch (error) { this.database.close(); throw error; }
  }

  close(): void { this.overviewStatements.clear(); this.database.close(); }

  searchSnapshot<T>(read: () => T): T { return this.database.transaction(read).deferred(); }

  setSearchCancellation(signal?: Int32Array): void { this.searchCancellation = signal; }

  private get searchGuard(): string { return this.searchCancellation ? " AND session_search_active()=1" : ""; }

  /** 小型回复索引只选同轮末条正文，不读取全部 AI 正文；旧只读库可直接回退。 */
  private lastReplyIds(revision: string): Set<string> {
    const rows = this.overviewStatement(`SELECT id FROM (SELECT id,ROW_NUMBER() OVER (PARTITION BY turn_id ORDER BY ordinal DESC,id DESC) AS reply_rank
      FROM ${this.replyMessageTable} WHERE revision=? AND ${replyWhere}) WHERE reply_rank=1`).all(revision) as { id: string }[];
    return new Set(rows.map(row => row.id));
  }

  /** 总览逐修订复用固定 SQL，原生语句数量不随历史修订数增长。 */
  private overviewStatement(sql: string): Database.Statement {
    const cached = this.overviewStatements.get(sql);
    if (cached) return cached.busy ? this.database.prepare(sql) : cached;
    const statement = this.database.prepare(sql);
    if (this.overviewStatements.size === 32) this.overviewStatements.delete(this.overviewStatements.keys().next().value!);
    this.overviewStatements.set(sql, statement);
    return statement;
  }

  prepareSearchIndex(onProgress?: (progress: number) => void): Promise<void> { return prepareSearchIndex(this.database, onProgress); }

  /** 空库没有可查询版本，辅助索引统一后建；唯一约束、外键与全文索引始终保留。 */
  beginInitialImport(): void {
    if (this.currentVersion()) return;
    const names = [...sessionQueryIndexes.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)].map(match => match[1]!);
    this.database.transaction(() => {
      for (const name of names) this.database.exec(`DROP INDEX IF EXISTS ${name}`);
    })();
  }


  private state(): Partial<SessionIndexStatus> {
    return decode(this.database.prepare("SELECT json FROM session_state WHERE id=1").get() as JsonRow);
  }

  private saveState(state: Partial<SessionIndexStatus>): void {
    this.database.prepare("UPDATE session_state SET json=? WHERE id=1").run(JSON.stringify(state));
  }

  currentVersion(): string | undefined {
    return (this.database.prepare("SELECT json_extract(json,'$.version') AS version FROM session_state WHERE id=1").get() as { version: string | null }).version ?? undefined;
  }

  status(): SessionIndexStatus { return this.indexStatus(this.state()); }

  statusSummary() {
    const row = this.database.prepare("SELECT json_remove(json,'$.gaps') AS json, COALESCE(json_array_length(json,'$.gaps'),0) AS gapCount FROM session_state WHERE id=1").get() as JsonRow & { gapCount: number };
    const { gaps: _gaps, ...status } = this.indexStatus(decode(row));
    return { ...status, gapCount: row.gapCount };
  }

  indexGaps(requestedVersion?: string) {
    const version = this.version(requestedVersion);
    const row = this.database.prepare("SELECT gaps FROM session_versions WHERE id=?").get(version) as { gaps: string };
    return { version, gaps: JSON.parse(row.gaps) as SessionIndexStatus["gaps"] };
  }

  private indexStatus(state: Partial<SessionIndexStatus>): SessionIndexStatus {
    const latestJob = this.database.prepare("SELECT json FROM session_jobs ORDER BY created_at DESC,rowid DESC LIMIT 1").get() as JsonRow | undefined;
    const result: SessionIndexStatus = { ...state, stale: state.stale ?? false, sessionCount: 0, sourceCount: 0, gaps: state.gaps ?? [], projects: [], clients: [] };
    if (state.version && this.statusMetadata?.version === state.version) {
      result.sessionCount = this.statusMetadata.sessionCount;
      result.sourceCount = this.statusMetadata.sourceCount;
      result.projects = [...this.statusMetadata.projects];
      result.clients = [...this.statusMetadata.clients];
    } else if (state.version) {
      result.sessionCount = (this.database.prepare("SELECT COUNT(*) AS count FROM session_version_sessions WHERE version=?").get(state.version) as { count: number }).count;
      result.sourceCount = (this.database.prepare("SELECT COUNT(*) AS count FROM session_version_sources WHERE version=?").get(state.version) as { count: number }).count;
      result.projects = (this.database.prepare(`SELECT r.project FROM session_version_sessions v JOIN session_revisions r ON r.id=v.revision
        WHERE v.version=? AND r.project IS NOT NULL GROUP BY r.project
        ORDER BY MAX(COALESCE(session_time_ms(r.updated_at),session_time_ms(r.started_at))) DESC,r.project`).all(state.version) as { project: string }[]).map(row => row.project);
      result.clients = (this.database.prepare(`SELECT DISTINCT r.client FROM session_version_sessions v JOIN session_revisions r ON r.id=v.revision
        WHERE v.version=? ORDER BY r.client`).all(state.version) as { client: Client }[]).map(row => row.client);
      this.statusMetadata = { version: state.version, sessionCount: result.sessionCount, sourceCount: result.sourceCount, projects: [...result.projects], clients: [...result.clients] };
    }
    if (latestJob) result.job = decode(latestJob);
    return result;
  }

  createJob(options: SessionRefreshOptions = {}): SessionJob {
    const job: SessionJob = { id: randomUUID(), status: "queued", phase: "queued", phaseDescriptor: { key: "diagnostics.sessions.store.m001" }, progress: 0, createdAt: new Date().toISOString(),
      client: options.client, mode: options.mode ?? "quick" };
    this.database.prepare("INSERT INTO session_jobs(id,created_at,json) VALUES(?,?,?)").run(job.id, job.createdAt, JSON.stringify(job));
    return job;
  }

  getJob(id: string): SessionJob {
    const row = this.database.prepare("SELECT json FROM session_jobs WHERE id=?").get(id) as JsonRow | undefined;
    if (!row) throw new StoreError("JOB_NOT_FOUND", "会话索引任务不存在", { key: "diagnostics.sessions.store.m002" });
    return decode(row);
  }

  updateJob(id: string, patch: Partial<SessionJob>): SessionJob {
    const job = { ...this.getJob(id), ...patch };
    this.database.prepare("UPDATE session_jobs SET json=? WHERE id=?").run(JSON.stringify(job), id);
    return job;
  }

  failJob(id: string, error: string, errorDescriptor?: MessageDescriptor): void {
    if (this.getJob(id).status === "failed") { this.removeUnpublishedRevisions(); return; }
    this.database.transaction(() => {
      this.updateJob(id, { status: "failed", phase: "failed", phaseDescriptor: { key: "diagnostics.sessions.store.m003" }, error, errorDescriptor, finishedAt: new Date().toISOString() });
      this.saveState({ ...this.state(), stale: true });
    })();
    this.removeUnpublishedRevisions();
  }

  recoverJobs(): void {
    const jobs = this.database.prepare("SELECT json FROM session_jobs").iterate() as Iterable<JsonRow>;
    const unfinished: string[] = [];
    for (const row of jobs) { const job = decode<SessionJob>(row); if (["queued", "running"].includes(job.status)) unfinished.push(job.id); }
    for (const id of unfinished) this.failJob(id, "服务中断，未完成的会话索引保留上一版", { key: "diagnostics.sessions.store.interrupted" });
    this.removeUnpublishedRevisions();
  }

  cachedRevisions(): SessionRevision[] {
    const version = this.state().version;
    if (!version) return [];
    return this.readRevisions("session_version_sources", "v.version=?", [version]);
  }

  importCheckpoints(): SessionRevision[] {
    return this.readRevisions("session_import_checkpoints", "1=1", []);
  }

  private readRevisions(table: string, where: string, values: string[]): SessionRevision[] {
    const rows = this.database.prepare(`SELECT r.path,r.id AS revision,r.fingerprint,r.client,r.source_location,r.quick_fingerprint,r.metadata_fingerprint
      FROM ${table} v JOIN session_revisions r ON r.id=v.revision WHERE ${where}`).all(...values) as
      (SessionRevision & { source_location: string | null; quick_fingerprint: string | null; metadata_fingerprint: string | null })[];
    return rows.map(({ source_location, quick_fingerprint, metadata_fingerprint, ...revision }) => ({ ...revision,
      location: source_location ? JSON.parse(source_location) as SourceLocation : undefined,
      quickFingerprint: quick_fingerprint ?? undefined, metadataFingerprint: metadata_fingerprint ?? undefined }));
  }

  /** 仅完成校验的来源进入检查点；不进入当前可查询版本。 */
  saveImportCheckpoint(item: SessionRevision): void {
    this.database.transaction(() => {
      const previous = this.database.prepare("SELECT revision FROM session_import_checkpoints WHERE path=?").get(item.path) as { revision: string } | undefined;
      this.database.prepare("UPDATE session_revisions SET source_location=?,quick_fingerprint=?,metadata_fingerprint=? WHERE id=?")
        .run(item.location ? JSON.stringify(item.location) : null, item.quickFingerprint ?? null, item.metadataFingerprint ?? null, item.revision);
      this.database.prepare("INSERT INTO session_import_checkpoints(path,revision) VALUES(?,?) ON CONFLICT(path) DO UPDATE SET revision=excluded.revision")
        .run(item.path, item.revision);
      if (previous && previous.revision !== item.revision) this.database.prepare("DELETE FROM session_revisions WHERE id=? AND id NOT IN (SELECT revision FROM session_version_sources)").run(previous.revision);
    })();
  }

  pruneImportCheckpoints(paths: ReadonlySet<string>, client?: Client): void {
    const obsolete = this.importCheckpoints().filter(item => (!client || item.client === client) && !paths.has(item.path));
    if (!obsolete.length) return;
    this.database.transaction(() => {
      const remove = this.database.prepare("DELETE FROM session_import_checkpoints WHERE path=?");
      for (const item of obsolete) remove.run(item.path);
      this.removeUnpublishedRevisions();
    })();
  }

  auxiliaryCheck(path: string, stamp: string): { fingerprint: string; limited: boolean } | undefined {
    const row = this.database.prepare("SELECT json FROM session_source_auxiliary_checks WHERE path=? AND stamp=?").get(path, stamp) as JsonRow | undefined;
    return row ? decode(row) : undefined;
  }

  saveAuxiliaryCheck(path: string, stamp: string, value: { fingerprint: string; limited: boolean }): void {
    this.database.prepare(`INSERT INTO session_source_auxiliary_checks(path,stamp,json) VALUES(?,?,?)
      ON CONFLICT(path) DO UPDATE SET stamp=excluded.stamp,json=excluded.json WHERE stamp IS NOT excluded.stamp OR json IS NOT excluded.json`)
      .run(path, stamp, JSON.stringify(value));
  }

  createRevision(path: string, fingerprint: string, bulk = false): { revision: string; sink: SessionSink; flush: () => void } {
    const revision = randomUUID();
    this.database.prepare("INSERT INTO session_revisions(id,path,fingerprint,json) VALUES(?,?,?,?)").run(revision, path, fingerprint, "{}");
    const message = this.database.prepare(`INSERT INTO session_messages(revision,id,ordinal,record_line,turn_id,kind,final,call_id,copied,text,json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(revision,id) DO UPDATE SET ordinal=excluded.ordinal,record_line=excluded.record_line,
      turn_id=excluded.turn_id,kind=excluded.kind,final=excluded.final,call_id=excluded.call_id,copied=excluded.copied,text=excluded.text,json=excluded.json`);
    const usage = this.database.prepare(`INSERT INTO session_usage(revision,id,message_id,turn_id,json) VALUES(?,?,?,?,?)
      ON CONFLICT(revision,id) DO UPDATE SET message_id=excluded.message_id,turn_id=excluded.turn_id,json=excluded.json`);
    let pending: ({ type: "message"; value: SessionMessage } | { type: "usage"; value: SessionUsage })[] = [];
    let bytes = 0;
    const flush = this.database.transaction(() => {
      for (const item of pending) {
        if (item.type === "message") {
          const value = item.value;
          const { id: _id, ordinal: _ordinal, recordLine: _recordLine, turnId: _turnId, kind: _kind,
            final: _final, callId: _callId, copied: _copied, text: _text, ...metadata } = value;
          message.run(revision, value.id, value.ordinal, value.recordLine, value.turnId, value.kind, value.final ?? null,
            value.callId ?? null, value.copied === undefined ? null : value.copied ? 1 : 0, value.text, JSON.stringify(metadata));
        } else {
          const value = item.value;
          usage.run(revision, value.id, value.messageId ?? null, value.turnId ?? null, JSON.stringify(value));
        }
      }
      pending = [];
      bytes = 0;
    });
    const sink: SessionSink = {
      message: value => { pending.push({ type: "message", value }); bytes += value.text.length * 2; if (pending.length >= (bulk ? 1000 : 200) || bytes >= (bulk ? 8_000_000 : 2_000_000)) flush(); },
      usage: value => { pending.push({ type: "usage", value }); if (pending.length >= (bulk ? 1000 : 200)) flush(); },
    };
    return { revision, sink, flush };
  }

  /** 预计算词项仅覆盖本批提交，常规增删改仍由同一套触发器维护。 */
  applyImportBatch(pending: { sink: SessionSink; flush(): void }, items: ImportItem[]): void {
    const terms = new Map(items.filter(item => item.type === "message").map(item => [item.value.text, item.terms]));
    withCharacterTerms(this.database, terms, () => {
      for (const item of items) {
        if (item.type === "message") pending.sink.message(item.value);
        else pending.sink.usage(item.value);
      }
      pending.flush();
    });
  }

  finishRevision(id: string, meta: SessionSourceMeta, fingerprint?: string): void {
    this.resourceGapSourceClients = undefined;
    this.database.transaction(() => {
      const counts = this.database.prepare("SELECT COUNT(*) AS messages,COUNT(DISTINCT CASE WHEN kind='user' THEN turn_id END) AS turns FROM session_messages WHERE revision=?").get(id) as { messages: number; turns: number };
      const summary = sessionTitle({ ...meta, messageCount: counts.messages, turnCount: counts.turns });
      this.database.prepare("UPDATE session_revisions SET session_id=?,client=?,project=?,title=?,started_at=?,updated_at=?,json=?,fingerprint=COALESCE(?,fingerprint) WHERE id=?")
        .run(meta.id, meta.client, meta.project ?? null, summary.title, meta.startedAt ?? null, meta.updatedAt ?? null, JSON.stringify(summary), fingerprint ?? null, id);
      this.ensureUsageFacts(id);
    }).immediate();
  }

  removeRevision(id: string): void { this.resourceGapSourceClients = undefined; this.database.prepare("DELETE FROM session_revisions WHERE id=?").run(id); }

  private removeUnpublishedRevisions(): void {
    this.resourceGapSourceClients = undefined;
    this.database.prepare(`DELETE FROM session_revisions WHERE id NOT IN (SELECT revision FROM session_version_sources)
      AND id NOT IN (SELECT revision FROM session_import_checkpoints)`).run();
  }

  private completeImport(jobId: string): void {
    const client = this.getJob(jobId).client;
    if (client) this.database.prepare("DELETE FROM session_import_checkpoints WHERE revision IN (SELECT id FROM session_revisions WHERE client=?)").run(client);
    else this.database.prepare("DELETE FROM session_import_checkpoints").run();
    this.removeUnpublishedRevisions();
  }

  publish(jobId: string, revisions: SessionRevision[], gaps: Gap[]): string {
    if (!this.currentVersion()) this.database.exec(sessionQueryIndexes);
    const version = randomUUID();
    const createdAt = new Date().toISOString();
    const saveCheck = this.database.prepare(`UPDATE session_revisions SET source_location=?,quick_fingerprint=?,metadata_fingerprint=?
      WHERE id=? AND (source_location IS NOT ? OR quick_fingerprint IS NOT ? OR metadata_fingerprint IS NOT ?)`);
    const writeCheck = (item: SessionRevision) => {
      const location = item.location ? JSON.stringify(item.location) : null;
      const quick = item.quickFingerprint ?? null;
      const metadata = item.metadataFingerprint ?? null;
      saveCheck.run(location, quick, metadata, item.revision, location, quick, metadata);
    };
    const stateBefore = this.state();
    const previousSources = new Map(this.cachedRevisions().map(item => [item.path, item.revision]));
    const sameSources = stateBefore.version && previousSources.size === revisions.length
      && revisions.every(item => previousSources.get(item.path) === item.revision);
    // 单独保留外部缺口输入，区别来源固有缺口和本轮缺失说明；旧版本缺少记录时保守发布一次。
    const previousInputs = stateBefore.version ? this.database.prepare("SELECT gaps FROM session_version_publication_inputs WHERE version=?")
      .get(stateBefore.version) as { gaps: string } | undefined : undefined;
    const sameExternalGaps = previousInputs?.gaps === JSON.stringify(gaps);
    if (sameSources && sameExternalGaps) {
      this.database.transaction(() => {
        for (const item of revisions) writeCheck(item);
        this.completeCheck(jobId, stateBefore.version!, createdAt, { ...stateBefore, stale: false });
        this.completeImport(jobId);
      })();
      return stateBefore.version!;
    }
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO session_versions(id,created_at,gaps) VALUES(?,?,?)").run(version, createdAt, "[]");
      this.database.prepare("INSERT INTO session_version_publication_inputs(version,gaps) VALUES(?,?)").run(version, JSON.stringify(gaps));
      const addSource = this.database.prepare("INSERT INTO session_version_sources(version,path,revision) VALUES(?,?,?)");
      for (const item of revisions) {
        addSource.run(version, item.path, item.revision);
        writeCheck(item);
      }
      // 同一会话存在活动／归档副本时择完整且较新的副本，不重复统计。
      this.database.prepare(`INSERT INTO session_version_sessions(version,session_id,revision)
        SELECT ?,session_id,id FROM (SELECT r.*,ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY CAST(json_extract(r.json,'$.messageCount') AS INTEGER) DESC,
          COALESCE(updated_at,started_at,'') DESC,r.path ASC) AS rank
          FROM session_revisions r JOIN session_version_sources s ON s.revision=r.id WHERE s.version=?) WHERE rank=1`).run(version, version);
      // 缺口按原因与来源聚合，保留按客户端判断观测完整性所需的归属。
      const aggregated = new Map<string, Gap>();
      const addGap = (gap: Gap) => {
        const key = JSON.stringify([gap.kind, gap.message, gap.sourceId ?? null]);
        const previous = aggregated.get(key);
        if (previous) previous.count = (previous.count ?? 1) + (gap.count ?? 1);
        else aggregated.set(key, { ...gap, count: gap.count ?? 1 });
      };
      for (const gap of gaps) addGap(gap);
      // 精确会话身份和原生声明建立关系，关系随版本发布，不回写可共享修订。
      this.database.prepare(`INSERT INTO session_version_relations(version,child,parent)
        SELECT ?,c.session_id,p.session_id FROM session_version_sessions c JOIN session_revisions r ON r.id=c.revision
          JOIN session_version_sessions p ON p.version=c.version AND p.session_id=json_extract(r.json,'$.parentSessionId')
        WHERE c.version=? AND json_extract(r.json,'$.relationship')='child' AND c.session_id<>p.session_id`).run(version, version);
      // 固定先展开实际子目标，再按完整身份查找，避免父子会话的无关两两扫描。
      const targets = this.database.prepare(`SELECT c.session_id AS child,MIN(p.session_id) AS parent,COUNT(DISTINCT p.session_id) AS parents
        FROM session_version_sessions p JOIN session_revisions pr ON pr.id=p.revision CROSS JOIN json_each(pr.json,'$.childSessionIds') target
        CROSS JOIN session_version_sessions c ON c.version=p.version AND c.session_id=target.value JOIN session_revisions cr ON cr.id=c.revision
        WHERE p.version=? AND pr.client=cr.client AND p.session_id<>c.session_id AND json_extract(cr.json,'$.parentSessionId') IS NULL
          AND COALESCE(json_extract(cr.json,'$.relationship'),'')<>'fork' GROUP BY c.session_id`).all(version) as { child: string; parent: string; parents: number }[];
      const addRelation = this.database.prepare("INSERT OR IGNORE INTO session_version_relations(version,child,parent) VALUES(?,?,?)");
      for (const target of targets) {
        if (target.parents === 1) addRelation.run(version, target.child, target.parent);
        else addGap({ kind: "ambiguous", message: "多个父会话声明同一子目标，未任意建立父子关联", messageDescriptor: { key: "diagnostics.sessions.store.m004" }, count: 1 });
      }
      const conflicts = (this.database.prepare(`SELECT COUNT(DISTINCT c.session_id) AS count FROM session_version_sessions p
        JOIN session_revisions pr ON pr.id=p.revision CROSS JOIN json_each(pr.json,'$.childSessionIds') target
        CROSS JOIN session_version_sessions c ON c.version=p.version AND c.session_id=target.value JOIN session_revisions cr ON cr.id=c.revision
        WHERE p.version=? AND json_extract(cr.json,'$.parentSessionId') IS NOT NULL
          AND json_extract(cr.json,'$.parentSessionId')<>p.session_id`).get(version) as { count: number }).count;
      if (conflicts) addGap({ kind: "ambiguous", message: "父工具目标与子会话显式父声明冲突，保留显式声明，不扩大汇总", messageDescriptor: { key: "diagnostics.sessions.store.m005" }, count: conflicts });
      const relationRows = this.database.prepare("SELECT child,parent FROM session_version_relations WHERE version=?").all(version) as { child: string; parent: string }[];
      const relationships = new Map(relationRows.map(item => [item.child, item.parent]));
      const checked = new Set<string>();
      const cycles = new Set<string>();
      for (const start of relationships.keys()) {
        if (checked.has(start)) continue;
        const path: string[] = [];
        const positions = new Map<string, number>();
        let next: string | undefined = start;
        while (next && !checked.has(next)) {
          const position = positions.get(next);
          if (position !== undefined) { for (const node of path.slice(position)) cycles.add(node); break; }
          positions.set(next, path.length); path.push(next); next = relationships.get(next);
        }
        for (const node of path) checked.add(node);
      }
      if (cycles.size) {
        const remove = this.database.prepare("DELETE FROM session_version_relations WHERE version=? AND child=?");
        for (const node of cycles) remove.run(version, node);
        addGap({ kind: "ambiguous", message: "父子声明形成循环，循环中的关系未纳入汇总", messageDescriptor: { key: "diagnostics.sessions.store.m006" }, count: cycles.size });
      }
      const duplicate = (this.database.prepare(`SELECT COALESCE(SUM(count-1),0) AS count FROM
        (SELECT COUNT(*) AS count FROM session_version_sources v JOIN session_revisions r ON r.id=v.revision WHERE v.version=? GROUP BY r.session_id HAVING COUNT(*)>1)`)
        .get(version) as { count: number }).count;
      if (duplicate) addGap({ kind: "ambiguous", message: "同一会话存在多个来源副本，采用消息较完整、时间较新的副本；不重复累计", messageDescriptor: { key: "diagnostics.sessions.store.m007" }, count: duplicate });
      for (const row of this.database.prepare(`SELECT r.json FROM session_version_sessions v JOIN session_revisions r ON r.id=v.revision
        WHERE v.version=?`).iterate(version) as Iterable<JsonRow>) {
        const summary = decode<SessionSourceMeta>(row);
        for (const gap of summary.gaps) addGap({ ...gap, sourceId: gap.sourceId ?? summary.sourceId });
      }
      const publishedGaps = [...aggregated.values()];
      this.database.prepare("UPDATE session_versions SET gaps=? WHERE id=?").run(JSON.stringify(publishedGaps), version);
      const state = this.state();
      const previousVersion = state.version;
      this.completeCheck(jobId, version, createdAt, { version, previousVersion, createdAt, stale: false, gaps: publishedGaps, clientChecks: state.clientChecks });
      this.database.prepare("DELETE FROM session_versions WHERE id<>? AND id<>?").run(version, previousVersion ?? version);
      this.completeImport(jobId);
      this.database.prepare("DELETE FROM session_source_auxiliary_checks WHERE path NOT IN (SELECT path FROM session_version_sources)").run();
    })();
    return version;
  }

  private completeCheck(jobId: string, version: string, checkedAt: string, state: Partial<SessionIndexStatus>): void {
    const job = this.getJob(jobId);
    const checkedClients = job.client ? [job.client] : clientIds;
    const clientChecks = new Map((state.clientChecks ?? []).map(check => [check.client, check]));
    for (const client of checkedClients) clientChecks.set(client, { client, checkedAt, mode: job.mode ?? "quick" });
    this.saveState({ ...state, clientChecks: [...clientChecks.values()] });
    this.updateJob(jobId, { status: "complete", phase: "complete", phaseDescriptor: { key: "diagnostics.sessions.store.m008" }, progress: 1, version, finishedAt: checkedAt });
  }

  private version(requested?: string): string {
    const version = requested ?? this.currentVersion();
    if (!version) throw new StoreError("ANALYSIS_NOT_READY", "会话索引尚未完成", { key: "diagnostics.sessions.store.m009" });
    if (!this.overviewStatement("SELECT 1 FROM session_versions WHERE id=?").get(version)) throw new StoreError("VERSION_NOT_FOUND", "会话索引版本不存在", { key: "diagnostics.sessions.store.m010" });
    return version;
  }

  private session(id: string, version: string): { revision: string; summary: SessionSummary } {
    const row = this.database.prepare(`SELECT r.id,r.json FROM session_version_sessions v JOIN session_revisions r ON r.id=v.revision
      WHERE v.version=? AND v.session_id=?`).get(version, id) as RevisionRow | undefined;
    if (!row) throw new StoreError("SOURCE_NOT_FOUND", "会话不存在于当前索引版本", { key: "diagnostics.sessions.store.m011" });
    return { revision: row.id, summary: this.summary(row, version) };
  }

  private summary(row: JsonRow, version: string): SessionSummary {
    const { path: _path, sourceId: _sourceId, ...summary } = decode<SessionSourceMeta>(row);
    const relation = this.database.prepare(`SELECT relation.parent,r.json FROM session_version_relations relation
      JOIN session_version_sessions v ON v.version=relation.version AND v.session_id=relation.parent
      JOIN session_revisions r ON r.id=v.revision WHERE relation.version=? AND relation.child=?`)
      .get(version, summary.id) as (JsonRow & { parent: string }) | undefined;
    const setParentTitle = (parentRow: JsonRow) => {
      const parent = sessionTitle(decode<SessionSummary>(parentRow));
      summary.parentTitle = parent.title;
      summary.parentTitleDescriptor = parent.titleOrigin === "fallback" ? {
        key: parent.relationship === "child" ? "sessions.title.childFallback" : "sessions.title.unnamed",
        ...(parent.relationship === "child" ? { params: { id: parent.clientSessionId.slice(-8) } } : {}),
      } : undefined;
    };
    if (relation) {
      summary.parentSessionId = relation.parent; summary.relationship = "child";
      setParentTitle(relation);
    } else if (summary.relationship === "fork" && summary.parentSessionId) {
      const parent = this.database.prepare(`SELECT r.json FROM session_version_sessions v JOIN session_revisions r ON r.id=v.revision
        WHERE v.version=? AND v.session_id=?`).get(version, summary.parentSessionId) as JsonRow | undefined;
      if (parent) setParentTitle(parent);
    }
    return sessionTitle(summary);
  }

  private filters(query: SessionQuery): { sql: string; values: SqlValue[] } {
    const parts: string[] = [];
    const values: SqlValue[] = [];
    for (const [column, value] of [["r.client", query.client], ["r.project", query.project]] as const) {
      if (column === "r.project" && value === "none") parts.push("r.project IS NULL");
      else if (value !== undefined) { parts.push(`${column}=?`); values.push(value); }
    }
    if (query.from) { parts.push("COALESCE(r.updated_at,r.started_at,'')>=?"); values.push(query.from); }
    if (query.to) { parts.push("COALESCE(r.started_at,r.updated_at,'')<=?"); values.push(query.to); }
    if (query.executionMode === "quiet") parts.push("json_extract(r.json,'$.executionMode')='quiet'");
    if (query.executionMode === "regular") parts.push("COALESCE(json_extract(r.json,'$.executionMode'),'')<>'quiet'");
    return { sql: parts.length ? " AND " + parts.join(" AND ") : "", values };
  }

  /** 客户端候选读取资源事件及状态索引，不解码正文或重新解析历史。 */
  resourceClients(): Record<ResourceKind, Client[]> {
    const version = this.currentVersion();
    if (!version) return { skill: [], mcp: [] };
    if (this.resourceClientMetadata?.version !== version) {
      const scope = `FROM session_version_sessions v JOIN session_revisions r ON r.id=v.revision
        JOIN session_messages m INDEXED BY session_message_resource_event_v2 ON m.revision=v.revision
        WHERE v.version=? AND m.kind IN ('tool_call','user') AND m.copied IS NOT 1
        AND json_extract(m.json,'$.resource.kind') IN ('mcp','skill_call','skill_read')`;
      const rows = this.overviewStatement(`SELECT DISTINCT r.client,json_extract(m.json,'$.resource.kind') AS kind ${scope}
        AND json_extract(m.json,'$.resource.kind')<>'skill_read' ORDER BY r.client`)
        .all(version) as { client: Client; kind: string }[];
      const skill = rows.filter(row => row.kind === "skill_call").map(row => row.client);
      // Skill 读取仅成功时生成资源记录；尚无显式调用的客户端再检查唯一结果配对。
      const reads = this.overviewStatement(`SELECT DISTINCT r.client ${scope} AND json_extract(m.json,'$.resource.kind')='skill_read'
        AND r.client NOT IN (SELECT value FROM json_each(?))
        AND COALESCE(CASE WHEN json_extract(m.json,'$.status') IN ('success','failure') THEN json_extract(m.json,'$.status') END,
          CASE WHEN (SELECT COUNT(*) FROM session_messages c WHERE c.revision=m.revision AND c.call_id=m.call_id
            AND c.kind='tool_call' AND c.copied IS NOT 1)=1 THEN
            (SELECT MAX(json_extract(z.json,'$.status')) FROM session_messages z WHERE z.revision=m.revision AND z.call_id=m.call_id
              AND z.kind='tool_result' AND z.copied IS NOT 1 HAVING COUNT(*)=1) END,'unknown')='success' ORDER BY r.client`)
        .all(version, JSON.stringify(skill)) as { client: Client }[];
      this.resourceClientMetadata = { version, clients: {
        skill: [...new Set([...skill, ...reads.map(row => row.client)])].sort(),
        mcp: rows.filter(row => row.kind === "mcp").map(row => row.client),
      } };
    }
    return { skill: [...this.resourceClientMetadata.clients.skill], mcp: [...this.resourceClientMetadata.clients.mcp] };
  }

  /** 资源查询只读取已发布调用的元信息；配对命中调用索引，不读取消息正文。 */
  resourceEvents(query: ResourceUsageQuery = {}, identity?: ResourceHistoryIdentity | ResourceUsageIdentity, revision?: string): ResourceEventStream {
    const version = this.version(query.version);
    const parts = ["v.version=?"];
    const values: SqlValue[] = [version];
    if (revision !== undefined) { parts.push("v.revision=?"); values.push(revision); }
    for (const [column, value] of [["r.client", query.client ?? identity?.client], ["r.project", query.project ?? identity?.project]] as const) {
      if (column === "r.project" && value === "none") parts.push("r.project IS NULL");
      else if (value !== undefined) { parts.push(`${column}=?`); values.push(value); }
    }
    if (identity?.client !== undefined && identity.project === undefined) parts.push("r.project IS NULL");
    const sessionFilter = parts.join(" AND ");
    const sessionCount = (this.overviewStatement(`SELECT COUNT(*) AS count FROM session_version_sessions v
      JOIN session_revisions r ON r.id=v.revision WHERE ${sessionFilter}`).get(...values) as { count: number }).count;
    const clients = (this.overviewStatement(`SELECT DISTINCT r.client FROM session_version_sessions v
      JOIN session_revisions r ON r.id=v.revision WHERE ${sessionFilter} ORDER BY r.client`).all(...values) as { client: Client }[]).map(row => row.client);
    const kind = query.kind ?? identity?.kind;
    if (kind) parts.push(kind === "mcp" ? "json_extract(m.json,'$.resource.kind')='mcp'" : "json_extract(m.json,'$.resource.kind') IN ('skill_call','skill_read')");
    if (identity) {
      parts.push(identity.kind === "mcp" ? "json_extract(m.json,'$.resource.server') IS ?"
        : "(json_extract(m.json,'$.resource.name')=? OR EXISTS (SELECT 1 FROM json_each(m.json,'$.resources') use WHERE json_extract(use.value,'$.name')=?))");
      if (identity.kind === "mcp" && identity.server === undefined) {
        parts[parts.length - 1] = "json_extract(m.json,'$.resource.server') IS NULL";
      } else {
        values.push(identity.kind === "mcp" ? identity.server! : identity.name);
        if (identity.kind !== "mcp") values.push(identity.name);
      }
    }
    const rows = this.overviewStatement(`SELECT m.id AS message_id,m.ordinal,m.turn_id,m.record_line,r.session_id,r.client,r.project,
      r.id AS revision,r.fingerprint,json_extract(r.json,'$.path') AS source_path,json_extract(r.json,'$.sourceId') AS source_id,
      json_extract(m.json,'$.resource.kind') AS resource_kind,json_extract(m.json,'$.resource.name') AS resource_name,
      json_extract(m.json,'$.resource.nameDescriptor') AS resource_name_descriptor,
      json_extract(m.json,'$.resources') AS resources,
      json_extract(m.json,'$.resource.server') AS resource_server,json_extract(m.json,'$.resource.path') AS resource_path,
      json_extract(m.json,'$.filePaths') AS file_paths,json_extract(m.json,'$.tool') AS tool,
      json_extract(m.json,'$.occurredAt') AS occurred_at,
      COALESCE(CASE WHEN json_extract(m.json,'$.status') IN ('success','failure') THEN json_extract(m.json,'$.status') END,
        CASE WHEN (SELECT COUNT(*) FROM session_messages c WHERE c.revision=m.revision AND c.call_id=m.call_id
          AND c.kind='tool_call' AND c.copied IS NOT 1)=1 THEN json_extract(result.json,'$.status') END,'unknown') AS status,
      COALESCE(json_extract(m.json,'$.durationMs'),json_extract(result.json,'$.durationMs')) AS duration_ms,
      result.id AS result_id,
      (SELECT COUNT(*) FROM session_messages z WHERE z.revision=m.revision AND z.call_id=m.call_id
        AND z.kind='tool_result' AND z.copied IS NOT 1) AS result_count,
      (SELECT COUNT(*) FROM session_messages c WHERE c.revision=m.revision AND c.call_id=m.call_id
        AND c.kind='tool_call' AND c.copied IS NOT 1) AS call_count
      FROM session_version_sessions v JOIN session_revisions r ON r.id=v.revision
      JOIN session_messages m INDEXED BY session_message_resource_event_v2 ON m.revision=r.id AND m.kind IN ('tool_call','user') AND m.copied IS NOT 1
      LEFT JOIN session_messages result ON result.revision=m.revision AND result.id=(SELECT MIN(z.id) FROM session_messages z
        WHERE z.revision=m.revision AND z.call_id=m.call_id AND z.kind='tool_result' AND z.copied IS NOT 1 HAVING COUNT(*)=1)
      AND (SELECT COUNT(*) FROM session_messages c WHERE c.revision=m.revision AND c.call_id=m.call_id
        AND c.kind='tool_call' AND c.copied IS NOT 1)=1
      WHERE ${parts.join(" AND ")} AND json_extract(m.json,'$.resource.kind') IN ('mcp','skill_call','skill_read')
      ORDER BY r.session_id,m.ordinal,m.id`).iterate(...values) as Iterable<{
        message_id: string; ordinal: number; turn_id: string; record_line: number; session_id: string; client: Client; project: string | null;
        revision: string; fingerprint: string; source_path: string; source_id: string; resource_kind: ResourceUsageEvent["kind"];
        resource_name: string | null; resource_name_descriptor: string | null; resource_server: string | null; resource_path: string | null; file_paths: string | null; resources: string | null;
        tool: string | null; occurred_at: string | null; status: ResourceUsageEvent["status"]; duration_ms: number | null;
        result_id: string | null; result_count: number; call_count: number;
      }>;
    const events = (function* (): Iterable<ResourceUsageEvent> {
      for (const row of rows) {
        const paths = row.file_paths ? JSON.parse(row.file_paths) as string[] : [];
        const skillPath = paths.find(path => /(?:^|[/\\])SKILL\.md$/.test(path));
        const resources = messageResources({ resource: { kind: row.resource_kind, name: row.resource_name ?? "未记录名称",
          ...(row.resource_name_descriptor ? { nameDescriptor: JSON.parse(row.resource_name_descriptor) } : {}), server: row.resource_server ?? undefined,
          path: row.resource_path ?? undefined }, resources: row.resources ? JSON.parse(row.resources) : undefined });
        for (const [index, resource] of resources.entries()) {
          if (kind === "mcp" && resource.kind !== "mcp" || kind === "skill" && resource.kind === "mcp") continue;
          if (identity && (identity.kind === "mcp" ? resource.server !== identity.server : resource.name !== identity.name)) continue;
          const path = resource.path ?? (resource.kind === "mcp" || index > 0 ? undefined : skillPath
            ?? (resource.kind === "skill_call" ? paths[0] : undefined));
          yield { id: `${row.session_id}:${row.message_id}${index ? `:resource:${index}` : ""}`, sessionId: row.session_id, messageId: row.message_id,
          turnId: row.turn_id, ordinal: row.ordinal, client: row.client, project: row.project ?? undefined,
          kind: resource.kind, name: resource.name, ...(resource.nameDescriptor ? { nameDescriptor: resource.nameDescriptor } : {}), server: resource.server,
          path, tool: row.tool ?? undefined, occurredAt: row.occurred_at ?? undefined,
          status: row.status === "success" || row.status === "failure" ? row.status : "unknown",
          durationMs: typeof row.duration_ms === "number" && Number.isFinite(row.duration_ms) && row.duration_ms >= 0 ? row.duration_ms : undefined,
          resultMessageId: row.result_id ?? undefined,
          pairing: row.call_count > 1 || row.result_count > 1 ? "ambiguous" : row.result_id ? "unique" : "missing",
          source: { path: row.source_path, sourceId: row.source_id, revision: row.revision, fingerprint: row.fingerprint, recordLine: row.record_line } };
        }
      }
    })();
    const allGaps = revision === undefined ? JSON.parse((this.overviewStatement("SELECT gaps FROM session_versions WHERE id=?").get(version) as { gaps: string }).gaps) as Gap[] : [];
    const sourceIds = [...new Set(allGaps.flatMap(gap => gap.sourceId ?? []))];
    const sourceClients = this.resourceGapSourceClients ?? new Map<string, Set<Client>>();
    if (sourceIds.length) {
      // 来源归属只随修订元数据变化，不在每个详情请求中重复解析全部修订 JSON。
      if (!this.resourceGapSourceClients) {
        const records = this.overviewStatement("SELECT DISTINCT json_extract(json,'$.sourceId') AS source_id,client FROM session_revisions").all() as { source_id: string; client: Client }[];
        for (const record of records) if (record.source_id) {
          let related = sourceClients.get(record.source_id);
          if (!related) { related = new Set(); sourceClients.set(record.source_id, related); }
          related.add(record.client);
        }
        this.resourceGapSourceClients = sourceClients;
      }
      // 首次发现即失败的来源没有修订；公开原生身份的客户端前缀仍可确认归属。
      for (const sourceId of sourceIds) if (!sourceClients.has(sourceId)) {
        const client = clientIds.find(client => sourceId.startsWith(`${client}:`));
        if (client) sourceClients.set(sourceId, new Set([client]));
      }
    }
    const selectedClient = query.client ?? identity?.client;
    const gaps = allGaps.filter(gap => !selectedClient || !gap.sourceId || !sourceClients.get(gap.sourceId)?.size || sourceClients.get(gap.sourceId)!.has(selectedClient));
    const related = gaps.filter(resourceGapRelevant);
    const affectedClients = (values: Gap[]) => [...new Set(values.flatMap(gap => gap.sourceId ? [...(sourceClients.get(gap.sourceId) ?? [])] : []))];
    const unscoped = (values: Gap[]) => values.some(gap => !gap.sourceId || !sourceClients.get(gap.sourceId)?.size);
    const unavailable = related.filter(gap => gap.kind === "source_unavailable");
    return { version, events, sessionCount, clients, gaps, uncertainClients: affectedClients(related), unscopedGaps: unscoped(related),
      unavailableClients: affectedClients(unavailable), unscopedUnavailableGaps: unscoped(unavailable) };
  }

  private listCandidates(query: SessionQuery, version: string, sessionId?: string) {
    const filter = this.filters({ ...query, executionMode: query.executionMode ?? "regular" });
    if (sessionId) { filter.sql += " AND v.session_id=?"; filter.values.push(sessionId); }
    // 仅有本地 Hook 的来源保留回查，但默认列表不当作对话展示。
    if (query.executionMode !== "all") filter.sql += ` AND (r.client<>'codeflicker'
      OR COALESCE(json_extract(r.json,'$.messageCount'),0)=0 OR COALESCE(json_extract(r.json,'$.turnCount'),0)>0
      OR EXISTS (SELECT 1 FROM session_messages m WHERE m.revision=r.id
        AND (m.kind<>'context' OR COALESCE(json_extract(m.json,'$.contextSource'),'')<>'hook')))`;
    if (!query.includeSubagents) filter.sql += ` AND COALESCE(json_extract(r.json,'$.relationship'),'')<>'child'
      AND NOT EXISTS (SELECT 1 FROM session_version_relations relation WHERE relation.version=v.version AND relation.child=v.session_id)`;
    if (query.q?.trim()) {
      const kinds = kindsOf(query);
      const candidate = searchCandidateIndex(this.database, (query.q ?? "").trim());
      const match = candidate?.match;
      const filterKinds = candidate?.table === "session_character_search";
      const candidates = match ? `m.rowid IN (SELECT rowid FROM ${candidate!.table} WHERE ${candidate!.table} MATCH ?${this.searchGuard}${filterKinds ? `
        INTERSECT SELECT message_key FROM session_messages WHERE kind IN (${kinds.map(() => "?").join(",") || "NULL"})${this.searchGuard}` : ""}) AND ` : "";
      const body = `m.kind IN (${kinds.map(() => "?").join(",") || "NULL"})${candidate?.exact ? "" : " AND m.text LIKE ? ESCAPE '\\'"}`;
      const matched = match ? `r.id IN (SELECT m.revision FROM session_messages m WHERE ${candidates}${body})`
        : `EXISTS(SELECT 1 FROM session_messages m WHERE m.revision=r.id AND ${body})`;
      filter.sql += ` AND (r.title LIKE ? ESCAPE '\\' OR ${matched})`;
      filter.values.push(literal((query.q ?? "").trim()), ...(match ? [match, ...(filterKinds ? kinds : [])] : []), ...kinds, ...(candidate?.exact ? [] : [literal((query.q ?? "").trim())]));
    }
    const from = `FROM session_version_sessions v JOIN session_revisions r ON r.id=v.revision WHERE v.version=?${filter.sql}`;
    return { from: from + this.searchGuard, values: [version, ...filter.values] };
  }

  list(query: SessionQuery = {}, sessionId?: string): SessionListResult {
    const version = this.version(query.version);
    const { page, pageSize } = paging(query);
    const { from, values } = this.listCandidates(query, version, sessionId);
    const rows = this.database.prepare(`WITH matches AS MATERIALIZED (SELECT v.session_id,r.id,COALESCE(r.updated_at,r.started_at,'') AS updated_at ${from}),
      totals AS (SELECT COUNT(*) AS total FROM matches), page AS (
        SELECT * FROM matches ORDER BY updated_at DESC,session_id LIMIT ? OFFSET ?
      ) SELECT totals.total,r.json FROM totals LEFT JOIN page ON 1 LEFT JOIN session_revisions r ON r.id=page.id
        ORDER BY page.updated_at DESC,page.session_id`).all(...values, pageSize, (page - 1) * pageSize) as { total: number; json: string | null }[];
    const sessions = rows.flatMap(row => row.json === null ? [] : [this.summary({ json: row.json }, version)]);
    return { version, sessions, total: rows[0]!.total, page, pageSize };
  }

  /** 地图只取已发布会话的标题元信息，不读取正文，也不依赖项目路径推断身份。 */
  summariesByIdentity(identities: Pick<HistoryEvent, "client" | "sessionId">[]): SessionSummary[] {
    const version = this.currentVersion();
    if (!version || !identities.length) return [];
    const keys = [...new Set(identities.map(item => `${item.client}:${item.sessionId}`))];
    const rows = this.database.prepare(`SELECT r.json FROM session_version_sessions v JOIN session_revisions r ON r.id=v.revision
      WHERE v.version=? AND r.client||':'||json_extract(r.json,'$.clientSessionId') IN (SELECT value FROM json_each(?))`)
      .all(version, JSON.stringify(keys)) as JsonRow[];
    return rows.map(row => this.summary(row, version));
  }

  private readingBranch(session: SessionSummary, query: SessionMessageQuery) {
    let branch = "";
    const values: SqlValue[] = [];
    if (query.branch && query.branch !== "all" && query.branch !== "current") {
      if (!session.branches?.some(item => item.id === query.branch)) throw new StoreError("INVALID_INPUT", "会话分支不存在", { key: "diagnostics.sessions.store.m012" });
      branch = " AND (json_extract(json,'$.branchIds') IS NULL OR EXISTS (SELECT 1 FROM json_each(session_messages.json,'$.branchIds') WHERE value=?))";
      values.push(query.branch);
    } else if (query.branch === "current" || !query.branch && query.mode === "brief") {
      branch = " AND COALESCE(json_extract(json,'$.currentBranch'),1)=1";
    }
    return { branch, values };
  }

  private readingScope(revision: string, session: SessionSummary, query: SessionMessageQuery, turnIds?: string[]) {
    const scope = this.readingBranch(session, query);
    let branch = scope.branch + this.searchGuard;
    const values: SqlValue[] = [revision, ...scope.values];
    if (turnIds) {
      branch += " AND turn_id IN (SELECT value FROM json_each(?))";
      values.push(JSON.stringify(turnIds));
    }
    if (query.mode !== "brief") return { values, cte: `WITH scoped AS MATERIALIZED (
      SELECT id,ordinal,CASE WHEN turn_id='' THEN 'unknown' ELSE turn_id END AS turn_id,kind,final FROM session_messages WHERE revision=?${branch}
    ), visible AS (SELECT * FROM scoped)` };
    // 阅读和投入统计都取末条非空回复；选择结果不改写来源 final。
    const cte = `WITH scoped AS MATERIALIZED (
      SELECT id,ordinal,CASE WHEN turn_id='' THEN 'unknown' ELSE turn_id END AS turn_id,kind,final,
        CASE WHEN kind='assistant' AND ${replyBodySql} THEN 1 ELSE 0 END AS has_body
      FROM session_messages WHERE revision=?${branch}
    ), ranked AS (
      SELECT *,ROW_NUMBER() OVER (PARTITION BY turn_id,kind ORDER BY has_body DESC,ordinal DESC,id DESC) AS answer_rank FROM scoped
    ), visible AS (
      SELECT * FROM ranked WHERE kind='user' OR (kind='assistant' AND has_body=1 AND answer_rank=1)
    )`;
    return { cte, values };
  }

  private searchBriefVisible(rows: SearchMessageRow[], version: string) {
    const batches = new Map<string, SearchMessageRow[]>();
    for (const row of rows) {
      if (!row.message_id || (row.kind !== "user" && row.kind !== "assistant")) continue;
      const batch = batches.get(row.revision) ?? [];
      batch.push(row); batches.set(row.revision, batch);
    }
    const visible = new Map<string, Set<string>>();
    for (const [revision, batch] of batches) {
      // 必须对命中所在完整轮次排名，不能只筛命中消息，否则中间回复会变成兜底终答。
      const turnIds = [...new Set(batch.flatMap(row => !row.turn_id || row.turn_id === "unknown" ? ["", "unknown"] : [row.turn_id]))];
      const { cte, values } = this.readingScope(revision, this.summary(batch[0]!, version), { mode: "brief", branch: "all" }, turnIds);
      const ids = batch.map(row => row.message_id!);
      const matches = this.database.prepare(`${cte} SELECT id FROM visible WHERE id IN (SELECT value FROM json_each(?))`)
        .all(...values, JSON.stringify(ids)) as { id: string }[];
      visible.set(revision, new Set(matches.map(row => row.id)));
    }
    return visible;
  }

  matches(id: string, query: SessionQuery = {}): { version: string; matches: boolean } {
    const version = this.version(query.version);
    if (query.q?.trim()) {
      const { union, values } = this.searchCandidates({ ...query, sessionId: id }, version, true);
      return { version, matches: Boolean(this.database.prepare(`SELECT 1 FROM (${union}) LIMIT 1`).get(...values)) };
    }
    const { from, values } = this.listCandidates(query, version, id);
    return { version, matches: Boolean(this.database.prepare(`SELECT 1 ${from} LIMIT 1`).get(...values)) };
  }

  turnDirectory(id: string, query: SessionMessageQuery = {}): SessionTurnDirectory {
    const version = this.version(query.version);
    const { revision, summary } = this.session(id, version);
    const { cte, values } = this.readingScope(revision, summary, { ...query, mode: query.mode ?? "brief" });
    const { page, pageSize } = paging(query);
    const groups = `${cte}, rounds AS (SELECT turn_id AS id,(SELECT MIN(s.ordinal) FROM scoped s WHERE s.turn_id=visible.turn_id) AS ordinal FROM visible
      WHERE turn_id NOT LIKE '%:turn:0' GROUP BY turn_id), directory AS (
      SELECT *,ROW_NUMBER() OVER (ORDER BY ordinal,id) AS position FROM rounds)`;
    const total = (this.database.prepare(`${groups} SELECT COUNT(*) AS count FROM directory`).get(...values) as { count: number }).count;
    const turns = this.database.prepare(`${groups} SELECT id,position,COALESCE((SELECT substr(text,1,4096) FROM session_messages m
      WHERE m.revision=? AND m.id IN (SELECT id FROM scoped WHERE turn_id=directory.id AND kind='user') ORDER BY ordinal,id LIMIT 1),'') AS question
      FROM directory ORDER BY position LIMIT ? OFFSET ?`).all(...values, revision, pageSize, (page - 1) * pageSize) as SessionTurnDirectory["turns"];
    return { version, turns, total, page, pageSize };
  }

  messages(id: string, query: SessionMessageQuery = {}): SessionMessageResult {
    const version = this.version(query.version);
    const { revision, summary: session } = this.session(id, version);
    const pagination = paging(query.pageUnit === "turn" ? { ...query, pageSize: query.pageSize ?? 10 } : query);
    const { cte, values } = this.readingScope(revision, session, query);
    const targetParts: string[] = [];
    const targetValues: SqlValue[] = [];
    if (query.messageId) { targetParts.push("id=?"); targetValues.push(query.messageId); }
    else {
      if (query.toolName) { targetParts.push("kind='tool_call' AND json_extract(json,'$.tool')=?"); targetValues.push(query.toolName); }
      const resourceFilters = ([["kind", query.resourceKind], ["name", query.resourceName], ["server", query.resourceServer]] as const)
        .flatMap(([key, value]) => value ? [{ key, value }] : []);
      if (resourceFilters.length) {
        targetParts.push(`(${resourceFilters.map(({ key }) => `json_extract(session_messages.json,'$.resource.${key}')=?`).join(" AND ")}
          OR EXISTS (SELECT 1 FROM json_each(session_messages.json,'$.resources') usage WHERE ${resourceFilters.map(({ key }) => `json_extract(usage.value,'$.${key}')=?`).join(" AND ")}))`);
        targetValues.push(...resourceFilters.map(({ value }) => value), ...resourceFilters.map(({ value }) => value));
      }
    }
    const target = targetParts.length ? this.database.prepare(`${cte} SELECT ordinal,id,turn_id,kind,final FROM session_messages
      WHERE revision=? AND id IN (SELECT id FROM scoped) AND ${targetParts.join(" AND ")} ORDER BY ordinal,id LIMIT 1`).get(...values, revision, ...targetValues) as
      { ordinal: number; id: string; turn_id: string; kind: string; final: string | null } | undefined : undefined;
    if (!target && targetParts.length && (!query.messageId || query.pageUnit === "turn")) throw new StoreError("SOURCE_NOT_FOUND", "定位消息不存在于当前会话", { key: "diagnostics.sessions.store.m013" });
    if (target && !this.database.prepare(`${cte} SELECT 1 FROM visible WHERE id=?`).get(...values, target.id)) {
      throw new StoreError("INVALID_INPUT", "定位消息不在简易视图中，请切换完整或轨迹视图", { key: "diagnostics.sessions.store.m014" });
    }
    const textColumns = query.maxTextChars ? `substr(text,1,${Math.min(100_000, Math.max(1, Math.floor(query.maxTextChars)))}) AS text,
      CASE WHEN instr(text,char(0))>0 THEN session_text_length(text) ELSE length(text) END AS text_length,length(CAST(text AS BLOB)) AS text_bytes` : "text";
    const project = (rows: PreviewMessageRow[]) => rows.map(row => {
      const message = decodePreview(row);
      return query.mode === "brief" && message.kind === "assistant" && !message.final ? { ...message, unconfirmed: true } : message;
    });
    if (query.pageUnit === "turn") {
      const groups = this.database.prepare(`${cte} SELECT turn_id AS id,COUNT(*) AS messageCount FROM visible
        GROUP BY turn_id ORDER BY (SELECT MIN(s.ordinal) FROM scoped s WHERE s.turn_id=visible.turn_id),MIN(id)`).all(...values) as { id: string; messageCount: number }[];
      const initial = groups.filter(turn => turn.id.endsWith(":turn:0"));
      const rounds = groups.filter(turn => !turn.id.endsWith(":turn:0"));
      const totalTurns = rounds.length;
      const total = groups.reduce((sum, turn) => sum + turn.messageCount, 0);
      const targetPosition = target ? target.turn_id.endsWith(":turn:0") ? 0 : rounds.findIndex(turn => turn.id === (target.turn_id || "unknown")) + 1 : query.turnPosition;
      if (targetPosition !== undefined) {
        if (targetPosition < 0 || targetPosition > totalTurns) throw new StoreError("INVALID_INPUT", "轮次位置超出当前视图范围", { key: "diagnostics.sessions.store.m015" });
        pagination.page = targetPosition === 0 ? 1 : Math.floor((targetPosition - 1) / pagination.pageSize) + 1;
      }
      pagination.page = Math.min(pagination.page, Math.max(1, Math.ceil(totalTurns / pagination.pageSize)));
      const turns = rounds.slice((pagination.page - 1) * pagination.pageSize, pagination.page * pagination.pageSize)
        .map((turn, index) => ({ ...turn, position: (pagination.page - 1) * pagination.pageSize + index + 1 }));
      if (pagination.page === 1) turns.unshift(...initial.map(turn => ({ ...turn, position: 0 })));
      const turnIds = turns.map(turn => turn.id);
      const messageLimit = query.messageLimit === undefined ? undefined : Math.min(2000, Math.max(1, Math.floor(query.messageLimit)));
      let messageOffset = Math.max(0, Math.floor(query.messageOffset ?? 0));
      if (target && messageLimit && query.messageOffset === undefined) {
        const before = (this.database.prepare(`${cte} SELECT COUNT(*) AS count FROM visible
          WHERE turn_id IN (${turnIds.map(() => "?").join(",")}) AND (ordinal<? OR (ordinal=? AND id<?))`)
          .get(...values, ...turnIds, target.ordinal, target.ordinal, target.id) as { count: number }).count;
        messageOffset = Math.floor(before / messageLimit) * messageLimit;
      }
      const bounded = messageLimit !== undefined;
      const messages = turns.length ? project(this.database.prepare(`${cte} SELECT ${MESSAGE_COLUMNS},${textColumns} FROM session_messages
        WHERE revision=? AND id IN (SELECT id FROM visible WHERE turn_id IN (${turnIds.map(() => "?").join(",")})) ORDER BY ordinal,id${bounded ? " LIMIT ? OFFSET ?" : ""}`)
        .all(...values, revision, ...turnIds, ...(bounded ? [messageLimit, messageOffset] : [])) as PreviewMessageRow[]) : [];
      const pageMessagesTotal = turns.reduce((sum, turn) => sum + turn.messageCount, 0);
      const usages = bounded ? this.usagesForTurns(revision, id, turnIds) : undefined;
      return { version, session, messages, total, ...pagination, pageUnit: "turn", totalTurns, turns, focusMessageId: target?.id,
        ...(bounded ? { messageOffset, messageLimit, hasMoreMessages: messageOffset + messages.length < pageMessagesTotal, usages,
          ...this.messageToolPairs(revision, session, query, messages, textColumns) } : {}) };
    }
    if (query.turnPosition !== undefined) throw new StoreError("INVALID_INPUT", "turnPosition 仅支持完整轮次分页", { key: "diagnostics.sessions.store.m016" });
    if (target) {
      const preceding = (this.database.prepare(`${cte} SELECT COUNT(*) AS count FROM visible WHERE ordinal<? OR (ordinal=? AND id<?)`)
        .get(...values, target.ordinal, target.ordinal, target.id) as { count: number }).count;
      pagination.page = Math.floor(preceding / pagination.pageSize) + 1;
    }
    const total = (this.database.prepare(`${cte} SELECT COUNT(*) AS count FROM visible`).get(...values) as { count: number }).count;
    const messages = project(this.database.prepare(`${cte} SELECT ${MESSAGE_COLUMNS},${textColumns} FROM session_messages
      WHERE revision=? AND id IN (SELECT id FROM visible ORDER BY ordinal,id LIMIT ? OFFSET ?) ORDER BY ordinal,id`)
      .all(...values, revision, pagination.pageSize, (pagination.page - 1) * pagination.pageSize) as MessageRow[]);
    return { version, session, messages, total, ...pagination, focusMessageId: target?.id };
  }

  private messageToolPairs(revision: string, session: SessionSummary, query: SessionMessageQuery, messages: SessionMessage[], textColumns: string):
    Pick<SessionMessageResult, "toolPairs" | "relatedMessages"> {
    const callIds = [...new Set(messages.filter(message => message.kind === "tool_call" || message.kind === "tool_result").flatMap(message => message.callId ? [message.callId] : []))];
    if (!callIds.length) return { toolPairs: [], relatedMessages: [] };
    const scope = this.readingBranch(session, query);
    // 利用调用身份索引批量查元信息，歧义判断覆盖完整分支，而不搬整轮正文。
    const candidates = (this.database.prepare(`SELECT ${MESSAGE_COLUMNS} FROM session_messages
      WHERE revision=? AND call_id IN (SELECT value FROM json_each(?)) AND kind IN ('tool_call','tool_result')${scope.branch} ORDER BY ordinal,id`)
      .all(revision, JSON.stringify(callIds), ...scope.values) as MessageMetadataRow[]).map(decodeMessageMetadata);
    const groups = new Map<string, { calls: Omit<SessionMessage, "text">[]; results: Omit<SessionMessage, "text">[] }>();
    for (const message of candidates) {
      const key = `${message.sessionId}\0${message.turnId}\0${message.callId}`;
      const group = groups.get(key) ?? { calls: [], results: [] };
      (message.kind === "tool_call" ? group.calls : group.results).push(message); groups.set(key, group);
    }
    const pageIds = new Set(messages.map(message => message.id));
    const toolPairs: NonNullable<SessionMessageResult["toolPairs"]> = [];
    for (const { calls, results } of groups.values()) {
      if (calls.length !== 1 || results.length !== 1) continue;
      const call = calls[0]!, result = results[0]!;
      if ((!pageIds.has(call.id) && !pageIds.has(result.id)) || result.ordinal <= call.ordinal
        || call.tool && result.tool && call.tool !== result.tool) continue;
      toolPairs.push({ callMessageId: call.id, resultMessageId: result.id });
    }
    const relatedIds = [...new Set(toolPairs.flatMap(pair => [pair.callMessageId, pair.resultMessageId]).filter(id => !pageIds.has(id)))];
    const relatedMessages = relatedIds.length ? (this.database.prepare(`SELECT ${MESSAGE_COLUMNS},${textColumns} FROM session_messages
      WHERE revision=? AND id IN (SELECT value FROM json_each(?)) ORDER BY ordinal,id`).all(revision, JSON.stringify(relatedIds)) as PreviewMessageRow[]).map(decodePreview) : [];
    return { toolPairs, relatedMessages };
  }

  private eligibleUsageWhere(): string {
    return `NOT EXISTS (SELECT 1 FROM session_messages m WHERE m.revision=u.revision AND m.copied=1 AND m.id=u.message_id)
      AND (u.message_id IS NOT NULL OR
        ((json_array_length(u.json,'$.requestMessageIds')>0 OR json_extract(u.json,'$.timing.end.messageId') IS NOT NULL) AND NOT EXISTS
          (SELECT 1 FROM session_messages m WHERE m.revision=u.revision AND m.copied=1 AND m.id IN
            (SELECT value FROM json_each(u.json,'$.requestMessageIds') UNION SELECT json_extract(u.json,'$.timing.end.messageId')))) OR
        (COALESCE(json_array_length(u.json,'$.requestMessageIds'),0)=0 AND json_extract(u.json,'$.timing.end.messageId') IS NULL AND NOT EXISTS
          (SELECT 1 FROM session_messages m WHERE m.revision=u.revision AND m.copied=1 AND m.turn_id=u.turn_id)))`;
  }

  usageVersion(requestedVersion?: string): string { return this.version(requestedVersion); }

  overviewGaps(requestedVersion?: string): Gap[] {
    const version = this.version(requestedVersion);
    return JSON.parse((this.overviewStatement("SELECT gaps FROM session_versions WHERE id=?").get(version) as { gaps: string }).gaps) as Gap[];
  }

  /** 派生缓存只保留仍属于完整发布版本的会话修订。 */
  overviewRetainedRevisions(): string[] {
    return (this.overviewStatement("SELECT DISTINCT revision FROM session_version_sessions").all() as { revision: string }[])
      .map(row => row.revision);
  }

  /** 只在时间桶回填或原事件调查时读取成员，避免在派生库复制请求成员表。 */
  overviewRequestMembers(revision: string, requestIds?: string[]): Iterable<{ id: string; messageId?: string; requestMessageIds?: string[]; endMessageId?: string }> {
    const rows = this.overviewStatement(`SELECT u.id,u.message_id,
      json_extract(u.json,'$.requestMessageIds') AS members,
      CASE WHEN COALESCE(json_extract(u.json,'$.timing.end.source'),'')<>'mirror'
        THEN json_extract(u.json,'$.timing.end.messageId') END AS end_id
      FROM session_usage_facts f JOIN session_usage u ON u.revision=f.revision AND u.id=f.id
      WHERE f.revision=? AND f.eligible=1${requestIds ? " AND u.id IN (SELECT value FROM json_each(?))" : ""}
      ORDER BY f.ordinal`).iterate(revision, ...(requestIds ? [JSON.stringify(requestIds)] : [])) as Iterable<{
        id: string; message_id: string | null; members: string | null; end_id: string | null }>;
    return (function* () {
      for (const row of rows) yield { id: row.id, messageId: row.message_id ?? undefined,
        requestMessageIds: row.members === null ? undefined : JSON.parse(row.members) as string[], endMessageId: row.end_id ?? undefined };
    })();
  }

  /** 活动原记录按当前页恢复原状态，不把配对后的工具结果覆盖原事件显示。 */
  overviewActivityStatuses(revision: string, ids: string[]): { id: string; status: OverviewEvent["status"] | null }[] {
    return this.overviewStatement(`SELECT id,json_extract(json,'$.status') AS status FROM session_messages
      WHERE revision=? AND id IN (SELECT value FROM json_each(?)) AND copied IS NOT 1`)
      .all(revision, JSON.stringify(ids)) as { id: string; status: OverviewEvent["status"] | null }[];
  }

  /** 按不可变修订读取窄事实；完整请求正文与工具参数不进入派生缓存。 */
  overviewRevisionFacts(revision: string, sessionId: string): Pick<OverviewSource, "events" | "requests"> {
    this.ensureUsageFacts(revision);
    const events = (this.overviewStatement(`SELECT id,ordinal,turn_id,kind,call_id,
      json_extract(json,'$.occurredAt') AS occurred_at,json_extract(json,'$.model') AS model,
      json_extract(json,'$.tool') AS tool,json_extract(json,'$.status') AS status,
      json_extract(json,'$.durationMs') AS duration_ms,json_extract(json,'$.contextSource') AS context_source,
      json_extract(json,'$.contextEvidence') AS context_evidence,json_extract(json,'$.resource') AS resource
      FROM session_messages WHERE revision=? AND copied IS NOT 1
        AND kind IN ('user','assistant','thinking','tool_call','tool_result','compression') ORDER BY ordinal,id`)
      .all(revision) as { id: string; ordinal: number; turn_id: string; kind: OverviewEvent["kind"];
        call_id: string | null; occurred_at: string | null; model: string | null; tool: string | null;
        status: OverviewEvent["status"] | null; duration_ms: number | null;
        context_source: OverviewEvent["contextSource"] | null; context_evidence: OverviewEvent["contextEvidence"] | null;
        resource: string | null }[]).map(row => ({ id: row.id, sessionId, ordinal: row.ordinal, turnId: row.turn_id,
      kind: row.kind, callId: row.call_id ?? undefined, occurredAt: row.occurred_at ?? undefined,
      model: row.model ?? undefined, tool: row.tool ?? undefined, status: row.status ?? undefined,
      durationMs: row.duration_ms ?? undefined, contextSource: row.context_source ?? undefined,
      contextEvidence: row.context_evidence ?? undefined, ...(row.resource ? { resource: JSON.parse(row.resource) } : {}) }));
    const requests = this.overviewRevisionRequests(revision, sessionId);
    return { events, requests };
  }

  private overviewRevisionRequests(revision: string, sessionId: string): OverviewSource["requests"] {
    this.ensureUsageFacts(revision);
    return (this.overviewStatement(`SELECT f.id,f.ordinal,f.model,f.provider,f.occurred_at,
      f.input_tokens,f.output_tokens,f.cache_read_tokens,f.cache_write_tokens,f.reasoning_tokens,f.context_tokens,u.message_id,u.turn_id,
      json_extract(u.json,'$.requestMessageIds') AS members,json_extract(u.json,'$.timing') AS timing,
      json_extract(u.json,'$.reasoningEffort') AS reasoning_effort
      FROM session_usage_facts f JOIN session_usage u ON u.revision=f.revision AND u.id=f.id
      WHERE f.revision=? AND f.eligible=1 ORDER BY f.ordinal`).all(revision) as {
        id: string; ordinal: number; model: string | null; provider: string | null; occurred_at: string | null;
        input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null;
        reasoning_tokens: number | null; context_tokens: number | null;
        reasoning_effort: string | null; message_id: string | null; turn_id: string | null; members: string | null; timing: string | null }[]).map(row =>
      ({ sessionId, ordinal: row.ordinal, usage: { id: row.id,
        ...(row.reasoning_effort !== null ? { reasoningEffort: row.reasoning_effort } : {}),
        ...(row.model !== null ? { model: row.model } : {}),
        ...(row.provider !== null ? { provider: row.provider } : {}),
        ...(row.occurred_at !== null ? { occurredAt: row.occurred_at } : {}),
        ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
        ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
        ...(row.cache_read_tokens !== null ? { cachedInputTokens: row.cache_read_tokens } : {}),
        ...(row.cache_write_tokens !== null ? { cacheWriteTokens: row.cache_write_tokens } : {}),
        ...(row.reasoning_tokens !== null ? { reasoningOutputTokens: row.reasoning_tokens } : {}),
        ...(row.context_tokens !== null ? { contextTokens: row.context_tokens } : {}),
        ...(row.message_id !== null ? { messageId: row.message_id } : {}),
        ...(row.turn_id !== null ? { turnId: row.turn_id } : {}),
        ...(row.members ? { requestMessageIds: JSON.parse(row.members) as string[] } : {}),
        ...(row.timing ? { timing: JSON.parse(row.timing) as SessionUsage["timing"] } : {}) } }));
  }

  /** 七天复盘按候选修订读取轮次边界与长度；完整用户正文不离开原索引。 */
  weeklyReviewRevisionFacts(revision: string, sessionId: string, scope?: { fromMs: number; toMs: number; client?: Client; timezone?: string;
    dayBounds?: { day: string; end: number }[];
    boundaryEvents?: WeeklyReviewEvent[];
    includeRounds?: boolean;
    requestFacts?: (turnIds: string[]) => OverviewSource["requests"] | undefined;
    processFacts?: (turnIds: string[]) => { events: WeeklyReviewEvent[]; retainedCompressions: number; missingTimeEvents: number; missingTimeRequests: number; activityDays: string[] } | undefined;
  }): {
    events: WeeklyReviewEvent[]; requests: OverviewSource["requests"]; retainedCompressions?: number; missingTimeEvents?: number; missingTimeRequests?: number; activityDays?: string[];
  } {
    const identityColumns = "id,ordinal,turn_id,record_line,kind,final,call_id";
    const endColumns = "json_extract(json,'$.finalEvidence') AS final_evidence,json_extract(json,'$.finalAt') AS final_at,json_extract(json,'$.finishedAt') AS finished_at,json_extract(json,'$.interrupted') AS interrupted";
    const columns = `${identityColumns},${endColumns},
      json_extract(json,'$.occurredAt') AS occurred_at,json_extract(json,'$.tool') AS tool,
      json_extract(json,'$.status') AS status,json_extract(json,'$.contextSource') AS context_source,
      json_extract(json,'$.resource') AS resource,
      CASE WHEN ${scope?.includeRounds === false ? "0" : "kind='user'"} AND json_extract(json,'$.contextSource') IS NULL AND COALESCE(json_extract(json,'$.resource.kind'),'')!='skill_read'${scope ? " AND usage_time_ms(json_extract(json,'$.occurredAt'))>=? AND usage_time_ms(json_extract(json,'$.occurredAt'))<?" : ""}
        THEN session_prompt_characters(text) END AS prompt_characters,
      ${scope ? "NULL" : "CASE WHEN kind='user' THEN substr(text,1,120) END"} AS prompt_preview`;
    type Row = { id: string; ordinal: number; turn_id: string; record_line: number; kind: WeeklyReviewEvent["kind"];
      final: WeeklyReviewEvent["final"] | null; final_evidence: WeeklyReviewEvent["finalEvidence"] | null; final_at: string | null; finished_at: string | null; interrupted: number | null; call_id: string | null; occurred_at: string | null; tool: string | null;
      status: WeeklyReviewEvent["status"] | null; context_source: WeeklyReviewEvent["contextSource"] | null;
      resource: string | null; prompt_characters: number | null; prompt_preview: string | null };
    const replies = scope?.includeRounds === false ? new Set<string>() : this.lastReplyIds(revision);
    const boundaryMetadata = new Map(scope?.boundaryEvents?.map(event => [event.id, event]));
    const decode = (row: Row): WeeklyReviewEvent => boundaryMetadata.has(row.id)
      ? { ...boundaryMetadata.get(row.id)!, sessionId, ordinal: row.ordinal, turnId: row.turn_id, recordLine: row.record_line,
        hasReply: replies.has(row.id), final: row.final ?? undefined, finalEvidence: row.final_evidence ?? undefined, finalAt: row.final_at ?? undefined, finishedAt: row.finished_at ?? undefined, interrupted: row.interrupted === 1 || undefined, callId: row.call_id ?? undefined }
      : ({ id: row.id, sessionId, ordinal: row.ordinal, turnId: row.turn_id, recordLine: row.record_line,
      kind: row.kind, hasReply: replies.has(row.id), final: row.final ?? undefined, finalEvidence: row.final_evidence ?? undefined, finalAt: row.final_at ?? undefined, finishedAt: row.finished_at ?? undefined, interrupted: row.interrupted === 1 || undefined, callId: row.call_id ?? undefined, occurredAt: row.occurred_at ?? undefined,
      tool: row.tool ?? undefined, status: row.status ?? undefined, contextSource: row.context_source ?? undefined,
      ...(row.resource ? { resource: JSON.parse(row.resource) } : {}),
      ...(row.prompt_characters === null ? {} : { promptCharacters: row.prompt_characters }),
      ...(row.prompt_preview === null ? {} : { promptPreview: row.prompt_preview }) });
    const prefix = scope ? [scope.fromMs, scope.toMs] : [];
    const cachedBoundaries = scope?.boundaryEvents !== undefined;
    const cachedRows = scope?.boundaryEvents?.filter(event => event.kind === "user" || replies.has(event.id));
    const boundarySource = cachedBoundaries ? `(SELECT value AS boundary FROM json_each(?)) selected CROSS JOIN ${this.overviewMessageTable === "session_messages" ? "session_messages INDEXED BY session_message_order" : this.overviewMessageTable}` : this.overviewMessageTable;
    const boundaryRows = cachedBoundaries && scope!.includeRounds === false ? scope!.boundaryEvents!
      : (this.overviewStatement(`SELECT ${cachedBoundaries ? `${identityColumns},${endColumns}` : columns} FROM ${boundarySource} WHERE revision=? AND copied IS NOT 1
      ${cachedBoundaries ? "AND ordinal=json_extract(selected.boundary,'$[1]') AND id=json_extract(selected.boundary,'$[0]')" : ""}
      AND ${scope ? "(kind='user' OR id IN (SELECT value FROM json_each(?)))" : "(kind IN ('user','tool_call','tool_result','compression') OR id IN (SELECT value FROM json_each(?)))"}
      ${scope?.includeRounds === false ? "AND kind='user' AND usage_time_ms(json_extract(json,'$.occurredAt'))>=? AND usage_time_ms(json_extract(json,'$.occurredAt'))<?" : ""}
      ORDER BY ordinal,id`).all(...(cachedBoundaries ? [JSON.stringify(cachedRows!.map(event => [event.id, event.ordinal]))] : prefix), revision, JSON.stringify([...replies]),
        ...(scope?.includeRounds === false ? [scope.fromMs, scope.toMs] : [])) as Row[]).map(decode);
    if (!scope) return { events: boundaryRows, requests: this.overviewRevisionRequests(revision, sessionId) };
    const inRange = (value?: string) => { const time = Date.parse(value ?? ""); return Number.isFinite(time) && time >= scope.fromMs && time < scope.toMs; };
    const selectedTurns = new Set(boundaryRows.filter(event => inRange(event.kind === "assistant" ? replyObservedAt(event) : event.occurredAt) && !event.contextSource
      && !(event.kind === "user" && event.resource?.kind === "skill_read")).map(event => event.turnId));
    const fullTurns = new Map<string, WeeklyReviewEvent>();
    for (const event of boundaryRows) if (event.kind === "assistant" && event.hasReply) fullTurns.set(event.turnId, event);
    const fullIds = JSON.stringify([...fullTurns.values()].filter(event => inRange(replyObservedAt(event))).map(event => event.turnId));
    let boundaries = boundaryRows.filter(event => selectedTurns.has(event.turnId));
    const cachedProcess = scope.processFacts?.(JSON.parse(fullIds) as string[]);
    const process = scope.includeRounds === false ? [] : cachedProcess?.events ?? (this.overviewStatement(`SELECT ${columns} FROM ${this.overviewMessageTable} WHERE revision=? AND copied IS NOT 1
      AND kind IN ('tool_call','compression')
      AND (usage_time_ms(json_extract(json,'$.occurredAt'))>=? AND usage_time_ms(json_extract(json,'$.occurredAt'))<?
        OR turn_id IN (SELECT value FROM json_each(?))) ORDER BY ordinal,id`)
      .all(...prefix, revision, scope.fromMs, scope.toMs, fullIds) as Row[]).map(decode);
    if (!cachedProcess && scope.includeRounds !== false) {
      const callIds = JSON.stringify([...new Set(process.filter(event => event.kind === "tool_call" && event.callId).map(event => event.callId))]);
      const paired = new Map(pairToolCalls((this.overviewStatement(`SELECT ${columns} FROM ${this.overviewMessageTable} WHERE revision=?
        AND copied IS NOT 1 AND kind IN ('tool_call','tool_result') AND call_id IN (SELECT value FROM json_each(?)) ORDER BY ordinal,id`)
        .all(...prefix, revision, callIds) as Row[]).map(decode)).map(event => [event.id, event]));
      for (let index = 0; index < process.length; index += 1) {
        const event = process[index]!, match = paired.get(event.id);
        if (match) process[index] = { ...event, ...match };
      }
    }
    // 周复盘只读原请求，不在索引库回填用量事实，避免与后台刷新争用写锁。
    const cachedRequests = scope.requestFacts?.(JSON.parse(fullIds) as string[]);
    const preparedUsage = usageFactsReady(this.database, revision);
    const copied = !preparedUsage && Boolean(this.overviewStatement("SELECT 1 FROM session_messages WHERE revision=? AND copied=1 LIMIT 1").get(revision));
    const resolvedTurn = `COALESCE(u.turn_id,(SELECT CASE WHEN COUNT(DISTINCT turn_id)=1 THEN MIN(turn_id) END FROM (
      SELECT m.turn_id FROM session_messages m WHERE m.revision=u.revision AND m.id=u.message_id
      UNION ALL SELECT m.turn_id FROM json_each(u.json,'$.requestMessageIds') member
        CROSS JOIN session_messages m ON m.revision=u.revision AND m.id=member.value
      UNION ALL SELECT m.turn_id FROM session_messages m WHERE m.revision=u.revision
        AND COALESCE(json_extract(u.json,'$.timing.end.source'),'')<>'mirror'
        AND m.id=json_extract(u.json,'$.timing.end.messageId'))))`;
    const missingTurns = cachedRequests?.filter(request => request.usage.turnId == null).map(request => request.usage.id) ?? [];
    const rows = cachedRequests !== undefined ? missingTurns.length ? this.overviewStatement(`SELECT u.json,${resolvedTurn} AS resolved_turn
      FROM session_usage u WHERE u.revision=? AND u.id IN (SELECT value FROM json_each(?)) ORDER BY u.rowid`)
      .all(revision, JSON.stringify(missingTurns)) as { json: string; resolved_turn: string | null }[] : []
      : preparedUsage ? this.overviewStatement(`SELECT u.json,${resolvedTurn} AS resolved_turn
      FROM session_usage_facts f JOIN session_usage u ON u.revision=f.revision AND u.id=f.id
      WHERE f.revision=? AND f.eligible=1 AND (f.time_ms>=? AND f.time_ms<?
        OR ${resolvedTurn} IN (SELECT value FROM json_each(?))) ORDER BY f.ordinal`)
      .all(revision, scope.fromMs, scope.toMs, fullIds) as { json: string; resolved_turn: string | null }[]
      : this.overviewStatement(`SELECT u.json,${resolvedTurn} AS resolved_turn FROM session_usage u
      WHERE u.revision=? AND ${copied ? this.eligibleUsageWhere() : "1"}
        AND (usage_time_ms(json_extract(u.json,'$.occurredAt'))>=? AND usage_time_ms(json_extract(u.json,'$.occurredAt'))<?
          OR ${resolvedTurn} IN (SELECT value FROM json_each(?))) ORDER BY u.rowid`)
      .all(revision, scope.fromMs, scope.toMs, fullIds) as { json: string; resolved_turn: string | null }[];
    const resolvedRequests: OverviewSource["requests"] = rows.map((row, ordinal) => {
      const raw = JSON.parse(row.json) as SessionUsage;
      return { sessionId, ordinal, usage: { ...raw, ...(row.resolved_turn === null ? {} : { turnId: row.resolved_turn }) } };
    });
    const resolvedById = new Map(resolvedRequests.map(request => [request.usage.id, request]));
    const endedTurns = new Set(JSON.parse(fullIds) as string[]);
    const requests = cachedRequests === undefined ? resolvedRequests : cachedRequests.map(request => resolvedById.get(request.usage.id) ?? request)
      .filter(request => {
        const time = instant(request.usage.occurredAt ?? "");
        return time !== undefined && time >= scope.fromMs && time < scope.toMs || endedTurns.has(request.usage.turnId ?? "");
      }).map((request, ordinal) => {
        const usage = request.usage;
        return { sessionId, ordinal, usage };
      });
    for (const request of requests) if (request.usage.turnId) selectedTurns.add(request.usage.turnId);
    boundaries = boundaryRows.filter(event => selectedTurns.has(event.turnId));
    if (scope.includeRounds !== false) {
      const ids = boundaries.filter(event => event.kind === "user" && !event.contextSource && event.resource?.kind !== "skill_read").map(event => event.id);
      // 只在轮次与请求筛选完成后读取必要的需求预览，旧轮次正文不参与七天首算。
      const titles = new Map((this.overviewStatement(`SELECT id,${scope.client === "codex" ? "session_user_title(text)" : "substr(text,1,120)"} AS title,
        ${cachedBoundaries ? "CASE WHEN usage_time_ms(json_extract(json,'$.occurredAt'))>=? AND usage_time_ms(json_extract(json,'$.occurredAt'))<? THEN session_prompt_characters(text) END" : "NULL"} AS characters
        FROM (SELECT value AS selected_id FROM json_each(?)) selected CROSS JOIN session_messages
        WHERE revision=? AND id=selected.selected_id`)
        .all(...(cachedBoundaries ? prefix : []), JSON.stringify(ids), revision) as { id: string; title: string; characters: number | null }[])
        .map(row => [row.id, row]));
      boundaries = boundaries.map(event => titles.has(event.id) ? { ...event, promptPreview: titles.get(event.id)!.title,
        ...(titles.get(event.id)!.characters === null ? {} : { promptCharacters: titles.get(event.id)!.characters! }) } : event);
    }
    const dayProjection = scope.dayBounds?.length ? `CASE ${scope.dayBounds.map(() => "WHEN usage_time_ms(json_extract(json,'$.occurredAt'))<? THEN ?").join(" ")} END`
      : "session_local_day(json_extract(json,'$.occurredAt'),?)";
    const dayValues = scope.dayBounds?.length ? scope.dayBounds.flatMap(day => [day.end, day.day]) : [scope.timezone ?? "UTC"];
    const activityDays = cachedProcess?.activityDays ?? (this.overviewStatement(`SELECT DISTINCT
      ${dayProjection} AS day FROM ${this.overviewMessageTable} WHERE revision=? AND copied IS NOT 1
        AND ${scope.includeRounds === false ? "kind IN ('user','assistant','thinking','tool_call','tool_result','compression') AND NOT(kind='user' AND COALESCE(json_extract(json,'$.resource.kind'),'')='skill_read')" : "kind IN ('assistant','thinking','tool_result')"} AND json_extract(json,'$.contextSource') IS NULL
        AND usage_time_ms(json_extract(json,'$.occurredAt'))>=? AND usage_time_ms(json_extract(json,'$.occurredAt'))<?`)
      .all(...dayValues, revision, scope.fromMs, scope.toMs) as { day: string | null }[]).flatMap(row => row.day === null ? [] : [row.day]);
    const metadata = cachedProcess ? { compressions: cachedProcess.retainedCompressions, missing_events: cachedProcess.missingTimeEvents, missing_requests: cachedProcess.missingTimeRequests } : this.overviewStatement(`SELECT
      (SELECT COUNT(*) FROM ${this.overviewMessageTable} WHERE revision=? AND copied IS NOT 1 AND kind='compression'
        AND json_extract(json,'$.contextSource') IS NULL) AS compressions,
      (SELECT COUNT(*) FROM ${this.overviewMessageTable} WHERE revision=? AND copied IS NOT 1 AND kind IN ('user','assistant','thinking','tool_call','tool_result','compression')
        AND json_extract(json,'$.contextSource') IS NULL AND NOT(kind='user' AND COALESCE(json_extract(json,'$.resource.kind'),'')='skill_read') AND usage_time_ms(json_extract(json,'$.occurredAt')) IS NULL) AS missing_events,
      (${preparedUsage ? "SELECT COUNT(*) FROM session_usage_facts WHERE revision=? AND eligible=1 AND time_ms IS NULL"
        : `SELECT COUNT(*) FROM session_usage u WHERE revision=? AND ${copied ? this.eligibleUsageWhere() : "1"}
          AND usage_time_ms(json_extract(u.json,'$.occurredAt')) IS NULL`}) AS missing_requests`)
      .get(revision, revision, revision) as { compressions: number; missing_events: number; missing_requests: number };
    return { events: [...boundaries, ...process].sort((a, b) => a.ordinal - b.ordinal), requests,
      activityDays, retainedCompressions: metadata.compressions, missingTimeEvents: metadata.missing_events, missingTimeRequests: metadata.missing_requests };
  }

  /** 活动日升级只读执行元数据，不重新扫描用户正文或计价请求。 */
  weeklyReviewActivityDays(revision: string, bounds: { fromMs: number; toMs: number }, timezone: string): string[] {
    return (this.overviewStatement(`SELECT DISTINCT session_local_day(json_extract(json,'$.occurredAt'),?) AS day
      FROM session_messages WHERE revision=? AND copied IS NOT 1 AND kind IN ('assistant','thinking','tool_result')
        AND json_extract(json,'$.contextSource') IS NULL AND usage_time_ms(json_extract(json,'$.occurredAt'))>=?
        AND usage_time_ms(json_extract(json,'$.occurredAt'))<?`).all(timezone, revision, bounds.fromMs, bounds.toMs) as { day: string | null }[])
      .flatMap(row => row.day === null ? [] : [row.day]);
  }

  /** 总览后台读取完整版本的轻量事实，不查询消息正文与工具参数。 */
  overviewSource(requestedVersion?: string): OverviewSource {
    return this.database.transaction(() => {
      const { version, sessions } = this.usageFactSessions(requestedVersion);
      const eventRows = this.database.prepare(`SELECT v.session_id,m.id,m.ordinal,m.turn_id,m.kind,m.call_id,
        json_extract(m.json,'$.occurredAt') AS occurred_at,json_extract(m.json,'$.model') AS model,
        json_extract(m.json,'$.tool') AS tool,json_extract(m.json,'$.status') AS status,
        json_extract(m.json,'$.durationMs') AS duration_ms,json_extract(m.json,'$.contextSource') AS context_source,
        json_extract(m.json,'$.contextEvidence') AS context_evidence,json_extract(m.json,'$.resource') AS resource
        FROM session_version_sessions v JOIN session_messages m ON m.revision=v.revision
        WHERE v.version=? AND m.copied IS NOT 1
        AND m.kind IN ('user','assistant','thinking','tool_call','tool_result','compression')
        ORDER BY v.session_id,m.ordinal,m.id`).iterate(version) as Iterable<{
          session_id: string; id: string; ordinal: number; turn_id: string; kind: OverviewEvent["kind"];
          call_id: string | null; occurred_at: string | null; model: string | null; tool: string | null;
          status: OverviewEvent["status"] | null; duration_ms: number | null;
          context_source: OverviewEvent["contextSource"] | null; context_evidence: OverviewEvent["contextEvidence"] | null;
          resource: string | null;
        }>;
      const events: OverviewEvent[] = [];
      for (const row of eventRows) events.push({ id: row.id, sessionId: row.session_id, ordinal: row.ordinal,
        turnId: row.turn_id, kind: row.kind, callId: row.call_id ?? undefined, occurredAt: row.occurred_at ?? undefined,
        model: row.model ?? undefined, tool: row.tool ?? undefined, status: row.status ?? undefined,
        durationMs: row.duration_ms ?? undefined, contextSource: row.context_source ?? undefined,
        contextEvidence: row.context_evidence ?? undefined, ...(row.resource ? { resource: JSON.parse(row.resource) } : {}) });
      const requestRows = this.database.prepare(`SELECT v.session_id,u.rowid AS ordinal,u.json
        FROM session_version_sessions v JOIN session_usage u ON u.revision=v.revision
        WHERE v.version=? AND ${this.eligibleUsageWhere()} ORDER BY v.session_id,u.rowid`).iterate(version) as Iterable<JsonRow & { session_id: string; ordinal: number }>;
      const requests: OverviewSource["requests"] = [];
      for (const row of requestRows) requests.push({ sessionId: row.session_id, ordinal: row.ordinal, usage: decode<SessionUsage>(row) });
      const resources = [...this.resourceEvents({ version }).events];
      const gaps = JSON.parse((this.database.prepare("SELECT gaps FROM session_versions WHERE id=?").get(version) as { gaps: string }).gaps) as Gap[];
      return { version, sessions: sessions.map(row => row.session), events, requests, resources, gaps };
    })();
  }

  /** 请求下钻只读取目标身份及其父标题，完整版本仍使用同一存在性校验。 */
  usageFactSession(requestedVersion: string, sessionId: string): { revision: string; session: SessionSummary } | undefined {
    return this.database.transaction(() => {
      const version = this.version(requestedVersion);
      const row = this.database.prepare(`SELECT r.id AS revision,r.json,relation.parent FROM session_version_sessions v
        JOIN session_revisions r ON r.id=v.revision LEFT JOIN session_version_relations relation
          ON relation.version=v.version AND relation.child=v.session_id
        WHERE v.version=? AND v.session_id=?`).get(version, sessionId) as (JsonRow & { revision: string; parent: string | null }) | undefined;
      if (!row) return;
      const { path: _path, sourceId: _sourceId, ...summary } = decode<SessionSourceMeta>(row);
      if (row.parent) { summary.parentSessionId = row.parent; summary.relationship = "child"; }
      const session = sessionTitle(summary);
      if (session.parentSessionId) {
        const parentRow = this.database.prepare(`SELECT r.json,relation.parent FROM session_version_sessions v
          JOIN session_revisions r ON r.id=v.revision LEFT JOIN session_version_relations relation
            ON relation.version=v.version AND relation.child=v.session_id
          WHERE v.version=? AND v.session_id=?`).get(version, session.parentSessionId) as (JsonRow & { parent: string | null }) | undefined;
        if (parentRow) {
          const parentSummary = decode<SessionSummary>(parentRow);
          if (parentRow.parent) { parentSummary.parentSessionId = parentRow.parent; parentSummary.relationship = "child"; }
          const parent = sessionTitle(parentSummary);
          session.parentTitle = parent.title;
          session.parentTitleDescriptor = parent.titleOrigin === "fallback" ? {
            key: parent.relationship === "child" ? "sessions.title.childFallback" : "sessions.title.unnamed",
            ...(parent.relationship === "child" ? { params: { id: parent.clientSessionId.slice(-8) } } : {}),
          } : undefined;
        }
      }
      return { revision: row.revision, session };
    })();
  }

  /** 只读取版本内身份和关系，统计后台按修订补齐事实，不读取原请求 JSON。 */
  usageFactSessions(requestedVersion?: string): { version: string; sessions: { revision: string; session: SessionSummary }[] } {
    return this.database.transaction(() => {
      const version = this.version(requestedVersion);
      const rows = this.database.prepare(`SELECT r.id AS revision,r.json,relation.parent FROM session_version_sessions v
        JOIN session_revisions r ON r.id=v.revision LEFT JOIN session_version_relations relation
          ON relation.version=v.version AND relation.child=v.session_id
        WHERE v.version=? ORDER BY v.session_id`).all(version) as (JsonRow & { revision: string; parent: string | null })[];
      const sessions = rows.map(row => {
        const { path: _path, sourceId: _sourceId, ...summary } = decode<SessionSourceMeta>(row);
        if (row.parent) { summary.parentSessionId = row.parent; summary.relationship = "child"; }
        return { revision: row.revision, session: sessionTitle(summary) };
      });
      const byId = new Map(sessions.map(row => [row.session.id, row.session]));
      for (const { session } of sessions) {
        const parent = session.parentSessionId ? byId.get(session.parentSessionId) : undefined;
        if (!parent) continue;
        session.parentTitle = parent.title;
        session.parentTitleDescriptor = parent.titleOrigin === "fallback" ? {
          key: parent.relationship === "child" ? "sessions.title.childFallback" : "sessions.title.unnamed",
          ...(parent.relationship === "child" ? { params: { id: parent.clientSessionId.slice(-8) } } : {}),
        } : undefined;
      }
      return { version, sessions };
    })();
  }

  ensureUsageFacts(revision: string): void {
    if (this.overviewStatement("SELECT 1 FROM session_usage_fact_revisions WHERE revision=? AND format_version=?")
      .get(revision, USAGE_FACT_FORMAT_VERSION)) return;
    prepareUsageFacts(this.database, revision, this.eligibleUsageWhere());
  }

  /** 旧索引补齐按小批次提交；单修订保持保存点原子，批次失败整体回滚。 */
  ensureUsageFactsBatch(revisions: string[]): void {
    this.database.transaction(() => {
      const eligible = this.eligibleUsageWhere();
      for (const revision of new Set(revisions)) prepareUsageFacts(this.database, revision, eligible);
    }).immediate();
  }

  usageFactMetadata(revisions: string[]): UsageFactMetadata[] {
    return this.database.transaction(() => readUsageFactMetadata(this.database, revisions))();
  }

  usageFacts(revision: string, includeSpeed = false): SessionUsage[] {
    return this.database.transaction(() => {
      if (!this.database.prepare("SELECT 1 FROM session_revisions WHERE id=?").get(revision)) {
        throw new StoreError("SOURCE_NOT_FOUND", "会话不存在于当前索引版本", { key: "diagnostics.sessions.store.m011" });
      }
      if (!usageFactsReady(this.database, revision)) {
        throw new StoreError("ANALYSIS_NOT_READY", "会话索引尚未完成", { key: "diagnostics.sessions.store.m009" });
      }
      return readUsageFacts(this.database, revision, includeSpeed);
    })();
  }

  /** 原始证据只加载页内请求，并验证会话属于指定的完整发布版本。 */
  usageEvidence(requestedVersion: string, sessionId: string, ids: string[]): SessionUsage[] {
    return this.database.transaction(() => {
      const version = this.version(requestedVersion);
      const selected = this.database.prepare("SELECT revision FROM session_version_sessions WHERE version=? AND session_id=?")
        .get(version, sessionId) as { revision: string } | undefined;
      if (!selected) throw new StoreError("SOURCE_NOT_FOUND", "会话不存在于当前索引版本", { key: "diagnostics.sessions.store.m011" });
      if (!ids.length) return [];
      const rows = this.database.prepare(`SELECT id,json FROM session_usage
        WHERE revision=? AND id IN (SELECT value FROM json_each(?))`).all(selected.revision, JSON.stringify(ids)) as (JsonRow & { id: string })[];
      const byId = new Map(rows.map(row => [row.id, decode<SessionUsage>(row)]));
      return [...new Set(ids)].flatMap(id => { const usage = byId.get(id); return usage ? [usage] : []; });
    })();
  }

  /** 批量读取已发布用量和会话身份，不加载消息正文，也不逐会话查询父关系。 */
  usageSource(requestedVersion?: string): UsageSource {
    return this.database.transaction(() => {
      const version = this.version(requestedVersion);
      const rows = this.database.prepare(`SELECT r.json,relation.parent FROM session_version_sessions v
        JOIN session_revisions r ON r.id=v.revision LEFT JOIN session_version_relations relation
          ON relation.version=v.version AND relation.child=v.session_id
        WHERE v.version=? ORDER BY v.session_id`).all(version) as (JsonRow & { parent: string | null })[];
      const sessions = rows.map(row => {
        const { path: _path, sourceId: _sourceId, ...summary } = decode<SessionSourceMeta>(row);
        if (row.parent) { summary.parentSessionId = row.parent; summary.relationship = "child"; }
        return sessionTitle(summary);
      });
      const byId = new Map(sessions.map(summary => [summary.id, summary]));
      for (const summary of sessions) {
        const parent = summary.parentSessionId ? byId.get(summary.parentSessionId) : undefined;
        if (!parent) continue;
        summary.parentTitle = parent.title;
        summary.parentTitleDescriptor = parent.titleOrigin === "fallback" ? {
          key: parent.relationship === "child" ? "sessions.title.childFallback" : "sessions.title.unnamed",
          ...(parent.relationship === "child" ? { params: { id: parent.clientSessionId.slice(-8) } } : {}),
        } : undefined;
      }
      const usages = this.database.prepare(`SELECT v.session_id,u.json FROM session_version_sessions v
        JOIN session_usage u ON u.revision=v.revision WHERE v.version=? AND ${this.eligibleUsageWhere()}
        ORDER BY v.session_id,u.rowid`).all(version) as (JsonRow & { session_id: string })[];
      return { version, sessions, requests: usages.map(row => ({ sessionId: row.session_id, usage: decode<SessionUsage>(row) })) };
    })();
  }

  private usagesForTurns(revision: string, sessionId: string, turnIds: string[]): SessionProfile["steps"] {
    if (!turnIds.length) return [];
    // 目标轮的消息身份只读取一次，避免每个请求重扫整轮；候选筛选不截断轮次统计。
    const rows = this.database.prepare(`WITH selected_turns AS MATERIALIZED (SELECT value AS id FROM json_each(?)),
      selected_messages AS MATERIALIZED (SELECT id FROM session_messages WHERE revision=? AND turn_id IN (SELECT id FROM selected_turns)),
      candidates AS MATERIALIZED (SELECT u.rowid,u.revision,u.message_id,u.turn_id,u.json FROM session_usage u WHERE u.revision=?
        AND (u.turn_id IN (SELECT id FROM selected_turns) OR u.message_id IN (SELECT id FROM selected_messages)
          OR json_extract(u.json,'$.timing.end.messageId') IN (SELECT id FROM selected_messages)
          OR EXISTS (SELECT 1 FROM json_each(u.json,'$.requestMessageIds') member WHERE member.value IN (SELECT id FROM selected_messages))))
      SELECT u.json FROM candidates u WHERE ${this.eligibleUsageWhere()} ORDER BY u.rowid`)
      .all(JSON.stringify(turnIds), revision, revision) as JsonRow[];
    const usages = rows.map(row => decode<SessionUsage>(row));
    const members = this.usageMemberships(revision, usages);
    return usages.map(usage => ({ ...usage, sessionId, ...this.requestBranches(usage, members) }));
  }

  timeline(id: string, requested?: string | SessionTimelineQuery): SessionTimelineResult {
    const query = typeof requested === "string" ? { version: requested } : requested ?? {};
    const version = this.version(query.version);
    const { revision } = this.session(id, version);
    const total = (this.database.prepare("SELECT COUNT(*) AS count FROM session_messages WHERE revision=?").get(revision) as { count: number }).count;
    const maxEvents = query.maxEvents === undefined ? undefined : Math.min(5000, Math.max(1, Math.floor(query.maxEvents)));
    let projection: SessionTimelineResult["projection"];
    if (maxEvents) {
      const projectionRow = this.database.prepare(`SELECT COUNT(DISTINCT CASE WHEN turn_id='' THEN 'unknown' ELSE turn_id END) AS total_turns, MIN(ordinal) AS first_ordinal, MAX(ordinal) AS last_ordinal,
        MIN(session_time_ms(json_extract(json,'$.occurredAt'))) AS time_start, MAX(session_time_ms(json_extract(json,'$.occurredAt'))) AS time_end,
        COALESCE(SUM(CASE WHEN session_time_ms(json_extract(json,'$.occurredAt')) IS NULL THEN 1 ELSE 0 END),0) AS missing_time
        FROM session_messages WHERE revision=?`).get(revision) as { total_turns: number; first_ordinal: number | null; last_ordinal: number | null; time_start: number | null; time_end: number | null; missing_time: number };
      projection = { totalTurns: projectionRow.total_turns, missingTime: projectionRow.missing_time,
        ...(projectionRow.first_ordinal !== null ? { firstOrdinal: projectionRow.first_ordinal, lastOrdinal: projectionRow.last_ordinal! } : {}),
        ...(projectionRow.time_start !== null ? { timeStart: projectionRow.time_start, timeEnd: projectionRow.time_end! } : {}) };
    }
    if (maxEvents && total > maxEvents) {
      const kindCount = (this.database.prepare("SELECT COUNT(DISTINCT kind) AS count FROM session_messages WHERE revision=?").get(revision) as { count: number }).count;
      // 固定桶和类型聚合保留密度；代表点仍使用真实消息身份供点击定位。
      const byKind = maxEvents >= kindCount;
      const buckets = Math.max(1, Math.floor(maxEvents / (byKind ? kindCount : 1)));
      const rows = this.database.prepare(`WITH ranked AS (
        SELECT ${MESSAGE_COLUMNS},ROW_NUMBER() OVER (ORDER BY ordinal,id)-1 AS position,
          FIRST_VALUE(id) OVER (PARTITION BY CASE WHEN turn_id='' THEN 'unknown' ELSE turn_id END ORDER BY ordinal,id) AS turn_first_id,
          MIN(ordinal) OVER (PARTITION BY CASE WHEN turn_id='' THEN 'unknown' ELSE turn_id END) AS turn_start,
          ROW_NUMBER() OVER (PARTITION BY CASE WHEN turn_id='' THEN 'unknown' ELSE turn_id END ORDER BY ordinal,id)-1 AS turn_offset,
          COUNT(*) OVER (PARTITION BY CASE WHEN turn_id='' THEN 'unknown' ELSE turn_id END) AS turn_count FROM session_messages WHERE revision=?
      ), positioned AS (SELECT *,DENSE_RANK() OVER (ORDER BY turn_start,turn_first_id)-1 AS turn_position FROM ranked),
      bucketed AS (SELECT *,MIN(?,CAST(position*?/CAST(? AS REAL) AS INTEGER)) AS bucket FROM positioned), grouped AS (
        SELECT *,COUNT(*) OVER (PARTITION BY bucket${byKind ? ",kind" : ""}) AS count,
          MIN(ordinal) OVER (PARTITION BY bucket${byKind ? ",kind" : ""}) AS range_start,
          MAX(ordinal) OVER (PARTITION BY bucket${byKind ? ",kind" : ""}) AS range_end,
          ROW_NUMBER() OVER (PARTITION BY bucket${byKind ? ",kind" : ""} ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,ordinal,id) AS rank FROM bucketed
      ) SELECT ${MESSAGE_COLUMNS},count,range_start,range_end,turn_position,turn_offset,turn_count,id IN
        (SELECT message_id FROM session_usage WHERE revision=? AND message_id IS NOT NULL) AS has_usage FROM grouped WHERE rank=1 ORDER BY ordinal,id`)
        .all(revision, buckets - 1, buckets, total, query.messageId ?? "", revision) as (MessageMetadataRow & { count: number; range_start: number; range_end: number; has_usage: number; turn_position: number; turn_offset: number; turn_count: number })[];
      const events = rows.map(row => {
        const { branchIds: _branches, currentBranch: _current, filePaths: _paths, resource: _resource, textDescriptor: _descriptor,
          ...message } = decodeMessageMetadata(row);
        const usage = Boolean(row.has_usage);
        return { ...message, usage, count: row.count, rangeStartOrdinal: row.range_start, rangeEndOrdinal: row.range_end,
          turnPosition: row.turn_position, turnOffset: row.turn_offset, turnCount: row.turn_count };
      });
      return { version, events, total, aggregated: true, projection };
    }
    // JSON 投影在 SQLite 内完成，避免把每条消息正文搬进服务或浏览器堆。
    const events = this.database.prepare(`${maxEvents ? `WITH ranked AS (
        SELECT revision,${MESSAGE_COLUMNS},FIRST_VALUE(id) OVER (PARTITION BY CASE WHEN turn_id='' THEN 'unknown' ELSE turn_id END ORDER BY ordinal,id) AS turn_first_id,
          MIN(ordinal) OVER (PARTITION BY CASE WHEN turn_id='' THEN 'unknown' ELSE turn_id END) AS turn_start,
          ROW_NUMBER() OVER (PARTITION BY CASE WHEN turn_id='' THEN 'unknown' ELSE turn_id END ORDER BY ordinal,id)-1 AS turn_offset,
          COUNT(*) OVER (PARTITION BY CASE WHEN turn_id='' THEN 'unknown' ELSE turn_id END) AS turn_count
        FROM session_messages WHERE revision=?), positioned AS (SELECT *,DENSE_RANK() OVER (ORDER BY turn_start,turn_first_id)-1 AS turn_position FROM ranked)` : ""}
      SELECT json_object('id',id,'sessionId',json_extract(json,'$.sessionId'),
      'ordinal',ordinal,'turnId',turn_id,'kind',kind,'occurredAt',json_extract(json,'$.occurredAt'),
      'model',json_extract(json,'$.model'),'callId',call_id,'tool',json_extract(json,'$.tool'),
      'status',json_extract(json,'$.status'),'durationMs',json_extract(json,'$.durationMs'),
      'contextSource',json_extract(json,'$.contextSource'),'copied',copied,'usage',id IN
        (SELECT message_id FROM session_usage WHERE revision=? AND message_id IS NOT NULL)${maxEvents ? ",'turnPosition',turn_position,'turnOffset',turn_offset,'turnCount',turn_count" : ""}) AS json
      FROM ${maxEvents ? "positioned" : "session_messages"} WHERE revision=? ORDER BY ordinal,id`).all(...(maxEvents ? [revision] : []), revision, revision) as JsonRow[];
    return { version, ...(maxEvents ? { total, aggregated: false, projection } : {}), events: events.map(row => {
      const event = Object.fromEntries(Object.entries(decode<SessionTimelineEvent>(row)).filter(([, value]) => value !== null)) as SessionTimelineEvent;
      event.usage = Boolean(event.usage);
      if (event.copied !== undefined) event.copied = Boolean(event.copied);
      return event;
    }) };
  }

  private searchCandidates(query: SessionQuery & { sessionId?: string }, version: string, existence = false) {
    const filter = this.filters(query);
    if (query.sessionId) { filter.sql += " AND v.session_id=?"; filter.values.push(query.sessionId); }
    const selectedKinds = kindsOf(query);
    const common = `FROM session_version_sessions v JOIN session_revisions r ON r.id=v.revision WHERE v.version=?${filter.sql}${this.searchGuard}`;
    const pattern = literal((query.q ?? "").trim());
    const candidate = existence ? undefined : searchCandidateIndex(this.database, (query.q ?? "").trim());
    const match = candidate?.match;
    const filterKinds = candidate?.table === "session_character_search";
    const candidates = match ? ` AND m.rowid IN (SELECT rowid FROM ${candidate!.table} WHERE ${candidate!.table} MATCH ?${this.searchGuard}${filterKinds ? `
      INTERSECT SELECT message_key FROM session_messages WHERE kind IN (${selectedKinds.map(() => "?").join(",") || "NULL"})${this.searchGuard}` : ""})` : "";
    const title = `SELECT v.session_id,NULL AS message_id,NULL AS turn_id,'title' AS kind,r.id AS revision,
      COALESCE(r.updated_at,r.started_at,'') AS updated_at,0 AS ordinal ${common} AND r.title LIKE ? ESCAPE '\\'`;
    let scopedFts = false;
    if (match && (query.client || query.project !== undefined || query.sessionId)) {
      const counts = this.database.prepare(`WITH scoped AS (
        SELECT json_extract(r.json,'$.messageCount') AS message_count
        FROM session_version_sessions v JOIN session_revisions r ON r.id=v.revision
        WHERE v.version=?${filter.sql} LIMIT 101
      ) SELECT COUNT(*) AS sessions,COUNT(message_count) AS known_sessions,
        COALESCE(SUM(message_count),0) AS messages FROM scoped`).get(version, ...filter.values) as {
          sessions: number; known_sessions: number; messages: number;
        };
      // 探测最多 101 条来源元数据；只有不超过 100 个会话且已知消息量不超过 10000 才按修订读取。
      scopedFts = counts.sessions <= 100 && counts.known_sessions === counts.sessions && counts.messages <= 10_000;
    }
    // 全局及宽范围搜索按 FTS rowid 读取命中消息；窄范围先筛活动修订再检查正文。
    const messageFrom = match && scopedFts ? `FROM session_version_sessions v
      CROSS JOIN session_revisions r ON r.id=v.revision
      CROSS JOIN session_messages m INDEXED BY session_message_order ON m.revision=r.id`
      : match ? `FROM session_messages m CROSS JOIN session_version_sessions v ON v.revision=m.revision
        JOIN session_revisions r ON r.id=v.revision` : `FROM session_version_sessions v
        JOIN session_revisions r ON r.id=v.revision JOIN session_messages m ON m.revision=r.id`;
    const messages = `SELECT v.session_id,m.id AS message_id,m.turn_id,m.kind,r.id AS revision,
      COALESCE(r.updated_at,r.started_at,'') AS updated_at,m.ordinal ${messageFrom}
      WHERE v.version=?${filter.sql}${this.searchGuard}${candidates} AND m.kind IN (${selectedKinds.map(() => "?").join(",") || "NULL"})${candidate?.exact ? "" : " AND m.text LIKE ? ESCAPE '\\'"}`;
    const union = `${title} UNION ALL ${messages}`;
    const needle = (query.q ?? "").trim();
    const values = [version, ...filter.values, pattern, version, ...filter.values, ...(match ? [match, ...(filterKinds ? selectedKinds : [])] : []), ...selectedKinds, ...(candidate?.exact ? [] : [pattern])];
    return { union, values, needle };
  }

  groupedSearch(query: SessionQuery = {}): SessionGroupedSearchResult {
    const version = this.version(query.version);
    const { page, pageSize } = paging(query);
    if (!query.q?.trim()) return { version, groups: [], total: 0, hitCount: 0, page, pageSize };
    const { union, values, needle } = this.searchCandidates(query, version);
    // 精简候选只匹配一次；总数、分页与页内代表命中共享同一快照。
    const result = this.database.prepare(`WITH matches AS MATERIALIZED (${union}), grouped AS MATERIALIZED (
      SELECT session_id,COUNT(*) AS match_count,MAX(updated_at) AS updated_at FROM matches GROUP BY session_id
    ), totals AS (SELECT COUNT(*) AS total,COALESCE(SUM(match_count),0) AS hitCount FROM grouped), selected AS (
      SELECT * FROM grouped ORDER BY updated_at DESC,session_id LIMIT ? OFFSET ?
    ), ranked AS (
      SELECT matches.*,selected.match_count,ROW_NUMBER() OVER (PARTITION BY matches.session_id ORDER BY ordinal,message_id) AS rank
      FROM matches JOIN selected ON selected.session_id=matches.session_id
    ), bodies AS MATERIALIZED (
      SELECT ranked.*,r.json,CASE WHEN message_id IS NULL THEN r.title ELSE m.text END AS body FROM ranked
        JOIN session_revisions r ON r.id=ranked.revision LEFT JOIN session_messages m ON m.revision=ranked.revision AND m.id=ranked.message_id WHERE rank<=3
    ) SELECT totals.total,totals.hitCount,bodies.session_id,message_id,turn_id,kind,revision,json,match_count,
      substr(body,MAX(1,instr(lower(body),lower(?))-70),240) AS text,
      length(body) AS text_length,MAX(1,instr(lower(body),lower(?))-70) AS text_start
      FROM totals LEFT JOIN bodies ON 1 ORDER BY updated_at DESC,session_id,rank`)
      .all(...values, pageSize, (page - 1) * pageSize, needle, needle) as (SearchMessageRow & { session_id: string | null;
        total: number; hitCount: number; match_count: number; text: string; text_start: number; text_length: number })[];
    const counts = { total: result[0]!.total, hitCount: result[0]!.hitCount };
    const rows = result.filter((row): row is typeof row & { session_id: string } => row.session_id !== null);
    const briefVisible = this.searchBriefVisible(rows, version);
    const groups: SessionGroupedSearchResult["groups"] = [];
    for (const row of rows) {
      let group = groups.find(item => item.session.id === row.session_id);
      if (!group) { group = { session: this.summary(row, version), matchCount: row.match_count, hits: [] }; groups.push(group); }
      group.hits.push({ session: group.session, messageId: row.message_id ?? undefined, turnId: row.turn_id ?? undefined, kind: row.kind,
        ...(row.message_id ? { briefVisible: briefVisible.get(row.revision)?.has(row.message_id) ?? false } : {}),
        snippet: (row.text_start > 1 ? "…" : "") + row.text + (row.text_length > row.text_start - 1 + 240 ? "…" : "") });
    }
    return { version, groups, ...counts, page, pageSize };
  }

  search(query: SessionQuery & { sessionId?: string } = {}): SessionSearchResult {
    const version = this.version(query.version);
    const { page, pageSize } = paging(query);
    if (!query.q?.trim()) return { version, hits: [], total: 0, page, pageSize };
    const { union, values, needle } = this.searchCandidates(query, version);
    const result = this.database.prepare(`WITH matches AS MATERIALIZED (${union}), totals AS (SELECT COUNT(*) AS total FROM matches), page AS (
      SELECT * FROM matches ORDER BY updated_at DESC,session_id,ordinal,message_id LIMIT ? OFFSET ?
    ), bodies AS MATERIALIZED (
      SELECT page.*,r.json,CASE WHEN page.message_id IS NULL THEN r.title ELSE m.text END AS body FROM page
        JOIN session_revisions r ON r.id=page.revision LEFT JOIN session_messages m ON m.revision=page.revision AND m.id=page.message_id
    ) SELECT totals.total,bodies.session_id,message_id,turn_id,kind,revision,json,
      substr(body,MAX(1,instr(lower(body),lower(?))-70),240) AS text,length(body) AS text_length,
      MAX(1,instr(lower(body),lower(?))-70) AS text_start FROM totals LEFT JOIN bodies ON 1 ORDER BY updated_at DESC,session_id,ordinal,message_id`)
      .all(...values, pageSize, (page - 1) * pageSize, needle, needle) as (SearchMessageRow & { session_id: string | null;
        total: number; text: string; text_start: number; text_length: number })[];
    const total = result[0]!.total;
    const rows = result.filter(row => row.session_id !== null);
    const briefVisible = this.searchBriefVisible(rows, version);
    const hits = rows.map(row => {
      const session = this.summary(row, version);
      return { session, messageId: row.message_id ?? undefined, turnId: row.turn_id ?? undefined, kind: row.kind,
        ...(row.message_id ? { briefVisible: briefVisible.get(row.revision)?.has(row.message_id) ?? false } : {}),
        snippet: (row.text_start > 1 ? "…" : "") + row.text + (row.text_length > row.text_start - 1 + 240 ? "…" : "") };
    });
    return { version, hits, total, page, pageSize };
  }

  locate(input: { client: string; clientSessionId: string; sourceId?: string; recordLine?: number; callId?: string }): { sessionId: string; messageId?: string } | null {
    const version = this.state().version;
    if (!version) return null;
    let row: { session_id: string; id: string } | undefined;
    if (input.sourceId) {
      const candidates = this.database.prepare(`SELECT v.session_id,r.id FROM session_version_sessions v JOIN session_revisions r ON r.id=v.revision
        WHERE v.version=? AND r.client=? AND json_extract(r.json,'$.clientSessionId')=? AND json_extract(r.json,'$.sourceId')=? LIMIT 2`).all(version, input.client, input.clientSessionId, input.sourceId) as { session_id: string; id: string }[];
      if (candidates.length > 1) return null;
      row = candidates[0];
    }
    if (!row) {
      const candidates = this.database.prepare(`SELECT v.session_id,r.id FROM session_version_sessions v JOIN session_revisions r ON r.id=v.revision
        WHERE v.version=? AND r.client=? AND json_extract(r.json,'$.clientSessionId')=? LIMIT 2`).all(version, input.client, input.clientSessionId) as { session_id: string; id: string }[];
      if (candidates.length > 1) return null;
      row = candidates[0];
    }
    if (!row) return null;
    let message: { id: string } | undefined;
    if (input.callId) message = this.database.prepare("SELECT id FROM session_messages WHERE revision=? AND call_id=? ORDER BY ordinal LIMIT 1").get(row.id, input.callId) as { id: string } | undefined;
    if (!message && input.recordLine) message = this.database.prepare("SELECT id FROM session_messages WHERE revision=? AND record_line=? ORDER BY ordinal LIMIT 1").get(row.id, input.recordLine) as { id: string } | undefined;
    return { sessionId: row.session_id, messageId: message?.id };
  }

  profile(id: string, query: SessionProfileQuery = {}): SessionProfile {
    const version = this.version(query.version);
    if (!query.summary && (query.stepLimit !== undefined || query.stepOffset !== undefined)) {
      const summary = this.profile(id, { ...query, version, summary: true });
      const stepsOffset = Math.max(0, Math.floor(query.stepOffset ?? 0));
      const limit = Math.min(2000, Math.max(1, Math.floor(query.stepLimit ?? 200)));
      return { ...summary, steps: this.profileSteps(summary, stepsOffset, limit), stepsOffset };
    }
    const root = this.session(id, version);
    const members = this.database.prepare(`WITH RECURSIVE included(session_id) AS (
      SELECT ? UNION SELECT child FROM session_version_relations relation JOIN included ON relation.parent=included.session_id
      WHERE relation.version=? AND (? OR relation.parent=?)
    ) SELECT v.session_id,v.revision,(SELECT relation.parent FROM session_version_relations relation
      WHERE relation.version=v.version AND relation.child=v.session_id) AS parent FROM included JOIN session_version_sessions v ON v.session_id=included.session_id
      WHERE v.version=? ORDER BY v.session_id`).all(id, version, query.includeChildren ? 1 : 0, id, version);
    // 摘要绑定不可变修订及关系成员；其他会话更新不让相同摘要失效。
    const key = JSON.stringify([root.revision, Boolean(query.includeChildren), members]);
    const cached = query.summary ? this.profileSummaries.get(key) : undefined;
    if (cached) return { ...structuredClone(cached), version };
    const profile = this.buildProfile(id, { ...query, version });
    if (!query.summary) return profile;
    const stepsTotal = profile.steps.length;
    const result = { ...profile, steps: [], stepsTotal, stepsOffset: 0 };
    if (JSON.stringify(result).length <= 256_000) {
      if (this.profileSummaries.size >= 32) this.profileSummaries.delete(this.profileSummaries.keys().next().value!);
      this.profileSummaries.set(key, structuredClone(result));
    }
    return result;
  }

  private profileSteps(profile: SessionProfile, requestedOffset: number, limit: number): SessionProfile["steps"] {
    let offset = requestedOffset;
    const steps: SessionProfile["steps"] = [];
    for (const sessionId of profile.sessionIds) {
      const { revision } = this.session(sessionId, profile.version);
      let count = this.revisionUsageCounts.get(revision);
      if (count === undefined) {
        count = (this.database.prepare(`SELECT COUNT(*) AS count FROM session_usage u WHERE u.revision=? AND ${this.eligibleUsageWhere()}`)
          .get(revision) as { count: number }).count;
        this.cacheUsageCount(revision, count);
      }
      if (offset >= count) { offset -= count; continue; }
      const rows = this.database.prepare(`SELECT u.json FROM session_usage u WHERE u.revision=? AND ${this.eligibleUsageWhere()}
        ORDER BY u.rowid LIMIT ? OFFSET ?`).all(revision, limit - steps.length, offset) as JsonRow[];
      const usages = rows.map(row => decode<SessionUsage>(row));
      const branchMessages = this.usageMemberships(revision, usages);
      for (const usage of usages) steps.push({ ...usage, sessionId, ...this.requestBranches(usage, branchMessages) });
      offset = 0;
      if (steps.length >= limit) break;
    }
    return steps;
  }

  private usageMemberships(revision: string, usages: SessionUsage[]): Map<string, Pick<SessionMessage, "branchIds" | "currentBranch">> {
    const ids = [...new Set(usages.flatMap(usage => [...(usage.requestMessageIds ?? []), ...(usage.messageId ? [usage.messageId] : []),
      ...(usage.timing?.end?.messageId ? [usage.timing.end.messageId] : [])]))];
    const rows = ids.length ? this.database.prepare(`SELECT id,json_extract(json,'$.branchIds') AS branches,
      json_extract(json,'$.currentBranch') AS current FROM session_messages WHERE revision=? AND copied IS NOT 1
      AND id IN (SELECT value FROM json_each(?))`).all(revision, JSON.stringify(ids)) as { id: string; branches: string | null; current: number | null }[] : [];
    return new Map(rows.filter(row => row.branches !== null || row.current !== null)
      .map(row => [row.id, { branchIds: row.branches ? JSON.parse(row.branches) as string[] : undefined,
        currentBranch: row.current === null ? undefined : Boolean(row.current) }]));
  }

  private cacheUsageCount(revision: string, count: number): void {
    if (this.revisionUsageCounts.size >= 4096) this.revisionUsageCounts.delete(this.revisionUsageCounts.keys().next().value!);
    this.revisionUsageCounts.set(revision, count);
  }

  private requestBranches(usage: SessionUsage, messages: Map<string, Pick<SessionMessage, "branchIds" | "currentBranch">>): Pick<SessionMessage, "branchIds" | "currentBranch"> {
    const associations = [...new Set([...(usage.requestMessageIds ?? []), ...(usage.messageId ? [usage.messageId] : []),
      ...(usage.timing?.end?.messageId ? [usage.timing.end.messageId] : [])])].flatMap(id => messages.has(id) ? [messages.get(id)!] : []);
    const memberships = associations.flatMap(message => message.branchIds ? [message.branchIds] : []);
    const branchIds = memberships.length ? memberships[0]!.filter(branch => memberships.every(values => values.includes(branch))) : undefined;
    const currentBranch = associations.some(message => message.currentBranch !== undefined)
      ? associations.every(message => message.currentBranch !== false) : undefined;
    return { ...(branchIds ? { branchIds } : {}), ...(currentBranch !== undefined ? { currentBranch } : {}) };
  }

  private buildProfile(id: string, query: SessionQuery & { includeChildren?: boolean }): SessionProfile {
    const version = this.version(query.version);
    const root = this.session(id, version);
    const getChildren = (parent: string) => (this.database.prepare(`SELECT r.json FROM session_version_relations relation
      JOIN session_version_sessions v ON v.version=relation.version AND v.session_id=relation.child JOIN session_revisions r ON r.id=v.revision
      WHERE relation.version=? AND relation.parent=? ORDER BY v.session_id`)
      .all(version, parent) as JsonRow[]).map(row => this.summary(row, version));
    const directChildren = getChildren(id);
    const included = new Set([id]);
    if (query.includeChildren) {
      const parents = [id];
      for (let index = 0; index < parents.length; index += 1) for (const child of getChildren(parents[index]!)) {
        if (!included.has(child.id)) { included.add(child.id); parents.push(child.id); }
      }
    }
    const profile: SessionProfile = { version, scope: query.includeChildren ? "tree" : "self", sessionIds: [...included], missingChildren: 0,
      messageCount: 0, turnCount: 0, models: [], usage: { requests: 0, inputTokens: null, outputTokens: null, cachedInputTokens: null,
        cacheWriteTokens: null, reasoningOutputTokens: null, cacheReadRatio: null, peakInputTokens: null, peakContextTokens: null, inputRecordedRequests: 0, cacheRecordedRequests: 0, recordedRequests: {} },
      estimate: { method: "留存文本字符数 ÷ 4 向上取整；仅为内容体量估算，非计费用量", methodDescriptor: { key: "sessions.estimate.method" }, total: 0, byKind: [] }, tools: [], resources: [], compressions: 0,
      children: directChildren, steps: [], gaps: [...root.summary.gaps] };
    const models = new Map<string, number>();
    const estimates = new Map<SessionMessage["kind"], number>();
    const tools = new Map<string, SessionProfile["tools"][number]>();
    const resources = new Map<string, SessionProfile["resources"][number]>();
    const turns = new Set<string>();
    const roundMessages: RoundMessage[] = [];
    let pairedInput = 0;
    let pairedCache = 0;
    const sum = (key: "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "reasoningOutputTokens", value: number | undefined) => {
      if (value !== undefined) {
        profile.usage[key] = (profile.usage[key] ?? 0) + value;
        profile.usage.recordedRequests![key] = (profile.usage.recordedRequests![key] ?? 0) + 1;
      }
    };
    for (const sessionId of included) {
      const { revision, summary } = this.session(sessionId, version);
      if (summary.usageReports?.length) (profile.usageReports ??= []).push(...summary.usageReports.map(report => ({ ...report, sessionId })));
      if (summary.contextSnapshots?.length) (profile.contextSnapshots ??= []).push(...summary.contextSnapshots.map(snapshot => ({ ...snapshot, sessionId })));
      if (sessionId !== id) profile.gaps.push(...summary.gaps);
      const confirmedChildren = new Set(getChildren(sessionId).map(child => child.id));
      const missing = new Set(summary.childSessionIds?.filter(child => !confirmedChildren.has(child)) ?? []);
      if (missing.size) {
        profile.missingChildren += missing.size;
        profile.gaps.push({ kind: "unassociated", message: "明确子会话目标缺少来源或父子关联尚未确认，未纳入汇总", messageDescriptor: { key: "diagnostics.sessions.store.m017" }, count: missing.size });
      }
      const retained = this.database.prepare(`SELECT kind,SUM(CAST((length(text)+3)/4 AS INTEGER)) AS tokens
        FROM session_messages WHERE revision=? AND copied IS NOT 1 GROUP BY kind`).all(revision) as { kind: SessionMessage["kind"]; tokens: number }[];
      for (const item of retained) {
        estimates.set(item.kind, (estimates.get(item.kind) ?? 0) + item.tokens);
        profile.estimate.total += item.tokens;
      }
      const replies = sessionId === id ? this.lastReplyIds(revision) : new Set<string>();
      const requestBranches = new Map<string, Pick<SessionMessage, "branchIds" | "currentBranch">>();
      for (const row of this.database.prepare(`SELECT ${MESSAGE_COLUMNS},${sessionId === id ? "CASE WHEN kind='user' THEN text ELSE NULL END" : "NULL"} AS prompt_text
        FROM session_messages WHERE revision=? AND copied IS NOT 1 ORDER BY ordinal,id`).iterate(revision) as Iterable<MessageMetadataRow & { prompt_text: string | null }>) {
        const message = decodeMessageMetadata(row);
        if (sessionId === id && (["user", "assistant", "tool_call", "thinking"].includes(message.kind) || message.interrupted)) {
          roundMessages.push({ ...message, hasReply: replies.has(message.id), ...(row.prompt_text !== null ? { text: row.prompt_text } : {}) });
        }
        if (message.branchIds || message.currentBranch !== undefined) requestBranches.set(message.id, message);
        profile.messageCount += 1;
        if (message.kind === "user" && message.turnId) turns.add(`${sessionId}:${message.turnId}`);
        if (message.model) models.set(message.model, (models.get(message.model) ?? 0) + 1);
        if (message.kind === "compression") profile.compressions += 1;
        if (message.kind === "tool_call") {
          const name = message.tool ?? "未记录工具名称";
          const tool = tools.get(name) ?? { name, calls: 0, success: 0, failure: 0, unknown: 0, durationMs: null };
          tool.calls += 1;
          tool[message.status ?? "unknown"] += 1;
          if (message.durationMs !== undefined) tool.durationMs = (tool.durationMs ?? 0) + message.durationMs;
          tools.set(name, tool);
        }
        if (message.kind === "tool_call" || message.kind === "user" && message.resource?.kind === "skill_read") for (const usage of messageResources(message)) {
          const { path: _resourcePath, ...identity } = usage;
          const key = JSON.stringify(identity);
          const resource = resources.get(key) ?? { ...identity, count: 0 };
          resource.count += 1;
          resources.set(key, resource);
        }
      }
      // 明确请求成员或结束项优先于轮次回退，工具参数请求也能排除复制且保留原创事件。
      const usageRows = this.database.prepare(`SELECT u.json FROM session_usage u WHERE u.revision=? AND ${this.eligibleUsageWhere()} ORDER BY u.rowid`).iterate(revision) as Iterable<JsonRow>;
      let usageCount = 0;
      for (const row of usageRows) {
        usageCount += 1;
        const usage = decode<SessionUsage>(row);
        profile.usage.requests += 1;
        sum("inputTokens", usage.inputTokens); sum("outputTokens", usage.outputTokens); sum("cachedInputTokens", usage.cachedInputTokens);
        sum("cacheWriteTokens", usage.cacheWriteTokens); sum("reasoningOutputTokens", usage.reasoningOutputTokens);
        if (usage.inputTokens !== undefined) {
          profile.usage.inputRecordedRequests += 1;
          if (profile.usage.peakInputTokens === null || usage.inputTokens > profile.usage.peakInputTokens) {
            profile.peakInputRequest = { id: usage.id, messageId: usage.messageId, turnId: usage.turnId, sessionId };
          }
          profile.usage.peakInputTokens = Math.max(profile.usage.peakInputTokens ?? 0, usage.inputTokens);
        }
        if (usage.inputTokens !== undefined && usage.cachedInputTokens !== undefined) {
          profile.usage.cacheRecordedRequests += 1;
          pairedInput += usage.inputTokens; pairedCache += usage.cachedInputTokens;
        }
        if (usage.contextTokens !== undefined) profile.usage.peakContextTokens = Math.max(profile.usage.peakContextTokens ?? 0, usage.contextTokens);
        if (usage.model && !models.has(usage.model)) models.set(usage.model, 0);
        profile.steps.push({ ...usage, sessionId, ...this.requestBranches(usage, requestBranches) });
      }
      this.cacheUsageCount(revision, usageCount);
    }
    profile.outputSpeed = summarizeRequestSpeed(profile.steps);
    profile.roundMetrics = summarizeRoundMetrics(roundMessages, profile.steps.filter(step => step.sessionId === id), completeRoundSource(root.summary.gaps));
    profile.turnCount = turns.size;
    profile.usage.cacheReadRatio = pairedInput > 0 ? pairedCache / pairedInput : null;
    profile.models = [...models].map(([model, count]) => ({ model, count })).sort((left, right) => right.count - left.count || left.model.localeCompare(right.model));
    profile.estimate.byKind = [...estimates].map(([kind, tokens]) => ({ kind, tokens }));
    profile.tools = [...tools.values()].sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));
    profile.resources = [...resources.values()].sort((left, right) => right.count - left.count);
    return profile;
  }
}
