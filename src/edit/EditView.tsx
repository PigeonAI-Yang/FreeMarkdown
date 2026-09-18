import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import type { SourcePayload } from "../lib/ipc";
import { api, basename, dirname } from "../lib/ipc";
import {
  emitDocSaved,
  openEditPanel,
  setEditStatus,
  setToc,
  useApp,
  type EditMode,
} from "../lib/store";
import { enhanceChunk, enhanceMermaidOnly } from "../lib/enhance";
import { useFileWatch } from "../lib/watch";
import { BlockPreview } from "./BlockPreview";
import { newMetrics, PreviewController } from "./previewController";
import type { PreviewBlock } from "./previewModel";
import { createEditorState, editorExtensions } from "./cmSetup";
import {
  alignPreviewToLine,
  editorTopLine,
  enqueueSync,
  isLineCovered,
  lockSync,
  previewTopLine,
  restoreScrollTop,
  scrollEditorToLine,
  scrollPreviewToLine,
  type SyncLock,
} from "./scrollSync";
import {
  putEditSession,
  registerEditProbe,
  takeEditSession,
  unregisterEditProbe,
  type EditSessionSnapshot,
} from "./editSessions";

/** 空闲自动保存延迟（与方案 §4.7 的 ~1s 一致；Ctrl+S 不等） */
const AUTOSAVE_MS = 1000;
/** 停打字多久算「空闲」——之后恢复 mermaid 等重增强 */
const TYPING_IDLE_MS = 320;
/** 空闲后补跑 mermaid 的延迟 */
const MERMAID_IDLE_MS = 500;

interface Props {
  path: string;
  /** 面板是否活动（全局快捷键作用域判定） */
  isActive: () => boolean;
  /** 「另存为」成功后关闭本面板 */
  onRequestClose: () => void;
}

/**
 * 编辑面板内容：CM6 源码编辑器 + 分栏预览 + 保存链路。
 *
 * 预览始终走「Rust 解析 → HTML 字符串 → 按块注入」的既有管线；本组件只负责
 * 编辑缓冲、防抖同步、保存与冲突处理。冻结（面板不可见）时本组件被卸载，
 * 缓冲区与滚动位置留在 editSessions，重新可见时无等待恢复。
 */
