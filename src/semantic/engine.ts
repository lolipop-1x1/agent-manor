import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { Client } from "../clients.js";
import type { SessionMessage, SessionSourceMeta } from "../session-contracts.js";
import type { SemanticConfig, SemanticEngineStats, SemanticInput, SemanticPreview, SemanticScope, SemanticSearchQuery, SemanticSearchResult, SemanticVector } from "../semantic-contracts.js";
import { searchScopeFilter } from "../sessions/search-scope.js";
import { encodingFingerprint } from "./config.js";
import { buildDocuments, isSemanticTurnKnown, sourceMessageHash, splitDocument } from "./documents.js";
import type { SemanticDocument } from "./documents.js";
import { semanticErrorDescriptor } from "./messages.js";
import { sessionTitle } from "../sessions/title.js";

export class SemanticEngineError extends Error {
  get messageDescriptor() { return semanticErrorDescriptor(this.code); }
  constructor(public readonly code: string, message: string) { super(message); this.name = "SemanticEngineError"; }
}
interface Plan { id: string; version: string; fingerprint: string; config: string; created_at: string; published: number }
interface Filter { sql: string; values: (string | number)[] }

/** 时间仅约束本次筛选，不把维护窗口隐式带入搜索。 */
function timeBounds(scope: SemanticScope, now = new Date()): { from?: string; to?: string } {
  let from = scope.from;
  if (!from && scope.timeRange === "recent") {
    const date = new Date(now); date.setDate(date.getDate() - Math.max(1, scope.recentDays) + 1); date.setHours(0, 0, 0, 0);
    from = date.toISOString();
  }
  return { from, to: scope.to };
}
function filterScope(scope: SemanticScope, now = new Date()): Filter {
  const { clauses, values } = searchScopeFilter({ ...scope, ...timeBounds(scope, now) });
  return { sql: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", values };
}

export class SemanticEngine {
  private readonly database: Database.Database;
  private readonly sourceDatabase: Database.Database;
  private readonly currentMessageFlags = new Map<string, boolean>();
  constructor(sourceDbPath: string, private readonly semanticDbPath: string) {
    mkdirSync(dirname(semanticDbPath), { recursive: true, mode: 0o700 });
    this.database = new Database(semanticDbPath);
    chmodSync(semanticDbPath, 0o600);
    this.database.pragma("journal_mode=WAL"); this.database.pragma("foreign_keys=ON"); this.database.pragma("busy_timeout=5000");
    sqliteVec.load(this.database);
    this.sourceDatabase = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
    this.sourceDatabase.pragma("busy_timeout=5000");
    const currentMessage = this.sourceDatabase.prepare("SELECT COALESCE(json_extract(json,'$.currentBranch'),1) current FROM session_messages WHERE revision=? AND id=?");
    // 旧位置缺少分支标记时只读核对原消息，有界缓存避免重叠片段重复回读。
    this.database.function("semantic_current_position", (revision: string, json: string) => {
      const location = JSON.parse(json) as SemanticDocument;
      return Number((location.anchors?.map(anchor => anchor.messageId) ?? [location.messageId]).every(id => {
        const key = JSON.stringify([revision, id]);
        if (!this.currentMessageFlags.has(key)) {
          const row = currentMessage.get(revision, id) as { current: number } | undefined;
          if (this.currentMessageFlags.size >= 4096) this.currentMessageFlags.delete(this.currentMessageFlags.keys().next().value!);
          this.currentMessageFlags.set(key, !!row && row.current !== 0);
        }
        return this.currentMessageFlags.get(key);
      }));
    });
    // 内存副本只保存已发布版本的元数据，真实历史连接始终只读。
    this.database.exec(`ATTACH DATABASE ':memory:' AS source;
      CREATE TABLE source.session_state(id INTEGER PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE source.session_revisions(id TEXT PRIMARY KEY,client TEXT,project TEXT,title TEXT,started_at TEXT,updated_at TEXT,json TEXT NOT NULL);
      CREATE TABLE source.session_version_sessions(version TEXT NOT NULL,session_id TEXT PRIMARY KEY,revision TEXT NOT NULL);
      CREATE INDEX source.session_snapshot_revision ON session_version_sessions(revision);`);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS semantic_vectors(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,text TEXT NOT NULL,tokens INTEGER NOT NULL,dimensions INTEGER,vector BLOB);
      CREATE INDEX IF NOT EXISTS semantic_vector_fingerprint ON semantic_vectors(fingerprint);
      CREATE TABLE IF NOT EXISTS semantic_input_splits(key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS semantic_plans(id TEXT PRIMARY KEY,version TEXT NOT NULL,fingerprint TEXT NOT NULL,config TEXT NOT NULL,created_at TEXT NOT NULL,published INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS semantic_plan_inputs(plan_id TEXT NOT NULL REFERENCES semantic_plans(id) ON DELETE CASCADE,key TEXT NOT NULL REFERENCES semantic_vectors(key),reused INTEGER NOT NULL,PRIMARY KEY(plan_id,key));
      CREATE TABLE IF NOT EXISTS semantic_plan_sessions(plan_id TEXT NOT NULL REFERENCES semantic_plans(id) ON DELETE CASCADE,session_id TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(plan_id,session_id));
      CREATE TABLE IF NOT EXISTS semantic_plan_positions(plan_id TEXT NOT NULL REFERENCES semantic_plans(id) ON DELETE CASCADE,id TEXT NOT NULL,session_id TEXT NOT NULL,revision TEXT NOT NULL,key TEXT NOT NULL REFERENCES semantic_vectors(key),json TEXT NOT NULL,PRIMARY KEY(plan_id,id));
      CREATE TABLE IF NOT EXISTS semantic_positions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,revision TEXT NOT NULL,key TEXT NOT NULL REFERENCES semantic_vectors(key),json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS semantic_position_revision ON semantic_positions(session_id,revision);
      CREATE INDEX IF NOT EXISTS semantic_position_key ON semantic_positions(key);
      CREATE TABLE IF NOT EXISTS semantic_active(id INTEGER PRIMARY KEY CHECK(id=1),fingerprint TEXT NOT NULL,source_version TEXT NOT NULL,plan_id TEXT NOT NULL);
    `);
  }

  private sourceVersion(): string {
    const row = this.sourceDatabase.prepare("SELECT json_extract(json,'$.version') version FROM session_state WHERE id=1").get() as { version: string | null } | undefined;
    if (!row?.version) throw new SemanticEngineError("NOT_READY", "历史索引尚未就绪");
    return row.version;
  }
  private snapshot<T>(read: () => T): T {
    return this.sourceDatabase.transaction(() => this.database.transaction(() => {
      const version = this.sourceVersion();
      const cached = this.database.prepare("SELECT json_extract(json,'$.version') version FROM source.session_state WHERE id=1").get() as { version: string } | undefined;
      if (cached?.version !== version) {
        this.database.exec("DELETE FROM source.session_revisions; DELETE FROM source.session_version_sessions; DELETE FROM source.session_state;");
        const revision = this.database.prepare("INSERT INTO source.session_revisions(id,client,project,title,started_at,updated_at,json) VALUES(?,?,?,?,?,?,?)");
        const session = this.database.prepare("INSERT INTO source.session_version_sessions(version,session_id,revision) VALUES(?,?,?)");
        const rows = this.sourceDatabase.prepare(`SELECT r.id,r.client,r.project,r.title,r.started_at,r.updated_at,r.json,s.session_id,relation.parent
          FROM session_version_sessions s JOIN session_revisions r ON r.id=s.revision LEFT JOIN session_version_relations relation
          ON relation.version=s.version AND relation.child=s.session_id WHERE s.version=?`);
        for (const row of rows.iterate(version) as Iterable<{ id: string; client: string; project: string | null; title: string; started_at: string | null; updated_at: string | null; json: string; session_id: string; parent: string | null }>) {
          const summary = JSON.parse(row.json) as SessionSourceMeta;
          if (row.parent) { summary.parentSessionId = row.parent; summary.relationship = "child"; }
          revision.run(row.id, row.client, row.project, row.title, row.started_at, row.updated_at, JSON.stringify(summary));
          session.run(version, row.session_id, row.id);
        }
        this.database.prepare("INSERT INTO source.session_state(id,json) VALUES(1,?)").run(JSON.stringify({ version }));
        this.refreshPositions(version);
      }
      return read();
    })())();
  }
  /** 仅在历史版本变化时核验已变会话；追加轮次不使未变的消息位置全部失效。 */
  private refreshPositions(version: string): void {
    const positions = this.database.prepare(`SELECT p.id,p.json,s.revision,r.json summary FROM semantic_positions p
      LEFT JOIN source.session_version_sessions s ON s.session_id=p.session_id AND s.version=?
      LEFT JOIN source.session_revisions r ON r.id=s.revision WHERE s.revision IS NULL OR s.revision!=p.revision`)
      .all(version) as { id: string; json: string; revision: string | null; summary: string | null }[];
    const source = this.sourceDatabase.prepare("SELECT id,ordinal,turn_id,kind,text,json FROM session_messages WHERE revision=? AND id=?");
    const remove = this.database.prepare("DELETE FROM semantic_positions WHERE id=?");
    const update = this.database.prepare("UPDATE semantic_positions SET revision=?,json=? WHERE id=?");
    const messages = new Map<string, { message: SessionMessage; hash: string } | undefined>();
    for (const position of positions) {
      const location = JSON.parse(position.json) as Omit<SemanticDocument, "text" | "estimatedTokens">;
      const summary = position.summary ? JSON.parse(position.summary) as SessionSourceMeta : undefined;
      let valid = Boolean(position.revision && summary && location.anchors?.length);
      if (location.branchId && summary?.branches?.length && !summary.branches.some(branch => branch.id === location.branchId)) valid = false;
      let previousOrdinal = -Infinity;
      const anchors = location.anchors?.map(anchor => {
        if (!valid || !anchor.sourceHash) { valid = false; return anchor; }
        const key = JSON.stringify([position.revision, anchor.messageId]);
        if (!messages.has(key)) {
          const row = source.get(position.revision, anchor.messageId) as { id: string; ordinal: number; turn_id: string; kind: SessionMessage["kind"]; text: string; json: string } | undefined;
          const message = row ? { ...JSON.parse(row.json), id: row.id, ordinal: row.ordinal, turnId: row.turn_id, kind: row.kind, text: row.text } as SessionMessage : undefined;
          messages.set(key, message ? { message, hash: sourceMessageHash(message) } : undefined);
        }
        const current = messages.get(key);
        if (!current || current.hash !== anchor.sourceHash || current.message.branchIds?.length && (!location.branchId || !current.message.branchIds.includes(location.branchId))) valid = false;
        if (current && current.message.ordinal <= previousOrdinal) valid = false;
        previousOrdinal = current?.message.ordinal ?? previousOrdinal;
        return { ...anchor, turnId: current?.message.turnId ?? anchor.turnId };
      });
      if (anchors && anchors.length > 1 && (new Set(anchors.map(anchor => anchor.turnId)).size !== 1 || !anchors.every(anchor => isSemanticTurnKnown(anchor.turnId)))) valid = false;
      if (!valid || !anchors?.length) { remove.run(position.id); continue; }
      location.anchors = anchors;
      delete location.currentBranch;
      location.turnId = anchors.find(anchor => anchor.messageId === location.messageId)?.turnId ?? location.turnId;
      update.run(position.revision, JSON.stringify(location), position.id);
    }
  }

  private plan(id: string): Plan {
    const plan = this.database.prepare("SELECT * FROM semantic_plans WHERE id=?").get(id) as Plan | undefined;
    if (!plan) throw new SemanticEngineError("PREVIEW_STALE", "构建预览已失效，请重新预览");
    return plan;
  }
  private *expandedDocuments(document: SemanticDocument, config: SemanticConfig, fingerprint: string): Generator<SemanticDocument> {
    if (this.database.prepare("SELECT 1 FROM semantic_input_splits WHERE key=?").get(document.key)) {
      const parts = splitDocument(document, config, fingerprint);
      if (parts.length) { for (const part of parts) yield* this.expandedDocuments(part, config, fingerprint); return; }
    }
    yield document;
  }
  preview(config: SemanticConfig): SemanticPreview {
    if (config.scope.timeRange === "unset") throw new SemanticEngineError("INVALID_INPUT", "请先选择维护时间范围");
    return this.snapshot(() => {
      const sourceVersion = this.sourceVersion(), fingerprint = encodingFingerprint(config), id = randomUUID(), createdAt = new Date().toISOString();
      this.database.prepare("INSERT INTO semantic_plans(id,version,fingerprint,config,created_at) VALUES(?,?,?,?,?)").run(id, sourceVersion, fingerprint, JSON.stringify(config), createdAt);
      const scope = filterScope(config.scope, new Date(createdAt));
      const sessions = this.database.prepare(`SELECT r.id revision,r.json FROM source.session_version_sessions v JOIN source.session_revisions r ON r.id=v.revision WHERE v.version=?${scope.sql}`);
      const messages = this.sourceDatabase.prepare("SELECT id,ordinal,record_line,turn_id,kind,text,json FROM session_messages WHERE revision=? ORDER BY ordinal,id");
      const input = this.database.prepare("INSERT INTO semantic_vectors(key,fingerprint,text,tokens) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET tokens=excluded.tokens");
      const planInput = this.database.prepare("INSERT OR IGNORE INTO semantic_plan_inputs(plan_id,key,reused) SELECT ?,key,vector IS NOT NULL FROM semantic_vectors WHERE key=?");
      const position = this.database.prepare("INSERT OR IGNORE INTO semantic_plan_positions(plan_id,id,session_id,revision,key,json) VALUES(?,?,?,?,?,?)");
      const planSession = this.database.prepare("INSERT INTO semantic_plan_sessions(plan_id,session_id,revision) VALUES(?,?,?)");
      let sessionCount = 0, positionCount = 0;
      for (const row of sessions.all(sourceVersion, ...scope.values) as { revision: string; json: string }[]) {
        const session = JSON.parse(row.json) as SessionSourceMeta;
        planSession.run(id, session.id, row.revision); sessionCount++;
        const records = (messages.all(row.revision) as { id: string; ordinal: number; record_line: number; turn_id: string; kind: SessionMessage["kind"]; text: string; json: string }[]).map(item =>
          ({ ...JSON.parse(item.json), id: item.id, ordinal: item.ordinal, recordLine: item.record_line, turnId: item.turn_id, kind: item.kind, text: item.text }) as SessionMessage);
        for (const original of buildDocuments(records, session, config, fingerprint)) {
          for (const document of this.expandedDocuments(original, config, fingerprint)) {
            input.run(document.key, fingerprint, document.text, document.estimatedTokens); planInput.run(id, document.key);
            const positionId = createHash("sha256").update(JSON.stringify([session.id, row.revision, document.messageId, document.branchId, document.start, document.end, document.key])).digest("hex");
            const { text: _text, estimatedTokens: _tokens, ...location } = document;
            positionCount += position.run(id, positionId, session.id, row.revision, document.key, JSON.stringify(location)).changes;
          }
        }
      }
      const totals = this.database.prepare(`SELECT COUNT(*) unique_inputs,COALESCE(SUM(i.reused),0) reused_inputs,COALESCE(SUM(CASE WHEN v.vector IS NULL THEN v.tokens ELSE 0 END),0) tokens
        FROM semantic_plan_inputs i JOIN semantic_vectors v ON v.key=i.key WHERE i.plan_id=?`).get(id) as { unique_inputs: number; reused_inputs: number; tokens: number };
      this.database.prepare("DELETE FROM semantic_plans WHERE published=0 AND id!=?").run(id);
      this.database.prepare(`DELETE FROM semantic_vectors WHERE vector IS NULL AND key NOT IN(SELECT key FROM semantic_positions)
        AND key NOT IN(SELECT key FROM semantic_plan_inputs)`).run();
      return { id, sourceVersion, fingerprint, sessionCount, positionCount, uniqueInputs: totals.unique_inputs, reusedInputs: totals.reused_inputs,
        pendingInputs: totals.unique_inputs - totals.reused_inputs, estimatedTokens: totals.tokens,
        estimatedCost: config.strategy.pricePerMillion === undefined ? null : totals.tokens * config.strategy.pricePerMillion / 1_000_000,
        vectorBytes: config.connection.dimensions ? totals.unique_inputs * config.connection.dimensions * 4 : null, createdAt };
    });
  }

  batch(previewId: string, limit: number, tokenBudget: number): SemanticInput[] {
    this.plan(previewId);
    for (;;) {
      const rows = this.database.prepare(`SELECT v.key,v.text,v.tokens FROM semantic_plan_inputs i JOIN semantic_vectors v ON v.key=i.key
        WHERE i.plan_id=? AND v.vector IS NULL ORDER BY v.key LIMIT ?`).all(previewId, Math.max(1, Math.min(512, Math.floor(limit)))) as { key: string; text: string; tokens: number }[];
      if (rows[0] && rows[0].tokens > tokenBudget) {
        if (this.splitInput(previewId, rows[0].key)) continue;
        throw new SemanticEngineError("INVALID_INPUT", "单个文本块已无法继续缩小，请提高批次 Token 预算或缩短编码前缀");
      }
      const batch: SemanticInput[] = []; let tokens = 0;
      for (const row of rows) {
        if (tokens + row.tokens > tokenBudget) break;
        batch.push({ key: row.key, text: row.text, estimatedTokens: row.tokens }); tokens += row.tokens;
      }
      return batch;
    }
  }

  saveVectors(previewId: string, vectors: SemanticVector[]): void {
    this.database.transaction(() => {
      const plan = this.plan(previewId), config = JSON.parse(plan.config) as SemanticConfig;
      const existing = this.database.prepare("SELECT dimensions FROM semantic_vectors WHERE fingerprint=? AND vector IS NOT NULL LIMIT 1").get(plan.fingerprint) as { dimensions: number } | undefined;
      let dimensions = config.connection.dimensions ?? existing?.dimensions;
      const save = this.database.prepare("UPDATE semantic_vectors SET dimensions=?,vector=? WHERE key=? AND fingerprint=? AND key IN (SELECT key FROM semantic_plan_inputs WHERE plan_id=?)");
      for (const vector of vectors) {
        if (!vector.values.length || vector.values.some(value => !Number.isFinite(value)) || !vector.values.some(value => value !== 0)) throw new SemanticEngineError("INVALID_INPUT", "模型返回了无效向量");
        dimensions ??= vector.values.length;
        if (vector.values.length !== dimensions) throw new SemanticEngineError("INDEX_CHANGED", "向量维度发生变化，请重新测试连接并重建");
        const values = new Float32Array(vector.values);
        if (values.some(value => !Number.isFinite(value)) || !values.some(value => value !== 0)) throw new SemanticEngineError("INVALID_INPUT", "向量不能表示为有效的 float32 数组");
        if (!save.run(dimensions, Buffer.from(values.buffer), vector.key, plan.fingerprint, previewId).changes) throw new SemanticEngineError("INVALID_INPUT", "编码结果不属于当前构建计划");
      }
    })();
  }

  splitInput(previewId: string, key: string): boolean {
    return this.database.transaction(() => {
      const plan = this.plan(previewId);
      if (plan.published) return false;
      const input = this.database.prepare(`SELECT v.text FROM semantic_vectors v JOIN semantic_plan_inputs i ON i.key=v.key
        WHERE i.plan_id=? AND v.key=? AND v.vector IS NULL`).get(previewId, key) as { text: string } | undefined;
      if (!input) return false;
      const positions = this.database.prepare("SELECT id,session_id,revision,json FROM semantic_plan_positions WHERE plan_id=? AND key=?")
        .all(previewId, key) as { id: string; session_id: string; revision: string; json: string }[];
      const config = JSON.parse(plan.config) as SemanticConfig;
      const replacement = positions.map(position => ({ position, documents: splitDocument({ ...JSON.parse(position.json), text: input.text }, config, plan.fingerprint) }));
      if (!replacement.length || replacement.some(item => !item.documents.length || item.documents.some(document => document.text === input.text))) return false;
      const insertInput = this.database.prepare("INSERT INTO semantic_vectors(key,fingerprint,text,tokens) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET tokens=excluded.tokens");
      const planInput = this.database.prepare("INSERT OR IGNORE INTO semantic_plan_inputs(plan_id,key,reused) SELECT ?,key,vector IS NOT NULL FROM semantic_vectors WHERE key=?");
      const insertPosition = this.database.prepare("INSERT OR IGNORE INTO semantic_plan_positions(plan_id,id,session_id,revision,key,json) VALUES(?,?,?,?,?,?)");
      for (const { position, documents } of replacement) {
        for (const document of documents) {
          insertInput.run(document.key, plan.fingerprint, document.text, document.estimatedTokens); planInput.run(previewId, document.key);
          const positionId = createHash("sha256").update(JSON.stringify([position.session_id, position.revision, document.messageId, document.branchId, document.start, document.end, document.key])).digest("hex");
          const { text: _text, estimatedTokens: _tokens, ...location } = document;
          insertPosition.run(previewId, positionId, position.session_id, position.revision, document.key, JSON.stringify(location));
        }
        this.database.prepare("DELETE FROM semantic_plan_positions WHERE plan_id=? AND id=?").run(previewId, position.id);
      }
      this.database.prepare("DELETE FROM semantic_plan_inputs WHERE plan_id=? AND key=?").run(previewId, key);
      this.database.prepare("INSERT OR IGNORE INTO semantic_input_splits(key) VALUES(?)").run(key);
      this.database.prepare(`DELETE FROM semantic_vectors WHERE key=? AND vector IS NULL AND key NOT IN(SELECT key FROM semantic_positions)
        AND key NOT IN(SELECT key FROM semantic_plan_inputs)`).run(key);
      return true;
    })();
  }

  progress(previewId: string): { totalInputs: number; completedInputs: number; reusedInputs: number } {
    this.plan(previewId);
    return this.database.prepare(`SELECT COUNT(*) totalInputs,COALESCE(SUM(v.vector IS NOT NULL),0) completedInputs,COALESCE(SUM(i.reused),0) reusedInputs
      FROM semantic_plan_inputs i JOIN semantic_vectors v ON v.key=i.key WHERE i.plan_id=?`).get(previewId) as { totalInputs: number; completedInputs: number; reusedInputs: number };
  }

  publish(previewId: string): SemanticEngineStats {
    return this.snapshot(() => {
      const plan = this.plan(previewId);
      if (plan.published) return this.stats(plan.fingerprint);
      if (this.sourceVersion() !== plan.version) throw new SemanticEngineError("PREVIEW_STALE", "历史已更新，请重新预览；已完成的兼容编码可以复用");
      const progress = this.progress(previewId);
      if (progress.completedInputs !== progress.totalInputs) throw new SemanticEngineError("NOT_READY", "当前构建尚未完成");
      const active = this.database.prepare("SELECT fingerprint FROM semantic_active WHERE id=1").get() as { fingerprint: string } | undefined;
      if (active?.fingerprint !== plan.fingerprint) this.database.prepare("DELETE FROM semantic_positions").run();
      this.database.prepare(`DELETE FROM semantic_positions WHERE session_id IN (SELECT session_id FROM semantic_plan_sessions WHERE plan_id=?)
        OR NOT EXISTS(SELECT 1 FROM source.session_version_sessions s WHERE s.version=? AND s.session_id=semantic_positions.session_id AND s.revision=semantic_positions.revision)`).run(previewId, plan.version);
      const config = JSON.parse(plan.config) as SemanticConfig;
      const bounds = timeBounds(config.scope, new Date(plan.created_at));
      if (config.strategy.cleanOutsideWindow && (bounds.from || bounds.to)) {
        const outside: string[] = [], values: string[] = [];
        if (bounds.from) { outside.push("julianday(COALESCE(r.updated_at,r.started_at))<julianday(?)"); values.push(bounds.from); }
        if (bounds.to) { outside.push("julianday(COALESCE(r.started_at,r.updated_at))>julianday(?)"); values.push(bounds.to); }
        this.database.prepare(`DELETE FROM semantic_positions WHERE session_id IN (SELECT s.session_id FROM source.session_version_sessions s
          JOIN source.session_revisions r ON r.id=s.revision WHERE s.version=? AND (${outside.join(" OR ")}))`).run(plan.version, ...values);
      }
      this.database.prepare("INSERT OR REPLACE INTO semantic_positions(id,session_id,revision,key,json) SELECT id,session_id,revision,key,json FROM semantic_plan_positions WHERE plan_id=?").run(previewId);
      this.database.prepare("INSERT OR REPLACE INTO semantic_active(id,fingerprint,source_version,plan_id) VALUES(1,?,?,?)").run(plan.fingerprint, plan.version, previewId);
      this.database.prepare("UPDATE semantic_plans SET published=1 WHERE id=?").run(previewId);
      this.database.prepare("DELETE FROM semantic_plan_positions WHERE plan_id=?").run(previewId);
      this.database.prepare("DELETE FROM semantic_plan_sessions WHERE plan_id=?").run(previewId);
      this.database.prepare("DELETE FROM semantic_plans WHERE published=1 AND id!=?").run(previewId);
      this.database.prepare("DELETE FROM semantic_vectors WHERE key NOT IN(SELECT key FROM semantic_positions) AND key NOT IN(SELECT key FROM semantic_plan_inputs)").run();
      return this.stats(plan.fingerprint);
    });
  }

  private databaseBytes(): number {
    return [this.semanticDbPath, `${this.semanticDbPath}-wal`].reduce((total, path) => { try { return total + statSync(path).size; } catch { return total; } }, 0);
  }
  stats(fingerprint: string): SemanticEngineStats {
    try { return this.snapshot(() => this.readStats(fingerprint)); }
    catch (error) {
      if (!(error instanceof SemanticEngineError) || error.code !== "NOT_READY") throw error;
      return { ready: false, indexedSessions: 0, indexedPositions: 0, uniqueVectors: 0, databaseBytes: this.databaseBytes() };
    }
  }
  private readStats(fingerprint: string): SemanticEngineStats {
    const active = this.database.prepare("SELECT fingerprint,source_version FROM semantic_active WHERE id=1").get() as { fingerprint: string; source_version: string } | undefined;
    if (!active || active.fingerprint !== fingerprint) return { ready: false, indexedSessions: 0, indexedPositions: 0, uniqueVectors: 0, databaseBytes: this.databaseBytes() };
    const version = this.sourceVersion();
    const counts = this.database.prepare(`SELECT COUNT(DISTINCT p.session_id) sessions,COUNT(*) positions,COUNT(DISTINCT p.key) vectors
      FROM semantic_positions p JOIN source.session_version_sessions s ON s.session_id=p.session_id AND s.revision=p.revision AND s.version=?`).get(version) as { sessions: number; positions: number; vectors: number };
    return { ready: true, sourceVersion: active.source_version, indexedSessions: counts.sessions, indexedPositions: counts.positions, uniqueVectors: counts.vectors, databaseBytes: this.databaseBytes() };
  }

  facets(): { models: string[]; projects: string[]; clients: Client[] } {
    try { return this.snapshot(() => this.readFacets()); }
    catch (error) { if (!(error instanceof SemanticEngineError) || error.code !== "NOT_READY") throw error; return { clients: [], projects: [], models: [] }; }
  }
  private readFacets(): { models: string[]; projects: string[]; clients: Client[] } {
    let version: string;
    try { version = this.sourceVersion(); } catch { return { models: [], projects: [], clients: [] }; }
    const scope = "FROM source.session_version_sessions s JOIN source.session_revisions r ON r.id=s.revision WHERE s.version=?";
    return {
      clients: (this.database.prepare(`SELECT DISTINCT r.client value ${scope} AND r.client IS NOT NULL ORDER BY value`).all(version) as { value: Client }[]).map(row => row.value),
      projects: (this.database.prepare(`SELECT DISTINCT r.project value ${scope} AND r.project IS NOT NULL ORDER BY value`).all(version) as { value: string }[]).map(row => row.value),
      models: (this.database.prepare(`SELECT DISTINCT model.value FROM source.session_version_sessions s JOIN source.session_revisions r ON r.id=s.revision
        JOIN json_each(r.json,'$.models') model WHERE s.version=? AND model.type='text' ORDER BY model.value`).all(version) as { value: string }[]).map(row => row.value),
    };
  }

  search(vector: number[], query: SemanticSearchQuery, fingerprint: string): SemanticSearchResult {
    return this.snapshot(() => {
      if (!this.stats(fingerprint).ready) throw new SemanticEngineError("NOT_READY", "语义索引尚未就绪，请先完成构建");
      const dimensions = (this.database.prepare("SELECT dimensions FROM semantic_vectors WHERE fingerprint=? AND vector IS NOT NULL LIMIT 1").get(fingerprint) as { dimensions: number } | undefined)?.dimensions;
      if (dimensions === undefined) return { version: this.sourceVersion(), mode: "semantic", groups: [], total: 0, hitCount: 0, coveredSessions: 0,
        limited: false, page: Math.max(1, Math.floor(query.page ?? 1)), pageSize: Math.max(1, Math.min(200, Math.floor(query.pageSize ?? 20))) };
      const input = new Float32Array(vector);
      if (vector.length !== dimensions || input.some(value => !Number.isFinite(value)) || !input.some(value => value !== 0)) throw new SemanticEngineError("INDEX_CHANGED", "查询向量与索引维度不兼容");
      const version = this.sourceVersion(), scope = filterScope(query.scope);
      let filter = scope.sql; const values: (string | number)[] = [version, ...scope.values];
      if (query.sessionId) { filter += " AND p.session_id=?"; values.push(query.sessionId); }
      if (query.scope.branch === "current") filter += ` AND COALESCE(json_extract(p.json,'$.currentBranch'),semantic_current_position(p.revision,p.json))=1 AND (json_extract(p.json,'$.branchId') IS NULL OR NOT EXISTS(SELECT 1 FROM json_each(r.json,'$.branches'))
        OR EXISTS(SELECT 1 FROM json_each(r.json,'$.branches') branch WHERE json_extract(branch.value,'$.id')=json_extract(p.json,'$.branchId') AND json_extract(branch.value,'$.current')=1))`;
      const pageSize = Math.max(1, Math.min(200, Math.floor(query.pageSize ?? 20))), page = Math.max(1, Math.floor(query.page ?? 1));
      const order = query.sort === "updated" ? "updated_at DESC,session_id" : "distance,session_id";
      const rows = this.database.prepare(`WITH valid AS MATERIALIZED (
        SELECT p.*,${query.response === "summary" ? "json_set(json_remove(r.json,'$.contextSnapshots','$.usageReports','$.gaps'),'$.gaps',json('[]'),'$.gapCount',COALESCE(json_array_length(r.json,'$.gaps'),0))" : "r.json"} session_json,COALESCE(r.updated_at,r.started_at,'') updated_at FROM semantic_positions p
        JOIN source.session_version_sessions s ON s.session_id=p.session_id AND s.revision=p.revision
        JOIN source.session_revisions r ON r.id=s.revision WHERE s.version=?${filter}
      ), distances AS MATERIALIZED (
        SELECT v.key,vec_distance_cosine(v.vector,?) distance FROM semantic_vectors v JOIN(SELECT DISTINCT key FROM valid) selected ON selected.key=v.key WHERE v.fingerprint=? AND v.vector IS NOT NULL
      ), grouped AS MATERIALIZED (
        SELECT p.session_id,MIN(d.distance) distance,COUNT(*) matches,MAX(p.updated_at) updated_at FROM valid p JOIN distances d ON d.key=p.key GROUP BY p.session_id
      ), candidates AS MATERIALIZED (SELECT * FROM grouped ORDER BY distance,session_id LIMIT 201), limited AS MATERIALIZED (
        SELECT * FROM candidates ORDER BY distance,session_id LIMIT 200
      ), selected AS MATERIALIZED (SELECT * FROM limited ORDER BY ${order} LIMIT ? OFFSET ?), ranked AS (
        SELECT p.*,d.distance,g.matches,ROW_NUMBER() OVER(PARTITION BY p.session_id ORDER BY d.distance,p.id) rank
        FROM valid p JOIN distances d ON d.key=p.key JOIN selected g ON g.session_id=p.session_id
      ), totals AS (SELECT (SELECT COUNT(*) FROM candidates)>200 limited,(SELECT COUNT(*) FROM limited) total,
        (SELECT COUNT(DISTINCT session_id) FROM valid) coveredSessions,COALESCE((SELECT SUM(matches) FROM limited),0) hitCount)
      SELECT t.*,r.session_id,r.session_json,r.json,r.matches,r.distance,r.updated_at,r.rank FROM totals t LEFT JOIN ranked r ON r.rank<=3 ORDER BY ${order},rank`)
        .all(...values, Buffer.from(input.buffer), fingerprint, pageSize, (page - 1) * pageSize) as { limited: number; total: number; coveredSessions: number; hitCount: number; session_id: string | null; session_json: string; json: string; matches: number }[];
      const totals = rows[0]!;
      const groups: SemanticSearchResult["groups"] = [];
      for (const row of rows) {
        if (!row.session_id) continue;
        let group = groups.find(item => item.session.id === row.session_id);
        if (!group) {
          const { path: _path, sourceId: _sourceId, ...summary } = JSON.parse(row.session_json) as SessionSourceMeta;
          group = { session: sessionTitle(summary), matchCount: row.matches, hits: [] }; groups.push(group);
        }
        const location = JSON.parse(row.json) as { messageId: string; turnId: string; kind: "user" | "assistant"; snippet: string; branchId?: string };
        const current = group.session.branches?.find(branch => branch.current)?.id;
        group.hits.push({ session: group.session, messageId: location.messageId, turnId: location.turnId, kind: location.kind,
          briefVisible: !location.branchId || location.branchId === current, snippet: location.snippet });
      }
      return { version, mode: "semantic", groups, total: totals.total, hitCount: totals.hitCount, coveredSessions: totals.coveredSessions, limited: Boolean(totals.limited), page, pageSize };
    });
  }

  clear(): void {
    this.database.transaction(() => {
      for (const table of ["semantic_active", "semantic_positions", "semantic_plans", "semantic_vectors", "semantic_input_splits"]) this.database.prepare(`DELETE FROM ${table}`).run();
    })();
    this.database.pragma("wal_checkpoint(TRUNCATE)"); this.database.exec("VACUUM");
  }
  close(): void { this.database.close(); this.sourceDatabase.close(); }
}
