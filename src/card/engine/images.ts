import { invoke } from "@tauri-apps/api/core";

/**
 * 图片本地化：把 markdown.rs 改写出的 asset.localhost 协议图片
 * 换成 data URL，供 snapdom 离线内嵌（svg foreignObject 无法直接读取
 * 自定义协议资源；远程 http(s) 图片不受影响，由 snapdom 自行抓取内嵌）。
 */

/** markdown.rs 写入的本地图片协议前缀（路径已 urlencoded） */
const ASSET_PREFIX = "http://asset.localhost/";

/** src → dataUrl 缓存：同一文档重复导出 / 拆多卡时免去重复 IPC 读盘 */
const dataUrlCache = new Map<string, string>();
/** 缓存条数上限，超出按 FIFO 淘汰最早插入项（Map 保持插入序，取首键即可） */
const CACHE_LIMIT = 300;

function cacheSet(key: string, value: string): void {
  if (!dataUrlCache.has(key)) {
    dataUrlCache.set(key, value);
  }
  while (dataUrlCache.size > CACHE_LIMIT) {
    const oldest = dataUrlCache.keys().next().value;
    if (oldest === undefined) break;
    dataUrlCache.delete(oldest);
  }
}

/**
 * 把容器内所有未处理的本地图片（src 以 http://asset.localhost/ 开头）
 * 批量替换为 data URL。
 *
 * 性能决策：所有待取图片合并为一次 IPC（card_images_dataurl），避免每图一次
 * 跨进程往返；成功结果进模块级缓存，失败（后端返回 None）不入缓存以便重试。
 */
export async function localizeImages(
  container: HTMLElement,
): Promise<{ replaced: number; failed: number }> {
  const imgs = Array.from(
    container.querySelectorAll<HTMLImageElement>(
      'img[src^="http://asset.localhost/"]',
    ),
  ).filter((img) => img.getAttribute("data-localized") !== "1");

  // 同名图片去重后再走 IPC；命中缓存的直接用
  const wanted = new Set<string>();
  for (const img of imgs) {
    const src = img.getAttribute("src");
    if (src && src.startsWith(ASSET_PREFIX) && !dataUrlCache.has(src)) {
      wanted.add(src);
    }
  }

  let fetched: (string | null)[] = [];
  if (wanted.size > 0) {
    const srcs = Array.from(wanted);
    // 后端 Vec<Option<String>>：None = 读取失败；返回顺序与 srcs 一致
    fetched = await invoke<(string | null)[]>("card_images_dataurl", { srcs });
    srcs.forEach((src, i) => {
      const dataUrl = fetched[i];
      if (dataUrl) cacheSet(src, dataUrl);
    });
  }

  let replaced = 0;
  let failed = 0;
  for (const img of imgs) {
    const src = img.getAttribute("src");
    if (!src) continue;
    const dataUrl = dataUrlCache.get(src);
    if (dataUrl) {
      img.src = dataUrl;
      img.setAttribute("data-localized", "1");
      replaced += 1;
    } else {
      // 失败：保持原 src，交给 snapdom 的占位/回退逻辑
      failed += 1;
    }
  }

  return { replaced, failed };
}
