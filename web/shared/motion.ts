/** 短暂反馈交给合成动画，读取共享 token；减少动态效果变化时立即中断。 */
export function animateSurface(element: HTMLElement, frames: Keyframe[], token = "--motion-state"): Animation | undefined {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  if (reduced.matches || !element.getClientRects().length) return;
  const style = getComputedStyle(element), time = style.getPropertyValue(token).trim();
  const duration = parseFloat(time) * (time.endsWith("ms") ? 1 : 1000);
  if (!(duration > 0)) return;
  const animation = element.animate(frames, { duration, easing: style.getPropertyValue("--motion-ease-out").trim() });
  const stop = () => { if (reduced.matches) animation.cancel(); };
  reduced.addEventListener("change", stop);
  const clean = () => reduced.removeEventListener("change", stop);
  void animation.finished.then(clean, clean);
  return animation;
}
