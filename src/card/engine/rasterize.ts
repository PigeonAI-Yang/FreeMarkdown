import { snapdom } from "@zumer/snapdom";
import type { ExportFormat } from "../templates/types";

/**
 * 栅格化引擎：把卡片 DOM 元素栅格化为 PNG/JPEG 位图字节。
 *
 * 性能决策：走 snapdom 的 foreignObject 路线（把带内联样式的克隆 DOM 序列化为
 * SVG <foreignObject>，再由浏览器原生解码渲染到 canvas）。相比逐节点手绘的
 * html2canvas 类方案，文本排版、字体形状、CSS 特性全部由浏览器自身渲染器完成，
 * 还原度高且无需逐属性模拟；本项目的模板也直接复用 .markdown-body 的真实样式。
 */

/** 浏览器画布单边安全上限（保守值，低于各引擎 16384~32767 的硬限制） */
const MAX_SIDE = 16_000;
/** 画布总像素预算（约 8000 万，防止超大面积位图导致 GPU 内存失败） */
const MAX_PIXELS = 80_000_000;

export interface RasterResult {
  bytes: Uint8Array;
  /** 最终位图宽（内容宽 × 实际 scale） */
  width: number;
  height: number;
  mime: "image/png" | "image/jpeg";
}

/**
 * 防爆降级：从传入 scale 逐级 -1 直到 1，返回第一个满足
 * 单边 ≤16000 且总像素 ≤8000 万的值；scale=1 仍超限时同样返回 1
 * （此时交给 snapdom 内部的 raster-clamp 兜底，避免调用方拿到 0/负数）。
 */
export function resolveScale(w: number, h: number, scale: number): number {
  let s = Math.max(1, Math.floor(scale));
  while (
    s > 1 &&
    !(w * s <= MAX_SIDE && h * s <= MAX_SIDE && w * h * s * s <= MAX_PIXELS)
  ) {
    s -= 1;
  }
  return s;
}

/** canvas.toBlob 的 Promise 封装（blob 可能为 null，需显式报错） */
function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: "image/png" | "image/jpeg",
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("canvas.toBlob 返回 null"))),
      mime,
      quality,
    );
  });
}

/**
 * 把元素栅格化为位图字节。
 * 流程：snapdom 捕获 → canvas（位图，含精确宽高）→ canvas.toBlob → arrayBuffer → Uint8Array。
 * 刻意不走 dataURL：大图 base64 字符串会额外复制一份且难以释放，Blob 路径保持单份内存。
 */
export async function captureElement(
  el: HTMLElement,
  opts: {
    scale: number;
    format: ExportFormat;
    jpegQuality?: number;
    backgroundColor?: string;
  },
): Promise<RasterResult> {
  // 字体就绪后再捕获，避免 webfont 未加载导致文字用回退字体栅格化
  await document.fonts.ready;

  const scale = resolveScale(el.offsetWidth, el.offsetHeight, opts.scale);
  const isJpeg = opts.format === "jpeg";
  // jpeg 无 alpha 通道：未指定底色时补白，避免透明区域被编码成黑色
  const backgroundColor = opts.backgroundColor ?? (isJpeg ? "#ffffff" : undefined);
  const mime: RasterResult["mime"] = isJpeg ? "image/jpeg" : "image/png";

  // dpr 固定为 1：snapdom 默认 dpr=devicePixelRatio 且与 scale 相乘，
  // 不固定会导致最终位图 = 内容 × scale × 系统 DPR，破坏 RasterResult 尺寸契约
  const result = await snapdom(el, { scale, dpr: 1, backgroundColor });
  const canvas = await result.toCanvas({ backgroundColor });

  const blob = await canvasToBlob(
    canvas,
    mime,
    isJpeg ? (opts.jpegQuality ?? 0.92) : undefined,
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());

  // result / canvas 均为函数局部量，返回后即释放，不做模块级缓存
  return { bytes, width: canvas.width, height: canvas.height, mime };
}
