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

/** 代码块 header 按钮：复制 + 换行切换（MarkdownView 与 EditView 预览共用） */
export function handleCodeBlockClick(target: HTMLElement): boolean {
  const wrapBtn = target.closest(".code-block-wrap");
  if (wrapBtn) {
    const block = wrapBtn.closest(".code-block");
    block?.classList.toggle("wrapped");
    return true;
  }
  const copyBtn = target.closest(".code-block-copy");
  if (!copyBtn) return false;
  const pre = copyBtn.closest(".code-block")?.querySelector("pre");
  const text = pre?.textContent ?? "";
  if (!text) return true;
  void navigator.clipboard.writeText(text).then(() => {
    copyBtn.classList.add("copied");
    const label = copyBtn.querySelector("span");
    if (label) {
      const prev = label.textContent;
      label.textContent = "已复制";
      setTimeout(() => {
        label.textContent = prev;
        copyBtn.classList.remove("copied");
      }, 1600);
    }
  });
  return true;
}

/** 代码块包裹：给 pre 套 .code-block，顶部加语言标签 + 换行/复制按钮 */
function wrapCodeBlock(pre: HTMLElement) {
  if (pre.parentElement?.classList.contains("code-block")) return;
  const code = pre.querySelector("code");
  const lang = code?.className.match(/language-(\S+)/)?.[1] ?? "";

  const wrap = document.createElement("div");
  wrap.className = "code-block";
  if (document.documentElement.dataset.codeWrap === "wrap") {
    wrap.classList.add("wrapped");
  }

  const header = document.createElement("div");
  header.className = "code-block-header";

  const langEl = document.createElement("span");
  langEl.className = "code-block-lang";
  langEl.textContent = lang || "text";
  header.appendChild(langEl);

  const right = document.createElement("div");
  right.className = "code-block-actions";

  const wrapBtn = document.createElement("button");
  wrapBtn.type = "button";
  wrapBtn.className = "code-block-wrap";
  wrapBtn.setAttribute("aria-label", "切换换行");
  wrapBtn.title = "切换换行";
  wrapBtn.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h12M3 18h12"/><path d="M21 12l-3-3v6l3-3z" fill="currentColor" stroke="none"/></svg>';
  right.appendChild(wrapBtn);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "code-block-copy";
  copyBtn.setAttribute("aria-label", "复制代码");
  copyBtn.title = "复制代码";
  copyBtn.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
    '<span>复制</span>';
  right.appendChild(copyBtn);

  header.appendChild(right);
  pre.replaceWith(wrap);
  wrap.appendChild(header);
  wrap.appendChild(pre);
}

/** 代码高亮 + 结构包装：跳过 mermaid / math / 已高亮 */
async function enhanceCode(root: HTMLElement) {
  const blocks = root.querySelectorAll<HTMLElement>(
    "pre code[class*='language-']:not([data-hl-done]):not(.language-mermaid):not(.language-math)",
  );
  // 无语言的 pre 也要包 header，但不高亮（wrapCodeBlock 内部幂等）
  const allPres = root.querySelectorAll<HTMLElement>("pre");
  for (const pre of allPres) wrapCodeBlock(pre);
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

/** mermaid 图表：替换 code.language-mermaid 的 pre 为渲染容器；可强制明暗主题（卡片导出用） */
async function enhanceMermaid(root: HTMLElement, forcedTheme?: "light" | "dark") {
  const blocks = root.querySelectorAll<HTMLElement>(
    "pre code.language-mermaid:not([data-mermaid-done])",
  );
  if (blocks.length === 0) return;
  const mermaid = await loadMermaid();
  const eff = forcedTheme ?? theme();
  if (mermaidInitedTheme !== eff) {
    mermaidInitedTheme = eff;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: eff === "dark" ? "dark" : "default",
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
    // 若已被 wrapCodeBlock 包壳，替换整个外壳；否则替换 pre 本身
    const wrapper = pre.parentElement?.classList.contains("code-block")
      ? pre.parentElement
      : pre;
    wrapper.replaceWith(host);
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
 * opts.mermaidTheme 可强制 mermaid 明暗（卡片导出按模板主题传入）。
 * opts.skipMermaid 用于编辑面板打字期间降级：mermaid 很重，空闲后再用
 * `enhanceMermaidOnly` 补跑。
 * 返回文档是否包含 mermaid（用于提示预加载）。
 */
export async function enhanceChunk(
  root: HTMLElement,
  opts?: { mermaidTheme?: "light" | "dark"; skipMermaid?: boolean },
) {
  root.querySelectorAll("img:not([data-lz])").forEach((img) => {
    img.setAttribute("loading", "lazy");
    img.setAttribute("data-lz", "1");
  });
  await Promise.all([
    enhanceCode(root),
    enhanceMath(root),
    opts?.skipMermaid
      ? Promise.resolve()
      : enhanceMermaid(root, opts?.mermaidTheme),
  ]);
}

/** 仅补跑 mermaid（编辑面板打字空闲后调用） */
export async function enhanceMermaidOnly(
  root: HTMLElement,
  mermaidTheme?: "light" | "dark",
) {
  await enhanceMermaid(root, mermaidTheme);
}

/** 文档级增强入口（与 chunk 相同，预留差异） */
export const enhanceDoc = enhanceChunk;
