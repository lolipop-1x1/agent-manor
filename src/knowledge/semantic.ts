import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KnowledgeConfig, KnowledgeDraft, KnowledgeEntry, KnowledgeIndexPreview, KnowledgeIndexStatus, KnowledgeList, KnowledgeQuery, KnowledgeRevision, KnowledgeSettings } from "../knowledge-contracts.js";
import type { SemanticConnection, SemanticSettings } from "../semantic-contracts.js";
import { defaultSemanticConfig, normalizeEmbeddingUrl, SemanticError } from "../semantic/config.js";
import { EmbeddingScheduler } from "../semantic/scheduler.js";
import { KnowledgeStore } from "./store.js";
import type { MessageDescriptor } from "../i18n/types.js";

interface Configuration { fingerprint: string; settings: SemanticSettings; key?: string }
interface Chunk { revisionId: string; text: string; key: string }
interface IndexState { status: KnowledgeIndexStatus["status"]; fingerprint: string; total: number; completed: number; error?: string; errorDescriptor?: MessageDescriptor; consented?: string; keys?: string[] }
interface SettingsProvider { settings(): Promise<KnowledgeSettings>; key(kind: "embedding"): Promise<string | undefined> }
interface ReusedConnection { settings(): Promise<SemanticSettings>; key(): Promise<string | undefined> }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const textOf = (revision: KnowledgeRevision) => [revision.title, revision.summary, revision.body, revision.applicability, revision.tags?.join(" ")].filter(Boolean).join("\n\n");
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function chunkText(revision: KnowledgeRevision, connection: SemanticConnection): Chunk[] {
  const chunks: Chunk[] = [];
  let text = "";
  let bytes = 0;
  const flush = () => {
    if (text.trim()) { const value = connection.documentPrefix + text; chunks.push({ revisionId: revision.id, text: value, key: digest(value) }); }
    text = ""; bytes = 0;
  };
  for (const character of textOf(revision)) {
    const length = Buffer.byteLength(character);
    if (bytes + length > 1800) flush();
    text += character; bytes += length;
  }
  flush();
  return chunks;
}

/** 知识编码独立于会话索引；缓存命中也必须重新核对修订、范围和当前可用性。 */
export class KnowledgeSemantic {
  get busy(): boolean { return Boolean(this.runner) || this.checking; }
  private readonly db: Database.Database;
  private readonly scheduler: EmbeddingScheduler;
  private runner?: Promise<void>;
  private controller?: AbortController;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private checking = false;
  private readonly previews = new Map<string, { value: KnowledgeIndexPreview; chunks: Chunk[]; configuration: Configuration }>();

  constructor(home: string, private readonly store: KnowledgeStore, private readonly provider: SettingsProvider, private readonly reused: ReusedConnection) {
    const path = join(home, "knowledge", "vectors.sqlite");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS vectors(fingerprint TEXT NOT NULL,key TEXT NOT NULL,dimensions INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(fingerprint,key))");
    const state = this.state();
    if (state?.status === "running") this.persist({ ...state, status: "paused" });
    this.scheduler = new EmbeddingScheduler(join(home, "knowledge"), async () => (await this.configuration()).settings, async () => (await this.configuration()).key);
    this.timer = setInterval(() => { void this.maintain(); }, 5000);
    this.timer.unref();
  }

