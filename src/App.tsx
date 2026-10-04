import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { SerializedDockview } from "dockview";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { api } from "./lib/ipc";
import {
  actions,
  appStore,
  dockRef,
  openCardPanel,
  openEditPanel,
  openFile,
  setRootFolder,
  scrollMap,
  useApp,
  type EditMode,
} from "./lib/store";
import { loadSession, saveSessionNow, sessionMarkDirty } from "./lib/session";
import type { DocWidth } from "./lib/store";
import { DockHost } from "./components/DockHost";
import { Sidebar } from "./components/Sidebar";
import { TocPanel } from "./components/TocPanel";
import { SearchPanel } from "./components/SearchPanel";
import { SettingsPage } from "./components/SettingsPage";
import { ContextMenu } from "./components/ContextMenu";
import { restoreCardSettings } from "./card/cardStore";
import { useFileOpenBridge } from "./lib/filedrop";

const DOC_WIDTH_VALUE: Record<DocWidth, string> = {
  narrow: "60ch",
  medium: "72ch",
  wide: "88ch",
  full: "none",
};

export default function App() {
  return (
    <>
      <AppShell />
      {/* 全局右键菜单：挂在根部，启动页/设置页分支外也生效 */}
      <ContextMenu />
      {/* 无边框边缘拉伸热区：上/下/左/右 4 边 + 4 角（角落同时处理两方向） */}
      <WindowResizeZones />
    </>
  );
}

