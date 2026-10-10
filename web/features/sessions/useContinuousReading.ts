import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { SessionMessageResult } from "../../../src/session-contracts";
import { ApiError, isAborted, request } from "../../shared/api";
import { sessionParams, TURN_PAGE_SIZE } from "./session-model";
import { appendReadingSegment, mergeReadingSegments, readingNeighbor, READING_SEGMENT_LIMIT, type ReadingDirection } from "./session-reading-window";

type Anchor = { id: string; offset: number };

export function useContinuousReading({ enabled, base, context, pane, mode, branch, onLoaded }: {
  enabled: boolean; base?: SessionMessageResult | null; context: string; pane: RefObject<HTMLDivElement | null>;
  mode: "brief" | "full" | "trace"; branch?: string; onLoaded: (messages: SessionMessageResult["messages"], resident: SessionMessageResult["messages"]) => void;
}) {
  const [window, setWindow] = useState<{ base: SessionMessageResult; context: string; segments: SessionMessageResult[] }>();
  const [loading, setLoading] = useState<ReadingDirection>();
  const [error, setError] = useState<Error>();
  const [errorDirection, setErrorDirection] = useState<ReadingDirection>();
  const controller = useRef<AbortController | undefined>(undefined);
  const anchor = useRef<Anchor | undefined>(undefined);
  const previousTop = useRef(0);
  const live = useRef({ base, context, enabled });
  live.current = { base, context, enabled };
  const segments = useMemo(() => !enabled || !base ? [] : window?.base === base && window.context === context ? window.segments : [base], [enabled, base, context, window]);
  const data = useMemo(() => segments.length ? mergeReadingSegments(segments) : base, [segments, base]);
  useEffect(() => {
    controller.current?.abort(); controller.current = undefined;
    setLoading(undefined); setError(undefined); anchor.current = undefined;
    setWindow(undefined);
    previousTop.current = pane.current?.scrollTop ?? 0;
    return () => { controller.current?.abort(); };
  }, [base, context, enabled]);
  useLayoutEffect(() => {
    const current = pane.current;
    if (!anchor.current || !current) return;
    const node = document.getElementById(anchor.current.id);
    if (node && current.contains(node)) current.scrollTop += node.getBoundingClientRect().top - current.getBoundingClientRect().top - anchor.current.offset;
    previousTop.current = current.scrollTop;
    anchor.current = undefined;
  }, [window, pane]);
  const load = async (direction: ReadingDirection) => {
    if (!enabled || !base || controller.current || !segments.length) return;
    const edge = direction === "earlier" ? segments[0]! : segments.at(-1)!;
    const neighbor = readingNeighbor(edge, direction);
    if (!neighbor) return;
    const pending = new AbortController(); controller.current = pending;
    setLoading(direction); setError(undefined);
    const fetchSegment = (offset: number) => request<SessionMessageResult>(`/sessions/${encodeURIComponent(base.session.id)}/messages${sessionParams({
      version: base.version, mode, branch, pageUnit: "turn", page: neighbor.page, pageSize: TURN_PAGE_SIZE,
      messageOffset: offset, messageLimit: READING_SEGMENT_LIMIT, maxTextChars: 6000,
    })}`, { signal: pending.signal });
    try {
      let incoming = await fetchSegment(neighbor.offset === "last" ? 0 : neighbor.offset);
      if (neighbor.offset === "last") {
        const total = incoming.turns?.reduce((count, turn) => count + turn.messageCount, 0) ?? 0;
        const lastOffset = Math.floor(Math.max(0, total - 1) / READING_SEGMENT_LIMIT) * READING_SEGMENT_LIMIT;
        if (lastOffset > 0) incoming = await fetchSegment(lastOffset);
      }
      if (pending.signal.aborted || live.current.base !== base || live.current.context !== context || !live.current.enabled) return;
      if (incoming.version !== base.version) throw new ApiError("VERSION_MISMATCH", "结果版本发生变化，请重试。", { key: "sessions.reading.versionChanged" });
      const next = appendReadingSegment(segments, incoming, direction);
      const retainedIds = new Set(next.flatMap(segment => segment.messages.map(message => `session-message-${message.id}`)));
      const retainedTurns = new Set(next.flatMap(segment => segment.messages.map(message => `session-turn-${message.turnId || "unknown"}`)));
      const current = pane.current;
      if (current) {
        const top = current.getBoundingClientRect().top;
        const candidates = [...current.querySelectorAll<HTMLElement>(".session-message, .session-turn")];
        const node = candidates.find(node => retainedIds.has(node.id) && node.getBoundingClientRect().bottom > top)
          ?? candidates.find(node => retainedTurns.has(node.id) && node.getBoundingClientRect().bottom > top);
        if (node) anchor.current = { id: node.id, offset: node.getBoundingClientRect().top - top };
      }
      onLoaded(incoming.messages, next.flatMap(segment => segment.messages));
      setWindow({ base, context, segments: next });
    } catch (failure) {
      if (!isAborted(failure) && live.current.base === base && live.current.context === context) { setError(failure instanceof Error ? failure : new Error(String(failure))); setErrorDirection(direction); }
    } finally {
      if (controller.current === pending) { controller.current = undefined; setLoading(undefined); }
    }
  };
  useEffect(() => {
    if (!enabled || !base) return;
    const frame = requestAnimationFrame(() => {
      const current = pane.current;
      // 定位页的顶部也可能没有可触发的滚动距离，先补一段前文并保留定位锚点。
      if (current) void load("earlier");
    });
    return () => cancelAnimationFrame(frame);
  }, [base, context, enabled]);
  const onScroll = () => {
    const current = pane.current;
    if (!current) return;
    const previous = previousTop.current;
    previousTop.current = current.scrollTop;
    if (error || anchor.current) return;
    if (current.scrollTop < previous && current.scrollTop < 120) void load("earlier");
    else if (current.scrollTop > previous && current.scrollHeight - current.clientHeight - current.scrollTop < 120) void load("later");
  };
  return { data, loading, error, errorDirection, load, onScroll,
    earlier: !!segments.length && !!readingNeighbor(segments[0]!, "earlier"),
    later: !!segments.length && !!readingNeighbor(segments.at(-1)!, "later") };
}
