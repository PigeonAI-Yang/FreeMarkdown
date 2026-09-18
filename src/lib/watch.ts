import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./ipc";

/** Rust 侧广播的外部改动事件 */
export interface FileChangedEvent {
  path: string;
  mtimeMs: number;
  exists: boolean;
}

/**
 * 监听某个文件的外部改动（Rust 侧 notify，见 src-tauri/src/watch.rs）。
 *
 * 引用计数在 Rust 侧维护：同一文件被阅读与编辑面板同时打开时只监听一份。
 * 回调在事件到达时触发，是否刷新/是否算冲突交由调用方按自己持有的 mtime 判断。
 */
export function useFileWatch(
  path: string | null,
  onChanged: (e: FileChangedEvent) => void,
) {
  const cbRef = useRef(onChanged);
  cbRef.current = onChanged;

  useEffect(() => {
    if (!path) return;
    let alive = true;
    let unlisten: (() => void) | null = null;
    void api.watchFile(path).catch((e) => console.warn("[watch] 注册失败:", e));
    void listen<FileChangedEvent>("app:file-changed", (event) => {
      const payload = event.payload;
      if (!alive || !payload || payload.path !== path) return;
      cbRef.current(payload);
    }).then((fn) => {
      if (!alive) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      alive = false;
      unlisten?.();
      void api.unwatchFile(path).catch(() => {});
    };
  }, [path]);
}
