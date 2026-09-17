import React, { useEffect, useRef } from "react";
import { appStore, jumpRegistry, useApp } from "../lib/store";
import { floatBaseStyle, useFloatPanel, useScrim } from "./usePanelAnim";

/** 面板全宽 */
const PANEL_W = 240;

/**
 * TOC 目录侧栏：点击跳转 + 滚动联动高亮；显隐直接切换，无动画。
 */
export function TocPanel() {
  const app = useApp();
  const listRef = useRef<HTMLDivElement>(null);
  const path = app.activePanelPath;
  const toc = path ? app.tocMap[path] : undefined;
  const activeId = path ? app.activeHeading[path] : null;

  useEffect(() => {
    if (!activeId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-toc-id="${CSS.escape(activeId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const { mounted, shown, nodeRef } = useFloatPanel(app.tocVisible);
  useScrim(app.tocVisible, () => {
    appStore.set({ tocVisible: false });
    void import("../lib/session").then(({ sessionMarkDirty }) => sessionMarkDirty());
  });
  if (!mounted) return null;

  return (
    <aside
      ref={nodeRef as React.Ref<HTMLElement>}
      className="flex h-full w-60 flex-col overflow-hidden border-r border-border-app bg-bg"
      style={floatBaseStyle("left", !shown)}
    >
      <div className="flex items-center px-3 pt-3 pb-1 text-[11px] font-medium tracking-wide text-text-3 uppercase">
        目录
        <button
          className="icon-btn ml-auto h-6 min-w-6 text-text-3"
          title="关闭目录"
          data-panel-toggle
          onClick={() => {
            appStore.set({ tocVisible: false });
            void import("../lib/session").then(({ sessionMarkDirty }) =>
              sessionMarkDirty(),
            );
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!toc || toc.length === 0 ? (
          <div className="px-2 py-2 text-[12px] text-text-3">当前文档没有标题</div>
        ) : (
          toc.map((t, i) => (
            <div
              key={`${t.id}-${i}`}
              data-toc-id={t.id}
              className={`cursor-default truncate rounded-md py-[3px] pr-1 text-[12.5px] leading-5 hover:bg-bg-hover hover:text-text-1 ${
                activeId === t.id ? "bg-accent-soft font-medium text-accent" : "text-text-2"
              }`}
              style={{ paddingLeft: 8 + (t.level - 1) * 12 }}
              title={t.text}
              onClick={() => jumpRegistry.get(path!)?.({ anchor: t.id })}
            >
              {t.text}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
