import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { dockRef, openFile } from "../lib/store";

interface FileOpenResolved {
  paths: string[];
  error?: string | null;
  target?: { groupId?: string | null; zone?: string | null };
}

function isMd(path: string) {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/**
 * Windows 文件打开桥接：监听 `app:file-open-resolved`（Rust filedrop
 * 从 ICoreWebView2File::Path 取到真实路径后发出），用现有 openFile 打开。
 */
export function useFileOpenBridge() {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<FileOpenResolved>("app:file-open-resolved", (event) => {
      const { paths, error, target } = event.payload;
      if (error) {
        console.warn("[fileopen]", error);
        return;
      }
      // 落点分组：drop 时 dockview 给出的分组；边缘 zone 转方向
      const api = dockRef.api;
      const refGroup = target?.groupId
        ? api?.groups.find((g) => g.id === target.groupId)
        : undefined;
      const zone = target?.zone;
      const direction =
        zone && zone !== "center"
          ? ((zone === "top" ? "above" : zone) as
              | "left"
              | "right"
              | "above"
              | "below")
          : undefined;
      for (const p of paths) {
        if (isMd(p)) {
          openFile(p, undefined, {
            groupId: refGroup?.id,
            direction,
          });
        } else {
          console.warn("[fileopen] 不支持的文件类型:", p);
        }
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);
}
