// 定位 dockview 模型/视图脱节（面板消失）的触发条件：
//   1) 单组内 moveTo(自身组, 'below')
//   2) 上下分屏后，把上窗格标签拖到右边缘（用户报告的场景）
// 每次操作后同时报告：api.groups / api.panels / DOM 中的 .dv-groupview 数量
import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223 });
const { Runtime, Input } = client;
await Runtime.enable();
let logs = [];
Runtime.consoleAPICalled((e) => logs.push(e.args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type)).join(" ").slice(0, 200)));
Runtime.exceptionThrown((e) => logs.push("EXC: " + String(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text).slice(0, 200)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expr) {
  const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
}
const DOC_A = "J:/PigeonYang/FreeMarkdown/testdata/验收样例.md";
const DOC_B = "J:\\PigeonYang\\e-books\\让AI帮你学会AI\\第8章_草稿.md";

const report = (label) =>
  ev(`(() => {
    const api = window.__fm.dock;
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    return {
      label: ${JSON.stringify(label)},
      model: { groups: api.groups.length, panels: api.panels.length, groupPanels: api.groups.map(g => g.panels.map(p => p.id.split(/[\\\\/]/).pop().slice(0, 8))) },
      dom: { groupviews: gvs.length, tabs: [...document.querySelectorAll(".dv-tab")].map(t => t.textContent.trim().slice(0, 8)),
             viewContainerChildren: document.querySelector(".dv-view-container") ? document.querySelector(".dv-view-container").children.length : -1 },
      ok: api.groups.length === gvs.length && api.panels.length === document.querySelectorAll(".dv-tab").length,
    };
  })()`);

async function reset2Panels() {
  await ev(`(() => { window.__fm.openFile(${JSON.stringify(DOC_A)}); window.__fm.openFile(${JSON.stringify(DOC_B)}); return 1; })()`);
  await sleep(700);
  await ev(`(() => {
    const api = window.__fm.dock;
    const first = api.groups[0];
    for (const g of api.groups.slice(1)) for (const p of [...g.panels]) { try { p.api.moveTo({ group: first, position: "center" }); } catch {} }
    return api.groups.length;
  })()`);
  await sleep(450);
}

const show = (r) => `模型: ${r.model.groups}组/${r.model.panels}面板 ${JSON.stringify(r.model.groupPanels)} | DOM: ${r.dom.groupviews}个分组视图/${r.dom.tabs.length}标签 ${JSON.stringify(r.dom.tabs)} | ${r.ok ? "一致" : "★ 脱节"}`;

// ---------- 用例 1：单组内 moveTo(自身组, 'below') ----------
await reset2Panels();
console.log("用例1 前:", show(await report("前")));
let err = await ev(`(() => {
  const api = window.__fm.dock;
  const g = api.groups[0];
  const p = g.panels[g.panels.length - 1];
  try { p.api.moveTo({ group: g, position: "below" }); return null; } catch (e) { return String(e && e.message || e); }
})()`);
await sleep(500);
console.log("用例1 后:", show(await report("后")), err ? "moveTo 抛错: " + err : "");
if (logs.length) console.log("   日志:", JSON.stringify(logs.slice(0, 4)));

// ---------- 恢复到干净状态 ----------
await ev(`(() => { window.__fm.dock.clear(); return 1; })()`);
await sleep(400);
await reset2Panels();
console.log("\n恢复后:", show(await report("恢复")));

// ---------- 用例 2：上下分屏后拖上窗格标签到右边缘（用户场景，合成鼠标） ----------
async function makeStacked() {
  await reset2Panels();
  // 拖第 2 个标签到底边带 → 上下堆叠（此前已验证可用）
  const s = await ev(`(() => {
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    const tabs = [...document.querySelectorAll(".dv-tab")];
    const t = tabs[tabs.length - 1].getBoundingClientRect();
    const c = gvs[0].querySelector(".dv-content-container").getBoundingClientRect();
    return { from: { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) }, c: { l: Math.round(c.left), r: Math.round(c.right), t: Math.round(c.top), b: Math.round(c.bottom) } };
  })()`);
  await drag(s.from, { x: Math.round((s.c.l + s.c.r) / 2), y: s.c.b - 40 });
}
async function drag(from, to) {
  await Input.dispatchMouseEvent({ type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 12; i++) {
    await Input.dispatchMouseEvent({ type: "mouseMoved", x: Math.round(from.x + ((to.x - from.x) * i) / 12), y: Math.round(from.y + ((to.y - from.y) * i) / 12), button: "left", buttons: 1 });
    await sleep(16);
  }
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(500);
}

await makeStacked();
let s2 = await report("上下分屏");
console.log("\n用例2 起点:", show(s2));
console.log("   DOM 几何:", JSON.stringify(await ev(`[...document.querySelectorAll(".dv-groupview")].map(g => { const r = g.getBoundingClientRect(); return { t: Math.round(r.top), h: Math.round(r.height), tabs: [...g.querySelectorAll(".dv-tab")].map(t => t.textContent.trim().slice(0, 8)) }; })`)));

const topInfo = await ev(`(() => {
  const gvs = [...document.querySelectorAll(".dv-groupview")];
  const t = gvs[0].querySelector(".dv-tab").getBoundingClientRect();
  const c = gvs[0].querySelector(".dv-content-container").getBoundingClientRect();
  return { from: { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) }, c: { l: Math.round(c.left), r: Math.round(c.right), t: Math.round(c.top), b: Math.round(c.bottom) } };
})()`);

for (const yFrac of [0.5, 0.15, 0.85]) {
  await makeStacked();
  const info = await ev(`(() => {
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    const t = gvs[0].querySelector(".dv-tab").getBoundingClientRect();
    const c = gvs[0].querySelector(".dv-content-container").getBoundingClientRect();
    return { from: { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) }, c: { l: Math.round(c.left), r: Math.round(c.right), t: Math.round(c.top), b: Math.round(c.bottom) } };
  })()`);
  const to = { x: info.c.r - 6, y: Math.round(info.c.t + (info.c.b - info.c.t) * yFrac) };
  const beforeR = await report("前");
  logs = [];
  await drag(info.from, to);
  const afterR = await report("后");
  console.log(`\n用例2 上窗格右边缘 y=${yFrac}  落点(${to.x},${to.y})`);
  console.log("   前:", show(beforeR));
  console.log("   后:", show(afterR), afterR.model.panels < beforeR.model.panels ? "★ 面板丢失" : "");
  if (logs.length) console.log("   日志:", JSON.stringify(logs.slice(0, 4)));
}
await client.close();
