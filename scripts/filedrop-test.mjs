import CDP from "chrome-remote-interface";
// 阶段 B 最小验证：监听 app:file-drop-resolved + 控制台错误，
// 用合成 drop（带 DataTransfer.files mock）触发桥接 —— 注意：
// 合成事件的 files 为空会提前 return；本脚本验证“无文件时不误触发 + 无新增错误”。
// 真文件拖拽必须由用户真鼠标完成（CDP 无法构造 OS 级 CF_HDROP）。
const client = await CDP({ port: 9223, wait: true });
const { Runtime, Log } = client;
await Log.enable(); await Runtime.enable();
const errors = [];
Log.entryAdded((e) => { if (e.entry.level === "error") errors.push(e.entry.text); });
Runtime.exceptionThrown((e) => errors.push("EXC: " + (e.exceptionDetails?.text ?? "")));
const evalJs = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }).then(r => {
  if (r.exceptionDetails) throw new Error("eval fail");
  return r.result.value;
});
// 注册 resolved 监听
await evalJs(`window.__fdResolved = null; (async () => { const { listen } = await import("@tauri-apps/api/event"); await listen("app:file-drop-resolved", (e) => { window.__fdResolved = JSON.stringify(e.payload); }); })()`);
await new Promise(r => setTimeout(r, 500));
// 发送对象消息（模拟前端桥接发送路径，但无 AdditionalObjects）
await evalJs(`window.chrome.webview.postMessageWithAdditionalObjects({ type: "__FM_FILE_DROP__", version: 1, requestId: "fd-test-1" }, [])`);
await new Promise(r => setTimeout(r, 1500));
console.log("resolved:", await evalJs("window.__fdResolved"));
console.log("console-errors:", JSON.stringify(errors.slice(0, 5)));
// 普通 invoke 仍正常
console.log("invoke-ok:", await evalJs(`(async () => { const { invoke } = await import("@tauri-apps/api/core"); try { await invoke("startup_ms"); return true; } catch { return false; } })()`));
client.close();
