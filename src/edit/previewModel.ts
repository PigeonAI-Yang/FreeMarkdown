/**
 * 块级增量预览的纯逻辑：文本差异 → 受影响的顶层块范围 → 送给 Rust 的切片范围。
 *
 * 与 DOM / IPC 无关，便于单测、也能在控制台里用真实数据复算。
 * 设计口径（见 docs/编辑功能方案.md 风险 3）：宁可多解析一块，不可渲染错，
 * 所以块范围向两侧各扩一块，变更跨度过大时直接退回整篇重渲染。
 */

export interface PreviewBlock {
  html: string;
  /** 全文坐标（1-based，含） */
  startLine: number;
  /** 全文坐标（1-based，含） */
  endLine: number;
  /** 内容版本号：DOM 注入侧靠它判断某块是否需要重写 innerHTML */
  rev: number;
}

export interface EditPlan {
  /** none = 文本没变；splice = 只重渲染 [lo, hi]；full = 整篇重渲染 */
  mode: "none" | "splice" | "full";
  /** 受影响块下标范围（splice 有效） */
  lo: number;
  hi: number;
  /** 发给 Rust 的切片（新文本坐标） */
  sliceStart: number;
  sliceEnd: number;
  /** 切片首行的全文行号（1-based） */
  sliceStartLine: number;
  /** 新块替换后，其后所有块的行号需要平移多少 */
  sliceLineDelta: number;
  /** 变更覆盖的旧文本行范围（诊断用） */
  oldFromLine: number;
  oldToLine: number;
}

/** 单次切片重渲染的行数上限，超过就整篇重渲染 */
export const MAX_SPLICE_LINES = 4000;
/** 单次切片重渲染的字节上限 */
export const MAX_SPLICE_BYTES = 512 * 1024;

const CHUNK = 1024;

/** 公共前缀长度（按 1KB 分块比对，避免 2MB 文档逐字符扫描） */
export function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i + CHUNK <= n && a.slice(i, i + CHUNK) === b.slice(i, i + CHUNK)) i += CHUNK;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** 公共后缀长度（不与前缀重叠） */
export function commonSuffixLen(a: string, b: string, minStart = 0): number {
  const max = Math.min(a.length, b.length) - minStart;
  let i = 0;
  while (
    i + CHUNK <= max &&
    a.slice(a.length - i - CHUNK, a.length - i) ===
      b.slice(b.length - i - CHUNK, b.length - i)
  ) {
    i += CHUNK;
  }
  while (
    i < max &&
    a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)
  ) {
    i++;
  }
  return i;
}

/**
 * 行号索引：按需构建一次，之后行号 ↔ 偏移都是 O(log n)。
 * 只认 `\n`（编辑器缓冲区已把换行规范化为 LF）。
 */
export class LineIndex {
  private starts: number[] | null = null;

  constructor(private text: string) {}

  private build(): number[] {
    if (this.starts) return this.starts;
    const t = this.text;
    const s: number[] = [0];
    for (let i = 0; i < t.length; i++) {
      if (t.charCodeAt(i) === 10) s.push(i + 1);
    }
    s.push(t.length); // 哨兵：starts[行数] = 文本长度
    this.starts = s;
    return s;
  }

  get lineCount(): number {
    return this.build().length - 1;
  }

  /** 偏移 → 1-based 行号 */
  lineOf(offset: number): number {
    const s = this.build();
    if (offset <= 0) return 1;
    if (offset >= this.text.length) return Math.max(1, s.length - 1);
    let lo = 0;
    let hi = s.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid] <= offset) lo = mid;
      else hi = mid;
    }
    return lo + 1;
  }

  /** 1-based 行号 → 行首偏移 */
  lineStart(line: number): number {
    const s = this.build();
    const i = Math.min(Math.max(1, line), s.length - 1) - 1;
    return s[i];
  }

  /** 1-based 行号 → 行尾偏移（独占，不含换行符） */
  lineEnd(line: number): number {
    const s = this.build();
    const count = s.length - 1;
    if (line >= count) return this.text.length;
    const i = Math.min(Math.max(1, line), count) - 1;
    return s[i + 1] - 1;
  }
}

