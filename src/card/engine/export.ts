import { invoke } from "@tauri-apps/api/core";
import { api } from "../../lib/ipc";
import { captureElement } from "./rasterize";
import type { ExportFormat } from "../templates/types";

/**
 * 导出出口层：把栅格化字节写到「文件」或「剪贴板」。
 *
 * 性能红线：逐张顺序捕获，位图字节即用即弃（captureElement 返回后由调用点
 * 立即转 base64 写盘，无模块级缓存）；全程不经过 dataURL 中转。
 */

/** 导出进度（批量拆卡时 done 从 0 递增到 total） */
export interface ExportProgress {
  done: number;
  total: number;
  label: string;
}

export interface CardExportOpts {
  /** 导出捕获根（含外壳/模板/水印的整卡，即 CardPanel 的 card-root 元素） */
  rootEl: HTMLElement;
  /** 目标缩放（内部先 resolveScale 防爆，实际值以 RasterResult 为准） */
  scale: number;
  format: ExportFormat;
  jpegQuality: number;
  /** 卡外底色（模板 shellBg），jpeg 无 alpha 时也作补底 */
  backgroundColor?: string;
  /** 文件名基（不含扩展名） */
  docBaseName: string;
  /** 1 = 单卡/长图；>1 = 批量拆卡 */
  cardCount: number;
  onProgress?: (p: ExportProgress) => void;
  /** 批量导出前切换视口到第 i 卡（CardPanel 用命令式 DOM 操作实现） */
  prepareCard?: (index: number) => Promise<void>;
  /** 结束后恢复预览 */
  restore?: () => void;
}

/**
 * Uint8Array → base64。
 * 用 0x8000 分块 String.fromCharCode，避免超长数组一次性展开触发
 * Function.prototype.apply 的参数栈上限溢出。
 */
function u8ToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** 目录与文件名拼接（Windows / Unix 分隔符均兼容） */
function joinPath(dir: string, name: string): string {
  return /[\\/]$/.test(dir) ? dir + name : `${dir}/${name}`;
}

/** 单次捕获 + 耗时上报（perfLog 自身吞错，不影响导出流程） */
async function captureCard(o: CardExportOpts) {
  const t0 = performance.now();
  const r = await captureElement(o.rootEl, {
    scale: o.scale,
    format: o.format,
    jpegQuality: o.jpegQuality,
    backgroundColor: o.backgroundColor,
  });
  void api.perfLog("card-capture", Math.round(performance.now() - t0));
  return r;
}

/**
 * 出口一：保存到磁盘。
 * - 单卡/长图：系统另存为对话框选单个文件路径后一次性写盘；
 * - 拆卡：先选目标文件夹，再逐张 prepareCard → 捕获 → 写盘，
 *   每张之间让出事件循环以便进度刷新；结束后 restore 恢复预览。
 * 取消（对话框返回 null）不算失败，以 ok:false + 「已取消」表达。
 */
export async function exportSave(
  o: CardExportOpts,
): Promise<{ ok: boolean; saved: number; message?: string }> {
  const ext = o.format === "jpeg" ? "jpeg" : "png";
  try {
    if (o.cardCount <= 1) {
      const path = await invoke<string | null>("card_pick_save_path", {
        defaultName: `${o.docBaseName}.${ext}`,
        format: o.format,
      });
      if (!path) {
        return { ok: false, saved: 0, message: "已取消" };
      }
      o.onProgress?.({ done: 0, total: 1, label: "正在生成图片…" });
      const r = await captureCard(o);
      await invoke<void>("card_write_file", {
        path,
        data_b64: u8ToBase64(r.bytes),
      });
      o.onProgress?.({ done: 1, total: 1, label: "完成" });
      return { ok: true, saved: 1, message: path };
    }

    const folder = await api.pickFolder();
    if (!folder) {
      return { ok: false, saved: 0, message: "已取消" };
    }
    let saved = 0;
    for (let i = 0; i < o.cardCount; i++) {
      o.onProgress?.({
        done: i,
        total: o.cardCount,
        label: `正在生成第 ${i + 1} 张…`,
      });
      await o.prepareCard?.(i);
      const r = await captureCard(o);
      await invoke<void>("card_write_file", {
        path: joinPath(
          folder,
          `${o.docBaseName}-${String(i + 1).padStart(2, "0")}.${ext}`,
        ),
        data_b64: u8ToBase64(r.bytes),
      });
      saved += 1;
      // 让出事件循环，让进度文本真正刷到界面上
      await new Promise((r2) => setTimeout(r2, 0));
    }
    await o.restore?.();
    return { ok: true, saved, message: folder };
  } catch (e) {
    // 半途失败也要把预览恢复到用户离开时的状态
    await o.restore?.();
    return { ok: false, saved: 0, message: String(e) };
  }
}

/**
 * 出口二：复制到剪贴板。
 * 始终按 PNG 捕获（系统剪贴板位图通道没有 jpeg 语义，转有损格式无意义）；
 * 拆卡模式下复制的即当前预览呈现的那张卡（rootEl 原样捕获，不做翻页）。
 */
export async function exportClipboard(
  o: CardExportOpts,
): Promise<{ ok: boolean; message?: string }> {
  try {
    const r = await captureElement(o.rootEl, {
      scale: o.scale,
      format: "png",
      backgroundColor: o.backgroundColor,
    });
    await invoke<void>("card_clipboard_write_png", {
      data_b64: u8ToBase64(r.bytes),
    });
    return { ok: true, message: "已复制到剪贴板" };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}
