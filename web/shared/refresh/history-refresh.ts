import type { SessionJob } from "../../../src/session-contracts";

export const historyJobActive = (job?: SessionJob) => job?.status === "queued" || job?.status === "running";

/** 状态查询可能晚于手动请求返回，旧任务和旧阶段不能覆盖已完成的新任务。 */
export function historyJobCanUpdate(previous: SessionJob | undefined, next: SessionJob, initiated = false): boolean {
  if (!previous || initiated) return true;
  if (next.createdAt < previous.createdAt) return false;
  if (previous.id === next.id) {
    if (previous.status === "running" && next.status === "queued") return false;
    return historyJobActive(previous) || !historyJobActive(next);
  }
  return !historyJobActive(previous);
}

/** 自动检查仅联动新版本；手动同步允许主动重读，旧完成记录不会重复通知。 */
export function historyJobShouldReload(version: string | undefined, next: SessionJob, notifiedId?: string, manual = false, previous?: SessionJob): boolean {
  const firstPublication = version === undefined && previous?.id === next.id && historyJobActive(previous);
  return next.status === "complete" && next.id !== notifiedId
    && (manual || firstPublication || version !== undefined && next.version !== undefined && version !== next.version);
}
