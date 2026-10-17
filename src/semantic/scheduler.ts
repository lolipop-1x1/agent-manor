import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EmbeddingResult, SemanticPurpose, SemanticSettings, SemanticUsage } from "../semantic-contracts.js";
import { SemanticError, writeSemanticJson } from "./config.js";
import { estimateTokens } from "./tokens.js";
import { embeddings } from "./embedding.js";

interface DailyLedger { usage: SemanticUsage; knownCost?: number; unpricedTokens?: number }
interface Ledger extends DailyLedger { day: string; previous?: Record<string, DailyLedger> }
interface RequestJob {
  texts: string[]; purpose: SemanticPurpose; settings: SemanticSettings; signal?: AbortSignal; overrideKey?: { apiKey?: string };
  resolve: (result: EmbeddingResult) => void; reject: (error: unknown) => void;
  estimate: number; attempts: number; retryError?: unknown; readyAt: number; running: boolean; cancelled: boolean; abort?: () => void;
}
interface RateEntry { at: number; tokens: number; job: RequestJob }

export function estimateEmbeddingTokens(texts: readonly string[]): number {
  // UTF-8 字节估算仅用于预留和限流；服务返回的用量另外记录。
  return texts.reduce((total, value) => total + estimateTokens(value), 0);
}
function emptyUsage(): SemanticUsage {
  return { requests: 0, estimatedTokens: 0, actualTokens: 0, actualRequests: 0, estimatedCost: 0, byPurpose: { build: { requests: 0, tokens: 0, cost: 0 }, query: { requests: 0, tokens: 0, cost: 0 }, test: { requests: 0, tokens: 0, cost: 0 } } };
}
function dayKey(): string { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function priority(purpose: SemanticPurpose): number { return purpose === "build" ? 1 : 0; }
function stopped(): SemanticError { return new SemanticError("semantic_closed", "模型调度已停止", 503); }
function aborted(): SemanticError { return new SemanticError("semantic_aborted", "模型请求已取消", 499); }
function retryable(error: unknown): boolean { return error instanceof SemanticError && ["semantic_rate_limited", "semantic_timeout", "semantic_network", "semantic_service"].includes(error.code); }
function safeDaily(value: unknown): value is DailyLedger {
  if (!value || typeof value !== "object") return false;
  const daily = value as DailyLedger, usage = daily.usage;
  const nonnegative = (number: unknown) => typeof number === "number" && Number.isFinite(number) && number >= 0;
  if (daily.knownCost !== undefined && !nonnegative(daily.knownCost) || daily.unpricedTokens !== undefined && !nonnegative(daily.unpricedTokens)) return false;
  if (!usage || typeof usage !== "object" || ![usage.requests, usage.estimatedTokens, usage.actualTokens, usage.actualRequests].every(nonnegative) || usage.estimatedCost !== null && !nonnegative(usage.estimatedCost)) return false;
  return ["build", "query", "test"].every(purpose => { const row = usage.byPurpose?.[purpose as SemanticPurpose]; return row && nonnegative(row.requests) && nonnegative(row.tokens) && (row.cost === null || nonnegative(row.cost)); });
}
function safeLedger(value: unknown): value is Ledger {
  if (!safeDaily(value)) return false;
  const stored = value as Ledger;
  if (typeof stored.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(stored.day)) return false;
  return stored.previous === undefined || Boolean(stored.previous && typeof stored.previous === "object" && !Array.isArray(stored.previous) && Object.values(stored.previous).every(safeDaily));
}

export class EmbeddingScheduler {
  private readonly directory: string;
  private readonly usagePath: string;
  private ledger?: Ledger;
  private ledgerWrites: Promise<void> = Promise.resolve();
  private queue: RequestJob[] = [];
  private rate: RateEntry[] = [];
  private active = 0;
  private pumping = false;
  private closed = false;
  private wake?: ReturnType<typeof setTimeout>;
  private readonly stopping = new AbortController();
  private readonly inflight = new Set<Promise<void>>();
  private readonly activeJobs = new Set<RequestJob>();

  constructor(home: string, private readonly getSettings: () => Promise<SemanticSettings>, private readonly getKey: () => Promise<string | undefined>) {
    this.directory = join(home, "semantic"); this.usagePath = join(this.directory, "usage.json");
  }

  private async loadLedger(): Promise<Ledger> {
    if (!this.ledger) {
      try { const value: unknown = JSON.parse(await readFile(this.usagePath, "utf8")); if (!safeLedger(value)) throw new Error(); this.ledger = value; }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw new SemanticError("semantic_usage_unreadable", "无法读取模型用量记录", 500); this.ledger = { day: dayKey(), usage: emptyUsage(), knownCost: 0, unpricedTokens: 0 }; }
    }
    if (this.ledger.day !== dayKey()) {
      const { day, usage, knownCost, unpricedTokens, previous = {} } = this.ledger;
      this.ledger = { day: dayKey(), usage: emptyUsage(), knownCost: 0, unpricedTokens: 0, previous: { ...previous, [day]: { usage, knownCost, unpricedTokens } } };
    }
    return this.ledger;
  }
  private transaction<T>(operation: (ledger: Ledger) => Promise<T>): Promise<T> {
    const result = this.ledgerWrites.then(async () => operation(await this.loadLedger()));
    this.ledgerWrites = result.then(() => undefined, () => undefined);
    return result;
  }
  private async persist(ledger: Ledger): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700);
    await writeSemanticJson(this.usagePath, ledger);
  }
  async usage(): Promise<SemanticUsage> { return this.transaction(async ledger => structuredClone(ledger.usage)); }

  private reserve(job: RequestJob): Promise<string> {
    return this.transaction(async ledger => {
      const strategy = job.settings.config.strategy, usage = ledger.usage;
      const cost = strategy.pricePerMillion === undefined ? null : job.estimate * strategy.pricePerMillion / 1_000_000;
      const knownCost = ledger.knownCost ?? usage.estimatedCost ?? 0;
      const unpricedTokens = ledger.unpricedTokens ?? (usage.estimatedCost === null ? usage.estimatedTokens + usage.actualTokens : 0);
      // 当日未定价调用仅在预算检查时按当前单价回估；对外用量仍保留费用未知。
      const budgetUsed = strategy.pricePerMillion === undefined ? null : knownCost + unpricedTokens * strategy.pricePerMillion / 1_000_000;
      if (strategy.dailyBudget !== undefined && (cost === null || budgetUsed === null || budgetUsed + cost > strategy.dailyBudget)) throw new SemanticError("semantic_budget_exceeded", "已达到每日模型调用预算", 429);
      const next = structuredClone(ledger);
      next.knownCost = knownCost + (cost ?? 0); next.unpricedTokens = unpricedTokens + (cost === null ? job.estimate : 0);
      next.usage.requests++; next.usage.estimatedTokens += job.estimate;
      next.usage.estimatedCost = usage.estimatedCost === null || cost === null ? null : usage.estimatedCost + cost;
      const purpose = next.usage.byPurpose[job.purpose];
      purpose.requests++; purpose.tokens += job.estimate;
      purpose.cost = purpose.cost === null || cost === null ? null : purpose.cost + cost;
      await this.persist(next); this.ledger = next;
      return next.day;
    });
  }
  private settle(job: RequestJob, tokens: number, reservationDay: string): Promise<void> {
    return this.transaction(async ledger => {
      // 跨午夜返回的响应归入预留当日，不混入下一日的预算。
      const next = structuredClone(ledger), daily = next.day === reservationDay ? next : next.previous?.[reservationDay];
      if (!daily) return;
      const usage = daily.usage, difference = tokens - job.estimate;
      usage.estimatedTokens = Math.max(0, usage.estimatedTokens - job.estimate); usage.actualTokens += tokens; usage.actualRequests++;
      usage.byPurpose[job.purpose].tokens += difference;
      const price = job.settings.config.strategy.pricePerMillion;
      if (price !== undefined) {
        daily.knownCost = Math.max(0, (daily.knownCost ?? usage.estimatedCost ?? 0) + difference * price / 1_000_000);
        if (usage.estimatedCost !== null) usage.estimatedCost = Math.max(0, usage.estimatedCost + difference * price / 1_000_000);
        const purpose = usage.byPurpose[job.purpose];
        if (purpose.cost !== null) purpose.cost = Math.max(0, purpose.cost + difference * price / 1_000_000);
      } else daily.unpricedTokens = Math.max(0, (daily.unpricedTokens ?? usage.estimatedTokens + usage.actualTokens - difference) + difference);
      await this.persist(next); this.ledger = next;
    });
  }

  private refund(job: RequestJob, reservationDay: string): Promise<void> {
    return this.transaction(async ledger => {
      const next = structuredClone(ledger), daily = next.day === reservationDay ? next : next.previous?.[reservationDay];
      if (!daily) return;
      const usage = daily.usage, purpose = usage.byPurpose[job.purpose], price = job.settings.config.strategy.pricePerMillion;
      usage.requests--; usage.estimatedTokens = Math.max(0, usage.estimatedTokens - job.estimate);
      purpose.requests--; purpose.tokens = Math.max(0, purpose.tokens - job.estimate);
      if (price === undefined) daily.unpricedTokens = Math.max(0, (daily.unpricedTokens ?? job.estimate) - job.estimate);
      else {
        const cost = job.estimate * price / 1_000_000;
        daily.knownCost = Math.max(0, (daily.knownCost ?? usage.estimatedCost ?? cost) - cost);
        if (purpose.cost !== null) purpose.cost = Math.max(0, purpose.cost - cost);
      }
      usage.estimatedCost = daily.unpricedTokens ? null : daily.knownCost ?? 0;
      if (!purpose.requests) purpose.cost = 0;
      await this.persist(next); this.ledger = next;
    });
  }

  /** 取消尚未发出的请求及退避重试；已发请求保留响应，但不再重试。 */
  cancelQueued(purpose?: SemanticPurpose): void {
    for (const job of this.activeJobs) if (purpose === undefined || job.purpose === purpose) job.cancelled = true;
    const retained: RequestJob[] = [];
    for (const job of this.queue) {
      if (purpose === undefined || job.purpose === purpose) { job.cancelled = true; this.finish(job, aborted()); }
      else retained.push(job);
    }
    this.queue = retained; this.kick();
  }

  async execute(texts: string[], purpose: SemanticPurpose, signal?: AbortSignal, override?: { settings: SemanticSettings; apiKey?: string }): Promise<EmbeddingResult> {
    if (this.closed) throw stopped();
    if (signal?.aborted) throw aborted();
    if (!texts.length || texts.some(text => typeof text !== "string" || !text.trim())) throw new SemanticError("semantic_input_invalid", "模型输入不能为空", 400);
    if (!["build", "query", "test"].includes(purpose)) throw new SemanticError("semantic_input_invalid", "模型调用用途无效", 400);
    const settings = structuredClone(override?.settings ?? await this.getSettings());
    if (this.closed) throw stopped();
    if (signal?.aborted) throw aborted();
    if (!settings.config.connection.url || !settings.config.connection.model) throw new SemanticError("semantic_config_invalid", "请先配置模型连接", 400);
    return new Promise<EmbeddingResult>((resolve, reject) => {
      const job: RequestJob = { texts: [...texts], purpose, settings, signal, overrideKey: override ? { apiKey: override.apiKey } : undefined, resolve, reject, estimate: estimateEmbeddingTokens(texts), attempts: 0, readyAt: 0, running: false, cancelled: false };
      job.abort = () => {
        if (job.running) return;
        const index = this.queue.indexOf(job);
        if (index < 0) return;
        this.queue.splice(index, 1); this.finish(job, aborted()); this.kick();
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job); this.kick();
    });
  }

  private finish(job: RequestJob, error?: unknown, result?: EmbeddingResult): void {
    if (job.abort) job.signal?.removeEventListener("abort", job.abort);
    if (error) job.reject(error); else job.resolve(result!);
  }
  private kick(): void {
    if (this.wake) { clearTimeout(this.wake); this.wake = undefined; }
    if (!this.pumping && !this.closed) void this.pump();
  }
  private delay(job: RequestJob, now: number, current?: RateEntry): number {
    this.rate = this.rate.filter(entry => now - entry.at < 60_000);
    const rate = this.rate.filter(entry => entry !== current);
    const { requestsPerMinute: rpm, tokensPerMinute: tpm } = job.settings.config.strategy;
    if (tpm > 0 && job.estimate > tpm) throw new SemanticError("semantic_rate_limit_input", "单次输入超过每分钟 token 限额，请缩小批次或提高限额", 400);
    let delay = Math.max(0, job.readyAt - now);
    if (rpm > 0 && rate.length >= rpm) delay = Math.max(delay, rate[rate.length - rpm]!.at + 60_000 - now);
    if (tpm > 0) {
      let tokens = rate.reduce((sum, entry) => sum + entry.tokens, 0);
      for (const entry of rate) { if (tokens + job.estimate <= tpm) break; tokens -= entry.tokens; delay = Math.max(delay, entry.at + 60_000 - now); }
    }
    return delay;
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (!this.closed && this.queue.length) {
        const now = Date.now();
        const ready = this.queue.filter(job => job.readyAt <= now).sort((a, b) => priority(a.purpose) - priority(b.purpose));
        const job = ready[0];
        if (!job) { this.wake = setTimeout(() => this.kick(), Math.min(2_147_000_000, Math.max(1, Math.min(...this.queue.map(item => item.readyAt)) - now))); break; }
        try { job.settings.config.strategy = structuredClone((await this.getSettings()).config.strategy); }
        catch (error) { const index = this.queue.indexOf(job); if (index >= 0) { this.queue.splice(index, 1); this.finish(job, error); } continue; }
        if (this.closed) break;
        if (!this.queue.includes(job)) continue;
        if (job.attempts > job.settings.config.strategy.retries) { this.queue.splice(this.queue.indexOf(job), 1); this.finish(job, job.retryError); continue; }
        if (this.active >= job.settings.config.strategy.concurrency) break;
        if (this.queue.some(other => other.readyAt <= Date.now() && priority(other.purpose) < priority(job.purpose))) continue;
        let wait: number;
        try { wait = this.delay(job, now); } catch (error) { this.queue.splice(this.queue.indexOf(job), 1); this.finish(job, error); continue; }
        if (wait > 0) { this.wake = setTimeout(() => this.kick(), Math.min(1000, wait)); break; }
        this.queue.splice(this.queue.indexOf(job), 1);
        if (job.signal?.aborted) { this.finish(job, aborted()); continue; }
        job.running = true; this.active++; this.activeJobs.add(job);
        const rateEntry = { at: Date.now(), tokens: job.estimate, job }; this.rate.push(rateEntry);
        const operation = this.run(job, rateEntry).finally(() => { this.active--; this.activeJobs.delete(job); this.inflight.delete(operation); this.kick(); });
        this.inflight.add(operation);
      }
    } finally { this.pumping = false; }
  }
  private async run(job: RequestJob, rateEntry: RateEntry): Promise<void> {
    let reserved = false;
    try {
      const apiKey = job.overrideKey ? job.overrideKey.apiKey : await this.getKey();
      if (this.closed) throw stopped();
      if (job.signal?.aborted || job.cancelled) throw aborted();
      // 向量身份保持入队时的配置，调用策略在每次真正发送前读取最新值。
      job.settings.config.strategy = structuredClone((await this.getSettings()).config.strategy);
      if (this.closed) throw stopped();
      if (job.signal?.aborted || job.cancelled) throw aborted();
      if (job.attempts > job.settings.config.strategy.retries) throw job.retryError;
      const now = Date.now(), wait = this.delay(job, now, rateEntry);
      if (wait > 0) {
        this.rate = this.rate.filter(entry => entry !== rateEntry); job.running = false; job.readyAt = now + wait;
        this.queue.push(job); return;
      }
      rateEntry.at = now;
      if (!this.rate.includes(rateEntry)) this.rate.push(rateEntry);
      const day = await this.reserve(job);
      reserved = true;
      if (job.cancelled || this.closed || job.signal?.aborted) { await this.refund(job, day); reserved = false; throw aborted(); }
      const signal = job.signal ? AbortSignal.any([job.signal, this.stopping.signal]) : this.stopping.signal;
      const result = await embeddings(job.settings.config.connection, apiKey, job.texts, { timeoutMs: job.settings.config.strategy.timeoutMs, signal });
      if (result.tokens !== undefined) {
        rateEntry.tokens = result.tokens;
        await this.settle(job, result.tokens, day);
      }
      this.finish(job, undefined, result);
    } catch (error) {
      if (!reserved) this.rate = this.rate.filter(entry => entry !== rateEntry);
      if (reserved && !job.cancelled && !this.closed && !job.signal?.aborted && retryable(error) && job.attempts < job.settings.config.strategy.retries) {
        job.attempts++; job.running = false; job.retryError = error;
        const retryAfter = error instanceof SemanticError ? error.retryAfterMs ?? 0 : 0;
        job.readyAt = Date.now() + Math.max(retryAfter, Math.min(30_000, 500 * 2 ** (job.attempts - 1)));
        this.queue.push(job);
      } else this.finish(job, job.cancelled ? aborted() : error);
    }
  }
  async close(): Promise<void> {
    this.closed = true; this.stopping.abort();
    if (this.wake) { clearTimeout(this.wake); this.wake = undefined; }
    for (const job of this.queue.splice(0)) this.finish(job, stopped());
    await Promise.allSettled([...this.inflight]); await this.ledgerWrites;
  }
}
