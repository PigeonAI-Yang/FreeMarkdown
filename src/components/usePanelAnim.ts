import { useEffect, useRef, useState } from "react";
import { PANEL_ANIM_MS } from "../lib/panelAnim";

/**
 * 浮层面板滑入/滑出 Hook。
 *
 * 面板挂载在内容区容器内（工具栏下方），absolute 定位，只覆盖内容区，
 * 不压工具栏。动画只改 transform/opacity（GPU 合成），不触发布局。
 */
export function useFloatPanel(visible: boolean) {
  const [mounted, setMounted] = useState(visible);
  const [shown, setShown] = useState(visible);
  const nodeRef = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (reduceMotion) {
      setMounted(visible);
      return;
    }
    if (visible) {
      setMounted(true);
      // 先提交隐藏态，下一帧切到显示态形成过渡
      setShown(false);
      const id = requestAnimationFrame(() =>
        requestAnimationFrame(() => setShown(true)),
      );
      return () => cancelAnimationFrame(id);
    }
    // 关闭：切到隐藏态播出 transition，播完再卸载
    setShown(false);
    timer.current = setTimeout(() => {
      setMounted(false);
      timer.current = null;
    }, PANEL_ANIM_MS);
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [visible]);

  return { mounted, shown, nodeRef };
}

/**
 * 浮层面板基础样式：挂在内容区容器（relative）内，顶部从标签栏下方起算，
 * 不压工具栏、不压标签栏（标题行）。hidden=true 时为滑出 + 透明态。
 */
export function floatBaseStyle(
  side: "left" | "right",
  hidden: boolean,
): React.CSSProperties {
  return {
    position: "absolute",
    top: "var(--float-top, 34px)",
    bottom: 0,
    [side]: 0,
    zIndex: 30,
    background: "var(--bg)",
    boxShadow:
      side === "left"
        ? "8px 0 24px rgba(0,0,0,0.18)"
        : "-8px 0 24px rgba(0,0,0,0.18)",
    transform: hidden
      ? `translateX(${side === "left" ? "-" : ""}100%)`
      : "translateX(0)",
    opacity: hidden ? 0 : 1,
    transition: `transform ${PANEL_ANIM_MS}ms ease-out, opacity ${PANEL_ANIM_MS}ms ease-out`,
    willChange: "transform, opacity",
  } as React.CSSProperties;
}

/** 浮层打开时点击面板外部关闭（常驻监听，直到关闭才移除）。 */
export function useScrim(active: boolean, onOutside: () => void) {
  const ref = useRef(onOutside);
  ref.current = onOutside;
  useEffect(() => {
    if (!active) return;
    const handler = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("aside") || t.closest("[data-panel-toggle]")) return;
      ref.current();
    };
    // 延迟两帧注册，避免触发本次打开的那次点击
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.addEventListener("pointerdown", handler);
      }),
    );
    return () => {
      window.removeEventListener("pointerdown", handler);
      cancelAnimationFrame(id);
    };
  }, [active]);
}

export { PANEL_ANIM_MS };
