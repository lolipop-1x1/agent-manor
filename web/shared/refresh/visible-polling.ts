export interface VisiblePollingEnvironment {
  visible(): boolean;
  now(): number;
  schedule(callback: () => void, delay: number): unknown;
  cancel(timer: unknown): void;
  subscribe(callback: () => void): () => void;
}

/** 隐藏时不安排新请求，恢复时按上次检查时间补查；慢请求之间不重叠。 */
export function startVisiblePolling(environment: VisiblePollingEnvironment, interval: number, task: (signal: AbortSignal) => Promise<void>, onError: (error: unknown) => void, immediateOnVisible = false) {
  const controller = new AbortController();
  let timer: unknown;
  let running = false;
  let lastStarted: number | undefined;
  const schedule = () => {
    if (timer !== undefined) environment.cancel(timer);
    timer = undefined;
    if (controller.signal.aborted || running || !environment.visible()) return;
    const delay = lastStarted === undefined ? 0 : Math.max(0, interval - (environment.now() - lastStarted));
    timer = environment.schedule(() => { timer = undefined; void run(); }, delay);
  };
  const run = async () => {
    if (controller.signal.aborted || !environment.visible() || running) return;
    running = true; lastStarted = environment.now();
    try { await task(controller.signal); }
    catch (error) { if (!controller.signal.aborted) onError(error); }
    finally { running = false; schedule(); }
  };
  const unsubscribe = environment.subscribe(() => {
    if (immediateOnVisible && environment.visible()) lastStarted = undefined;
    schedule();
  });
  schedule();
  return () => { controller.abort(); if (timer !== undefined) environment.cancel(timer); unsubscribe(); };
}
