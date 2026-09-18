// 微探针：onWillDragPanel 是否触发？在其上调用 nativeEvent.preventDefault() 能否取消原生拖拽会话？
// 判读：
//   fired>0 且 仍有 drag/drop 事件  → preventDefault 无效（dockview/WebView2 语义问题）
//   fired>0 且 无 drag/drop 事件    → preventDefault 有效（说明线上处理器根本没跑）
//   fired==0                        → 事件根本没触发（注册/接线问题）
import CDP from "chrome-remote-interface";
const port = process.env.CDP_PORT || 9223;
const client = await CDP({ port });
const { Runtime, Input, Log } = client;
await Runtime.enable();
await Log.enable().catch(() => {});
const errors = [];
Log.entryAdded((e) => { if (e.entry.level === "error") errors.push(e.entry.text.slice(0, 240)); });
Runtime.exceptionThrown((e) => errors.push("EXC " + String(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text).slice(0, 240)));

async function ev(expr) {
  const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 注册测量用 handler：记录是否触发 + 在 nativeEvent 上调 preventDefault
const reg = await ev(`(() => {
  window.__probe = { fired: 0, fields: null, hasNative: null, preventCalls: 0, err: null, nativeType: null };
  const api = window.__fm && window.__fm.dock;
  if (!api) { window.__probe.err = "no api"; return window.__probe; }
  try {
    api.onWillDragPanel((e) => {
      window.__probe.fired++;
      window.__probe.fields = e && typeof e === "object" ? Object.keys(e) : null;
      try {
        window.__probe.hasNative = !!(e && e.nativeEvent);
        window.__probe.nativeType = e && e.nativeEvent ? e.nativeEvent.type : null;
        e.nativeEvent.preventDefault();
        window.__probe.preventCalls++;
      } catch (err) { window.__probe.err = String((err && err.message) || err); }
    });
  } catch (err) { window.__probe.err = "register: " + String((err && err.message) || err); }
  return window.__probe;
})()`);
console.log("register:", JSON.stringify(reg));

// 2) 现场：标签位置
const info = await ev(`(() => {
  const api = window.__fm.dock;
  const tabs = [...document.querySelectorAll(".dv-tab")].map(t => {
    const r = t.getBoundingClientRect();
    return { text: t.textContent.trim().slice(0,16), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  });
  const groups = [...document.querySelectorAll(".dv-groupview")].map(g => {
    const r = g.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  return { tabs, groups: api.groups.length, groupRects: groups, panels: api.panels.map(p=>p.id.slice(0,26)) };
})()`);
console.log("before:", JSON.stringify(info, null, 1));

if (!info.tabs.length || !info.groupRects.length) { console.log("无标签/分组，先打开文档"); await client.close(); process.exit(0); }

await ev(`window.__dg = [], 1`);
const from = info.tabs[0];
const g = info.groupRects[0];
const to = { x: Math.round(g.x + g.w - 4), y: Math.round(g.y + g.h / 2) };

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
await sleep(300);

const res = await ev(`(() => {
  const api = window.__fm.dock;
  const counts = {};
  for (const e of (window.__dg || [])) counts[e.t] = (counts[e.t] || 0) + 1;
  return {
    probe: window.__probe,
    counts,
    sampleDrag: (window.__dg || []).filter(e => e.t === "dragstart" || e.t === "drop" || e.t === "dragend").slice(0, 6),
    groups: api.groups.length,
    panelOrder: api.groups.map(gr => gr.panels.map(p => p.id.slice(0,24))),
  };
})()`);
console.log("RESULT:", JSON.stringify(res, null, 1));
console.log("errors:", JSON.stringify(errors.slice(-5)));
await client.close();
