import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionStore } from "../sessions/store.js";
import type { SemanticConfig, SemanticEngineStats, SemanticInput, SemanticJob, SemanticPreview, SemanticScope, SemanticSearchQuery, SemanticSearchResult, SemanticSettings, SemanticSettingsInput, SemanticStatus } from "../semantic-contracts.js";
import { encodingFingerprint, SemanticConfigStore, SemanticError, validateSemanticConfig } from "./config.js";
import { resolveModelConnection } from "./model-adapters.js";
import type { MessageDescriptor } from "../i18n/types.js";
import { semanticErrorDescriptor } from "./messages.js";
import { EmbeddingScheduler } from "./scheduler.js";

interface PersistedState {
  started?: boolean;
  requiresBuild?: boolean;
  job?: SemanticJob;
  preview?: { value: SemanticPreview; config: SemanticConfig; baseDigest: string };
}
interface PendingQuery { promise: Promise<number[]>; controller: AbortController; subscribers: number }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const emptyStats = (): SemanticEngineStats => ({ ready: false, indexedSessions: 0, indexedPositions: 0, uniqueVectors: 0, databaseBytes: 0 });

/** 正文扫描与向量排序分别使用 Worker，模型请求保持异步并受统一调度。 */
class EngineClient {
  private worker?: Worker;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  constructor(private readonly sourceDbPath: string, private readonly semanticDbPath: string) {}

  call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (!this.worker) {
      const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
      const url = new URL(`./worker.${extension}`, import.meta.url);
      const workerData = { sourceDbPath: this.sourceDbPath, semanticDbPath: this.semanticDbPath };
      const worker = extension === "ts"
        ? new Worker(`import('tsx/esm/api').then(({register}) => { register(); return import(${JSON.stringify(url.href)}); });`, { eval: true, workerData })
        : new Worker(url, { workerData });
      this.worker = worker;
      worker.on("message", (message: { id: number; result?: unknown; error?: { message: string; code?: string; messageDescriptor?: MessageDescriptor } }) => {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new SemanticError(message.error.code ?? "semantic_engine", message.error.message, undefined, undefined, message.error.messageDescriptor));
        else request.resolve(message.result);
      });
      const failed = (error: Error) => {
        if (this.worker !== worker) return;
        this.worker = undefined;
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
      };
      worker.on("error", failed);
      worker.on("exit", () => failed(new SemanticError("semantic_worker_stopped", "Semantic worker stopped")));
    }
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      try { this.worker!.postMessage({ id, method, args }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    if (worker) await worker.terminate();
  }
}

export class SemanticManager {
  activeJob(): Pick<SemanticJob, "id" | "status"> | undefined {
    const job = this.state.job;
    return job?.status === "running" ? { id: job.id, status: job.status } : undefined;
  }
  private readonly configStore: SemanticConfigStore;
  private readonly scheduler: EmbeddingScheduler;
  private readonly writer: EngineClient;
  private readonly reader: EngineClient;
  private readonly databasePath: string;
  private readonly statePath: string;
  private state: PersistedState = {};
  private readonly initialized: Promise<void>;
  private persistence = Promise.resolve();
  private mutations = Promise.resolve();
  private runner?: Promise<void>;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private changedAt?: number;
  private lastChangedAt?: number;
  private observedVersion?: string;
  private readonly queryCache = new Map<string, { createdAt: number; values: number[] }>();
  private readonly pendingQueries = new Map<string, PendingQuery>();
  private readonly results = new Map<string, SemanticSearchResult>();
  private configurationEpoch = 0;
  private resultEpoch = 0;

  constructor(private readonly home: string, private readonly sessions: SessionStore) {
    this.databasePath = join(home, "semantic", "vectors.sqlite");
    this.statePath = join(home, "semantic", "state.json");
    this.configStore = new SemanticConfigStore(home);
    this.scheduler = new EmbeddingScheduler(home, () => this.settings(), () => this.configStore.key());
    this.writer = new EngineClient(sessions.dbPath, this.databasePath);
    this.reader = new EngineClient(sessions.dbPath, this.databasePath);
    this.initialized = this.restore();
    void this.initialized.catch(() => undefined);
  }

