import { api } from "./ipc";
import { appStore, dockRef, scrollMap, type DocWidth, type EditMode } from "./store";
import {
  cardStore,
  DEFAULT_CARD_SETTINGS,
  setCardSaveHook,
} from "../card/cardStore";
import type { CardSettings } from "../card/templates/types";

// 卡片选项变更 → 会话防抖保存（cardStore 不反向 import session，避免循环依赖）
setCardSaveHook(sessionMarkDirty);

export interface WindowState {
  width: number;
  height: number;
  maximized: boolean;
}

export interface SessionData {
  version: 1;
  layout: unknown | null;
  scroll: Record<string, number>;
  theme: "light" | "dark";
  fontSize: number;
  /** 阅读栏宽档位（新增字段，缺省走 DEFAULTS，不改版本号） */
  docWidth: DocWidth;
  /** 代码块默认换行（新增字段，缺省走 DEFAULTS） */
  codeWrap: boolean;
  /** 阅读区底色（按主题存） */
  docBgLight: string;
  docBgDark: string;
  /** 浮层侧栏底色（按主题存） */
  floatBgLight: string;
  floatBgDark: string;
  /** 编辑器标记符号色（按主题存） */
  edMarkLight: string;
  edMarkDark: string;
  /** 编辑器标题色（按主题存） */
  edHeadingLight: string;
  edHeadingDark: string;
  /** 编辑器代码色（按主题存） */
  edCodeLight: string;
  edCodeDark: string;
  /** 编辑器字符串色（按主题存） */
  edStringLight: string;
  edStringDark: string;
  /** 编辑器搜索匹配色（按主题存） */
  edMatchLight: string;
  edMatchDark: string;
  /** 编辑器行号色（按主题存） */
  edGutterLight: string;
  edGutterDark: string;
  /** 编辑器字号（不分主题） */
  edFontSize: number;
  /** 编辑器行高（不分主题） */
  edLineHeight: number;
  /** 诊断模式（不持久化，重启后关） */
  diagnosticMode?: boolean;
  rootFolder: string | null;
  recentFiles: string[];
  recentFolders: string[];
  sidebarVisible: boolean;
  tocVisible: boolean;
  /** 侧边栏宽度（px） */
  sidebarWidth: number;
  /** TOC 侧栏宽度（px） */
  tocWidth: number;
  searchRoot: string | null;
  /** 编辑面板形态：源码 / 分栏 / 预览（全局，顶部工具条切换） */
  editMode: EditMode;
  window: WindowState | null;
  /** 卡片导出选项（新增字段，缺省合并默认值，不改版本号） */
  card: CardSettings;
}

const DEFAULTS: SessionData = {
  version: 1,
  layout: null,
  scroll: {},
  theme: window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light",
  fontSize: 17,
  docWidth: "medium",
  codeWrap: true,
  docBgLight: "#f7f1e6",
  docBgDark: "#232323",
  floatBgLight: "#ebe4d5",
  floatBgDark: "#1f1f1f",
  edMarkLight: "#a89e8a",
  edMarkDark: "#6e6e6e",
  edHeadingLight: "#4f5bd5",
  edHeadingDark: "#7ab7ff",
  edCodeLight: "#b25e09",
  edCodeDark: "#e5a06a",
  edStringLight: "#0a7f4f",
  edStringDark: "#7dd3a8",
  edMatchLight: "#ffd8a8",
  edMatchDark: "#4a4020",
  edGutterLight: "#a8a299",
  edGutterDark: "#5f5f5f",
  edFontSize: 13,
  edLineHeight: 1.7,
  rootFolder: null,
  recentFiles: [],
  recentFolders: [],
  sidebarVisible: true,
  tocVisible: true,
  sidebarWidth: 240,
  tocWidth: 240,
  searchRoot: null,
  editMode: "split",
  window: null,
  card: { ...DEFAULT_CARD_SETTINGS },
};

export async function loadSession(): Promise<SessionData> {
  try {
    const raw = await api.loadSession();
    if (!raw) return { ...DEFAULTS };
    const data = JSON.parse(raw) as SessionData;
    if (data?.version !== 1) return { ...DEFAULTS };
    return {
      ...DEFAULTS,
      ...data,
      // 嵌套字段与默认值逐层合并，兼容旧会话缺少 card 字段
      card: { ...DEFAULT_CARD_SETTINGS, ...(data.card ?? {}) },
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function sessionPayload(layout: unknown, window: WindowState | null): SessionData {
  const s = appStore.get();
  return {
    version: 1,
    layout: layout ?? null,
    scroll: Object.fromEntries(scrollMap),
    theme: s.theme,
    fontSize: s.fontSize,
    docWidth: s.docWidth,
    codeWrap: s.codeWrap,
    docBgLight: s.docBgLight,
    docBgDark: s.docBgDark,
    floatBgLight: s.floatBgLight,
    floatBgDark: s.floatBgDark,
    edMarkLight: s.edMarkLight,
    edMarkDark: s.edMarkDark,
    edHeadingLight: s.edHeadingLight,
    edHeadingDark: s.edHeadingDark,
    edCodeLight: s.edCodeLight,
    edCodeDark: s.edCodeDark,
    edStringLight: s.edStringLight,
    edStringDark: s.edStringDark,
    edMatchLight: s.edMatchLight,
    edMatchDark: s.edMatchDark,
    edGutterLight: s.edGutterLight,
    edGutterDark: s.edGutterDark,
    edFontSize: s.edFontSize,
    edLineHeight: s.edLineHeight,
    diagnosticMode: s.diagnosticMode,
    rootFolder: s.rootFolder,
    recentFiles: s.recentFiles,
    recentFolders: s.recentFolders,
    sidebarVisible: s.sidebarVisible,
    tocVisible: s.tocVisible,
    sidebarWidth: s.sidebarWidth,
    tocWidth: s.tocWidth,
    searchRoot: s.searchRoot,
    editMode: s.editMode,
    window,
    card: cardStore.get(),
  };
}

async function currentWindowState(): Promise<WindowState | null> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    const physical = await w.innerSize();
    const dpr = await w.scaleFactor();
    const maximized = await w.isMaximized();
    if (maximized) return { width: 1440, height: 900, maximized };
    const width = Math.round(physical.width / dpr);
    const height = Math.round(physical.height / dpr);
    // 最小化/未就绪时会读到 0 或极小尺寸，直接丢弃，不污染 session
    if (width <= 100 || height <= 100) return null;
    return { width, height, maximized };
  } catch {
    return null;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

export function sessionMarkDirty() {
  dirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveSessionNow();
  }, 600);
}

export function sessionConsumeDirty(): boolean {
  const d = dirty;
  dirty = false;
  return d;
}

export async function saveSessionNow(layout?: unknown) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    const win = await currentWindowState();
    // 未显式传入布局时取当前实时布局：防抖保存（主题/字号/卡片选项变更都会触发）
    // 此前会用 layout:null 覆盖会话，把打开的文档列表清空。
    const live = layout ?? dockRef.api?.toJSON() ?? null;
    await api.saveSession(JSON.stringify(sessionPayload(live, win)));
    dirty = false;
  } catch {
    // 保存失败不阻断退出
  }
}

export function addRecentFile(path: string) {
  const cur = appStore.get().recentFiles;
  if (cur[0] === path) return;
  appStore.set({
    recentFiles: [path, ...cur.filter((p) => p !== path)].slice(0, 20),
  });
  sessionMarkDirty();
}
