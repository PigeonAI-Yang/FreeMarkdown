// 用户场景复现（干净页面 + 全走应用自身路径，不手写 moveTo 参数）：
//   上下分屏 → 把上面窗格的标签往右拖 → 观察面板是否丢失 / 模型与 DOM 是否脱节
import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223 });
const { Runtime, Input, Page } = client;
await Runtime.enable();
await Page.enable();
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

async function reload() {
  await Page.reload({ ignoreCache: true });
  await sleep(6000);
  // 安装移除记录
  await ev(`(() => {
    if (window.__rmInstalled) return 1;
    window.__rmInstalled = true;
    window.__rm = [];
    window.__fm.dock.onDidRemovePanel((e) => window.__rm.push({ id: String(e.panel && e.panel.id).slice(-22), stack: String(new Error().stack).split("\\n").slice(1, 5).join(" | ") }));
    return 1;
  })()`);
}

const report = (label) =>
  ev(`(() => {
    const api = window.__fm.dock;
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    return {
      label: ${JSON.stringify(label)},
      groups: api.groups.length,
      panels: api.panels.length,
      groupPanels: api.groups.map(g => g.panels.map(p => p.id.split(/[\\\\/]/).pop().slice(0, 8))),
      domGroups: gvs.length,
      domTabs: [...document.querySelectorAll(".dv-tab")].map(t => t.textContent.trim().slice(0, 8)),
      domGeom: gvs.map(g => { const r = g.getBoundingClientRect(); return { t: Math.round(r.top), h: Math.round(r.height) }; }),
    };
  })()`);
const show = (r) => `模型 ${r.groups}组/${r.panels}面板 ${JSON.stringify(r.groupPanels)} | DOM ${r.domGroups}组 ${JSON.stringify(r.domTabs)} ${JSON.stringify(r.domGeom)} | ${r.groups === r.domGroups && r.panels === r.domTabs.length ? "一致" : "★ 脱节"}`;

async function drag(from, to) {
  await Input.dispatchMouseEvent({ type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 12; i++) {
    await Input.dispatchMouseEvent({ type: "mouseMoved", x: Math.round(from.x + ((to.x - from.x) * i) / 12), y: Math.round(from.y + ((to.y - from.y) * i) / 12), button: "left", buttons: 1 });
    await sleep(16);
  }
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(500);
}

/** 用鼠标在本分组底边带拖一次 → 上下分屏（全程应用自身路径） */
async function makeStackedByMouse() {
  await ev(`(() => {
    const api = window.__fm.dock;
    const first = api.groups[0];
    for (const g of api.groups.slice(1)) for (const p of [...g.panels]) { try { p.api.moveTo({ group: first, position: "center" }); } catch {} }
    return api.groups.length;
  })()`);
  await sleep(450);
  const s = await ev(`(() => {
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    const tabs = [...document.querySelectorAll(".dv-tab")];
    const t = tabs[tabs.length - 1].getBoundingClientRect();
    const c = gvs[0].querySelector(".dv-content-container").getBoundingClientRect();
    return { from: { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) }, c: { l: Math.round(c.left), r: Math.round(c.right), t: Math.round(c.top), b: Math.round(c.bottom) } };
  })()`);
  if (!s || !s.from) return null;
  await drag(s.from, { x: Math.round((s.c.l + s.c.r) / 2), y: s.c.b - 40 });
  return s;
}

await reload();
await ev(`(() => { window.__fm.openFile(${JSON.stringify(DOC_A)}); window.__fm.openFile(${JSON.stringify(DOC_B)}); return 1; })()`);
await sleep(800);
console.log("刷新后:", show(await report("刷新")));

// 场景：上窗格标签 → 右边缘（三个高度）
for (const yFrac of [0.5, 0.15, 0.85]) {
  await reload();
  await ev(`(() => { window.__fm.openFile(${JSON.stringify(DOC_A)}); window.__fm.openFile(${JSON.stringify(DOC_B)}); return 1; })()`);
  await sleep(800);
  await makeStackedByMouse();
  const before = await report("分屏后");
  const p = await ev(`(() => {
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    if (gvs.length < 2) return null;
    const t = gvs[0].querySelector(".dv-tab").getBoundingClientRect();
    const c = gvs[0].querySelector(".dv-content-container").getBoundingClientRect();
    return { topTabText: gvs[0].querySelector(".dv-tab").textContent.trim().slice(0, 10), from: { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) }, c: { l: Math.round(c.left), r: Math.round(c.right), t: Math.round(c.top), b: Math.round(c.bottom) } };
  })()`);
  if (!p) { console.log(`\n[y=${yFrac}] 未能建立上下分屏：`, show(before)); continue; }
  const to = { x: p.c.r - 6, y: Math.round(p.c.t + (p.c.b - p.c.t) * yFrac) };
  logs = [];
  await ev(`window.__rm = [], 1`);
  await drag(p.from, to);
  const after = await report("拖后");
  console.log(`\n[y=${yFrac}] 拖「${p.topTabText}」(上窗格) 到 (${to.x},${to.y})`);
  console.log("   前:", show(before));
  console.log("   后:", show(after), after.panels < before.panels ? "★★ 面板丢失" : "");
  const rm = await ev(`window.__rm`);
  if (rm && rm.length) console.log("   移除记录:", JSON.stringify(rm));
  if (logs.length) console.log("   日志:", JSON.stringify(logs.slice(0, 4)));
}
await client.close();
