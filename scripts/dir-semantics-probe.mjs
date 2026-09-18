// 清理测试垃圾 + 验证原子分屏的方向语义（被拖面板应落在请求的那一侧）
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
const DOC_A = "J:\PigeonYang\FreeMarkdown\testdata\验收样例.md";
const DOC_B = "J:\PigeonYang\e-books\让AI帮你学会AI\第8章_草稿.md";

// 1) 清空所有面板，只重开两个正式文档
await ev(`(() => { const api = window.__fm.dock; for (const p of [...api.panels]) { try { api.removePanel(p); } catch(e) {} } return 1; })()`);
await sleep(600);
await ev(`(() => { window.__fm.openFile(${JSON.stringify(DOC_A)}); window.__fm.openFile(${JSON.stringify(DOC_B)}); return 1; })()`);
await sleep(1000);
console.log("清理+重开:", JSON.stringify(await ev(`(() => { const api = window.__fm.dock; return { panels: api.panels.map(p => p.title), groups: api.groups.length }; })()`)));

for (const dir of ["left", "above", "right", "below"]) {
  // 合并回一个分组
  await ev(`(() => { const api = window.__fm.dock; const f = api.groups[0]; for (const g of api.groups.slice(1)) for (const p of [...g.panels]) { try { p.api.moveTo({ group: f, position: "center" }); } catch(e) {} } return 1; })()`);
  await sleep(600);
  const res = await ev(`(() => {
    const api = window.__fm.dock;
    const g = api.groups[0];
    const p = g.panels[g.panels.length - 1];
    const movedTitle = p.title;
    let ng = null;
    try { ng = api.addGroup({ referenceGroup: g, direction: ${JSON.stringify(dir)} }); } catch (e) { return { err: String(e && e.message || e) }; }
    try { p.api.moveTo({ group: ng, position: "center" }); } catch (e) { return { err: "moveTo " + String(e && e.message || e), movedTitle }; }
    return { movedTitle, newGroupId: ng.id };
  })()`);
  await sleep(800);
  const layout = await ev(`(() => {
    const api = window.__fm.dock;
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    return { dom: gvs.map(g => { const r = g.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), tabs: [...g.querySelectorAll(".dv-tab")].map(x => x.textContent.trim()) }; }),
             groups: api.groups.map(g => g.id + ':' + g.panels.map(p => p.title).join('+')),
             broken: api.groups.some(g => !g.element.isConnected), panels: api.panels.length };
  })()`);
  console.log(`\n方向 ${dir}: 被移动面板=${res.movedTitle}  新组=${res.newGroupId}`);
  console.log("  DOM:", JSON.stringify(layout.dom));
  console.log("  健康:", layout.panels, "面板, broken =", layout.broken);
}
await client.close();
