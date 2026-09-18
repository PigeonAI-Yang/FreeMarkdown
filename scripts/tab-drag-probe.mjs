// 标签拖拽探针：用 CDP 合成鼠标事件驱动真实应用，逐段记录事件链。
// CDP 鼠标事件不会启动 OS 原生拖拽会话（DoDragDrop），因此若此实验成功
// 而真实鼠标失败，说明差异出在"原生 HTML5 拖拽会话夺走了 pointer 事件"。
//   node scripts/tab-drag-probe.mjs
import CDP from "chrome-remote-interface";

const port = process.env.CDP_PORT || 9223;

const client = await CDP({ port });
const { Runtime, Input, Log } = client;
await Runtime.enable();
await Log.enable().catch(() => {});
const errors = [];
Log.entryAdded((e) => {
  if (e.entry.level === "error") errors.push(e.entry.text.slice(0, 300));
});
Runtime.exceptionThrown((e) =>
  errors.push("EXC " + (e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text ?? "").slice(0, 300)),
);

async function ev(expr) {
  const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 安装事件记录器（捕获阶段，记录 pointer 与 drag 两类事件）
await ev(`(() => {
  if (!window.__dg) {
    window.__dg = [];
    window.__dgOn = true;
    const rec = (type) => (e) => {
      if (window.__dg.length > 600) return;
      window.__dg.push({
        t: type,
        ms: Math.round(performance.now()),
        x: Math.round(e.clientX || 0),
        y: Math.round(e.clientY || 0),
        cls: String(e.target && e.target.className || "").slice(0, 48),
        prevented: e.defaultPrevented,
      });
    };
    for (const t of ["pointerdown","pointermove","pointerup","mousedown","mousemove","mouseup","dragstart","drag","dragenter","dragover","drop","dragend"]) {
      window.addEventListener(t, rec(t), true);
    }
  }
  window.__dg = [];
  return true;
})()`);

// 2) 现场信息：标签 DOM / draggable 属性 / 分组
const before = await ev(`(() => {
  const api = window.__fm && window.__fm.dock;
  const tabs = [...document.querySelectorAll(".dv-tab")];
  return {
    groups: api ? api.groups.length : -1,
    panels: api ? api.panels.map(p => p.id) : [],
    groupDetail: api ? api.groups.map(g => ({ id: g.id.slice(0,10), panels: g.panels.map(p => p.id.slice(0,26)) })) : [],
    tabs: tabs.map(t => {
      const r = t.getBoundingClientRect();
      return {
        text: t.textContent.trim().slice(0, 18),
        draggable: t.getAttribute("draggable"),
        outer: t.outerHTML.slice(0, 90),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      };
    }),
    groupRects: [...document.querySelectorAll(".dv-groupview")].map(g => {
      const r = g.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }),
  };
})()`);
console.log("=== BEFORE ===");
console.log(JSON.stringify(before, null, 1));

if (before.tabs.length < 1) {
  console.log("!! 没有标签，先打开文档再跑（cdp.mjs open <path>）");
  await client.close();
  process.exit(0);
}

async function mouseDrag(from, to, label) {
  await ev(`window.__dg = [], 1`);
  await Input.dispatchMouseEvent({ type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    await Input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "left", buttons: 1 });
    await sleep(16);
  }
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(220);
  const log = await ev(`(() => {
    const g = window.__dg;
    const counts = {};
    for (const e of g) counts[e.t] = (counts[e.t] || 0) + 1;
    const head = g.slice(0, 6);
    const tail = g.slice(-8);
    const drags = g.filter(e => e.t.startsWith("drag") || e.t === "drop");
    return { total: g.length, counts, head, tail, dragEvents: drags.slice(0, 8) };
  })()`);
  const after = await ev(`(() => {
    const api = window.__fm && window.__fm.dock;
    return {
      groups: api ? api.groups.length : -1,
      groupDetail: api ? api.groups.map(g => ({ id: g.id.slice(0,10), panels: g.panels.map(p => p.id.slice(0,26)) })) : [],
      ghostLeft: document.querySelectorAll('body > div[style*="9999"]').length,
    };
  })()`);
  console.log(`\n=== EXP ${label} ===`);
  console.log("event counts:", JSON.stringify(log.counts));
  console.log("first events:", JSON.stringify(log.head));
  console.log("last events :", JSON.stringify(log.tail));
  console.log("drag events :", JSON.stringify(log.dragEvents));
  console.log("after      :", JSON.stringify(after));
  console.log("errors     :", JSON.stringify(errors.slice(-6)));
}

const t0 = before.tabs[0];
const tabCenter = { x: t0.rect.x + t0.rect.w / 2, y: t0.rect.y + t0.rect.h / 2 };

// 实验 1：拖到本分组右侧边缘 → 期望分屏（groups +1）
if (before.groupRects.length) {
  const g = before.groupRects[0];
  await mouseDrag(tabCenter, { x: g.x + g.w - 3, y: g.y + g.h / 2 }, "1 拖到右边缘(期望分屏)");
}

// 实验 2：若有第二个标签，拖到另一个标签上 → 期望排序/并入
const info2 = await ev(`(() => {
  const api = window.__fm && window.__fm.dock;
  const tabs = [...document.querySelectorAll(".dv-tab")].map(t => { const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), text: t.textContent.trim().slice(0,18) }; });
  return { tabs, groups: api ? api.groups.length : -1, panelOrder: api ? api.panels.map(p => p.id.slice(0,24)) : [] };
})()`);
console.log("\n=== 现场（实验1后）===");
console.log(JSON.stringify(info2, null, 1));

if (info2.tabs.length >= 2) {
  await mouseDrag(info2.tabs[0], info2.tabs[1], "2 拖到第二个标签(期望排序/并入)");
}

await client.close();
