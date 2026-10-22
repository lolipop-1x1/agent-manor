import { createHash, randomUUID } from "node:crypto";
import type { KnowledgeConfig, KnowledgeExtractionScope, KnowledgeJob, KnowledgeJobSummary, KnowledgeLanguage, KnowledgePreview, KnowledgeSettings, KnowledgeSettingsInput, KnowledgeSourceReader, KnowledgeTarget, KnowledgeTaskStatus, KnowledgeTaskSummaryPage, KnowledgeTryResult, KnowledgeRequestEvent, KnowledgeTaskEvent } from "../knowledge-contracts.js";
import { KnowledgeConfigStore, KnowledgeModelError, knowledgeFingerprint, validateKnowledgeConfig, validateKnowledgeScope } from "./config.js";
import { KnowledgeGenerationScheduler, estimateKnowledgeTokens, emptyKnowledgeUsage, applyKnowledgeRequestUsage, knowledgeRequestCost } from "./generation.js";
import { KnowledgeExtractionPipeline, type PipelineCheckpoint, type PipelineOptions } from "./pipeline.js";
import type { KnowledgeStore } from "./store.js";
import { knowledgeLimitations } from "./diagnostics.js";

interface PreviewRecord { preview: KnowledgePreview; config: KnowledgeConfig }
interface JobRecord { job: KnowledgeJob; preview: KnowledgePreview; config: KnowledgeConfig; order: number[]; cursor: number; successful: number[]; failureIndexes: number[]; chunks: Record<string, { total: number; completed: number }>; keySnapshot: boolean; budgetInput?: number; budgetCost?: number }
interface Coverage { messages: Record<string, { hash: string; version: string; fingerprint: string; taskId: string }>; updatedAt: string }
interface ManagerState { previews: string[]; jobs: string[]; idempotency: Record<string, { previewId: string; jobId: string }>; automatic: KnowledgeTaskStatus["automatic"] & { failureCount?: number; notBefore?: string; signature?: string } }
const stateKey = "extraction.manager";
function now(): string { return new Date().toISOString(); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function modelError(code: string, message: string, status = 400): KnowledgeModelError { return new KnowledgeModelError(code, message, status); }
function terminal(job: KnowledgeJob): boolean { return ["complete", "partial", "failed", "budget_stopped"].includes(job.status); }
function diagnostic(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4096); }
function jobTitle(record: JobRecord): string | undefined { return record.preview.targets.length === 1 ? record.job.title ?? record.preview.targets[0]?.title : undefined; }

