import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PreviewBlock } from "./previewModel";

/** 初始高度估算系数（px / HTML 字节），挂载后按实测修正 */
const ESTIMATE_PX_PER_BYTE = 0.55;
/** 可视区外各保留块数 */
const BUFFER = 2;
/** 块数/字节低于此值全量挂载（小文档没有窗口化的必要） */
const FULL_MOUNT_MAX_BLOCKS = 240;
const FULL_MOUNT_MAX_BYTES = 400_000;
/** 可视区外预挂载边距（px） */
const OVERSCAN_PX = 400;
/** 连续"实测修正"触发的重渲染上限：标签/图片异步布局不得把渲染打成死循环 */
const MEASURE_TICK_LIMIT = 6;

interface Props {
  blocks: PreviewBlock[];
  /** 本次变化相对上一份块列表的替换范围；null = 整份替换 */
  splice: { lo: number; hi: number } | null;
  /** 滚动容器（由父级持有，冻结时记录位置） */
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  /**
   * 跳到源码行的命令句柄（供父级同步用）。
   * 目标块未挂载时 `scrollPreviewToLine` 无从对齐，只能先按估算高度把窗口滚过去；
   * 块挂载后由调用方再做一次精确对齐。
   */
  jumpRef?: React.RefObject<{ jumpToLine: (line: number) => boolean } | null>;
  /** 新块注入后的增强（打字期间可降级） */
  onInject: (el: HTMLElement) => void;
  /** 点击正文块（用于把光标跳到对应源码行） */
  onClick?: (e: React.MouseEvent) => void;
  /** 用户在预览里的真实手势（滚轮/按下）：用于解除"恢复后暂停反向联动" */
  onUserGesture?: () => void;
  /** 空文档提示 */
  emptyHint?: string;
}

/**
 * 分栏预览的正文：按顶层块维护 DOM，只挂载可视区附近的块。
 *
 * 三条不变量：
 * 1. React 只管结构与 `key` / `data-block`（下标），`innerHTML` 与 `data-rev` 由本组件的
 *    注入器直接写 DOM —— 注入器自带版本比对，块内容变了才重写，未受影响的块元素身份不变。
 * 2. 未挂载区域用前后两个占位 div 撑高（高度取估算值，挂载后按实测修正），
 *    因此 2MB / 上万块文档的 React 元素数量恒定在可视区量级。
 * 3. 行号平移（块插入/删除导致后续块行号变化）只改 `data-start/data-end`，不重写 HTML。
 */