/** 最后一个 startLine ≤ line 的块；line 在首块之前时返回 0 */
export function blockAtOrBefore(blocks: PreviewBlock[], line: number): number {
  if (blocks.length === 0) return -1;
  if (line < blocks[0].startLine) return 0;
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (blocks[mid].startLine <= line) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 计算本次文本变化的切片方案 */
export function planEdit(
  oldText: string,
  newText: string,
  blocks: PreviewBlock[],
): EditPlan {
  const none: EditPlan = {
    mode: "none",
    lo: 0,
    hi: -1,
    sliceStart: 0,
    sliceEnd: 0,
    sliceStartLine: 1,
    sliceLineDelta: 0,
    oldFromLine: 1,
    oldToLine: 1,
  };
  if (oldText === newText) return none;
  if (blocks.length === 0) return { ...none, mode: "full" };

  const p = commonPrefixLen(oldText, newText);
  const s = commonSuffixLen(oldText, newText, p);
  const oldFrom = p;
  const oldTo = Math.max(p, oldText.length - s);
  const newTo = Math.max(p, newText.length - s);
  if (oldFrom === oldTo && p === newTo) return none;

  const oldIdx = new LineIndex(oldText);
  const newIdx = new LineIndex(newText);
  const oldFromLine = oldIdx.lineOf(oldFrom);
  const oldToLine = oldIdx.lineOf(oldTo);

  const k1 = blockAtOrBefore(blocks, oldFromLine);
  const k2 = blockAtOrBefore(blocks, oldToLine);
  // 向两侧各扩一块：跨块结构（段落合并、setext 标题、列表与代码块边界）必须一起重解析
  const lo = Math.max(0, k1 - 1);
  const hi = Math.min(blocks.length - 1, k2 + 1);

  const sliceStart = oldIdx.lineStart(blocks[lo].startLine);
  const endRaw = oldIdx.lineEnd(blocks[hi].endLine) + (newText.length - oldText.length);
  const sliceEnd = Math.min(newText.length, Math.max(sliceStart, endRaw));
  const sliceStartLine = newIdx.lineOf(sliceStart);
  const sliceEndLine = newIdx.lineOf(sliceEnd);
  const sliceLineDelta = sliceEndLine - blocks[hi].endLine;

  const spanLines = oldToLine - oldFromLine + 1;
  if (spanLines > MAX_SPLICE_LINES || sliceEnd - sliceStart > MAX_SPLICE_BYTES) {
    return { ...none, mode: "full", oldFromLine, oldToLine };
  }
  return {
    mode: "splice",
    lo,
    hi,
    sliceStart,
    sliceEnd,
    sliceStartLine,
    sliceLineDelta: sliceLineDelta,
    oldFromLine,
    oldToLine,
  };
}

/* ---------- 文档级定义扫描（引用定义 / 脚注） ---------- */

export interface DocFlags {
  /** 含链接引用定义 `[id]: url`（切片渲染需带上它们，否则引用解析不出来） */
  hasRefDefs: boolean;
  /** 含脚注定义 `[^id]: …`：脚注编号依赖全文顺序，切片渲染会失真 → 整篇重渲染 */
  hasFootnotes: boolean;
  /** 链接引用定义原文（含缩进续行），作为切片前缀 */
  refDefsText: string;
  refDefsLines: number;
}

export const NO_FLAGS: DocFlags = {
  hasRefDefs: false,
  hasFootnotes: false,
  refDefsText: "",
  refDefsLines: 0,
};

const REFDEF_RE = /^ {0,3}\[(?!\^)[^\]]+\]:/;
const FOOTNOTE_RE = /^ {0,3}\[\^[^\]]*\]:/;

/**
 * 扫描全文找出引用定义（含其缩进续行）与脚注定义。
 * 只在文本里真的出现 "]:" / "[^" 时才做正则扫描，常规打字代价为 0。
 */
export function scanDocFlags(text: string): DocFlags {
  const maybeFoot = text.includes("[^");
  const maybeRef = text.includes("]:");
  if (!maybeFoot && !maybeRef) return NO_FLAGS;
  const lines = text.split("\n");
  const defs: string[] = [];
  let hasFoot = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (maybeFoot && FOOTNOTE_RE.test(l)) {
      // 脚注定义按其块整体收集（缩进续行）
      hasFoot = true;
      continue;
    }
    if (maybeRef && REFDEF_RE.test(l)) {
      defs.push(l);
      // 续行：紧跟其后的缩进非空行属于同一个定义
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) {
        i++;
        defs.push(lines[i]);
      }
    }
  }
  if (hasFoot) return { ...NO_FLAGS, hasFootnotes: true };
  if (defs.length === 0) return NO_FLAGS;
  const defText = `${defs.join("\n")}\n\n`;
  return {
    hasRefDefs: true,
    hasFootnotes: false,
    refDefsText: defText,
    // 前缀行数 = 换行数（末尾的 \n\n 让定义块与切片内容分开）
    refDefsLines: defText.length - defText.replace(/\n/g, "").length,
  };
}
