import { api } from "./ipc";
import { appStore, scrollMap } from "./store";
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
  rootFolder: string | null;
  recentFiles: string[];
  recentFolders: string[];
  sidebarVisible: boolean;
  tocVisible: boolean;
  searchRoot: string | null;
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
  rootFolder: null,
  recentFiles: [],
  recentFolders: [],
  sidebarVisible: true,
  tocVisible: true,
  searchRoot: null,
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
    rootFolder: s.rootFolder,
    recentFiles: s.recentFiles,
    recentFolders: s.recentFolders,
    sidebarVisible: s.sidebarVisible,
    tocVisible: s.tocVisible,
    searchRoot: s.searchRoot,
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
    await api.saveSession(JSON.stringify(sessionPayload(layout, win)));
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
