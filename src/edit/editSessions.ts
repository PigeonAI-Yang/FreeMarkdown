import type { PreviewMetrics } from "./previewController";

/**
 * 编辑面板的冻结快照与调试句柄。
 *
 * 冻结（面板不可见 / 网格重建）时 CM6 实例会被销毁、DOM 全不挂，只把
 * `EditorState.toJSON()`（文本 + 光标 + 选区 + 撤销历史）与滚动位置留在这里；
 * 重新可见时用它无等待还原。会话持久化不写这些内容（内容永远以磁盘为准）。
 */

export interface EditSessionSnapshot {
  /** EditorState.toJSON()：文本 + 选区 + 光标 + 撤销历史 */
  stateJSON: unknown;
  /** 编辑器滚动位置（px） */
  editorScroll: number;
  /** 编辑器视口顶部行号：像素值在大文档里会被高度图夹掉，按行还原才是可靠坐标 */
  editorTopLine: number;
  /** 预览滚动位置（px） */
  previewScroll: number;
  /** 快照时是否有未保存改动 */
  dirty: boolean;
  /** 快照基于的磁盘 mtime（恢复后保存仍用它比对，冲突检测不失效） */
  mtimeMs: number;
  eol: string;
  bom: boolean;
  size: number;
}

const sessions = new Map<string, EditSessionSnapshot>();
const MAX_SESSIONS = 4;

/** 当前真正活着（挂载中）的编辑面板路径：卸载不立刻丢快照，
 *  给「网格重建 → 同刻重挂」留出认领窗口，避免未保存缓冲被误丢。 */
const livePaths = new Set<string>();

export function claimEditPath(path: string) {
  livePaths.add(path);
}

/** 面板卸载：稍后确认无人认领，再丢快照（关闭面板不残留在内存里） */
export function scheduleReleaseEditPath(path: string, delayMs = 200) {
  window.setTimeout(() => {
    if (!livePaths.has(path)) dropEditSession(path);
  }, delayMs);
}

export function releaseEditPathNow(path: string) {
  livePaths.delete(path);
}

export function putEditSession(path: string, snap: EditSessionSnapshot) {
  sessions.delete(path);
  sessions.set(path, snap);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

export function takeEditSession(path: string): EditSessionSnapshot | null {
  const s = sessions.get(path);
  if (!s) return null;
  sessions.delete(path);
  sessions.set(path, s);
  return s;
}

export function dropEditSession(path: string) {
  sessions.delete(path);
}

/* ---------- 验收探针句柄（仅开发环境） ---------- */

export interface EditProbeHandle {
  path: string;
  /** 当前缓冲文本 */
  text: () => string;
  /** 保存状态与指标快照 */
  snapshot: () => {
    dirty: boolean;
    saving: boolean;
    conflict: number | null;
    eol: string;
    bom: boolean;
    mtimeMs: number;
    size: number;
    textLen: number;
    blocks: number;
    mounted: number;
    metrics: PreviewMetrics;
    stateJSON: unknown | null;
  };
  /** 光标与编辑器视口位置 */
  cursor: () => { line: number; col: number; scrollTop: number; focused: boolean };
  /** 双向联动的测量口：编辑器顶部行 / 预览顶部块，及其在块列表中的下标 */
  syncProbe: () => {
    editorTopLine: number;
    editorBottomLine: number;
    previewTopLine: number | null;
    editorTopBlock: number;
    previewTopBlock: number;
    blockCount: number;
    editorScrollTop: number;
    previewScrollTop: number;
    editorScrollHeight: number;
    editorClientHeight: number;
    previewScrollHeight: number;
    previewClientHeight: number;
  };
  /** 块列表（行范围）快照，供联动误差计算 */
  blockLines: () => { start: number; end: number }[];
  /** 几何测量（行 → 块坐标 / 滚动状态），用于核对联动换算 */
  measure: (line: number) => {
    line: number;
    blockTop: number;
    blockBottom: number;
    documentTop: number;
    scrollTop: number;
    scrollRectTop: number;
    clientHeight: number;
    scrollHeight: number;
    topLine: number;
  } | null;
  /** 把光标/视口移到指定源码行（验收脚本造场景用） */
  gotoLine: (line: number) => void;
  /** 在指定源码行行尾插入文本（验收脚本用：改"中间那块"而不改变块数） */
  insertAtLine: (line: number, text: string) => void;
  /** 立即保存（force=用给定 mtime 覆盖） */
  save: (forceMtime?: number) => Promise<void>;
  /** 立即同步预览 */
  sync: () => Promise<void>;
  /** 整段替换文档（模拟外部改动 / 重新载入） */
  replaceAll: (text: string) => void;
  /** 在文首插入文本（模拟真实键入） */
  insertAtStart: (text: string) => void;
  /** 冲突面板可见性与按钮 */
  conflictUi: () => { visible: boolean; buttons: string[] };
  /** 点击冲突面板上的按钮 */
  clickConflict: (label: string) => void;
  /** 重新载入（丢弃本地改动） */
  reload: () => Promise<void>;
}

const probes = new Map<string, EditProbeHandle>();

export function registerEditProbe(path: string, handle: EditProbeHandle) {
  probes.set(path, handle);
  const w = window as unknown as Record<string, unknown>;
  w.__fmEdit = {
    get: (p?: string) => (p ? probes.get(p) : [...probes.values()][0]),
    paths: () => [...probes.keys()],
    /** 冻结快照快照（DEV 诊断用：确认视口坐标有没有在卸载前被清成 0） */
    snapshots: () =>
      Object.fromEntries(
        [...sessions].map(([k, s]) => [
          k,
          {
            editorScroll: s.editorScroll,
            editorTopLine: s.editorTopLine,
            previewScroll: s.previewScroll,
            dirty: s.dirty,
            len: (s.stateJSON as { doc?: string } | null)?.doc?.length ?? 0,
          },
        ]),
      ),
  };
}

export function unregisterEditProbe(path: string) {
  probes.delete(path);
}
