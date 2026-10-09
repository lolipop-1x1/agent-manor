import type { MessageDescriptor } from "../i18n/types.js";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Gap } from "../contracts.js";
import { clientIds } from "../clients.js";
import type { Client } from "../clients.js";
import type { SourceLocation } from "../history/types.js";
import type { ResourceEventStream, ResourceHistoryIdentity, ResourceUsageIdentity, ResourceUsageEvent, ResourceUsageQuery } from "../resource-contracts.js";
import type { SessionGroupedSearchResult, SessionTurnDirectory, SessionIndexStatus, SessionJob, SessionListResult, SessionMessage, SessionMessageQuery, SessionMessageResult, SessionProfile, SessionQuery, SessionRefreshOptions, SessionSearchResult, SessionSink, SessionSourceMeta, SessionSummary, SessionTimelineEvent, SessionTimelineResult, SessionUsage } from "../session-contracts.js";
import { StoreError } from "../index/store.js";
import { summarizeRequestSpeed } from "../session-speed.js";
import { initializeIndexSchema } from "../index/schema.js";
import { resourceGapRelevant } from "../resources/coverage.js";
import { sessionTitle } from "./title.js";
import { initializeSearchIndex, prepareSearchIndex, searchMatch } from "./search-index.js";

interface JsonRow { json: string }
interface MessageMetadataRow extends JsonRow {
  id: string; ordinal: number; record_line: number; turn_id: string; kind: SessionMessage["kind"];
  final: SessionMessage["final"] | null; call_id: string | null; copied: number | null;
}
interface MessageRow extends MessageMetadataRow { text: string }
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
const literal = (value: string) => `%${value.replace(/[\\%_]/g, "\\$&")}%`;
const paging = (query: SessionQuery) => ({ page: Math.max(1, Math.floor(query.page ?? 1)), pageSize: Math.min(200, Math.max(1, Math.floor(query.pageSize ?? 50))) });
const kindsOf = (query: SessionQuery) => (query.kinds?.length ? query.kinds : ["user", "assistant"])
  .filter(kind => ["user", "assistant", "tool_call", "tool_result", "thinking", "system", "context", "compression"].includes(kind));

/** 全局正文按来源修订保存，读者只访问最后完整发布的版本。 */
export class SessionStore {
  readonly dbPath: string;
  private readonly database: Database.Database;