export class KnowledgeManager {
  activeJobs(): Pick<KnowledgeJob, "id" | "status">[] {
    return this.state().jobs.map(id => this.record(id)?.job).filter((job): job is KnowledgeJob => Boolean(job && ["queued", "running"].includes(job.status))).map(job => ({ id: job.id, status: job.status }));
  }
  private readonly config: KnowledgeConfigStore;
  private readonly scheduler: KnowledgeGenerationScheduler;
  private readonly pipeline: KnowledgeExtractionPipeline;
  private readonly controllers = new Map<string, AbortController>();
  private closed = false;
  private running?: Promise<void>;
  private wake?: ReturnType<typeof setTimeout>;
  private starting: Promise<unknown> = Promise.resolve();
  constructor(home: string, private readonly store: KnowledgeStore, private readonly sources: KnowledgeSourceReader, options?: PipelineOptions) {
    this.config = new KnowledgeConfigStore(home); this.scheduler = new KnowledgeGenerationScheduler(store); this.pipeline = new KnowledgeExtractionPipeline(this.scheduler, store, sources, options);
    const state = this.state();
    for (const id of state.jobs) {
      const record = this.record(id);
      if (record && ["running", "queued"].includes(record.job.status)) { record.job.status = "paused"; record.job.updatedAt = now(); record.job.error = "interrupted"; record.job.errorDescriptor = { key: "knowledge.errors.stopped" }; this.event(record, { kind: "paused", error: "interrupted", errorDescriptor: { key: "knowledge.errors.stopped" } }); this.save(record); }
    }
    this.schedule();
  }
  private state(): ManagerState { return this.store.getState<ManagerState>(stateKey) ?? { previews: [], jobs: [], idempotency: {}, automatic: { enabled: false } }; }
  private record(id: string): JobRecord | undefined { return this.store.getState<JobRecord>(`extraction.job:${id}`); }
  private save(record: JobRecord): void { this.store.setState(`extraction.job:${record.job.id}`, record); }
  private event(record: JobRecord, event: Omit<KnowledgeTaskEvent, "id" | "at"> & { at?: string }): void {
    record.job.events ??= [];
    record.job.events.push({ ...event, id: randomUUID(), at: event.at ?? now() });
    if (record.job.events.length > 400) { record.job.droppedEvents = (record.job.droppedEvents ?? 0) + record.job.events.length - 400; record.job.events = record.job.events.slice(-400); }
  }
  private request(id: string, event: KnowledgeRequestEvent): void {
    const record = this.record(id); if (!record) throw modelError("task_not_found", "找不到沉淀任务", 404);
    const generation = record.config.generation;
    if (event.kind === "before") {
      const input = event.measurement.inputTokenUpperBound ?? event.measurement.inputTokens;
      const cost = knowledgeRequestCost(record.config, { inputTokens: input, outputTokens: event.measurement.outputTokens }, true);
      if (generation.taskInputTokenBudget !== undefined && (record.budgetInput ?? 0) + input > generation.taskInputTokenBudget) throw modelError("task_token_budget_exceeded", "已达到本次知识沉淀的输入 Token 预算", 429);
      if (generation.taskBudget !== undefined && (cost === null || (record.budgetCost ?? 0) + cost > generation.taskBudget)) throw modelError("task_budget_exceeded", "已达到本次知识沉淀的费用预算", 429);
      return;
    }
    record.job.usage ??= emptyKnowledgeUsage(); applyKnowledgeRequestUsage(record.job.usage, event);
    if (event.kind === "reserved") {
      const input = event.measurement.inputTokenUpperBound ?? event.measurement.inputTokens;
      record.budgetInput = (record.budgetInput ?? 0) + input;
      record.budgetCost = (record.budgetCost ?? 0) + (knowledgeRequestCost(record.config, { inputTokens: input, outputTokens: event.measurement.outputTokens }, true) ?? 0);
    } else if (event.kind === "settled") {
      const reservedInput = event.reservation.inputTokenUpperBound ?? event.reservation.inputTokens;
      if (event.measurement.actualInputTokens !== undefined) record.budgetInput = Math.max(0, (record.budgetInput ?? 0) - reservedInput + event.measurement.actualInputTokens);
      if (event.measurement.actualInputTokens !== undefined && event.measurement.actualOutputTokens !== undefined && event.measurement.estimatedCost !== null) {
        const reservedCost = knowledgeRequestCost(record.config, { inputTokens: reservedInput, outputTokens: event.reservation.outputTokens }, true);
        if (reservedCost !== null) record.budgetCost = Math.max(0, (record.budgetCost ?? 0) - reservedCost + event.measurement.estimatedCost);
      }
    }
    this.event(record, event.kind === "failed" ? { kind: "request", at: event.at, requestId: event.requestId, purpose: event.purpose, attempt: event.attempt, requestState: "failed", error: event.error, errorDescriptor: event.errorDescriptor }
      : { kind: "request", at: event.at, requestId: event.requestId, purpose: event.purpose, attempt: event.attempt, requestState: event.kind, measurement: event.measurement });
    record.job.updatedAt = now(); this.save(record);
  }
  private coverageKey(target: KnowledgeTarget): string { return `extraction.coverage:${digest([target.client, target.sessionId, target.branch])}`; }
  private checkpointKey(id: string, target: KnowledgeTarget): string { return `extraction.work:${id}:${digest([target.sessionId, target.branch])}`; }
  private trim(state: ManagerState): void {
    if (state.previews.length > 20) { for (const id of state.previews.slice(0, -20)) this.store.deleteState(`extraction.preview:${id}`); state.previews = state.previews.slice(-20); }
    const removable = state.jobs.filter(id => { const value = this.record(id); return value && terminal(value.job); });
    const remove = new Set(removable.slice(0, Math.max(0, state.jobs.length - 50)));
    for (const id of remove) {
      const record = this.record(id); if (record) for (const target of record.preview.targets) this.store.deleteState(this.checkpointKey(id, target));
      this.store.deleteState(`extraction.job:${id}`);
    }
    state.jobs = state.jobs.filter(id => !remove.has(id));
    for (const [key, value] of Object.entries(state.idempotency)) if (remove.has(value.jobId)) delete state.idempotency[key];
  }
  async settings(language?: KnowledgeLanguage): Promise<KnowledgeSettings> { return this.config.read(language); }
  async key(kind: "generation" | "embedding"): Promise<string | undefined> { return this.config.key(kind); }
  async saveSettings(input: KnowledgeSettingsInput): Promise<KnowledgeSettings> {
    const settings = await this.config.save(input), state = this.state(); state.automatic.enabled = settings.config.automatic.enabled;
    state.automatic.nextCheckAt = settings.config.automatic.enabled ? new Date(Date.now() + settings.config.automatic.intervalMinutes * 60_000).toISOString() : undefined;
    delete state.automatic.error; delete state.automatic.errorDescriptor; delete state.automatic.notBefore; delete state.automatic.signature; state.automatic.failureCount = 0;
    this.store.setState(stateKey, state); this.schedule(); return settings;
  }
  async preview(input: KnowledgeExtractionScope): Promise<KnowledgePreview> {
    const scope = validateKnowledgeScope(input);
    if (scope.timeRange === "unset" && !scope.sessionIds?.length) throw modelError("scope_required", "请先选择沉淀范围");
    const settings = await this.settings(), planned = await this.sources.plan(scope);
    let skippedMessages = 0, estimatedTokens = 0, contextTokens = 0, plannedChunks = 0, estimatedOutputTokens = 0, sourceBytes = 0, textBytes = 0, omittedMedia = 0;
    const targets: KnowledgeTarget[] = [];
    for (const target of planned) {
      const coverage = this.store.getState<Coverage>(this.coverageKey(target));
      const indexes = target.messageIds.map((id, index) => ({ id, index })).filter(({ id, index }) => scope.force || coverage?.messages[id]?.hash !== target.hashes[index]);
      skippedMessages += target.messageIds.length - indexes.length;
      if (!indexes.length) continue;
      const next: KnowledgeTarget = { ...target, messageIds: indexes.map(item => item.id), hashes: indexes.map(item => target.hashes[item.index]!) };
      let conversation;
      try { conversation = await this.sources.read(next); } catch (cause) { throw modelError("source_changed", `来源已变化，请重新预览：${diagnostic(cause)}`, 409); }
      const plan = this.pipeline.plan(conversation, settings.config), pending = plan.conversation.messages.filter(message => message.target);
      next.inputTokens = pending.reduce((sum, message) => sum + estimateKnowledgeTokens(message.text), 0); next.contextTokens = plan.contextTokens;
      next.turnCount = new Set(pending.map(message => message.turnId)).size; next.plannedChunks = plan.plannedChunks;
      next.limitations = plan.conversation.limitations; next.limitationDetails = plan.conversation.limitationDetails;
      estimatedTokens += plan.estimatedTokens; contextTokens += plan.contextTokens; plannedChunks += plan.plannedChunks; estimatedOutputTokens += plan.estimatedOutputTokens;
      sourceBytes += plan.sourceBytes; textBytes += plan.textBytes; omittedMedia += plan.omittedMedia; targets.push(next);
    }
    const pendingMessages = targets.reduce((sum, target) => sum + target.messageIds.length, 0), generation = settings.config.generation;
    const estimatedExtractionCost = !plannedChunks ? 0 : generation.inputPricePerMillion !== undefined && generation.outputPricePerMillion !== undefined
      ? (estimatedTokens * generation.inputPricePerMillion + estimatedOutputTokens * generation.outputPricePerMillion) / 1_000_000 : null;
    // 归并与回读次数取决于生成结果，提炼估算不能作为整项任务费用。
    const estimatedCost = plannedChunks ? null : 0;
    const preview: KnowledgePreview = { id: randomUUID(), createdAt: now(), fingerprint: settings.fingerprint, scope, targets, sessionCount: new Set(targets.map(target => target.sessionId)).size, turnCount: targets.reduce((sum, target) => sum + target.turnCount, 0), estimatedTokens, contextTokens, skippedMessages, pendingMessages, estimatedCost, estimatedExtractionCost, plannedChunks, estimatedOutputTokens, sourceBytes, textBytes, omittedMedia, limitations: [...new Set(targets.flatMap(target => target.limitations))] };
    preview.limitationDetails = knowledgeLimitations(preview.limitations, targets.flatMap(target => target.limitationDetails ?? []));
    if (Buffer.byteLength(JSON.stringify(preview)) > 6_000_000) throw modelError("input_too_long", "预览目标过大，请缩小时间或会话范围");
    this.store.transaction(() => { const state = this.state(); state.previews.push(preview.id); this.store.setState(`extraction.preview:${preview.id}`, { preview, config: settings.config } satisfies PreviewRecord); this.trim(state); this.store.setState(stateKey, state); });
    return structuredClone(preview);
  }
  start(previewId: string, idempotencyKey?: string): Promise<KnowledgeJob>;
  start(previewId: string, idempotencyKey: string | undefined, summary: true): Promise<KnowledgeJobSummary>;
  start(previewId: string, idempotencyKey?: string, summary = false): Promise<KnowledgeJob | KnowledgeJobSummary> {
    const operation = this.starting.then(() => this.begin(previewId, idempotencyKey, summary)); this.starting = operation.catch(() => undefined); return operation;
  }
  private async begin(previewId: string, idempotencyKey?: string, summary = false): Promise<KnowledgeJob | KnowledgeJobSummary> {
    if (this.closed) throw modelError("stopped", "知识后台已停止", 503);
    if (typeof previewId !== "string" || !previewId) throw modelError("preview_stale", "沉淀预览不存在或已失效", 409);
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > 512)) throw modelError("request_invalid", "任务幂等键无效");
    const state = this.state(), idempotencyHash = idempotencyKey ? digest(idempotencyKey) : undefined, prior = idempotencyHash ? state.idempotency[idempotencyHash] : undefined;
    if (prior) { if (prior.previewId !== previewId) throw modelError("conflict", "同一幂等键不能启动不同范围", 409); return summary ? this.job(prior.jobId, true) : this.job(prior.jobId); }
    const stored = this.store.getState<PreviewRecord | null>(`extraction.preview:${previewId}`);
    if (!stored || Date.now() - Date.parse(stored.preview.createdAt) > 86_400_000) throw modelError("preview_stale", "沉淀预览不存在或已失效，请重新预览", 409);
    const capture = await this.config.capture(), settings = capture.settings; if (settings.fingerprint !== stored.preview.fingerprint) throw modelError("preview_stale", "生成配置已改变，请重新预览", 409);
    if (!settings.config.generation.url || !settings.config.generation.model) throw modelError("connection_required", "请先配置知识生成模型");
    // 启动只核验固定范围，新的消息不会并入已预览的任务。
    for (const target of stored.preview.targets) {
      try { await this.sources.read(target); } catch (cause) { throw modelError("source_changed", `来源已变化，请重新预览：${diagnostic(cause)}`, 409); }
    }
    const id = randomUUID(), key = capture.generationKey; await this.config.snapshot(id, key);
    const job: KnowledgeJob = { id, previewId, status: "queued", phase: "planning", createdAt: now(), updatedAt: now(), totalSessions: stored.preview.sessionCount, completedSessions: 0, totalChunks: stored.preview.plannedChunks ?? 0, completedChunks: 0, createdEntries: 0, updatedEntries: 0, duplicates: 0, noValue: 0, needsContext: 0, failedSessions: [], results: [], outputLanguage: stored.config.outputLanguage, fingerprint: stored.preview.fingerprint, title: stored.preview.targets.length === 1 ? stored.preview.targets[0]?.title : undefined, model: structuredClone(stored.config.generation), usage: emptyKnowledgeUsage(), events: [] };
    const record: JobRecord = { job, preview: stored.preview, config: stored.config, order: stored.preview.targets.map((_target, index) => index), cursor: 0, successful: [], failureIndexes: [], chunks: Object.fromEntries(stored.preview.targets.map((target, index) => [String(index), { total: target.plannedChunks ?? 0, completed: 0 }])), keySnapshot: key !== undefined };
    this.store.transaction(() => {
      const current = this.state(); current.jobs.push(id); if (idempotencyHash) current.idempotency[idempotencyHash] = { previewId, jobId: id };
      this.event(record, { kind: "queued", phase: "planning" }); this.save(record); this.trim(current); this.store.setState(stateKey, current);
    });
    await this.config.retainSnapshots(this.state().jobs);
    this.kick(); return summary ? this.job(id, true) : structuredClone(job);
  }
  job(id: string): Promise<KnowledgeJob>;
  job(id: string, summary: true): Promise<KnowledgeJobSummary>;
  async job(id: string, summary = false): Promise<KnowledgeJob | KnowledgeJobSummary> {
    if (summary) {
      const job = this.store.extractionJobSummary(id); if (!job) throw modelError("task_not_found", "找不到沉淀任务", 404);
      return structuredClone(job);
    }
    const record = this.record(id); if (!record) throw modelError("task_not_found", "找不到沉淀任务", 404);
    return structuredClone({ ...record.job, title: jobTitle(record) });
  }
  async previewById(id: string): Promise<KnowledgePreview> {
    const preview = this.store.getState<PreviewRecord | null>(`extraction.preview:${id}`)?.preview ?? this.state().jobs.map(jobId => this.record(jobId)?.preview).find(value => value?.id === id);
    if (!preview) throw modelError("preview_stale", "沉淀预览不存在或已失效", 404);
    return structuredClone(preview);
  }
  status(): Promise<KnowledgeTaskStatus>;
  status(query: { response: "summary"; page?: number; pageSize?: number }): Promise<KnowledgeTaskSummaryPage>;
  async status(query?: { response: "summary"; page?: number; pageSize?: number }): Promise<KnowledgeTaskStatus | KnowledgeTaskSummaryPage> {
    const settings = await this.settings(), state = this.state();
    if (query) {
      const page = query.page ?? 1, pageSize = query.pageSize ?? 20;
      const result = this.store.extractionJobSummaries(state.jobs, page, pageSize);
      return { ...structuredClone(result), page, pageSize, hasMore: page * pageSize < result.total, usage: this.scheduler.usage(), automatic: {
        enabled: settings.config.automatic.enabled, lastCheckAt: state.automatic.lastCheckAt, nextCheckAt: state.automatic.nextCheckAt,
        error: state.automatic.error, errorDescriptor: state.automatic.errorDescriptor } };
    }
    const jobs = state.jobs.map(id => this.record(id)).filter((record): record is JobRecord => Boolean(record)).reverse().map(record => { const { events: _events, ...job } = record.job; return structuredClone({ ...job, title: jobTitle(record) }); });
    return { jobs, usage: this.scheduler.usage(), automatic: { enabled: settings.config.automatic.enabled, lastCheckAt: state.automatic.lastCheckAt, nextCheckAt: state.automatic.nextCheckAt, error: state.automatic.error, errorDescriptor: state.automatic.errorDescriptor } };
  }
  action(id: string, action: "pause" | "resume" | "retry"): Promise<KnowledgeJob>;
  action(id: string, action: "pause" | "resume" | "retry", summary: true): Promise<KnowledgeJobSummary>;
  async action(id: string, action: "pause" | "resume" | "retry", summary = false): Promise<KnowledgeJob | KnowledgeJobSummary> {
    if (this.closed) throw modelError("stopped", "知识后台已停止", 503);
    const record = this.record(id); if (!record) throw modelError("task_not_found", "找不到沉淀任务", 404);
    if (action !== "pause" && record.preview.fingerprint !== knowledgeFingerprint(record.config)) throw modelError("preview_stale", "输入处理方案已更新，请新建预览后开始沉淀", 409);
    if (action === "pause") {
      if (["queued", "running"].includes(record.job.status)) { record.job.status = "paused"; record.job.updatedAt = now(); this.event(record, { kind: "paused", phase: record.job.phase }); this.save(record); this.controllers.get(id)?.abort(); }
    } else if (action === "resume") {
      if (record.job.status !== "paused") throw modelError("conflict", "只有暂停任务可以恢复", 409);
      record.job.status = "queued"; this.event(record, { kind: "resumed", phase: record.job.phase }); delete record.job.error; delete record.job.errorDescriptor; record.job.updatedAt = now(); this.save(record); this.kick();
    } else if (action === "retry") {
      if (!["partial", "failed", "budget_stopped"].includes(record.job.status)) throw modelError("conflict", "当前任务没有可重试的失败范围", 409);
      record.order = [...new Set([...record.failureIndexes, ...record.order.slice(record.cursor)])]; record.cursor = 0; record.failureIndexes = [];
      for (const index of record.order) {
        const key = this.checkpointKey(id, record.preview.targets[index]!), checkpoint = this.store.getState<PipelineCheckpoint | null>(key);
        if (checkpoint?.needsContext) { this.store.deleteState(key); delete record.chunks[String(index)]; }
      }
      this.event(record, { kind: "retried", phase: record.job.phase }); record.job.needsContext = 0; record.job.failedSessions = []; record.job.status = "queued"; delete record.job.finishedAt; delete record.job.error; delete record.job.errorDescriptor; record.job.updatedAt = now(); this.save(record); this.kick();
    } else throw modelError("request_invalid", "不支持的任务操作");
    return summary ? this.job(id, true) : this.job(id);
  }
  private kick(): void {
    if (this.closed || this.running) return;
    this.running = this.drain().finally(() => { this.running = undefined; if (!this.closed && this.state().jobs.some(id => this.record(id)?.job.status === "queued")) this.kick(); });
  }
  private async drain(): Promise<void> {
    for (;;) {
      if (this.closed) return;
      const id = this.state().jobs.find(id => this.record(id)?.job.status === "queued"); if (!id) return;
      const controller = new AbortController(); this.controllers.set(id, controller);
      try { await this.run(id, controller.signal); }
      catch (cause) {
        const record = this.record(id); if (record && !["paused", "complete", "partial"].includes(record.job.status)) { record.job.status = "failed"; record.job.error = diagnostic(cause); record.job.errorDescriptor = { key: "knowledge.errors.persistence_failed" }; record.job.updatedAt = now(); this.event(record, { kind: "error", error: "persistence_failed", errorDescriptor: record.job.errorDescriptor }); this.save(record); }
      } finally { this.controllers.delete(id); }
    }
  }
  private async run(id: string, signal: AbortSignal): Promise<void> {
    let record = this.record(id)!; record.job.status = "running"; record.job.updatedAt = now(); this.event(record, { kind: "started", phase: "planning" }); this.save(record);
    const key = record.keySnapshot ? await this.config.key("generation", id) : undefined;
    for (; record.cursor < record.order.length;) {
      if (signal.aborted || this.closed) return;
      const index = record.order[record.cursor]!, target = record.preview.targets[index]!, checkpointKey = this.checkpointKey(id, target);
      try {
        record.job.phase = "planning"; this.event(record, { kind: "phase", phase: "planning", sessionId: target.sessionId }); this.save(record);
        let conversation;
        try { conversation = await this.sources.read(target); } catch (cause) { throw modelError("source_changed", `来源已变化：${diagnostic(cause)}`, 409); }
        const checkpoint = this.store.getState<PipelineCheckpoint | null>(checkpointKey) ?? undefined;
        const result = await this.pipeline.run(conversation, record.config, key, checkpoint, {
          signal,
          request: event => this.request(id, event),
          phase: phase => { const latest = this.record(id)!; if (latest.job.status === "paused") return; if (latest.job.phase !== phase) this.event(latest, { kind: "phase", phase, sessionId: target.sessionId }); latest.job.phase = phase; latest.job.updatedAt = now(); this.save(latest); },
          checkpoint: async (state, chunks) => {
            if (signal.aborted) throw modelError("cancelled", "沉淀已暂停", 499);
            this.store.transaction(() => {
              const latest = this.record(id)!; latest.chunks[String(index)] = { total: chunks, completed: state.next };
              latest.job.totalChunks = Object.values(latest.chunks).reduce((sum, item) => sum + item.total, 0); latest.job.completedChunks = Object.values(latest.chunks).reduce((sum, item) => sum + item.completed, 0);
              this.event(latest, { kind: "progress", sessionId: target.sessionId, completedChunks: latest.job.completedChunks, totalChunks: latest.job.totalChunks }); latest.job.updatedAt = now(); this.store.setState(checkpointKey, state); this.save(latest);
            });
          },
        });
        if (signal.aborted) return;
        record = this.record(id)!;
        if (result.needsContext) {
          const errorDescriptor = { key: "knowledge.errors.context_required" };
          record.job.needsContext++; record.failureIndexes.push(index); record.job.failedSessions.push({ sessionId: target.sessionId, title: target.title, error: "Knowledge extraction needs more source context.", errorDescriptor }); record.job.error = "Knowledge extraction needs more source context."; record.job.errorDescriptor = errorDescriptor; record.cursor++; record.job.updatedAt = now(); this.event(record, { kind: "error", sessionId: target.sessionId, error: "context_required", errorDescriptor }); this.save(record); continue;
        }
        record.job.phase = "saving"; this.event(record, { kind: "phase", phase: "saving", sessionId: target.sessionId }); this.save(record);
        // 候选、任务结果和非连续消息覆盖在同一 SQLite 事务提交；没有价值也推进实际完成的身份集合。
        this.store.transaction(() => {
          const latest = this.record(id)!;
          for (const [position, raw] of result.candidates.entries()) {
            const { targetKnowledgeId, baseRevisionId, ...draft } = raw;
            draft.sources = (draft.sources ?? []).map(source => ({ ...source, taskId: id }));
            const resultKey = `extraction:${id}:${index}:${position}`;
            const detail = targetKnowledgeId && baseRevisionId ? this.store.revise(targetKnowledgeId, { ...draft, baseRevisionId }, resultKey) : this.store.create(draft, resultKey);
            latest.job.results.push({ knowledgeId: detail.id, revisionId: detail.latestRevisionId });
            if (targetKnowledgeId) latest.job.updatedEntries++; else latest.job.createdEntries++;
          }
          const coverage = this.store.getState<Coverage>(this.coverageKey(target)) ?? { messages: {}, updatedAt: now() };
          for (const [position, messageId] of target.messageIds.entries()) coverage.messages[messageId] = { hash: target.hashes[position]!, version: target.version, fingerprint: latest.job.fingerprint, taskId: id };
          coverage.updatedAt = now(); this.store.setState(this.coverageKey(target), coverage);
          latest.job.duplicates += result.duplicates; latest.job.noValue += result.noValue;
          if (!latest.successful.includes(index)) latest.successful.push(index);
          latest.job.completedSessions = [...new Set(latest.preview.targets.map(target => target.sessionId))].filter(sessionId => latest.preview.targets.every((target, position) => target.sessionId !== sessionId || latest.successful.includes(position))).length;
          latest.cursor++; latest.job.updatedAt = now(); this.store.deleteState(checkpointKey); this.save(latest);
        });
        record = this.record(id)!;
      } catch (cause) {
        record = this.record(id)!;
        if (signal.aborted || record.job.status === "paused" || this.closed) return;
        if (cause instanceof KnowledgeModelError && ["budget_exceeded", "task_budget_exceeded", "task_token_budget_exceeded"].includes(cause.code)) { record.job.status = "budget_stopped"; record.job.error = cause.message; record.job.errorDescriptor = cause.messageDescriptor; record.job.updatedAt = now(); this.event(record, { kind: "error", error: cause.code, errorDescriptor: cause.messageDescriptor }); this.save(record); return; }
        const errorDescriptor = cause instanceof KnowledgeModelError ? cause.messageDescriptor : { key: "knowledge.errors.persistence_failed" };
        record.failureIndexes.push(index); record.job.failedSessions.push({ sessionId: target.sessionId, title: target.title, error: diagnostic(cause), errorDescriptor }); record.cursor++; record.job.error = diagnostic(cause);
        record.job.errorDescriptor = errorDescriptor; record.job.updatedAt = now(); this.event(record, { kind: "error", sessionId: target.sessionId, error: cause instanceof KnowledgeModelError ? cause.code : "persistence_failed", errorDescriptor }); this.save(record);
      }
    }
    record = this.record(id)!; if (record.job.status === "paused" || signal.aborted) return;
    record.job.status = record.job.failedSessions.length ? record.successful.length > 0 ? "partial" : "failed" : "complete";
    record.job.phase = "complete"; record.job.finishedAt = now(); record.job.updatedAt = now(); this.event(record, { kind: "completed", phase: "complete" }); this.save(record);
  }
  private async overrides(input?: KnowledgeSettingsInput): Promise<{ config: KnowledgeConfig; key?: string }> {
    if (!input) { const settings = await this.settings(); return { config: settings.config, key: await this.key("generation") }; }
    const config = validateKnowledgeConfig(input.config);
    if (input.generationKey !== undefined && input.generationKey !== null && (typeof input.generationKey !== "string" || input.generationKey.length > 16_384 || /[\r\n]/.test(input.generationKey))) throw modelError("config_invalid", "模型凭据无效");
    return { config, key: input.generationKey === null || input.generationKey === "" ? undefined : input.generationKey ?? await this.key("generation") };
  }
  async test(input?: KnowledgeSettingsInput): Promise<{ ok: boolean }> {
    const { config, key } = await this.overrides(input);
    const response = await this.scheduler.execute(config, [{ role: "system", content: 'Return exactly the JSON object {"ok":true}. /no_think' }, { role: "user", content: "Test the configured knowledge generation connection." }], key, undefined, undefined, "test");
    if (!response.value || typeof response.value !== "object" || (response.value as { ok?: unknown }).ok !== true) throw modelError("response_invalid", "模型未返回测试结果", 502);
    return { ok: true };
  }
  async tryExtract(input: KnowledgeExtractionScope, settings?: KnowledgeSettingsInput): Promise<KnowledgeTryResult> {
    const scope = validateKnowledgeScope(input);
    if (scope.timeRange === "unset" && !scope.sessionIds?.length) throw modelError("scope_required", "请先选择试抽取范围");
    const { config, key } = await this.overrides(settings), targets = await this.sources.plan(scope);
    if (targets.length !== 1 || targets[0]!.messageIds.length > 100) throw modelError("request_invalid", "试抽取请选择一个会话中不超过 100 条消息的小范围");
    const conversation = await this.sources.read(targets[0]!), controller = new AbortController();
    if (this.pipeline.plan(conversation, config).estimatedTokens > 100_000) throw modelError("request_invalid", "试抽取请选择一个会话中不超过 100 条消息的小范围");
    const usage = emptyKnowledgeUsage(this.scheduler.usage().date);
    const result = await this.pipeline.run(conversation, config, key, undefined, { signal: controller.signal, phase: () => undefined, checkpoint: async () => undefined, usage, purpose: "try" });
    return { candidates: result.candidates.map(({ targetKnowledgeId: _id, baseRevisionId: _base, ...draft }) => draft), disposition: result.needsContext ? "needs_context" : result.candidates.length ? "knowledge" : "no_value", limitations: result.limitations, limitationDetails: result.limitationDetails, usage };
  }
  private schedule(): void {
    if (this.wake) clearTimeout(this.wake);
    if (this.closed) return;
    this.wake = setTimeout(() => { this.wake = undefined; void this.automatic().finally(() => this.schedule()); }, 60_000); this.wake.unref();
  }
  private async automatic(): Promise<void> {
    if (this.closed) return;
    try {
      const settings = await this.settings(), strategy = settings.config.automatic;
      if (!strategy.enabled || this.state().jobs.some(id => ["running", "queued", "paused"].includes(this.record(id)?.job.status ?? ""))) return;
      let state = this.state(), next = state.automatic.notBefore ?? state.automatic.nextCheckAt;
      if (next && Date.parse(next) > Date.now()) return;
      state.automatic.lastCheckAt = now(); state.automatic.nextCheckAt = new Date(Date.now() + strategy.intervalMinutes * 60_000).toISOString(); this.store.setState(stateKey, state);
      const preview = await this.preview(strategy.scope), quietBefore = Date.now() - strategy.quietMinutes * 60_000;
      let unknownActivity = false;
      preview.targets = preview.targets.filter(target => {
        const updatedAt = target.updatedAt;
        if (updatedAt === undefined || !Number.isFinite(Date.parse(updatedAt))) { unknownActivity = true; return false; }
        return Date.parse(updatedAt) <= quietBefore;
      });
      const signature = digest(preview.targets.map(target => [target.sessionId, target.branch, target.messageIds, target.hashes]));
      state = this.state();
      if (unknownActivity) { state.automatic.error = "Some sessions have no recorded activity time and were skipped."; state.automatic.errorDescriptor = { key: "knowledge.errors.quiet_time_unknown" }; }
      else { delete state.automatic.error; delete state.automatic.errorDescriptor; }
      this.store.setState(stateKey, state);
      if (!preview.targets.length || state.automatic.signature === signature) return;
      preview.sessionCount = new Set(preview.targets.map(target => target.sessionId)).size; preview.turnCount = preview.targets.reduce((sum, target) => sum + target.turnCount, 0); preview.pendingMessages = preview.targets.reduce((sum, target) => sum + target.messageIds.length, 0);
      this.store.setState(`extraction.preview:${preview.id}`, { preview, config: settings.config } satisfies PreviewRecord);
      await this.start(preview.id, `automatic:${signature}`);
      state = this.state(); state.automatic.signature = signature; state.automatic.failureCount = 0; delete state.automatic.notBefore; this.store.setState(stateKey, state);
    } catch (cause) {
      if (this.closed) return; const state = this.state(); state.automatic.error = diagnostic(cause); state.automatic.errorDescriptor = cause instanceof KnowledgeModelError ? cause.messageDescriptor : { key: "knowledge.errors.automatic_failed" }; state.automatic.failureCount = (state.automatic.failureCount ?? 0) + 1;
      state.automatic.notBefore = new Date(Date.now() + Math.min(24 * 60, 5 * 2 ** Math.min(state.automatic.failureCount, 8)) * 60_000).toISOString(); this.store.setState(stateKey, state);
    }
  }
  async close(): Promise<void> {
    this.closed = true; if (this.wake) clearTimeout(this.wake);
    for (const [id, controller] of this.controllers) { const record = this.record(id); if (record && record.job.status === "running") { record.job.status = "paused"; record.job.updatedAt = now(); this.event(record, { kind: "paused", phase: record.job.phase }); this.save(record); } controller.abort(); }
    await this.scheduler.close(); await this.running; await this.starting;
  }
}
