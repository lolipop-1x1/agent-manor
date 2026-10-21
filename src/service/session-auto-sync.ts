import { errorDescriptor } from "../i18n/diagnostics.js";
import type { SessionAutoSyncStatus, SessionJob, SessionRefreshOptions } from "../session-contracts.js";

export interface SessionAutoSyncClock {
  now(): number;
  /** 返回撤销本次唤醒的函数；测试时可推进时钟而不等待真实周期。 */
  setTimeout(callback: () => void, delayMs: number): () => void;
}

export interface SessionAutoSyncWorker {
  readonly busy: boolean;
  readonly sessionsBusy?: boolean;
  activeSessionJobs(): SessionJob[];
  coveringSessionJob(clearCache?: boolean, options?: SessionRefreshOptions): SessionJob | undefined;
  refreshSessions(clearCache?: boolean, options?: SessionRefreshOptions): SessionJob | Promise<SessionJob>;
  subscribeChanges(listener: (jobs: SessionJob[]) => void): () => void;
}

export interface SessionGlobalCheckState {
  lastSuccessAt?: string;
  lastFinished?: SessionJob;
  consecutiveFailures: number;
}

const systemClock: SessionAutoSyncClock = {
  now: Date.now,
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs).unref();
    return () => { clearTimeout(timer); };
  },
};

/** 每个后台持有一份周期；必要补查留在此处，不堆积到串行 Worker。 */
export class SessionAutoSyncScheduler {
  private intervalMs = 0;
  private nextRun?: number;
  private pending = false;
  private closed = false;
  private driving = false;
  private cancelTimer?: () => void;
  private readonly unsubscribe: () => void;
  private readonly settled = new Set<string>();
  private lastSuccessAt?: string;
  private lastFinished?: SessionJob;
  private consecutiveFailures: number;
  private submissionError?: Pick<SessionJob, "error" | "errorDescriptor">;

  constructor(private readonly worker: SessionAutoSyncWorker, history: SessionGlobalCheckState, private readonly clock = systemClock) {
    this.lastSuccessAt = history.lastSuccessAt;
    this.lastFinished = history.lastFinished;
    this.consecutiveFailures = history.consecutiveFailures;
    if (history.lastFinished) this.settled.add(history.lastFinished.id);
    this.unsubscribe = worker.subscribeChanges(jobs => {
      for (const job of jobs) this.settle(job);
      this.drive();
    });
  }

  updateInterval(intervalMs: number): void {
    if (this.closed || this.intervalMs === intervalMs) return;
    const enabling = !this.intervalMs && intervalMs > 0;
    this.intervalMs = intervalMs;
    this.pending = false;
    this.nextRun = intervalMs ? enabling ? this.clock.now() : this.deadline() : undefined;
    this.drive();
  }

  /** 状态观察不触发检查，也不修改调度截止时间。 */
  status(): SessionAutoSyncStatus {
    const covering = this.worker.coveringSessionJob();
    const state: SessionAutoSyncStatus["state"] = !this.intervalMs ? "disabled" : covering ? "running" : this.pending || this.driving ? "pending"
      : this.consecutiveFailures ? "backoff" : "waiting";
    return { intervalMs: this.intervalMs, state, consecutiveFailures: this.consecutiveFailures,
      ...(this.lastSuccessAt ? { lastSuccessAt: this.lastSuccessAt } : {}),
      ...(covering ? { job: covering } : {}),
      ...(this.intervalMs && !covering && !this.pending && this.nextRun !== undefined ? { nextRunAt: new Date(this.nextRun).toISOString() } : {}),
      ...(this.submissionError ?? (this.lastFinished?.status === "failed" ? { error: this.lastFinished.error, errorDescriptor: this.lastFinished.errorDescriptor } : {})) };
  }

  private settle(job: SessionJob): void {
    if (job.client || (job.status !== "complete" && job.status !== "failed") || this.settled.has(job.id)) return;
    this.settled.add(job.id);
    if (this.settled.size > 128) this.settled.delete(this.settled.values().next().value!);
    this.lastFinished = job;
    this.submissionError = undefined;
    if (job.status === "complete") {
      this.lastSuccessAt = job.finishedAt;
      this.consecutiveFailures = 0;
    } else this.consecutiveFailures += 1;
    this.pending = false;
    this.nextRun = this.intervalMs ? this.deadline() : undefined;
  }

  private deadline(): number {
    const completedAt = this.lastFinished?.finishedAt ?? this.lastSuccessAt;
    const baseline = completedAt ? Date.parse(completedAt) : NaN;
    if (!Number.isFinite(baseline)) return this.clock.now();
    const retry = this.consecutiveFailures ? Math.min(30_000 * 2 ** Math.min(this.consecutiveFailures - 1, 5), 600_000) : 0;
    return baseline + Math.max(this.intervalMs, retry);
  }

  private drive(): void {
    if (this.closed || this.driving) return;
    this.cancelTimer?.(); this.cancelTimer = undefined;
    if (!this.intervalMs) return;
    // 已提交的全局任务包含启动和手动入口，可直接作为这轮周期的检查。
    if (this.worker.coveringSessionJob()) { this.pending = false; this.nextRun = undefined; return; }
    const remaining = (this.nextRun ?? this.clock.now()) - this.clock.now();
    if (remaining > 0) {
      // 部分平台的单调时钟在休眠时暂停，短唤醒按绝对时间判断是否只补一轮。
      this.cancelTimer = this.clock.setTimeout(() => { this.cancelTimer = undefined; this.drive(); }, Math.min(remaining, 5_000));
      return;
    }
    if (this.worker.sessionsBusy ?? this.worker.busy) { this.pending = true; return; }
    this.pending = false;
    this.nextRun = undefined;
    this.driving = true;
    const failed = (error: unknown) => {
      this.consecutiveFailures += 1;
      this.submissionError = { error: error instanceof Error ? error.message : String(error), errorDescriptor: errorDescriptor(error) };
      this.nextRun = this.clock.now() + Math.max(this.intervalMs, Math.min(30_000 * 2 ** Math.min(this.consecutiveFailures - 1, 5), 600_000));
    };
    try {
      const result = this.worker.refreshSessions();
      if (result instanceof Promise) {
        void result.catch(failed).finally(() => { this.driving = false; this.drive(); });
        return;
      }
    } catch (error) { failed(error); }
    this.driving = false;
    if (this.submissionError) this.drive();
  }

  close(): void {
    this.closed = true;
    this.pending = false;
    this.cancelTimer?.(); this.cancelTimer = undefined;
    this.unsubscribe();
  }
}
