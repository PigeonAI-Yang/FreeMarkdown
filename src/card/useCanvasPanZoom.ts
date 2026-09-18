import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/** 画布视图状态：zoom 是相对"自动适应比例"的倍率，x/y 是屏幕像素平移量 */
export interface CanvasView {
  zoom: number;
  x: number;
  y: number;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 6;

/**
 * 预览画布交互：按住拖动平移、Ctrl/⌘ + 滚轮以光标为中心缩放、滚轮平移、双击复位。
 *
 * 变换只作用在卡片外层的包装盒上。导出走 snapdom 克隆卡片元素自身（祖先 transform
 * 不参与捕获），所以画布怎么拖怎么缩都不会影响导出结果，也不需要导出前复位。
 */
export function useCanvasPanZoom(
  stageRef: RefObject<HTMLElement | null>,
  /** 当前自动适应比例（fit）：真实缩放 = fit × zoom */
  fit: number,
) {
  const [view, setView] = useState<CanvasView>({ zoom: 1, x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const panStart = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const reset = useCallback(() => setView({ zoom: 1, x: 0, y: 0 }), []);

  /**
   * 以光标为中心缩放：保持光标下的内容点不动。
   * 变换为 translate(x, y) scale(z)、transform-origin: top center，
   * 记 O = 元素原点（stage 坐标，含 top-center 原点），则
   *   (x', y') = c - O - (z'/z) · (c - O - (x, y))
   */
  const zoomAt = useCallback(
    (factor: number, cx?: number, cy?: number) => {
      const el = stageRef.current;
      const v = viewRef.current;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      if (Math.abs(next - v.zoom) < 1e-4) return;
      const box = el?.querySelector(".card-scale") as HTMLElement | null;
      if (!el || !box || cx === undefined || cy === undefined) {
        setView({ ...v, zoom: next });
        return;
      }
      const s0 = fitRef.current * v.zoom;
      const s1 = fitRef.current * next;
      const rect = el.getBoundingClientRect();
      const ox = box.offsetLeft + box.offsetWidth / 2 - el.clientLeft;
      const oy = box.offsetTop - el.clientTop;
      const px = cx - rect.left;
      const py = cy - rect.top;
      const dx = px - ox - v.x;
      const dy = py - oy - v.y;
      const k = s1 / Math.max(1e-6, s0);
      setView({ zoom: next, x: px - ox - k * dx, y: py - oy - k * dy });
    },
    [stageRef],
  );

  const zoomByStep = useCallback((dir: 1 | -1) => zoomAt(dir > 0 ? 1.2 : 1 / 1.2), [zoomAt]);

  /* 滚轮：Ctrl/⌘ 缩放，否则平移（画布模式下不再用原生滚动条） */
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(Math.pow(1.0015, -e.deltaY), e.clientX, e.clientY);
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [stageRef, zoomAt]);

  /* 拖动平移：指针捕获 + 捕获阶段监听，窗口外松手也能正常收尾 */
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest("button, input, select, a, textarea")) return;
      panStart.current = { x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
      setPanning(true);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败不影响本次拖动 */
      }
    },
    [],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const st = panStart.current;
    if (!st) return;
    setView((v) => ({ ...v, x: st.vx + (e.clientX - st.x), y: st.vy + (e.clientY - st.y) }));
  }, []);

  const endPan = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!panStart.current) return;
    panStart.current = null;
    setPanning(false);
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* 忽略 */
    }
  }, []);

  return {
    view,
    panning,
    reset,
    zoomByStep,
    /** 真实渲染缩放（卡片尺寸 × 该值 = 屏幕像素） */
    scale: fit * view.zoom,
    stageHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPan,
      onPointerCancel: endPan,
      onDoubleClick: reset,
    },
  };
}
