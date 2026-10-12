import { useEffect, useState, type RefObject } from "react";

/** 隐藏页面保留上一次有效宽度，显示或缩放后按容器重新绘制。 */
export function useChartWidth(ref: RefObject<HTMLElement | null>, enabled = true) {
  const [width, setWidth] = useState(1000);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const update = (value: number) => { if (value > 0) setWidth(value); };
    update(element.clientWidth);
    const observer = new ResizeObserver(entries => { update(entries[0]?.contentRect.width ?? 0); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return width;
}