  constructor(dbPath: string) {
    this.dbPath = resolve(dbPath);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.database = new Database(this.dbPath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    try {
      initializeIndexSchema(this.database, () => {
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS session_state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_jobs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_revisions (id TEXT PRIMARY KEY, path TEXT NOT NULL, fingerprint TEXT NOT NULL,
        session_id TEXT, client TEXT, project TEXT, title TEXT, started_at TEXT, updated_at TEXT,
        source_location TEXT, quick_fingerprint TEXT, metadata_fingerprint TEXT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_messages (message_key INTEGER PRIMARY KEY, revision TEXT NOT NULL REFERENCES session_revisions(id) ON DELETE CASCADE,
        id TEXT NOT NULL, ordinal INTEGER NOT NULL, record_line INTEGER NOT NULL, turn_id TEXT NOT NULL, kind TEXT NOT NULL,
        final TEXT, call_id TEXT, copied INTEGER, text TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(revision,id));
      CREATE INDEX IF NOT EXISTS session_message_order ON session_messages(revision,ordinal,id);
      CREATE INDEX IF NOT EXISTS session_message_call ON session_messages(revision,call_id);
      CREATE INDEX IF NOT EXISTS session_message_turn ON session_messages(revision,turn_id,ordinal,id);
      CREATE INDEX IF NOT EXISTS session_message_resource_event_v2
        ON session_messages(revision,json_extract(json,'$.resource.kind'),ordinal,id)
        WHERE kind IN ('tool_call','user') AND copied IS NOT 1 AND json_extract(json,'$.resource.kind') IN ('mcp','skill_call','skill_read');
      CREATE INDEX IF NOT EXISTS session_message_resource_call ON session_messages(revision,call_id,kind,copied)
        WHERE kind='tool_call' AND copied IS NOT 1;
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
    `);
        this.database.prepare("INSERT OR IGNORE INTO session_state(id,json) VALUES(1,?)").run(JSON.stringify({ stale: false }));
        initializeSearchIndex(this.database);
      });
    } catch (error) { this.database.close(); throw error; }
  }

  close(): void { this.database.close(); }

  prepareSearchIndex(onProgress?: (progress: number) => void): Promise<void> { return prepareSearchIndex(this.database, onProgress); }

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
    const result: SessionIndexStatus = { ...state, stale: state.stale ?? false, sessionCount: 0, sourceCount: 0, gaps: state.gaps ?? [], projects: [] };
    if (state.version) {
      result.sessionCount = (this.database.prepare("SELECT COUNT(*) AS count FROM session_version_sessions WHERE version=?").get(state.version) as { count: number }).count;
      result.sourceCount = (this.database.prepare("SELECT COUNT(*) AS count FROM session_version_sources WHERE version=?").get(state.version) as { count: number }).count;
      result.projects = (this.database.prepare(`SELECT DISTINCT r.project FROM session_version_sessions v JOIN session_revisions r ON r.id=v.revision
        WHERE v.version=? AND r.project IS NOT NULL ORDER BY r.project`).all(state.version) as { project: string }[]).map(row => row.project);
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
    const rows = this.database.prepare(`SELECT r.path,r.id AS revision,r.fingerprint,r.client,r.source_location,r.quick_fingerprint,r.metadata_fingerprint
      FROM session_version_sources v JOIN session_revisions r ON r.id=v.revision WHERE v.version=?`).all(version) as
      (SessionRevision & { source_location: string | null; quick_fingerprint: string | null; metadata_fingerprint: string | null })[];
    return rows.map(({ source_location, quick_fingerprint, metadata_fingerprint, ...revision }) => ({ ...revision,
      location: source_location ? JSON.parse(source_location) as SourceLocation : undefined,
      quickFingerprint: quick_fingerprint ?? undefined, metadataFingerprint: metadata_fingerprint ?? undefined }));
  }

  createRevision(path: string, fingerprint: string): { revision: string; sink: SessionSink; flush: () => void } {
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
      message: value => { pending.push({ type: "message", value }); bytes += value.text.length * 2; if (pending.length >= 200 || bytes >= 2_000_000) flush(); },
      usage: value => { pending.push({ type: "usage", value }); if (pending.length >= 200) flush(); },
    };
    return { revision, sink, flush };
  }

  finishRevision(id: string, meta: SessionSourceMeta): void {
    const counts = this.database.prepare("SELECT COUNT(*) AS messages,COUNT(DISTINCT CASE WHEN kind='user' THEN turn_id END) AS turns FROM session_messages WHERE revision=?").get(id) as { messages: number; turns: number };
    const summary = sessionTitle({ ...meta, messageCount: counts.messages, turnCount: counts.turns });
    this.database.prepare("UPDATE session_revisions SET session_id=?,client=?,project=?,title=?,started_at=?,updated_at=?,json=? WHERE id=?")
      .run(meta.id, meta.client, meta.project ?? null, summary.title, meta.startedAt ?? null, meta.updatedAt ?? null, JSON.stringify(summary), id);
  }

  removeRevision(id: string): void { this.database.prepare("DELETE FROM session_revisions WHERE id=?").run(id); }

  private removeUnpublishedRevisions(): void {
    this.database.prepare("DELETE FROM session_revisions WHERE id NOT IN (SELECT revision FROM session_version_sources)").run();
  }

  publish(jobId: string, revisions: SessionRevision[], gaps: Gap[]): string {
    const version = randomUUID();
    const createdAt = new Date().toISOString();
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO session_versions(id,created_at,gaps) VALUES(?,?,?)").run(version, createdAt, "[]");
      const addSource = this.database.prepare("INSERT INTO session_version_sources(version,path,revision) VALUES(?,?,?)");
      const saveCheck = this.database.prepare(`UPDATE session_revisions SET source_location=?,quick_fingerprint=?,metadata_fingerprint=?
        WHERE id=? AND (source_location IS NOT ? OR quick_fingerprint IS NOT ? OR metadata_fingerprint IS NOT ?)`);
      for (const item of revisions) {
        addSource.run(version, item.path, item.revision);
        const location = item.location ? JSON.stringify(item.location) : null;
        const quick = item.quickFingerprint ?? null;
        const metadata = item.metadataFingerprint ?? null;
        saveCheck.run(location, quick, metadata, item.revision, location, quick, metadata);
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
      const job = this.getJob(jobId);
      const checkedClients = job.client ? [job.client] : clientIds;
      const clientChecks = new Map((state.clientChecks ?? []).map(check => [check.client, check]));
      for (const client of checkedClients) clientChecks.set(client, { client, checkedAt: createdAt, mode: job.mode ?? "quick" });
      this.saveState({ version, previousVersion, createdAt, stale: false, gaps: publishedGaps, clientChecks: [...clientChecks.values()] });
      this.updateJob(jobId, { status: "complete", phase: "complete", phaseDescriptor: { key: "diagnostics.sessions.store.m008" }, progress: 1, version, finishedAt: createdAt });
      this.database.prepare("DELETE FROM session_versions WHERE id<>? AND id<>?").run(version, previousVersion ?? version);
      this.removeUnpublishedRevisions();
    })();
    return version;
  }

  private version(requested?: string): string {
    const version = requested ?? this.currentVersion();
    if (!version) throw new StoreError("ANALYSIS_NOT_READY", "会话索引尚未完成", { key: "diagnostics.sessions.store.m009" });
    if (!this.database.prepare("SELECT 1 FROM session_versions WHERE id=?").get(version)) throw new StoreError("VERSION_NOT_FOUND", "会话索引版本不存在", { key: "diagnostics.sessions.store.m010" });
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

  /** 资源查询只读取已发布调用的元信息；配对命中调用索引，不读取消息正文。 */
  resourceEvents(query: ResourceUsageQuery = {}, identity?: ResourceHistoryIdentity | ResourceUsageIdentity): ResourceEventStream {
    const version = this.version(query.version);
    const parts = ["v.version=?"];
    const values: SqlValue[] = [version];
    for (const [column, value] of [["r.client", query.client ?? identity?.client], ["r.project", query.project ?? identity?.project]] as const) {
      if (column === "r.project" && value === "none") parts.push("r.project IS NULL");
      else if (value !== undefined) { parts.push(`${column}=?`); values.push(value); }
    }
    if (identity?.client !== undefined && identity.project === undefined) parts.push("r.project IS NULL");
    const sessionFilter = parts.join(" AND ");
    const sessionCount = (this.database.prepare(`SELECT COUNT(*) AS count FROM session_version_sessions v
      JOIN session_revisions r ON r.id=v.revision WHERE ${sessionFilter}`).get(...values) as { count: number }).count;
    const clients = (this.database.prepare(`SELECT DISTINCT r.client FROM session_version_sessions v
      JOIN session_revisions r ON r.id=v.revision WHERE ${sessionFilter} ORDER BY r.client`).all(...values) as { client: Client }[]).map(row => row.client);
    const kind = query.kind ?? identity?.kind;
    if (kind) parts.push(kind === "mcp" ? "json_extract(m.json,'$.resource.kind')='mcp'" : "json_extract(m.json,'$.resource.kind') IN ('skill_call','skill_read')");
    if (identity) {
      parts.push(identity.kind === "mcp" ? "json_extract(m.json,'$.resource.server') IS ?" : "json_extract(m.json,'$.resource.name')=?");
      if (identity.kind === "mcp" && identity.server === undefined) {
        parts[parts.length - 1] = "json_extract(m.json,'$.resource.server') IS NULL";
      } else values.push(identity.kind === "mcp" ? identity.server! : identity.name);
    }
    const rows = this.database.prepare(`SELECT m.id AS message_id,m.ordinal,m.turn_id,m.record_line,r.session_id,r.client,r.project,
      r.id AS revision,r.fingerprint,json_extract(r.json,'$.path') AS source_path,json_extract(r.json,'$.sourceId') AS source_id,
      json_extract(m.json,'$.resource.kind') AS resource_kind,json_extract(m.json,'$.resource.name') AS resource_name,
      json_extract(m.json,'$.resource.nameDescriptor') AS resource_name_descriptor,
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
        resource_name: string | null; resource_name_descriptor: string | null; resource_server: string | null; resource_path: string | null; file_paths: string | null;
        tool: string | null; occurred_at: string | null; status: ResourceUsageEvent["status"]; duration_ms: number | null;
        result_id: string | null; result_count: number; call_count: number;
      }>;
    const events = (function* (): Iterable<ResourceUsageEvent> {
      for (const row of rows) {
        const paths = row.file_paths ? JSON.parse(row.file_paths) as string[] : [];
        const skillPath = paths.find(path => /(?:^|[/\\])SKILL\.md$/.test(path));
        const path = row.resource_path ?? (row.resource_kind === "mcp" ? undefined : skillPath
          ?? (row.resource_kind === "skill_call" ? paths[0] : undefined));
        yield { id: `${row.session_id}:${row.message_id}`, sessionId: row.session_id, messageId: row.message_id,
          turnId: row.turn_id, ordinal: row.ordinal, client: row.client, project: row.project ?? undefined,
          kind: row.resource_kind, name: row.resource_name ?? "未记录名称",
          ...(row.resource_name_descriptor ? { nameDescriptor: JSON.parse(row.resource_name_descriptor) } : {}), server: row.resource_server ?? undefined,
          path, tool: row.tool ?? undefined, occurredAt: row.occurred_at ?? undefined,
          status: row.status === "success" || row.status === "failure" ? row.status : "unknown",
          durationMs: typeof row.duration_ms === "number" && Number.isFinite(row.duration_ms) && row.duration_ms >= 0 ? row.duration_ms : undefined,
          resultMessageId: row.result_id ?? undefined,
          pairing: row.call_count > 1 || row.result_count > 1 ? "ambiguous" : row.result_id ? "unique" : "missing",
          source: { path: row.source_path, sourceId: row.source_id, revision: row.revision, fingerprint: row.fingerprint, recordLine: row.record_line } };
      }
    })();
    const allGaps = JSON.parse((this.database.prepare("SELECT gaps FROM session_versions WHERE id=?").get(version) as { gaps: string }).gaps) as Gap[];
    const sourceIds = [...new Set(allGaps.flatMap(gap => gap.sourceId ?? []))];
    const sourceClients = new Map<string, Set<Client>>();
    if (sourceIds.length) {
      const wanted = new Set(sourceIds);
      const records = this.database.prepare("SELECT DISTINCT json_extract(json,'$.sourceId') AS source_id,client FROM session_revisions").all() as { source_id: string; client: Client }[];
      for (const record of records) if (wanted.has(record.source_id)) {
        let related = sourceClients.get(record.source_id);
        if (!related) { related = new Set(); sourceClients.set(record.source_id, related); }
        related.add(record.client);
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

  list(query: SessionQuery = {}, sessionId?: string): SessionListResult {
    const version = this.version(query.version);
    const { page, pageSize } = paging(query);
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
      const match = searchMatch(this.database, (query.q ?? "").trim());
      const candidates = match ? "m.rowid IN (SELECT rowid FROM session_message_search WHERE session_message_search MATCH ?) AND " : "";
      const body = `m.kind IN (${kinds.map(() => "?").join(",") || "NULL"}) AND m.text LIKE ? ESCAPE '\\'`;
      const matched = match ? `r.id IN (SELECT m.revision FROM session_messages m WHERE ${candidates}${body})`
        : `EXISTS(SELECT 1 FROM session_messages m WHERE m.revision=r.id AND ${body})`;
      filter.sql += ` AND (r.title LIKE ? ESCAPE '\\' OR ${matched})`;
      filter.values.push(literal((query.q ?? "").trim()), ...(match ? [match] : []), ...kinds, literal((query.q ?? "").trim()));
    }
    const from = `FROM session_version_sessions v JOIN session_revisions r ON r.id=v.revision WHERE v.version=?${filter.sql}`;
    const total = (this.database.prepare(`SELECT COUNT(*) AS count ${from}`).get(version, ...filter.values) as { count: number }).count;
    const rows = this.database.prepare(`SELECT r.json ${from} ORDER BY COALESCE(r.updated_at,r.started_at,'') DESC,v.session_id ASC LIMIT ? OFFSET ?`)
      .all(version, ...filter.values, pageSize, (page - 1) * pageSize) as JsonRow[];
    const sessions = rows.map(row => this.summary(row, version));
    return { version, sessions, total, page, pageSize };
  }

  private readingScope(revision: string, session: SessionSummary, query: SessionMessageQuery) {
    let branch = "";
    const values: SqlValue[] = [revision];
    if (query.branch && query.branch !== "all" && query.branch !== "current") {
      if (!session.branches?.some(item => item.id === query.branch)) throw new StoreError("INVALID_INPUT", "会话分支不存在", { key: "diagnostics.sessions.store.m012" });
      branch = " AND (json_extract(json,'$.branchIds') IS NULL OR EXISTS (SELECT 1 FROM json_each(session_messages.json,'$.branchIds') WHERE value=?))";
      values.push(query.branch);
    } else if (query.branch === "current" || !query.branch && query.mode === "brief") {
      branch = " AND COALESCE(json_extract(json,'$.currentBranch'),1)=1";
    }
    if (query.mode !== "brief") return { values, cte: `WITH scoped AS MATERIALIZED (
      SELECT id,ordinal,CASE WHEN turn_id='' THEN 'unknown' ELSE turn_id END AS turn_id,kind,final FROM session_messages WHERE revision=?${branch}
    ), visible AS (SELECT * FROM scoped)` };
    // 只计算元信息和正文是否为空；跨轮分页后才取正文。兜底不会写回 final。
    const cte = `WITH scoped AS MATERIALIZED (
      SELECT id,ordinal,CASE WHEN turn_id='' THEN 'unknown' ELSE turn_id END AS turn_id,kind,final,
        CASE WHEN kind='assistant' AND length(trim(text,char(9)||char(10)||char(13)||' '))>0 THEN 1 ELSE 0 END AS has_body
      FROM session_messages WHERE revision=?${branch}
    ), ranked AS (
      SELECT *,SUM(CASE WHEN kind='assistant' AND final IS NOT NULL THEN 1 ELSE 0 END) OVER (PARTITION BY turn_id) AS finals,
        ROW_NUMBER() OVER (PARTITION BY turn_id,kind ORDER BY has_body DESC,ordinal DESC,id DESC) AS answer_rank FROM scoped
    ), visible AS (
      SELECT * FROM ranked ${query.mode === "brief" ? "WHERE kind='user' OR (kind='assistant' AND (final IS NOT NULL OR (finals=0 AND has_body=1 AND answer_rank=1)))" : ""}
    )`;
    return { cte, values };
  }

  matches(id: string, query: SessionQuery = {}): { version: string; matches: boolean } {
    const result = query.q?.trim() ? this.search({ ...query, sessionId: id, pageSize: 1 }) : this.list({ ...query, pageSize: 1 }, id);
    return { version: result.version, matches: result.total > 0 };
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
    const turns = this.database.prepare(`${groups} SELECT id,position,COALESCE((SELECT substr(text,1,160) FROM session_messages m
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
      for (const [key, value] of [["kind", query.resourceKind], ["name", query.resourceName], ["server", query.resourceServer]] as const) {
        if (value) { targetParts.push(`json_extract(json,'$.resource.${key}')=?`); targetValues.push(value); }
      }
    }
    const target = targetParts.length ? this.database.prepare(`${cte} SELECT ordinal,id,turn_id,kind,final FROM session_messages
      WHERE revision=? AND id IN (SELECT id FROM scoped) AND ${targetParts.join(" AND ")} ORDER BY ordinal,id LIMIT 1`).get(...values, revision, ...targetValues) as
      { ordinal: number; id: string; turn_id: string; kind: string; final: string | null } | undefined : undefined;
    if (!target && targetParts.length && (!query.messageId || query.pageUnit === "turn")) throw new StoreError("SOURCE_NOT_FOUND", "定位消息不存在于当前会话", { key: "diagnostics.sessions.store.m013" });
    if (target && !this.database.prepare(`${cte} SELECT 1 FROM visible WHERE id=?`).get(...values, target.id)) {
      throw new StoreError("INVALID_INPUT", "定位消息不在简易视图中，请切换完整或轨迹视图", { key: "diagnostics.sessions.store.m014" });
    }
    const project = (rows: MessageRow[]) => rows.map(row => {
      const message = decodeMessage(row);
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
      const messages = turns.length ? project(this.database.prepare(`${cte} SELECT ${MESSAGE_COLUMNS},text FROM session_messages
        WHERE revision=? AND id IN (SELECT id FROM visible WHERE turn_id IN (${turnIds.map(() => "?").join(",")})) ORDER BY ordinal,id`)
        .all(...values, revision, ...turnIds) as MessageRow[]) : [];
      return { version, session, messages, total, ...pagination, pageUnit: "turn", totalTurns, turns, focusMessageId: target?.id };
    }
    if (query.turnPosition !== undefined) throw new StoreError("INVALID_INPUT", "turnPosition 仅支持完整轮次分页", { key: "diagnostics.sessions.store.m016" });
    if (target) {
      const preceding = (this.database.prepare(`${cte} SELECT COUNT(*) AS count FROM visible WHERE ordinal<? OR (ordinal=? AND id<?)`)
        .get(...values, target.ordinal, target.ordinal, target.id) as { count: number }).count;
      pagination.page = Math.floor(preceding / pagination.pageSize) + 1;
    }
    const total = (this.database.prepare(`${cte} SELECT COUNT(*) AS count FROM visible`).get(...values) as { count: number }).count;
    const messages = project(this.database.prepare(`${cte} SELECT ${MESSAGE_COLUMNS},text FROM session_messages
      WHERE revision=? AND id IN (SELECT id FROM visible ORDER BY ordinal,id LIMIT ? OFFSET ?) ORDER BY ordinal,id`)
      .all(...values, revision, pagination.pageSize, (pagination.page - 1) * pagination.pageSize) as MessageRow[]);
    return { version, session, messages, total, ...pagination, focusMessageId: target?.id };
  }

  timeline(id: string, requestedVersion?: string): SessionTimelineResult {
    const version = this.version(requestedVersion);
    const { revision } = this.session(id, version);
    // JSON 投影在 SQLite 内完成，避免把每条消息正文搬进服务或浏览器堆。
    const events = this.database.prepare(`SELECT json_object('id',id,'sessionId',json_extract(json,'$.sessionId'),
      'ordinal',ordinal,'turnId',turn_id,'kind',kind,'occurredAt',json_extract(json,'$.occurredAt'),
      'model',json_extract(json,'$.model'),'callId',call_id,'tool',json_extract(json,'$.tool'),
      'status',json_extract(json,'$.status'),'durationMs',json_extract(json,'$.durationMs'),
      'contextSource',json_extract(json,'$.contextSource'),'copied',copied,'usage',id IN
        (SELECT message_id FROM session_usage WHERE revision=? AND message_id IS NOT NULL)) AS json
      FROM session_messages WHERE revision=? ORDER BY ordinal,id`).all(revision, revision) as JsonRow[];
    return { version, events: events.map(row => {
      const event = Object.fromEntries(Object.entries(decode<SessionTimelineEvent>(row)).filter(([, value]) => value !== null)) as SessionTimelineEvent;
      event.usage = Boolean(event.usage);
      if (event.copied !== undefined) event.copied = Boolean(event.copied);
      return event;
    }) };
  }

  private searchCandidates(query: SessionQuery & { sessionId?: string }, version: string) {
    const filter = this.filters(query);
    if (query.sessionId) { filter.sql += " AND v.session_id=?"; filter.values.push(query.sessionId); }
    const selectedKinds = kindsOf(query);
    const common = `FROM session_version_sessions v JOIN session_revisions r ON r.id=v.revision WHERE v.version=?${filter.sql}`;
    const pattern = literal((query.q ?? "").trim());
    const match = searchMatch(this.database, (query.q ?? "").trim());
    const candidates = match ? " AND m.rowid IN (SELECT rowid FROM session_message_search WHERE session_message_search MATCH ?)" : "";
    const title = `SELECT v.session_id,NULL AS message_id,NULL AS turn_id,'title' AS kind,r.id AS revision,
      r.json,COALESCE(r.updated_at,r.started_at,'') AS updated_at,0 AS ordinal ${common} AND r.title LIKE ? ESCAPE '\\'`;
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
      r.json,COALESCE(r.updated_at,r.started_at,'') AS updated_at,m.ordinal ${messageFrom}
      WHERE v.version=?${filter.sql}${candidates} AND m.kind IN (${selectedKinds.map(() => "?").join(",") || "NULL"}) AND m.text LIKE ? ESCAPE '\\'`;
    const union = `${title} UNION ALL ${messages}`;
    const needle = (query.q ?? "").trim();
    const values = [version, ...filter.values, pattern, version, ...filter.values, ...(match ? [match] : []), ...selectedKinds, pattern];
    return { union, values, needle };
  }

  groupedSearch(query: SessionQuery = {}): SessionGroupedSearchResult {
    const version = this.version(query.version);
    const { page, pageSize } = paging(query);
    if (!query.q?.trim()) return { version, groups: [], total: 0, hitCount: 0, page, pageSize };
    const { union, values, needle } = this.searchCandidates(query, version);
    const counts = this.database.prepare(`SELECT COUNT(DISTINCT session_id) AS total,COUNT(*) AS hitCount FROM (${union})`)
      .get(...values) as { total: number; hitCount: number };
    // 以会话分页，代表片段只取当前页的前三条，展开时复用记录级查询。
    const rows = this.database.prepare(`WITH matches AS MATERIALIZED (${union}), selected AS (
      SELECT session_id,COUNT(*) AS match_count FROM matches GROUP BY session_id ORDER BY MAX(updated_at) DESC,session_id LIMIT ? OFFSET ?
    ), ranked AS (
      SELECT matches.*,selected.match_count,ROW_NUMBER() OVER (PARTITION BY matches.session_id ORDER BY ordinal,message_id) AS rank
      FROM matches JOIN selected ON selected.session_id=matches.session_id
    ), bodies AS (
      SELECT ranked.*,CASE WHEN message_id IS NULL THEN r.title ELSE m.text END AS body FROM ranked
        JOIN session_revisions r ON r.id=ranked.revision LEFT JOIN session_messages m ON m.revision=ranked.revision AND m.id=ranked.message_id WHERE rank<=3
    ) SELECT *,substr(body,MAX(1,instr(lower(body),lower(?))-70),240) AS text,
      length(body) AS text_length,MAX(1,instr(lower(body),lower(?))-70) AS text_start FROM bodies ORDER BY updated_at DESC,session_id,rank`)
      .all(...values, pageSize, (page - 1) * pageSize, needle, needle) as (JsonRow & { session_id: string; message_id?: string; turn_id?: string;
        kind: SessionSearchResult["hits"][number]["kind"]; match_count: number; text: string; text_start: number; text_length: number })[];
    const groups: SessionGroupedSearchResult["groups"] = [];
    for (const row of rows) {
      let group = groups.find(item => item.session.id === row.session_id);
      if (!group) { group = { session: this.summary(row, version), matchCount: row.match_count, hits: [] }; groups.push(group); }
      group.hits.push({ session: group.session, messageId: row.message_id ?? undefined, turnId: row.turn_id ?? undefined, kind: row.kind,
        snippet: (row.text_start > 1 ? "…" : "") + row.text + (row.text_length > row.text_start - 1 + 240 ? "…" : "") });
    }
    return { version, groups, ...counts, page, pageSize };
  }

  search(query: SessionQuery & { sessionId?: string } = {}): SessionSearchResult {
    const version = this.version(query.version);
    const { page, pageSize } = paging(query);
    if (!query.q?.trim()) return { version, hits: [], total: 0, page, pageSize };
    const { union, values, needle } = this.searchCandidates(query, version);
    const total = (this.database.prepare(`SELECT COUNT(*) AS count FROM (${union})`).get(...values) as { count: number }).count;
    // 先选出当前页，避免为全部命中正文计算摘要和大小写转换。
    const rows = this.database.prepare(`WITH page AS MATERIALIZED (
      SELECT * FROM (${union}) ORDER BY updated_at DESC,session_id,ordinal,message_id LIMIT ? OFFSET ?
    ), bodies AS MATERIALIZED (
      SELECT page.*,CASE WHEN page.message_id IS NULL THEN r.title ELSE m.text END AS body FROM page
        JOIN session_revisions r ON r.id=page.revision LEFT JOIN session_messages m ON m.revision=page.revision AND m.id=page.message_id
    ) SELECT session_id,message_id,turn_id,kind,json,substr(body,MAX(1,instr(lower(body),lower(?))-70),240) AS text,length(body) AS text_length,
      MAX(1,instr(lower(body),lower(?))-70) AS text_start FROM bodies ORDER BY updated_at DESC,session_id,ordinal,message_id`)
      .all(...values, pageSize, (page - 1) * pageSize, needle, needle) as (JsonRow & { message_id?: string; turn_id?: string; kind: SessionSearchResult["hits"][number]["kind"]; text: string; text_start: number; text_length: number })[];
    const hits = rows.map(row => {
      const session = this.summary(row, version);
      return { session, messageId: row.message_id ?? undefined, turnId: row.turn_id ?? undefined, kind: row.kind,
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
        WHERE v.version=? AND r.client=? AND json_extract(r.json,'$.sourceId')=? LIMIT 2`).all(version, input.client, input.sourceId) as { session_id: string; id: string }[];
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

  profile(id: string, query: SessionQuery & { includeChildren?: boolean } = {}): SessionProfile {
    return this.buildProfile(id, query);
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
        cacheWriteTokens: null, reasoningOutputTokens: null, cacheReadRatio: null, peakInputTokens: null, peakContextTokens: null, inputRecordedRequests: 0, cacheRecordedRequests: 0 },
      estimate: { method: "留存文本字符数 ÷ 4 向上取整；仅为内容体量估算，非计费用量", methodDescriptor: { key: "sessions.estimate.method" }, total: 0, byKind: [] }, tools: [], resources: [], compressions: 0,
      children: directChildren, steps: [], gaps: [...root.summary.gaps] };
    const models = new Map<string, number>();
    const estimates = new Map<SessionMessage["kind"], number>();
    const tools = new Map<string, SessionProfile["tools"][number]>();
    const resources = new Map<string, SessionProfile["resources"][number]>();
    const turns = new Set<string>();
    let pairedInput = 0;
    let pairedCache = 0;
    const sum = (key: "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "reasoningOutputTokens", value: number | undefined) => {
      if (value !== undefined) profile.usage[key] = (profile.usage[key] ?? 0) + value;
    };
    for (const sessionId of included) {
      const { revision, summary } = this.session(sessionId, version);
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
      const requestBranches = new Map<string, Pick<SessionMessage, "branchIds" | "currentBranch">>();
      for (const row of this.database.prepare(`SELECT ${MESSAGE_COLUMNS} FROM session_messages WHERE revision=? AND copied IS NOT 1 ORDER BY ordinal,id`).iterate(revision) as Iterable<MessageMetadataRow>) {
        const message = decodeMessageMetadata(row);
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
        if ((message.kind === "tool_call" || message.kind === "user" && message.resource?.kind === "skill_read") && message.resource) {
          const { path: _resourcePath, ...identity } = message.resource;
          const key = JSON.stringify(identity);
          const resource = resources.get(key) ?? { ...identity, count: 0 };
          resource.count += 1;
          resources.set(key, resource);
        }
      }
      // 明确请求成员或结束项优先于轮次回退，工具参数请求也能排除复制且保留原创事件。
      const usageRows = this.database.prepare(`SELECT u.json FROM session_usage u WHERE u.revision=? AND NOT EXISTS
        (SELECT 1 FROM session_messages m WHERE m.revision=u.revision AND m.copied=1 AND m.id=u.message_id)
        AND (u.message_id IS NOT NULL OR
          ((json_array_length(u.json,'$.requestMessageIds')>0 OR json_extract(u.json,'$.timing.end.messageId') IS NOT NULL) AND NOT EXISTS
            (SELECT 1 FROM session_messages m WHERE m.revision=u.revision AND m.copied=1 AND m.id IN
              (SELECT value FROM json_each(u.json,'$.requestMessageIds') UNION SELECT json_extract(u.json,'$.timing.end.messageId')))) OR
          (COALESCE(json_array_length(u.json,'$.requestMessageIds'),0)=0 AND json_extract(u.json,'$.timing.end.messageId') IS NULL AND NOT EXISTS
            (SELECT 1 FROM session_messages m WHERE m.revision=u.revision AND m.copied=1 AND m.turn_id=u.turn_id))) ORDER BY u.rowid`).iterate(revision) as Iterable<JsonRow>;
      for (const row of usageRows) {
        const usage = decode<SessionUsage>(row);
        profile.usage.requests += 1;
        sum("inputTokens", usage.inputTokens); sum("outputTokens", usage.outputTokens); sum("cachedInputTokens", usage.cachedInputTokens);
        sum("cacheWriteTokens", usage.cacheWriteTokens); sum("reasoningOutputTokens", usage.reasoningOutputTokens);
        if (usage.inputTokens !== undefined) {
          profile.usage.inputRecordedRequests += 1;
          profile.usage.peakInputTokens = Math.max(profile.usage.peakInputTokens ?? 0, usage.inputTokens);
        }
        if (usage.inputTokens !== undefined && usage.cachedInputTokens !== undefined) {
          profile.usage.cacheRecordedRequests += 1;
          pairedInput += usage.inputTokens; pairedCache += usage.cachedInputTokens;
        }
        if (usage.contextTokens !== undefined) profile.usage.peakContextTokens = Math.max(profile.usage.peakContextTokens ?? 0, usage.contextTokens);
        if (usage.model && !models.has(usage.model)) models.set(usage.model, 0);
        const associations = [...new Set([...(usage.requestMessageIds ?? []), ...(usage.messageId ? [usage.messageId] : []),
          ...(usage.timing?.end?.messageId ? [usage.timing.end.messageId] : [])])]
          .flatMap(messageId => requestBranches.has(messageId) ? [requestBranches.get(messageId)!] : []);
        const memberships = associations.flatMap(message => message.branchIds ? [message.branchIds] : []);
        const branchIds = memberships.length ? memberships[0]!.filter(branch => memberships.every(values => values.includes(branch))) : undefined;
        const currentBranch = associations.some(message => message.currentBranch !== undefined)
          ? associations.every(message => message.currentBranch !== false) : undefined;
        profile.steps.push({ ...usage, sessionId, ...(branchIds ? { branchIds } : {}), ...(currentBranch !== undefined ? { currentBranch } : {}) });
      }
    }
    profile.outputSpeed = summarizeRequestSpeed(profile.steps);
    profile.turnCount = turns.size;
    profile.usage.cacheReadRatio = pairedInput > 0 ? pairedCache / pairedInput : null;
    profile.models = [...models].map(([model, count]) => ({ model, count })).sort((left, right) => right.count - left.count || left.model.localeCompare(right.model));
    profile.estimate.byKind = [...estimates].map(([kind, tokens]) => ({ kind, tokens }));
    profile.tools = [...tools.values()].sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));
    profile.resources = [...resources.values()].sort((left, right) => right.count - left.count);
    return profile;
  }
}
