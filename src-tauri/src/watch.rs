//! 常驻文件监听：被打开（阅读或编辑）的文件被外部改动时，向 WebView 广播事件。
//!
//! 分工：Rust 只负责"文件变了"这件事与最新 mtime；是否需要刷新、是否算冲突
//! 由前端按自己持有的 mtime 判断（避免后端猜测 UI 状态）。
//!
//! 实现要点：
//! - 监听**父目录**而不是文件本身：编辑器常见的保存方式是「写临时文件 + rename」，
//!   直接盯文件会在 rename 后失去监听。
//! - 事件去抖 80ms：一次保存往往触发多条事件（Create/Modify/Remove）。
//! - 监听集合按路径引用计数：同一文件被阅读与编辑面板同时打开时只监听一份。
//! - 依赖 notify 8（CC0-1.0，公共领域，符合"只用宽松许可"的项目规则）。

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

/// 事件去抖窗口
const DEBOUNCE: Duration = Duration::from_millis(80);
/// 去抖线程的轮询步长
const TICK: Duration = Duration::from_millis(40);

#[derive(Default)]
struct WatchSet {
    /// 被监听的文件 → 引用计数
    files: HashMap<PathBuf, usize>,
    /// 已监听的目录 → 引用计数
    dirs: HashMap<PathBuf, usize>,
}

pub struct WatchState {
    set: Mutex<WatchSet>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl WatchState {
    pub fn new() -> Self {
        Self {
            set: Mutex::new(WatchSet::default()),
            watcher: Mutex::new(None),
        }
    }
}

fn parent_dir(p: &Path) -> PathBuf {
    p.parent().map(|d| d.to_path_buf()).unwrap_or_else(|| PathBuf::from("."))
}

/// 启动监听线程（进程存活期内常驻，无监听目标时只是空转等消息）
pub fn install(app: &AppHandle) -> Result<WatchState, String> {
    let (tx, rx) = std::sync::mpsc::channel::<PathBuf>();
    let app2 = app.clone();
    std::thread::spawn(move || debounce_loop(app2, rx));

    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            // rename 类事件两个路径都要报（临时文件 → 目标文件）
            for p in ev.paths {
                let _ = tx.send(p);
            }
        }
    })
    .map_err(|e| format!("启动文件监听失败: {e}"))?;

    Ok(WatchState {
        set: Mutex::new(WatchSet::default()),
        watcher: Mutex::new(Some(watcher)),
    })
}

fn debounce_loop(app: AppHandle, rx: Receiver<PathBuf>) {
    let mut pending: HashMap<PathBuf, Instant> = HashMap::new();
    loop {
        match rx.recv_timeout(TICK) {
            Ok(p) => {
                pending.insert(p, Instant::now());
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if pending.is_empty() {
            continue;
        }
        let now = Instant::now();
        let ready: Vec<PathBuf> = pending
            .iter()
            .filter(|(_, t)| now.duration_since(**t) >= DEBOUNCE)
            .map(|(p, _)| p.clone())
            .collect();
        for p in ready {
            pending.remove(&p);
            let (mtime_ms, exists) = match std::fs::metadata(&p) {
                Ok(meta) => (
                    meta.modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0),
                    true,
                ),
                Err(_) => (0, false),
            };
            let _ = app.emit(
                "app:file-changed",
                serde_json::json!({
                    "path": p.to_string_lossy(),
                    "mtimeMs": mtime_ms,
                    "exists": exists,
                }),
            );
        }
    }
}

/// 开始监听（引用计数 +1）
#[tauri::command]
pub fn watch_file(path: String, state: tauri::State<WatchState>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.as_os_str().is_empty() {
        return Err("空路径".into());
    }
    let mut set = state.set.lock().map_err(|e| e.to_string())?;
    let entry = set.files.entry(p.clone()).or_insert(0);
    *entry += 1;
    if *entry > 1 {
        return Ok(()); // 已在监听
    }
    let dir = parent_dir(&p);
    let dir_entry = set.dirs.entry(dir.clone()).or_insert(0);
    *dir_entry += 1;
    if *dir_entry == 1 {
        if let Some(w) = state.watcher.lock().map_err(|e| e.to_string())?.as_mut() {
            w.watch(&dir, RecursiveMode::NonRecursive)
                .map_err(|e| format!("监听目录失败: {e}"))?;
        }
    }
    Ok(())
}

/// 停止监听（引用计数 -1，归零后取消目录监听）
#[tauri::command]
pub fn unwatch_file(path: String, state: tauri::State<WatchState>) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let mut set = state.set.lock().map_err(|e| e.to_string())?;
    if let Some(count) = set.files.get_mut(&p) {
        *count = count.saturating_sub(1);
        if *count == 0 {
            set.files.remove(&p);
        } else {
            return Ok(());
        }
    } else {
        return Ok(());
    }
    let dir = parent_dir(&p);
    let drop_dir = match set.dirs.get_mut(&dir) {
        Some(c) => {
            *c = c.saturating_sub(1);
            *c == 0
        }
        None => false,
    };
    if drop_dir {
        set.dirs.remove(&dir);
        if let Some(w) = state.watcher.lock().map_err(|e| e.to_string())?.as_mut() {
            let _ = w.unwatch(&dir);
        }
    }
    Ok(())
}

/// 监听数量（验收探针用：确认注册/注销成对）
#[tauri::command]
pub fn watch_count(state: tauri::State<WatchState>) -> Result<(usize, usize), String> {
    let set = state.set.lock().map_err(|e| e.to_string())?;
    Ok((set.files.len(), set.dirs.len()))
}
