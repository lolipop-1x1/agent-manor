import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionIndexSummary, SessionJob, SessionRefreshOptions } from "../../../src/session-contracts";
import { ApiError, errorMessage, isAborted, request } from "../api";
import { historyJobActive, historyJobCanUpdate, historyJobShouldReload, historySnapshotShouldReload, historyManualJobOutcome, historyManualJobToRead, historyRetryOptions } from "./history-refresh";
import { useI18n } from "../i18n";
import { useVisiblePolling } from "./useVisiblePolling";

export function useHistoryRefresh() {
  const { beginSessionIntervalObservation } = useI18n();
  const [job, setJob] = useState<SessionJob>();
  const currentJob = useRef<SessionJob | undefined>(undefined);
  const notified = useRef<string | undefined>(undefined);
  const publishedVersion = useRef<string | undefined>(undefined);
  const manualJob = useRef<string | undefined>(undefined);
  const initialized = useRef(false);
  const requestSequence = useRef(0);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const [error, setError] = useState<Error | null>(null);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<SessionIndexSummary>();
  const lastRequest = useRef<SessionRefreshOptions>({ mode: "quick" });
  const errorOperation = useRef<"status" | "start">("status");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const settleManualJob = useCallback((next?: SessionJob) => {
    const outcome = historyManualJobOutcome(manualJob.current, next);
    if (!mounted.current || !outcome) return outcome;
    manualJob.current = undefined;
    if (outcome === "complete") {
      notified.current = next!.id; setRevision(value => value + 1);
    } else {
      errorOperation.current = "start"; setError(new ApiError("INTERNAL_ERROR", next!.error ?? next!.phase, next!.errorDescriptor ?? next!.phaseDescriptor));
    }
    return outcome;
  }, []);
  const observeJob = useCallback((next: SessionJob, initiated = false) => {
    const previous = currentJob.current;
    if (!mounted.current) return;
    if (initiated) manualJob.current = next.id;
    const manualOutcome = settleManualJob(next);
    // 手动响应可能晚于后继任务的状态，仍保留主动重读但不倒退当前任务。
    if (!historyJobCanUpdate(previous, next)) {
      return;
    }
    if (manualOutcome !== "complete" && historyJobShouldReload(publishedVersion.current, next, notified.current, false, previous)) {
      setRevision(value => value + 1);
    }
    if (next.status === "complete") { notified.current = next.id; publishedVersion.current = next.version ?? publishedVersion.current; }
    currentJob.current = next; setJob(next);
  }, [settleManualJob]);
  const observeStatus = useCallback((next: SessionIndexSummary) => {
    if (!mounted.current) return;
    const manualId = manualJob.current;
    const manualOutcome = settleManualJob(next.job);
    if (manualOutcome !== "complete" && historySnapshotShouldReload(initialized.current, publishedVersion.current, next, notified.current, manualId)) {
      setRevision(value => value + 1);
    }
    initialized.current = true;
    if (next.version) publishedVersion.current = next.version;
    // 新摘要是唯一的观察来源；服务重启后没有任务时也需清除旧进度。
    if (next.job?.status === "complete") notified.current = next.job.id;
    currentJob.current = next.job; setJob(next.job);
    setStatus(next);
  }, [settleManualJob]);
  const readStatus = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++requestSequence.current;
    const observeInterval = beginSessionIntervalObservation();
    try {
      const next = await request<SessionIndexSummary>("/sessions/status?summary=true", { signal });
      if (!signal?.aborted && mounted.current && sequence === requestSequence.current) {
        observeStatus(next);
        if (next.autoSync) observeInterval(next.autoSync.intervalMs);
        if (errorOperation.current === "status") setError(null);
        const pendingId = historyManualJobToRead(manualJob.current, next.job);
        if (pendingId) {
          const pending = await request<{ job: SessionJob }>(`/jobs/${encodeURIComponent(pendingId)}`, { signal });
          // 补读仅结算本页操作，不让旧任务覆盖摘要中的后继任务进度与版本。
          if (!signal?.aborted && mounted.current && sequence === requestSequence.current) settleManualJob(pending.job);
        }
      }
    } catch (failure) {
      if (!isAborted(failure) && !signal?.aborted && mounted.current && sequence === requestSequence.current) {
        errorOperation.current = "status"; setError(failure instanceof Error ? failure : new Error(errorMessage(failure)));
      }
    }
  }, [observeStatus, beginSessionIntervalObservation, settleManualJob]);
  useVisiblePolling(true, historyJobActive(job) || status?.autoSync?.state === "running" ? 1100 : 5000, readStatus, undefined, true);

  const refresh = useCallback(async (options: SessionRefreshOptions = { mode: "quick" }) => {
    if (startingRef.current || historyJobActive(currentJob.current)) return;
    ++requestSequence.current;
    startingRef.current = true; setStarting(true); setError(null); lastRequest.current = options;
    try {
      const result = await request<{ job: SessionJob }>("/sessions/refresh", { method: "POST", body: { ...options } });
      if (mounted.current) { ++requestSequence.current; observeJob(result.job, true); }
    } catch (failure) { if (mounted.current) { errorOperation.current = "start"; setError(failure instanceof Error ? failure : new Error(errorMessage(failure))); } }
    finally { startingRef.current = false; if (mounted.current) setStarting(false); }
  }, [observeJob]);
  const retry = () => {
    if (error && errorOperation.current === "status") { void readStatus(); return; }
    if (historyJobActive(currentJob.current)) { void readStatus(); return; }
    void refresh(historyRetryOptions(status?.autoSync, currentJob.current, lastRequest.current));
  };
  return { job, starting, updating: starting || historyJobActive(job) || status?.autoSync?.state === "running", error, errorOperation: errorOperation.current, revision, status, refresh, retry, observeJob, observeStatus };
}

/** 隐藏或读取中的页面保留最新通知，避免持续同步反复取消完整结果。 */
export function useHistoryRevision(active: boolean, revision: number, refresh: () => void, updating = false, onReading?: (reading: boolean) => void) {
  const consumed = useRef(revision), callback = useRef(refresh);
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  callback.current = refresh;
  useEffect(() => {
    const updateVisibility = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);
  useEffect(() => {
    if (!active || !onReading) return;
    onReading(updating);
    return () => onReading(false);
  }, [active, updating, onReading]);
  useEffect(() => {
    if (!active || !visible || updating || consumed.current === revision) return;
    consumed.current = revision; callback.current();
  }, [active, visible, revision, updating]);
}
