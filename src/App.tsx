import { useEffect, useRef, useState } from "react";
import type { SerializedDockview } from "dockview";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { api } from "./lib/ipc";
import {
  actions,
  appStore,
  dockRef,
  openCardPanel,
  openFile,
  setRootFolder,
  scrollMap,
  useApp,
} from "./lib/store";
import { loadSession, saveSessionNow, sessionMarkDirty } from "./lib/session";
import { DockHost } from "./components/DockHost";
import { Sidebar } from "./components/Sidebar";
import { TocPanel } from "./components/TocPanel";
import { SearchPanel } from "./components/SearchPanel";
import { SettingsPage } from "./components/SettingsPage";
import { ContextMenu } from "./components/ContextMenu";
import { restoreCardSettings } from "./card/cardStore";
import { useFileOpenBridge } from "./lib/filedrop";

export default function App() {
  return (
    <>
      <AppShell />
      {/* 全局右键菜单：挂在根部，启动页/设置页分支外也生效 */}
      <ContextMenu />
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
        recentFiles: session.recentFiles,
        recentFolders: session.recentFolders,
        sidebarVisible: session.sidebarVisible,
        tocVisible: session.tocVisible,
        rootFolder: session.rootFolder,
        searchRoot: session.searchRoot ?? null,
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

  /* ---------- 快捷键 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      const k = e.key.toLowerCase();
      if (k === "o" && e.shiftKey) {
        e.preventDefault();
        actions.pickFolder();
      } else if (k === "o") {
        e.preventDefault();
        actions.pickFile();
      } else if (k === "f" && e.shiftKey) {
        e.preventDefault();
        appStore.set({ searchOpen: !appStore.get().searchOpen });
      } else if (k === "e") {
        e.preventDefault();
        // 对活动文档打开卡片导出面板
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

  return (
    <header className="flex h-11 flex-none items-center gap-1 border-b border-border-app bg-bg px-2.5">
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
          if (p) openCardPanel(p);
        }}
        title="卡片导出 (Ctrl+E)"
      >
        <IconCard />
      </button>

      <div className="mx-1 h-5 w-px bg-border-app" />

      <button className="icon-btn" onClick={() => bumpFont(-1)} title="减小字号 (Ctrl+-)">
        <span className="px-0.5 text-[13px]">A-</span>
      </button>
      <span className="w-7 text-center text-[11px] text-text-3">{app.fontSize}</span>
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
        <button
          className={`icon-btn ${app.settingsOpen ? "active" : ""}`}
          onClick={() => updateUi({ settingsOpen: !app.settingsOpen })}
          title="设置"
        >
          <IconGear />
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
