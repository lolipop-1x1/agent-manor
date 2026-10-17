import { useEffect, useRef } from "react";
import { startVisiblePolling } from "./visible-polling";

export function useVisiblePolling(enabled: boolean, interval: number, task: (signal: AbortSignal) => Promise<void>, onError: (error: unknown) => void = () => {}, immediateOnVisible = false) {
  const callback = useRef(task), failure = useRef(onError);
  callback.current = task; failure.current = onError;
  useEffect(() => {
    if (!enabled) return;
    return startVisiblePolling({
      visible: () => document.visibilityState !== "hidden",
      now: () => Date.now(),
      schedule: (callback, delay) => setTimeout(callback, delay),
      cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
      subscribe: callback => { document.addEventListener("visibilitychange", callback); return () => document.removeEventListener("visibilitychange", callback); },
    }, interval, signal => callback.current(signal), error => failure.current(error), immediateOnVisible);
  }, [enabled, interval, immediateOnVisible]);
}
