import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { DocPayload } from "../lib/ipc";
import { api } from "../lib/ipc";
import {
  consumePendingJump,
  jumpRegistry,
  onDocSaved,
  scrollMap,
  setActiveHeading,
  setDocInfo,
  setToc,
} from "../lib/store";
import { enhanceChunk } from "../lib/enhance";
import { useFileWatch } from "../lib/watch";
import { Lightbox } from "./Lightbox";

/** 超过此源文件大小走分块虚拟滚动 */
const BIG_DOC_BYTES = 1024 * 1024;
/** 初始高度估算系数（px / html字节），按实测逐步修正 */
const ESTIMATE_PX_PER_BYTE = 0.55;
/** 可视区外各保留 2 块 */
const CHUNK_BUFFER = 2;

/** path -> chunks HTML（锚点/搜索的字符串级定位用） */
export const chunkHtmlCache = new Map<string, string[]>();
/** path -> 最近一次解析结果（窗格解冻重挂载时零等待复用） */
const docCache = new Map<string, DocPayload>();

interface MdViewProps {
  path: string;
}

export function MarkdownView({ path }: MdViewProps) {
  const [doc, setDoc] = useState<DocPayload | null>(() => docCache.get(path) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(
    null,
  );
  const bigDoc = !!doc && doc.size > BIG_DOC_BYTES;

  /* ------- 编辑面板保存广播：同路径阅读面板按新 mtime 重读（LRU 自然失效） ------- */
  useEffect(() => {
    return onDocSaved((p) => {
      if (p !== path) return;
      // 丢掉这份过期载荷，触发重新解析
      docCache.delete(path);
      setReloadSeq((n) => n + 1);
    });
  }, [path]);

  /* ------- 外部改动监听：磁盘上的文件被别的程序改了 → 热刷新（mtime 变了才刷） ------- */
  useFileWatch(path, (e) => {
    const loaded = docCache.get(path);
    if (loaded && e.mtimeMs === loaded.mtimeMs) return; // 自己保存引起的事件
    docCache.delete(path);
    setReloadSeq((n) => n + 1);
    void api.perfLog(`doc-external-reload:${path}`, 0);
  });

  /* ------- 加载文档（Rust 后台解析，LRU 命中零解析） ------- */
  useEffect(() => {
    let alive = true;
    setDoc(null);
    setError(null);
    const t0 = performance.now();
    api
      .readMarkdown(path)
      .then((payload) => {
        if (!alive) return;
        setDoc(payload);
        docCache.set(path, payload);
        setToc(path, payload.toc);
        setDocInfo(path, {
          size: payload.size,
          parseMs: payload.parseMs,
          fromCache: payload.fromCache,
        });
        chunkHtmlCache.set(path, payload.chunks);
        void api.perfLog(
          `doc-ready:${path}`,
          Math.round(performance.now() - t0),
        );
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [path, reloadSeq]);

  /* ------- 内容注入完成后的增强（由子级注入点调用） ------- */
  const afterInject = useCallback(
    (_container: HTMLElement) => {
      void enhanceChunk(_container);
    },
    [],
  );

  /* ------- 注册跳转执行器（先于滚动恢复 effect 声明，保证时序） ------- */
  useLayoutEffect(() => {
    jumpRegistry.set(path, (opts) => {
      if (opts?.revealText || opts?.line)
        jumpToText(path, opts?.revealText ?? "", opts?.line);
      else if (opts?.anchor) jumpToAnchor(path, opts.anchor);
    });
    return () => {
      jumpRegistry.delete(path);
    };
  }, [path]);

  /* ------- 滚动恢复 + 待处理跳转（本组件 layout effect 时 ref 已挂载） ------- */
  useLayoutEffect(() => {
    if (!doc) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const target = scrollMap.get(path) ?? 0;
    requestAnimationFrame(() => {
      scroller.scrollTop = target;
      const pending = consumePendingJump(path);
      if (pending) {
        requestAnimationFrame(() => jumpRegistry.get(path)?.({ ...pending }));
      }
    });
  }, [doc, path]);

  /* ------- 小文档：一次性 innerHTML 注入 ------- */
  const smallHtml = doc && !bigDoc ? doc.chunks.join("") : null;
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || smallHtml == null) return;
    el.innerHTML = smallHtml;
    afterInject(el);
  }, [smallHtml, afterInject]);

  /* ------- 滚动联动：保存位置 + TOC 高亮 ------- */
  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    scheduleScrollWork(path, scroller, content);
  }, [path]);

  useEffect(() => () => flushScrollWork(), []);

  /* ------- 点击委托：md 内链 / 外链 / 锚点 / 图片缩放 ------- */
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a");
      if (anchor) {
        e.preventDefault();
        const mdHref = anchor.dataset.mdHref;
        if (mdHref) {
          void import("../lib/store").then(({ openFile }) =>
            openFile(mdHref, { anchor: anchor.dataset.mdAnchor }),
          );
          return;
        }
        if (anchor.dataset.external) {
          void api.openExternal(anchor.getAttribute("href") ?? "");
          return;
        }
        const hash = anchor.getAttribute("href") ?? "";
        if (hash.startsWith("#")) jumpToAnchor(path, hash.slice(1));
        return;
      }
      const img = target.closest("img");
      if (img) {
        setLightbox({ src: img.getAttribute("src") ?? "", alt: img.alt });
      }
    },
    [path],
  );

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-[13px] text-text-3">
        打开失败：{error}
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-text-3">
        <span className="animate-pulse">加载中…</span>
      </div>
    );
  }

  return (
    <div ref={scrollerRef} className="doc-scroll" onScroll={onScroll} onClick={onClick}>
      {bigDoc ? (
        <ChunkedContent ref={contentRef} chunks={doc.chunks} onInject={afterInject} />
      ) : (
        <div ref={contentRef} className="doc-content markdown-body" data-path={path} />
      )}
      {lightbox && (
        <Lightbox
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

/* ================= 大文档：分块虚拟滚动，只挂载可视区 ================= */

interface ChunkedProps {
  chunks: string[];
  onInject: (container: HTMLElement) => void;
}

const ChunkedContent = React.forwardRef<HTMLDivElement, ChunkedProps>(
  function ChunkedContent({ chunks, onInject }, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const scrollerRef = useRef<HTMLDivElement | null>(null);
    const heights = useRef<number[]>([]);
    const mounted = useRef<Set<number>>(new Set());
    const [version, setVersion] = useState(0);

    if (heights.current.length !== chunks.length) {
      heights.current = chunks.map((c) => Math.max(80, c.length * ESTIMATE_PX_PER_BYTE));
      mounted.current = new Set();
    }

    useLayoutEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      scrollerRef.current = host.closest(".doc-scroll") as HTMLDivElement | null;
      onInject(host);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chunks]);

    const recompute = useCallback(() => {
      const host = hostRef.current;
      const scroller = scrollerRef.current;
      if (!host || !scroller) return;
      const top = scroller.scrollTop;
      const bottom = top + scroller.clientHeight;
      let y = 0;
      let first = Number.MAX_SAFE_INTEGER;
      let last = -1;
      for (let i = 0; i < chunks.length; i++) {
        const h = heights.current[i];
        if (y + h >= top - 400 && y <= bottom + 400) {
          first = Math.min(first, i);
          last = Math.max(last, i);
        }
        y += h;
      }
      const want = new Set<number>();
      if (last >= 0) {
        for (
          let i = Math.max(0, first - CHUNK_BUFFER);
          i <= Math.min(chunks.length - 1, last + CHUNK_BUFFER);
          i++
        ) {
          want.add(i);
        }
      }
      let changed = false;
      for (const i of [...mounted.current]) {
        if (!want.has(i)) {
          mounted.current.delete(i);
          changed = true;
        }
      }
      for (const i of want) {
        if (!mounted.current.has(i)) {
          mounted.current.add(i);
          changed = true;
        }
      }
      if (changed) setVersion((v) => v + 1);
    }, [chunks]);

    useEffect(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      let raf = 0;
      const handler = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(recompute);
      };
      scroller.addEventListener("scroll", handler, { passive: true });
      recompute();
      return () => {
        scroller.removeEventListener("scroll", handler);
        cancelAnimationFrame(raf);
      };
    }, [recompute]);

    // 实测已挂载 chunk 高度，修正估算（收敛后不再触发）
    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      let changed = false;
      for (const i of mounted.current) {
        const el = host.querySelector<HTMLElement>(`[data-chunk="${i}"]`);
        if (!el || !el.classList.contains("doc-chunk-filled")) continue;
        const h = el.offsetHeight;
        if (Math.abs((heights.current[i] ?? 0) - h) > 2) {
          heights.current[i] = h;
          changed = true;
        }
      }
      if (changed) setVersion((v) => v + 1);
    });

    const nodes: React.ReactNode[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (mounted.current.has(i)) {
        nodes.push(
          <div
            key={i}
            data-chunk={i}
            className="doc-chunk doc-chunk-filled"
            ref={(el) => {
              if (el && el.dataset.injected !== "1") {
                el.dataset.injected = "1";
                el.innerHTML = chunks[i];
                void enhanceChunk(el);
              }
            }}
          />,
        );
      } else {
        nodes.push(
          <div
            key={i}
            data-chunk={i}
            className="doc-chunk"
            style={{ height: heights.current[i] }}
          />,
        );
      }
    }

    void version;
    return (
      <div ref={mergeRefs(ref, hostRef)} className="doc-content markdown-body">
        {nodes}
      </div>
    );
  },
);

