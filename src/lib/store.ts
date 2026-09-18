import { useSyncExternalStore } from "react";
import type { DockviewApi } from "dockview";
import type { TocItem } from "./ipc";
import { basename } from "./ipc";
import { addRecentFile, sessionMarkDirty } from "./session";

type Listener = () => void;

export class Store<T extends object> {
  private listeners = new Set<Listener>();
  constructor(public state: T) {}
  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  get = () => this.state;
  set = (patch: Partial<T>) => {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  };
}

export type Theme = "light" | "dark";

/** 编辑面板形态：仅源码 / 源码+预览 / 仅预览（顶部工具条切换，全局生效） */
export type EditMode = "editor" | "split" | "preview";

/** 编辑面板对外汇报的状态（顶部工具条显示保存状态与换行/BOM） */
export interface EditStatus {
  dirty: boolean;
  saving: boolean;
  conflict: number | null;
  eol: string;
  bom: boolean;
  savedAt: number | null;
}

export interface DocInfo {
  size: number;
  parseMs: number;
  fromCache: boolean;
}

export interface AppState {
  booted: boolean;
  theme: Theme;
  fontSize: number;
  rootFolder: string | null;
  recentFiles: string[];
  recentFolders: string[];
  activePanelPath: string | null;
  tocMap: Record<string, TocItem[]>;
  activeHeading: Record<string, string | null>;
  docInfo: Record<string, DocInfo>;
  searchOpen: boolean;
  searchQuery: string;
  sidebarVisible: boolean;
  tocVisible: boolean;
  settingsOpen: boolean;
  coldStartMs: number | null;
  /** 搜索范围目录；null 表示跟随当前阅读文档所在目录 */
  searchRoot: string | null;
  /** 编辑面板形态（全局） */
  editMode: EditMode;
  /** 编辑面板状态登记表（按路径；顶部工具条读它） */
  editStatus: Record<string, EditStatus>;
  /** 网格重建代数：+1 会重挂 DockHost，拿到全新 dockview 实例 */
  gridEpoch: number;
}

export const appStore = new Store<AppState>({
  booted: false,
  theme: "light",
  fontSize: 17,
  rootFolder: null,
  recentFiles: [],
  recentFolders: [],
  activePanelPath: null,
  tocMap: {},
  activeHeading: {},
  docInfo: {},
  searchOpen: false,
  searchQuery: "",
  sidebarVisible: true,
  tocVisible: true,
  settingsOpen: false,
  coldStartMs: null,
  searchRoot: null,
  editMode: "split",
  editStatus: {},
  gridEpoch: 0,
});

export function useApp(): AppState {
  return useSyncExternalStore(appStore.subscribe, appStore.get);
}

/* ---------- 非响应式的运行时登记表 ---------- */

/** 每个文档路径的滚动位置（窗格冻结/关闭也保留） */
export const scrollMap = new Map<string, number>();

/** 跳转选项：TOC 锚点 / 搜索文本 / 搜索命中源码行 */
export interface JumpOpts {
  anchor?: string;
  revealText?: string;
  line?: number;
}

/** path -> 跳转执行器（TOC 点击 / 搜索跳转 / 正文内链接） */
export const jumpRegistry = new Map<string, (opts?: JumpOpts) => void>();

/** dockview api 句柄 */
export const dockRef: { api: DockviewApi | null } = { api: null };

/** 由 App 注入的全局动作（打开文件/文件夹对话框） */
export const actions: {
  pickFile: () => void;
  pickFolder: () => Promise<string | null>;
} = {
  pickFile: () => {},
  pickFolder: () => Promise.resolve(null),
};

// 仅开发环境：暴露打开入口，供自动化验收驱动真实渲染管线
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__fm = {
    openFile,
    openEditPanel,
    openCardPanel,
    setRootFolder,
    appStore,
    scrollMap,
    get dock() {
      return dockRef.api;
    },
  };
}

/** 待消费的跳转请求：openFile 时若面板尚未挂载好，先暂存 */
const pendingJumps = new Map<string, JumpOpts | undefined>();

export function setToc(path: string, toc: TocItem[]) {
  appStore.set({ tocMap: { ...appStore.get().tocMap, [path]: toc } });
}

export function setActiveHeading(path: string, id: string | null) {
  const cur = appStore.get().activeHeading;
  if (cur[path] !== id) {
    appStore.set({ activeHeading: { ...cur, [path]: id } });
  }
}

export function setEditStatus(path: string, status: EditStatus | null) {
  const cur = appStore.get().editStatus;
  if (status == null) {
    if (!(path in cur)) return;
    const next = { ...cur };
    delete next[path];
    appStore.set({ editStatus: next });
    return;
  }
  appStore.set({ editStatus: { ...cur, [path]: status } });
}

export function setDocInfo(path: string, info: DocInfo) {
  appStore.set({ docInfo: { ...appStore.get().docInfo, [path]: info } });
}

/* ---------- 网格健康检查与重建 ---------- */

