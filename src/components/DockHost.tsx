import { useMemo } from "react";
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type IWatermarkPanelProps,
  type SerializedDockview,
} from "dockview";
import type { DockviewApi } from "dockview";
import { basename } from "../lib/ipc";
import { dockRef, appStore, useApp, actions } from "../lib/store";
import { sessionMarkDirty } from "../lib/session";
import { MarkdownPane } from "./MarkdownPane";

type DocParams = { path: string };

function Watermark(_props: IWatermarkPanelProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-text-3">
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M6 3h9l4 4v14H6z" strokeLinejoin="round" />
        <path d="M14 3v5h5" strokeLinejoin="round" />
        <path d="M9 12h7M9 16h7" strokeLinecap="round" />
      </svg>
      <div className="text-[13px]">
        按 <kbd className="rounded border border-border-app px-1">Ctrl+O</kbd> 打开 Markdown 文件，
        或 <kbd className="rounded border border-border-app px-1">Ctrl+Shift+O</kbd> 打开文件夹
      </div>
      <button
        className="icon-btn mt-1 border border-border-app text-[12px]"
        onClick={() => actions.pickFile()}
      >
        选择文件…
      </button>
    </div>
  );
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleLayoutSave(api: DockviewApi) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void import("../lib/session").then(({ saveSessionNow }) =>
      saveSessionNow(api.toJSON() as SerializedDockview),
    );
  }, 500);
}

export function DockHost({ layout }: { layout: SerializedDockview | null }) {
  const app = useApp();
  const themeClass =
    app.theme === "dark" ? "dockview-theme-dark" : "dockview-theme-light";

  const components = useMemo(() => ({ doc: MarkdownPane }), []);
  const watermark = useMemo(() => Watermark, []);

  const onReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    dockRef.api = api;

    if (layout && layout.panels && Object.keys(layout.panels).length > 0) {
      try {
        api.fromJSON(layout);
      } catch {
        // 布局损坏则从空白开始
      }
    }
    // 恢复后同步一次活动面板
    syncActivePanel(api);

    api.onDidActivePanelChange(() => syncActivePanel(api));
    api.onDidLayoutChange(() => {
      sessionMarkDirty();
      scheduleLayoutSave(api);
    });
  };

  return (
    <div className="doc-host h-full w-full">
      <DockviewReact
        className={themeClass}
        components={components}
        watermarkComponent={watermark}
        onReady={onReady}
      />
    </div>
  );
}

function syncActivePanel(api: DockviewApi) {
  const panel = api.activePanel;
  const path = (panel?.params as DocParams | undefined)?.path ?? null;
  const prev = appStore.get().activePanelPath;
  if (prev !== path) appStore.set({ activePanelPath: path });
  if (path) {
    const title = `${basename(path)} — FreeMarkdown`;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      getCurrentWindow().setTitle(title),
    );
  } else {
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      getCurrentWindow().setTitle("FreeMarkdown"),
    );
  }
}
