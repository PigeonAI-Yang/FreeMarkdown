// 复现用户报告：上下分屏时，把「上面」窗格的标签往右拖 → 面板丢失
// 同时打印：DOM 分组顺序 vs api.groups 顺序、落点命中结果、面板移除堆栈
import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223 });
const { Runtime, Input } = client;
await Runtime.enable();
let logs = [];
Runtime.consoleAPICalled((e) =>
  logs.push(e.args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type)).join(" ").slice(0, 400)),
);
Runtime.exceptionThrown((e) => logs.push("EXC: " + String(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text).slice(0, 300)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expr) {
  const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
}

const DOC_A = "J:/PigeonYang/FreeMarkdown/testdata/验收样例.md";
const DOC_B = "J:\\PigeonYang\\e-books\\让AI帮你学会AI\\第8章_草稿.md";

// 安装移除记录（一次性）
await ev(`(() => {
  if (window.__rmInstalled) return 1;
  window.__rmInstalled = true;
  window.__rm = [];
  const api = window.__fm.dock;
  api.onDidRemovePanel((e) => {
    window.__rm.push({ id: String(e.panel && e.panel.id).slice(-24), stack: String(new Error().stack).split("\\n").slice(1, 6).join(" | ") });
    console.warn("[fm] PANEL REMOVED " + e.panel.id);
  });
  return 1;
})()`);

/** 上下堆叠：第一个文档在上，第二个在下 */
async function setupStacked() {
  await ev(`(() => { window.__fm.openFile(${JSON.stringify(DOC_A)}); window.__fm.openFile(${JSON.stringify(DOC_B)}); return 1; })()`);
  await sleep(700);
  await ev(`(() => {
    const api = window.__fm.dock;
    const first = api.groups[0];
    for (const g of api.groups.slice(1)) for (const p of [...g.panels]) { try { p.api.moveTo({ group: first, position: "center" }); } catch {} }
    return api.groups.length;
  })()`);
  await sleep(450);
  await ev(`(() => {
    const api = window.__fm.dock;
    const g = api.groups[0];
    const p = g.panels[g.panels.length - 1];
    p.api.moveTo({ group: g, position: "below" });
    return api.groups.length;
  })()`);
  await sleep(500);
}

const state = () =>
  ev(`(() => {
    const api = window.__fm.dock;
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    return {
      panelIds: api.panels.map(p => p.id.split(/[\\\\/]/).pop()),
      apiGroupOrder: api.groups.map(g => ({ id: g.id, panels: g.panels.map(p => p.id.split(/[\\\\/]/).pop().slice(0, 10)) })),
      domGroupOrder: gvs.map(g => ({ id: null, panels: [...g.querySelectorAll(".dv-tab")].map(t => t.textContent.trim().slice(0, 10)), rect: (r => ({ l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }))(g.getBoundingClientRect()) })),
      topTab: (() => { const t = gvs[0]?.querySelector(".dv-tab")?.getBoundingClientRect(); return t ? { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) } : null; })(),
      topContent: (() => { const c = gvs[0]?.querySelector(".dv-content-container")?.getBoundingClientRect(); return c ? { l: Math.round(c.left), r: Math.round(c.right), t: Math.round(c.top), b: Math.round(c.bottom) } : null; })(),
    };
  })()`);

async function drag(from, to) {
  await Input.dispatchMouseEvent({ type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 12; i++) {
    await Input.dispatchMouseEvent({ type: "mouseMoved", x: Math.round(from.x + ((to.x - from.x) * i) / 12), y: Math.round(from.y + ((to.y - from.y) * i) / 12), button: "left", buttons: 1 });
    await sleep(16);
  }
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(500);
}

await setupStacked();
let s = await state();
console.log("初始（上下堆叠）:");
console.log("  api.groups 顺序:", JSON.stringify(s.apiGroupOrder));
console.log("  DOM 分组顺序  :", JSON.stringify(s.domGroupOrder));
console.log("  上面窗格标签: ", JSON.stringify(s.topTab), " 上窗格内容区:", JSON.stringify(s.topContent));

const targets = [
  { name: "上窗格右边缘(中部)", y: Math.round((s.topContent.t + s.topContent.b) / 2), x: s.topContent.r - 6 },
  { name: "上窗格右边缘(偏上)", y: s.topContent.t + 40, x: s.topContent.r - 6 },
  { name: "上窗格右边缘(偏下)", y: s.topContent.b - 40, x: s.topContent.r - 6 },
];

for (const t of targets) {
  await setupStacked();
  s = await state();
  const before = s.panelIds.length;
  logs = [];
  await ev(`window.__rm = [], 1`);
  await drag(s.topTab, { x: t.x, y: t.y });
  const after = await state();
  // 落点命中复刻（tabdrop.ts 的规则）
  const hit = await ev(`(() => {
    const x = ${t.x}, y = ${t.y};
    const el = document.elementFromPoint(x, y);
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    const gi = gvs.findIndex(g => g === el || g.contains(el));
    const api = window.__fm.dock;
    const box = (gi >= 0 ? gvs[gi] : null)?.querySelector(".dv-content-container")?.getBoundingClientRect();
    const relX = box ? (x - box.left) / box.width : null, relY = box ? (y - box.top) / box.height : null;
    return {
      elCls: el ? String(el.className).slice(0, 30) : null,
      domIndex: gi,
      targetGroupId: gi >= 0 ? api.groups[Math.min(gi, api.groups.length - 1)].id : null,
      targetGroupPanels: gi >= 0 ? api.groups[Math.min(gi, api.groups.length - 1)].panels.map(p => p.id.split(/[\\\\/]/).pop().slice(0, 10)) : null,
      relX: relX === null ? null : +relX.toFixed(2), relY: relY === null ? null : +relY.toFixed(2),
    };
  })()`);
  console.log(`\n--- ${t.name}  落点(${t.x},${t.y}) ---`);
  console.log("  命中:", JSON.stringify(hit));
  console.log(`  面板 ${before} -> ${after.panelIds.length}  ${after.panelIds.length < before ? "★ 丢失" : "OK"}  现有: ${JSON.stringify(after.panelIds)}`);
  console.log("  分组数:", after.apiGroupOrder.length, "| api:", JSON.stringify(after.apiGroupOrder.map(g => g.panels)));
  if (logs.length) console.log("  日志:", JSON.stringify(logs.slice(0, 5)));
  const rm = await ev(`window.__rm`);
  if (rm && rm.length) console.log("  ★ 移除记录:", JSON.stringify(rm));
}
await client.close();
