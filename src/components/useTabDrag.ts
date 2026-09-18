import { useEffect, useRef } from "react";
import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from "dockview";
import { hitTestTabDrop, moveTabTo } from "../lib/tabdrop";
import { gridBroken, openFile, repairGrid } from "../lib/store";

const DRAG_THRESHOLD = 6; // px，超过才算拖拽（区分点击）

interface DragState {
  panel: IDockviewPanel;
  startX: number;
  startY: number;
  dragging: boolean;
  ghost: HTMLElement | null;
  indicator: HTMLElement | null;
  zone: string | null;
  pointerId: number;
  /** 指针捕获元素（松手事件在窗口外也能收到） */
  captureEl: HTMLElement | null;
}

/**
 * Pointer Events 标签拖拽（方案 A：文件拖放走原生 Tauri，标签拖拽走指针）。
 *
 * - 标签栏 pointerdown → 移动超阈值进入拖拽；
 * - onWillDragPanel/Group preventDefault 禁掉 dockview 原生 HTML5 拖拽
 *   （否则 wry/OS 层会显示🚫）；
 * - 拖拽中自绘 ghost 跟手 + 落点高亮预览（pointer-events:none）；
 * - 松手按 hitTest 调 moveTo；Esc 取消。
 * 文件拖放由 dockview onDidDrop 处理，两条链路互不相干。
 */
export function usePointerTabDrag(api: DockviewApi | null) {
  const state = useRef<DragState | null>(null);

  useEffect(() => {
    if (!api) return;

    // 关键：禁掉 dockview 原生 HTML5 拖拽启动（wry 下会显示🚫）
    const d1 = api.onWillDragPanel((e) => e.nativeEvent.preventDefault());
    const d2 = api.onWillDragGroup((e) => e.nativeEvent.preventDefault());

    const host = document.querySelector(".doc-host") as HTMLElement | null;
    if (!host) return;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      const tab = target.closest(".dv-tab") as HTMLElement | null;
      if (!tab || tab.closest(".dv-floating")) return;
      // 关闭按钮不接管
      if (target.closest(".dv-default-tab-action")) return;
      const panel = panelFromTab(api, tab);
      if (!panel) return;
      cleanup(); // 清掉上一次可能残留的覆盖层（松手事件丢失的兜底）
      // 拖拽开始前先修一次网格：损坏状态下 moveTo 会把面板吞掉
      if (gridBroken(api)) repairGrid(api);
      state.current = {
        panel,
        startX: e.clientX,
        startY: e.clientY,
        dragging: false,
        ghost: null,
        indicator: null,
        zone: null,
        pointerId: e.pointerId,
        captureEl: tab,
      };
      // 指针捕获：松手即使发生在窗口外也能收到 pointerup
      try {
        tab.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败不影响本次拖拽 */
      }
      // 捕获阶段监听：避免被其它组件的 stopPropagation 吞掉
      window.addEventListener("pointermove", onPointerMove, true);
      window.addEventListener("pointerup", onPointerUp, true);
      window.addEventListener("pointercancel", onCancel, true);
      window.addEventListener("blur", onCancel, true);
      window.addEventListener("dragend", onCancel, true);
      window.addEventListener("keydown", onKey);
    };

    const onPointerMove = (e: PointerEvent) => {
      const st = state.current;
      if (!st || e.pointerId !== st.pointerId) return;
      // 按钮已松开但松手事件没到（例如在窗口外释放）：就地收尾，防止覆盖层残留
      if (st.dragging && e.buttons === 0) {
        cleanup();
        return;
      }
      if (!st.dragging) {
        if (Math.hypot(e.clientX - st.startX, e.clientY - st.startY) < DRAG_THRESHOLD)
          return;
        st.dragging = true;
        ensureOverlays(st, st.panel.title ?? st.panel.id);
      }
      if (st.ghost) {
        st.ghost.style.left = `${e.clientX + 12}px`;
        st.ghost.style.top = `${e.clientY + 12}px`;
      }
      const t = hitTestTabDrop(api, e.clientX, e.clientY);
      st.zone = t ? t.zone : null;
      drawIndicator(st, e.clientX, e.clientY, t);
    };

    const onPointerUp = (e: PointerEvent) => {
      const st = state.current;
      const wasDragging = st?.dragging ?? false;
      const zone = st?.zone ?? null;
      cleanup();
      if (wasDragging && st) {
        const panelId = st.panel.id;
        // 网格损坏时不做任何布局操作：dockview 内部会抛 Invalid grid element，
        // 且会把面板摘出分组再也放不回去（表现为文档凭空消失）。先尝试修复。
        if (gridBroken(api) && !repairGrid(api)) {
          console.warn("[tabdrag] 网格状态异常且修复失败，已跳过本次移动");
          return;
        }
        const t = hitTestTabDrop(api, e.clientX, e.clientY);
        if (t && (t.zone !== "center" || t.group.id !== st.panel.group.id || zone)) {
          try {
            moveTabTo(api, st.panel, t);
          } catch (err) {
            console.warn("[tabdrag] moveTo 失败:", err);
          }
        }
        // 兜底：若 moveTo 把面板弄丢了，立刻按路径重新打开（内部会按需重建网格）
        if (!api.getPanel(panelId) && panelId.startsWith("doc:")) {
          console.warn("[tabdrag] 面板在移动中丢失，正在恢复:", panelId);
          openFile(panelId.slice(4));
        }
      }
    };

    const onCancel = () => cleanup();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && state.current?.dragging) cleanup();
    };

    function cleanup() {
      const st = state.current;
      state.current = null;
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("blur", onCancel, true);
      window.removeEventListener("dragend", onCancel, true);
      window.removeEventListener("keydown", onKey);
      try {
        if (st?.captureEl?.hasPointerCapture(st.pointerId)) {
          st.captureEl.releasePointerCapture(st.pointerId);
        }
      } catch {
        /* 元素已卸载等情况忽略 */
      }
      st?.ghost?.remove();
      st?.indicator?.remove();
    }

    host.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      host.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      cleanup();
      d1.dispose();
      d2.dispose();
    };
  }, [api]);
}

