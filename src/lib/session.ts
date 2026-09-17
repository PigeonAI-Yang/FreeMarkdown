import { api } from "./ipc";
import { appStore, scrollMap } from "./store";

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
};

export async function loadSession(): Promise<SessionData> {
  try {
    const raw = await api.loadSession();
    if (!raw) return { ...DEFAULTS };
    const data = JSON.parse(raw) as SessionData;
    if (data?.version !== 1) return { ...DEFAULTS };
    return { ...DEFAULTS, ...data };
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
    return {
      width: Math.round(physical.width / dpr),
      height: Math.round(physical.height / dpr),
      maximized,
    };
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
