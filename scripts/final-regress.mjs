// 最终回归：覆盖拖拽的全部交互 + 健康断言（不丢面板、模型与 DOM 不脱节）
import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223 });
const { Runtime, Input } = client;
await Runtime.enable();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expr) {
  const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
}
const A = "J:/PigeonYang/FreeMarkdown/testdata/验收样例.md";
const B = "J:/PigeonYang/e-books/让AI帮你学会AI/第8章_草稿.md";

async function drag(from, to) {
  await Input.dispatchMouseEvent({ type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 12; i++) {
    await Input.dispatchMouseEvent({ type: "mouseMoved", x: Math.round(from.x + ((to.x - from.x) * i) / 12), y: Math.round(from.y + ((to.y - from.y) * i) / 12), button: "left", buttons: 1 });
    await sleep(16);
  }
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(550);
}
const S = () =>
  ev(`(() => {
    const api = window.__fm.dock;
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    return { panels: api.panels.length, groups: api.groups.length, domGroups: gvs.length,
             broken: api.groups.some(g => !g.element.isConnected),
             tabsTotal: document.querySelectorAll(".dv-tab").length,
             rects: gvs.map(g => { const r = g.getBoundingClientRect(); return { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; }) };
  })()`);
const ok = (s, expectPanels = 2) => !s.broken && s.panels === expectPanels && s.groups === s.domGroups && s.tabsTotal === s.panels;

/** 两组文档并到一组 */
async function oneGroup() {
  await ev(`(() => { const api = window.__fm.dock; const f = api.groups[0]; for (const g of api.groups.slice(1)) for (const p of [...g.panels]) { try { p.api.moveTo({ group: f, position: "center" }); } catch (e) {} } return 1; })()`);
  await sleep(600);
}
/** 左右两组 */
async function twoGroups() {
  await oneGroup();
  await ev(`(() => { const api = window.__fm.dock; const g = api.groups[0]; const p = g.panels[g.panels.length - 1]; p.api.moveTo({ group: g, position: "right" }); return 1; })()`);
  await sleep(600);
}
const geo = () =>
  ev(`[...document.querySelectorAll(".dv-groupview")].map(g => { const t = g.querySelector(".dv-tab"); const tr = t ? t.getBoundingClientRect() : null; const c = g.querySelector(".dv-content-container").getBoundingClientRect(); return { tab: tr ? { x: Math.round(tr.x + tr.width/2), y: Math.round(tr.y + tr.height/2), text: t.textContent.trim() } : null, c: { l: Math.round(c.left), r: Math.round(c.right), t: Math.round(c.top), b: Math.round(c.bottom) } }; })`);

// 预备：确保两个文档在
await ev(`(() => { window.__fm.openFile(${JSON.stringify(A)}); window.__fm.openFile(${JSON.stringify(B)}); return 1; })()`);
await sleep(900);

const results = [];
async function check(name, expect) {
  const s = await S();
  const pass = ok(s);
  results.push({ name, pass, s });
  console.log(`${pass ? "PASS" : "★ FAIL"}  ${name}  面板 ${s.panels} 组 ${s.groups} DOM组 ${s.domGroups} 标签 ${s.tabsTotal} 脱节=${s.broken}`);
  console.log(`        几何 ${JSON.stringify(s.rects)}${expect ? "  期望 " + expect : ""}`);
}

/** 单分组内第 2 个标签的位置 + 内容区几何 */
const oneGroupInfo = () =>
  ev(`(() => {
    const gv = document.querySelector(".dv-groupview");
    const tabs = [...gv.querySelectorAll(".dv-tab")];
    const c = gv.querySelector(".dv-content-container").getBoundingClientRect();
    const t = tabs[tabs.length - 1].getBoundingClientRect();
    return { tabCount: tabs.length, from: { x: Math.round(t.x + t.width/2), y: Math.round(t.y + t.height/2) },
             c: { l: Math.round(c.left), r: Math.round(c.right), t: Math.round(c.top), b: Math.round(c.bottom) } };
  })()`);

// ① 同组 → 自身右边缘（新安全路径）
await oneGroup();
let g = await oneGroupInfo();
if (g.tabCount < 2) { console.log("★ 前置条件不足：单组内标签不足 2 个"); }
else {
  await drag(g.from, { x: g.c.r - 6, y: Math.round((g.c.t + g.c.b) / 2) });
  await check("① 同组拖到自身右边缘（应左右分屏）", "左右两组");
}

// ② 同组 → 自身底边带
await oneGroup();
g = await oneGroupInfo();
if (g.tabCount >= 2) {
  await drag(g.from, { x: Math.round((g.c.l + g.c.r) / 2), y: g.c.b - 40 });
  await check("② 同组拖到底边带（应上下分屏）", "上下两组");
}

// ③ 跨组边缘
await twoGroups();
g = await geo();
await drag(g[1].tab, { x: g[0].c.l + 6, y: Math.round((g[0].c.t + g[0].c.b) / 2) });
await check("③ 跨组拖到另一组左边缘（应换位）");

// ④ 中央合并
g = await geo();
await drag(g[1].tab, { x: Math.round((g[0].c.l + g[0].c.r) / 2), y: Math.round((g[0].c.t + g[0].c.b) / 2) });
const merged = await S();
const mergePass = ok(merged) && merged.groups === 1;
console.log(`${mergePass ? "PASS" : "★ FAIL"}  ④ 拖到另一组中央（应合并为 1 组）  组 ${merged.groups} 面板 ${merged.panels} 脱节=${merged.broken}`);
results.push({ name: "④ 中央合并", pass: mergePass, s: merged });

// ⑤ 同组排序
const before = await ev(`[...document.querySelectorAll(".dv-tab")].map(t => t.textContent.trim())`);
const tabs = await ev(`[...document.querySelectorAll(".dv-tab")].map(t => { const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })`);
if (tabs.length >= 2) await drag(tabs[1], tabs[0]);
const after = await ev(`[...document.querySelectorAll(".dv-tab")].map(t => t.textContent.trim())`);
const reorderPass = JSON.stringify(before) !== JSON.stringify(after);
console.log(`${reorderPass ? "PASS" : "★ FAIL"}  ⑤ 同组排序  ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
results.push({ name: "⑤ 同组排序", pass: reorderPass });

// 收尾：合并为一组
await oneGroup();
const final = await S();
console.log(`\n收尾：${JSON.stringify(final)}`);
console.log(`\n总计: ${results.filter(r => r.pass).length}/${results.length} 通过` + (results.every(r => r.pass) ? " — 全部通过" : " — 有失败项"));
await client.close();
