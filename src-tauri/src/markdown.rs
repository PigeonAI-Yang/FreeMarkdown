//! Markdown 解析、TOC 提取、资源路径改写与 LRU 缓存。
//!
//! 文件读取与 comrak 解析都在后台线程完成，一次性把 HTML 字符串发给 WebView。
//! 分块在 Rust 侧完成：在文档顶层块边界插入哨兵，输出按哨兵切分为 chunks，
//! 前端对大文档只注入可视区 chunk。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use lru::LruCache;
use regex::Regex;
use serde::Serialize;
use tauri::State;

/// 单个分块的目标大小（字节），按顶层块聚合
const CHUNK_TARGET: usize = 64 * 1024;
/// 顶层块边界哨兵（控制字符开头，不会出现在正常 HTML 中）
const SENTINEL: &str = "\u{1}FMCHUNK\u{1}";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TocItem {
    pub level: u8,
    pub text: String,
    pub id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocPayload {
    pub chunks: Vec<Arc<String>>,
    pub total_len: usize,
    pub toc: Arc<Vec<TocItem>>,
    pub size: u64,
    pub mtime_ms: u64,
    pub from_cache: bool,
    pub parse_ms: u128,
}

#[derive(Clone)]
struct CachedDoc {
    chunks: Arc<Vec<Arc<String>>>,
    toc: Arc<Vec<TocItem>>,
}

pub struct CacheState(Mutex<LruCache<(PathBuf, u64), CachedDoc>>);

impl CacheState {
    pub fn new(cap: usize) -> Self {
        Self(Mutex::new(LruCache::new(
            std::num::NonZeroUsize::new(cap).unwrap(),
        )))
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn read_markdown(
    state: State<'_, CacheState>,
    path: String,
) -> Result<DocPayload, String> {
    let pb = PathBuf::from(&path);
    let meta = std::fs::metadata(&pb).map_err(|e| format!("读取文件信息失败: {e}"))?;
    let size = meta.len();
    let mtime = mtime_ms(&meta);
    let key = (pb.clone(), mtime);

    if let Some(c) = state.0.lock().unwrap().get(&key) {
        return Ok(DocPayload {
            total_len: c.chunks.iter().map(|c| c.len()).sum(),
            chunks: c.chunks.as_ref().clone(),
            toc: c.toc.clone(),
            size,
            mtime_ms: mtime,
            from_cache: true,
            parse_ms: 0,
        });
    }

    let job = move || -> Result<(Vec<Arc<String>>, Vec<TocItem>, usize, u128), String> {
        let t0 = std::time::Instant::now();
        let raw = std::fs::read(&pb).map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&raw).into_owned();
        let (chunks, toc) = render_document(&text, pb.parent().unwrap_or(Path::new(".")));
        let total = chunks.iter().map(|c| c.len()).sum();
        let chunks: Vec<Arc<String>> = chunks.into_iter().map(Arc::new).collect();
        Ok((chunks, toc, total, t0.elapsed().as_millis()))
    };
    let (chunks, toc, total_len, parse_ms) = tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| e.to_string())??;

    let toc = Arc::new(toc);
    state.0.lock().unwrap().put(
        key,
        CachedDoc {
            chunks: Arc::new(chunks.clone()),
            toc: toc.clone(),
        },
    );

    Ok(DocPayload {
        total_len,
        chunks,
        toc,
        size,
        mtime_ms: mtime,
        from_cache: false,
        parse_ms,
    })
}

/// comrak 解析配置（GFM 全家桶 + 数学公式 + 标题 id）
fn comrak_options() -> comrak::Options<'static> {
    let mut opts = comrak::Options::default();
    opts.extension.table = true;
    opts.extension.strikethrough = true;
    opts.extension.tasklist = true;
    opts.extension.autolink = true;
    opts.extension.footnotes = true;
    opts.extension.description_lists = true;
    opts.extension.header_id_prefix = Some(String::new());
    opts.extension.math_dollars = true;
    opts.extension.math_code = false;
    opts.parse.default_info_string = Some("text".into());
    // 块级元素写 data-sourcepos="起始行:列-结束行:列"，供搜索跳转精确定位行
    opts.render.sourcepos = true;
    opts
}

