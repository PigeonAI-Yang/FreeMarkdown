/** 面板显隐动画时长（ms），全应用统一 */
export const PANEL_ANIM_MS = 200;

/**
 * 宽度从 from 到 to 的 ease-out cubic 动画，每帧回调 onFrame。
 * 返回停止函数。调用方负责在卸载/反转时 stop。
 */
export function animateWidth(
  from: number,
  to: number,
  onFrame: (w: number) => void,
  onDone?: () => void,
): () => void {
  let raf = 0;
  let stopped = false;
  const t0 = performance.now();
  const tick = (now: number) => {
    if (stopped) return;
    const t = Math.min(1, (now - t0) / PANEL_ANIM_MS);
    const e = 1 - Math.pow(1 - t, 3);
    onFrame(Math.round(from + (to - from) * e));
    if (t < 1) {
      raf = requestAnimationFrame(tick);
    } else {
      onDone?.();
    }
  };
  raf = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}
