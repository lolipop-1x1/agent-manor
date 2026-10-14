import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionIndexSummary, SessionJob, SessionRefreshOptions } from "../../../src/session-contracts";
import { errorMessage, isAborted, request } from "../api";
import { historyJobActive, historyJobCanUpdate, historyJobCompleted } from "./history-refresh";
import { useVisiblePolling } from "./useVisiblePolling";

export function useHistoryRefresh() {
  const [job, setJob] = useState<SessionJob>();
  const currentJob = useRef<SessionJob | undefined>(undefined);
  const notified = useRef<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const [error, setError] = useState<Error | null>(null);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<SessionIndexSummary>();
  const lastRequest = useRef<SessionRefreshOptions>({ mode: "quick" });
  const errorOperation = useRef<"status" | "start" | "poll">("status");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const observeJob = useCallback((next: SessionJob, initiated = false) => {
    const previous = currentJob.current;
    if (!mounted.current || !historyJobCanUpdate(previous, next, initiated)) return;
    if (historyJobCompleted(previous, next, notified.current, initiated)) {
      notified.current = next.id; setRevision(value => value + 1);
    }
    currentJob.current = next; setJob(next);
  }, []);
  const observeStatus = useCallback((next: SessionIndexSummary) => {
    if (!mounted.current || next.job && !historyJobCanUpdate(currentJob.current, next.job)) return;
    setStatus(next);
    if (next.job) observeJob(next.job);
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
  const retry = () => {
    if (error && errorOperation.current === "status") { void readStatus(); return; }
    if (historyJobActive(currentJob.current)) void poll().catch(failure => setError(failure instanceof Error ? failure : new Error(errorMessage(failure))));
    else void refresh(currentJob.current?.status === "failed"
      ? { client: currentJob.current.client, mode: currentJob.current.mode ?? "quick" } : lastRequest.current);
  };
  return { job, starting, updating: starting || historyJobActive(job), error, errorOperation: errorOperation.current, revision, status, refresh, retry, observeJob, observeStatus };
}

/** 隐藏页面保留通知，激活后沿用页面自己的更新路径。 */
export function useHistoryRevision(active: boolean, revision: number, refresh: () => void) {
  const consumed = useRef(revision), callback = useRef(refresh);
  callback.current = refresh;
  useEffect(() => {
    if (!active || consumed.current === revision) return;
    consumed.current = revision; callback.current();
  }, [active, revision]);
}
