import { useEffect, useRef, useState } from "react";
import type { ComponentProps, HTMLAttributes, MouseEvent, PointerEvent } from "react";
import type * as Popover from "@radix-ui/react-popover";
import type { UsageReport } from "../../../src/usage-contracts";

/** 时间主图与速度图共享选择、浮层固定和焦点恢复，数据与绘制留在调用方。 */
export function useUsageTimeInteraction<T>(report: UsageReport, interactive: boolean, view = "trend") {
  const [detail, setDetail] = useState<T | null>(null);
  const pinned = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const popover = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const suppressFocus = useRef(false);
  const anchor = useRef({ getBoundingClientRect: () => new DOMRect() });
  useEffect(() => { pinned.current = false; restoreFocus.current = false; setDetail(null); }, [report, interactive, view]);
  const show = (value: T, target: HTMLElement, rect = target.getBoundingClientRect()) => {
    if (!interactive) return;
    trigger.current = target; anchor.current = { getBoundingClientRect: () => rect }; setDetail(value);
  };
  const focus = (value: T, target: HTMLElement) => {
    if (suppressFocus.current) { suppressFocus.current = false; return; }
    show(value, target);
  };
  const hover = (value: T, target: HTMLElement) => {
    if (pinned.current) return false;
    show(value, target); return true;
  };
  const pin = (value: T, target: HTMLElement) => { pinned.current = true; show(value, target); };
  const leave = (event: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>) => {
    if (!pinned.current && !(event.relatedTarget instanceof Node && popover.current?.contains(event.relatedTarget))) setDetail(null);
  };
  const close = () => {
    restoreFocus.current = pinned.current || document.activeElement === trigger.current || !!popover.current?.contains(document.activeElement);
    pinned.current = false; setDetail(null);
  };
  const sliderProps = (count: number, activeIndex: number, select: (index: number) => T): HTMLAttributes<HTMLDivElement> => {
    const indexAt = (clientX: number, target: HTMLDivElement) => {
      const bounds = target.getBoundingClientRect();
      return Math.max(0, Math.min(count - 1, Math.floor((clientX - bounds.left) / bounds.width * count)));
    };
    return {
      onPointerMove: event => { if (!pinned.current && (event.pointerType === "mouse" || event.buttons)) show(select(indexAt(event.clientX, event.currentTarget)), event.currentTarget, new DOMRect(event.clientX, event.clientY, 0, 0)); },
      onPointerLeave: leave,
      onFocus: event => {
        if (suppressFocus.current) { suppressFocus.current = false; return; }
        show(select(activeIndex), event.currentTarget);
      },
      onPointerDown: event => {
        event.currentTarget.focus({ preventScroll: true }); pinned.current = true;
        show(select(indexAt(event.clientX, event.currentTarget)), event.currentTarget, new DOMRect(event.clientX, event.clientY, 0, 0));
      },
      onKeyDown: event => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
          const index = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : Math.max(0, Math.min(count - 1, activeIndex + direction));
          show(select(index), event.currentTarget);
        } else if (["Enter", " "].includes(event.key)) { event.preventDefault(); pin(select(activeIndex), event.currentTarget); }
      },
    };
  };
  const contentProps: Pick<ComponentProps<typeof Popover.Content>, "ref" | "onOpenAutoFocus" | "onCloseAutoFocus" | "onInteractOutside" | "onPointerLeave"> = {
    ref: popover,
    onOpenAutoFocus: event => event.preventDefault(),
    onCloseAutoFocus: event => {
      event.preventDefault();
      if (restoreFocus.current && trigger.current?.isConnected && document.activeElement !== trigger.current) { suppressFocus.current = true; trigger.current.focus({ preventScroll: true }); }
    },
    onInteractOutside: event => { if ((event.target as HTMLElement).closest(".usage-bucket-selector, .usage-heatmap")) event.preventDefault(); },
    onPointerLeave: () => { if (!pinned.current && !popover.current?.contains(document.activeElement)) setDetail(null); },
  };
  return { detail, anchor, sliderProps, contentProps, focus, hover, pin, leave,
    rootProps: { open: interactive && detail !== null, onOpenChange: (open: boolean) => { if (!open) close(); } } };
}
