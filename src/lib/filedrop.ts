import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./ipc";
import { dockRef, openFile, type OpenTarget } from "./store";

interface FileOpenResolved {
  paths: string[];
  error?: string | null;
  target?: { groupId?: string | null; zone?: string | null };
}

function isMd(path: string) {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

const pendingOpenFiles: Array<{ path: string; target?: OpenTarget }> = [];

function queueOpen(path: string, target?: OpenTarget) {
  pendingOpenFiles.push({ path, target });
  flushPendingOpenFiles();
}

export function flushPendingOpenFiles() {
  if (!dockRef.api) return;
  for (const { path, target } of pendingOpenFiles.splice(0)) {
    openFile(path, undefined, target);
  }
}

/**
 * Windows 文件打开桥接：监听 `app:file-open-resolved`（Rust filedrop
 * 从 ICoreWebView2File::Path 取到真实路径后发出），用现有 openFile 打开。
 */
export function useFileOpenBridge() {
  useEffect(() => {
    let alive = true;
    const unlisteners: Array<() => void> = [];
    let draining = Promise.resolve();
    const drainOpenRequests = () => {
      draining = draining.then(async () => {
        const paths = await api.takeOpenFileRequests();
        for (const path of paths) {
          if (isMd(path)) queueOpen(path);
          else console.warn("[fileopen] 不支持的文件类型:", path);
        }
      }).catch((error) => console.warn("[fileopen] 打开请求读取失败:", error));
    };

    const resolved = listen<FileOpenResolved>("app:file-open-resolved", (event) => {
      const { paths, error, target } = event.payload;
      if (error) {
        console.warn("[fileopen]", error);
        return;
      }
      const openTarget = target
        ? {
            groupId: target.groupId ?? undefined,
            direction:
              target.zone && target.zone !== "center"
                ? ((target.zone === "top" ? "above" : target.zone) as
                    | "left"
                    | "right"
                    | "above"
                    | "below")
                : undefined,
          }
        : undefined;
      for (const p of paths) {
        if (isMd(p)) {
          queueOpen(p, openTarget);
        } else {
          console.warn("[fileopen] 不支持的文件类型:", p);
        }
      }
    });
    const requested = listen("app:open-file-requests", drainOpenRequests);
    void Promise.all([resolved, requested]).then((fns) => {
      if (!alive) {
        fns.forEach((fn) => fn());
        return;
      }
      unlisteners.push(...fns);
      drainOpenRequests();
    }).catch((error) => console.warn("[fileopen] 事件监听注册失败:", error));

    return () => {
      alive = false;
      unlisteners.forEach((fn) => fn());
    };
  }, []);
}
