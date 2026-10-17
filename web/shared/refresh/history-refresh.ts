import type { SessionAutoSyncStatus, SessionIndexSummary, SessionJob, SessionRefreshOptions } from "../../../src/session-contracts";

export const historyJobActive = (job?: SessionJob) => job?.status === "queued" || job?.status === "running";

/** 全局策略失败的重试不能继承页面上次局部检查的范围。 */
export function historyRetryOptions(autoSync: Pick<SessionAutoSyncStatus, "error"> | undefined, job: SessionJob | undefined, previous: SessionRefreshOptions): SessionRefreshOptions {
  if (autoSync?.error) return { mode: "quick" };
  return job?.status === "failed" ? { client: job.client, mode: job.mode ?? "quick" } : previous;
}

/** 摘要可能已指向后继任务，尚未确认的手动任务仍需按身份读取一次。 */
export function historyManualJobToRead(manualId: string | undefined, snapshotJob?: SessionJob): string | undefined {
  return manualId && snapshotJob?.id !== manualId ? manualId : undefined;
}

export function historyManualJobOutcome(manualId: string | undefined, next?: SessionJob): "complete" | "failed" | undefined {
  return next?.id === manualId && (next?.status === "complete" || next?.status === "failed") ? next.status : undefined;
}

/** 状态查询可能晚于手动请求返回，旧任务和旧阶段不能覆盖已完成的新任务。 */
export function historyJobCanUpdate(previous: SessionJob | undefined, next: SessionJob, initiated = false): boolean {
  if (!previous || initiated) return true;
  if (next.createdAt < previous.createdAt) return false;
  if (previous.id === next.id) {
    if (previous.status === "running" && next.status === "queued") return false;
    return historyJobActive(previous) || !historyJobActive(next);
  }
  // 两次状态读取之间可能已有任务完成，并开始了下一项任务。
  return next.createdAt >= previous.createdAt;
}

/** 以完整发布版本通知页面，不要求页面曾经看到相应任务运行。 */
export function historySnapshotShouldReload(initialized: boolean, version: string | undefined, next: Pick<SessionIndexSummary, "version" | "job">, notifiedId?: string, manualId?: string): boolean {
  const changed = initialized && next.version !== undefined && next.version !== version;
  return changed || next.job?.status === "complete" && next.job.id === manualId && next.job.id !== notifiedId;
}

/** 自动检查仅联动新版本；手动同步允许主动重读，旧完成记录不会重复通知。 */
export function historyJobShouldReload(version: string | undefined, next: SessionJob, notifiedId?: string, manual = false, previous?: SessionJob): boolean {
  const firstPublication = version === undefined && previous?.id === next.id && historyJobActive(previous);
  return next.status === "complete" && next.id !== notifiedId
    && (manual || firstPublication || version !== undefined && next.version !== undefined && version !== next.version);
}
