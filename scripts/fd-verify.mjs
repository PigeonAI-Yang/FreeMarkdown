import CDP from "chrome-remote-interface";
// 在页面 bundle 上下文内执行（经由 __fm 暴露的模块作用域不可用，改用 Function 构造经由 vite 预加载的 listen）。
// 实际做法：在页面内动态 import 相对路径的 @tauri-apps/api（vite dev 可解析）。
const client = await CDP({ port: 9223, wait: true });
const { Runtime, Log } = client;
await Log.enable(); await Runtime.enable();
const errors = [];
Log.entryAdded((e) => { if (e.entry.level === "error") errors.push(e.entry.text); });
const evalJs = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }).then(r => {
  if (r.exceptionDetails) throw new Error("EXC:" + JSON.stringify(r.exceptionDetails).slice(0, 150));
  return r.result.value;
});
// vite dev 下 /@fs/ 路径可加载 npm 包；用完整 URL import
await evalJs(`(async () => {
  const m = await import("/node_modules/.pnpm/@tauri-apps+api@2.11.1/node_modules/@tauri-apps/api/dist/event.js");
  window.__fdGot = "none";
  await m.listen("app:file-drop-resolved", (e) => { window.__fdGot = JSON.stringify(e.payload); });
  return "listening";
})()`);
await new Promise(r => setTimeout(r, 500));
await evalJs(`window.chrome.webview.postMessageWithAdditionalObjects({ type: "__FM_FILE_DROP__", version: 1, requestId: "fd-verify-1" }, [])`);
await new Promise(r => setTimeout(r, 2000));
console.log("resolved:", await evalJs("window.__fdGot"));
console.log("console-errors:", JSON.stringify(errors.slice(0, 8)));
client.close();