/* ================= 辅助 ================= */

function mergeRefs<T>(
  a: React.ForwardedRef<T>,
  b: React.RefObject<T | null>,
): (el: T | null) => void {
  return (el) => {
    if (typeof a === "function") a(el);
    else if (a) (a as React.MutableRefObject<T | null>).current = el;
    b.current = el;
  };
}

/** 滚动事件节流：保存位置 + TOC 高亮 */
const lastSpy = new Map<string, number>();
let scrollRaf = 0;
function scheduleScrollWork(
  path: string,
  scroller: HTMLDivElement,
  content: HTMLElement,
) {
  scrollMap.set(path, scroller.scrollTop);
  const now = performance.now();
  if (now - (lastSpy.get(path) ?? 0) < 120) {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      spyHeading(path, scroller, content);
    });
    return;
  }
  lastSpy.set(path, now);
  spyHeading(path, scroller, content);
}

function flushScrollWork() {
  if (scrollRaf) {
    cancelAnimationFrame(scrollRaf);
    scrollRaf = 0;
  }
}

function spyHeading(path: string, scroller: HTMLDivElement, content: HTMLElement) {
  const headings = content.querySelectorAll<HTMLElement>("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]");
  if (headings.length === 0) return;
  const line = scroller.getBoundingClientRect().top + 96;
  let active: string | null = headings[0].id;
  for (const h of headings) {
    if (h.getBoundingClientRect().top <= line) active = h.id;
    else break;
  }
  setActiveHeading(path, active);
}

