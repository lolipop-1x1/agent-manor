import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionIndexSummary, SessionJob, SessionRefreshOptions } from "../../../src/session-contracts";
import { errorMessage, isAborted, request } from "../api";
import { historyJobActive, historyJobCanUpdate, historyJobShouldReload } from "./history-refresh";
import { useVisiblePolling } from "./useVisiblePolling";

export function useHistoryRefresh(autoInterval = 0, canCheckAutomatically: () => boolean = () => true) {
  const [job, setJob] = useState<SessionJob>();
  const currentJob = useRef<SessionJob | undefined>(undefined);
  const notified = useRef<string | undefined>(undefined);
  const publishedVersion = useRef<string | undefined>(undefined);
  const manualJob = useRef<string | undefined>(undefined);
  const checkingAutomatically = useRef(false);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const [error, setError] = useState<Error | null>(null);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<SessionIndexSummary>();
  const lastRequest = useRef<SessionRefreshOptions>({ mode: "quick" });
  const errorOperation = useRef<"status" | "start" | "poll" | "auto">("status");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const observeJob = useCallback((next: SessionJob, initiated = false) => {
    const previous = currentJob.current;
    if (!mounted.current || !historyJobCanUpdate(previous, next, initiated)) return;
    if (initiated) manualJob.current = next.id;
    if (historyJobShouldReload(publishedVersion.current, next, notified.current, manualJob.current === next.id, previous)) {
      setRevision(value => value + 1);
    }
    if (next.status === "complete") { notified.current = next.id; publishedVersion.current = next.version ?? publishedVersion.current; }
    currentJob.current = next; setJob(next);
  }, []);
  const observeStatus = useCallback((next: SessionIndexSummary) => {
    if (!mounted.current || next.job && !historyJobCanUpdate(currentJob.current, next.job)) return;
    setStatus(next);
    if (next.job) observeJob(next.job);
    if (next.version) publishedVersion.current = next.version;
  }, [observeJob]);
  const readStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await request<SessionIndexSummary>("/sessions/status?summary=true", { signal });
      if (!signal?.aborted && mounted.current) {
        observeStatus(next); if (errorOperation.current === "status") setError(null);
      }
    } catch (failure) {
      if (!isAborted(failure) && !signal?.aborted && mounted.current) {
        errorOperation.current = "status"; setError(failure instanceof Error ? failure : new Error(errorMessage(failure)));
      }
    }
  }, [observeStatus]);
  useEffect(() => {
    const controller = new AbortController();
    void readStatus(controller.signal);
    return () => controller.abort();
  }, [readStatus]);
  useEffect(() => {
    if (job?.status !== "complete" || notified.current !== job.id) return;
    const controller = new AbortController(); void readStatus(controller.signal);
    return () => controller.abort();
  }, [job?.id, job?.status, readStatus]);

  const refresh = useCallback(async (options: SessionRefreshOptions = { mode: "quick" }) => {
    if (startingRef.current || historyJobActive(currentJob.current)) return;
    startingRef.current = true; setStarting(true); setError(null); lastRequest.current = options;
    try {
      const result = await request<{ job: SessionJob }>("/sessions/refresh", { method: "POST", body: { ...options } });
      if (mounted.current) observeJob(result.job, true);
    } catch (failure) { if (mounted.current) { errorOperation.current = "start"; setError(failure instanceof Error ? failure : new Error(errorMessage(failure))); } }
    finally { startingRef.current = false; if (mounted.current) setStarting(false); }
  }, [observeJob]);
  const poll = useCallback(async (signal?: AbortSignal) => {
    const current = currentJob.current;
    if (!current) return;
    const result = await request<{ job: SessionJob }>(`/jobs/${encodeURIComponent(current.id)}`, { signal });
    if (!signal?.aborted && mounted.current && currentJob.current?.id === current.id) {
      setError(null); observeJob(result.job);
    }
  }, [observeJob]);
  useVisiblePolling(historyJobActive(job), 1100, poll,
    failure => { errorOperation.current = "poll"; setError(failure instanceof Error ? failure : new Error(errorMessage(failure))); });
  const checkAutomatically = useCallback(async () => {
    if (!canCheckAutomatically() || checkingAutomatically.current || startingRef.current || historyJobActive(currentJob.current)) return;
    checkingAutomatically.current = true;
    try {
      // 关闭设置只停掉后续检查，已经提交的任务仍接收进度与完成结果。
      const result = await request<{ job?: SessionJob }>("/sessions/auto-refresh", { method: "POST", body: {} });
      if (!mounted.current) return;
      if (errorOperation.current === "auto") setError(null);
      if (result.job) observeJob(result.job);
      else await readStatus();
    } finally { checkingAutomatically.current = false; }
  }, [observeJob, readStatus, canCheckAutomatically]);
  useVisiblePolling(autoInterval > 0, autoInterval, checkAutomatically,
    failure => { errorOperation.current = "auto"; setError(failure instanceof Error ? failure : new Error(errorMessage(failure))); });
  useEffect(() => { if (!autoInterval && errorOperation.current === "auto") setError(null); }, [autoInterval]);
  const retry = () => {
    if (error && errorOperation.current === "status") { void readStatus(); return; }
    if (error && errorOperation.current === "auto") { void checkAutomatically().catch(failure => setError(failure instanceof Error ? failure : new Error(errorMessage(failure)))); return; }
    if (historyJobActive(currentJob.current)) void poll().catch(failure => setError(failure instanceof Error ? failure : new Error(errorMessage(failure))));
    else void refresh(currentJob.current?.status === "failed"
      ? { client: currentJob.current.client, mode: currentJob.current.mode ?? "quick" } : lastRequest.current);
  };
  return { job, starting, updating: starting || historyJobActive(job), error, errorOperation: errorOperation.current, revision, status, refresh, retry, observeJob, observeStatus };
}

/** 隐藏或读取中的页面保留最新通知，避免持续同步反复取消完整结果。 */
export function useHistoryRevision(active: boolean, revision: number, refresh: () => void, updating = false, onReading?: (reading: boolean) => void) {
  const consumed = useRef(revision), callback = useRef(refresh);
  callback.current = refresh;
  useEffect(() => {
    if (!active || !onReading) return;
    onReading(updating);
    return () => onReading(false);
  }, [active, updating, onReading]);
  useEffect(() => {
    if (!active || updating || consumed.current === revision) return;
    consumed.current = revision; callback.current();
  }, [active, revision, updating]);
}