/**
 * 网格是否已损坏：某些布局操作会让 dockview 把分组视图从 DOM 上摘下来
 * （.dv-view-container 里没有子节点）。此后 dockview 内部靠 DOM 反推网格位置
 * （getGridLocation 走 parentElement 链）会抛 `Invalid grid element`，
 * 表现是：moveTo 抛错并把面板摘出分组再也放不回去（文档凭空消失）、
 * addPanel 静默失效（点什么都打不开）。
 * 这种状态下唯一的出路是丢掉实例、重挂一个新的。
 */
export function gridBroken(api: DockviewApi): boolean {
  return api.groups.some((g) => {
    const el = (g as unknown as { element?: HTMLElement }).element;
    return !!el && !el.isConnected;
  });
}

/**
 * 尝试就地修复损坏的网格：把脱离 DOM 的分组视图放回视图容器
 * （`.dv-view-container`）。dockview 之后靠 DOM 反推位置，回填后即可继续工作。
 * 实测：回填后 addPanel / moveTo 均恢复正常，无需重建实例（重建反而会在
 * dispose 阶段因为元素已不在父节点上而抛错，把 React 子树整个带崩）。
 * @returns 修复后网格是否健康
 */
export function repairGrid(api: DockviewApi): boolean {
  if (!gridBroken(api)) return true;
  const detached = api.groups.filter((g) => {
    const el = (g as unknown as { element?: HTMLElement }).element;
    return !!el && !el.isConnected;
  });
  const containers = Array.from(
    document.querySelectorAll(".doc-host .dv-view-container"),
  ) as HTMLElement[];
  if (containers.length === 0) return false;
  for (const g of detached) {
    const el = (g as unknown as { element: HTMLElement }).element;
    const target = containers.find((c) => c.children.length === 0) ?? containers[0];
    target.appendChild(el);
  }
  return !gridBroken(api);
}

/** 当前已打开的文档路径（重建网格时按此恢复现场） */
export function openDocPaths(api: DockviewApi): string[] {
  return api.panels
    .filter((p) => p.id.startsWith("doc:"))
    .map((p) => p.id.slice(4));
}

/** 同上，按面板前缀取路径（card: / edit:） */
export function panelPaths(api: DockviewApi, prefix: "card:" | "edit:"): string[] {
  return api.panels
    .filter((p) => p.id.startsWith(prefix))
    .map((p) => p.id.slice(prefix.length));
}

/** 重建请求：重挂 DockHost 后用这些路径恢复文档 */
export const rebuildState: {
  paths: string[];
  cardPaths: string[];
  editPaths: string[];
  focus: string | null;
} = { paths: [], cardPaths: [], editPaths: [], focus: null };

export function rebuildGrid(
  paths: string[],
  focus?: string,
  cardPaths: string[] = [],
  editPaths: string[] = [],
) {
  rebuildState.paths = paths;
  rebuildState.cardPaths = cardPaths;
  rebuildState.editPaths = editPaths;
  rebuildState.focus = focus ?? null;
  appStore.set({ gridEpoch: appStore.get().gridEpoch + 1 });
}

/* ---------- 打开文件 / 文件夹 ---------- */

export interface OpenTarget {
  /** 在指定分组内打开（默认：活动分组） */
  groupId?: string;
  /** 分屏方向（落点在分组边缘时传入；缺省 center 不传） */
  direction?: "left" | "right" | "above" | "below";
}

/**
 * 统一路径写法：Windows 盘符路径把正斜杠转成反斜杠。
 * 否则同一个文件会因为 `J:/a/b.md` 与 `J:\a\b.md` 被当成两个文档，
 * 出现重复标签（面板 id 直接由路径拼出）。
 */
