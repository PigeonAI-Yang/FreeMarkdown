// 带 console 采集的拖拽探针：读取 useTabDrag 内部日志，定位断点。
import CDP from "chrome-remote-interface";
const port = process.env.CDP_PORT || 9223;
const client = await CDP({ port });
const { Runtime, Input } = client;
await Runtime.enable();
const logs = [];
Runtime.consoleAPICalled((e) => {
  const text = e.args.map((a) => (a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : a.description ?? a.type)).join(" ");
  logs.push(text);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expr) {
  const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
}

const info = await ev(`(() => {
  const api = window.__fm.dock;
  const t = document.querySelector(".dv-tab");
  const r = t.getBoundingClientRect();
  const g = t.closest(".dv-groupview").getBoundingClientRect();
  return {
    tab: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: t.textContent.trim().slice(0, 18) },
    group: { x: Math.round(g.x), y: Math.round(g.y), w: Math.round(g.width), h: Math.round(g.height) },
    groups: api.groups.length,
  };
})()`);
console.log("before:", JSON.stringify(info));

const from = { x: info.tab.x, y: info.tab.y };
const to = { x: info.group.x + info.group.w - 4, y: info.group.y + Math.round(info.group.h / 2) };
logs.length = 0;
await Input.dispatchMouseEvent({ type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
for (let i = 1; i <= 12; i++) {
  await Input.dispatchMouseEvent({
    type: "mouseMoved",
    x: Math.round(from.x + ((to.x - from.x) * i) / 12),
    y: Math.round(from.y + ((to.y - from.y) * i) / 12),
    button: "left", buttons: 1,
  });
  await sleep(16);
}
await Input.dispatchMouseEvent({ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
await sleep(400);

console.log("--- console from drag ---");
for (const l of logs) console.log(l);
const after = await ev(`({ groups: window.__fm.dock.groups.length, detail: window.__fm.dock.groups.map(g => g.panels.map(p => p.id.slice(0,22))) })`);
console.log("after:", JSON.stringify(after));
await client.close();
