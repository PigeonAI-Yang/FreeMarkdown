//! 图片卡片导出的 Rust 支撑：系统字体枚举（DirectWrite + GDI 合并）、
//! asset 图片转 DataURL、保存路径选择、写文件与剪贴板写入。
//!
//! 重活（读文件、base64、图片解码）都丢进 spawn_blocking + rayon 并行。

use base64::Engine as _;
use tauri::AppHandle;

/// asset 协议前缀（前端把本地图片映射成该 URL）
const ASSET_PREFIX: &str = "http://asset.localhost/";

/// 按扩展名映射 MIME 类型
fn ext_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

/// asset.localhost URL → 本地文件路径（前缀不符或解码失败返回 None）
fn asset_url_to_path(src: &str) -> Option<String> {
    let rest = src
        .strip_prefix(ASSET_PREFIX)
        .or_else(|| src.strip_prefix("https://asset.localhost/"))?;
    // 去掉可能的查询串（前端防缓存参数）
    let rest = rest.split('?').next()?;
    let path = urlencoding::decode(rest).ok()?.into_owned();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

/// 读单个文件并编码为 data:URL；扩展名不可识别或读取失败返回 None
fn read_file_dataurl(src: &str) -> Option<String> {
    let path = asset_url_to_path(src)?;
    let ext = std::path::Path::new(&path)
        .extension()?
        .to_string_lossy()
        .to_lowercase();
    let mime = ext_mime(&ext)?;
    let bytes = std::fs::read(&path).ok()?;
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// 批量把 asset 图片读成 DataURL（rayon 并行，失败项为 None）
#[tauri::command]
pub async fn card_images_dataurl(srcs: Vec<String>) -> Result<Vec<Option<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use rayon::prelude::*;
        let out: Vec<Option<String>> = srcs.par_iter().map(|s| read_file_dataurl(s)).collect();
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 保存对话框：按格式设置过滤器，返回用户选择的路径（取消为 None）
#[tauri::command]
pub fn card_pick_save_path(
    app: AppHandle,
    default_name: String,
    format: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = match format.as_str() {
        "jpeg" => app
            .dialog()
            .file()
            .set_title("保存图片卡片")
            .add_filter("JPEG 图片", &["jpg", "jpeg"])
            .set_file_name(&default_name)
            .blocking_pick_file(),
        _ => app
            .dialog()
            .file()
            .set_title("保存图片卡片")
            .add_filter("PNG 图片", &["png"])
            .set_file_name(&default_name)
            .blocking_pick_file(),
    };
    Ok(picked.map(|p| p.to_string()))
}

/// base64 数据写文件，返回写入字节数
#[tauri::command]
pub async fn card_write_file(path: String, data_b64: String) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = base64::engine::general_purpose::STANDARD
            .decode(data_b64.as_bytes())
            .map_err(|e| format!("base64 解码失败: {e}"))?;
        std::fs::write(&path, &data).map_err(|e| format!("写入文件失败: {e}"))?;
        Ok(data.len() as u32)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 解码 PNG 并写入系统剪贴板，返回图片 (宽, 高)
#[tauri::command]
pub async fn card_clipboard_write_png(
    app: AppHandle,
    data_b64: String,
) -> Result<(u32, u32), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    tauri::async_runtime::spawn_blocking(move || {
        let data = base64::engine::general_purpose::STANDARD
            .decode(data_b64.as_bytes())
            .map_err(|e| format!("base64 解码失败: {e}"))?;
        let img = image::load_from_memory(&data).map_err(|e| format!("图片解码失败: {e}"))?;
        let (w, h) = (img.width(), img.height());
        let rgba = img.to_rgba8();
        let timg = tauri::image::Image::new_owned(rgba.into_raw(), w, h);
        app.clipboard()
            .write_image(&timg)
            .map_err(|e| format!("写入剪贴板失败: {e}"))?;
        Ok((w, h))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 系统字体家族列表（DirectWrite + GDI 合并，进程级缓存一次）
#[tauri::command]
pub fn system_fonts() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        static CACHE: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
        Ok(CACHE.get_or_init(collect_system_fonts).clone())
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

/// UTF-16 定长缓冲 → String（截断到首个 NUL）
#[cfg(windows)]
fn utf16_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// 合并 DirectWrite 与 GDI 的字体家族：
/// DW 提供本地化名（zh 优先），GDI 补齐 per-user 安装且 DW 未见到的家族
#[cfg(windows)]
fn collect_system_fonts() -> Vec<String> {
    use std::collections::HashSet;

    let (mut out, aliases) = directwrite_families();
    let mut seen: HashSet<String> = out.iter().map(|s| s.to_lowercase()).collect();
    for name in gdi_font_families() {
        let key = name.to_lowercase();
        // 命中 DW 任一本地化名视为同一家族，保留 DW 的 zh 名
        if !aliases.contains(&key) && seen.insert(key) {
            out.push(name);
        }
    }
    out.sort();
    out
}

/// DirectWrite 枚举：返回（展示名列表，全部本地化名小写别名集）
#[cfg(windows)]
fn directwrite_families() -> (Vec<String>, std::collections::HashSet<String>) {
    use windows::core::Interface as _;
    use windows::Win32::Graphics::DirectWrite::{
        DWriteCreateFactory, DWRITE_FACTORY_TYPE_SHARED, IDWriteFactory3, IDWriteFontCollection,
        IDWriteFontCollection1,
    };

    let mut out: Vec<String> = Vec::new();
    let mut aliases = std::collections::HashSet::new();
    // 枚举失败时返回空列表，不让导出功能整体失败
    let factory: IDWriteFactory3 = match unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED) }
    {
        Ok(f) => f,
        Err(_) => return (out, aliases),
    };
    // Factory3 的系统集合包含按用户安装的字体（v1 工厂仅机器级）
    let mut coll1: Option<IDWriteFontCollection1> = None;
    if unsafe { factory.GetSystemFontCollection(false, &mut coll1, false) }.is_err() {
        return (out, aliases);
    }
    let coll1 = match coll1 {
        Some(c) => c,
        None => return (out, aliases),
    };
    let collection: IDWriteFontCollection = match coll1.cast() {
        Ok(c) => c,
        Err(_) => return (out, aliases),
    };
    let count = unsafe { collection.GetFontFamilyCount() };
    for i in 0..count {
        let name = pick_family_name(&collection, i, &mut aliases);
        if !name.is_empty() {
            out.push(name);
        }
    }
    out.sort();
    (out, aliases)
}

/// 取单个家族的展示名：zh 开头 locale 优先，否则第 0 个；
/// 该家族的全部本地化名记入 aliases（供与 GDI 结果跨源去重）
#[cfg(windows)]
fn pick_family_name(
    collection: &windows::Win32::Graphics::DirectWrite::IDWriteFontCollection,
    index: u32,
    aliases: &mut std::collections::HashSet<String>,
) -> String {
    use windows::Win32::Graphics::DirectWrite::IDWriteLocalizedStrings;

    // 读出一个本地化字符串（UTF-16），失败返回 None
    fn read_at(strings: &IDWriteLocalizedStrings, j: u32) -> Option<String> {
        let len = unsafe { strings.GetStringLength(j) }.ok()? as usize;
        let mut buf = vec![0u16; len + 1];
        unsafe { strings.GetString(j, &mut buf) }.ok()?;
        Some(String::from_utf16_lossy(&buf[..len]))
    }

    let family = match unsafe { collection.GetFontFamily(index) } {
        Ok(f) => f,
        Err(_) => return String::new(),
    };
    let names = match unsafe { family.GetFamilyNames() } {
        Ok(n) => n,
        Err(_) => return String::new(),
    };
    let n = unsafe { names.GetCount() };
    if n == 0 {
        return String::new();
    }
    let fallback = read_at(&names, 0).unwrap_or_default();
    aliases.insert(fallback.to_lowercase());
    for j in 0..n {
        let text = match read_at(&names, j) {
            Some(t) => t,
            None => continue,
        };
        aliases.insert(text.to_lowercase());
        let locale = (|| -> Option<String> {
            let len = unsafe { names.GetLocaleNameLength(j) }.ok()? as usize;
            let mut buf = vec![0u16; len + 1];
            unsafe { names.GetLocaleName(j, &mut buf) }.ok()?;
            Some(String::from_utf16_lossy(&buf[..len]))
        })();
        if locale.as_deref().map(|l| l.to_lowercase().starts_with("zh")) == Some(true) {
            return text;
        }
    }
    fallback
}

/// GDI 枚举字体家族（EnumFontFamiliesEx，覆盖 per-user 安装字体）；
/// 优先 family name，缺失时退回 full name
#[cfg(windows)]
fn gdi_font_families() -> Vec<String> {
    use std::collections::HashSet;
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::Graphics::Gdi::{
        EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, ENUMLOGFONTEXW, LOGFONTW,
        TEXTMETRICW,
    };

    // 回调：收集 family name（full name 兜底）；返回 1 继续
    unsafe extern "system" fn enum_proc(
        lplf: *const LOGFONTW,
        _ntm: *const TEXTMETRICW,
        _font_type: u32,
        lparam: LPARAM,
    ) -> i32 {
        unsafe {
            let names = &mut *(lparam.0 as *mut HashSet<String>);
            let elf = &*(lplf.cast::<ENUMLOGFONTEXW>());
            let face = utf16_to_string(&elf.elfLogFont.lfFaceName);
            let full = utf16_to_string(&elf.elfFullName);
            let pick = if face.is_empty() { full } else { face };
            if !pick.is_empty() {
                names.insert(pick);
            }
        }
        1
    }

    unsafe {
        let hdc = GetDC(None);
        if hdc.is_invalid() {
            return Vec::new();
        }
        let mut names: HashSet<String> = HashSet::new();
        let mut lf: LOGFONTW = core::mem::zeroed();
        lf.lfCharSet = DEFAULT_CHARSET;
        EnumFontFamiliesExW(
            hdc,
            &lf,
            Some(enum_proc),
            LPARAM(&mut names as *mut HashSet<String> as isize),
            0,
        );
        ReleaseDC(None, hdc);
        names.into_iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小 1x1 RGBA PNG（base64）
    const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==";

    /// 随机临时文件名（进程 id + 纳秒，避免并发冲突）
    fn temp_name(suffix: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u64 + d.as_secs())
            .unwrap_or(0);
        format!("fmd_card_{}_{nanos}{suffix}", std::process::id())
    }

    #[test]
    fn system_fonts_should_contain_common_family() {
        let fonts = system_fonts().unwrap();
        println!("merged font family count = {}", fonts.len());
        if cfg!(windows) {
            // 纯 DirectWrite 数量现算对比（本机 DW 仅 176，GDI 基线 303）
            let dw = directwrite_families().0.len();
            println!("directwrite-only count = {dw}");
            assert!(
                fonts.len() >= 300,
                "合并后家族数应 ≥ 300，实际 {}",
                fonts.len()
            );
            assert!(
                fonts.len() > dw,
                "GDI 合并应补充 per-user 字体，合并 {} 未超过 DW {dw}",
                fonts.len()
            );
            assert!(
                fonts
                    .iter()
                    .any(|f| f.contains("Microsoft YaHei") || f.contains("微软雅黑")),
                "字体列表应包含微软雅黑"
            );
        } else {
            assert!(fonts.is_empty());
        }
    }

    #[test]
    fn write_file_roundtrip() {
        let data = b"freemdown card export roundtrip bytes 1234567890";
        let b64 = base64::engine::general_purpose::STANDARD.encode(data);
        let path = std::env::temp_dir().join(temp_name(".bin"));
        let n = tauri::async_runtime::block_on(card_write_file(
            path.to_string_lossy().into_owned(),
            b64,
        ))
        .unwrap();
        assert_eq!(n as usize, data.len(), "返回字节数应与写入数据一致");
        let read = std::fs::read(&path).unwrap();
        assert_eq!(read, data, "读回字节应与原始数据一致");
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn images_dataurl_roundtrip() {
        let path = std::env::temp_dir().join(temp_name(".png"));
        let path_str = path.to_string_lossy().into_owned();
        // 先经 card_write_file 落盘一个真实 png
        tauri::async_runtime::block_on(card_write_file(path_str.clone(), PNG_1X1.to_string()))
            .unwrap();

        let encoded = urlencoding::encode(&path_str);
        let url = format!("{ASSET_PREFIX}{encoded}");
        let bad_url = format!(
            "{ASSET_PREFIX}{}",
            urlencoding::encode("Z:\\no_such_dir_card\\no_such_file.png")
        );
        let res = tauri::async_runtime::block_on(card_images_dataurl(vec![
            url,
            bad_url,
            "not-an-asset-url".to_string(),
        ]))
        .unwrap();
        let ok = res[0].as_ref().expect("合法 asset 路径应返回 Some");
        assert!(
            ok.starts_with("data:image/png;base64,"),
            "应带 data 前缀，实际开头: {}",
            &ok[..ok.len().min(40)]
        );
        assert!(res[1].is_none(), "不存在的文件应返回 None");
        assert!(res[2].is_none(), "非 asset 前缀应返回 None");
        std::fs::remove_file(&path).unwrap();
    }
}