  private state(): IndexState | undefined { return this.store.getState<IndexState>("knowledge.semantic"); }
  private persist(value: IndexState): void { this.store.setState("knowledge.semantic", value); }
  private fail(code: "index_required" | "index_changed" | "preview_stale" | "busy", message: string): never {
    throw new SemanticError(`knowledge_${code}`, message, 409, undefined, { key: `knowledge.errors.${code}` });
  }
  private async configuration(input?: KnowledgeConfig): Promise<Configuration> {
    const config = input ?? (await this.provider.settings()).config;
    const embedding = config.embedding;
    if (embedding.mode === "off") this.fail("index_required", "Knowledge semantic search is disabled");
    const base = defaultSemanticConfig();
    const inherited = embedding.mode === "reuse" ? await this.reused.settings() : undefined;
    const connection = inherited?.config.connection ?? embedding.connection;
    if (!connection.url || !connection.model) this.fail("index_required", "An embedding connection is required");
    const fingerprint = digest({ recipe: 1, connection: { ...connection, url: normalizeEmbeddingUrl(connection.url) }, chunkBytes: 1800 });
    const settings: SemanticSettings = { config: { ...base, enabled: true, connection, strategy: {
      ...base.strategy, concurrency: 1, batchSize: 8, timeoutMs: embedding.timeoutMs, retries: embedding.retries,
      requestsPerMinute: embedding.requestsPerMinute, pricePerMillion: embedding.pricePerMillion, dailyBudget: embedding.dailyBudget,
    } }, hasKey: false, fingerprint };
    return { fingerprint, settings, key: inherited ? await this.reused.key() : await this.provider.key("embedding") };
  }

  /** 任务内候选只做短文本召回，不要求构建正式知识索引，也不改变知识审阅状态。 */
  async compareCandidates(candidate: KnowledgeDraft, others: readonly KnowledgeDraft[], config: KnowledgeConfig, signal?: AbortSignal): Promise<number[] | undefined> {
    if (config.embedding.mode === "off" || !others.length) return undefined;
    const configuration = await this.configuration(config), connection = configuration.settings.config.connection;
    const text = (item: KnowledgeDraft) => {
      const content = [item.title, item.summary, item.applicability, item.body, item.tags?.join(" ")].filter(Boolean).join("\n");
      // 召回材料有界；完整正文仍交给后续关系判断，不用分数代替证据校验。
      let bytes = 0, result = "";
      for (const character of content) { bytes += Buffer.byteLength(character); if (bytes > 1800) break; result += character; }
      return connection.documentPrefix + result;
    };
    const texts = [candidate, ...others].map(text), unique = [...new Set(texts)], values = new Map<string, number[]>();
    const fingerprint = digest({ candidateRecipe: 1, connection: { ...connection, url: normalizeEmbeddingUrl(connection.url) } });
    for (const value of unique) {
      const row = this.db.prepare("SELECT json FROM vectors WHERE fingerprint=? AND key=?").get(fingerprint, digest(value)) as { json: string } | undefined;
      if (row) values.set(value, JSON.parse(row.json) as number[]);
    }
    const pending = unique.filter(value => !values.has(value));
    for (let offset = 0; offset < pending.length; offset += 8) {
      const batch = pending.slice(offset, offset + 8), response = await this.scheduler.execute(batch, "query", signal, { settings: configuration.settings, apiKey: configuration.key });
      if (signal?.aborted) throw new SemanticError("semantic_cancelled", "Candidate comparison was cancelled", 499);
      if ((await this.configuration(config)).fingerprint !== configuration.fingerprint) this.fail("index_changed", "Embedding configuration changed during candidate matching");
      this.db.transaction(() => batch.forEach((value, index) => {
        const vector = response.vectors[index]!; values.set(value, vector);
        this.db.prepare("INSERT OR REPLACE INTO vectors VALUES(?,?,?,?)").run(fingerprint, digest(value), vector.length, JSON.stringify(vector));
      }))();
    }
    const query = values.get(texts[0]!)!, magnitude = (vector: number[]) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return texts.slice(1).map(value => {
      const vector = values.get(value)!, denominator = magnitude(query) * magnitude(vector);
      if (query.length !== vector.length || !denominator) this.fail("index_changed", "Candidate embedding dimensions changed");
      return query.reduce((sum, item, index) => sum + item * vector[index]!, 0) / denominator;
    });
  }

