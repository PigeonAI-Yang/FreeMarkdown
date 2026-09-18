// 用户场景回归：上下分屏后，把「上面窗格」的标签往右拖（多个高度），
// 断言面板不丢、模型与 DOM 不脱节。
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
const DOC_A = "J:\\PigeonYang\\FreeMarkdown\\testdata\\验收样例.md";
const DOC_B = "J:\\PigeonYang\\e-books\\让AI帮你学会AI\\第8章_草稿.md";

async function drag(from, to) {
  await Input.dispatchMouseEvent({ type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 12; i++) {
    await Input.dispatchMouseEvent({ type: "mouseMoved", x: Math.round(from.x + ((to.x - from.x) * i) / 12), y: Math.round(from.y + ((to.y - from.y) * i) / 12), button: "left", buttons: 1 });
    await sleep(16);
  }
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(500);
}
const state = () =>
  ev(`(() => {
    const api = window.__fm.dock;
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    return { panels: api.panels.length, groups: api.groups.length, domGroups: gvs.length,
             broken: api.groups.some(g => !g.element.isConnected),
             rects: gvs.map(g => { const r = g.getBoundingClientRect(); return { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; }) };
  })()`);

/** 用鼠标在本分组底边带拖一次，做出上下分屏 */
async function makeStacked() {
  await ev(`(() => { const api = window.__fm.dock; const f = api.groups[0]; for (const g of api.groups.slice(1)) for (const p of [...g.panels]) { try { p.api.moveTo({ group: f, position: "center" }); } catch(e) {} } return api.groups.length; })()`);
  await sleep(400);
  const s = await ev(`(() => {
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    const tabs = [...document.querySelectorAll(".dv-tab")];
    const t = tabs[tabs.length - 1].getBoundingClientRect();
    const c = gvs[0].querySelector(".dv-content-container").getBoundingClientRect();
    return { from: { x: Math.round(t.x + t.width/2), y: Math.round(t.y + t.height/2) }, c: { l: Math.round(c.left), r: Math.round(c.right), t: Math.round(c.top), b: Math.round(c.bottom) } };
  })()`);
  await drag(s.from, { x: Math.round((s.c.l + s.c.r) / 2), y: s.c.b - 40 });
}

await ev(`(() => { window.__fm.openFile(${JSON.stringify(DOC_A)}); window.__fm.openFile(${JSON.stringify(DOC_B)}); return 1; })()`);
await sleep(900);

for (const frac of [0.5, 0.15, 0.85]) {
  await makeStacked();
  const before = await state();
  const info = await ev(`(() => {
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    if (gvs.length < 2) return null;
    const t = gvs[0].querySelector(".dv-tab").getBoundingClientRect();
    const c = gvs[0].querySelector(".dv-content-container").getBoundingClientRect();
    return { topTab: gvs[0].querySelector(".dv-tab").textContent.trim().slice(0, 10),
             from: { x: Math.round(t.x + t.width/2), y: Math.round(t.y + t.height/2) },
             c: { l: Math.round(c.left), r: Math.round(c.right), t: Math.round(c.top), b: Math.round(c.bottom) } };
  })()`);
  if (!info) { console.log(`[y=${frac}] 未能建立上下分屏，跳过`); continue; }
  const to = { x: info.c.r - 8, y: Math.round(info.c.t + (info.c.b - info.c.t) * frac) };
  await drag(info.from, to);
  const after = await state();
  const ok = after.panels >= before.panels && !after.broken && after.groups === after.domGroups;
  console.log(`[y=${frac}] 拖「${info.topTab}」(上窗格) → (${to.x},${to.y})  面板 ${before.panels}→${after.panels} 组 ${before.groups}→${after.groups} DOM组 ${after.domGroups} 脱节=${after.broken}  ${ok ? "PASS" : "★ FAIL"}`);
  console.log(`         几何: ${JSON.stringify(after.rects)}`);
}
await client.close();
