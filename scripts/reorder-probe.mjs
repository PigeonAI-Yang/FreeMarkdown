// 同组排序测试：把第 2 个标签拖到第 1 个标签上，期望顺序翻转。
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
const order = () =>
  ev(`[...document.querySelectorAll(".dv-tab")].map(t => t.textContent.trim().slice(0, 12))`);

// 先并成一组（若当前是两组）
await ev(`(() => {
  const api = window.__fm.dock;
  if (api.groups.length > 1) {
    const p = api.groups[api.groups.length - 1].panels[0];
    p.api.moveTo({ group: api.groups[0], position: "center" });
  }
  return api.groups.length;
})()`);
await sleep(500);

const before = await order();
const tabs = await ev(`[...document.querySelectorAll(".dv-tab")].map(t => { const r = t.getBoundingClientRect(); return { text: t.textContent.trim().slice(0,12), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })`);
console.log("before:", JSON.stringify(before), JSON.stringify(tabs));
if (tabs.length < 2) { console.log("标签不足 2 个，无法测试排序"); await client.close(); process.exit(0); }

const from = tabs[1];
const to = tabs[0];
await Input.dispatchMouseEvent({ type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
for (let i = 1; i <= 10; i++) {
  await Input.dispatchMouseEvent({ type: "mouseMoved", x: Math.round(from.x + ((to.x - from.x) * i) / 10), y: Math.round(from.y + ((to.y - from.y) * i) / 10), button: "left", buttons: 1 });
  await sleep(16);
}
await Input.dispatchMouseEvent({ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
await sleep(400);
console.log("after :", JSON.stringify(await order()));
await client.close();
