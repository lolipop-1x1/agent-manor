import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { knowledgeTypes } from "../knowledge-contracts.js";
import type { KnowledgeAudit, KnowledgeAvailability, KnowledgeDetail, KnowledgeDraft, KnowledgeEntry, KnowledgeFacets, KnowledgeJobSummary, KnowledgeList, KnowledgeQuery, KnowledgeReview, KnowledgeReviewInput, KnowledgeRevision, KnowledgeRevisionInput, KnowledgeSource } from "../knowledge-contracts.js";
import type { MessageDescriptor } from "../i18n/types.js";

export class KnowledgeError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT", message: string, readonly messageDescriptor?: MessageDescriptor) {
    super(message); this.name = "KnowledgeError";
  }
}
interface EntryRow { id: string; created_at: string; updated_at: string; availability: "active" | "deprecated" | "superseded"; reason: string | null; published: string | null; latest: string }
interface RevisionRow { id: string; knowledge_id: string; version: number; base: string | null; review: KnowledgeReview; created_at: string; payload: string }
interface SelectedRow extends EntryRow { selected: string }
interface TaskSummaryRow { json: string | null; title: string | null }
const taskSummaryColumns = `json_set(json_remove(json_extract(state.json,'$.job'),'$.title','$.events','$.results','$.failedSessions','$.model'),
  '$.eventCount',COALESCE(json_array_length(state.json,'$.job.events'),0),
  '$.resultCount',COALESCE(json_array_length(state.json,'$.job.results'),0),
  '$.failedSessionCount',COALESCE(json_array_length(state.json,'$.job.failedSessions'),0)) AS json,
  CASE WHEN json_array_length(state.json,'$.preview.targets')=1 THEN COALESCE(json_extract(state.json,'$.job.title'),json_extract(state.json,'$.preview.targets[0].title')) END AS title`;
