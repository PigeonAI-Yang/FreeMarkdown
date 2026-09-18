import { api, type TocItem } from "../lib/ipc";
import {
  NO_FLAGS,
  planEdit,
  scanDocFlags,
  type DocFlags,
  type EditPlan,
  type PreviewBlock,
} from "./previewModel";

/** 打字防抖：与验收口径（单键 → 预览更新 ≤150ms）配套，取值留出 IPC 往返余量 */
export const DEBOUNCE_MS = 90;

export interface PreviewUpdate {
  blocks: PreviewBlock[];
  /** 本次内容发生变化的块范围（DOM 侧据此只扫这一段）；整篇替换时为 null */
  splice: { lo: number; hi: number } | null;
  toc?: TocItem[];
}

export interface PreviewMetrics {
  /** 按键 → 预览块更新完成（ms），每次「防抖触发的那次按键」记一条 */
  keystrokes: number[];
  /** 单次「按键触发的切片」IPC 请求字节数（不含整篇渲染，用于 32KB 口径） */
  payloads: number[];
  /** Rust 侧 parse_ms */
  parseMs: number[];
  splices: number;
  fullRenders: number;
  blockCount: number;
  /** 打开时的整篇文本字节（不计入单键载荷口径） */
  openTextBytes: number;
  /** 整篇兜底渲染的文本字节（脚注文档 / 跨度过大时才会出现） */
  fullTextBytes: number[];
  /** 打开文档到块可用的总耗时（含解析 + IPC） */
  openMs: number;
}

export function newMetrics(): PreviewMetrics {
  return {
    keystrokes: [],
    payloads: [],
    parseMs: [],
    splices: 0,
    fullRenders: 0,
    blockCount: 0,
    openTextBytes: 0,
    fullTextBytes: [],
    openMs: 0,
  };
}

export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const s = [...samples].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, i)];
}

/**
 * 预览控制器：持有块列表与文本快照，负责「按键 → 防抖 → 切片重渲染 → 通知 DOM 侧」。
 * 串行化：同时只允许一个渲染在飞，期间的按键合并成一次补跑（不丢最后一次）。
 */
export class PreviewController {
  blocks: PreviewBlock[] = [];
  flags: DocFlags = NO_FLAGS;
  readonly metrics = newMetrics();

  private text = "";
  private baseDir = "";
  private path = "";
  private rev = 0;
  private timer: number | null = null;
  private pendingText: string | null = null;
  private inFlight = false;
  private lastKeyAt = 0;
  private pendingSample: number | null = null;
  private disposed = false;
  private onUpdate: (u: PreviewUpdate) => void;
  private getText: () => string;

  constructor(opts: { onUpdate: (u: PreviewUpdate) => void; getText: () => string }) {
    this.onUpdate = opts.onUpdate;
    this.getText = opts.getText;
  }

  dispose() {
    this.disposed = true;
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
    this.pendingText = null;
  }

  /** 打开文档：整篇渲染一次，得到块列表与目录 */
  async load(path: string, text: string, baseDir: string): Promise<TocItem[]> {
    this.path = path;
    this.baseDir = baseDir;
    this.text = text;
    this.flags = scanDocFlags(text);
    const t0 = performance.now();
    const res = await api.renderBlocks(text, baseDir, 0, 0);
    this.metrics.openTextBytes = text.length;
    this.metrics.parseMs.push(res.parseMs);
    this.metrics.fullRenders++;
    this.blocks = res.blocks.map((b) => ({
      html: b.html,
      startLine: b.startLine,
      endLine: b.endLine,
      rev: ++this.rev,
    }));
    this.metrics.blockCount = this.blocks.length;
    this.metrics.openMs = performance.now() - t0;
    this.onUpdate({ blocks: this.blocks, splice: null, toc: res.toc });
    return res.toc;
  }

