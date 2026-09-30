import { useEffect, useMemo, useRef, useState } from "react";
import { api, basename, dirname, type SearchHit, type SearchOutcome } from "../lib/ipc";
import { actions, appStore, openFile, useApp } from "../lib/store";

/** 全文搜索命令面板：贴顶浮层，键盘驱动（↑↓/Enter/Esc），结果按文件分组。 */
export function SearchPanel() {
  const app = useApp();
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const [selIdx, setSelIdx] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const runId = useRef(0);

  const [mounted, setMounted] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (app.searchOpen) {
      setMounted(true);
      setSelIdx(0);
      setFilterOpen(false);
      const id = requestAnimationFrame(() =>
        requestAnimationFrame(() => setShown(true)),
      );
      return () => cancelAnimationFrame(id);
    }
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
  // 自动解锁：锁定的 searchRoot 若不含当前文档，降级为跟随文档（换目录时不会卡住）
  const activeDir = app.activePanelPath ? dirname(app.activePanelPath) : null;
  const lockedRoot = app.searchRoot;
  const searchRoot = lockedRoot ?? activeDir ?? app.rootFolder;
  const isFollowDoc = !lockedRoot && !!activeDir;

  // 锁定目录不含当前文档时自动解锁（回到跟随文档）
  useEffect(() => {
    if (!lockedRoot || !activeDir) return;
    const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
    if (!norm(activeDir).startsWith(norm(lockedRoot))) {
      appStore.set({ searchRoot: null });
      void import("../lib/session").then(({ sessionMarkDirty }) => sessionMarkDirty());
    }
  }, [lockedRoot, activeDir]);

  useEffect(() => {
    const root = searchRoot;
    const q = app.searchQuery.trim();
    if (!root || q.length < 1) {
      setOutcome(null);
      setSelIdx(0);
      return;
    }
    console.log("[search] root=", root, "query=", q, "activePanelPath=", app.activePanelPath);
    setBusy(true);
    const id = ++runId.current;
    const timer = setTimeout(() => {
      api
        .searchFolder(root, q)
        .then((res) => {
          if (id === runId.current) {
            setOutcome(res);
            setSelIdx(0);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (id === runId.current) setBusy(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [app.searchQuery, searchRoot]);

  // 扁平化结果列表供键盘导航
  const flatHits = useMemo(() => outcome?.hits ?? [], [outcome]);

  // 选中项滚动到可视区
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-hit-idx="${selIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selIdx]);

  const close = () => appStore.set({ searchOpen: false });
  const openHit = (h: SearchHit) => {
    close();
    openFile(h.path, { revealText: h.snippet, line: h.line });
  };

  // Esc 关闭 / ↑↓ 导航 / Enter 打开
  useEffect(() => {
    if (!app.searchOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (flatHits.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelIdx((i) => Math.min(i + 1, flatHits.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        openHit(flatHits[selIdx]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [app.searchOpen, flatHits, selIdx]);

  // 点外部关闭
  const onOutsideRef = useRef((e: PointerEvent) => {
    const t = e.target as HTMLElement;
    if (!t.closest("[data-search-float]") && !t.closest("[data-panel-toggle='search']")) {
      close();
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

  const query = app.searchQuery.trim();

  return (
    <div
      data-search-float
      className="absolute top-2 left-1/2 z-40 flex max-h-[70vh] w-[min(760px,92%)] flex-col overflow-hidden rounded-xl border border-border-app bg-bg-elev"
      style={{
        boxShadow: "var(--shadow)",
        opacity: shown ? 1 : 0,
        transform: `translateX(-50%) translateY(${shown ? "0" : "-8px"})`,
        transition: "opacity 150ms ease-out, transform 150ms ease-out",
      }}
    >
      {/* 搜索输入行 */}
      <div className="flex items-center gap-2 border-b border-border-app px-3 py-2.5">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="flex-none text-text-3">
          <circle cx="11" cy="11" r="6" />
          <path d="M20 20l-4.5-4.5" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          autoFocus
          className="h-7 flex-1 bg-transparent text-[14px] text-text-1 outline-none placeholder:text-text-3"
          placeholder={searchRoot ? "在当前文件夹中搜索…" : "先打开一个文档或文件夹"}
          value={app.searchQuery}
          onChange={(e) => appStore.set({ searchQuery: e.target.value })}
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
        {/* 范围筛选器 */}
        {searchRoot && (
          <div className="relative">
            <button
              className="icon-btn h-6 w-6 text-text-3"
              title="搜索范围"
              onClick={() => setFilterOpen((v) => !v)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 5h18l-7 8v6l-4 2v-8L3 5z" strokeLinejoin="round" />
              </svg>
            </button>
            {filterOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 w-48 overflow-hidden rounded-lg border border-border-app bg-bg-elev py-1" style={{ boxShadow: "var(--shadow)" }}>
                <div className="px-3 py-1.5 text-[11px] text-text-3">搜索范围</div>
                <div className="truncate px-3 pb-1 text-[12px] text-text-2" title={searchRoot}>
                  {basename(searchRoot)}
                  {isFollowDoc && <span className="ml-1 text-text-3">（跟随文档）</span>}
                </div>
                <div className="border-t border-border-app" />
                {isFollowDoc ? (
                  <button
                    className="w-full px-3 py-1.5 text-left text-[12px] text-text-2 hover:bg-bg-hover"
                    onClick={() => {
                      appStore.set({ searchRoot });
                      void import("../lib/session").then(({ sessionMarkDirty }) => sessionMarkDirty());
                      setFilterOpen(false);
                    }}
                  >
                    锁定为当前目录
                  </button>
                ) : (
                  <>
                    <button
                      className="w-full px-3 py-1.5 text-left text-[12px] text-text-2 hover:bg-bg-hover"
                      onClick={() => {
                        appStore.set({ searchRoot: null });
                        void import("../lib/session").then(({ sessionMarkDirty }) => sessionMarkDirty());
                        setFilterOpen(false);
                      }}
                    >
                      跟随当前文档目录
                    </button>
                    <button
                      className="w-full px-3 py-1.5 text-left text-[12px] text-text-2 hover:bg-bg-hover"
                      onClick={() =>
                        actions.pickFolder().then((picked) => {
                          if (picked) {
                            appStore.set({ searchRoot: picked });
                            void import("../lib/session").then(({ sessionMarkDirty }) => sessionMarkDirty());
                          }
                          setFilterOpen(false);
                        })
                      }
                    >
                      选择其他目录…
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 诊断信息（设置里开） */}
      {app.diagnosticMode && (
        <div className="border-b border-border-app px-3 py-1 text-[10px] text-text-3">
          root={searchRoot ?? "null"} | active={app.activePanelPath ?? "null"} | hits={outcome?.hits.length ?? 0}
        </div>
      )}
      {/* 结果列表 */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
        {!outcome ? (
          <div className="px-4 py-6 text-center text-[12px] text-text-3">
            {searchRoot ? "输入关键词开始搜索" : "先打开一个文档或文件夹"}
          </div>
        ) : outcome.hits.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-text-3">无结果</div>
        ) : (
          <GroupedHits hits={outcome.hits} selIdx={selIdx} query={query} onOpen={openHit} onHover={setSelIdx} />
        )}
      </div>

      {/* 底部提示 */}
      {outcome && outcome.hits.length > 0 && (
        <div className="flex items-center gap-3 border-t border-border-app px-3 py-1.5 text-[11px] text-text-3">
          <span><kbd className="rounded border border-border-app bg-bg px-1 py-0.5">↑↓</kbd> 选择</span>
          <span><kbd className="rounded border border-border-app bg-bg px-1 py-0.5">Enter</kbd> 打开</span>
          <span><kbd className="rounded border border-border-app bg-bg px-1 py-0.5">Esc</kbd> 关闭</span>
          {outcome.truncated && <span className="ml-auto">超过 1000 条已截断</span>}
        </div>
      )}
    </div>
  );
}

/* ---------------- 结果分组渲染 ---------------- */

function GroupedHits({
  hits,
  selIdx,
  query,
  onOpen,
  onHover,
}: {
  hits: SearchHit[];
  selIdx: number;
  query: string;
  onOpen: (h: SearchHit) => void;
  onHover: (i: number) => void;
}) {
  // 按文件分组（保持 hits 顺序，同文件连续）
  const groups: { path: string; items: { hit: SearchHit; flatIdx: number }[] }[] = [];
  let cur: (typeof groups)[0] | null = null;
  hits.forEach((h, i) => {
    if (!cur || cur.path !== h.path) {
      cur = { path: h.path, items: [] };
      groups.push(cur);
    }
    cur.items.push({ hit: h, flatIdx: i });
  });

  return (
    <>
      {groups.map((g) => (
        <div key={g.path} className="mb-1">
          {/* 文件头：文件名 + 命中数 */}
          <div className="flex items-center gap-2 px-3 py-1">
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-2" title={g.path}>
              {basename(g.path)}
            </span>
            <span className="flex-none rounded-full bg-bg-active px-1.5 py-0.5 text-[10px] text-text-3">
              {g.items.length}
            </span>
          </div>
          {g.items.map(({ hit, flatIdx }) => (
            <button
              key={`${hit.path}-${hit.line}-${flatIdx}`}
              data-hit-idx={flatIdx}
              className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left ${
                flatIdx === selIdx ? "bg-accent-soft" : "hover:bg-bg-hover"
              }`}
              onMouseEnter={() => onHover(flatIdx)}
              onClick={() => onOpen(hit)}
            >
              {/* 第一行：snippet + 行号 */}
              <div className={`flex items-baseline gap-2 text-[12.5px] leading-5 ${
                flatIdx === selIdx ? "text-accent" : "text-text-2"
              }`}>
                <HighlightedSnippet text={cleanSnippet(hit.snippet)} query={query} />
                <span className={`flex-none font-mono text-[11px] ${flatIdx === selIdx ? "text-accent" : "text-text-3"}`}>
                  :{hit.line}
                </span>
              </div>
              {/* 第二行：路径（小字弱化） */}
              <div className={`truncate text-[11px] ${flatIdx === selIdx ? "text-accent opacity-70" : "text-text-3"}`}>
                {dirname(hit.path)}
              </div>
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

/** 剥掉 snippet 首尾的截断符（… / ...），显示更干净 */
function cleanSnippet(s: string): string {
  return s.replace(/^[…\s.]+/, "").replace(/[…\s.]+$/, "").trim();
}

/** snippet 中高亮关键词（大小写不敏感，多处命中都标） */
function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  if (!query) return <span className="min-w-0 flex-1 truncate">{text}</span>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: { str: string; hit: boolean }[] = [];
  let pos = 0;
  while (true) {
    const idx = lower.indexOf(q, pos);
    if (idx < 0) {
      parts.push({ str: text.slice(pos), hit: false });
      break;
    }
    if (idx > pos) parts.push({ str: text.slice(pos, idx), hit: false });
    parts.push({ str: text.slice(idx, idx + q.length), hit: true });
    pos = idx + q.length;
  }
  return (
    <span className="min-w-0 flex-1 truncate">
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="bg-transparent font-semibold text-accent">
            {p.str}
          </mark>
        ) : (
          <span key={i}>{p.str}</span>
        ),
      )}
    </span>
  );
}
