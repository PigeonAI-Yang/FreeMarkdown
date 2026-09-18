import { invoke } from "@tauri-apps/api/core";

/** 系统字体列表请求：模块级 memo，in-flight promise 去重 */
let systemFontsPromise: Promise<string[]> | null = null;

/** 列出系统字体；失败返回空数组并告警 */
export async function listSystemFonts(): Promise<string[]> {
  if (!systemFontsPromise) {
    systemFontsPromise = invoke<string[]>("system_fonts").then(
      (fonts) => (Array.isArray(fonts) ? fonts : []),
      (err: unknown) => {
        console.warn("[fonts] 读取系统字体列表失败:", err);
        return [] as string[];
      },
    );
  }
  return systemFontsPromise;
}

/** 已导入自定义字体缓存：文件标识 → family 名 */
const importedFonts = new Map<string, string>();

/** 去扩展名 */
function stripExt(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}

/** 导入本地字体文件；同文件重复导入直接返回同名 family，不重复加载 */
export async function importFontFile(file: File): Promise<string> {
  const key = `${file.name}::${file.size}::${file.lastModified}`;
  const cached = importedFonts.get(key);
  if (cached) {
    return cached;
  }

  const family = `FMCustom-${stripExt(file.name)}`;
  const buffer = await file.arrayBuffer();
  const face = new FontFace(family, buffer);
  await face.load();
  document.fonts.add(face);
  importedFonts.set(key, family);
  return family;
}

/** 确保字体已可渲染：预载 16px 样例并等待字体队列就绪；空 family 直接返回 */
export async function ensureFontReady(family: string): Promise<void> {
  if (!family) {
    return;
  }
  try {
    await document.fonts.load(`16px "${family}"`);
  } catch (err) {
    console.warn("[fonts] 字体预载失败:", family, err);
  }
  await document.fonts.ready;
}
