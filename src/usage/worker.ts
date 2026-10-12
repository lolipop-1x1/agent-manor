import { setImmediate as nextTurn } from "node:timers/promises";
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { StoreError } from "../index/store.js";
import { ServiceError } from "../service/input.js";
import { SessionStore } from "../sessions/store.js";
import type { UsageFactMetadata } from "../sessions/usage-facts.js";
import type { PricingStatus, UsagePreparationStatus, UsageQuery, UsageSource } from "../usage-contracts.js";
import { accumulator, add, buildUsageReport, buildUsageRequestPage, coverageOf, instant, queryOf, timeKeys } from "./analytics.js";
import { UsageResultCache } from "./cache.js";
import { createPricingEstimator } from "./pricing.js";
import { buildUsageRollup, buildUsageRollupReport, canUseUsageRollup, combineUsageRollups } from "./rollup.js";
import type { UsageRollup } from "./rollup-contracts.js";
import { UsageRollupStore } from "./rollup-store.js";
import { preparationKey } from "./worker-contracts.js";
import type { UsageWorkerRequest, UsageWorkerResponse } from "./worker-contracts.js";

const port = parentPort!;
const { dbPath, cachePath } = workerData as { dbPath: string; cachePath: string };
const sessions = new SessionStore(dbPath), persisted = new UsageRollupStore(cachePath);
const revisions = new Database(dbPath, { readonly: true });
const combined = new UsageResultCache<UsageRollup>(128 * 1024 * 1024, 2);
const compactSources = new UsageResultCache<UsageSource>(64 * 1024 * 1024, 1);
interface RollupSource { version: string; sessions: ReturnType<SessionStore["usageFactSessions"]>["sessions"] }
interface Waiter { query: UsageQuery; required?: Set<string>; resolve(rollup: UsageRollup): void; reject(error: unknown): void }
interface PreparationJob {
  query: UsageQuery; progress: UsagePreparationStatus; source?: RollupSource; metadata?: Map<string, UsageFactMetadata>;
  parts: Map<string, UsageRollup>; partBytes: number; waiters: Waiter[]; completion?: Promise<UsageRollup>;
}
const preparing = new Map<string, PreparationJob>(), reading = new Map<string, Promise<UsageSource>>();
const combinedRollupSafetyBytes = 1024;

const send = (message: UsageWorkerResponse) => port.postMessage(message);
const update = (status: UsagePreparationStatus) => send({ type: "status", status });

function validate(query: UsageQuery, pricing: PricingStatus): UsageQuery {
  const version = sessions.usageVersion(query.version);
  const fixed = queryOf(query, { version, sessions: [], requests: [] }, pricing);
  timeKeys(fixed.timezone!, "hour");
  return fixed;
}

function cachedRollup(query: UsageQuery): UsageRollup | undefined {
  const cached = combined.get(preparationKey(query));
  if (cached) update({ state: "ready", version: query.version, priceVersion: query.priceVersion, timezone: query.timezone,
    preparedSessions: cached.sessions.length, totalSessions: cached.sessions.length });
  return cached;
}

function requiredRevisions(query: UsageQuery, metadata: Map<string, UsageFactMetadata>): Set<string> {
  // 当地日期边界保守扩展一天，覆盖全部时区偏移、夏令时和日期变更线，不漏任何可能相交的修订。
  const day = 86_400_000;
  const from = query.from ? Date.parse(`${query.from}T00:00:00Z`) - day : -Infinity;
  const to = query.to ? Date.parse(`${query.to}T00:00:00Z`) + 2 * day : Infinity;
  return new Set([...metadata.values()].filter(value => value.undatedCount > 0 || value.hasUsage
    && value.maxTime !== undefined && value.minTime !== undefined && value.maxTime >= from && value.minTime < to).map(value => value.revision));
}

function assembled(job: PreparationJob): UsageRollup {
  const source = job.source!, metadata = job.metadata!;
  const parts = source.sessions.map(({ revision, session }) => job.parts.get(revision) ?? {
    version: source.version, timezone: job.query.timezone!, sessions: [], cells: [],
    sessionIdsWithUsage: metadata.get(revision)!.hasUsage ? [session.id] : [], models: metadata.get(revision)!.models,
  });
  return combineUsageRollups(parts, source.version, source.sessions.map(item => item.session), job.query.timezone);
}

function releaseReady(job: PreparationJob): void {
  if (!job.metadata) return;
  const pending: Waiter[] = [];
  let rollup: UsageRollup | undefined;
  for (const waiter of job.waiters) {
    waiter.required ??= requiredRevisions(waiter.query, job.metadata);
    if ([...waiter.required].some(revision => !job.parts.has(revision))) { pending.push(waiter); continue; }
    // 仅返回查询必需的数据；未准备的历史用元数据补齐全集 facets，不能写入全量 family 缓存。
    rollup ??= assembled(job);
    waiter.resolve(rollup);
  }
  job.waiters = pending;
}