/// 在每个顶层块进入时写哨兵；写侧按哨兵 + 阈值切块。
fn chunker_formatter(
    context: &mut comrak::html::Context<()>,
    node: comrak::Node<'_>,
    entering: bool,
) -> Result<comrak::html::ChildRendering, std::fmt::Error> {
    if entering && node.parent().map_or(false, |p| p.parent().is_none()) {
        use std::fmt::Write as _;
        let _ = context.write_str(SENTINEL);
    }
    comrak::html::format_node_default(context, node, entering)
}

struct ChunkWriter {
    chunks: Vec<String>,
    current: String,
}

impl std::fmt::Write for ChunkWriter {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        let mut rest = s;
        while let Some(i) = rest.find(SENTINEL) {
            self.current.push_str(&rest[..i]);
            if self.current.len() >= CHUNK_TARGET {
                self.chunks.push(std::mem::take(&mut self.current));
            }
            rest = &rest[i + SENTINEL.len()..];
        }
        self.current.push_str(rest);
        Ok(())
    }
}

/// 按文档顶层块渲染并聚合成 chunks。小文档通常只有 1 块。
fn render_document(text: &str, base_dir: &Path) -> (Vec<String>, Vec<TocItem>) {
    let opts = comrak_options();
    let arena = comrak::Arena::new();
    let root = comrak::parse_document(&arena, text, &opts);

    let mut writer = ChunkWriter {
        chunks: Vec::new(),
        current: String::with_capacity(text.len().min(1 << 20) / 2 + 1024),
    };
    comrak::html::format_document_with_formatter(
        root,
        &opts,
        &mut writer,
        &comrak::options::Plugins::default(),
        chunker_formatter,
        (),
    )
    .expect("html render");
    if !writer.current.is_empty() {
        writer.chunks.push(std::mem::take(&mut writer.current));
    }
    let chunks: Vec<String> = writer
        .chunks
        .into_iter()
        .map(|c| rewrite_assets(&c, base_dir))
        .collect();
    let joined = chunks.join("");
    let toc = extract_toc(&joined);
    (chunks, toc)
}

fn resolve_local(base_dir: &Path, href: &str) -> Option<PathBuf> {
    let href = href.trim();
    if href.is_empty()
        || href.starts_with("http://")
        || href.starts_with("https://")
        || href.starts_with("data:")
        || href.starts_with('#')
        || href.starts_with("mailto:")
    {
        return None;
    }
    let decoded = urlencoding::decode(href)
        .unwrap_or_else(|_| href.into())
        .into_owned();
    let decoded = decoded.replace('\\', "/");
    if decoded.starts_with("//") {
        return None; // UNC / protocol-relative
    }
    let p = PathBuf::from(&decoded);
    Some(if p.is_absolute() { p } else { base_dir.join(p) })
}

fn asset_url(p: &Path) -> String {
    format!(
        "http://asset.localhost/{}",
        urlencoding::encode(&p.to_string_lossy())
    )
}

