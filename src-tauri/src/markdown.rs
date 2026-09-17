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
fn rewrite_assets(html: &str, base_dir: &Path) -> String {
    let img_re = Regex::new(r#"<img\s([^>]*?)/?>"#).unwrap();
    let src_re = Regex::new(r#"src="([^"]*)""#).unwrap();
    let a_re = Regex::new(r#"<a\s([^>]*?)>"#).unwrap();
    let href_re = Regex::new(r#"href="([^"]*)""#).unwrap();

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