async function ensureFacts(source: RollupSource): Promise<void> {
  for (let start = 0; start < source.sessions.length; start += 64) {
    sessions.ensureUsageFactsBatch(source.sessions.slice(start, start + 64).map(item => item.revision));
    await nextTurn();
  }
}

async function foregroundTurn(job: PreparationJob): Promise<void> {
  // 历史预热在修订边界让出，新版本、价格或时区的前台查询不排在旧 family 全历史之后。
  while (!job.waiters.length && [...preparing.values()].some(other => other !== job && other.waiters.length)) await nextTurn();
}

/** family 在批次和修订边界协作调度，SQLite 操作仍在单个 Worker 内同步执行。 */
function preparationJob(query: UsageQuery, pricing: PricingStatus): PreparationJob {
  const key = preparationKey(query), current = preparing.get(key);
  if (current) return current;
  const job: PreparationJob = { query, progress: { state: "preparing", version: query.version, priceVersion: pricing.version,
    timezone: query.timezone, preparedSessions: 0, totalSessions: 0 }, parts: new Map(), partBytes: 0, waiters: [] };
  update(job.progress);
  const completion = Promise.resolve().then(async () => {
    const source = sessions.usageFactSessions(query.version), estimate = createPricingEstimator(pricing);
    job.progress.totalSessions = source.sessions.length; update(job.progress);
    // 全局筛选和无用量会话需要完整事实身份，先补事实再用请求时间安排汇总，不能按会话开始时间排序。
    await ensureFacts(source);
    job.source = source;
    job.metadata = new Map(sessions.usageFactMetadata(source.sessions.map(item => item.revision)).map(value => [value.revision, value]));
    const remaining = source.sessions.filter(({ revision, session }) => {
      const cached = persisted.getWithBytes(revision, session.client, pricing.version, query.timezone!);
      const part = cached?.rollup;
      if (!part) return true;
      job.parts.set(revision, part); job.partBytes += cached.bytes; job.progress.preparedSessions += 1; return false;
    });
    const recent = Date.now() - 30 * 86_400_000;
    remaining.sort((left, right) => {
      const leftTime = job.metadata!.get(left.revision)!.maxTime ?? -Infinity;
      const rightTime = job.metadata!.get(right.revision)!.maxTime ?? -Infinity;
      return Number(rightTime >= recent) - Number(leftTime >= recent) || rightTime - leftTime
        || left.session.id.localeCompare(right.session.id);
    });
    releaseReady(job); update(job.progress);
    // 先让已命中的前台 waiter 返回，避免紧接着计算一个大型历史修订。
    await nextTurn();
    let lastUpdate = Date.now();
    while (remaining.length) {
      await foregroundTurn(job);
      const needed = job.waiters.map(waiter => [...(waiter.required ?? [])].filter(revision => !job.parts.has(revision)))
        .filter(values => values.length).sort((left, right) => left.length - right.length)[0];
      const priority = needed ? remaining.findIndex(item => needed.includes(item.revision)) : -1;
      const { revision, session } = remaining.splice(priority < 0 ? 0 : priority, 1)[0]!;
      // 新旧分析版本可交错准备相同修订，重新检查其他 family 在上一分片完成的持久结果。
      const cached = persisted.getWithBytes(revision, session.client, pricing.version, query.timezone!);
      let part: UsageRollup;
      if (cached) {
        part = cached.rollup; job.partBytes += cached.bytes;
      } else {
        part = buildUsageRollup({ version: source.version, sessions: [session],
          requests: sessions.usageFacts(revision).map(usage => ({ sessionId: session.id, usage })) }, query.timezone!, estimate);
        // 当前版本摘要在组合时提供，持久化项只存不可变修订的用量和预览。
        part.sessions = []; job.partBytes += persisted.put(revision, session.client, pricing.version, query.timezone!, part);
      }
      job.parts.set(revision, part); job.progress.preparedSessions += 1;
      releaseReady(job);
      if (Date.now() - lastUpdate >= 100 || !remaining.length) {
        update(job.progress); lastUpdate = Date.now();
      }
      await nextTurn();
    }
    const rollup = assembled(job);
    // 分片字节覆盖 cells 和 facets；只补当前会话摘要及外层结构，避免序列化全量组合结果。
    const headerBytes = Buffer.byteLength(JSON.stringify({ version: source.version, timezone: query.timezone!, sessions: source.sessions,
      cells: [], sessionIdsWithUsage: [], models: [] }));
    combined.set(key, rollup, job.partBytes + headerBytes + combinedRollupSafetyBytes);
    persisted.touch(pricing.version, query.timezone!);
    persisted.prune((revisions.prepare("SELECT id FROM session_revisions").all() as { id: string }[]).map(row => row.id));
    update({ ...job.progress, state: "ready" });
    return rollup;
  }).catch(error => {
    for (const waiter of job.waiters) waiter.reject(error);
    job.waiters = []; update({ ...job.progress, state: "failed" }); throw error;
  }).finally(() => { if (preparing.get(key) === job) preparing.delete(key); });
  job.completion = completion; preparing.set(key, job);
  // 提前返回的范围查询不再等待全量 completion，历史阶段失败仍需消费拒绝并发送独立状态。
  void completion.catch(() => undefined);
  return job;
}

