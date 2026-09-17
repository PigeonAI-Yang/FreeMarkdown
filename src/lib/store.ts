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

export function setDocInfo(path: string, info: DocInfo) {
  appStore.set({ docInfo: { ...appStore.get().docInfo, [path]: info } });
}

/* ---------- 打开文件 / 文件夹 ---------- */

export function openFile(path: string, opts?: JumpOpts) {
  const api = dockRef.api;
  if (!api) return;
  const panelId = `doc:${path}`;
  const existing = api.getPanel(panelId);
  if (existing) {
    existing.api.setActive();
  } else {
    api.addPanel({
      id: panelId,
      component: "doc",
      title: basename(path),
      params: { path },
    });
  }
  const active = appStore.get().activePanelPath;
  if (active === path) {
    jumpRegistry.get(path)?.(opts);
  } else {
    pendingJumps.set(path, opts);
  }
  addRecentFile(path);
}

export function consumePendingJump(path: string) {
  const opts = pendingJumps.get(path);
  pendingJumps.delete(path);
  return opts;
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