const taskSummary = (row: TaskSummaryRow): KnowledgeJobSummary => ({ ...JSON.parse(row.json!) as KnowledgeJobSummary, ...(row.title !== null ? { title: row.title } : {}) });
const draftKeys = ["title", "body", "summary", "type", "tags", "scope", "subject", "language", "applicability", "validUntil", "occurredAt", "resolved", "sources", "author", "changeReason"];
const reviewValues = ["pending", "reviewed", "rejected", "all"];
const availabilityValues = ["active", "deprecated", "expired", "superseded", "resolved", "all"];
function invalid(message: string): never { throw new KnowledgeError("INVALID_INPUT", message); }
function conflict(message: string): never { throw new KnowledgeError("CONFLICT", message); }
function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(`${label} 必须为对象`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) invalid(`${label} 包含未知字段`);
  return result;
}
function text(value: unknown, label: string, max: number, required = false): string | undefined {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || value.includes("\0") || value.length > max || (required && !value.trim())) invalid(`${label} 不是有效文本`);
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[], label: string): T | undefined {
  if (value === undefined) return;
  if (typeof value !== "string" || !values.includes(value as T)) invalid(`${label} 不受支持`);
  return value as T;
}
function date(value: unknown, label: string): string | undefined {
  const result = text(value, label, 40);
  if (result === undefined) return;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(result) || !Number.isFinite(Date.parse(result))) invalid(`${label} 必须为日期或带时区的时间`);
  const day = result.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) invalid(`${label} 不是有效日期`);
  if (result.length > 10 && (Number(result.slice(11, 13)) > 23 || Number(result.slice(14, 16)) > 59 || Number(result.slice(17, 19)) > 59)) invalid(`${label} 不是有效时间`);
  return result;
}
function source(value: unknown): KnowledgeSource {
  const input = object(value, ["kind", "taskId", "client", "sessionId", "sessionTitle", "sourceVersion", "currentVersion", "branch", "messageId", "turnId", "turnPosition", "ordinal", "callId", "hash", "excerpt", "limitation", "limitationDetails", "status"], "来源");
  const kind = choice(input.kind, ["manual", "agent", "extraction"] as const, "来源类型");
  if (!kind) invalid("来源缺少类型");
  const output: Record<string, unknown> = { kind };
  for (const key of ["taskId", "client", "sessionId", "sessionTitle", "sourceVersion", "currentVersion", "branch", "messageId", "turnId", "callId", "hash", "excerpt", "limitation"]) {
    const value = text(input[key], key, key === "excerpt" ? 16_384 : 2_048);
    if (value !== undefined) output[key] = value;
  }
  for (const key of ["turnPosition", "ordinal"]) {
    if (input[key] === undefined) continue;
    if (!Number.isSafeInteger(input[key]) || (input[key] as number) < 0) invalid(`${key} 必须为非负整数`);
    output[key] = input[key];
  }
  const status = choice(input.status, ["available", "changed", "missing"] as const, "来源状态");
  if (status) output.status = status;
  if (input.limitationDetails !== undefined) {
    if (!Array.isArray(input.limitationDetails) || input.limitationDetails.length > 64) invalid("来源限制数量无效");
    output.limitationDetails = input.limitationDetails.map(raw => {
      const item = object(raw, ["message", "messageDescriptor"], "来源限制");
      const message = text(item.message, "来源限制原文", 4096, true)!;
      if (item.messageDescriptor === undefined) return { message };
      const descriptor = object(item.messageDescriptor, ["key", "params"], "来源限制标识");
      const key = text(descriptor.key, "来源限制标识", 256, true)!;
      if (descriptor.params === undefined) return { message, messageDescriptor: { key } };
      if (!descriptor.params || typeof descriptor.params !== "object" || Array.isArray(descriptor.params) || Object.keys(descriptor.params).length > 32) invalid("来源限制参数无效");
      const params = Object.fromEntries(Object.entries(descriptor.params).map(([name, value]) => {
        text(name, "来源限制参数名", 128, true);
        if (typeof value === "number" && Number.isFinite(value)) return [name, value];
        return [name, text(value, "来源限制参数", 4096, true)!];
      }));
      return { message, messageDescriptor: { key, params } };
    });
  }
  return output as unknown as KnowledgeSource;
}
function searchFields(content: KnowledgeDraft): [NonNullable<KnowledgeEntry["snippetField"]>, string | undefined][] {
  return [["title", content.title], ["summary", content.summary], ["body", content.body], ["applicability", content.applicability],
    ["tags", content.tags?.join("\n")], ["source", content.sources?.flatMap(item => [item.client, item.sessionTitle, item.excerpt]).filter(Boolean).join("\n")]];
}
function searchText(content: KnowledgeDraft): string { return searchFields(content).map(([, value]) => value).filter(Boolean).join("\n").toLocaleLowerCase(); }
function draft(value: unknown, revision = false): KnowledgeDraft {
  const input = object(value, revision ? [...draftKeys, "baseRevisionId"] : draftKeys, "知识");
  const scope = object(input.scope, ["kind", "project"], "适用范围");
  const kind = choice(scope.kind, ["global", "project"] as const, "适用范围");
  if (!kind) invalid("必须明确适用范围");
  const project = text(scope.project, "项目", 4_096, kind === "project");
  if (kind === "global" && project !== undefined) invalid("全局范围不能指定项目");
  const output: KnowledgeDraft = {
    title: text(input.title, "标题", 512, true)!, body: text(input.body, "正文", 524_288, true)!,
    scope: kind === "project" ? { kind, project } : { kind },
  };
  for (const key of ["summary", "applicability", "author", "changeReason"] as const) {
    const value = text(input[key], key, key === "author" ? 256 : 16_384);
    if (value !== undefined) output[key] = value;
  }
  const type = choice(input.type, knowledgeTypes, "知识类型"); if (type) output.type = type;
  const subject = choice(input.subject, ["personal", "project", "general"] as const, "描述主体"); if (subject) output.subject = subject;
  const language = choice(input.language, ["zh-CN", "en"] as const, "知识语言"); if (language) output.language = language;
  for (const key of ["validUntil", "occurredAt"] as const) { const value = date(input[key], key); if (value !== undefined) output[key] = value; }
  if (input.resolved !== undefined) {
    if (typeof input.resolved !== "boolean" || (input.resolved && type !== "open_question")) invalid("仅未决事项可标为已解决");
    output.resolved = input.resolved;
  }
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > 64) invalid("标签必须为最多 64 项的数组");
    output.tags = [...new Set(input.tags.map(value => text(value, "标签", 128, true)!.trim()))];
  }
  if (input.sources !== undefined) {
    if (!Array.isArray(input.sources) || input.sources.length > 128) invalid("来源必须为最多 128 项的数组");
    output.sources = input.sources.map(source);
  }
  if (Buffer.byteLength(JSON.stringify(output)) > 2_097_152) invalid("单个知识快照过大");
  return output;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, value]) => value !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(",")}}`;
  return JSON.stringify(value);
}
function revision(row: RevisionRow): KnowledgeRevision {
  return { ...JSON.parse(row.payload) as KnowledgeDraft, id: row.id, knowledgeId: row.knowledge_id, version: row.version,
    ...(row.base ? { baseRevisionId: row.base } : {}), review: row.review, createdAt: row.created_at };
}
function effectiveAvailability(row: EntryRow, content: KnowledgeDraft): KnowledgeAvailability {
  if (row.availability !== "active") return row.availability;
  if (content.validUntil && Date.parse(content.validUntil) <= Date.now()) return "expired";
  return content.resolved ? "resolved" : "active";
}

/** 知识与证据是权威数据，独立于可重建的会话索引。 */
export class KnowledgeStore {
  readonly dbPath: string;
  private readonly database: Database.Database;
  constructor(path: string) {
    this.dbPath = resolve(path); mkdirSync(dirname(this.dbPath), { recursive: true });
    this.database = new Database(this.dbPath); chmodSync(this.dbPath, 0o600);
    this.database.pragma("journal_mode=WAL"); this.database.pragma("foreign_keys=ON"); this.database.pragma("busy_timeout=5000");
    this.database.exec(`CREATE TABLE IF NOT EXISTS knowledge_entries (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, availability TEXT NOT NULL DEFAULT 'active', reason TEXT, published TEXT, latest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_revisions (
        id TEXT PRIMARY KEY, knowledge_id TEXT NOT NULL REFERENCES knowledge_entries(id), version INTEGER NOT NULL, base TEXT,
        review TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL, search TEXT NOT NULL,
        UNIQUE(knowledge_id,version));
      CREATE INDEX IF NOT EXISTS knowledge_revision_entry ON knowledge_revisions(knowledge_id,version);
      CREATE INDEX IF NOT EXISTS knowledge_entry_order ON knowledge_entries(updated_at DESC,id);
      CREATE TABLE IF NOT EXISTS knowledge_audit (
        id TEXT PRIMARY KEY, knowledge_id TEXT NOT NULL REFERENCES knowledge_entries(id), revision_id TEXT, action TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS knowledge_audit_entry ON knowledge_audit(knowledge_id,created_at,id);
      CREATE TABLE IF NOT EXISTS knowledge_idempotency (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, knowledge_id TEXT NOT NULL, revision_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_state (key TEXT PRIMARY KEY, json TEXT NOT NULL, bytes INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS knowledge_extraction_status ON knowledge_state(
        json_extract(json,'$.job.status'),key,json_extract(json,'$.job.id'))
        WHERE key GLOB 'extraction.job:*';`);
    const hasSearch = this.database.prepare("SELECT 1 FROM sqlite_master WHERE name='knowledge_search'").get();
    this.database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_search USING fts5(search,content='knowledge_revisions',content_rowid='rowid',tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS knowledge_search_insert AFTER INSERT ON knowledge_revisions BEGIN
        INSERT INTO knowledge_search(rowid,search) VALUES(new.rowid,new.search);
      END;`);
    const version = this.database.pragma("user_version", { simple: true }) as number;
    this.database.transaction(() => {
      if (version < 2) {
        const rows = this.database.prepare("SELECT rowid,payload FROM knowledge_revisions").all() as { rowid: number; payload: string }[];
        const update = this.database.prepare("UPDATE knowledge_revisions SET search=? WHERE rowid=?");
        for (const row of rows) update.run(searchText(JSON.parse(row.payload) as KnowledgeDraft), row.rowid);
      }
      if (!hasSearch || version < 2) this.database.prepare("INSERT INTO knowledge_search(knowledge_search) VALUES('rebuild')").run();
      if (version < 2) this.database.pragma("user_version=2");
    })();
  }

  create(input: KnowledgeDraft, idempotencyKey?: string): KnowledgeDetail {
    const content = draft(input);
    return this.transaction(() => this.idempotent("create", content, idempotencyKey, () => {
      const id = randomUUID(), now = new Date().toISOString(), revisionId = randomUUID();
      this.database.prepare("INSERT INTO knowledge_entries(id,created_at,updated_at,latest) VALUES(?,?,?,?)").run(id, now, now, revisionId);
      this.insertRevision(id, revisionId, 1, undefined, content, now);
      this.audit(id, revisionId, "create", content.changeReason);
      return this.get(id, { review: "all", availability: "all" });
    }));
  }

  revise(id: string, input: KnowledgeRevisionInput, idempotencyKey?: string): KnowledgeDetail {
    const content = draft(input, true), base = text(input.baseRevisionId, "基础修订", 128, true)!;
    return this.transaction(() => this.idempotent(`revise:${id}`, { ...content, baseRevisionId: base }, idempotencyKey,
      () => this.append(id, base, content, "revise")));
  }

  restore(id: string, revisionId: string, baseRevisionId: string, idempotencyKey?: string): KnowledgeDetail {
    text(revisionId, "恢复修订", 128, true); text(baseRevisionId, "基础修订", 128, true);
    return this.transaction(() => this.idempotent(`restore:${id}`, { revisionId, baseRevisionId }, idempotencyKey, () => {
      const original = this.revisionRow(id, revisionId);
      const content = JSON.parse(original.payload) as KnowledgeDraft;
      return this.append(id, baseRevisionId, { ...content, changeReason: `恢复版本 ${original.version}` }, "restore");
    }));
  }

  private append(id: string, base: string, content: KnowledgeDraft, action: string): KnowledgeDetail {
    const entry = this.entryRow(id); if (entry.latest !== base) conflict("知识已有更新，请重新比较后提交");
    const previous = this.revisionRow(id, entry.latest), next = randomUUID(), now = new Date().toISOString();
    this.insertRevision(id, next, previous.version + 1, base, content, now);
    const changed = this.database.prepare("UPDATE knowledge_entries SET latest=?,updated_at=? WHERE id=? AND latest=?").run(next, now, id, base);
    if (!changed.changes) conflict("知识已有更新，请重新比较后提交");
    this.audit(id, next, action, content.changeReason);
    return this.get(id, { review: "all", availability: "all" });
  }

  private insertRevision(id: string, revisionId: string, version: number, base: string | undefined, content: KnowledgeDraft, now: string): void {
    const search = searchText(content);
    this.database.prepare("INSERT INTO knowledge_revisions(id,knowledge_id,version,base,review,created_at,payload,search) VALUES(?,?,?,?,?,?,?,?)")
      .run(revisionId, id, version, base ?? null, "pending", now, JSON.stringify(content), search);
  }

  get(id: string, options: { revisionId?: string; review?: KnowledgeReview | "all"; availability?: KnowledgeAvailability | "all" } = {}): KnowledgeDetail {
    object(options, ["revisionId", "review", "availability"], "读取选项");
    const entry = this.entryRow(id), review = choice(options.review, reviewValues, "审阅状态") ?? "reviewed";
    const availability = choice(options.availability, availabilityValues, "可用性") ?? "active";
    const selected = options.revisionId ? this.revisionRow(id, text(options.revisionId, "修订", 128, true)!) : this.selectRevision(entry, review);
    if (!selected || (review !== "all" && selected.review !== review)) throw new KnowledgeError("NOT_FOUND", "没有匹配的知识修订");
    const value = this.entry(entry, selected, review !== "reviewed");
    if (availability !== "all" && value.availability !== availability) throw new KnowledgeError("NOT_FOUND", "知识不在指定可用范围内");
    return { ...value, revisions: review === "all" ? this.revisions(id) : [revision(selected)],
      audit: this.auditRows(id).filter(item => review === "all" || !item.revisionId || item.revisionId === selected.id) };
  }

  list(input: KnowledgeQuery = {}): KnowledgeList {
    const query = object(input, ["q", "view", "project", "client", "type", "tag", "review", "availability", "from", "to", "taskId", "page", "pageSize"], "知识查询");
    const review = choice(query.review, reviewValues, "审阅状态") ?? "reviewed";
    const availability = choice(query.availability, availabilityValues, "可用性") ?? "active";
    const view = choice(query.view, ["all", "personal", "project", "general"] as const, "视图") ?? "all";
    const type = choice(query.type, knowledgeTypes, "知识类型");
    const page = this.positiveInteger(query.page, 1, 1_000_000), pageSize = this.positiveInteger(query.pageSize, 30, 200);
    const filters: string[] = [], values: (string | number)[] = [];
    const selected = review === "reviewed" ? "e.published" : review === "all"
      ? "CASE WHEN latest.review='pending' THEN e.latest ELSE COALESCE(e.published,e.latest) END" : "e.latest";
    if (review !== "all") { filters.push("r.review=?"); values.push(review); }
    // 显式废弃优先；时效与事项状态按所读取的修订判断，旧缓存不能使失效知识重新可用。
    const effective = "CASE WHEN e.availability<>'active' THEN e.availability WHEN json_extract(r.payload,'$.validUntil') IS NOT NULL AND julianday(json_extract(r.payload,'$.validUntil'))<=julianday('now') THEN 'expired' WHEN json_extract(r.payload,'$.resolved')=1 THEN 'resolved' ELSE 'active' END";
    if (availability !== "all") { filters.push(`${effective}=?`); values.push(availability); }
    if (view !== "all") {
      if (view === "personal") filters.push("json_extract(r.payload,'$.subject')='personal'");
      if (view === "project") filters.push("json_extract(r.payload,'$.scope.kind')='project'");
      if (view === "general") filters.push("(json_extract(r.payload,'$.subject')='general' OR (json_extract(r.payload,'$.scope.kind')='global' AND COALESCE(json_extract(r.payload,'$.subject'),'general')<>'personal'))");
    }
    for (const key of ["project", "client", "tag", "taskId"] as const) {
      const value = text(query[key], key, 4_096, query[key] !== undefined); if (value === undefined) continue;
      filters.push(key === "project" ? "json_extract(r.payload,'$.scope.project')=?" : key === "tag"
        ? "EXISTS(SELECT 1 FROM json_each(r.payload,'$.tags') t WHERE t.value=?)"
        : `EXISTS(SELECT 1 FROM json_each(r.payload,'$.sources') s WHERE json_extract(s.value,'$.${key}')=?)`);
      values.push(value);
    }
    if (type) { filters.push("json_extract(r.payload,'$.type')=?"); values.push(type); }
    const from = date(query.from, "起始时间"), to = date(query.to, "结束时间");
    if (from?.length === 10 && to?.length === 10 && from > to) invalid("起始时间不能晚于结束时间");
    const fromTime = from ? new Date(from.length === 10 ? `${from}T00:00:00` : from) : undefined;
    const toTime = to ? new Date(to.length === 10 ? `${to}T00:00:00` : to) : undefined;
    // 本机日历日期先转换为时间边界；次日使用日历加一天，保留夏令时的 23/25 小时日。
    if (to?.length === 10) toTime!.setDate(toTime!.getDate() + 1);
    if (fromTime && toTime && fromTime > toTime) invalid("起始时间不能晚于结束时间");
    if (fromTime) { filters.push("julianday(e.updated_at)>=julianday(?)"); values.push(fromTime.toISOString()); }
    if (toTime) { filters.push(to!.length === 10 ? "julianday(e.updated_at)<julianday(?)" : "julianday(e.updated_at)<=julianday(?)"); values.push(toTime.toISOString()); }
    const keywords = text(query.q, "关键词", 512)?.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean) ?? [];
    if (keywords.length > 20) invalid("关键词过多");
    // 三字及以上先用可重建的三元组索引缩小候选；短中文词仍按正文扫描，避免丢失结果。
    const indexed = keywords.filter(keyword => [...keyword].length >= 3);
    if (indexed.length) {
      filters.push("r.rowid IN (SELECT rowid FROM knowledge_search WHERE knowledge_search MATCH ?)");
      values.push(indexed.map(keyword => `"${keyword.replaceAll('"', '""')}"`).join(" AND "));
    }
    for (const keyword of keywords) { filters.push("instr(r.search,?)>0"); values.push(keyword); }
    const fromSql = `FROM knowledge_entries e JOIN knowledge_revisions latest ON latest.id=e.latest JOIN knowledge_revisions r ON r.id=${selected} ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}`;
    const count = this.database.prepare(`SELECT COUNT(*) total ${fromSql}`).get(...values) as { total: number };
    const rows = this.database.prepare(`SELECT e.*,r.id selected ${fromSql} ORDER BY e.updated_at DESC,e.id LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize) as SelectedRow[];
    return { items: rows.map(row => {
      const result = this.entry(row, this.revisionRow(row.id, row.selected), review !== "reviewed");
      if (keywords.length) Object.assign(result, this.snippet(result.revision, keywords));
      return result;
    }), total: count.total, page, pageSize };
  }

  revisions(id: string): KnowledgeRevision[] {
    this.entryRow(id);
    return (this.database.prepare("SELECT * FROM knowledge_revisions WHERE knowledge_id=? ORDER BY version DESC").all(id) as RevisionRow[]).map(revision);
  }

  /** 内容及人工状态的审计身份独立于任务进度，暖维护无需读取正文。 */
  semanticGeneration(): string {
    return (this.database.prepare("SELECT id FROM knowledge_audit ORDER BY rowid DESC LIMIT 1").get() as { id: string } | undefined)?.id ?? "empty";
  }

  semanticRevisions(): { id: string; review: KnowledgeReview }[] {
    return this.database.prepare(`SELECT r.id,r.review FROM knowledge_entries e JOIN knowledge_revisions r
      ON r.id=e.published OR (r.id=e.latest AND r.review='pending')
      WHERE e.availability='active' AND r.review IN ('reviewed','pending')
        AND (json_extract(r.payload,'$.validUntil') IS NULL OR julianday(json_extract(r.payload,'$.validUntil'))>julianday('now'))
        AND COALESCE(json_extract(r.payload,'$.resolved'),0)<>1 ORDER BY r.id`).all() as { id: string; review: KnowledgeReview }[];
  }

  semanticRevision(id: string): KnowledgeRevision {
    const row = this.database.prepare("SELECT * FROM knowledge_revisions WHERE id=?").get(id) as RevisionRow | undefined;
    if (!row) throw new KnowledgeError("NOT_FOUND", "知识修订不存在");
    return revision(row);
  }

  review(id: string, value: KnowledgeReviewInput): KnowledgeDetail {
    const input = object(value, ["revisionId", "action", "baseRevisionId", "reason"], "审阅");
    const revisionId = text(input.revisionId, "审阅修订", 128, true)!, base = text(input.baseRevisionId, "基础修订", 128);
    const action = choice(input.action, ["approve", "reject"] as const, "审阅操作"); if (!action) invalid("必须指定审阅操作");
    const reason = text(input.reason, "原因", 4_096);
    return this.transaction(() => {
      const row = this.entryRow(id), target = this.revisionRow(id, revisionId);
      if (row.latest !== revisionId || (base !== undefined && base !== row.latest)) conflict("待审建议已有更新，请重新比较");
      if (target.review !== "pending") conflict("该修订已经处理");
      this.database.prepare("UPDATE knowledge_revisions SET review=? WHERE id=? AND review='pending'").run(action === "approve" ? "reviewed" : "rejected", revisionId);
      this.database.prepare(`UPDATE knowledge_entries SET updated_at=?${action === "approve" ? ",published=?" : ""} WHERE id=?`).run(...(action === "approve" ? [new Date().toISOString(), revisionId, id] : [new Date().toISOString(), id]));
      this.audit(id, revisionId, action, reason);
      return this.get(id, { review: "all", availability: "all", revisionId });
    });
  }

  setAvailability(id: string, value: { availability: "active" | "deprecated" | "superseded"; reason?: string }): KnowledgeDetail {
    const input = object(value, ["availability", "reason"], "可用性设置"), availability = choice(input.availability, ["active", "deprecated", "superseded"] as const, "可用性");
    if (!availability) invalid("必须指定可用性");
    const reason = text(input.reason, "原因", 4_096);
    return this.transaction(() => {
      const row = this.entryRow(id);
      if (row.availability !== availability || (row.reason ?? undefined) !== reason) {
        this.database.prepare("UPDATE knowledge_entries SET availability=?,reason=?,updated_at=? WHERE id=?").run(availability, reason ?? null, new Date().toISOString(), id);
        this.audit(id, undefined, `availability:${availability}`, reason);
      }
      return this.get(id, { review: "all", availability: "all" });
    });
  }

  facets(): KnowledgeFacets {
    const select = "FROM knowledge_entries e JOIN knowledge_revisions r ON r.id IN (e.latest,e.published)";
    const projects = this.database.prepare(`SELECT DISTINCT json_extract(r.payload,'$.scope.project') value ${select} WHERE json_extract(r.payload,'$.scope.project') IS NOT NULL ORDER BY value`).all() as { value: string }[];
    const clients = this.database.prepare(`SELECT DISTINCT json_extract(s.value,'$.client') value ${select},json_each(r.payload,'$.sources') s WHERE json_extract(s.value,'$.client') IS NOT NULL ORDER BY value`).all() as { value: string }[];
    const tags = this.database.prepare(`SELECT DISTINCT t.value value ${select},json_each(r.payload,'$.tags') t ORDER BY t.value`).all() as { value: string }[];
    return { projects: projects.map(row => row.value), clients: clients.map(row => row.value), tags: tags.map(row => row.value) };
  }

  getState<T>(key: string): T | undefined {
    text(key, "状态键", 256, true);
    const row = this.database.prepare("SELECT json FROM knowledge_state WHERE key=?").get(key) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as T : undefined;
  }

  extractionJobSummary(id: string): KnowledgeJobSummary | undefined {
    const key = `extraction.job:${id}`; text(key, "状态键", 256, true);
    const row = this.database.prepare(`SELECT ${taskSummaryColumns} FROM knowledge_state state WHERE state.key=?`).get(key) as TaskSummaryRow | undefined;
    return row?.json ? taskSummary(row) : undefined;
  }

  /** 先按任务身份分页，再在 SQL 中投影；大结果与过程记录不进入解析及深克隆。 */
  extractionJobSummaries(ids: string[], page: number, pageSize: number, status?: KnowledgeJobSummary["status"]): { jobs: KnowledgeJobSummary[]; total: number } {
    const candidates = status === undefined ? `SELECT state.key,CAST(item.key AS INTEGER) AS position FROM json_each(?) item
      JOIN knowledge_state state ON state.key='extraction.job:'||item.value`
      : `SELECT state.key,CAST(item.key AS INTEGER) AS position FROM json_each(?) item
      CROSS JOIN knowledge_state state INDEXED BY knowledge_extraction_status
      WHERE state.key GLOB 'extraction.job:*' AND json_extract(state.json,'$.job.status')=?
        AND state.key='extraction.job:'||item.value`;
    const values = [JSON.stringify(ids), ...(status === undefined ? [] : [status]), pageSize, (page - 1) * pageSize];
    const rows = this.database.prepare(`WITH candidates AS MATERIALIZED (
      ${candidates}
    ), totals AS (SELECT COUNT(*) AS total FROM candidates), selected AS (
      SELECT key,position FROM candidates ORDER BY position DESC LIMIT ? OFFSET ?
    ) SELECT totals.total,${taskSummaryColumns} FROM totals LEFT JOIN selected ON 1
      LEFT JOIN knowledge_state state ON state.key=selected.key ORDER BY selected.position DESC`)
      .all(...values) as (TaskSummaryRow & { total: number })[];
    return { jobs: rows.filter(row => row.json !== null).map(taskSummary), total: rows[0]!.total };
  }

  /** 活动状态不读取任务正文、结果或输入预览。 */
  extractionActiveJobs(ids: string[]): Pick<KnowledgeJobSummary, "id" | "status">[] {
    return this.database.prepare(`SELECT json_extract(state.json,'$.job.id') AS id,json_extract(state.json,'$.job.status') AS status
      FROM knowledge_state state INDEXED BY knowledge_extraction_status CROSS JOIN json_each(?) item
      WHERE state.key GLOB 'extraction.job:*' AND json_extract(state.json,'$.job.status') IN ('queued','running')
        AND state.key='extraction.job:'||item.value ORDER BY CAST(item.key AS INTEGER)`)
      .all(JSON.stringify(ids)) as Pick<KnowledgeJobSummary, "id" | "status">[];
  }

  deleteState(key: string): void {
    text(key, "状态键", 256, true);
    this.database.prepare("DELETE FROM knowledge_state WHERE key=?").run(key);
  }

  setState(key: string, value: unknown): void {
    text(key, "状态键", 256, true);
    let json: string;
    try { json = JSON.stringify(value); } catch { invalid("状态必须可序列化为 JSON"); }
    if (json === undefined) invalid("状态必须为 JSON 值");
    const bytes = Buffer.byteLength(json); if (bytes > 8_388_608) invalid("单项任务状态过大");
    this.transaction(() => {
      const count = this.database.prepare("SELECT COUNT(*) count,COALESCE(SUM(bytes),0) bytes FROM knowledge_state WHERE key<>?").get(key) as { count: number; bytes: number };
      if (count.count >= 10_000 || count.bytes + bytes > 268_435_456) invalid("任务状态容量已满");
      this.database.prepare("INSERT INTO knowledge_state(key,json,bytes) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json,bytes=excluded.bytes").run(key, json, bytes);
    });
  }

  transaction<T>(operation: () => T): T {
    return this.database.transaction(() => {
      const result = operation();
      if (result && typeof result === "object" && "then" in result) invalid("知识事务回调必须同步执行");
      return result;
    }).immediate();
  }

  close(): void { if (this.database.open) this.database.close(); }

  private idempotent(operation: string, payload: unknown, key: string | undefined, execute: () => KnowledgeDetail): KnowledgeDetail {
    if (key === undefined) return execute();
    text(key, "幂等键", 256, true);
    const fingerprint = createHash("sha256").update(canonical({ operation, payload })).digest("hex");
    const old = this.database.prepare("SELECT fingerprint,knowledge_id,revision_id FROM knowledge_idempotency WHERE key=?").get(key) as { fingerprint: string; knowledge_id: string; revision_id: string } | undefined;
    if (old) {
      if (old.fingerprint !== fingerprint) conflict("同一幂等键不能用于不同内容或操作");
      return this.get(old.knowledge_id, { revisionId: old.revision_id, review: "all", availability: "all" });
    }
    const result = execute();
    this.database.prepare("INSERT INTO knowledge_idempotency(key,fingerprint,knowledge_id,revision_id) VALUES(?,?,?,?)").run(key, fingerprint, result.id, result.revision.id);
    return result;
  }

  private entryRow(id: string): EntryRow {
    text(id, "知识标识", 128, true);
    const row = this.database.prepare("SELECT * FROM knowledge_entries WHERE id=?").get(id) as EntryRow | undefined;
    if (!row) throw new KnowledgeError("NOT_FOUND", "知识不存在"); return row;
  }
  private revisionRow(id: string, revisionId: string): RevisionRow {
    const row = this.database.prepare("SELECT * FROM knowledge_revisions WHERE id=? AND knowledge_id=?").get(revisionId, id) as RevisionRow | undefined;
    if (!row) throw new KnowledgeError("NOT_FOUND", "知识修订不存在"); return row;
  }
  private selectRevision(entry: EntryRow, review: string): RevisionRow | undefined {
    if (review === "reviewed") return entry.published ? this.revisionRow(entry.id, entry.published) : undefined;
    const latest = this.revisionRow(entry.id, entry.latest);
    if (review === "all") return latest.review === "pending" || !entry.published ? latest : this.revisionRow(entry.id, entry.published);
    return latest.review === review ? latest : undefined;
  }
  private entry(row: EntryRow, selected: RevisionRow, includePending = false): KnowledgeEntry {
    const content = revision(selected), latest = this.revisionRow(row.id, row.latest);
    return { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, availability: effectiveAvailability(row, content),
      ...(row.reason !== null ? { availabilityReason: row.reason } : {}), ...(row.published ? { publishedRevisionId: row.published } : {}),
      latestRevisionId: row.latest, revision: content, ...(includePending && latest.review === "pending" ? { pendingRevision: revision(latest) } : {}) };
  }
  private audit(id: string, revisionId: string | undefined, action: string, reason?: string): void {
    this.database.prepare("INSERT INTO knowledge_audit(id,knowledge_id,revision_id,action,reason,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(), id, revisionId ?? null, action, reason ?? null, new Date().toISOString());
  }
  private auditRows(id: string): KnowledgeAudit[] {
    return (this.database.prepare("SELECT * FROM knowledge_audit WHERE knowledge_id=? ORDER BY rowid DESC").all(id) as { id: string; knowledge_id: string; revision_id: string | null; action: string; reason: string | null; created_at: string }[])
      .map(row => ({ id: row.id, knowledgeId: row.knowledge_id, ...(row.revision_id ? { revisionId: row.revision_id } : {}), action: row.action, ...(row.reason !== null ? { reason: row.reason } : {}), createdAt: row.created_at }));
  }
  private positiveInteger(value: unknown, fallback: number, max: number): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) invalid(`分页数值必须为 1 到 ${max} 的整数`);
    return value as number;
  }
  private snippet(content: KnowledgeDraft, keywords: string[]): Pick<KnowledgeEntry, "snippet" | "snippetField"> {
    const [snippetField, matched = ""] = searchFields(content).find(([, value]) => value && keywords.some(keyword => value.toLocaleLowerCase().includes(keyword))) ?? ["body", content.body];
    const body = ["title", "summary", "body"].includes(snippetField) ? [content.title, content.summary, content.body].filter(Boolean).join("\n") : matched;
    const lower = body.toLocaleLowerCase();
    const positions = keywords.map(keyword => lower.indexOf(keyword)).filter(position => position >= 0), start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 60);
    return { snippetField, snippet: `${start ? "…" : ""}${body.slice(start, start + 240)}${body.length > start + 240 ? "…" : ""}` };
  }
}