function prepare(query: UsageQuery, pricing: PricingStatus): Promise<UsageRollup> {
  const cached = cachedRollup(query);
  return cached ? Promise.resolve(cached) : preparationJob(query, pricing).completion!;
}

function queryRollup(query: UsageQuery, pricing: PricingStatus): Promise<UsageRollup> {
  const cached = cachedRollup(query);
  if (cached) return Promise.resolve(cached);
  const job = preparationJob(query, pricing);
  return new Promise((resolve, reject) => {
    job.waiters.push({ query, resolve, reject }); releaseReady(job); update(job.progress);
  });
}

/** 精确边界和费用比较只加载结构化事实，顺序与旧实时分析保持一致。 */
function compactSource(version: string): Promise<UsageSource> {
  const cached = compactSources.get(version);
  if (cached) return Promise.resolve(cached);
  const pending = reading.get(version);
  if (pending) return pending;
  const result = (async () => {
    const metadata = sessions.usageFactSessions(version);
    const source: UsageSource = { version, sessions: metadata.sessions.map(item => item.session), requests: [] };
    await ensureFacts(metadata);
    for (const { revision, session } of metadata.sessions) {
      for (const usage of sessions.usageFacts(revision)) source.requests.push({ sessionId: session.id, usage });
      await nextTurn();
    }
    compactSources.set(version, source);
    return source;
  })().finally(() => reading.delete(version));
  reading.set(version, result);
  return result;
}

async function handle(message: UsageWorkerRequest): Promise<void> {
  try {
    const query = validate(message.query, message.pricing), estimate = createPricingEstimator(message.pricing);
    let result;
    if (message.type === "sessionCost") {
      const total = accumulator();
      // 只读当前画像范围的精简事实；价格缓存不进入纯画像摘要，也不等待全历史汇总。
      for (const sessionId of message.sessionIds!) {
        const target = sessions.usageFactSession(query.version!, sessionId);
        if (!target) throw new StoreError("SOURCE_NOT_FOUND", "会话不存在于当前索引版本", { key: "diagnostics.sessions.store.m011" });
        sessions.ensureUsageFacts(target.revision);
        for (const usage of sessions.usageFacts(target.revision)) {
          add(total, { session: target.session, usage, cost: estimate(usage, target.session.client), coverage: coverageOf(usage), time: instant(usage.occurredAt) });
        }
        await nextTurn();
      }
      result = { version: query.version!, priceVersion: message.pricing.version, currency: message.pricing.currency,
        scope: message.scope!, sessionIds: message.sessionIds!, totals: total.totals };
    } else if (message.type === "requests") {
      const target = sessions.usageFactSession(query.version!, message.sessionId!);
      if (target) sessions.ensureUsageFacts(target.revision);
      const source: UsageSource = { version: query.version!, sessions: target ? [target.session] : [],
        requests: target ? sessions.usageFacts(target.revision).map(usage => ({ sessionId: target.session.id, usage })) : [] };
      result = buildUsageRequestPage(source, query, message.pricing, estimate, message.sessionId!, message.page, message.pageSize);
    } else if (message.type === "prepare") {
      await prepare(query, message.pricing); result = null;
    } else if (canUseUsageRollup(query)) {
      result = buildUsageRollupReport(await queryRollup(query, message.pricing), query, message.pricing);
    } else {
      const progress = { version: query.version, priceVersion: query.priceVersion, timezone: query.timezone,
        preparedSessions: 0, totalSessions: 0 };
      // 精确查询不能将同一 family 仍在进行的历史预热误报为完成或失败。
      const standalone = () => !preparing.has(preparationKey(query));
      if (standalone()) update({ ...progress, state: "preparing" });
      try {
        const source = await compactSource(query.version!);
        result = buildUsageReport(source, query, message.pricing, estimate);
        if (standalone()) update({ ...progress, state: "ready", preparedSessions: source.sessions.length, totalSessions: source.sessions.length });
      } catch (error) { if (standalone()) update({ ...progress, state: "failed" }); throw error; }
    }
    if (message.type === "summary" && result && "sessions" in result) result = { ...result,
      sessions: result.sessions.map(row => ({ ...row, requests: [], requestsLimited: row.requestsTotal > 0 })) };
    send({ id: message.id, type: "result", result });
  } catch (error) {
    const known = error instanceof StoreError || error instanceof ServiceError;
    send({ id: message.id, type: "error", error: { code: known ? error.code : "INTERNAL_ERROR",
      message: known ? error.message : "本地服务处理失败", messageDescriptor: known ? error.messageDescriptor : { key: "diagnostics.server.m003" } } });
  }
}

port.on("message", (message: UsageWorkerRequest) => { void handle(message); });
port.on("close", () => { revisions.close(); persisted.close(); sessions.close(); });
