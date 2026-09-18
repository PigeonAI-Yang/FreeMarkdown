import { invoke } from "@tauri-apps/api/core";

export interface TocItem {
  level: number;
  text: string;
  id: string;
}

export interface DocPayload {
  chunks: string[];
  totalLen: number;
  toc: TocItem[];
  size: number;
  mtimeMs: number;
  fromCache: boolean;
  parseMs: number;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isMd: boolean;
}

export interface SearchHit {
  path: string;
  line: number;
  snippet: string;
  count: number;
}

export interface SearchOutcome {
  hits: SearchHit[];
  filesScanned: number;
  filesMatched: number;
  elapsedMs: number;
  truncated: boolean;
}

/* ---------- 编辑链路 ---------- */

/** 编辑用原文载荷：text 已把换行规范化为 \n，写回时按 eol / bom 还原 */
export interface SourcePayload {
  text: string;
  mtimeMs: number;
  size: number;
  eol: "lf" | "crlf";
  bom: boolean;
}

/** 单个顶层块：HTML + 它在全文中的行范围 */
export interface BlockHtml {
  html: string;
  startLine: number;
  endLine: number;
}

export interface BlocksPayload {
  blocks: BlockHtml[];
  toc: TocItem[];
  parseMs: number;
}

export interface WriteResult {
  mtimeMs: number;
  bytes: number;
}

export const api = {
  readMarkdown: (path: string) => invoke<DocPayload>("read_markdown", { path }),
  readSource: (path: string) => invoke<SourcePayload>("read_markdown_source", { path }),
  /** 渲染一段 Markdown 文本（内存中）：lineBase = 该切片之前已有多少行；
   *  dropLines = 切片前面挂了多少行上下文前缀（链接引用定义），这些行只参与解析 */
  renderBlocks: (text: string, baseDir: string, lineBase: number, dropLines: number) =>
    invoke<BlocksPayload>("render_markdown_blocks", { text, baseDir, lineBase, dropLines }),
  /** 原子写回；expectMtimeMs 与磁盘不一致时后端返回 "conflict:<当前 mtime>" */
  writeMarkdown: (
    path: string,
    text: string,
    expectMtimeMs: number | null,
    eol: string,
    bom: boolean,
  ) =>
    invoke<WriteResult>("write_markdown", {
      path,
      text,
      expectMtimeMs,
      eol,
      bom,
    }),
  listDir: (path: string) => invoke<FileEntry[]>("fs_list_dir", { path }),
  /* ---------- 外部改动监听（Rust 侧 notify，事件 app:file-changed） ---------- */
  watchFile: (path: string) => invoke<void>("watch_file", { path }),
  unwatchFile: (path: string) => invoke<void>("unwatch_file", { path }),
  watchCount: () => invoke<[number, number]>("watch_count"),
  pickFolder: () => invoke<string | null>("fs_pick_folder"),
  pickMdFile: () => invoke<string | null>("fs_pick_markdown_file"),
  pickMdSavePath: (defaultName: string) =>
    invoke<string | null>("fs_pick_markdown_save_path", { defaultName }),
  searchFolder: (root: string, query: string) =>
    invoke<SearchOutcome>("search_folder", { root, query }),
  saveSession: (data: string) => invoke<void>("session_save", { data }),
  loadSession: () => invoke<string | null>("session_load"),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  reveal: (path: string) => invoke<void>("fs_reveal", { path }),
  startupMs: () => invoke<number>("startup_ms"),
  perfLog: (label: string, ms: number) =>
    invoke<void>("perf_log", { label, ms }).catch(() => {}),
  /* ---------- 卡片导出 ---------- */
  cardPickSavePath: (defaultName: string, format: string) =>
    invoke<string | null>("card_pick_save_path", { defaultName, format }),
  cardWriteFile: (path: string, dataB64: string) =>
    invoke<number>("card_write_file", { path, dataB64 }),
  cardClipboardWritePng: (dataB64: string) =>
    invoke<[number, number]>("card_clipboard_write_png", { dataB64 }),
};

export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(i + 1) : p;
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : p;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// 仅开发环境：暴露真实 IPC 封装，供 CDP 验收探针直接驱动命令（如 read_markdown / write_markdown）
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__fmIpc = api;
}