export function EditView({ path, isActive, onRequestClose }: Props) {
  const [src, setSrc] = useState<SourcePayload | null>(null);
  const [blocks, setBlocks] = useState<PreviewBlock[]>([]);
  const [splice, setSplice] = useState<{ lo: number; hi: number } | null>(null);
  const mode: EditMode = useApp().editMode;
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const savedAtRef = useRef<number | null>(null);
  /** 自己发起写入的时间（用于过滤"自己保存"触发的监听事件） */
  const selfWriteAtRef = useRef(0);
  /** 读盘完成后 +1：驱动「挂编辑器」这个第二阶段 effect */
  const [initSeq, setInitSeq] = useState(0);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const controllerRef = useRef<PreviewController | null>(null);
  const srcRef = useRef<SourcePayload | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const conflictRef = useRef<number | null>(null);
  const typingRef = useRef(false);
  const mountedRef = useRef(true);
  const autosaveRef = useRef<number | null>(null);
  const typingTimerRef = useRef<number | null>(null);
  const mermaidTimerRef = useRef<number | null>(null);
  const blocksRef = useRef<PreviewBlock[]>([]);
  const buildExtRef = useRef<() => ReturnType<typeof editorExtensions>>(() => []);
  /** 联动互斥：谁在驱动对面，避免两侧 scroll 互相回灌 */
  const syncLockRef = useRef<SyncLock>({
    origin: null,
    at: 0,
    pending: null,
    timer: null,
  });
  /** 冻结恢复后的静默期：两侧滚动位置刚回填，先不要互相拉动 */
  const syncPausedUntilRef = useRef(0);
  /**
   * 预览 → 编辑器的反向联动只在用户真的动过预览后才启用：
   * 冻结恢复时预览的位置可能滞后于编辑器（快照里两侧不完全一致），
   * 放任它反向拉动会把编辑器视口拽回顶部（实测：滚动位置 47px 丢失）。
   */
  const previewSyncArmedRef = useRef(false);
  /**
   * 视口坐标的最后一次可信读数（px + 顶部行号）。
   * 冻结快照不能现场读 `scrollDOM.scrollTop`：dockview 先把面板隐藏成 display:none，
   * 滚动容器随即失去可滚动范围、位置被夹成 0，卸载清理读到的是 0 而不是真实位置
   * （实测 543457px → 快照里 0，切回后视口回落文档顶部）。
   * 所以在滚动回调里持续记录，且只记「容器可见且已连树」时的读数。
   */
  const viewportRef = useRef({ scroll: 0, topLine: 1 });
  const previewScrollRef = useRef(0);
  /** 预览的按行跳转句柄（窗口外目标块够不着时用） */
  const previewJumpRef = useRef<{ jumpToLine: (line: number) => boolean } | null>(null);
  const onSelectionRef = useRef<() => void>(() => {});
  const initRef = useRef<{
    base: SourcePayload;
    snap: EditSessionSnapshot | null;
  } | null>(null);

  /* ---------------- 保存 ---------------- */

  const save = useCallback(
    async (forceMtime?: number) => {
      const view = viewRef.current;
      const meta = srcRef.current;
      if (!view || !meta || savingRef.current) return;
      savingRef.current = true;
      selfWriteAtRef.current = performance.now();
      if (mountedRef.current) setSaving(true);
      const t0 = performance.now();
      try {
        const text = view.state.doc.toString();
        const r = await api.writeMarkdown(
          path,
          text,
          forceMtime ?? meta.mtimeMs,
          meta.eol,
          meta.bom,
        );
        const next: SourcePayload = { ...meta, mtimeMs: r.mtimeMs, size: r.bytes };
        srcRef.current = next;
        dirtyRef.current = false;
        conflictRef.current = null;
        if (mountedRef.current) {
          setSrc(next);
          setDirty(false);
          setConflict(null);
          setSaveError(null);
          const now = Date.now();
          savedAtRef.current = now;
          setSavedAt(now);
        }
        // 同路径的阅读面板按新 mtime 重读（LRU 自然失效）
        emitDocSaved(path, r.mtimeMs);
        const toc = controllerRef.current?.refreshToc();
        if (toc) setToc(path, toc);
        void api.perfLog(`edit-save:${path}`, Math.round(performance.now() - t0));
      } catch (e) {
        const msg = String(e);
        const m = /conflict:(\d+)/.exec(msg);
        if (m) {
          conflictRef.current = Number(m[1]);
          if (mountedRef.current) setConflict(Number(m[1]));
        } else {
          // 冲突待解时不自动重试
          if (mountedRef.current) setSaveError(msg.replace(/^Error:\s*/, ""));
        }
        void api.perfLog(`edit-save-fail:${path}`, Math.round(performance.now() - t0));
      } finally {
        savingRef.current = false;
        if (mountedRef.current) setSaving(false);
      }
    },
    [path],
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  /* ---------------- 预览增强（打字期降级） ---------------- */

  const injectBlock = useCallback((el: HTMLElement) => {
    void enhanceChunk(el, { skipMermaid: typingRef.current });
  }, []);

  const scheduleMermaid = useCallback(() => {
    if (mermaidTimerRef.current) clearTimeout(mermaidTimerRef.current);
    mermaidTimerRef.current = window.setTimeout(() => {
      mermaidTimerRef.current = null;
      const content = scrollerRef.current?.querySelector<HTMLElement>(".doc-content");
      if (content) void enhanceMermaidOnly(content);
    }, MERMAID_IDLE_MS);
  }, []);

  const markDirty = useCallback(() => {
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      if (mountedRef.current) setDirty(true);
    }
    // 空闲自动保存：冲突未解时不覆盖磁盘
    if (autosaveRef.current) clearTimeout(autosaveRef.current);
    autosaveRef.current = window.setTimeout(() => {
      autosaveRef.current = null;
      if (conflictRef.current == null) void saveRef.current();
    }, AUTOSAVE_MS);
    // 打字期不跑 mermaid（重），停下来再补
    typingRef.current = true;
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = window.setTimeout(() => {
      typingTimerRef.current = null;
      typingRef.current = false;
      scheduleMermaid();
    }, TYPING_IDLE_MS);
  }, [scheduleMermaid]);
  const markDirtyRef = useRef(markDirty);
  markDirtyRef.current = markDirty;

  /* ---------------- 重新载入 / 另存为 ---------------- */

  const reloadFromDisk = useCallback(async () => {
    const view = viewRef.current;
    try {
      const payload = await api.readSource(path);
      srcRef.current = payload;
      if (mountedRef.current) setSrc(payload);
      if (view) {
        // 重建 state：同时丢掉与旧文本绑定的撤销历史
        const st = createEditorState(payload.text, buildExtRef.current());
        view.setState(st);
      }
      dirtyRef.current = false;
      conflictRef.current = null;
      if (mountedRef.current) {
        setDirty(false);
        setConflict(null);
        setSaveError(null);
      }
      const c = controllerRef.current;
      if (c) {
        await c.syncNow();
        const toc = c.refreshToc();
        setToc(path, toc);
      }
      emitDocSaved(path, payload.mtimeMs);
    } catch (e) {
      if (mountedRef.current) setSaveError(`重新载入失败：${String(e)}`);
    }
  }, [path]);
  const reloadRef = useRef(reloadFromDisk);
  reloadRef.current = reloadFromDisk;

  const saveAs = useCallback(async () => {
    const view = viewRef.current;
    const meta = srcRef.current;
    if (!view || !meta) return;
    const target = await api.pickMdSavePath(basename(path));
    if (!target) return;
    try {
      const text = view.state.doc.toString();
      const r = await api.writeMarkdown(target, text, null, meta.eol, meta.bom);
      emitDocSaved(target, r.mtimeMs);
      openEditPanel(target);
      onRequestClose();
    } catch (e) {
      if (mountedRef.current) setSaveError(`另存为失败：${String(e)}`);
    }
  }, [path, onRequestClose]);
  const saveAsRef = useRef(saveAs);
  saveAsRef.current = saveAs;

  /* ---------------- 编辑器与预览的装配 ---------------- */

  const buildExt = useCallback(
    () =>
      editorExtensions({
        onChange: () => {
          markDirtyRef.current();
          controllerRef.current?.ingest();
        },
        onSave: () => void saveRef.current(),
        onBlur: () => {
          if (dirtyRef.current) void saveRef.current();
        },
        onSelection: () => onSelectionRef.current(),
      }),
    [],
  );
  buildExtRef.current = buildExt;

  /* ---------------- 源码 ↔ 预览 双向联动（阶段 2） ---------------- */

  /** 编辑器 → 预览：按编辑器当前顶部可视行滚预览 */
  const syncPreviewFromEditor = useCallback(() => {
    if (performance.now() < syncPausedUntilRef.current) return;
    const lock = syncLockRef.current;
    enqueueSync(lock, "editor", () => {
      const view = viewRef.current;
      const scroller = scrollerRef.current;
      if (!view || !scroller) return;
      const ranges = view.visibleRanges;
      if (ranges.length === 0) return;
      const line = view.state.doc.lineAt(ranges[0].from).number;
      if (isLineCovered(scroller, line)) {
        scrollPreviewToLine(scroller, line);
        lockSync(lock, "editor");
        return;
      }
      // 目标块没挂载（窗口外，例如冻结恢复后视口在文档深处）：
      // 先按估算把窗口拉过去，再外推逼近后精确对齐。
      const jump = previewJumpRef.current?.jumpToLine;
      if (!jump) return;
      lockSync(lock, "editor");
      alignPreviewToLine(scroller, line, jump);
    });
  }, []);

  /** 预览 → 编辑器：按预览顶部块滚编辑器（不移动光标，只滚视口） */
  const syncEditorFromPreview = useCallback(() => {
    if (performance.now() < syncPausedUntilRef.current) return;
    if (!previewSyncArmedRef.current) return;
    const lock = syncLockRef.current;
    enqueueSync(lock, "preview", () => {
      const view = viewRef.current;
      const scroller = scrollerRef.current;
      if (!view || !scroller) return;
      const line = previewTopLine(scroller);
      if (line == null) return;
      const target = Math.min(Math.max(1, line), view.state.doc.lines);
      const ranges = view.visibleRanges;
      const curTop = ranges.length
        ? view.state.doc.lineAt(ranges[0].from).number
        : 0;
      const moved = curTop !== target;
      lockSync(lock, "preview");
      if (!moved) return; // 已在同一行，不动（防抖）
      scrollEditorToLine(view, target, "start", 8, () => {
        const l = syncLockRef.current;
        return l.origin === "preview" && performance.now() - l.at < 600;
      });
    });
  }, []);

  /** 点击预览正文块 → 光标跳到对应源码行（并居中） */
  const onPreviewClick = useCallback((e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-block]");
    const view = viewRef.current;
    if (!el || !view) return;
    const start = Number(el.dataset.start);
    if (!Number.isFinite(start) || start <= 0) return;
    const line = Math.min(Math.max(1, start), view.state.doc.lines);
    const pos = view.state.doc.line(line).from;
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
    scrollEditorToLine(view, line, "center");
    // 这次滚动是「点哪跳哪」，不要再把预览拽回去
    lockSync(syncLockRef.current, "preview");
  }, []);

  /** 光标移动（编辑器内点击 / 方向键）→ 预览跟随 */
  onSelectionRef.current = () => {
    const lock = syncLockRef.current;
    enqueueSync(lock, "editor", () => {
      const view = viewRef.current;
      const scroller = scrollerRef.current;
      if (!view || !scroller) return;
      const line = view.state.doc.lineAt(view.state.selection.main.head).number;
      if (scrollPreviewToLine(scroller, line)) lockSync(lock, "editor");
    });
  };

  /** 记录最后一次可信的编辑器视口（见 viewportRef 注释） */
  const trackViewport = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const el = view.scrollDOM;
    if (!el.isConnected || el.clientHeight <= 0) return;
    const ranges = view.visibleRanges;
    if (ranges.length === 0) return;
    viewportRef.current = {
      scroll: el.scrollTop,
      topLine: view.state.doc.lineAt(ranges[0].from).number,
    };
  }, []);

  /** 编辑器滚动 → 预览跟随（rAF 节流） */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        trackViewport();
        syncPreviewFromEditor();
      });
    };
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    trackViewport();
    return () => {
      view.scrollDOM.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [initSeq, path, syncPreviewFromEditor]);

  /** 预览滚动 → 编辑器跟随（rAF 节流）。预览在「仅源码」形态下不存在，故按形态重挂 */
  const hasPreview = mode !== "editor" && blocks.length > 0;
  useEffect(() => {
    if (!hasPreview) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (scroller.isConnected && scroller.clientHeight > 0) {
          previewScrollRef.current = scroller.scrollTop;
        }
        syncEditorFromPreview();
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hasPreview, mode, syncEditorFromPreview]);

  /* 阶段一：读磁盘 + 取冻结快照（拿到文本后才会渲染出编辑器宿主节点） */
  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    void (async () => {
      try {
        const payload = await api.readSource(path);
        if (disposed) return;
        const restored = takeEditSession(path);
        // 只有「有未保存改动」或「快照内容与磁盘一致」时才恢复快照：
        // 否则（外部改动 + 干净快照）以磁盘为准，避免显示过期文本还报"已同步"
        const snapDoc = (restored?.stateJSON as { doc?: string } | null)?.doc;
        const snap =
          restored && (restored.dirty || snapDoc === payload.text) ? restored : null;
        const base: SourcePayload = snap
          ? {
              ...payload,
              mtimeMs: snap.mtimeMs || payload.mtimeMs,
              eol: (snap.eol as SourcePayload["eol"]) || payload.eol,
              bom: snap.bom,
              size: snap.size || payload.size,
            }
          : payload;
        srcRef.current = base;
        dirtyRef.current = !!snap?.dirty;
        setSrc(base);
        setDirty(!!snap?.dirty);
        initRef.current = { base, snap };
        setInitSeq((n) => n + 1);
      } catch (e) {
        if (!disposed) setError(String(e));
      }
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  /* 阶段二：宿主节点已挂载 → 建 CM6 实例 + 首次整篇预览。
     必须放在独立 effect 里：读盘是异步的，续跑时节点还没提交（hostRef 为 null）。 */
  useLayoutEffect(() => {
    const init = initRef.current;
    const host = hostRef.current;
    if (!init || !host) return;
    const { base, snap } = init;
    const t0 = performance.now();

    const controller = new PreviewController({
      onUpdate: (u) => {
        if (!mountedRef.current) return;
        blocksRef.current = u.blocks;
        setBlocks(u.blocks);
        setSplice(u.splice);
        if (u.toc) setToc(path, u.toc);
      },
      getText: () => viewRef.current?.state.doc.toString() ?? "",
    });
    controllerRef.current = controller;

    const state = createEditorState(base.text, buildExtRef.current(), snap?.stateJSON);
    const docText = state.doc.toString();
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    if (snap?.previewScroll) {
      restoreScrollTop(scrollerRef.current, snap.previewScroll, 6, 800);
    }
    // 编辑器视口：像素值只在 CM6 高度图测准之后才落得住，大文档（2MB）里
    // 首次赋值会被夹到 0。策略是「行号粗定位 → 像素精定位」：
    // 高度图还没测出足够范围时按行先滚到附近（行号不依赖长度估算），
    // 范围够了再把精确像素值写进去。只按行对齐会差一个"部分可见块"（实测 65px）。
    // 落位后还要复查一次：行号路径的 settle 定时器与 CM6 的测量回合都可能把位置挪回去。
    const wantScroll = snap?.editorScroll ?? 0;
    const wantLine = snap?.editorTopLine ?? 0;
    const ladder = [120, 400, 900, 1600];
    let viewportTimer: number | null = null;
    let pixelDone = false;
    const stillRestoring = () => mountedRef.current && !pixelDone;
    const restoreViewport = (rung: number) => {
      if (!mountedRef.current || !wantScroll) return;
      const el = view.scrollDOM;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      if (wantScroll <= max + 2) {
        el.scrollTop = wantScroll;
        if (Math.abs(el.scrollTop - wantScroll) <= 2) {
          pixelDone = true;
          if (rung <= ladder.length) {
            viewportTimer = window.setTimeout(() => {
              if (!mountedRef.current || Math.abs(el.scrollTop - wantScroll) <= 2) return;
              pixelDone = false;
              restoreViewport(rung + 1);
            }, 260);
          }
          return;
        }
      }
      if (wantLine > 0) scrollEditorToLine(view, wantLine, "start", 0, stillRestoring);
      if (rung < ladder.length) {
        viewportTimer = window.setTimeout(() => restoreViewport(rung + 1), ladder[rung]);
      }
    };
    requestAnimationFrame(() => restoreViewport(0));
    // 恢复期间先静默，随后以「编辑器视口」为准对齐预览：
    // 冻结快照里两侧位置可能已经不同步（例如冻结前光标被移动过），
    // 放任两侧互相拉动会把编辑器视口拽回顶部。
    syncPausedUntilRef.current = performance.now() + 700;
    window.setTimeout(() => {
      syncPausedUntilRef.current = 0;
      syncPreviewFromEditor();
    }, 720);
    // 预览：整篇渲染一次（文本取编辑器缓冲，可能是恢复出来的未保存内容）
    void controller.load(path, docText, dirname(path)).then(() => {
      void api.perfLog(`edit-open:${path}`, Math.round(performance.now() - t0));
    });

    return () => {
      mountedRef.current = false;
      if (autosaveRef.current) clearTimeout(autosaveRef.current);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      if (mermaidTimerRef.current) clearTimeout(mermaidTimerRef.current);
      if (viewportTimer != null) clearTimeout(viewportTimer);
      autosaveRef.current = null;
      const snapOut: EditSessionSnapshot = {
        stateJSON: view.state.toJSON(),
        editorScroll: viewportRef.current.scroll || view.scrollDOM.scrollTop,
        editorTopLine: viewportRef.current.topLine || editorTopLine(view),
        previewScroll: previewScrollRef.current || (scrollerRef.current?.scrollTop ?? 0),
        dirty: dirtyRef.current,
        mtimeMs: srcRef.current?.mtimeMs ?? 0,
        eol: srcRef.current?.eol ?? "lf",
        bom: srcRef.current?.bom ?? false,
        size: srcRef.current?.size ?? 0,
      };
      putEditSession(path, snapOut);
      // 冻结/关闭前立即落盘（不阻塞拆卸）
      if (dirtyRef.current && conflictRef.current == null) void saveRef.current();
      view.destroy();
      viewRef.current = null;
      controller.dispose();
      controllerRef.current = null;
      blocksRef.current = [];
      unregisterEditProbe(path);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initSeq, path]);

  /** 状态上移：顶部工具条读 editStatus[path]（只在状态变化时写，避免每次按键都推送） */
  useEffect(() => {
    if (!src) return;    setEditStatus(path, {
      dirty,
      saving,
      conflict,
      eol: src.eol,
      bom: src.bom,
      savedAt: savedAtRef.current,
    });
    return () => setEditStatus(path, null);
  }, [path, src, dirty, saving, conflict]);

  /* 外部改动监听（notify）：磁盘上的文件被别的程序改了。
     脏 → 立刻挂冲突横幅（保存时才不会静默覆盖）；干净 → 直接重载，缓冲跟随磁盘。 */
  useFileWatch(path, (e) => {
    const meta = srcRef.current;
    if (!meta || e.mtimeMs === meta.mtimeMs) return; // 自己保存引起的事件
    // 自己刚写完盘时事件可能先到（invoke 还没返回），用时间窗兜一版
    if (performance.now() - selfWriteAtRef.current < 1500) return;
    if (dirtyRef.current) {
      conflictRef.current = e.mtimeMs;
      if (mountedRef.current) setConflict(e.mtimeMs);
      void api.perfLog(`edit-external-conflict:${path}`, 0);
      return;
    }
    void reloadRef.current();
  });

  /* 切换 源码/预览 时编辑器尺寸变化：让 CM6 重新测量 */
  useLayoutEffect(() => {
    viewRef.current?.requestMeasure();
  }, [mode]);

  /* 预览 DOM 写入完成 → 记录「按键 → 预览更新完成」延迟 */
  useLayoutEffect(() => {
    controllerRef.current?.noteRendered();
  }, [blocks]);

  /* ---------------- 快捷键（焦点在预览侧时也要能存） ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s") return;
      if (!isActive()) return;
      e.preventDefault();
      if (e.shiftKey) void saveAsRef.current();
      else void saveRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive]);

  /* ---------------- 验收探针（仅开发环境） ---------------- */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    registerEditProbe(path, {
      path,
      text: () => viewRef.current?.state.doc.toString() ?? "",
      snapshot: () => ({
        dirty: dirtyRef.current,
        saving: savingRef.current,
        conflict: conflictRef.current,
        eol: srcRef.current?.eol ?? "",
        bom: !!srcRef.current?.bom,
        mtimeMs: srcRef.current?.mtimeMs ?? 0,
        size: srcRef.current?.size ?? 0,
        textLen: viewRef.current?.state.doc.length ?? 0,
        blocks: blocksRef.current.length,
        mounted: document.querySelectorAll("[data-edit-preview] [data-block]").length,
        metrics: controllerRef.current?.metrics ?? newMetrics(),
        stateJSON: null,
      }),
      cursor: () => {
        const v = viewRef.current;
        if (!v) return { line: 0, col: 0, scrollTop: 0, focused: false };
        const head = v.state.selection.main.head;
        const line = v.state.doc.lineAt(head);
        return {
          line: line.number,
          col: head - line.from,
          scrollTop: Math.round(v.scrollDOM.scrollTop),
          focused: v.hasFocus,
        };
      },
      syncProbe: () => {
        const v = viewRef.current;
        const sc = scrollerRef.current;
        const edTop =
          v && v.visibleRanges.length
            ? v.state.doc.lineAt(v.visibleRanges[0].from).number
            : 0;
        const pvTop = sc ? previewTopLine(sc) : null;
        const ranges = v?.visibleRanges ?? [];
        const edBottom =
          v && ranges.length
            ? v.state.doc.lineAt(ranges[ranges.length - 1].to).number
            : 0;
        const blocks = blocksRef.current;
        const idxOf = (line: number | null) =>
          line == null
            ? -1
            : blocks.findIndex((b) => line >= b.startLine && line <= b.endLine);
        return {
          editorTopLine: edTop,
          editorBottomLine: edBottom,
          previewTopLine: pvTop,
          editorTopBlock: idxOf(edTop),
          previewTopBlock: idxOf(pvTop),
          blockCount: blocks.length,
          editorScrollTop: v ? Math.round(v.scrollDOM.scrollTop) : 0,
          previewScrollTop: sc ? Math.round(sc.scrollTop) : 0,
          // 滚动边界（验收脚本判断"到顶/到底被夹取"用）
          editorScrollHeight: v ? Math.round(v.scrollDOM.scrollHeight) : 0,
          editorClientHeight: v ? Math.round(v.scrollDOM.clientHeight) : 0,
          previewScrollHeight: sc ? Math.round(sc.scrollHeight) : 0,
          previewClientHeight: sc ? Math.round(sc.clientHeight) : 0,
        };
      },
      blockLines: () =>
        blocksRef.current.map((b) => ({ start: b.startLine, end: b.endLine })),
      measure: (line) => {
        const v = viewRef.current;
        if (!v) return null;
        const n = Math.min(Math.max(1, Math.round(line)), v.state.doc.lines);
        const block = v.lineBlockAt(v.state.doc.line(n).from);
        return {
          line: n,
          blockTop: Math.round(block.top),
          blockBottom: Math.round(block.bottom),
          documentTop: Math.round(v.documentTop),
          scrollTop: Math.round(v.scrollDOM.scrollTop),
          scrollRectTop: Math.round(v.scrollDOM.getBoundingClientRect().top),
          clientHeight: v.scrollDOM.clientHeight,
          scrollHeight: v.scrollDOM.scrollHeight,
          topLine:
            v.visibleRanges.length > 0
              ? v.state.doc.lineAt(v.visibleRanges[0].from).number
              : 0,
        };
      },
      gotoLine: (line) => {
        const v = viewRef.current;
        if (!v) return;
        const n = Math.min(Math.max(1, Math.round(line)), v.state.doc.lines);
        v.dispatch({ selection: { anchor: v.state.doc.line(n).from } });
        scrollEditorToLine(v, n, "start");
      },
      insertAtLine: (line, text) => {
        const v = viewRef.current;
        if (!v) return;
        const n = Math.min(Math.max(1, Math.round(line)), v.state.doc.lines);
        const at = v.state.doc.line(n).to;
        v.dispatch({ changes: { from: at, insert: text } });
      },
      save: async (force) => {
        await saveRef.current(force);
      },
      sync: async () => {
        await controllerRef.current?.syncNow();
      },
      replaceAll: (text) => {
        const v = viewRef.current;
        if (v) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
      },
      insertAtStart: (text) => {
        const v = viewRef.current;
        if (v) v.dispatch({ changes: { from: 0, insert: text } });
      },
      conflictUi: () => {
        const panel = document.querySelector(
          `[data-conflict-panel="${CSS.escape(path)}"]`,
        );
        return {
          visible: !!panel,
          buttons: panel
            ? Array.from(panel.querySelectorAll("[data-conflict-action]")).map(
                (b) => b.textContent ?? "",
              )
            : [],
        };
      },
      clickConflict: (label) => {
        const panel = document.querySelector(
          `[data-conflict-panel="${CSS.escape(path)}"]`,
        );
        const btn = panel
          ? Array.from(panel.querySelectorAll<HTMLElement>("[data-conflict-action]")).find(
              (b) => (b.textContent ?? "").includes(label),
            )
          : null;
        btn?.click();
      },
      reload: reloadFromDisk,
    });
    return () => unregisterEditProbe(path);
  }, [path, reloadFromDisk]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-[13px] text-text-3">
        打开失败：{error}
      </div>
    );
  }
  if (!src) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-text-3">
        <span className="animate-pulse">加载中…</span>
      </div>
    );
  }

  return (
    <div className="edit-pane" data-edit-path={path}>
      {conflict != null && (
        <div className="edit-conflict" data-conflict-panel={path}>
          <span>
            磁盘上的文件已被外部修改（mtime {conflict}），本地改动尚未保存。
          </span>
          <button data-conflict-action="overwrite" onClick={() => void save(conflict)}>
            覆盖
          </button>
          <button data-conflict-action="reload" onClick={() => void reloadFromDisk()}>
            重新载入
          </button>
          <button data-conflict-action="saveAs" onClick={() => void saveAs()}>
            另存为
          </button>
        </div>
      )}
      {saveError && (
        <div className="edit-save-error" data-save-error>
          保存失败：{saveError}
        </div>
      )}

      {/* 仅预览形态下编辑器只是 hidden、不卸载：保住 CM6 实例、光标与撤销历史，
          冻结（切标签）才真正销毁 DOM。 */}
      <div className={`edit-body mode-${mode}`}>
        <div className="edit-editor" ref={hostRef} hidden={mode === "preview"} />
        {mode !== "editor" && (
          <BlockPreview
            blocks={blocks}
            splice={splice}
            scrollerRef={scrollerRef}
            jumpRef={previewJumpRef}
            onInject={injectBlock}
            onClick={onPreviewClick}
            onUserGesture={() => {
              previewSyncArmedRef.current = true;
            }}
            emptyHint="（空文档：开始输入即可，右侧预览会跟着更新）"
          />
        )}
      </div>
    </div>
  );
}
