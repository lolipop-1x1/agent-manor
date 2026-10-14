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

/** 仅本次发起或实际观察到运行的任务完成时通知页面，旧完成记录不会重复触发。 */
export function historyJobCompleted(previous: SessionJob | undefined, next: SessionJob, notifiedId?: string, initiated = false): boolean {
  return next.status === "complete" && next.id !== notifiedId
    && (initiated || previous?.id === next.id && historyJobActive(previous));
}