/// 把本地图片地址改写为 Tauri asset 协议；md 相对链接写入 data-md-href 供前端拦截；
/// http(s) 外链加 data-external 标记。
///
/// 编译好的正则用 OnceLock 缓存：编辑链路按块调用（2MB 文档上万次），
/// 每次重建正则会让块级渲染退化到秒级。
fn rewrite_assets(html: &str, base_dir: &Path) -> String {
    static IMG_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static SRC_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static A_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static HREF_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let img_re = IMG_RE.get_or_init(|| Regex::new(r#"<img\s([^>]*?)/?>"#).unwrap());
    let src_re = SRC_RE.get_or_init(|| Regex::new(r#"src="([^"]*)""#).unwrap());
    let a_re = A_RE.get_or_init(|| Regex::new(r#"<a\s([^>]*?)>"#).unwrap());
    let href_re = HREF_RE.get_or_init(|| Regex::new(r#"href="([^"]*)""#).unwrap());

    let html: String = img_re
        .replace_all(html, |caps: &regex::Captures| {
            let attrs = &caps[1];
            let src = src_re
                .captures(attrs)
                .map(|c| c[1].to_string())
                .unwrap_or_default();
            let new_src = match resolve_local(base_dir, &src) {
                Some(p) if p.exists() => asset_url(&p),
                _ => src.clone(),
            };
            let attrs = src_re.replace(attrs, format!("src=\"{new_src}\""));
            format!("<img {attrs}>")
        })
        .into_owned();

    a_re
        .replace_all(&html, |caps: &regex::Captures| {
            let attrs = &caps[1];
            let href = href_re
                .captures(attrs)
                .map(|c| c[1].to_string())
                .unwrap_or_default();
            if href.starts_with("http://") || href.starts_with("https://") {
                let attrs = href_re.replace(attrs, format!("href=\"{href}\" data-external=\"1\""));
                return format!("<a {attrs}>");
            }
            if href.starts_with('#') {
                return format!("<a {attrs}>");
            }
            match resolve_local(base_dir, &href) {
                Some(p) => {
                    let anchor = href.rsplit_once('#').and_then(|(p, a)| {
                        (!p.is_empty() && !a.is_empty()).then(|| a.to_string())
                    });
                    let anchor_attr = anchor
                        .map(|a| format!(" data-md-anchor=\"{a}\""))
                        .unwrap_or_default();
                    let attrs = href_re.replace(
                        attrs,
                        format!(
                            "href=\"#\" data-md-href=\"{}\"{anchor_attr}",
                            p.to_string_lossy().replace('\\', "/")
                        ),
                    );
                    format!("<a {attrs}>")
                }
                None => format!("<a {attrs}>"),
            }
        })
        .into_owned()
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
}

/* ==================== 编辑支持：原文读取 / 内存渲染 / 原子写回 ====================
 *
 * 编辑走的是「后端只做无状态渲染与安全落盘」的分工：文本缓冲在前端（CodeMirror），
 * 每次改动只把受影响的块切片发过来重新解析，磁盘写入保持原子性与换行/BOM 原样。
 */

/// 编辑用原文载荷：换行已规范化为 `\n`，写回时按 `eol` / `bom` 还原
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePayload {
    pub text: String,
    pub mtime_ms: u64,
    pub size: u64,
    /// 原文件换行风格："lf" | "crlf"
    pub eol: String,
    pub bom: bool,
}

/// 单个顶层块：HTML + 它在全文中的行范围（供源码↔预览映射）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockHtml {
    pub html: String,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlocksPayload {
    pub blocks: Vec<BlockHtml>,
    pub toc: Arc<Vec<TocItem>>,
    pub parse_ms: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub mtime_ms: u64,
    pub bytes: u64,
}

/// 读原文（编辑用）的同步核心。换行统一成 `\n` 交给编辑器，并记录原文件风格与 BOM。
fn read_source_blocking(path: &Path) -> Result<SourcePayload, String> {
    let raw = std::fs::read(path).map_err(|e| format!("读取失败: {e}"))?;
    let meta = std::fs::metadata(path).map_err(|e| format!("读取文件信息失败: {e}"))?;
    let bom = raw.starts_with(&[0xEF, 0xBB, 0xBF]);
    let body: &[u8] = if bom { &raw[3..] } else { &raw };
    let text = String::from_utf8_lossy(body).into_owned();
    let crlf = text.matches("\r\n").count();
    let lf_total = text.matches('\n').count();
    // 以多数派为准（个别行风格不一致时按多数还原，不做逐行保留）
    let eol = if crlf * 2 > lf_total { "crlf" } else { "lf" };
    let text = if eol == "crlf" {
        text.replace("\r\n", "\n")
    } else {
        text
    };
    Ok(SourcePayload {
        text,
        mtime_ms: mtime_ms(&meta),
        size: meta.len(),
        eol: eol.to_string(),
        bom,
    })
}

/// 读原文（编辑用）
#[tauri::command]
pub async fn read_markdown_source(path: String) -> Result<SourcePayload, String> {
    tauri::async_runtime::spawn_blocking(move || read_source_blocking(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

/// 直通 formatter：不带分块哨兵，按节点原样渲染（单块渲染用）
fn plain_formatter(
    context: &mut comrak::html::Context<()>,
    node: comrak::Node<'_>,
    entering: bool,
) -> Result<comrak::html::ChildRendering, std::fmt::Error> {
    comrak::html::format_node_default(context, node, entering)
}

/// 把 `data-sourcepos` 的行号平移到全文坐标（局部切片解析时行号是片内相对值）。
/// `offset` 允许为负：切片前面挂"链接引用定义前缀"时，前缀行要整体扣掉。
fn shift_sourcepos(html: &str, offset: i64) -> String {
    if offset == 0 {
        return html.to_string();
    }
    static SP_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = SP_RE
        .get_or_init(|| Regex::new(r#"data-sourcepos="(\d+):(\d+)-(\d+):(\d+)""#).unwrap());
    re.replace_all(html, |c: &regex::Captures| {
        let s = (c[1].parse::<i64>().unwrap_or(1) + offset).max(1);
        let e = (c[3].parse::<i64>().unwrap_or(1) + offset).max(1);
        format!("data-sourcepos=\"{s}:{}-{e}:{}\"", &c[2], &c[4])
    })
    .into_owned()
}

/// 按 comrak 的顶层块逐个渲染（块即增量渲染的最小单位）。
///
/// `line_base` = 切片首行在全文中的行号减一（即前置行数）；`drop_lines` = 切片
/// 前面挂了多少行"上下文前缀"（链接引用定义），这些行只参与解析、不出现在结果里。
fn render_blocks(
    text: &str,
    base_dir: &Path,
    line_base: i64,
    drop_lines: u32,
) -> (Vec<BlockHtml>, Vec<TocItem>) {
    let opts = comrak_options();
    let arena = comrak::Arena::new();
    let root = comrak::parse_document(&arena, text, &opts);
    let plugins = comrak::options::Plugins::default();
    let shift = line_base - drop_lines as i64;
    let mut blocks: Vec<BlockHtml> = Vec::new();
    for child in root.children() {
        let sp = child.data().sourcepos;
        // 前缀行只喂给解析器（提供引用定义），不产出块
        if sp.end.line as u32 <= drop_lines {
            continue;
        }
        let mut buf = String::new();
        // 单块渲染失败只丢这一块，不拖垮整篇
        if comrak::html::format_document_with_formatter(
            child,
            &opts,
            &mut buf,
            &plugins,
            plain_formatter,
            (),
        )
        .is_err()
        {
            continue;
        }
        let html = rewrite_assets(&buf, base_dir);
        blocks.push(BlockHtml {
            html: shift_sourcepos(&html, shift),
            start_line: (sp.start.line as i64 + shift).max(1) as u32,
            end_line: (sp.end.line as i64 + shift).max(1) as u32,
        });
    }
    let joined: String = blocks.iter().map(|b| b.html.as_str()).collect();
    let toc = extract_toc(&joined);
    (blocks, toc)
}

/// 解析一段 Markdown 文本（内存中，不落盘）为顶层块列表。
/// `line_base` = 该切片之前已有多少行（全文坐标换算用，可为负——见 render_blocks）。
#[tauri::command]
pub async fn render_markdown_blocks(
    text: String,
    base_dir: String,
    line_base: i64,
    drop_lines: u32,
) -> Result<BlocksPayload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let dir = if base_dir.trim().is_empty() {
            PathBuf::from(".")
        } else {
            PathBuf::from(&base_dir)
        };
        let (blocks, toc) = render_blocks(&text, &dir, line_base, drop_lines);
        Ok(BlocksPayload {
            blocks,
            toc: Arc::new(toc),
            parse_ms: t0.elapsed().as_millis(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 原子写回的同步核心：临时文件 + rename；写前比对 mtime，不一致返回 `conflict:<当前 mtime>`。
fn write_markdown_blocking(
    path: &Path,
    text: &str,
    expect_mtime_ms: Option<u64>,
    eol: &str,
    bom: bool,
) -> Result<WriteResult, String> {
    if let Some(expect) = expect_mtime_ms {
        let meta = std::fs::metadata(path).map_err(|e| format!("读取文件信息失败: {e}"))?;
        let cur = mtime_ms(&meta);
        if cur != expect {
            return Err(format!("conflict:{cur}"));
        }
    }
    // 换行先统一成 \n 再按目标风格还原：避免文本里混入 \r\n 时写出 \r\r\n
    let lf = text.replace("\r\n", "\n");
    let body = if eol == "crlf" {
        lf.replace('\n', "\r\n")
    } else {
        lf
    };
    let mut bytes: Vec<u8> = Vec::with_capacity(body.len() + 3);
    if bom {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(body.as_bytes());

    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "doc.md".into());
    let tmp = dir.join(format!(".{name}.fm-tmp-{}", std::process::id()));
    // 清掉上次异常中断（进程被杀）留下的临时文件
    let stale_prefix = format!(".{name}.fm-tmp-");
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let fname = e.file_name().to_string_lossy().to_string();
            if fname.starts_with(&stale_prefix) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    if let Err(e) = std::fs::write(&tmp, &bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("写入失败: {e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("替换文件失败: {e}"));
    }
    let meta = std::fs::metadata(path).map_err(|e| format!("读取文件信息失败: {e}"))?;
    Ok(WriteResult {
        mtime_ms: mtime_ms(&meta),
        bytes: meta.len(),
    })
}

/// 原子写回（编辑用）
#[tauri::command]
pub async fn write_markdown(
    path: String,
    text: String,
    expect_mtime_ms: Option<u64>,
    eol: String,
    bom: bool,
) -> Result<WriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_markdown_blocking(Path::new(&path), &text, expect_mtime_ms, &eol, bom)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn extract_toc(html: &str) -> Vec<TocItem> {
    static H_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = H_RE.get_or_init(|| {
        Regex::new(r#"(?s)<h([1-6])\b[^>]*\bid="([^"]*)"[^>]*>(.*?)</h[1-6]>"#).unwrap()
    });
    static TAG_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let tag_re = TAG_RE.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());

    re.captures_iter(html)
        .map(|c| {
            let level = c[1].as_bytes()[0] - b'0';
            let id = c[2].to_string();
            let text = decode_entities(tag_re.replace_all(&c[3], "").trim());
            TocItem { level, text, id }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn print_sample_render() {
        let md = r##"# 标题一

一些 **加粗** 文字与脚注[^1]。

## 标题二 Section

行内公式 $E=mc^2$ 与显示公式：

$$\int_0^1 x^2 dx = \frac13$$

```rust
fn main() { println!("hi"); }
```

```mermaid
graph LR; A-->B;
```

| 列A | 列B |
|-----|-----|
| 1   | 2   |

- [x] 任务一
- [ ] 任务二

~~删除线~~ 与 https://example.com 自动链接

[^1]: 脚注内容

<div>raw html</div>
"##;
        let (chunks, toc) = render_document(md, Path::new("."));
        for (i, c) in chunks.iter().enumerate() {
            eprintln!("=== chunk {i} ({} bytes) ===", c.len());
            eprintln!("{c}");
        }
        eprintln!("=== TOC ===");
        for t in &toc {
            eprintln!("h{} [{}] {}", t.level, t.id, t.text);
        }
        assert!(!chunks.is_empty());
    }
}

/// 编辑链路（读原文 / 分块渲染 / 原子写回）的单元测试
#[cfg(test)]
mod edit_tests {
    use super::*;

    /// 每个用例独占的临时目录（进程内并发安全）
    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fm-edit-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn read_source_detects_eol_and_bom() {
        let dir = tmp_dir("read");
        let crlf = dir.join("crlf.md");
        std::fs::write(&crlf, b"\xEF\xBB\xBF# t\r\n\r\nbody\r\n").unwrap();
        let s = read_source_blocking(&crlf).unwrap();
        assert!(s.bom, "BOM 应被识别");
        assert_eq!(s.eol, "crlf");
        assert!(!s.text.contains('\r'), "文本应规范化为纯 \\n");
        assert_eq!(s.text, "# t\n\nbody\n");
        assert_eq!(s.size, 16);

        let lf = dir.join("lf.md");
        std::fs::write(&lf, "# t\n\nbody\n").unwrap();
        let s2 = read_source_blocking(&lf).unwrap();
        assert!(!s2.bom);
        assert_eq!(s2.eol, "lf");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_round_trip_preserves_crlf_and_bom() {
        let dir = tmp_dir("roundtrip");
        let p = dir.join("a.md");
        let original: &[u8] = b"\xEF\xBB\xBF# \xE6\xA0\x87\xE9\xA2\x98\r\n\r\n\xE6\xAD\xA3\xE6\x96\x87\r\n";
        std::fs::write(&p, original).unwrap();

        // 前端流程：读原文 → 改一处 → 写回（带 eol/bom 标志）
        let s = read_source_blocking(&p).unwrap();
        let edited = s.text.replace("正文", "正文改");
        let r = write_markdown_blocking(&p, &edited, Some(s.mtime_ms), &s.eol, s.bom).unwrap();
        assert_eq!(r.bytes, std::fs::metadata(&p).unwrap().len());

        let back = std::fs::read(&p).unwrap();
        assert!(back.starts_with(&[0xEF, 0xBB, 0xBF]), "BOM 应保留");
        let body = String::from_utf8(back[3..].to_vec()).unwrap();
        assert!(body.contains("\r\n"), "CRLF 应保留");
        assert!(!body.replace("\r\n", "").contains('\n'), "不应出现裸 LF");
        assert!(!body.contains("\r\r"), "不应重复 \\r");
        assert!(body.contains("正文改"), "改动应落盘");

        // 未改动内容字节级一致（除被改的那一处）
        let expect = String::from_utf8_lossy(&original[3..]).replace("正文", "正文改");
        assert_eq!(body, expect);

        // 写回过程不留临时文件
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("fm-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "临时文件应被清理: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_rejects_stale_mtime() {
        let dir = tmp_dir("conflict");
        let p = dir.join("c.md");
        std::fs::write(&p, "v1\n").unwrap();
        let s = read_source_blocking(&p).unwrap();

        // 外部改动（保证 mtime 前进：毫秒精度需要跨过至少 1ms）
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&p, "v2 外部修改\n").unwrap();

        let err = write_markdown_blocking(&p, "v1 我的修改\n", Some(s.mtime_ms), &s.eol, s.bom)
            .unwrap_err();
        assert!(err.starts_with("conflict:"), "应报冲突: {err}");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "v2 外部修改\n", "冲突时不得落盘");

        // 换用最新 mtime 重试成功（覆盖外部修改）
        let cur = mtime_ms(&std::fs::metadata(&p).unwrap());
        write_markdown_blocking(&p, "v3\n", Some(cur), "lf", false).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "v3\n");

        // expect=None（如「另存为」新文件）跳过比对
        write_markdown_blocking(&p, "v4\n", None, "lf", false).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "v4\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn blocks_cover_document_with_sourcepos() {
        let md = "# 标题\n\n段落一\n\n- a\n- b\n\n```rust\nfn a() {}\n```\n";
        let (blocks, toc) = render_blocks(md, Path::new("."), 0, 0);
        assert_eq!(blocks.len(), 4, "顶层块：标题/段落/列表/代码");
        assert_eq!(toc.len(), 1);
        assert_eq!(toc[0].text, "标题");
        assert_eq!(blocks[0].start_line, 1);
        assert_eq!(blocks[0].end_line, 1);
        assert_eq!(blocks[1].start_line, 3);
        assert_eq!(blocks[3].start_line, 8);
        assert_eq!(blocks[3].end_line, 10);
        assert!(blocks[0].html.contains("data-sourcepos=\"1:1-1:"), "{}", blocks[0].html);
        // 与整篇渲染等价：整篇里按序包含每个块的 HTML
        //（整篇多出的块间空行是 comrak 文档级分隔符，对 HTML 渲染无语义影响）
        let (whole, _) = render_document(md, Path::new("."));
        let flat = whole.concat();
        let mut cursor = 0usize;
        for b in &blocks {
            let idx = flat[cursor..]
                .find(&b.html)
                .unwrap_or_else(|| panic!("整篇中未按序包含块: {}", b.html));
            cursor += idx + b.html.len();
        }
    }

    #[test]
    fn blocks_offset_shifts_sourcepos() {
        let (blocks, _) = render_blocks("段落\n", Path::new("."), 10, 0);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].start_line, 11);
        assert_eq!(blocks[0].end_line, 11);
        assert!(
            blocks[0].html.contains("data-sourcepos=\"11:1-11:"),
            "{}",
            blocks[0].html
        );
    }

    /// 块级增量：单块重解析的产物应与整篇解析中该块一致
    #[test]
    fn single_block_reparse_matches_full() {
        let head = "# 标题\n\n第一段\n\n";
        let edited = "第二段 **改**\n";
        let tail = "\n- 列表\n";
        let offset = head.matches('\n').count() as i64;
        let (full, _) = render_blocks(&format!("{head}{edited}{tail}"), Path::new("."), 0, 0);
        let (part, _) = render_blocks(edited, Path::new("."), offset, 0);
        assert_eq!(part.len(), 1);
        let expect = full
            .iter()
            .find(|b| b.start_line == part[0].start_line)
            .expect("整篇中应存在同起点的块");
        assert_eq!(part[0].html, expect.html, "偏移渲染应等于整篇对应块");
        assert_eq!(part[0].end_line, expect.end_line);
    }

    /// 链接引用定义：切片单渲染时引用会失效，挂前缀后必须与整篇一致
    #[test]
    fn slice_with_reference_definition_prefix() {
        let defs = "[ref]: https://example.com \"标题\"\n\n";
        let slice = "见 [文档][ref] 与 [ref][]。\n";
        // 不带前缀：引用解析不出来（说明前缀是必需的）
        let (bare, _) = render_blocks(slice, Path::new("."), 4, 0);
        assert!(!bare[0].html.contains("https://example.com"), "{}", bare[0].html);
        // 带前缀（前缀 2 行，切片首行是全文第 5 行）：行号与整篇一致
        let (with_defs, _) = render_blocks(&format!("{defs}{slice}"), Path::new("."), 4, 2);
        assert_eq!(with_defs.len(), 1, "前缀不产出块");
        assert_eq!(with_defs[0].start_line, 5);
        assert_eq!(with_defs[0].end_line, 5);
        assert!(
            with_defs[0].html.contains("https://example.com"),
            "{}",
            with_defs[0].html
        );
        assert!(
            with_defs[0].html.contains("data-sourcepos=\"5:1-5:"),
            "{}",
            with_defs[0].html
        );
        // 与整篇渲染的对应块一致（整篇里定义占第 3 行，段落在第 5 行）
        let (full, _) = render_blocks(&format!("# 标题\n\n{defs}{slice}"), Path::new("."), 0, 0);
        let expect = full.iter().find(|b| b.start_line == 5).unwrap();
        assert_eq!(with_defs[0].html, expect.html);
    }

    /// 上次被强杀留下的临时文件，会在下一次保存时清掉
    #[test]
    fn write_cleans_stale_temp_files() {
        let dir = tmp_dir("stale");
        let p = dir.join("s.md");
        std::fs::write(&p, "v1\n").unwrap();
        let stale = dir.join(format!(".s.md.fm-tmp-{}", 999_999_999u32));
        let stale_other_pid = dir.join(".s.md.fm-tmp-1234");
        std::fs::write(&stale, "半截内容\n").unwrap();
        std::fs::write(&stale_other_pid, "半截内容\n").unwrap();
        let keep = dir.join("s.md"); // 目标文件本身不能被误删

        write_markdown_blocking(&p, "v2\n", None, "lf", false).unwrap();
        assert!(!stale.exists(), "同名临时文件应被清理");
        assert!(!stale_other_pid.exists(), "其他 pid 的临时文件同样清理");
        assert!(keep.exists());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "v2\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 性能基准（有 2MB 夹具时执行）：整篇渲染 vs 单块切片渲染
    #[test]
    fn perf_render_blocks_2mb() {
        let p = Path::new("../testdata/big/big1.md");
        if !p.exists() {
            eprintln!("跳过：缺少 2MB 夹具 testdata/big/big1.md");
            return;
        }
        let text = std::fs::read_to_string(p).unwrap();
        let t0 = std::time::Instant::now();
        let (blocks, _) = render_blocks(&text, Path::new("."), 0, 0);
        let full = t0.elapsed();
        assert!(blocks.len() > 1000, "块数 {}", blocks.len());

        // 模拟一次按键：取中间一个块做切片重渲染
        let lines: Vec<&str> = text.lines().collect();
        let b = &blocks[blocks.len() / 2];
        let slice = lines[(b.start_line as usize - 1)..(b.end_line as usize)].join("\n");
        let mut best = std::time::Duration::from_secs(9);
        for _ in 0..5 {
            let t1 = std::time::Instant::now();
            let (sb, _) = render_blocks(&slice, Path::new("."), b.start_line as i64 - 1, 0);
            best = best.min(t1.elapsed());
            assert_eq!(sb.len(), 1);
        }
        eprintln!(
            "[perf] 2MB 整篇 render_blocks: {} ms（{} 块，{} 字节）",
            full.as_millis(),
            blocks.len(),
            text.len()
        );
        eprintln!("[perf] 单块切片 render_blocks: {} µs", best.as_micros());
    }
}
