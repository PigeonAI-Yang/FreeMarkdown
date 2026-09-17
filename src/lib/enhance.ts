/// <reference types="vite/client" />

/** 动态依赖的懒加载单例（保持首屏 bundle 精简） */
let hljsPromise: Promise<typeof import("highlight.js").default> | null = null;
function loadHljs() {
  hljsPromise ??= import("highlight.js/lib/common").then((m) => m.default);
  return hljsPromise;
}

let katexPromise: Promise<typeof import("katex")> | null = null;
function loadKatex() {
  katexPromise ??= import("katex");
  return katexPromise;
}

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  mermaidPromise ??= import("mermaid").then((m) => m.default);
  return mermaidPromise;
}

const MAX_HL_BYTES = 100_000; // 单个代码块超此大小不高亮，避免卡顿

function theme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** 代码高亮：跳过 mermaid / math / 已高亮 */
async function enhanceCode(root: HTMLElement) {
  const blocks = root.querySelectorAll<HTMLElement>(
    "pre code[class*='language-']:not([data-hl-done]):not(.language-mermaid):not(.language-math)",
  );
  if (blocks.length === 0) return;
  const hljs = await loadHljs();
  for (const el of blocks) {
    if (el.dataset.hlDone) continue;
    el.dataset.hlDone = "1";
    if (el.textContent && el.textContent.length > MAX_HL_BYTES) continue;
    try {
      hljs.highlightElement(el);
    } catch {
      // 高亮失败保留原文
    }
  }
}

/** 数学公式：comrak 输出 <span data-math-style="inline|display">tex</span> */
async function enhanceMath(root: HTMLElement) {
  const nodes = root.querySelectorAll<HTMLElement>(
    "[data-math-style]:not([data-katex-done])",
  );
  if (nodes.length === 0) return;
  const katex = await loadKatex();
  for (const el of nodes) {
    el.dataset.katexDone = "1";
    const display = el.dataset.mathStyle === "display";
    try {
      el.innerHTML = katex.renderToString(el.textContent ?? "", {
        displayMode: display,
        throwOnError: false,
        strict: false,
      });
    } catch {
      // 保留原文
    }
  }
}

let mermaidSeq = 0;
let mermaidInitedTheme: string | null = null;

/** mermaid 图表：替换 code.language-mermaid 的 pre 为渲染容器 */
async function enhanceMermaid(root: HTMLElement) {
  const blocks = root.querySelectorAll<HTMLElement>(
    "pre code.language-mermaid:not([data-mermaid-done])",
  );
  if (blocks.length === 0) return;
  const mermaid = await loadMermaid();
  if (mermaidInitedTheme !== theme()) {
    mermaidInitedTheme = theme();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme() === "dark" ? "dark" : "default",
      fontFamily: getComputedStyle(document.body).fontFamily,
    });
  }
  for (const code of blocks) {
    code.dataset.mermaidDone = "1";
    const pre = code.parentElement;
    if (!pre) continue;
    const host = document.createElement("div");
    host.className = "mermaid-host";
    const src = code.textContent ?? "";
    pre.replaceWith(host);
    try {
      const { svg } = await mermaid.render(`mmd-${++mermaidSeq}`, src);
      host.innerHTML = svg;
    } catch (e) {
      host.innerHTML = "";
      const err = document.createElement("div");
      err.className = "mermaid-error";
      err.textContent = `mermaid 图表渲染失败：${String(e).slice(0, 200)}`;
      host.appendChild(err);
    }
  }
}

/**
 * 注入 HTML 后的增强（幂等）：高亮、公式、图表。
 * 返回文档是否包含 mermaid（用于提示预加载）。
 */
export async function enhanceChunk(root: HTMLElement) {
  root.querySelectorAll("img:not([data-lz])").forEach((img) => {
    img.setAttribute("loading", "lazy");
    img.setAttribute("data-lz", "1");
  });
  await Promise.all([
    enhanceCode(root),
    enhanceMath(root),
    enhanceMermaid(root),
  ]);
}

/** 文档级增强入口（与 chunk 相同，预留差异） */
export const enhanceDoc = enhanceChunk;
