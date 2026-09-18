import { useEffect, useMemo, useRef, useState } from "react";
import {
  DockviewReact,
  themeDark,
  themeLight,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  type IWatermarkPanelProps,
  type SerializedDockview,
} from "dockview";
import type { DockviewApi } from "dockview";
import { basename } from "../lib/ipc";
import {
  dockRef,
  appStore,
  useApp,
  actions,
  openFile,
  openCardPanel,
  openEditPanel,
  rebuildState,
} from "../lib/store";
import { sessionMarkDirty } from "../lib/session";
import { MarkdownPane } from "./MarkdownPane";
import { CardPanel } from "../card/CardPanel";
import { EditPane } from "../edit/EditPane";
import { getChrome } from "../lib/webview2";
import { usePointerTabDrag } from "./useTabDrag";

type DocParams = { path: string };

/* 自定义标签页：完全复刻内置 default tab 的 DOM 结构与类名
   （dv-default-tab 系列），dockview 主题作用于 .dv-tab 外壳的规则
   （活动态颜色、下划线、关闭按钮显隐）原样生效，视觉与内置一致；
   根节点带 data-ctx="tab" 供全局右键菜单识别。 */
function CtxTab(props: IDockviewPanelHeaderProps) {
  const path = (props.params as DocParams | undefined)?.path;
  const [title, setTitle] = useState(props.api.title);
  const midDown = useRef(false);

  useEffect(() => {
    const d = props.api.onDidTitleChange((t) => setTitle(t.title));
    return () => d.dispose();
  }, [props.api]);

  return (
    <div
      className="dv-default-tab"
      data-ctx="tab"
      data-path={path}
      onPointerDown={(e) => {
        midDown.current = e.button === 1;
      }}
      onPointerUp={(e) => {
        // 与内置 tab 一致：中键点击关闭
        if (midDown.current && e.button === 1) {
          midDown.current = false;
          props.api.close();
        }
      }}
      onPointerLeave={() => {
        midDown.current = false;
      }}
    >
      <span className="dv-default-tab-content">{title ?? ""}</span>
      <div
        className="dv-default-tab-action"
        onPointerDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.preventDefault();
          props.api.close();
        }}
      >
        <svg
          height="11"
          width="11"
          viewBox="0 0 28 28"
          aria-hidden="false"
          focusable={false}
          className="dv-svg"
        >
          <path d="M2.1 27.3L0 25.2L11.55 13.65L0 2.1L2.1 0L13.65 11.55L25.2 0L27.3 2.1L15.75 13.65L27.3 25.2L25.2 27.3L13.65 15.75L2.1 27.3Z" />
        </svg>
      </div>
    </div>
  );
}

function Watermark(_props: IWatermarkPanelProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-text-3">
      <img src="/freemarkdown-icon.svg" width={56} height={56} alt="FreeMarkdown" />
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

/**
 * 清掉残留的空分组。dockview 某些移动路径会留下 0 面板的分组：它依旧渲染成
 * 一层 dv-groupview（与相邻分组重叠、盖在上面挡住点击），而且会让
 * 「DOM 序号 → 分组对象」的对应关系错位。空分组本身没有任何内容可丢，
 * 直接移除是安全的。
 */
function sweepEmptyGroups(api: DockviewApi) {
  const gridGroups = api.groups.filter((g) => g.api.location.type === "grid");
  const empties = gridGroups.filter((g) => g.panels.length === 0);
  if (empties.length === 0 || empties.length === gridGroups.length) return;
  for (const g of empties) {
    try {
      api.removeGroup(g);
    } catch {
      /* 忽略：下一次布局变化还会再扫 */
    }
  }
}

let sweepTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleEmptyGroupSweep(api: DockviewApi) {
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    sweepEmptyGroups(api);
  }, 400);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleLayoutSave(api: DockviewApi) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // 空布局不保存：避免拖拽中间态/面板全关瞬间覆盖掉有效布局
    if (api.groups.length === 0 || api.panels.length === 0) return;
    void import("../lib/session").then(({ saveSessionNow }) =>
      saveSessionNow(api.toJSON() as SerializedDockview),
    );
  }, 500);
}

