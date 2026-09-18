// 确定性断言：① 中央=合并 ② 顶边带=向上堆叠分屏（带 PASS/FAIL）
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

/** 重置为「左右两个分组，各组一个文档」 */
async function setupSideBySide() {
  await ev(`(() => {
    const api = window.__fm.dock;
    // 全部并到第一个分组
    const first = api.groups[0];
    for (const g of api.groups.slice(1)) {
      for (const p of [...g.panels]) {
        try { p.api.moveTo({ group: first, position: "center" }); } catch {}
      }
    }
    return api.groups.length;
  })()`);
  await sleep(350);
  await ev(`(() => {
    const api = window.__fm.dock;
    const g = api.groups[0];
    const p = g.panels[g.panels.length - 1];
    p.api.moveTo({ group: g, position: "right" });
    return api.groups.length;
  })()`);
  await sleep(400);
}

async function drag(from, to) {
  await Input.dispatchMouseEvent({ type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 12; i++) {
    await Input.dispatchMouseEvent({ type: "mouseMoved", x: Math.round(from.x + ((to.x - from.x) * i) / 12), y: Math.round(from.y + ((to.y - from.y) * i) / 12), button: "left", buttons: 1 });
    await sleep(16);
  }
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(420);
}

/** 第 2 个分组（DOM 顺序）里的标签中心 */
const rightTab = () =>
  ev(`(() => {
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    const t = gvs[1].querySelector(".dv-tab").getBoundingClientRect();
    const c = gvs[0].querySelector(".dv-content-container").getBoundingClientRect();
    return {
      from: { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) },
      content0: { l: Math.round(c.left), r: Math.round(c.right), t: Math.round(c.top), b: Math.round(c.bottom) },
    };
  })()`);

const state = () =>
  ev(`(() => {
    const api = window.__fm.dock;
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    return {
      groups: api.groups.length,
      rects: gvs.map(g => { const r = g.getBoundingClientRect(); return { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; }),
      tabs: gvs.map(g => ({ y: Math.round(g.querySelector(".dv-tab").getBoundingClientRect().top), text: g.querySelector(".dv-tab").textContent.trim().slice(0, 12) })),
    };
  })()`);

// ---- ① 中央合并 ----
await setupSideBySide();
let info = await rightTab();
await drag(info.from, { x: Math.round((info.content0.l + info.content0.r) / 2), y: Math.round((info.content0.t + info.content0.b) / 2) });
let s = await state();
console.log("① 中央落点 → 分组数:", s.groups, s.groups === 1 ? "PASS（已合并）" : `FAIL（期望 1）`, JSON.stringify(s.rects));

// ---- ② 顶边带（向上分屏） ----
await setupSideBySide();
info = await rightTab();
const topY = info.content0.t + Math.round((info.content0.b - info.content0.t) * 0.1);
await drag(info.from, { x: Math.round((info.content0.l + info.content0.r) / 2), y: topY });
s = await state();
const stacked = s.groups === 2 && s.rects[0].t === s.rects[1].t ? false : s.rects[0].w === s.rects[1].w && s.rects[0].h < s.rects[1].h * 2;
const draggedOnTop = s.tabs[0] ? s.tabs[0].y < s.tabs[1].y : false;
console.log("② 顶边带落点 → 分组数:", s.groups, "几何:", JSON.stringify(s.rects));
console.log("   ", s.groups === 2 && stacked ? "PASS（上下堆叠）" : "FAIL（期望上下堆叠）", "| 被拖面板在上:", draggedOnTop ? "PASS" : "FAIL", JSON.stringify(s.tabs));

// ---- 收尾：并回单个分组 ----
await ev(`(() => {
  const api = window.__fm.dock;
  const first = api.groups[0];
  for (const g of api.groups.slice(1)) for (const p of [...g.panels]) { try { p.api.moveTo({ group: first, position: "center" }); } catch {} }
  return api.groups.length;
})()`);
await sleep(400);
console.log("收尾：合并为", await ev(`window.__fm.dock.groups.length`), "个分组；标签:", JSON.stringify(await ev(`[...document.querySelectorAll(".dv-tab")].map(t => t.textContent.trim())`)));
await client.close();