function AppShell() {
  const app = useApp();
  useFileOpenBridge();
  const [layout, setLayout] = useState<SerializedDockview | null>(null);

  /* ---------- 启动：加载会话，恢复主题/字号/现场 ---------- */
  useEffect(() => {
    (async () => {
      const session = await loadSession();
      Object.entries(session.scroll).forEach(([k, v]) => scrollMap.set(k, v));
      appStore.set({
        theme: session.theme,
        fontSize: session.fontSize,
        docWidth: session.docWidth ?? "medium",
        codeWrap: session.codeWrap ?? true,
        docBgLight: session.docBgLight ?? "#f7f1e6",
        docBgDark: session.docBgDark ?? "#232323",
        floatBgLight: session.floatBgLight ?? "#ebe4d5",
        floatBgDark: session.floatBgDark ?? "#1f1f1f",
        edMarkLight: session.edMarkLight ?? "#a89e8a",
        edMarkDark: session.edMarkDark ?? "#6e6e6e",
        edHeadingLight: session.edHeadingLight ?? "#4f5bd5",
        edHeadingDark: session.edHeadingDark ?? "#7ab7ff",
        edCodeLight: session.edCodeLight ?? "#b25e09",
        edCodeDark: session.edCodeDark ?? "#e5a06a",
        edStringLight: session.edStringLight ?? "#0a7f4f",
        edStringDark: session.edStringDark ?? "#7dd3a8",
        edMatchLight: session.edMatchLight ?? "#ffd8a8",
        edMatchDark: session.edMatchDark ?? "#4a4020",
        edGutterLight: session.edGutterLight ?? "#a8a299",
        edGutterDark: session.edGutterDark ?? "#5f5f5f",
        edFontSize: session.edFontSize ?? 13,
        edLineHeight: session.edLineHeight ?? 1.7,
        diagnosticMode: session.diagnosticMode ?? false,
        recentFiles: session.recentFiles,
        recentFolders: session.recentFolders,
        sidebarVisible: session.sidebarVisible,
        tocVisible: session.tocVisible,
        sidebarWidth: session.sidebarWidth ?? 240,
        tocWidth: session.tocWidth ?? 240,
        rootFolder: session.rootFolder,
        searchRoot: session.searchRoot ?? null,
        editMode: session.editMode ?? "split",
        booted: true,
      });
      setLayout((session.layout as SerializedDockview) ?? null);
      // 恢复卡片导出选项
      restoreCardSettings(session.card);

      // 窗口尺寸恢复
      try {
        const w = getCurrentWindow();
        if (session.window?.maximized) await w.maximize();
        else if (
          session.window &&
          session.window.width > 100 &&
          session.window.height > 100
        )
          await w.setSize(new LogicalSize(session.window.width, session.window.height));
      } catch {
        // 忽略窗口恢复失败
      }
    })();
  }, []);

  /* ---------- 主题与字号落到根节点 ---------- */
  useEffect(() => {
    document.documentElement.dataset.theme = app.theme;
  }, [app.theme]);
  useEffect(() => {
    document.documentElement.style.setProperty("--doc-font-size", `${app.fontSize}px`);
  }, [app.fontSize]);
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--doc-max-width",
      DOC_WIDTH_VALUE[app.docWidth],
    );
  }, [app.docWidth]);
  useEffect(() => {
    document.documentElement.dataset.codeWrap = app.codeWrap ? "wrap" : "scroll";
    // 已渲染的块同步跟随总开关（新块在 wrapCodeBlock 里读 dataset 初始化）
    document
      .querySelectorAll(".code-block")
      .forEach((el) => el.classList.toggle("wrapped", app.codeWrap));
  }, [app.codeWrap]);
  // 按主题写所有可调色值：当前主题下改的就是当前主题的
  useEffect(() => {
    const root = document.documentElement;
    const isDark = app.theme === "dark";
    root.style.setProperty("--doc-bg", isDark ? app.docBgDark : app.docBgLight);
    root.style.setProperty("--float-bg", isDark ? app.floatBgDark : app.floatBgLight);
    root.style.setProperty("--ed-mark", isDark ? app.edMarkDark : app.edMarkLight);
    root.style.setProperty("--ed-heading", isDark ? app.edHeadingDark : app.edHeadingLight);
    root.style.setProperty("--ed-code", isDark ? app.edCodeDark : app.edCodeLight);
    root.style.setProperty("--ed-string", isDark ? app.edStringDark : app.edStringLight);
    root.style.setProperty("--ed-match", isDark ? app.edMatchDark : app.edMatchLight);
    root.style.setProperty("--ed-gutter-fg", isDark ? app.edGutterDark : app.edGutterLight);
    root.style.setProperty("--ed-font-size", `${app.edFontSize}px`);
    root.style.setProperty("--ed-line-height", String(app.edLineHeight));
  }, [
    app.theme,
    app.docBgLight, app.docBgDark,
    app.floatBgLight, app.floatBgDark,
    app.edMarkLight, app.edMarkDark,
    app.edHeadingLight, app.edHeadingDark,
    app.edCodeLight, app.edCodeDark,
    app.edStringLight, app.edStringDark,
    app.edMatchLight, app.edMatchDark,
    app.edGutterLight, app.edGutterDark,
    app.edFontSize, app.edLineHeight,
  ]);

  /* ---------- 全局动作注册（水印/侧边栏使用） ---------- */
  useEffect(() => {
    actions.pickFile = async () => {
      const p = await api.pickMdFile();
      if (p) openFile(p);
    };
    actions.pickFolder = async () => {
      const p = await api.pickFolder();
      if (p) setRootFolder(p);
      return p;
    };
  }, []);

  /* ---------- 关窗前保存会话 + 定期兜底保存 ---------- */
  useEffect(() => {
    const w = getCurrentWindow();
    // 显式接管关闭流程：保存（限时）后销毁窗口，避免关闭时序竞争
    const un = w.onCloseRequested(async (event) => {
      event.preventDefault();
      try {
        await Promise.race([
          saveSessionNow(dockRef.api?.toJSON()),
          new Promise((r) => setTimeout(r, 1200)),
        ]);
      } finally {
        await w.destroy();
      }
    });
    // 原生文件拖放（dragDropEnabled=true）：只处理真实文件 drop，
    // paths 为空的事件直接忽略，不干扰 dockview 内部拖拽。
    const unDrop = w.onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const paths = event.payload.paths;
      if (!paths || paths.length === 0) return;
      for (const p of paths) {
        const lower = p.toLowerCase();
        if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
          openFile(p);
        } else {
          // 可能是目录：尝试列目录，成功则设为根目录
          void api.listDir(p).then(
            () => setRootFolder(p),
            () => {},
          );
        }
      }
    });
    // 定时兜底保存：与 scheduleLayoutSave 同规则，空布局不保存——
    // 否则恰好撞上面板全关的瞬间，就会把有效现场（布局+打开列表）覆盖成空。
    const interval = setInterval(() => {
      const api = dockRef.api;
      if (!api || api.panels.length === 0) return;
      void saveSessionNow(api.toJSON());
    }, 30_000);
    return () => {
      void un;
      void unDrop;
      clearInterval(interval);
    };
  }, []);

  /* ---------- 冷启动计时：UI 完整挂起后上报 ---------- */
  useEffect(() => {
    if (!app.booted) return;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(async () => {
        try {
          const ms = await api.startupMs();
          appStore.set({ coldStartMs: ms });
          void api.perfLog("cold-start-to-interactive", ms);
        } catch {
          // perf 上报失败不影响使用
        }
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [app.booted]);

  /* ---------- Ctrl/⌘ + 滚轮缩放（全局委托，挂 window 不依赖 ref） ---------- */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let raf = 0;
    let pendingZoom: number | null = null;
    const flush = () => {
      raf = 0;
      if (pendingZoom == null) return;
      document.documentElement.style.setProperty(
        "--doc-zoom",
        String(pendingZoom),
      );
      pendingZoom = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const t = e.target as HTMLElement;
      // 编辑器内改 --ed-font-size（CM 布局自己算字号，zoom 会让光标位置偏）
      if (t.closest(".edit-editor")) {
        const cur =
          parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue(
              "--ed-font-size",
            ),
          ) || 13;
        const next = Math.min(24, Math.max(10, cur + (e.deltaY < 0 ? 1 : -1)));
        document.documentElement.style.setProperty(
          "--ed-font-size",
          `${next}px`,
        );
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          appStore.set({ edFontSize: next });
          void import("./lib/session").then(({ sessionMarkDirty }) =>
            sessionMarkDirty(),
          );
          timer = null;
        }, 300);
        return;
      }
      // 其余区域（阅读区/卡片预览）统一改 --doc-zoom：GPU 合成本不触发 layout
      const cur =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--doc-zoom",
          ),
        ) || 1;
      const next = Math.min(3, Math.max(0.5, cur * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      pendingZoom = next;
      if (!raf) raf = requestAnimationFrame(flush);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // 缩放比例不回写字号（zoom 是视觉缩放，字号记录保持原值）
        timer = null;
      }, 300);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("wheel", onWheel);
      if (timer) clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  /* ---------- 快捷键（含浏览器快捷键屏蔽） ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (e.key === "F5") {
        e.preventDefault();
        actions.refreshActive();
        return;
      }
      if (!ctrl) {
        // 非 Ctrl 键：屏蔽 F12 DevTools
        if (e.key === "F12") e.preventDefault();
        return;
      }
      // 我们支持的快捷键：先处理，再阻止默认
      if (k === "o" && e.shiftKey) {
        e.preventDefault();
        actions.pickFolder();
      } else if (k === "o") {
        e.preventDefault();
        actions.pickFile();
      } else if (k === "f" && e.shiftKey) {
        e.preventDefault();
        appStore.set({ searchOpen: !appStore.get().searchOpen });
      } else if (k === "f") {
        // Ctrl+F → 切换全文搜索（屏蔽浏览器查找）
        e.preventDefault();
        appStore.set({ searchOpen: !appStore.get().searchOpen });
      } else if (k === "s" && !e.shiftKey) {
        // Ctrl+S → 保存当前文档（编辑器内 CM6 已绑，这里兜底全局）
        e.preventDefault();
        actions.saveActive();
      } else if (k === "z" && !e.shiftKey) {
        // Ctrl+Z → 撤销（编辑器内 CM6 已绑，编辑器外走 active undo）
        e.preventDefault();
        actions.undoActive();
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        // Ctrl+Y / Ctrl+Shift+Z → 重做
        e.preventDefault();
        actions.redoActive();
      } else if (k === "e" && e.shiftKey) {
        e.preventDefault();
        const p = appStore.get().activePanelPath;
        if (p) openEditPanel(p);
      } else if (k === "e") {
        e.preventDefault();
        const p = appStore.get().activePanelPath;
        if (p) openCardPanel(p);
      } else if (k === "=" || k === "+") {
        e.preventDefault();
        bumpFont(1);
      } else if (k === "-") {
        e.preventDefault();
        bumpFont(-1);
      } else if (k === "0") {
        e.preventDefault();
        updateUi({ fontSize: 17 });
      } else {
        // 屏蔽浏览器默认快捷键（打印/保存/查看源码/历史/下载/书签/地址栏），
        // 放行编辑类（Ctrl+C/V/X/Z/Y/A/B/I）与标签操作（Ctrl+W/Tab/G 查找下一个）。
        const BROWSER_KEYS = new Set(["p", "u", "h", "j", "d", "k", "l", "n", "t", "r"]);
        if (BROWSER_KEYS.has(k)) e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!app.booted) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg text-text-3">
        <img src="/freemarkdown-icon.svg" width={64} height={64} alt="FreeMarkdown" />
        <span className="animate-pulse text-[15px] font-medium">FreeMarkdown</span>
      </div>
    );
  }

  // 全屏设置页：独占窗口，不显示工具栏与阅读区
  if (app.settingsOpen) {
    return (
      <div className="flex h-full flex-col">
        <SettingsPage />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ToolBar />
      <div className="relative flex min-h-0 flex-1">
        <Sidebar />
        <TocPanel />
        <main className="min-w-0 flex-1">
          {/* key = 网格代数：网格损坏时 +1，换一个全新的 dockview 实例 */}
          <DockHost key={app.gridEpoch} layout={layout} />
        </main>
      </div>
      <SearchPanel />
    </div>
  );
}

