//! Windows 文件打开桥接：DOM File → ICoreWebView2File::Path。
//!
//! dockview onDidDrop 收到外部文件 drop 后发 `__FM_FILE_OPEN__` 消息
//! （附带 File 对象），本模块在原生层取真实路径并调用现有打开流程。
//! 原生 handler 与 wry IPC handler 共存：对象消息经 WebMessageAsJson
//! 读取，字符串 IPC 消息由 wry 自己处理，互不干扰。

use serde::Deserialize;
use tauri::{Emitter, EventTarget, Manager};

/// 前端桥接消息（WebMessageAsJson 读取）
#[derive(Deserialize)]
struct FileOpenMessage {
    #[serde(rename = "type")]
    kind: String,
    name: String,
    #[serde(rename = "target")]
    drop_target: Option<DropTarget>,
}

#[derive(Deserialize, serde::Serialize)]
struct DropTarget {
    #[serde(rename = "groupId")]
    group_id: Option<String>,
    zone: Option<String>,
}

const OPEN_MESSAGE: &str = "__FM_FILE_OPEN__";

/// 在指定 WebView 上注册消息 handler：取 File 真实路径并打开。
/// 在 app setup（主线程）调用一次；handler 随 WebView 生命周期。
#[cfg(windows)]
pub fn install(
    webview: &tauri::Webview<tauri::Wry>,
    _app: &tauri::AppHandle<tauri::Wry>,
) -> tauri::Result<()> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
        },
        WebMessageReceivedEventHandler,
    };
    use windows::core::Interface;

    let label = webview.label().to_string();
    let app_handle = _app.clone();

    webview.with_webview(move |platform| {
        // SAFETY: with_webview 闭包在 WebView2 所属主线程执行
        let result: windows::core::Result<()> = (|| {
            let controller = platform.controller();
            // SAFETY: 同上
            let webview2 = unsafe { controller.CoreWebView2()? };

            let app_inner = app_handle.clone();
            let label_inner = label.clone();
            let mut token = Default::default();
            // SAFETY: 主线程注册；与 wry IPC handler 共存
            unsafe {
                webview2.add_WebMessageReceived(
                    &WebMessageReceivedEventHandler::create(Box::new(
                        move |_, args| {
                            if let Err(e) =
                                on_web_message(&app_inner, &label_inner, args)
                            {
                                eprintln!("[fileopen] handler error: {e}");
                            }
                            Ok(())
                        },
                    )),
                    &mut token,
                )?;
            }
            // handler 随 WebView 生命周期
            std::mem::forget(token);
            eprintln!("[fileopen] handler registered (label={label})");
            Ok(())
        })();
        if let Err(e) = &result {
            eprintln!("[fileopen] install failed: {e}");
        }
    })?;
    Ok(())
}

/// 单条 WebMessage：只处理 __FM_FILE_OPEN__ 对象消息，取路径后发事件给前端。
#[cfg(windows)]
fn on_web_message(
    app: &tauri::AppHandle<tauri::Wry>,
    label: &str,
    args: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebMessageReceivedEventArgs>,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
    };
    use windows::core::Interface;

    let Some(args) = args else { return Ok(()) };
    // SAFETY: WebMessageReceived 回调在 WebView2 主线程触发，args 当场使用不出逃
    let mut json_ptr = Default::default();
    // SAFETY: 同上
    if unsafe { args.WebMessageAsJson(&mut json_ptr) }.is_err() {
        return Ok(()); // 字符串 IPC 消息（Tauri 自己的），忽略
    }
    let json = take_pwstr(json_ptr);
    let msg: FileOpenMessage = match serde_json::from_str(&json) {
        Ok(m) => m,
        Err(_) => return Ok(()), // 其他 JSON 消息，忽略
    };
    if msg.kind != OPEN_MESSAGE {
        return Ok(());
    }

    let mut paths: Vec<String> = Vec::new();
    let mut error: Option<String> = None;
    // SAFETY: COM 对象在回调线程内当场使用，只复制出路径字符串
    let bridge: windows::core::Result<()> = (|| {
        let args2: ICoreWebView2WebMessageReceivedEventArgs2 =
            unsafe { args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>()? };
        let objects = unsafe { args2.AdditionalObjects()? };
        let mut count = 0u32;
        unsafe { objects.Count(&mut count)? };
        for i in 0..count {
            let value = unsafe { objects.GetValueAtIndex(i)? };
            if let Ok(file) = value.cast::<ICoreWebView2File>() {
                let mut path_ptr = Default::default();
                unsafe { file.Path(&mut path_ptr)? };
                paths.push(take_pwstr(path_ptr));
            }
        }
        Ok(())
    })();
    if let Err(e) = &bridge {
        error = Some(format!("bridge error: {e}"));
    } else if paths.is_empty() {
        error = Some("no file paths".into());
    }
    eprintln!("[fileopen] paths={paths:?} err={error:?}");

    // 复用现有打开流程：发事件给前端（含落点），前端调 openFile
    let target = msg.drop_target;
    let _ = app.emit_to(
        tauri::EventTarget::webview(label.to_string()),
        "app:file-open-resolved",
        serde_json::json!({ "paths": paths, "error": error, "target": target }),
    );
    Ok(())
}

/// PWSTR → Rust String。
#[cfg(windows)]
fn take_pwstr(ptr: windows::core::PWSTR) -> String {
    // SAFETY: WebView2 传出的 PWSTR 以 NUL 结尾，读取后由 COM 释放
    unsafe { ptr.to_string().unwrap_or_default() }
}