  private current(query: KnowledgeQuery = {}): KnowledgeEntry[] {
    const entries: KnowledgeEntry[] = [];
    for (let page = 1; ; page += 1) {
      const result = this.store.list({ ...query, page, pageSize: 200 });
      entries.push(...result.items);
      if (page * result.pageSize >= result.total) break;
    }
    return entries;
  }
  private revisions(): KnowledgeRevision[] {
    const result = new Map<string, KnowledgeRevision>();
    for (const review of ["reviewed", "pending"] as const) for (const entry of this.current({ review })) result.set(entry.revision.id, entry.revision);
    return [...result.values()];
  }
  private has(fingerprint: string, key: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM vectors WHERE fingerprint=? AND key=?").get(fingerprint, key)); }

  async status(): Promise<KnowledgeIndexStatus> {
    if ((await this.provider.settings()).config.embedding.mode === "off") return { status: "off", total: 0, completed: 0 };
    const configuration = await this.configuration();
    const state = this.state();
    if (!state || state.fingerprint !== configuration.fingerprint) return { status: "needs_build", total: 0, completed: 0, fingerprint: configuration.fingerprint };
    return { status: state.status, total: state.total, completed: state.completed, fingerprint: state.fingerprint, error: state.error, errorDescriptor: state.errorDescriptor };
  }
  async preview(): Promise<KnowledgeIndexPreview> {
    const configuration = await this.configuration();
    const revisions = this.revisions();
    const chunks = revisions.flatMap(revision => chunkText(revision, configuration.settings.config.connection));
    const pending = [...new Map(chunks.filter(chunk => !this.has(configuration.fingerprint, chunk.key)).map(chunk => [chunk.key, chunk])).values()];
    const estimatedTokens = pending.reduce((sum, chunk) => sum + Math.ceil(Buffer.byteLength(chunk.text) / 3) + 4, 0);
    const price = configuration.settings.config.strategy.pricePerMillion;
    const value: KnowledgeIndexPreview = { id: randomUUID(), total: pending.length,
      reviewed: revisions.filter(revision => revision.review === "reviewed").length,
      pending: revisions.filter(revision => revision.review === "pending").length,
      estimatedTokens, estimatedCost: price === undefined ? null : estimatedTokens * price / 1_000_000, fingerprint: configuration.fingerprint };
    this.previews.clear();
    this.previews.set(value.id, { value, chunks: pending, configuration });
    return value;
  }
  async build(previewId: string): Promise<KnowledgeIndexStatus> {
    if (this.runner) this.fail("busy", "A knowledge indexing task is already running");
    const preview = this.previews.get(previewId);
    if (!preview || preview.value.fingerprint !== (await this.configuration()).fingerprint) this.fail("preview_stale", "Knowledge index preview is stale");
    this.persist({ status: "running", fingerprint: preview.configuration.fingerprint, total: preview.chunks.length, completed: 0, consented: preview.configuration.fingerprint });
    this.launch(preview.chunks, preview.configuration);
    return this.status();
  }
  private launch(chunks: Chunk[], configuration: Configuration): void {
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.runner = this.run(chunks, configuration, signal).finally(() => { this.runner = undefined; this.controller = undefined; });
  }
  private async run(chunks: Chunk[], configuration: Configuration, signal: AbortSignal): Promise<void> {
    try {
      for (const chunk of chunks) {
        if (signal.aborted || this.closed) return;
        if ((await this.configuration()).fingerprint !== configuration.fingerprint) this.fail("index_changed", "Knowledge embedding configuration changed");
        if (!this.has(configuration.fingerprint, chunk.key)) {
          const result = await this.scheduler.execute([chunk.text], "build", signal, { settings: configuration.settings, apiKey: configuration.key });
          if (signal.aborted) return;
          if ((await this.configuration()).fingerprint !== configuration.fingerprint) this.fail("index_changed", "Knowledge embedding configuration changed");
          this.db.prepare("INSERT OR REPLACE INTO vectors VALUES (?,?,?,?)").run(configuration.fingerprint, chunk.key, result.dimensions, JSON.stringify(result.vectors[0]));
        }
        const state = this.state()!;
        this.persist({ ...state, completed: state.completed + 1 });
      }
      if (!signal.aborted) this.persist({ ...this.state()!, status: "ready" });
    } catch (error) {
      if (!signal.aborted) this.persist({ ...this.state()!, status: "failed", error: error instanceof Error ? error.message : String(error), errorDescriptor: error instanceof SemanticError ? error.messageDescriptor : { key: "knowledge.errors.index_failed" } });
    }
  }
  async action(action: "pause" | "resume"): Promise<KnowledgeIndexStatus> {
    const state = this.state();
    if (!state) this.fail("index_required", "Build the knowledge index first");
    if (action === "pause") {
      this.persist({ ...state, status: "paused" });
      this.controller?.abort();
      await this.runner;
    } else {
      if (this.runner) this.fail("busy", "Knowledge indexing is already running");
      const configuration = await this.configuration();
      if (configuration.fingerprint !== state.fingerprint) this.fail("index_changed", "Preview and rebuild after changing the embedding connection");
      const chunks = [...new Map(this.revisions().flatMap(revision => chunkText(revision, configuration.settings.config.connection))
        .filter(chunk => !this.has(configuration.fingerprint, chunk.key)).map(chunk => [chunk.key, chunk])).values()];
      this.persist({ ...state, status: "running", total: state.completed + chunks.length, error: undefined, errorDescriptor: undefined });
      this.launch(chunks, configuration);
    }
    return this.status();
  }
  private async maintain(): Promise<void> {
    if (this.closed || this.checking || this.runner) return;
    this.checking = true;
    try {
      const state = this.state();
      if (!state || state.status !== "ready") return;
      const configuration = await this.configuration();
      if (state.consented !== configuration.fingerprint) return;
      const chunks = [...new Map(this.revisions().flatMap(revision => chunkText(revision, configuration.settings.config.connection))
        .filter(chunk => !this.has(configuration.fingerprint, chunk.key)).map(chunk => [chunk.key, chunk])).values()];
      if (!chunks.length) return;
      this.persist({ ...state, status: "running", total: state.completed + chunks.length });
      this.launch(chunks, configuration);
    } catch { /* 未明确构建的新配置不自动编码；读取接口继续表达实际状态。 */ }
    finally { this.checking = false; }
  }

  async search(query: KnowledgeQuery): Promise<KnowledgeList> {
    if (!query.q?.trim()) return this.store.list(query);
    const configuration = await this.configuration();
    const state = this.state();
    if (!state || state.fingerprint !== configuration.fingerprint) this.fail("index_required", "Preview and build the knowledge semantic index first");
    const embedded = await this.scheduler.execute([configuration.settings.config.connection.queryPrefix + query.q], "query", undefined, { settings: configuration.settings, apiKey: configuration.key });
    const vector = embedded.vectors[0]!;
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    const ranked: KnowledgeEntry[] = [];
    // 先由权威知识存储筛选状态和范围，向量只参与排序。
    const entries = this.current({ ...query, q: undefined });
    for (const [index, entry] of entries.entries()) {
      let score = -Infinity;
      for (const chunk of chunkText(entry.revision, configuration.settings.config.connection)) {
        const row = this.db.prepare("SELECT json,dimensions FROM vectors WHERE fingerprint=? AND key=?").get(configuration.fingerprint, chunk.key) as { json: string; dimensions: number } | undefined;
        if (!row || row.dimensions !== vector.length) continue;
        const values = JSON.parse(row.json) as number[];
        const denominator = magnitude * Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
        score = Math.max(score, values.reduce((sum, value, position) => sum + value * vector[position]!, 0) / denominator);
      }
      if (Number.isFinite(score)) ranked.push({ ...entry, score });
      if (index % 100 === 0) await tick();
    }
    if ((await this.configuration()).fingerprint !== configuration.fingerprint) this.fail("index_changed", "Knowledge embedding configuration changed during the query");
    // 模型请求和分批排序期间可能发生审阅或废弃，返回前再次核验。
    const current = new Map(this.current({ ...query, q: undefined }).map(entry => [entry.id, entry.revision.id]));
    const valid = ranked.filter(entry => current.get(entry.id) === entry.revision.id).sort((a, b) => b.score! - a.score! || b.updatedAt.localeCompare(a.updatedAt));
    const page = query.page ?? 1, pageSize = query.pageSize ?? 50;
    return { items: valid.slice((page - 1) * pageSize, page * pageSize), total: valid.length, page, pageSize };
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.controller?.abort();
    await this.runner;
    await this.scheduler.close();
    this.db.close();
  }
}
