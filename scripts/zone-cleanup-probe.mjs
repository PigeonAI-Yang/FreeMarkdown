// 验证两项修复：
//   ① 上下分屏判定：把标签拖到目标窗格内容区「底边带」的正中，应判定为 bottom（堆叠分屏）
//   ② 覆盖层兜底清理：拖拽中松手事件丢失（模拟在窗口外松手）后，ghost/预览框必须自行消失
import CDP from "chrome-remote-interface";
const port = process.env.CDP_PORT || 9223;
const client = await CDP({ port });
const { Runtime, Input } = client;
await Runtime.enable();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expr) {
  const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
}
const overlays = () =>
  ev(`(() => {
    const g = [...document.querySelectorAll("body > div")].filter(d => d.style && d.style.zIndex === "9999").length;
    const i = [...document.querySelectorAll("body > div")].filter(d => d.style && d.style.zIndex === "9998").length;
    return { ghost: g, indicator: i };
  })()`);
const geom = () =>
  ev(`[...document.querySelectorAll(".dv-groupview")].map(g => { const r = g.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })`);

// 准备：确保是两个左右并排的分组
await ev(`(() => {
  const api = window.__fm.dock;
  if (api.groups.length < 2) {
    const p = api.panels[api.panels.length - 1];
    p.api.moveTo({ group: api.groups[0], position: "right" });
  }
  return api.groups.length;
})()`);
await sleep(500);
console.log("初始几何:", JSON.stringify(await geom()));

// ---- ① 底边带判定 ----
const info = await ev(`(() => {
  const api = window.__fm.dock;
  const gvs = [...document.querySelectorAll(".dv-groupview")];
  const tabEls = gvs.map(g => g.querySelector(".dv-tab"));
  const t1 = tabEls[1].getBoundingClientRect();
  const c0 = gvs[0].querySelector(".dv-content-container").getBoundingClientRect();
  return {
    from: { x: Math.round(t1.x + t1.width / 2), y: Math.round(t1.y + t1.height / 2) },
    content0: { l: Math.round(c0.left), r: Math.round(c0.right), t: Math.round(c0.top), b: Math.round(c0.bottom) },
    groups: api.groups.length,
  };
})()`);
// 目标点：内容区底边带正中（bottom 带 = 高度的 20%，取距底 40px 处）
const to = { x: Math.round((info.content0.l + info.content0.r) / 2), y: info.content0.b - 40 };
console.log("拖拽:", JSON.stringify(info.from), "->", JSON.stringify(to));

await Input.dispatchMouseEvent({ type: "mousePressed", x: info.from.x, y: info.from.y, button: "left", buttons: 1, clickCount: 1 });
for (let i = 1; i <= 12; i++) {
  await Input.dispatchMouseEvent({
    type: "mouseMoved",
    x: Math.round(info.from.x + ((to.x - info.from.x) * i) / 12),
    y: Math.round(info.from.y + ((to.y - info.from.y) * i) / 12),
    button: "left", buttons: 1,
  });
  await sleep(16);
}
const ind = await ev(`(() => {
  const i = [...document.querySelectorAll("body > div")].find(d => d.style && d.style.zIndex === "9998");
  if (!i) return null;
  const r = i.getBoundingClientRect();
  return { display: i.style.display, l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
})()`);
console.log("拖拽中预览框:", JSON.stringify(ind), " (期望：覆盖下半部分)");
await Input.dispatchMouseEvent({ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
await sleep(400);
console.log("松手后几何:", JSON.stringify(await geom()), " (期望：上下堆叠)");
console.log("松手后覆盖层:", JSON.stringify(await overlays()), " (期望 ghost=0 indicator=0)");

// ---- ② 松手事件丢失时的兜底清理 ----
const info2 = await ev(`(() => {
  const t = document.querySelector(".dv-tab").getBoundingClientRect();
  return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
})()`);
await Input.dispatchMouseEvent({ type: "mousePressed", x: info2.x, y: info2.y, button: "left", buttons: 1, clickCount: 1 });
for (let i = 1; i <= 5; i++) {
  await Input.dispatchMouseEvent({ type: "mouseMoved", x: info2.x + i * 20, y: info2.y + i * 12, button: "left", buttons: 1 });
  await sleep(16);
}
console.log("拖拽中覆盖层:", JSON.stringify(await overlays()), " (期望 ghost=1 indicator=1)");
// 只发一个「按钮已松开」的移动事件，不发 mouseReleased —— 模拟松手事件丢失
await Input.dispatchMouseEvent({ type: "mouseMoved", x: info2.x + 130, y: info2.y + 90, button: "left", buttons: 0 });
await sleep(200);
console.log("丢失松手后覆盖层:", JSON.stringify(await overlays()), " (期望 ghost=0 indicator=0)");
await Input.dispatchMouseEvent({ type: "mouseReleased", x: info2.x + 130, y: info2.y + 90, button: "left", buttons: 0, clickCount: 1 });
await sleep(200);
console.log("收尾几何:", JSON.stringify(await geom()));
await client.close();