export function DockHost({ layout }: { layout: SerializedDockview | null }) {
  const app = useApp();
  const components = useMemo(
    () => ({ doc: MarkdownPane, card: CardPanel, edit: EditPane }),
    [],
  );
  const watermark = useMemo(() => Watermark, []);
  const tab = useMemo(() => CtxTab, []);
  const apiRef = useRef<DockviewApi | null>(null);
  const [, force] = useState(0);
  usePointerTabDrag(apiRef.current);

  // 卸载（含网格重建导致的换实例）时清掉句柄，避免后续操作打到已死的实例上。
  // 注意：effect 被重跑（HMR/Fast Refresh）时清理先于下一轮执行，所以这里在
  // 执行体内把句柄重新指向当前实例，否则会出现「实例还活着、句柄却是 null」。
  useEffect(() => {
    if (apiRef.current) dockRef.api = apiRef.current;
    return () => {
      if (dockRef.api === apiRef.current) dockRef.api = null;
    };
  }, []);

  const onReady = (event: DockviewReadyEvent) => {
    const api = event.api;
    dockRef.api = api;
    apiRef.current = api;
    force((n) => n + 1);

    // 外部文件拖拽（无 PanelTransfer 数据）时接受 overlay 显示，
    // 使文件也能像标签一样分屏/移动；内部标签拖拽走 dockview 原生逻辑。
    api.onUnhandledDragOverEvent((e) => {
      try {
        const types = e.nativeEvent.dataTransfer?.types;
        if (types && Array.from(types).includes("Files")) e.accept();
      } catch {
        /* 忽略 */
      }
    });

    // 网格重建优先于启动布局：重建时按登记表恢复文档，
    // 不再套用启动时那份旧布局（那会把现场覆盖掉）。
    if (
      rebuildState.paths.length > 0 ||
      rebuildState.cardPaths.length > 0 ||
      rebuildState.editPaths.length > 0
    ) {
      const { paths, cardPaths, editPaths, focus } = rebuildState;
      rebuildState.paths = [];
      rebuildState.cardPaths = [];
      rebuildState.editPaths = [];
      rebuildState.focus = null;
      for (const p of paths) openFile(p);
      for (const p of cardPaths) openCardPanel(p);
      for (const p of editPaths) openEditPanel(p);
      if (focus) {
        const panel =
          api.getPanel(`doc:${focus}`) ??
          api.getPanel(`edit:${focus}`) ??
          api.getPanel(`card:${focus}`);
        panel?.api.setActive();
      }
    } else if (layout && layout.panels && Object.keys(layout.panels).length > 0) {
      try {
        api.fromJSON(layout);
      } catch {
        // 布局损坏则从空白开始
      }
    }
    // 恢复后同步一次活动面板，并清掉可能残留的空分组
    syncActivePanel(api);
    sweepEmptyGroups(api);

    api.onDidActivePanelChange(() => syncActivePanel(api));
    api.onDidLayoutChange(() => {
      sessionMarkDirty();
      scheduleLayoutSave(api);
      scheduleEmptyGroupSweep(api);
    });
    // 文件拖放松手：dockview onDidDrop（外部 DnD 落到分组/边缘时触发）。
    // e.group/e.position 给出落点；边缘 → 在该方向新建分组打开（分屏），
    // 中央/标签 → 在落点分组内打开。
    api.onDidDrop((e) => {
      const dt = e.nativeEvent.dataTransfer;
      const files = dt ? Array.from(dt.files || []) : [];
      if (files.length === 0) return; // 内部标签拖拽不会走到这里
      const mdFiles = files.filter((f) => /\.(md|markdown)$/i.test(f.name));
      if (mdFiles.length === 0) {
        console.warn("[drop] 不支持的文件类型:", files.map((f) => f.name));
        return;
      }
      // WebView2 DOM File 无 path：经 webview 桥接到 Rust 读取真实路径后打开
      const dropTarget = {
        groupId: e.group?.id,
        zone: e.position, // 'center' | 'left' | 'right' | 'top' | 'bottom'
      };
      try {
        getChrome()!.webview.postMessageWithAdditionalObjects(
          {
            type: "__FM_FILE_OPEN__",
            target: dropTarget,
            files: mdFiles.map((f) => ({ name: f.name, type: f.type })),
          },
          mdFiles,
        );
      } catch (err) {
        console.warn("[drop] 桥接失败:", err);
      }
    });
  };

  return (
    <div className="doc-host h-full w-full">
      <DockviewReact
        theme={app.theme === "dark" ? themeDark : themeLight}
        components={components}
        watermarkComponent={watermark}
        defaultTabComponent={tab}
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
