import React, { useCallback, useEffect, useState } from "react";
import { api, basename, dirname, type FileEntry } from "../lib/ipc";
import { actions, appStore, openFile, setRootFolder, useApp } from "../lib/store";
import { floatBaseStyle, useFloatPanel, useScrim } from "./usePanelAnim";
import { sessionMarkDirty } from "../lib/session";

/** 侧边栏全宽 */
const SIDEBAR_W = 240;

/** 侧边栏：文件目录树（懒加载）+ 最近打开；浮层滑入滑出，不挤占中栏 */
export function Sidebar() {
  const app = useApp();
  const { mounted, shown, nodeRef } = useFloatPanel(app.sidebarVisible);
  useScrim(app.sidebarVisible, () => {
    appStore.set({ sidebarVisible: false });
    sessionMarkDirty();
  });
  if (!mounted) return null;
  return (
    <aside
      ref={nodeRef as React.Ref<HTMLElement>}
      className="flex h-full w-60 flex-col overflow-hidden border-r border-border-app bg-bg"
      style={floatBaseStyle("left", !shown)}
    >
      <DirHeader />
      {app.rootFolder ? (
        <FileTree />
      ) : (
        <div className="px-4 py-3 text-[12px] leading-relaxed text-text-3">
          尚未打开文件夹。
          <div className="mt-2 flex flex-col items-start gap-1.5">
            <button className="text-accent" onClick={() => void actions.pickFolder()}>
              选择文件夹…
            </button>
            {app.recentFolders.length > 0 && (
              <span className="text-text-3">或从下方“最近目录”中选择</span>
            )}
          </div>
        </div>
      )}
      <RecentDirs />
      <Recents />
    </aside>
  );
}

/* ---------------- 目录头部：当前目录展示 + 切换下拉 ---------------- */

