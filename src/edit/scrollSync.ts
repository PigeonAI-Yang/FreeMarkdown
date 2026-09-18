import type { EditorView } from "@codemirror/view";

/**
 * 源码 ↔ 预览的双向定位（阶段 2）。
 *
 * 不维护第二套映射表：预览块 DOM 上本来就带 `data-sourcepos` 派生的
 * `data-start` / `data-end`（Rust 侧按 comrak 的块边界给出，是全文行号），
 * 源码侧用 CM6 自己的行号，两边都以「行号」为唯一坐标。
 *
 * 三条约定：
 * 1. 只按块对齐（粒度就是一个顶层块），不做行内像素级对齐——与方案里
 *    「双向联动定位误差 ≤ 1 个块」的口径一致。
 * 2. 联动是单向触发的：谁在动，谁就只驱动对面；触发后短暂上锁，
 *    避免两侧 scroll 互相回灌形成抖动。
 * 3. 打字不触发联动（只有用户主动滚动/点击/移动光标才联动）。
 */

/** 联动方向：由哪一侧发起 */
export type SyncOrigin = "editor" | "preview";

/**
 * 回填滚动位置，带重试。
 *
 * 刚挂载的滚动容器可能还没测出内容高度（scrollHeight≈0），直接赋值会被夹成 0；
 * 这里在几帧内重试，等 CM6 / 预览测完高度后落位。
 */
export function restoreScrollTop(
  el: HTMLElement | null,
  target: number,
  tries = 5,
  budgetMs = 0,
) {
  if (!el || target <= 0) return;
  const deadline = budgetMs > 0 ? performance.now() + budgetMs : 0;
  const attempt = (n: number) => {
    if (!el.isConnected) return;
    el.scrollTop = target;
    if (Math.abs(el.scrollTop - target) <= 2) return;
    if (n > 0 || (deadline > 0 && performance.now() < deadline)) {
      requestAnimationFrame(() => attempt(n - 1));
    }
  };
  requestAnimationFrame(() => attempt(tries));
}

/** 编辑器视口顶部行号（冻结/恢复用的可靠坐标） */
export function editorTopLine(view: EditorView): number {
  const range = view.visibleRanges[0];
  if (!range) return 1;
  return view.state.doc.lineAt(range.from).number;
}

export interface SyncLock {
  origin: SyncOrigin | null;
  at: number;
  /** 被对侧锁挡住时登记的最后一次请求（锁过期后补跑，保证"最后一次一定生效"） */
  pending: SyncOrigin | null;
  timer: number | null;
}

/** 联动互斥窗口：这段时间内不响应被驱动侧的事件（防 ping-pong） */
const LOCK_MS = 180;

export function lockSync(lock: SyncLock, origin: SyncOrigin) {
  lock.origin = origin;
  lock.at = performance.now();
}

/** 对侧是否正在驱动我们（这时我们收到的事件是被驱动产生的，不该再反向联动） */
function lockedByOther(lock: SyncLock, origin: SyncOrigin): boolean {
  if (lock.origin == null || lock.origin === origin) return false;
  return performance.now() - lock.at <= LOCK_MS;
}

/**
 * 联动事件入口。
 *
 * 单纯用时间窗丢事件会漏掉"连续滚动里的最后一次"（滚动事件约 130ms 一个、
 * 互斥窗 180ms，就会出现"编辑器总是差两块"这类残留偏差）。这里改成：
 * 被挡住时登记 pending，锁一过期就补跑一次。
 */
export function enqueueSync(
  lock: SyncLock,
  origin: SyncOrigin,
  run: () => void,
) {
  if (!lockedByOther(lock, origin)) {
    run();
    return;
  }
  lock.pending = origin;
  const wait = Math.max(0, LOCK_MS - (performance.now() - lock.at)) + 16;
  if (lock.timer != null) clearTimeout(lock.timer);
  lock.timer = window.setTimeout(() => {
    lock.timer = null;
    const p = lock.pending;
    lock.pending = null;
    if (p !== origin) return;
    lock.origin = null; // 清锁，让 run() 里的联动重新上锁
    run();
  }, wait);
}

export interface BlockLineRange {
  start: number;
  end: number;
}

/** 预览里已挂载的块的源码行范围（按 data-start 排序） */
export function mountedBlockRanges(scroller: HTMLElement): BlockLineRange[] {
  const els = Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-edit-preview] [data-block], [data-block]"),
  );
  const out: BlockLineRange[] = [];
  for (const el of els) {
    const start = Number(el.dataset.start);
    const end = Number(el.dataset.end);
    if (Number.isFinite(start) && start > 0) {
      out.push({ start, end: Number.isFinite(end) && end >= start ? end : start });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * 预览顶部对应的源码行：取「覆盖视口顶部」的那个块。
 * 用块元素相对滚动容器的位置判断，避免受占位高度估算影响。
 */
export function previewTopLine(scroller: HTMLElement): number | null {
  const top = scroller.getBoundingClientRect().top;
  const els = Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-block]"),
  );
  let best: { start: number; dist: number } | null = null;
  for (const el of els) {
    const start = Number(el.dataset.start);
    if (!Number.isFinite(start) || start <= 0) continue;
    const r = el.getBoundingClientRect();
    // 视口顶部附近的第一个块（底部已进入视口）
    if (r.bottom < top + 4) continue;
    const dist = Math.abs(r.top - top);
    if (!best || dist < best.dist) best = { start, dist };
  }
  return best ? best.start : null;
}

