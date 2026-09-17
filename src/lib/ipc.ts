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

export const api = {
  readMarkdown: (path: string) => invoke<DocPayload>("read_markdown", { path }),
  listDir: (path: string) => invoke<FileEntry[]>("fs_list_dir", { path }),
  pickFolder: () => invoke<string | null>("fs_pick_folder"),
  pickMdFile: () => invoke<string | null>("fs_pick_markdown_file"),
  searchFolder: (root: string, query: string) =>
    invoke<SearchOutcome>("search_folder", { root, query }),
  saveSession: (data: string) => invoke<void>("session_save", { data }),
  loadSession: () => invoke<string | null>("session_load"),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  startupMs: () => invoke<number>("startup_ms"),
  perfLog: (label: string, ms: number) =>
    invoke<void>("perf_log", { label, ms }).catch(() => {}),
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