function panelFromTab(
  api: DockviewApi,
  tab: Element,
): IDockviewPanel | null {
  const groupView = tab.closest(".dv-groupview");
  const views = Array.from(document.querySelectorAll(".dv-groupview"));
  const gi = views.indexOf(groupView as HTMLElement);
  const group: DockviewGroupPanel | undefined =
    gi >= 0
      ? api.groups[Math.min(gi, api.groups.length - 1)]
      : api.activeGroup;
  if (!group) return null;
  const tabs = Array.from(
    (groupView as HTMLElement).querySelectorAll(".dv-tab"),
  );
  const ti = tabs.indexOf(tab as HTMLElement);
  const panels = group.panels ?? [];
  return panels[ti] ?? group.activePanel ?? panels[0] ?? null;
}

function ensureOverlays(
  st: DragState,
  title: string,
) {
  if (st.ghost) return;
  const g = document.createElement("div");
  g.textContent = title;
  g.style.cssText =
    "position:fixed;z-index:9999;pointer-events:none;max-width:220px;" +
    "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
    "padding:6px 12px;font-size:12px;border-radius:8px;" +
    "background:var(--bg-elev);color:var(--text-1);" +
    "border:1px solid var(--border);box-shadow:var(--shadow);opacity:.95;";
  document.body.appendChild(g);
  st.ghost = g;
  const ind = document.createElement("div");
  ind.style.cssText =
    "position:fixed;z-index:9998;pointer-events:none;display:none;" +
    "background:color-mix(in srgb, var(--accent) 22%, transparent);" +
    "border:1.5px solid var(--accent);border-radius:6px;" +
    "transition:all 80ms ease-out;";
  document.body.appendChild(ind);
  st.indicator = ind;
}

function drawIndicator(
  st: DragState,
  x: number,
  y: number,
  t: ReturnType<typeof import("../lib/tabdrop").hitTestTabDrop>,
) {
  if (!st.indicator) return;
  if (!t) {
    st.indicator.style.display = "none";
    return;
  }
  const el = document.elementFromPoint(x, y);
  const gv = el?.closest?.(".dv-groupview") as HTMLElement | null;
  // 预览框按「内容区」绘制（不含标签栏），与命中判定的坐标系一致
  const box = (gv?.querySelector(".dv-content-container") ?? gv) as HTMLElement | null;
  const rect = box?.getBoundingClientRect();
  if (!rect) {
    st.indicator.style.display = "none";
    return;
  }
  const pad = 4;
  let r: { x: number; y: number; w: number; h: number };
  switch (t.zone) {
    case "left":
      r = { x: rect.x + pad, y: rect.y + pad, w: rect.width / 2 - pad * 1.5, h: rect.height - pad * 2 };
      break;
    case "right":
      r = { x: rect.x + rect.width / 2 + pad / 2, y: rect.y + pad, w: rect.width / 2 - pad * 1.5, h: rect.height - pad * 2 };
      break;
    case "top":
      r = { x: rect.x + pad, y: rect.y + pad, w: rect.width - pad * 2, h: rect.height / 2 - pad * 1.5 };
      break;
    case "bottom":
      r = { x: rect.x + pad, y: rect.y + rect.height / 2 + pad / 2, w: rect.width - pad * 2, h: rect.height / 2 - pad * 1.5 };
      break;
    default:
      r = { x: rect.x + pad, y: rect.y + pad, w: rect.width - pad * 2, h: rect.height - pad * 2 };
  }
  st.indicator.style.display = "block";
  st.indicator.style.left = `${r.x}px`;
  st.indicator.style.top = `${r.y}px`;
  st.indicator.style.width = `${r.w}px`;
  st.indicator.style.height = `${r.h}px`;
}