/** 找到覆盖某源码行的块（未命中时取其后最近的块） */export function blockForLine(
  ranges: BlockLineRange[],
  line: number,
): BlockLineRange | null {
  if (ranges.length === 0) return null;
  for (const r of ranges) {
    if (line >= r.start && line <= r.end) return r;
  }
  for (const r of ranges) {
    if (r.start >= line) return r;
  }
  return ranges[ranges.length - 1];
}

/** 把预览滚到指定源码行对应的块（已挂载时精确对齐，未挂载时返回 false） */
export function scrollPreviewToLine(
  scroller: HTMLElement,
  line: number,
  margin = 24,
): boolean {
  const els = Array.from(scroller.querySelectorAll<HTMLElement>("[data-block]"));
  let target: { el: HTMLElement; dist: number } | null = null;
  for (const el of els) {
    const start = Number(el.dataset.start);
    const end = Number(el.dataset.end);
    if (!Number.isFinite(start) || start <= 0) continue;
    const hit = line >= start && line <= (Number.isFinite(end) ? end : start);
    const dist = hit ? 0 : Math.abs(start - line);
    if (!target || dist < target.dist) target = { el, dist };
  }
  if (!target) return false;
  const delta =
    target.el.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top -
    margin;
  scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
  return true;
}

/**
 * 该源码行当前有没有挂载中的块可以对齐。
 *
 * `scrollPreviewToLine` 在目标块没挂载时会退化成"找最近的已挂载块"并返回 true，
 * 只看返回值分不出"真的对齐了"和"窗口里根本没有这个块"，所以要显式判断。
 */
export function isLineCovered(scroller: HTMLElement, line: number): boolean {
  return mountedBlockRanges(scroller).some((r) => line >= r.start && line <= r.end);
}

/**
 * 把预览对齐到指定源码行，目标块在窗口外也能到。
 *
 * 窗口外的块没有 DOM，`scrollPreviewToLine` 无从对齐；`jump` 会按估算高度把窗口滚过去，
 * 但块高估算与实测差得远（2MB 文档实测只落在文档 2% 附近），所以再按
 * 「目标行 / 当前顶部行」做线性外推逼近，目标块进窗口后再精确对齐。
 */
export function alignPreviewToLine(
  scroller: HTMLElement,
  line: number,
  jump: (line: number) => boolean,
  tries = 8,
) {
  const step = (n: number) => {
    if (!scroller.isConnected) return;
    if (isLineCovered(scroller, line)) {
      scrollPreviewToLine(scroller, line);
      return;
    }
    if (n <= 0) return;
    const top = previewTopLine(scroller);
    if (top != null && top > 0 && top !== line) {
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const next = Math.max(
        0,
        Math.min(max, Math.round((scroller.scrollTop * line) / top)),
      );
      if (Math.abs(next - scroller.scrollTop) >= 4) {
        scroller.scrollTop = next;
        jump(line);
      }
    }
    requestAnimationFrame(() => step(n - 1));
  };
  jump(line);
  requestAnimationFrame(() => step(tries));
}

/**
 * 把编辑器滚到指定源码行（start = 贴顶，center = 居中）。
 *
 * 不用 `EditorView.scrollIntoView`：目标已经在视口内时它会直接不动，
 * 于是"预览滚到中段、编辑器只跟着动一点点"这类联动会失效（实测差 8 个块）。
 * 这里按 `lineBlockAt` 的真实几何自己算滚动量，贴顶就是贴顶。
 */
export function scrollEditorToLine(
  view: EditorView,
  line: number,
  align: "start" | "center" = "start",
  margin = 8,
  stillValid?: () => boolean,
) {
  const n = Math.min(Math.max(1, Math.round(line)), view.state.doc.lines);
  const pos = view.state.doc.line(n).from;

  const applyOnce = (): boolean => {
    const block = view.lineBlockAt(pos);
    const blockH = Math.max(1, block.bottom - block.top);
    const offset =
      align === "center"
        ? Math.max(margin, (view.scrollDOM.clientHeight - blockH) / 2)
        : margin;
    // CM6 的 BlockInfo.top 是「文档坐标 + 容器顶偏移」，与滚动位置无关；
    // 容器顶（scrollDOM 的屏幕 y）在同一个坐标空间里，相减即该块贴顶所需的绝对 scrollTop。
    // 别写成 scrollTop +=：那会多算当前滚动量，落到越界值再被夹住，看起来"没反应"。
    const rectTop = view.scrollDOM.getBoundingClientRect().top;
    const want = Math.max(0, block.top - rectTop - offset);
    if (Math.abs(want - view.scrollDOM.scrollTop) < 1) return false;
    view.scrollDOM.scrollTop = want;
    return true;
  };

  const settle = (delay: number, passes: number) => {
    window.setTimeout(() => {
      if (stillValid && !stillValid()) return;
      if (applyOnce() && passes > 1) settle(delay, passes - 1);
    }, delay);
  };

  if (!applyOnce()) return;
  // 目标块在屏幕外时高度图给的是估算值，一次可能落不准：
  // CM6 重测（下一帧 / 稍后）后再校正两轮，逐步收敛到贴顶。
  requestAnimationFrame(() => {
    if (stillValid && !stillValid()) return;
    if (applyOnce()) settle(60, 2);
  });
}
