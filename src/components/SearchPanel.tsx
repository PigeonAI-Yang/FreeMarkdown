import { useEffect, useRef, useState } from "react";
import { api, basename, dirname, type SearchOutcome } from "../lib/ipc";
import { actions, appStore, openFile, useApp } from "../lib/store";

/** 全文搜索浮窗：居中弹出，不占布局。Rust rayon 并行扫描当前文件夹。 */
export function SearchPanel() {
  const app = useApp();
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const runId = useRef(0);

  // 挂载态与显示态分离：关闭时先播收起动画（shown=false），播完再卸载
  const [mounted, setMounted] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (app.searchOpen) {
      setMounted(true);
      inputRef.current?.focus();
      const id = requestAnimationFrame(() =>
        requestAnimationFrame(() => setShown(true)),
      );
      return () => cancelAnimationFrame(id);
    }
    // 收起：先播动画，播完卸载
    setShown(false);
    closeTimer.current = setTimeout(() => {
      setMounted(false);
      closeTimer.current = null;
    }, 150);
    return () => {
      if (closeTimer.current) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
    };
  }, [app.searchOpen]);

  // 有效搜索范围：手动指定的 searchRoot > 当前阅读文档所在目录 > 侧边栏根目录
  const activeDir = app.activePanelPath ? dirname(app.activePanelPath) : null;
  const searchRoot = app.searchRoot ?? activeDir ?? app.rootFolder;
  const isFollowDoc = !app.searchRoot && !!activeDir;

  useEffect(() => {
    const root = searchRoot;
    const q = app.searchQuery.trim();
    if (!root || q.length < 1) {
      setOutcome(null);
      return;
    }
    setBusy(true);
    const id = ++runId.current;
    const timer = setTimeout(() => {
      api
        .searchFolder(root, q)
        .then((res) => {
          if (id === runId.current) setOutcome(res);
        })
        .catch(() => {})
        .finally(() => {
          if (id === runId.current) setBusy(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [app.searchQuery, searchRoot]);

  // Esc 关闭
  useEffect(() => {
    if (!app.searchOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") appStore.set({ searchOpen: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [app.searchOpen]);

  // 点外部关闭：监听器 ref 化，延迟两帧注册避开本次打开点击，常驻到关闭
  const onOutsideRef = useRef((e: PointerEvent) => {
    const t = e.target as HTMLElement;
    if (!t.closest("[data-search-float]") && !t.closest("[data-panel-toggle='search']")) {
      appStore.set({ searchOpen: false });
    }
  });
  useEffect(() => {
    if (!app.searchOpen) return;
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.addEventListener("pointerdown", onOutsideRef.current);
      }),
    );
    return () => {
      window.removeEventListener("pointerdown", onOutsideRef.current);
      cancelAnimationFrame(id);
    };
  }, [app.searchOpen]);

  if (!mounted) return null;

  const close = () => appStore.set({ searchOpen: false });

  const openHit = (path: string, snippet?: string, line?: number) => {
    close();
    openFile(path, snippet ? { revealText: snippet, line } : undefined);
  };

  return (
    <div
      data-search-float
      className="absolute top-14 left-1/2 z-40 flex max-h-[600px] w-[min(640px,90%)] flex-col overflow-hidden rounded-xl border border-border-app bg-bg-elev"
      style={{
        boxShadow: "var(--shadow)",
        opacity: shown ? 1 : 0,
        transform: `translateX(-50%) translateY(${shown ? "0" : "-8px"})`,
        transition: "opacity 150ms ease-out, transform 150ms ease-out",
      }}
    >
      <div className="flex items-center gap-2 border-b border-border-app px-3 py-2.5">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="flex-none text-text-3">
          <circle cx="11" cy="11" r="6" />
          <path d="M20 20l-4.5-4.5" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          className="h-7 flex-1 bg-transparent text-[14px] text-text-1 outline-none placeholder:text-text-3"
          placeholder={searchRoot ? "在当前文件夹中搜索…" : "先打开一个文档或文件夹"}
          value={app.searchQuery}
          onChange={(e) => appStore.set({ searchQuery: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && outcome?.hits.length) {
              const h = outcome.hits[0];
              openHit(h.path, h.snippet, h.line);
            }
          }}
        />
        {busy ? (
          <span className="text-[11px] text-text-3">搜索中…</span>
        ) : (
          outcome && (
            <span className="flex-none text-[11px] text-text-3">
              {outcome.hits.length} 条 · {outcome.elapsedMs} ms
            </span>
          )
        )}
      </div>
      {searchRoot && (
        <div className="flex items-center gap-1.5 border-b border-border-app px-3 py-1.5 text-[11px] text-text-3">
          <span className="flex-none">范围</span>
          <span className="min-w-0 flex-1 truncate" title={searchRoot}>
            {isFollowDoc ? `${basename(searchRoot)}（跟随当前文档）` : basename(searchRoot)}
          </span>
          {isFollowDoc ? (
            <button
              className="flex-none text-accent hover:underline"
              title="锁定为当前目录，不再跟随文档切换"
              onClick={() => {
                appStore.set({ searchRoot });
                void import("../lib/session").then(({ sessionMarkDirty }) => sessionMarkDirty());
              }}
            >
              锁定
            </button>
          ) : (
            <>
              <button
                className="flex-none text-accent hover:underline"
                title="改回跟随当前阅读文档所在目录"
                onClick={() => {
                  appStore.set({ searchRoot: null });
                  void import("../lib/session").then(({ sessionMarkDirty }) => sessionMarkDirty());
                }}
              >
                跟随文档
              </button>
              <button
                className="flex-none text-accent hover:underline"
                title="选择其他目录作为搜索范围"
                onClick={() =>
                  actions.pickFolder().then((picked) => {
                    if (picked) {
                      appStore.set({ searchRoot: picked });
                      void import("../lib/session").then(({ sessionMarkDirty }) => sessionMarkDirty());
                    }
                  })
                }
              >
                换目录
              </button>
            </>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {!outcome ? (
          <div className="px-2 py-3 text-[12px] text-text-3">
            {searchRoot ? "输入关键词开始搜索" : "先打开一个文档或文件夹"}
          </div>
        ) : (
          outcome.hits.map((h, i) => (
            <div key={`${h.path}-${h.line}-${i}`} className="mb-0.5">
              {(i === 0 || outcome.hits[i - 1].path !== h.path) && (
                <div
                  className="mt-1 cursor-default truncate px-2 py-1 text-[12px] font-medium text-text-2"
                  title={h.path}
                >
                  {basename(h.path)}
                  <span className="ml-1.5 font-normal text-text-3 opacity-70">{dirname(h.path)}</span>
                </div>
              )}
              <div
                className="cursor-default truncate rounded-md px-2 py-1.5 text-[12.5px] leading-5 text-text-2 hover:bg-bg-hover hover:text-text-1"
                title={`第 ${h.line} 行`}
                onClick={() => openHit(h.path, h.snippet, h.line)}
              >
                <span className="mr-1.5 text-text-3">{h.line}</span>
                {h.snippet}
              </div>
            </div>
          ))
        )}
      </div>
      {outcome?.truncated && (
        <div className="border-t border-border-app px-3 py-1.5 text-[11px] text-text-3">
          超过 1000 条已截断，可加长关键词缩小范围
        </div>
      )}
    </div>
  );
}