function findDocSurfaces(path: string): { scroller: HTMLDivElement | null; content: HTMLElement | null } {
  const content = document.querySelector<HTMLElement>(
    `.doc-content[data-path="${CSS.escape(path)}"]`,
  );
  const scroller = (content?.closest(".doc-scroll") as HTMLDivElement | null) ?? null;
  return { scroller, content };
}

function scrollToEl(scroller: HTMLDivElement, el: HTMLElement, smooth: boolean) {
  scroller.scrollTo({
    top:
      el.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      24,
    behavior: smooth ? "smooth" : "auto",
  });
}

/** 解析 comrak 的 data-sourcepos="起始行:列-结束行:列"，返回 [起始行, 结束行] */
function sourceposRange(el: HTMLElement): [number, number] | null {
  const sp = el.getAttribute("data-sourcepos");
  if (!sp) return null;
  const m = /^(\d+):\d+-(\d+):\d+$/.exec(sp);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}

/** 在已挂载 DOM 中找覆盖目标源码行的最深块 */
function findBlockAtLine(content: HTMLElement, line: number): HTMLElement | null {
  const blocks = content.querySelectorAll<HTMLElement>("[data-sourcepos]");
  let best: HTMLElement | null = null;
  let bestDepth = -1;
  for (const el of blocks) {
    const range = sourceposRange(el);
    if (!range) continue;
    if (line < range[0] || line > range[1]) continue;
    let depth = 0;
    let p: HTMLElement | null = el;
    while (p && p !== content) {
      depth++;
      p = p.parentElement;
    }
    if (depth > bestDepth) {
      best = el;
      bestDepth = depth;
    }
  }
  return best;
}

