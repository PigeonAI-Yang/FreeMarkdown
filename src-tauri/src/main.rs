#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod card;
mod filedrop;
mod markdown;
mod search;
mod session;

use std::time::Instant;
use tauri::Manager;

/// 进程起点，用于冷启动计时（main 入口，近似进程启动时刻）
pub fn process_start() -> Instant {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    *START.get_or_init(Instant::now)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    is_md: bool,
}

fn dir_should_skip(name: &str) -> bool {
    matches!(
        name,
        "node_modules" | "target" | "dist" | ".git" | ".svn" | ".hg" | ".idea" | ".vscode" | "$RECYCLE.BIN" | "System Volume Information"
    ) || (name.starts_with('.') && name != "." && name != "..")
}

/// 列出目录内容：目录 + Markdown 文件（文件树懒加载用）
#[tauri::command]
async fn fs_list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<FileEntry> = Vec::new();
        let rd = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if dir_should_skip(&name) {
                    continue;
                }
            } else {
                let is_md = {
                    let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase());
                    matches!(ext.as_deref(), Some("md") | Some("markdown"))
                };
                if !is_md || name.starts_with('.') {
                    continue;
                }
            }
            out.push(FileEntry {
                name,
                path: p.to_string_lossy().into_owned(),
                is_dir,
                is_md: !is_dir,
            });
        }
        out.sort_by(|a, b| {
            b.is_dir.cmp(&a.is_dir).then_with(|| {
                a.name.to_lowercase().cmp(&b.name.to_lowercase())
            })
        });
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn fs_pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    Ok(app
        .dialog()
        .file()
        .set_title("选择文件夹")
        .blocking_pick_folder()
        .map(|p| p.to_string()))
}

#[tauri::command]
fn fs_pick_markdown_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    Ok(app
        .dialog()
        .file()
        .set_title("打开 Markdown 文件")
        .add_filter("Markdown", &["md", "markdown"])
        .blocking_pick_file()
        .map(|p| p.to_string()))
}

/// 用系统默认程序打开外部链接/文件（http/https）
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// 在 Windows 资源管理器中定位文件/目录（explorer /select,"<path>"）
#[tauri::command]
fn fs_reveal(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // /select, 后紧跟引号包裹的完整路径，是 explorer 可靠解析的写法
        //（逗号与路径分开设参在含空格路径下不可靠）
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(())
    }
}

#[tauri::command]
fn startup_ms() -> u128 {
    process_start().elapsed().as_millis()
}

#[tauri::command]
fn perf_log(app: tauri::AppHandle, label: String, ms: u64) {
    use std::io::Write as _;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[perf] {label}: {ms} ms (t={ts})\n");
    eprint!("[perf] {label}: {ms} ms\n");
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("perf.log"))
        {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

fn main() {
    process_start();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(markdown::CacheState::new(64))
        .setup(|app| {
            // Windows 文件打开桥接（DOM File → 原生路径）
            #[cfg(windows)]
            {
                if let Some(w) = app.get_webview_window("main") {
                    let v: &tauri::Webview<_> = w.as_ref();
                    let handle = app.handle().clone();
                    if let Err(e) = filedrop::install(v, &handle) {
                        eprintln!("[fileopen] setup install failed: {e}");
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            markdown::read_markdown,
            fs_list_dir,
            fs_pick_folder,
            fs_pick_markdown_file,
            search::search_folder,
            session::session_save,
            session::session_load,
            open_external,
            fs_reveal,
            startup_ms,
            perf_log,
            card::system_fonts,
            card::card_images_dataurl,
            card::card_pick_save_path,
            card::card_write_file,
            card::card_clipboard_write_png,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
