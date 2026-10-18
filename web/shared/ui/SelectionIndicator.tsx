import { useLayoutEffect, useRef } from "react";
import { animateSurface } from "../motion";

/** 只移动独立指示层，切换和窗口变化都不改变按钮布局。 */
export function SelectionIndicator({ value, selector = '[aria-selected="true"]', line = false }: {
  value: string; selector?: string; line?: boolean;
}) {
  const indicator = useRef<HTMLSpanElement>(null);
  const refresh = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    const node = indicator.current, group = node?.parentElement;
    if (!node || !group) return;
    let animation: Animation | undefined;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      const selected = group.querySelector<HTMLElement>(selector);
      if (!selected || !selected.offsetWidth || !group.offsetWidth) { node.hidden = true; return; }
      const previous = node.hidden ? undefined : node.getBoundingClientRect();
      const box = selected.getBoundingClientRect(), parent = group.getBoundingClientRect();
      animation?.cancel();
      node.hidden = false;
      node.style.width = `${box.width}px`;
      node.style.height = line ? "2px" : `${box.height}px`;
      const x = box.left - parent.left + group.scrollLeft - group.clientLeft;
      const y = box.top - parent.top + group.scrollTop - group.clientTop + (line ? box.height - 2 : 0);
      node.style.transform = `translate(${x}px, ${y}px)`;
      if (previous && !reduced.matches && (Math.abs(previous.left - box.left) > .5 || Math.abs(previous.width - box.width) > .5 || Math.abs(previous.top - (box.top + (line ? box.height - 2 : 0))) > .5)) {
        animation = animateSurface(node, [
          { transform: `translate(${previous.left - parent.left + group.scrollLeft - group.clientLeft}px, ${previous.top - parent.top + group.scrollTop - group.clientTop}px) scaleX(${previous.width / box.width})` },
          { transform: `translate(${x}px, ${y}px) scaleX(1)` },
        ], "--motion-navigation");
      }
    };
    refresh.current = update;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(group);
    for (const child of group.children) if (child !== node) observer.observe(child);
    const reduce = () => { animation?.cancel(); update(); };
    reduced.addEventListener("change", reduce);
    return () => { observer.disconnect(); reduced.removeEventListener("change", reduce); animation?.cancel(); };
  }, [selector, line]);
  useLayoutEffect(() => { refresh.current(); }, [value]);
  return <span ref={indicator} hidden aria-hidden="true" className={`selection-indicator${line ? " is-line" : ""}`} />;
}
