//! 全文搜索：收集目录下全部 Markdown，rayon 并行扫描，毫秒~秒级返回。

use rayon::prelude::*;
use serde::Serialize;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024; // 单文件上限
const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024; // 扫描总量预算
const MAX_PER_FILE_HITS: usize = 12;
const MAX_TOTAL_HITS: usize = 1000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub line: u64,
    pub snippet: String,
    pub count: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub hits: Vec<SearchHit>,
    pub files_scanned: u32,
    pub files_matched: u32,
    pub elapsed_ms: u128,
    pub truncated: bool,
}

fn dir_should_skip(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | "target" | "dist" | ".git" | ".svn" | ".hg" | ".idea" | "$RECYCLE.BIN"
    ) || name.starts_with('.')
}

fn collect_md_files(root: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut budget: u64 = MAX_TOTAL_BYTES;
    let mut stack = vec![std::path::PathBuf::from(root)];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                let name = e.file_name().to_string_lossy().to_string();
                if !dir_should_skip(&name) {
                    stack.push(p);
                }
            } else if ft.is_file() {
                let is_md = p
                    .extension()
                    .map(|x| {
                        let x = x.to_string_lossy().to_lowercase();
                        x == "md" || x == "markdown"
                    })
                    .unwrap_or(false);
                if !is_md {
                    continue;
                }
                if let Ok(meta) = e.metadata() {
                    let size = meta.len();
                    if size <= MAX_FILE_BYTES && size <= budget {
                        budget -= size;
                        out.push(p.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    out
}

/// 在行内做不区分大小写查找，返回首个匹配的字节位置与匹配次数
fn find_in_line(lower_line: &str, needle: &str) -> Option<(usize, u32)> {
    let mut count = 0u32;
    let mut first = None;
    let mut from = 0usize;
    while let Some(pos) = lower_line[from..].find(needle) {
        let abs = from + pos;
        if first.is_none() {
            first = Some(abs);
        }
        count += 1;
        from = abs + needle.len().max(1);
        if from >= lower_line.len() {
            break;
        }
    }
    first.map(|p| (p, count))
}

/// 截取首个匹配位置前后约 40 字符的片段（按字符边界）
fn make_snippet(line: &str, byte_pos: usize) -> String {
    let mut start = 0usize;
    let mut chars_before = 0usize;
    for (i, _) in line.char_indices() {
        if i >= byte_pos || chars_before >= 40 {
            break;
        }
        start = i;
        chars_before += 1;
    }
    let mut out = String::new();
    if start > 0 || chars_before >= 40 {
        out.push('…');
    }
    let mut taken = 0usize;
    for ch in line[start..].chars() {
        if taken >= 110 {
            out.push('…');
            break;
        }
        out.push(ch);
        taken += ch.len_utf8();
    }
    out
}

fn scan_file(path: &str, needle: &str) -> Option<Vec<SearchHit>> {
    let content = std::fs::read_to_string(path).ok()?;
    let mut hits = Vec::new();
    for (idx, line) in content.lines().enumerate() {
        if hits.len() >= MAX_PER_FILE_HITS {
            break;
        }
        let lower = line.to_lowercase();
        if let Some((pos, count)) = find_in_line(&lower, needle) {
            hits.push(SearchHit {
                path: path.to_string(),
                line: (idx + 1) as u64,
                snippet: make_snippet(line, pos),
                count,
            });
        }
    }
    if hits.is_empty() {
        None
    } else {
        Some(hits)
    }
}

pub fn run(root: &str, query: &str) -> SearchOutcome {
    let t0 = std::time::Instant::now();
    let files = collect_md_files(root);
    let needle = query.to_lowercase();

    let per_file: Vec<Vec<SearchHit>> = if needle.is_empty() {
        Vec::new()
    } else {
        files
            .par_iter()
            .filter_map(|p| scan_file(p, &needle))
            .collect()
    };

    let files_matched = per_file.len() as u32;
    let mut all: Vec<SearchHit> = Vec::new();
    for mut hits in per_file {
        all.append(&mut hits);
    }
    all.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    let truncated = all.len() > MAX_TOTAL_HITS;
    all.truncate(MAX_TOTAL_HITS);

    SearchOutcome {
        hits: all,
        files_scanned: files.len() as u32,
        files_matched,
        elapsed_ms: t0.elapsed().as_millis(),
        truncated,
    }
}

#[tauri::command]
pub async fn search_folder(root: String, query: String) -> Result<SearchOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(run(&root, &query)))
        .await
        .map_err(|e| e.to_string())?
}