function DirHeader() {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const boxRef = React.useRef<HTMLDivElement>(null);

  // 点外部关闭下拉
  useEffect(() => {
    if (!open) return;
    const handler = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", handler);
    return () => window.removeEventListener("pointerdown", handler);
  }, [open ]);

  const closeDir = () => {
    setOpen(false);
    setRootFolder(null);
  };

  return (
    <div ref={boxRef} className="relative px-3 pt-3 pb-1">
      <div className="text-[11px] font-medium tracking-wide text-text-3 uppercase">
        文件目录
      </div>
      <button
        className="mt-0.5 flex w-full items-center gap-1 rounded-md px-1 py-1 text-left text-[12px] text-text-2 hover:bg-bg-hover hover:text-text-1"
        title={app.rootFolder ?? "尚未打开文件夹，点击选择"}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="min-w-0 flex-1 truncate">
          {app.rootFolder ? basename(app.rootFolder) : "尚未打开文件夹"}
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-none opacity-60">
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute top-full right-2 left-2 z-50 mt-1 overflow-hidden rounded-lg border border-border-app bg-bg-elev" style={{ boxShadow: "var(--shadow)" }}>
          {app.rootFolder && (
            <button
              className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-[12px] text-text-2 hover:bg-bg-hover"
              title="复制完整路径"
              onClick={() => {
                void navigator.clipboard?.writeText(app.rootFolder!);
                setOpen(false);
              }}
            >
              <span className="min-w-0 flex-1 truncate" title={app.rootFolder}>
                {app.rootFolder}
              </span>
              <span className="flex-none text-text-3">复制</span>
            </button>
          )}
          {app.recentFolders.length > 0 && (
            <div className="border-t border-border-app py-1">
              <div className="px-2.5 pt-1 pb-0.5 text-[11px] text-text-3">最近目录</div>
              {app.recentFolders.slice(0, 6).map((f) => (
                <button
                  key={f}
                  className={`flex w-full items-center px-2.5 py-1.5 text-left text-[12px] hover:bg-bg-hover ${
                    f === app.rootFolder ? "font-medium text-accent" : "text-text-2"
                  }`}
                  title={f}
                  onClick={() => {
                    setOpen(false);
                    if (f !== app.rootFolder) setRootFolder(f);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{basename(f) || f}</span>
                </button>
              ))}
            </div>
          )}
          <div className="border-t border-border-app py-1">
            {app.rootFolder && (
              <button
                className="block w-full px-2.5 py-1.5 text-left text-[12px] text-text-2 hover:bg-bg-hover"
                onClick={closeDir}
              >
                关闭目录，只看已打开文件
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- 最近目录 ---------------- */

function RecentDirs() {
  const app = useApp();
  const dirs = app.recentFolders.filter((f) => f !== app.rootFolder).slice(0, 5);
  if (dirs.length === 0) return null;
  return (
    <div className="border-t border-border-app px-1.5 py-2">
      <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-text-3 uppercase">
        最近目录
      </div>
      {dirs.map((f) => (
        <div
          key={f}
          className="cursor-default truncate rounded-md px-2 py-[3px] text-[12px] text-text-2 hover:bg-bg-hover hover:text-text-1"
          title={f}
          onClick={() => setRootFolder(f)}
        >
          {basename(f) || f}
        </div>
      ))}
    </div>
  );
}

/* ---------------- 文件树 ---------------- */

function FileTree() {
  const app = useApp();
  const root = app.rootFolder!;
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set([root]));
  const [cache, setCache] = useState<Map<string, FileEntry[]>>(new Map());

  const load = useCallback(
    async (dir: string) => {
      const list = await api.listDir(dir);
      setCache((m) => {
        const next = new Map(m);
        next.set(dir, list);
        return next;
      });
      return list;
    },
    [],
  );

  useEffect(() => {
    setChildren(null);
    setCache(new Map());
    setExpanded(new Set([root]));
    void load(root).then(setChildren);
  }, [root, load]);

  const toggle = async (dir: string) => {
    const next = new Set(expanded);
    if (next.has(dir)) next.delete(dir);
    else {
      next.add(dir);
      if (!cache.has(dir)) await load(dir);
    }
    setExpanded(next);
  };

  if (!children) {
    return <div className="px-4 py-3 text-[12px] text-text-3">读取中…</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 text-[13px] select-none">
      {children.map((e) => (
        <TreeRow key={e.path} entry={e} depth={0} expanded={expanded} cache={cache} toggle={toggle} load={load} />
      ))}
    </div>
  );
}

interface TreeRowProps {
  entry: FileEntry;
  depth: number;
  expanded: Set<string>;
  cache: Map<string, FileEntry[]>;
  toggle: (dir: string) => void;
  load: (dir: string) => Promise<FileEntry[]>;
}

function TreeRow({ entry, depth, expanded, cache, toggle, load }: TreeRowProps) {
  const isOpen = expanded.has(entry.path);
  const kids = entry.isDir && isOpen ? cache.get(entry.path) : undefined;
  return (
    <div>
      <div
        className="flex cursor-default items-center gap-1 rounded-md px-1.5 py-[3px] hover:bg-bg-hover"
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => (entry.isDir ? void toggle(entry.path) : openFile(entry.path))}
        title={entry.path}
        data-ctx="tree"
        data-path={entry.path}
        data-is-dir={entry.isDir ? "true" : "false"}
      >
        {entry.isDir ? (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            className={`flex-none text-text-3 transition-transform ${isOpen ? "rotate-90" : ""}`}
          >
            <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="flex-none text-text-3">
            <path d="M7 3h7l4 4v14H7z" strokeLinejoin="round" />
            <path d="M14 3v4h4" strokeLinejoin="round" />
          </svg>
        )}
        <span className="truncate">{entry.name}</span>
      </div>
      {entry.isDir && isOpen && (
        <div>
          {kids ? (
            kids.map((k) => (
              <TreeRow key={k.path} entry={k} depth={depth + 1} expanded={expanded} cache={cache} toggle={toggle} load={load} />
            ))
          ) : (
            <div className="py-1 text-[12px] text-text-3" style={{ paddingLeft: 20 + depth * 14 }}>
              加载中…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- 最近打开 ---------------- */

function Recents() {
  const app = useApp();
  const files = app.recentFiles.slice(0, 8);
  if (files.length === 0) return null;
  return (
    <div className="border-t border-border-app px-1.5 py-2">
      <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-text-3 uppercase">
        最近打开
      </div>
      {files.map((p) => (
        <div
          key={p}
          className="cursor-default truncate rounded-md px-2 py-[3px] text-[12px] text-text-2 hover:bg-bg-hover hover:text-text-1"
          title={p}
          onClick={() => openFile(p)}
          data-ctx="recent"
          data-path={p}
          data-is-dir="false"
        >
          {basename(p)}
          <span className="ml-1 text-text-3 opacity-70">{shortDir(dirname(p))}</span>
        </div>
      ))}
    </div>
  );
}

function shortDir(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : dir;
}
