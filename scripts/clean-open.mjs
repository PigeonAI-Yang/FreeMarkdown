// 清理测试垃圾面板并重开两个正式文档（用正斜杠路径，避免转义问题）
import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223 });
const { Runtime } = client;
await Runtime.enable();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expr) {
  const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
}
const A = "J:/PigeonYang/FreeMarkdown/testdata/验收样例.md";
const B = "J:/PigeonYang/e-books/让AI帮你学会AI/第8章_草稿.md";

await ev(`(() => { const api = window.__fm.dock; for (const p of [...api.panels]) { try { api.removePanel(p); } catch (e) {} } return 1; })()`);
await sleep(700);
await ev(`(() => {
  window.__fm.openFile(${JSON.stringify(A)});
  window.__fm.openFile(${JSON.stringify(B)});
  const s = window.__fm.appStore.get();
  window.__fm.appStore.set({ recentFiles: s.recentFiles.filter((f) => /^[A-Za-z]:[\\\\/]/.test(f) && f.includes("\\\\")) });
  return 1;
})()`);
await sleep(1200);
console.log(JSON.stringify(await ev(`(() => {
  const api = window.__fm.dock;
  return { panels: api.panels.map((p) => ({ title: p.title, path: p.params.path })), groups: api.groups.length,
           domGroups: document.querySelectorAll(".dv-groupview").length,
           broken: api.groups.some((g) => !g.element.isConnected),
           recents: window.__fm.appStore.get().recentFiles.slice(0, 4) };
})()`), null, 1));
await client.close();
