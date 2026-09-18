import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from "dockview";

export type DropZone = "center" | "left" | "right" | "top" | "bottom";

export interface TabDropTarget {
  group: DockviewGroupPanel;
  zone: DropZone;
  /** 同组排序时的插入下标（仅落点在标签上时有效） */
  index?: number;
}

/**
 * 根据落点坐标判定目标分组与区域——规则与 dockview 原生 overlay 完全对齐：
 *
 * - 落在某标签上 → center + 该标签下标（排序/移动到此标签前）；
 * - 落在标签栏空白处 → center + 末尾（追加到该组）；
 * - 落在内容区 → 按四边带判定：
 *     带宽 = 内容区尺寸的 20%（dockview 的 DEFAULT_ACTIVATION_SIZE），
 *     优先级 left → right → top → bottom，都不沾边才是 center；
 * - 落在分组间隙/容器空白 → 取消（面板原位不动）。
 *
 * 关键在于带宽用「百分比」而不是固定像素：固定 24px 的窄带在宽窗格里
 * 几乎只能碰到左右两边，想上下分屏得贴到极低——这正是之前手感很怪的原因。
 * 另外带宽按「内容区」算（不含标签栏），与 dockview 原生 overlay 一致。
 */
export function hitTestTabDrop(
  api: DockviewApi,
  x: number,
  y: number,
): TabDropTarget | null {
  const groups = api.groups;
  if (groups.length === 0) return null;
  const el = document.elementFromPoint(x, y);
  const host = document.querySelector(".doc-host") as HTMLElement | null;
  if (host && el && !host.contains(el)) return null;

  const gv = el?.closest?.(".dv-groupview") as HTMLElement | null;
  if (!gv) {
    // 落在 dock 区域外（工具栏/侧边栏/窗口外/分组间隙）：取消本次拖拽，面板原位不动
    return null;
  }
  const group = groupOfView(api, gv);
  if (!group) return null;

  // 1. 标签：排序到该标签前
  const tabEl = (el as HTMLElement | null)?.closest?.(".dv-tab") as HTMLElement | null;
  if (tabEl && gv.contains(tabEl)) {
    return { group, zone: "center", index: tabIndexOf(gv, tabEl) };
  }
  // 2. 标签栏空白：追加到该组末尾
  const tabStrip = (el as HTMLElement | null)?.closest?.(
    ".dv-tabs-and-actions-container",
  );
  if (tabStrip && gv.contains(tabStrip)) {
    return { group, zone: "center", index: tabCountOf(gv) };
  }
  // 3. 内容区四边带：与 dockview 原生 overlay 同规则（20% 带宽 + 固定优先级）
  const box = (gv.querySelector(".dv-content-container") ?? gv).getBoundingClientRect();
  const relX = (x - box.left) / Math.max(1, box.width);
  const relY = (y - box.top) / Math.max(1, box.height);
  if (relX < EDGE_RATIO) return { group, zone: "left" };
  if (relX > 1 - EDGE_RATIO) return { group, zone: "right" };
  if (relY < EDGE_RATIO) return { group, zone: "top" };
  if (relY > 1 - EDGE_RATIO) return { group, zone: "bottom" };
  return { group, zone: "center" };
}

/** 边缘带宽度占内容区尺寸的比例；20% = dockview DEFAULT_ACTIVATION_SIZE */
const EDGE_RATIO = 0.2;

/**
 * DOM 分组视图 → dockview 分组对象（按元素身份比对，不用下标）。
 *
 * 不能用「DOM 序号 → api.groups 序号」的映射：dockview 会残留 0 面板的空分组，
 * 两者顺序并不一致，一旦认错分组，moveTo 可能被指到空分组/浮动分组上，
 * 轻则落点错误，重则在 dockview 内部抛错并把面板摘出分组再也放不回去
 * （用户看到的"文档拖一下就没了"）。空分组不参与落点判定。
 */
function groupOfView(
  api: DockviewApi,
  gv: HTMLElement,
): DockviewGroupPanel | null {
  const group = api.groups.find(
    (g) => (g as unknown as { element?: HTMLElement }).element === gv,
  );
  if (!group || group.panels.length === 0) return null;
  return group;
}

/** 该标签在组内的下标 */
function tabIndexOf(groupView: HTMLElement, tab: HTMLElement): number {
  const tabs = Array.from(groupView.querySelectorAll(".dv-tab"));
  const i = tabs.indexOf(tab);
  return i >= 0 ? i : tabCountOf(groupView);
}

function tabCountOf(groupView: HTMLElement): number {
  return groupView.querySelectorAll(".dv-tab").length;
}

/**
 * 执行标签移动：同组排序 / 跨组移动 / 四向分屏。
 *
 * 重点：**不能**对「面板自己所在的分组」使用 `moveTo({group, position: 边缘})`。
 * dockview 4.13.1 在这条路径上会抛 `Invalid grid element`，而且可能已经把分组
 * 视图从 DOM 上摘掉了 —— 之后模型里这个分组还在、界面却少一个窗格，
 * 再拖任何东西都会把面板摘出分组再也放不回去（用户看到的"文档拖一下就没了"）。
 * 实测：同组 moveTo(边缘) 四种组合里三种抛错，其中一种直接让 domGroups 归零。
 *
 * 处理方式：
 * - 单面板分组：本来就没有可分的余地，保持原位（也避免踩到上面那个坑）；
 * - 多面板分组：改用「新建相邻分组 → 中心移动」两步，这两步都是可靠路径，
 *   实测四个方向都正确且不损坏网格。
 */
export function moveTabTo(
  api: DockviewApi,
  panel: IDockviewPanel,
  target: TabDropTarget,
) {
  if (target.zone === "center") {
    panel.api.moveTo({
      group: target.group,
      position: "center",
      ...(target.index !== undefined ? { index: target.index } : {}),
    });
    return;
  }
  if (target.group.id !== panel.group?.id) {
    // 跨组边缘分屏：dockview 这条路径工作正常
    panel.api.moveTo({ group: target.group, position: target.zone });
    return;
  }
  // 同组边缘：见上方说明
  if (panel.group.panels.length <= 1) return;
  const direction: "left" | "right" | "above" | "below" =
    target.zone === "left"
      ? "left"
      : target.zone === "right"
        ? "right"
        : target.zone === "top"
          ? "above"
          : "below";
  try {
    const newGroup = api.addGroup({
      referenceGroup: target.group,
      direction,
    });
    panel.api.moveTo({ group: newGroup, position: "center" });
  } catch (err) {
    // 新建分组这条路也失败时保持原位：宁可这次拖拽不生效，也不能丢面板
    console.warn("[tabdrag] 同组分屏失败，已保持原位:", err);
  }
}