  /** 编辑器每次文档变化都调用（内部防抖；文本在触发时才向编辑器取，避免每次按键都拍平 rope） */
  ingest() {
    if (this.disposed) return;
    this.lastKeyAt = performance.now();
    this.pendingText = "__pending__";
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, DEBOUNCE_MS);
  }

  /** DOM 侧写入完成后调用，用于统计「按键 → 预览更新完成」延迟 */
  noteRendered() {
    if (this.pendingSample == null) return;
    this.metrics.keystrokes.push(performance.now() - this.pendingSample);
    this.pendingSample = null;
  }

  /** 立即同步（保存前 / 冻结前调用，保证预览与文本一致） */
  async syncNow(): Promise<void> {
    if (this.pendingText == null) this.pendingText = "__pending__";
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.pendingText == null || this.disposed) return;
    if (this.inFlight) return; // 结束后由 finally 里的补跑处理
    this.pendingText = null;
    this.inFlight = true;
    try {
      const text = this.getText();
      const plan = planEdit(this.text, text, this.blocks);
      if (plan.mode !== "none") {
        if (plan.mode === "full" || this.flags.hasFootnotes) await this.fullRender(text);
        else await this.splice(text, plan);
        // 延迟采样在 DOM 写入后由 noteRendered() 落账
        this.pendingSample = this.lastKeyAt || null;
      }
    } catch (e) {
      console.warn("[edit] 预览更新失败:", e);
    } finally {
      this.inFlight = false;
      if (!this.disposed && this.pendingText != null) void this.flush();
    }
  }

  /** 切片重渲染：只把受影响的块发给 Rust */
  private async splice(text: string, plan: EditPlan) {
    const useDefs = this.flags.hasRefDefs;
    const prefix = useDefs ? this.flags.refDefsText : "";
    const drop = useDefs ? this.flags.refDefsLines : 0;
    const payload = prefix + text.slice(plan.sliceStart, plan.sliceEnd);
    this.metrics.payloads.push(payload.length);
    const res = await api.renderBlocks(
      payload,
      this.baseDir,
      plan.sliceStartLine - 1,
      drop,
    );
    this.metrics.parseMs.push(res.parseMs);
    // 切片边界与 comrak 的块边界对不上（跨块结构边界情况）：退回整篇重渲染保证正确
    if (res.blocks.length > 0 && res.blocks[0].startLine !== plan.sliceStartLine) {
      await this.fullRender(text);
      return;
    }
    const fresh: PreviewBlock[] = res.blocks.map((b) => ({
      html: b.html,
      startLine: b.startLine,
      endLine: b.endLine,
      rev: ++this.rev,
    }));
    const delta = plan.sliceLineDelta;
    const tail = this.blocks.slice(plan.hi + 1).map((b) => ({
      ...b,
      startLine: b.startLine + delta,
      endLine: b.endLine + delta,
    }));
    this.blocks = [...this.blocks.slice(0, plan.lo), ...fresh, ...tail];
    this.text = text;
    this.metrics.splices++;
    this.metrics.blockCount = this.blocks.length;
    this.onUpdate({
      blocks: this.blocks,
      splice: { lo: plan.lo, hi: plan.lo + fresh.length - 1 },
    });
  }

  /** 整篇重渲染（脚注文档 / 变更跨度过大 / 切片边界对不上时的兜底）。
   *  行范围与 HTML 都没变的块沿用旧 rev，DOM 不重写：滚动位置与选中态不受影响。 */
  private async fullRender(text: string) {
    // 整篇兜底不占「单键载荷」口径，单独记在 fullTextBytes 里
    this.metrics.fullTextBytes.push(text.length);
    const res = await api.renderBlocks(text, this.baseDir, 0, 0);
    this.metrics.parseMs.push(res.parseMs);
    this.metrics.fullRenders++;
    const oldByKey = new Map<string, PreviewBlock>();
    for (const b of this.blocks) oldByKey.set(`${b.startLine}:${b.endLine}`, b);
    this.blocks = res.blocks.map((b) => {
      const old = oldByKey.get(`${b.startLine}:${b.endLine}`);
      return {
        html: b.html,
        startLine: b.startLine,
        endLine: b.endLine,
        rev: old && old.html === b.html ? old.rev : ++this.rev,
      };
    });
    this.text = text;
    this.flags = scanDocFlags(text);
    this.metrics.blockCount = this.blocks.length;
    this.onUpdate({ blocks: this.blocks, splice: null, toc: res.toc });
  }

  /** 保存后刷新目录（客户端从块 HTML 里抽取，避免再解析一遍整篇） */
  refreshToc() {
    const toc = extractTocFromBlocks(this.blocks);
    this.onUpdate({ blocks: this.blocks, splice: null, toc });
    return toc;
  }
}

/* ---------- 目录抽取：与 Rust 的 extract_toc 同口径 ---------- */

const H_RE = /<h([1-6])\b[^>]*\bid="([^"]*)"[^>]*>([\s\S]*?)<\/h[1-6]>/g;
const TAG_RE = /<[^>]+>/g;

export function extractTocFromBlocks(blocks: PreviewBlock[]): TocItem[] {
  const out: TocItem[] = [];
  for (const b of blocks) {
    if (b.html.indexOf("<h") < 0) continue;
    H_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = H_RE.exec(b.html)) !== null) {
      out.push({
        level: Number(m[1]),
        id: m[2],
        text: decodeEntities(m[3].replace(TAG_RE, "").trim()),
      });
    }
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}