  private async restore(): Promise<void> {
    try { this.state = JSON.parse(await readFile(this.statePath, "utf8")) as PersistedState; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (this.state.job?.status === "running") this.state.job.status = "paused";
    if (this.state.started) this.startTimer();
  }

  private async persist(): Promise<void> {
    const contents = JSON.stringify(this.state);
    this.persistence = this.persistence.catch(() => undefined).then(async () => {
      await mkdir(join(this.home, "semantic"), { recursive: true, mode: 0o700 });
      const temporary = `${this.statePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, this.statePath);
    });
    try { await this.persistence; }
    catch (error) { throw new SemanticError("semantic_persistence_failed", error instanceof Error ? error.message : String(error)); }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(operation);
    this.mutations = next.then(() => undefined, () => undefined);
    return next;
  }

  settings(): Promise<SemanticSettings> { return this.configStore.read(); }
  key(): Promise<string | undefined> { return this.configStore.key(); }

  async save(input: SemanticSettingsInput): Promise<SemanticSettings> {
    return this.exclusive(async () => {
      await this.initialized;
      const previous = await this.settings();
      const nextConfig = validateSemanticConfig(input.config);
      nextConfig.connection = resolveModelConnection(nextConfig.connection, previous.config.connection);
      const changed = encodingFingerprint(nextConfig) !== previous.fingerprint;
      const scopeChanged = digest(nextConfig.scope) !== digest(previous.config.scope);
      if (changed || !nextConfig.enabled) {
        this.configurationEpoch++;
        this.resultEpoch++;
        this.cancelQueries();
        this.scheduler.cancelQueued();
        await this.pause();
      }
      const result = await this.configStore.save({ ...input, config: nextConfig });
      if (changed || scopeChanged) { this.state.requiresBuild = true; this.state.preview = undefined; }
      if (changed) { this.queryCache.clear(); this.results.clear(); }
      await this.persist();
      return result;
    });
  }

  async test(body: { connection?: unknown; apiKey?: string | null }): Promise<{ dimensions: number; tokens?: number }> {
    const current = await this.settings();
    const config = validateSemanticConfig({ ...current.config, connection: body.connection ?? current.config.connection });
    config.connection = resolveModelConnection(config.connection, current.config.connection);
    const apiKey = body.apiKey === null ? undefined : body.apiKey ?? await this.key();
    const settings = { config, hasKey: Boolean(apiKey), fingerprint: encodingFingerprint(config) };
    const result = await this.scheduler.execute([config.connection.queryPrefix + "Local connection test."], "test", undefined, { settings, apiKey });
    return { dimensions: result.dimensions, tokens: result.tokens };
  }

  async facets(): Promise<{ models: string[]; projects: string[]; clients: string[] }> {
    return this.reader.call("facets");
  }

  async preview(scope?: SemanticScope): Promise<SemanticPreview> {
    return this.exclusive(async () => {
      await this.initialized;
      if (this.runner) throw new SemanticError("semantic_busy", "Pause the current build before previewing another plan");
      const current = await this.settings();
      const config = validateSemanticConfig({ ...current.config, scope: scope ?? current.config.scope });
      this.requireConnection(config);
      if (config.scope.timeRange === "unset") throw new SemanticError("semantic_scope_required", "Choose the history time range before building");
      const preview = await this.writer.call<SemanticPreview>("preview", config);
      this.state.job = undefined;
      this.state.preview = { value: preview, config, baseDigest: digest(current.config) };
      await this.persist();
      return preview;
    });
  }

  async build(previewId: string): Promise<SemanticStatus> {
    await this.exclusive(async () => {
      await this.initialized;
      if (this.runner) throw new SemanticError("semantic_busy", "A semantic build is already running");
      const current = await this.settings();
      const plan = this.state.preview;
      if (!plan || plan.value.id !== previewId || plan.baseDigest !== digest(current.config)
        || plan.value.sourceVersion !== this.sessions.currentVersion()) throw new SemanticError("semantic_preview_stale", "Preview changed; create a new preview before building");
      await this.configStore.save({ config: { ...plan.config, enabled: true } });
      const progress = await this.writer.call<Pick<SemanticJob, "totalInputs" | "completedInputs" | "reusedInputs">>("progress", previewId);
      this.state.started = true;
      this.state.requiresBuild = false;
      this.state.job = { id: randomUUID(), previewId, status: "running", phase: "encoding", ...progress, failedInputs: 0, createdAt: new Date().toISOString() };
      await this.persistAndLaunch();
      this.startTimer();
    });
    return this.status();
  }

  private async persistAndLaunch(): Promise<void> {
    try { await this.persist(); }
    catch (error) {
      if (this.state.job) this.failJob(this.state.job, error);
      throw error;
    }
    this.launch();
  }

  private launch(): void {
    this.runner = this.run().catch(error => {
      // 状态盘写失败也保留可见的内存失败状态，避免后台 Promise 未处理拒绝。
      const job = this.state.job;
      if (job) this.failJob(job, error);
    }).finally(() => { this.runner = undefined; });
  }

  private async run(): Promise<void> {
    const job = this.state.job!;
    try {
      while (!this.stopped && job.status === "running") {
        const { config, fingerprint } = await this.settings();
        if (!config.enabled || fingerprint !== this.state.preview?.value.fingerprint) { job.status = "paused"; break; }
        const batch = await this.writer.call<SemanticInput[]>("batch", job.previewId, config.strategy.batchSize * config.strategy.concurrency, config.strategy.batchTokens * config.strategy.concurrency);
        if (!batch.length) {
          if (job.status !== "running" || this.stopped) break;
          job.phase = "publishing";
          await this.persist();
          await this.writer.call("publish", job.previewId);
          this.resultEpoch++;
          job.status = "complete";
          job.phase = "complete";
          job.finishedAt = new Date().toISOString();
          this.observedVersion = this.state.preview?.value.sourceVersion;
          this.changedAt = undefined;
          this.lastChangedAt = undefined;
          this.results.clear();
          break;
        }
        const batches: SemanticInput[][] = [];
        for (const input of batch) {
          let target = batches.at(-1);
          if (!target || target.length >= config.strategy.batchSize || target.reduce((sum, item) => sum + item.estimatedTokens, 0) + input.estimatedTokens > config.strategy.batchTokens) {
            target = []; batches.push(target);
          }
          target.push(input);
        }
        const operations = await Promise.allSettled(batches.map(async items => {
          if (job.status !== "running" || this.stopped) return;
          try {
            const result = await this.scheduler.execute(items.map(item => item.text), "build");
            await this.writer.call("saveVectors", job.previewId, items.map((item, index) => ({ key: item.key, values: result.vectors[index]! })));
          } catch (error) {
            if (error instanceof SemanticError && error.code === "semantic_aborted" && job.status !== "running") return;
            if (!(error instanceof SemanticError) || error.code !== "semantic_input_too_long") throw error;
            for (const item of items) if (!await this.writer.call<boolean>("splitInput", job.previewId, item.key)) throw error;
          }
        }));
        const failed = operations.find((operation): operation is PromiseRejectedResult => operation.status === "rejected");
        if (failed) throw failed.reason;
        Object.assign(job, await this.writer.call("progress", job.previewId));
        await this.persist();
      }
    } catch (error) { this.failJob(job, error); }

    await this.persist();
  }

  private failJob(job: SemanticJob, error: unknown): void {
    job.status = error instanceof SemanticError && error.code === "semantic_budget_exceeded" ? "budget_stopped" : "failed";
    job.failedInputs += 1;
    job.error = error instanceof Error ? error.message : String(error);
    job.errorCode = error instanceof SemanticError ? error.code : "semantic_build_failed";
    job.errorDescriptor = semanticErrorDescriptor(job.errorCode);
    job.finishedAt = new Date().toISOString();
  }

  private async pause(): Promise<void> {
    if (this.state.job?.status === "running") this.state.job.status = "paused";
    this.scheduler.cancelQueued("build");
    await this.runner;
    await this.persist();
  }

  async action(action: string): Promise<SemanticStatus> {
    if (action === "update") {
      const preview = await this.preview();
      return this.build(preview.id);
    }
    await this.exclusive(async () => {
      await this.initialized;
      if (action === "pause") await this.pause();
      else if (action === "resume") {
        if (!this.state.job || this.state.job.status === "complete" || this.state.job.previewId !== this.state.preview?.value.id) throw new SemanticError("semantic_not_ready", "There is no paused build");
        if (this.runner) return;
        const current = await this.settings();
        if (current.fingerprint !== this.state.preview?.value.fingerprint) throw new SemanticError("semantic_preview_stale", "The model changed; preview a new build");
        await this.configStore.save({ config: { ...current.config, enabled: true } });
        Object.assign(this.state.job, { status: "running", error: undefined, errorCode: undefined, errorDescriptor: undefined, finishedAt: undefined });
        await this.persistAndLaunch();
      } else if (action === "disable" || action === "enable") {
        if (action === "disable") { this.configurationEpoch++; this.resultEpoch++; this.cancelQueries(); this.scheduler.cancelQueued(); await this.pause(); }
        const current = await this.settings();
        await this.configStore.save({ config: { ...current.config, enabled: action === "enable" } });
      } else if (action === "clear") {
        this.configurationEpoch++; this.resultEpoch++;
        this.cancelQueries();
        this.scheduler.cancelQueued();
        await this.pause();
        await this.writer.call("clear");
        this.state = {};
        this.queryCache.clear(); this.results.clear();
      } else throw new SemanticError("semantic_input_invalid", "Unknown semantic action");
      await this.persist();
    });
    return this.status();
  }

  async status(): Promise<SemanticStatus> {
    await this.initialized;
    const { config, fingerprint } = await this.settings();
    const stats = existsSync(this.databasePath) ? await this.reader.call<SemanticEngineStats>("stats", fingerprint) : emptyStats();
    return { ...stats, ready: config.enabled && stats.ready, enabled: config.enabled, fingerprint, job: this.state.job ? { ...this.state.job, errorDescriptor: this.state.job.errorDescriptor ?? semanticErrorDescriptor(this.state.job.errorCode) } : undefined, usage: await this.scheduler.usage() };
  }

  async search(query: SemanticSearchQuery, signal?: AbortSignal): Promise<SemanticSearchResult> {
    await this.initialized;
    const configurationEpoch = this.configurationEpoch;
    if (typeof query.q !== "string" || !query.q.trim() || query.q.length > 8192) throw new SemanticError("semantic_input_invalid", "Query must contain 1 to 8192 characters");
    const { config, fingerprint } = await this.settings();
    if (!config.enabled) throw new SemanticError("semantic_not_ready", "Semantic search is disabled");
    const stats = await this.reader.call<SemanticEngineStats>("stats", fingerprint);
    if (!stats.ready) throw new SemanticError("semantic_not_ready", "Build the semantic index before searching");
    const scope = validateSemanticConfig({ ...config, scope: query.scope }).scope;
    if (!stats.indexedPositions) return { version: this.sessions.currentVersion()!, mode: "semantic", groups: [], total: 0, hitCount: 0, page: 1, pageSize: query.pageSize ?? 25, limited: false, coveredSessions: 0 };
    if (signal?.aborted) throw new DOMException("Search cancelled", "AbortError");
    const text = config.connection.queryPrefix + query.q.trim();
    const apiKey = await this.key();
    if (configurationEpoch !== this.configurationEpoch) throw new SemanticError("semantic_not_ready", "Search configuration changed");
    const cacheKey = digest([fingerprint, text]);
    const cached = this.queryCache.get(cacheKey);
    let vector = cached && Date.now() - cached.createdAt < 30 * 60_000 ? cached.values : undefined;
    if (!vector) {
      if (query.cacheOnly) throw new SemanticError("semantic_query_cache_expired", "The query context expired; submit the search again");
      const pendingKey = `${configurationEpoch}:${cacheKey}`;
      let pending = this.pendingQueries.get(pendingKey);
      if (!pending || pending.controller.signal.aborted) {
        const entry: PendingQuery = { controller: new AbortController(), subscribers: 0, promise: Promise.resolve([]) };
        entry.promise = this.scheduler.execute([text], "query", entry.controller.signal, { settings: { config, fingerprint, hasKey: Boolean(apiKey) }, apiKey }).then(result => {
          if (configurationEpoch !== this.configurationEpoch) throw new SemanticError("semantic_not_ready", "Search configuration changed");
          const values = result.vectors[0]!;
          this.queryCache.delete(cacheKey);
          this.queryCache.set(cacheKey, { createdAt: Date.now(), values });
          while (this.queryCache.size > 256) this.queryCache.delete(this.queryCache.keys().next().value!);
          return values;
        }).finally(() => { if (this.pendingQueries.get(pendingKey) === entry) this.pendingQueries.delete(pendingKey); });
        pending = entry;
        this.pendingQueries.set(pendingKey, entry);
      }
      vector = await this.subscribeQuery(pending, signal);
    }
    if (signal?.aborted) throw new DOMException("Search cancelled", "AbortError");
    const latest = await this.settings();
    if (!latest.config.enabled || latest.fingerprint !== fingerprint || configurationEpoch !== this.configurationEpoch) throw new SemanticError("semantic_not_ready", "Search configuration changed");
    const resultEpoch = this.resultEpoch;
    const resultKey = digest([fingerprint, query.q.trim(), scope, query.sort, query.sessionId, this.sessions.currentVersion(), query.response]);
    let all = this.results.get(resultKey);
    if (!all) {
      all = await this.reader.call<SemanticSearchResult>("search", vector, { ...query, scope, page: 1, pageSize: 200 }, fingerprint);
      if (resultEpoch !== this.resultEpoch || configurationEpoch !== this.configurationEpoch || all.version !== this.sessions.currentVersion()) throw new SemanticError("semantic_not_ready", "Search index changed; search again");
      this.results.set(resultKey, all);
      while (this.results.size > 16) this.results.delete(this.results.keys().next().value!);
    }
    const pageSize = Math.min(200, Math.max(1, Math.floor(query.pageSize ?? 25)));
    const page = Math.min(Math.max(1, Math.ceil(all.total / pageSize)), Math.max(1, Math.floor(query.page ?? 1)));
    return { ...all, groups: all.groups.slice((page - 1) * pageSize, page * pageSize), page, pageSize };
  }

  private requireConnection(config: SemanticConfig): void {
    if (!config.connection.url || !config.connection.model || !config.connection.dimensions) throw new SemanticError("semantic_connection_required", "Configure and test an embedding connection first");
  }

  private subscribeQuery(query: PendingQuery, signal?: AbortSignal): Promise<number[]> {
    query.subscribers++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const release = () => {
        if (finished) return false;
        finished = true; query.subscribers--;
        signal?.removeEventListener("abort", cancel);
        return true;
      };
      const cancel = () => {
        if (!release()) return;
        if (!query.subscribers) query.controller.abort();
        reject(new DOMException("Search cancelled", "AbortError"));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      query.promise.then(values => { if (release()) resolve(values); }, error => { if (release()) reject(error); });
      if (signal?.aborted) cancel();
    });
  }

  private cancelQueries(): void {
    for (const query of this.pendingQueries.values()) query.controller.abort();
    this.pendingQueries.clear();
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, 5000);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking || !this.state.started || this.state.requiresBuild || this.runner
      || this.state.job?.status !== "complete") return;
    this.ticking = true;
    try {
      const { config } = await this.settings();
      if (!config.enabled) return;
      const version = this.sessions.currentVersion();
      this.observedVersion ??= this.state.preview?.value.sourceVersion;
      if (!version) return;
      const now = Date.now();
      if (version !== this.observedVersion) {
        this.changedAt ??= now;
        this.lastChangedAt = now;
        this.observedVersion = version;
      }
      if (version === this.state.preview?.value.sourceVersion) { this.changedAt = undefined; this.lastChangedAt = undefined; return; }
      if (this.changedAt && (now - this.lastChangedAt! >= config.strategy.quietMinutes * 60_000
        || now - this.changedAt >= config.strategy.maxDelayMinutes * 60_000)) {
        const preview = await this.preview();
        await this.build(preview.id);
      }
    } finally { this.ticking = false; }
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.configurationEpoch++;
    this.cancelQueries();
    this.scheduler.cancelQueued();
    if (this.timer) clearInterval(this.timer);
    const schedulerClosing = this.scheduler.close();
    await this.initialized.catch(() => undefined);
    try { await this.pause(); }
    catch (error) { if (this.state.job) this.failJob(this.state.job, error); }
    finally { await Promise.allSettled([schedulerClosing, this.writer.close(), this.reader.close()]); }
  }
}
