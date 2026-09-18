// 指针拖拽下钻探针：拖拽过程中检查 ghost/预览框是否出现；松手后检查 moveTo 是否生效。
// 判读：
//   ghost 中途出现 + 松手后布局不变 → 断点在 hitTest 或 moveTo
//   ghost 从未出现                   → 断点在 pointerdown 处理（未接管 / panelFromTab 失败）
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

const info = await ev(`(() => {
  const api = window.__fm.dock;
  const t = document.querySelector(".dv-tab");
  const r = t.getBoundingClientRect();
  const g = document.querySelector(".dv-groupview").getBoundingClientRect();
  return {
    tab: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
    group: { x: Math.round(g.x), y: Math.round(g.y), w: Math.round(g.width), h: Math.round(g.height) },
    groups: api.groups.length,
    panelCount: api.panels.length,
  };
})()`);
console.log("before:", JSON.stringify(info));

// 松手前：先测"直接调 moveTo 能否分屏"（dockview 语义基线）
const baseline = await ev(`(() => {
  const api = window.__fm.dock;
  const p = api.panels[0];
  const before = api.groups.length;
  try {
    p.api.moveTo({ group: p.group, position: "right" });
  } catch (e) {
    return { ok: false, err: String(e && e.message || e), before, after: api.groups.length };
  }
  return { ok: true, before, after: api.groups.length };
})()`);
console.log("baseline moveTo(同一分组 right):", JSON.stringify(baseline));
await sleep(400);

const info2 = await ev(`(() => {
  const api = window.__fm.dock;
  const t = document.querySelector(".dv-tab");
  const r = t.getBoundingClientRect();
  const g = document.querySelector(".dv-groupview").getBoundingClientRect();
  return {
    tab: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
    group: { x: Math.round(g.x), y: Math.round(g.y), w: Math.round(g.width), h: Math.round(g.height) },
    groups: api.groups.length,
  };
})()`);
console.log("after baseline:", JSON.stringify(info2));

const from = info2.tab;
const to = { x: info2.group.x + info2.group.w - 4, y: info2.group.y + Math.round(info2.group.h / 2) };
console.log("drag:", JSON.stringify(from), "->", JSON.stringify(to));

// 拖拽中检查 ghost / 预览框
let midStates = [];
await Input.dispatchMouseEvent({ type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
for (let i = 1; i <= 12; i++) {
  const x = Math.round(from.x + ((to.x - from.x) * i) / 12);
  const y = Math.round(from.y + ((to.y - from.y) * i) / 12);
  await Input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "left", buttons: 1 });
  await sleep(16);
  if (i === 4 || i === 10) {
    midStates.push(await ev(`(() => {
      const ghosts = [...document.querySelectorAll("body > div")].filter(d => (d.style && d.style.zIndex) === "9999");
      const inds = [...document.querySelectorAll("body > div")].filter(d => (d.style && d.style.zIndex) === "9998");
      const ind = inds[0];
      return {
        ghosts: ghosts.length,
        ghostText: ghosts[0] ? ghosts[0].textContent : null,
        indCount: inds.length,
        indDisplay: ind ? ind.style.display : null,
        indRect: ind ? { l: ind.style.left, t: ind.style.top, w: ind.style.width, h: ind.style.height } : null,
      };
    })()`));
  }
}
await Input.dispatchMouseEvent({ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
await sleep(350);

console.log("mid-drag states:", JSON.stringify(midStates, null, 1));

// 松手点上的命中判定（复刻 tabdrop.ts 的规则，用于对照）
const hit = await ev(`(() => {
  const x = ${to.x}, y = ${to.y};
  const el = document.elementFromPoint(x, y);
  const host = document.querySelector(".doc-host");
  const gvs = [...document.querySelectorAll(".dv-groupview")];
  const gi = gvs.findIndex(g => g === el || g.contains(el));
  const rect = gi >= 0 ? gvs[gi].getBoundingClientRect() : null;
  const api = window.__fm.dock;
  return {
    elClass: el ? String(el.className).slice(0, 40) : null,
    insideHost: host ? host.contains(el) : null,
    groupIndex: gi,
    apiGroups: api.groups.length,
    rect: rect ? { l: Math.round(rect.left), r: Math.round(rect.right), t: Math.round(rect.top), b: Math.round(rect.bottom) } : null,
    inTab: !!(el && el.closest && el.closest(".dv-tab")),
    geom: rect ? { dxR: Math.round(rect.right - x), dyB: Math.round(rect.bottom - y), dxL: Math.round(x - rect.left), dyT: Math.round(y - rect.top) } : null,
  };
})()`);
console.log("hit at drop point:", JSON.stringify(hit, null, 1));

const after = await ev(`(() => {
  const api = window.__fm.dock;
  return { groups: api.groups.length, detail: api.groups.map(g => g.panels.map(p => p.id.slice(0, 22))) };
})()`);
console.log("after drag:", JSON.stringify(after));
await client.close();
