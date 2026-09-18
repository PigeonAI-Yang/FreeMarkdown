import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { IDockviewPanel } from "dockview";
import { api, basename } from "../lib/ipc";
import { appStore, actions, dockRef, openFile, setRootFolder } from "../lib/store";
import { sessionMarkDirty } from "../lib/session";

/* ---------------- 菜单项模型（扁平一级，不做子菜单） ---------------- */

export interface MenuItem {
  label?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onClick?: () => void;
}

interface MenuState {
  /** 触发点（viewport 坐标） */
  x: number;
  y: number;
  items: MenuItem[];
}

/* ---------------- 全局单例右键菜单 ---------------- */

/**
 * 挂载在 App 根部：document capture 阶段拦截 contextmenu，
 * 替换 WebView2 默认网页菜单；输入类元素放行系统菜单。
 */
export function ContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [placed, setPlaced] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /* 拦截右键并构建菜单项 */
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      // 输入框/可编辑区域放行 WebView2 系统菜单（保留复制/粘贴）
      if (target?.closest("input, textarea, [contenteditable]")) return;
      e.preventDefault();
      const items = buildMenuItems(target);
      if (items.length === 0) return; // 无可用动作：只屏蔽不弹
      setPlaced(null);
      setMenu({ x: e.clientX, y: e.clientY, items });
    };
    document.addEventListener("contextmenu", onContextMenu, true);
    return () => document.removeEventListener("contextmenu", onContextMenu, true);
  }, []);

  /* 关闭时机：点菜单外 / Escape / 滚动（capture）/ 窗口失焦 / resize */
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  /* 视口右/下边缘翻转定位（先隐藏渲染，量完尺寸再贴位） */
  useLayoutEffect(() => {
    if (!menu) return;
    const el = menuRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 6;
    let x = menu.x;
    let y = menu.y;
    if (x + w > window.innerWidth - margin) x = Math.max(margin, menu.x - w);
    if (y + h > window.innerHeight - margin) y = Math.max(margin, menu.y - h);
    setPlaced({ x, y });
  }, [menu]);

  if (!menu) return null;
  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[160px] overflow-hidden rounded-lg border border-border-app bg-bg-elev py-1"
      style={{
        left: placed ? placed.x : menu.x,
        top: placed ? placed.y : menu.y,
        boxShadow: "var(--shadow)",
        visibility: placed ? "visible" : "hidden",
      }}
      // 菜单上再右键：只屏蔽系统菜单，不重复弹
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((it, i) =>
        it.separator ? (
          <div key={i} className="my-1 border-t border-border-app" />
        ) : (
          <button
            key={i}
            disabled={it.disabled}
            className={`block w-full cursor-default px-3 py-1.5 text-left text-[12px] hover:bg-bg-hover ${
              it.disabled
                ? "pointer-events-none text-text-3 opacity-50"
                : it.danger
                  ? "text-red-500"
                  : "text-text-2 hover:text-text-1"
            }`}
            onClick={() => {
              setMenu(null);
              it.onClick?.();
            }}
          >
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/* ---------------- 菜单项构建（按优先级：结构区域 > 链接 > 选区） ---------------- */

function buildMenuItems(target: HTMLElement | null): MenuItem[] {
  // a) 结构化区域（文件树 / 最近列表 / 标签页）
  const region = target?.closest("[data-ctx]");
  if (region instanceof HTMLElement) {
    const kind = region.dataset.ctx;
    const path = region.dataset.path ?? "";
    if (kind === "tree") return treeItems(path, region.dataset.isDir === "true");
    if (kind === "recent") return recentItems(path);
    if (kind === "tab") return tabItems(path);
  }

  // b) 链接（仅 http/https 提供“打开链接”；内链复制其实际目标路径）
  const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
  if (anchor) {
    const href = anchor.getAttribute("href") ?? "";
    const mdHref = anchor.dataset.mdHref;
    const items: MenuItem[] = [];
    if (/^https?:\/\//i.test(href)) {
      items.push({ label: "打开链接", onClick: () => void api.openExternal(href) });
    }
    items.push({
      label: "复制链接地址",
      onClick: () => void navigator.clipboard?.writeText(mdHref ?? href),
    });
    return items;
  }

  // c) 非空选区：复制 + 搜索
  const selected = window.getSelection()?.toString() ?? "";
  const text = selected.trim();
  if (text) {
    const query = text.replace(/\s+/g, " ").slice(0, 100);
    const short = query.length > 16 ? `${query.slice(0, 16)}…` : query;
    return [
      { label: "复制", onClick: () => void navigator.clipboard?.writeText(text) },
      {
        label: `搜索“${short}”`,
        onClick: () => {
          appStore.set({ searchOpen: true, searchQuery: query });
          sessionMarkDirty();
        },
      },
    ];
  }

  // d) 默认菜单：正文/侧边栏等空白处右键也有响应
  return defaultItems();
}

/** 空白处默认菜单：打开入口 + 当前活动文档的常用动作 */
function defaultItems(): MenuItem[] {
  const items: MenuItem[] = [
    { label: "打开文件…", onClick: () => actions.pickFile() },
    { label: "打开文件夹…", onClick: () => void actions.pickFolder() },
  ];
  const activePath = appStore.get().activePanelPath;
  if (activePath) {
    items.push(
      { separator: true },
      { label: "在资源管理器中显示", onClick: () => void api.reveal(activePath) },
      { label: "复制文件路径", onClick: () => void navigator.clipboard?.writeText(activePath) },
      {
        label: "关闭当前标签",
        onClick: () => {
          try {
            dockRef.api?.getPanel(`doc:${activePath}`)?.api.close();
          } catch {
            // 面板已不存在则忽略
          }
        },
      },
    );
  }
  return items;
}

/* ---------------- 文件树菜单 ---------------- */

function treeItems(path: string, isDir: boolean): MenuItem[] {
  if (isDir) {
    return [
      { label: "设为根目录", onClick: () => setRootFolder(path) },
      { separator: true },
      { label: "在资源管理器中显示", onClick: () => void api.reveal(path) },
      { separator: true },
      { label: "复制路径", onClick: () => void navigator.clipboard?.writeText(path) },
    ];
  }
  return [
    { label: "打开", onClick: () => openFile(path) },
    {
      label: "在新分屏打开",
      onClick: () => {
        // direction 需配合 groupId 才生效（落点为活动分组右侧）
        const groupId = dockRef.api?.activePanel?.group.id;
        openFile(path, undefined, groupId ? { groupId, direction: "right" } : undefined);
      },
    },
    { separator: true },
    { label: "在资源管理器中显示", onClick: () => void api.reveal(path) },
    { separator: true },
    { label: "复制路径", onClick: () => void navigator.clipboard?.writeText(path) },
    { label: "复制文件名", onClick: () => void navigator.clipboard?.writeText(basename(path)) },
  ];
}

/* ---------------- 最近打开菜单 ---------------- */

function recentItems(path: string): MenuItem[] {
  return [
    { label: "打开", onClick: () => openFile(path) },
    { label: "在资源管理器中显示", onClick: () => void api.reveal(path) },
    { separator: true },
    {
      label: "从最近移除",
      danger: true,
      onClick: () => {
        appStore.set({
          recentFiles: appStore.get().recentFiles.filter((f) => f !== path),
        });
        sessionMarkDirty();
      },
    },
  ];
}

/* ---------------- 标签页菜单 ---------------- */

function tabItems(path: string): MenuItem[] {
  const dockApi = dockRef.api;
  const panel = dockApi?.panels.find(
    (p) => (p.params as { path?: string } | undefined)?.path === path,
  );
  if (!dockApi || !panel) return [];
  const closeSome = (list: readonly IDockviewPanel[]) => {
    for (const p of list) {
      try {
        p.api.close();
      } catch {
        // 跳过关不掉的面板
      }
    }
  };
  const others = dockApi.panels.filter((p) => p.id !== panel.id);
  const groupPanels = panel.group.panels;
  const idx = groupPanels.indexOf(panel);
  return [
    { label: "关闭", onClick: () => closeSome([panel]) },
    { label: "关闭其他", disabled: others.length === 0, onClick: () => closeSome(others) },
    {
      label: "关闭右侧",
      disabled: idx < 0 || idx >= groupPanels.length - 1,
      onClick: () => closeSome(groupPanels.slice(idx + 1)),
    },
    { label: "关闭全部", disabled: dockApi.panels.length === 0, onClick: () => closeSome([...dockApi.panels]) },
    { separator: true },
    { label: "复制文件路径", onClick: () => void navigator.clipboard?.writeText(path) },
    { label: "在资源管理器中显示", onClick: () => void api.reveal(path) },
  ];
}