export function normalizePath(p: string): string {
  return /^[A-Za-z]:[\\/]/.test(p) ? p.replace(/\//g, "\\") : p;
}

export function openFile(rawPath: string, opts?: JumpOpts, target?: OpenTarget) {
  const api = dockRef.api;
  if (!api) return;
  const path = normalizePath(rawPath);
  // 网格损坏：任何布局操作都可能把面板吞掉。先尝试就地修复，
  // 修不好才退到重建实例（重建后按登记表恢复现场）。
  if (gridBroken(api)) {
    if (repairGrid(api)) {
      console.warn("[grid] 分组视图脱离 DOM，已自动回填修复");
    } else {
      pendingJumps.set(path, opts);
      rebuildGrid(
        Array.from(new Set([...openDocPaths(api), path])),
        path,
        panelPaths(api, "card:"),
        panelPaths(api, "edit:"),
      );
      return;
    }
  }
  const panelId = `doc:${path}`;
  const existing = api.getPanel(panelId);
  if (existing) {
    existing.api.setActive();
  } else {
    // 目标分组（外部文件拖放指定落点）；找不到则回退默认行为。
    // 注意：referencePanel 必须是已存在面板，activePanel 可能在布局恢复
    // 中间态短暂失效，校验存在性后再用，否则 addPanel 直接抛错。
    const refGroup = target?.groupId ? api.groups.find((g) => g.id === target.groupId) : undefined;
    const refPanel = refGroup?.activePanel ?? api.activePanel;
    const refExists = refPanel ? !!api.getPanel(refPanel.id) : false;
    const dir = target?.direction;
    api.addPanel({
      id: panelId,
      component: "doc",
      title: basename(path),
      params: { path },
      ...(refExists && refPanel
        ? {
            position: {
              referencePanel: refPanel.id,
              ...(dir ? { direction: dir } : { direction: "within" as const }),
            },
          }
        : dir && refGroup
          ? { position: { referenceGroup: refGroup, direction: dir } }
          : {}),
    });
    // 校验：dockview 内部状态异常时 addPanel 会静默失效（不抛错也不加面板），
    // 这时只能用重建兜底，否则就是"点什么都打不开"。
    if (!api.getPanel(panelId)) {
      pendingJumps.set(path, opts);
      rebuildGrid(
        Array.from(new Set([...openDocPaths(api), path])),
        path,
        panelPaths(api, "card:"),
        panelPaths(api, "edit:"),
      );
      return;
    }
  }
  const active = appStore.get().activePanelPath;
  if (active === path) {
    jumpRegistry.get(path)?.(opts);
  } else {
    pendingJumps.set(path, opts);
  }
  addRecentFile(path);
}

/** 打开卡片导出面板（同一路径复用已有面板，落在当前分组） */
export function openCardPanel(rawPath: string) {
  const api = dockRef.api;
  if (!api) return;
  const path = normalizePath(rawPath);
  // 同 openFile：网格损坏先就地修复，修不好才重建（重建后卡片面板一并恢复）
  if (gridBroken(api)) {
    if (!repairGrid(api)) {
      rebuildGrid(
        Array.from(new Set([...openDocPaths(api), path])),
        path,
        [path],
        panelPaths(api, "edit:"),
      );
      return;
    }
  }
  const panelId = `card:${path}`;
  const existing = api.getPanel(panelId);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const refPanel = api.activePanel;
  const refExists = refPanel ? !!api.getPanel(refPanel.id) : false;
  api.addPanel({
    id: panelId,
    component: "card",
    title: `卡片 · ${basename(path)}`,
    params: { path },
    ...(refExists && refPanel
      ? { position: { referencePanel: refPanel.id, direction: "within" as const } }
      : {}),
  });
}

/** 打开编辑面板（同一路径复用已有面板；分栏预览由面板内部负责） */
export function openEditPanel(rawPath: string) {
  const api = dockRef.api;
  if (!api) return;
  const path = normalizePath(rawPath);
  if (gridBroken(api)) {
    if (!repairGrid(api)) {
      rebuildGrid(
        Array.from(new Set([...openDocPaths(api), path])),
        path,
        panelPaths(api, "card:"),
        [path],
      );
      return;
    }
  }
  const panelId = `edit:${path}`;
  const existing = api.getPanel(panelId);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const refPanel = api.activePanel;
  const refExists = refPanel ? !!api.getPanel(refPanel.id) : false;
  api.addPanel({
    id: panelId,
    component: "edit",
    title: `编辑 · ${basename(path)}`,
    params: { path },
    ...(refExists && refPanel
      ? { position: { referencePanel: refPanel.id, direction: "within" as const } }
      : {}),
  });
  if (!api.getPanel(panelId)) {
    rebuildGrid(
      Array.from(new Set([...openDocPaths(api), path])),
      path,
      panelPaths(api, "card:"),
      [path],
    );
    return;
  }
  // 点「编辑」就是要看到编辑器：让新面板成为分组内的活动标签
  // （addPanel 只加标签不激活，落在非活动标签上的编辑面板会一直处于冻结态）
  api.getPanel(panelId)?.api.setActive();
}

export function consumePendingJump(path: string) {
  const opts = pendingJumps.get(path);
  pendingJumps.delete(path);
  return opts;
}

/* ---------- 保存广播：编辑面板落盘后通知同路径的阅读面板刷新 ---------- */

const docSavedListeners = new Set<(path: string, mtimeMs: number) => void>();

export function onDocSaved(cb: (path: string, mtimeMs: number) => void): () => void {
  docSavedListeners.add(cb);
  return () => {
    docSavedListeners.delete(cb);
  };
}

export function emitDocSaved(path: string, mtimeMs: number) {
  for (const cb of [...docSavedListeners]) {
    try {
      cb(path, mtimeMs);
    } catch (e) {
      console.warn("[doc-saved] 监听器异常:", e);
    }
  }
}

export function setRootFolder(path: string | null) {
  appStore.set({ rootFolder: path });
  sessionMarkDirty();
  if (path) {
    const folders = [
      path,
      ...appStore.get().recentFolders.filter((f) => f !== path),
    ].slice(0, 10);
    appStore.set({ recentFolders: folders });
  }
}