export function BlockPreview({
  blocks,
  splice,
  scrollerRef,
  jumpRef,
  onInject,
  onClick,
  onUserGesture,
  emptyHint,
}: Props) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const heights = useRef<number[]>([]);
  const rangeRef = useRef<[number, number]>([0, -1]);
  const prevBlocks = useRef<PreviewBlock[] | null>(null);
  const [, force] = useState(0);
  const rafRef = useRef(0);
  /** 实测修正的重渲染计数与帧节流（见下方注入器注释） */
  const measureTickRef = useRef(0);
  const measureRafRef = useRef(0);

  const totalBytes = blocks.reduce((n, b) => n + b.html.length, 0);
  const fullMount =
    blocks.length <= FULL_MOUNT_MAX_BLOCKS && totalBytes <= FULL_MOUNT_MAX_BYTES;

  /* 高度表与块列表同步（插入/删除时按替换范围拼接，未受影响块沿用已测高度） */
  if (prevBlocks.current !== blocks) {
    const prev = prevBlocks.current;
    const estimate = (b: PreviewBlock) =>
      Math.max(24, Math.round(b.html.length * ESTIMATE_PX_PER_BYTE));
    if (!prev || !splice) {
      heights.current = blocks.map(estimate);
    } else {
      const { lo, hi } = splice;
      const head = heights.current.slice(0, lo);
      const fresh = blocks
        .slice(lo, hi + 1)
        .map((b, i) => heights.current[lo + i] ?? estimate(b));
      const tail = heights.current.slice(hi + 1, hi + 1 + (blocks.length - hi - 1));
      heights.current = [...head, ...fresh, ...tail];
      if (heights.current.length !== blocks.length) {
        heights.current = blocks.map((b, i) => heights.current[i] ?? estimate(b));
      }
    }
    prevBlocks.current = blocks;
  }

  const sumHeights = (from: number, to: number) => {
    let n = 0;
    for (let i = from; i < to; i++) n += heights.current[i] ?? 24;
    return Math.round(n);
  };

  const recompute = () => {
    const scroller = scrollerRef.current;
    if (!scroller || blocks.length === 0) {
      rangeRef.current = [0, -1];
      return;
    }
    if (fullMount) {
      rangeRef.current = [0, blocks.length - 1];
      return;
    }
    const top = scroller.scrollTop;
    const bottom = top + scroller.clientHeight;
    let y = 0;
    let first = -1;
    let last = -1;
    for (let i = 0; i < blocks.length; i++) {
      const h = heights.current[i] ?? 24;
      if (y + h >= top - OVERSCAN_PX && y <= bottom + OVERSCAN_PX) {
        if (first < 0) first = i;
        last = i;
      }
      y += h;
    }
    if (first < 0) {
      // 滚动位置在估算范围之外（高度失真）：退化成显示首块附近
      first = 0;
      last = Math.min(blocks.length - 1, 20);
    }
    const lo = Math.max(0, first - BUFFER);
    const hi = Math.min(blocks.length - 1, last + BUFFER);
    rangeRef.current = [lo, hi];
  };

  const scheduleRecompute = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const before = rangeRef.current;
      recompute();
      if (before[0] !== rangeRef.current[0] || before[1] !== rangeRef.current[1]) {
        force((v) => v + 1);
      }
    });
  };

  /**
   * 按源码行跳转（父级同步用）。
   * 目标块在窗口外时 `scrollPreviewToLine` 够不着，这里先按估算高度把滚动位置移过去，
   * 窗口重算后目标块挂载，调用方再做一次精确对齐。
   */
  const jumpToLine = (line: number): boolean => {
    const scroller = scrollerRef.current;
    if (!scroller || blocks.length === 0) return false;
    let idx = -1;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (line <= b.endLine) {
        idx = i;
        break;
      }
    }
    if (idx < 0) idx = blocks.length - 1;
    const target = Math.max(0, sumHeights(0, idx) - 8);
    if (Math.abs(scroller.scrollTop - target) >= 2) scroller.scrollTop = target;
    scheduleRecompute();
    return true;
  };

  useLayoutEffect(() => {
    if (!jumpRef) return;
    jumpRef.current = { jumpToLine };
    return () => {
      jumpRef.current = null;
    };
  });

  recompute();

  /* 滚动与尺寸变化 → 重算可视块范围 */
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || fullMount) return;
    const onScroll = () => scheduleRecompute();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => scheduleRecompute());
    ro.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullMount, blocks.length]);

  /* 块列表变化 → 重算范围（可能影响可视区） */
  useLayoutEffect(() => {
    measureTickRef.current = 0; // 内容变了，允许重新实测
    scheduleRecompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks]);

  /* DOM 注入器：版本比对 → 重写 HTML；行号平移只改属性。
     高度实测修正会触发一次重渲染，这里必须限频：
     标签/图片等异步布局会让 offsetHeight 反复变化，不设上限就是
     "render → 测量 → setState → render" 的自增循环（React 会直接抛
     Maximum update depth exceeded 并卸载整棵树 = 白屏）。 */
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const nodes = content.querySelectorAll<HTMLElement>("[data-block]");
    let measured = false;
    nodes.forEach((el) => {
      const i = Number(el.dataset.block);
      const b = blocks[i];
      if (!b) {
        el.innerHTML = "";
        return;
      }
      const rev = String(b.rev);
      if (el.dataset.rev !== rev) {
        el.dataset.rev = rev;
        el.dataset.start = String(b.startLine);
        el.dataset.end = String(b.endLine);
        el.innerHTML = b.html;
        onInject(el);
      } else if (
        el.dataset.start !== String(b.startLine) ||
        el.dataset.end !== String(b.endLine)
      ) {
        el.dataset.start = String(b.startLine);
        el.dataset.end = String(b.endLine);
      }
      const h = el.offsetHeight;
      if (h > 0 && Math.abs((heights.current[i] ?? -1) - h) > 2) {
        heights.current[i] = h;
        measured = true;
      }
    });
    if (!measured || measureTickRef.current >= MEASURE_TICK_LIMIT) return;
    measureTickRef.current += 1;
    if (measureRafRef.current) return;
    measureRafRef.current = requestAnimationFrame(() => {
      measureRafRef.current = 0;
      force((v) => v + 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  const [lo, hi] = rangeRef.current;
  const pre = fullMount ? 0 : sumHeights(0, Math.max(0, lo));
  const post = fullMount ? 0 : sumHeights(Math.min(blocks.length, hi + 1), blocks.length);
  const nodes: React.ReactNode[] = [];
  for (let i = Math.max(0, lo); i <= hi; i++) {
    const b = blocks[i];
    // key 用 rev（内容版本）而不是下标：块插入/删除后，未受影响的块 React 会复用
    // 同一个 DOM 节点（元素身份不变、innerHTML 不重写），只有真的变了或新增的块换节点。
    nodes.push(<div key={b ? b.rev : `i-${i}`} data-block={i} className="doc-block" />);
  }

  return (
    <div
      ref={scrollerRef}
      className="doc-scroll edit-preview-scroll"
      data-edit-preview
      onClick={onClick}
      onPointerDown={onUserGesture}
      onWheel={onUserGesture}
    >
      <div ref={contentRef} className="doc-content markdown-body">
        {blocks.length === 0 && (
          <div className="edit-empty-hint">{emptyHint ?? "（空文档）"}</div>
        )}
        {pre > 0 && <div className="edit-preview-spacer" style={{ height: pre }} />}
        {nodes}
        {post > 0 && <div className="edit-preview-spacer" style={{ height: post }} />}
      </div>
    </div>
  );
}
