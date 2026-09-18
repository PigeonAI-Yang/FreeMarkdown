// 清理测试垃圾 + 归一化重复面板，然后跑一遍关键回归
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
const GOOD = "J:\\PigeonYang\\FreeMarkdown\\testdata\\验收样例.md";
const GOOD2 = "J:\\PigeonYang\\e-books\\让AI帮你学会AI\\第8章_草稿.md";

// 1) 关掉所有面板，按规范路径重开两个文档
await ev(`(() => { const api = window.__fm.dock; for (const p of [...api.panels]) { try { api.removePanel(p); } catch(e) {} } return api.panels.length; })()`);
await sleep(500);
await ev(`(() => {
  const s = window.__fm.appStore.get();
  window.__fm.appStore.set({ recentFiles: s.recentFiles.filter(f => !/PigeonYange-books|FreeMarkdown\\\\testdata验收/.test(f)) });
  window.__fm.openFile(${JSON.stringify(GOOD)});
  window.__fm.openFile(${JSON.stringify(GOOD2)});
  return 1;
})()`);
await sleep(1200);
console.log("清理后:", JSON.stringify(await ev(`(() => { const api = window.__fm.dock; return { panels: api.panels.map(p => p.id), groups: api.groups.length, domGroups: document.querySelectorAll('.dv-groupview').length }; })()`)));

// 2) 归一化验证：同一文件用不同分隔符打开，不应新增标签
const norm = await ev(`(() => {
  const api = window.__fm.dock;
  const before = api.panels.length;
  window.__fm.openFile('J:/PigeonYang/FreeMarkdown/testdata/验收样例.md');
  return { before, after: api.panels.length };
})()`);
console.log("归一化验证（正斜杠打开已存在的反斜杠路径）:", JSON.stringify(norm), norm.before === norm.after ? "PASS" : "FAIL");

// 3) 回归：合并 / 顶边带分屏 / 同组排序
async function drag(from, to) {
  const { Input } = client;
  await Input.dispatchMouseEvent({ type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 12; i++) {
    await Input.dispatchMouseEvent({ type: "mouseMoved", x: Math.round(from.x + ((to.x - from.x) * i) / 12), y: Math.round(from.y + ((to.y - from.y) * i) / 12), button: "left", buttons: 1 });
    await sleep(16);
  }
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(500);
}
const layout = () =>
  ev(`(() => {
    const api = window.__fm.dock;
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    return { groups: api.groups.length, domGroups: gvs.length, panels: api.panels.length,
             rects: gvs.map(g => { const r = g.getBoundingClientRect(); return { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; }),
             tabs: gvs.map(g => [...g.querySelectorAll(".dv-tab")].map(t => t.textContent.trim().slice(0, 10))) };
  })()`);

const setup = async () => {
  await ev(`(() => { const api = window.__fm.dock; const f = api.groups[0]; for (const g of api.groups.slice(1)) for (const p of [...g.panels]) { try { p.api.moveTo({ group: f, position: "center" }); } catch(e) {} } return api.groups.length; })()`);
  await sleep(400);
  await ev(`(() => { const api = window.__fm.dock; const g = api.groups[0]; const p = g.panels[g.panels.length - 1]; p.api.moveTo({ group: g, position: "right" }); return api.groups.length; })()`);
  await sleep(450);
};

const gvs = () => ev(`[...document.querySelectorAll(".dv-groupview")].map(g => { const t = g.querySelector(".dv-tab").getBoundingClientRect(); const c = g.querySelector(".dv-content-container").getBoundingClientRect(); return { tab: { x: Math.round(t.x + t.width/2), y: Math.round(t.y + t.height/2) }, c: { l: Math.round(c.left), r: Math.round(c.right), t: Math.round(c.top), b: Math.round(c.bottom) } }; })`);

// ① 中央合并
await setup();
let g = await gvs();
await drag(g[1].tab, { x: Math.round((g[0].c.l + g[0].c.r) / 2), y: Math.round((g[0].c.t + g[0].c.b) / 2) });
let L = await layout();
console.log("\n① 中央落点 →", L.groups === 1 ? "PASS 合并为 1 组" : "FAIL", JSON.stringify(L.rects));

// ② 顶边带 → 上下堆叠
await setup();
g = await gvs();
await drag(g[1].tab, { x: Math.round((g[0].c.l + g[0].c.r) / 2), y: g[0].c.t + Math.round((g[0].c.b - g[0].c.t) * 0.1) });
L = await layout();
const stacked = L.rects.length === 2 && Math.abs(L.rects[0].h - L.rects[1].h) < 40 && L.rects[0].t !== L.rects[1].t;
console.log("② 顶边带 →", stacked ? "PASS 上下堆叠" : "FAIL", JSON.stringify(L.rects), "面板数", L.panels);

// ③ 同组排序
await ev(`(() => { const api = window.__fm.dock; const f = api.groups[0]; for (const gr of api.groups.slice(1)) for (const p of [...gr.panels]) { try { p.api.moveTo({ group: f, position: "center" }); } catch(e) {} } return 1; })()`);
await sleep(450);
const orderBefore = await ev(`[...document.querySelectorAll(".dv-tab")].map(t => t.textContent.trim().slice(0, 10))`);
const tabs2 = await ev(`[...document.querySelectorAll(".dv-tab")].map(t => { const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })`);
if (tabs2.length >= 2) await drag(tabs2[1], tabs2[0]);
const orderAfter = await ev(`[...document.querySelectorAll(".dv-tab")].map(t => t.textContent.trim().slice(0, 10))`);
console.log("③ 同组排序 →", JSON.stringify(orderBefore), "→", JSON.stringify(orderAfter), orderBefore.join() !== orderAfter.join() ? "PASS" : "FAIL");

// 收尾：合并为一个分组
await ev(`(() => { const api = window.__fm.dock; const f = api.groups[0]; for (const gr of api.groups.slice(1)) for (const p of [...gr.panels]) { try { p.api.moveTo({ group: f, position: "center" }); } catch(e) {} } return 1; })()`);
await sleep(500);
console.log("\n收尾:", JSON.stringify(await layout()));
await client.close();