/**
 * 切换编辑形态。若当前活动文档还没有编辑面板，顺手开一个：
 * 让「分栏/源码/预览」在阅读态下也是直接可用的入口。
 */
function setEditMode(mode: EditMode) {
  updateUi({ editMode: mode });
  const p = appStore.get().activePanelPath;
  if (p && !dockRef.api?.getPanel(`edit:${p}`)) openEditPanel(p);
}

function updateUi(patch: Parameters<typeof appStore.set>[0]) {
  appStore.set(patch);
  sessionMarkDirty();
}

function bumpFont(delta: number) {
  const cur = appStore.get().fontSize;
  const next = Math.min(24, Math.max(14, cur + delta));
  updateUi({ fontSize: next });
}

/* ---------------- 顶部工具栏 ---------------- */

function ToolBar() {
  const app = useApp();
  const dragRef = useRef<HTMLDivElement>(null);
  void dragRef;
  // 状态芯片跟随「当前活动面板」：只有它确实是编辑面板时才显示
  const editStatus = app.activePanelPath
    ? app.editStatus[app.activePanelPath]
    : undefined;

  return (
    <header
      className="flex h-11 flex-none items-center gap-1 border-b border-border-app bg-bg px-2.5"
      data-tauri-drag-region
      onDoubleClick={(e) => {
        // 双击空白区切换最大化；点在按钮上不动
        if ((e.target as HTMLElement).closest("button, a, input, select, [role='button']"))
          return;
        void getCurrentWindow().toggleMaximize();
      }}
    >
      <button
        className={`icon-btn ${app.sidebarVisible ? "active" : ""}`}
        onClick={() => updateUi({ sidebarVisible: !app.sidebarVisible })}
        title="侧边栏"
        data-panel-toggle
      >
        <IconPanelLeft />
      </button>
      <button
        className={`icon-btn ${app.tocVisible ? "active" : ""}`}
        onClick={() => updateUi({ tocVisible: !app.tocVisible })}
        title="目录"
        data-panel-toggle
      >
        <IconList />
      </button>

      <div className="mx-1 h-5 w-px bg-border-app" />

      <button
        className="icon-btn text-[12px]"
        onClick={() => actions.pickFolder()}
        title="打开文件夹 (Ctrl+Shift+O)"
      >
        <IconFolder /> 文件夹
      </button>
      <button
        className="icon-btn text-[12px]"
        onClick={() => actions.pickFile()}
        title="打开文件 (Ctrl+O)"
      >
        <IconFile /> 文件
      </button>

      <div className="mx-1 h-5 w-px bg-border-app" />

      <button
        className={`icon-btn ${app.searchOpen ? "active" : ""}`}
        onClick={() => updateUi({ searchOpen: !app.searchOpen })}
        title="全文搜索 (Ctrl+Shift+F)"
        data-panel-toggle="search"
      >
        <IconSearch />
      </button>
      <button
        className="icon-btn"
        onClick={() => {
          const p = appStore.get().activePanelPath;
          if (p) openEditPanel(p);
        }}
        title="编辑（源码 + 分栏预览） (Ctrl+Shift+E)"
      >
        <IconEdit />
      </button>
      <button
        className="icon-btn"
        onClick={() => {
          const p = appStore.get().activePanelPath;
          if (p) openCardPanel(p);
        }}
        title="卡片导出 (Ctrl+E)"
      >
        <IconCard />
      </button>

      {/* 编辑形态：仅源码 / 分栏 / 仅预览（全局，作用于编辑面板） */}
      <div className="tb-seg" role="group" aria-label="编辑形态">
        {(
          [
            ["editor", "源码"],
            ["split", "分栏"],
            ["preview", "预览"],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            className={`tb-seg-btn ${app.editMode === m ? "active" : ""}`}
            data-edit-mode={m}
            onClick={() => setEditMode(m)}
            title={`编辑面板：${label}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mx-1 h-5 w-px bg-border-app" />

      <button className="icon-btn" onClick={() => bumpFont(-1)} title="减小字号 (Ctrl+-)">
        <span className="px-0.5 text-[13px]">A-</span>
      </button>
      <button
        className="icon-btn text-[11px]"
        onClick={() => updateUi({ fontSize: 17 })}
        title="恢复默认字号 (Ctrl+0)"
        disabled={app.fontSize === 17}
      >
        {app.fontSize}
      </button>
      <button className="icon-btn" onClick={() => bumpFont(1)} title="增大字号 (Ctrl+=)">
        <span className="px-0.5 text-[13px]">A+</span>
      </button>
      <button
        className="icon-btn"
        onClick={() => updateUi({ theme: app.theme === "dark" ? "light" : "dark" })}
        title="切换主题"
      >
        {app.theme === "dark" ? <IconSun /> : <IconMoon />}
      </button>

      <div className="ml-auto flex items-center gap-1">
        {editStatus && (
          <span className="mr-1 flex items-center gap-1.5">
            <button
              className="icon-btn"
              onClick={() => actions.undoActive()}
              title="撤销 (Ctrl+Z)"
            >
              <IconUndo />
            </button>
            <button
              className="icon-btn"
              onClick={() => actions.redoActive()}
              title="重做 (Ctrl+Y)"
            >
              <IconRedo />
            </button>
            <button
              className="icon-btn"
              onClick={() => actions.saveActive()}
              title="保存 (Ctrl+S)"
              disabled={!editStatus.dirty && !editStatus.saving}
            >
              <IconSave />
            </button>
            <span
              className={`tb-status ${editStatus.dirty ? "is-dirty" : ""}`}
              data-save-state={
                editStatus.saving ? "saving" : editStatus.dirty ? "dirty" : "clean"
              }
            >
              {editStatus.saving
                ? "保存中…"
                : editStatus.dirty
                  ? "未保存"
                  : editStatus.savedAt
                    ? `已保存 ${new Date(editStatus.savedAt).toLocaleTimeString()}`
                    : "已同步"}
            </span>
            <span className="tb-badge" data-eol>
              {editStatus.eol === "crlf" ? "CRLF" : "LF"}
            </span>
            {editStatus.bom && (
              <span className="tb-badge" data-bom>
                BOM
              </span>
            )}
            {editStatus.conflict != null && (
              <span className="tb-badge is-warn">冲突</span>
            )}
          </span>
        )}
        <button
          className={`icon-btn ${app.settingsOpen ? "active" : ""}`}
          onClick={() => updateUi({ settingsOpen: !app.settingsOpen })}
          title="设置"
        >
          <IconGear />
        </button>

        <div className="mx-1 h-5 w-px bg-border-app" />

        {/* 无边框窗口控制：最小化 / 最大化 / 关闭 */}
        <button
          className="icon-btn win-ctrl"
          onClick={() => void getCurrentWindow().minimize()}
          title="最小化"
        >
          <IconMin />
        </button>
        <button
          className="icon-btn win-ctrl"
          onClick={() => void getCurrentWindow().toggleMaximize()}
          title="最大化 / 还原"
        >
          <IconMax />
        </button>
        <button
          className="icon-btn win-ctrl win-close"
          onClick={() => void getCurrentWindow().close()}
          title="关闭"
        >
          <IconClose />
        </button>
      </div>
    </header>
  );
}

/* 内联图标（stroke 风格，跟随 currentColor） */
function IconFolder() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 7V5a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" strokeLinejoin="round" />
    </svg>
  );
}
function IconFile() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 3h9l4 4v14H6z" strokeLinejoin="round" />
      <path d="M14 3v5h5" strokeLinejoin="round" />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" strokeLinecap="round" />
    </svg>
  );
}
function IconCard() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M3 17l5-4.5 4 3.5 3.5-3L21 17" strokeLinejoin="round" />
    </svg>
  );
}
function IconEdit() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 20h4L20 8l-4-4L4 16v4z" strokeLinejoin="round" />
      <path d="M14 6l4 4" strokeLinejoin="round" />
    </svg>
  );
}
function IconPanelLeft() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9.5 4v16" />
    </svg>
  );
}
function IconList() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M8 6h13M8 12h13M8 18h13" strokeLinecap="round" />
      <circle cx="3.5" cy="6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="12" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="18" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}
function IconSun() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" strokeLinecap="round" />
    </svg>
  );
}
function IconMoon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 109.8 9.8z" strokeLinejoin="round" />
    </svg>
  );
}
function IconGear() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1.04 1.56V21a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1.04-1.56 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-1.56-1.04H3a2 2 0 110-4h.09A1.7 1.7 0 004.6 8.9a1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.87.34h.09A1.7 1.7 0 009.1 3.09V3a2 2 0 114 0v.09c0 .68.4 1.3 1.04 1.56.6.25 1.3.1 1.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.87v.09c.25.6.88 1.04 1.56 1.04H21a2 2 0 110 4h-.09c-.68 0-1.3.4-1.51 1.04z" strokeLinejoin="round" />
    </svg>
  );
}
function IconMin() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M5 12h14" strokeLinecap="round" />
    </svg>
  );
}
function IconMax() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}
function IconSave() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" strokeLinejoin="round" />
      <path d="M17 21v-8H7v8" strokeLinejoin="round" />
      <path d="M7 3v5h8" strokeLinejoin="round" />
    </svg>
  );
}
function IconUndo() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 7v6h6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconRedo() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M21 7v6h-6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ---------- 无边框窗口边缘拉伸热区 ---------- */
type ResizeDir =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

function WindowResizeZones() {
  const zone = (dir: ResizeDir, style: CSSProperties) => (
    <div
      key={dir}
      style={{
        position: "fixed",
        zIndex: 9998,
        // 命中区域（仅左键按下触发 resize，避免拦截右键/拖拽事件）
        cursor: dir.toLowerCase().includes("east")
          ? dir.toLowerCase().includes("west")
            ? "nwse-resize"
            : "nesw-resize"
          : dir.toLowerCase().includes("west")
            ? "nesw-resize"
            : dir === "North" || dir === "South"
              ? "ns-resize"
              : "ew-resize",
        ...style,
      }}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        void getCurrentWindow().startResizeDragging(dir);
      }}
    />
  );
  const T = 6; // 边缘热区厚度
  const C = 12; // 角落热区边长
  return (
    <>
      {zone("North", { top: 0, left: C, right: C, height: T })}
      {zone("South", { bottom: 0, left: C, right: C, height: T })}
      {zone("West", { left: 0, top: C, bottom: C, width: T })}
      {zone("East", { right: 0, top: C, bottom: C, width: T })}
      {zone("NorthWest", { top: 0, left: 0, width: C, height: C })}
      {zone("NorthEast", { top: 0, right: 0, width: C, height: C })}
      {zone("SouthWest", { bottom: 0, left: 0, width: C, height: C })}
      {zone("SouthEast", { bottom: 0, right: 0, width: C, height: C })}
    </>
  );
}