/** 统计一个 HTML chunk 对应的源码行跨度：取其中最大的 sourcepos 结束行 */
function countSourceLines(chunkHtml: string): number {
  let max = 0;
  const re = /data-sourcepos="\d+:\d+-(\d+):\d+"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunkHtml)) !== null) {
    const end = parseInt(m[1], 10);
    if (end > max) max = end;
  }
  return max;
}

/** 高亮闪烁并居中显示；同时挂常驻淡底标记直到下次跳转 */
function flashAndCenter(scroller: HTMLDivElement, el: HTMLElement) {
  const top =
    el.getBoundingClientRect().top -
    scroller.getBoundingClientRect().top +
    scroller.scrollTop -
    scroller.clientHeight / 2 +
    el.offsetHeight / 2;
  scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  const content = el.closest(".doc-content");
  content?.querySelectorAll(".search-hit").forEach((n) => {
    n.classList.remove("search-hit");
    n.classList.remove("search-flash");
  });
  el.classList.remove("search-flash");
  void el.offsetWidth;
  el.classList.add("search-hit");
  el.classList.add("search-flash");
}

/** 跳转锚点：元素未挂载时按 chunk 定位再精确校正 */
function jumpToAnchor(path: string, anchor: string) {
  const { scroller, content } = findDocSurfaces(path);
  if (!scroller || !content) return;
  const el = content.querySelector<HTMLElement>(`[id="${CSS.escape(anchor)}"]`);
  if (el) {
    scrollToEl(scroller, el, true);
    return;
  }
  const chunks = chunkHtmlCache.get(path);
  if (!chunks) return;
  const idx = chunks.findIndex((c) => c.includes(`id="${anchor}"`));
  if (idx < 0) return;
  let y = 0;
  for (let i = 0; i < idx; i++) y += Math.max(80, chunks[i].length * ESTIMATE_PX_PER_BYTE);
  scroller.scrollTo({ top: Math.max(0, y - 24), behavior: "smooth" });
  setTimeout(() => {
    const el2 = content.querySelector<HTMLElement>(`[id="${CSS.escape(anchor)}"]`);
    if (el2) scrollToEl(scroller, el2, false);
  }, 240);
}

/** 搜索跳转：按源码行精确定位并闪烁高亮对应块 */
function jumpToText(path: string, text: string, line?: number) {
  const { scroller, content } = findDocSurfaces(path);
  if (!scroller || !content) return;
  if (line && line > 0) {
    const byLine = findBlockAtLine(content, line);
    if (byLine) {
      flashAndCenter(scroller, byLine);
      return;
    }
    // 目标行在未挂载 chunk：按该行所在 chunk 估算滚动，挂载后递归精确定位
    const chunks = chunkHtmlCache.get(path);
    if (chunks) {
      let saw = 0;
      let total = 0;
      for (let i = 0; i < chunks.length; i++) {
        saw += countSourceLines(chunks[i]);
        total += Math.max(80, chunks[i].length * ESTIMATE_PX_PER_BYTE);
        if (saw >= line) {
          scroller.scrollTo({ top: Math.max(0, total / 2 - scroller.clientHeight / 2), behavior: "smooth" });
          setTimeout(() => jumpToText(path, text, line), 260);
          return;
        }
      }
    }
  }
  // 兜底：按文本片段模糊匹配
  const needle = text.replace(/^[…]+/, "").trim();
  if (needle.length < 4) return;
  const candidates = content.querySelectorAll<HTMLElement>(
    "p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, dd, dt",
  );
  for (const el of candidates) {
    if ((el.textContent ?? "").includes(needle)) {
      flashAndCenter(scroller, el);
      return;
    }
  }
  const chunks = chunkHtmlCache.get(path);
  if (!chunks) return;
  const plain = needle.slice(0, 24);
  const idx = chunks.findIndex((c) => c.includes(plain));
  if (idx < 0) return;
  let y = 0;
  for (let i = 0; i < idx; i++)
    y += Math.max(80, chunks[i].length * ESTIMATE_PX_PER_BYTE);
  scroller.scrollTo({ top: Math.max(0, y - 24) });
  setTimeout(() => jumpToText(path, text, line), 260);
}
