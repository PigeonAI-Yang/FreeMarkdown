// 面板丢失复现矩阵：固定两个文档，逐点测试拖拽后是否两个面板都在。
// 同时捕获页面 console/异常，若 moveTo 中途抛错会暴露出来。
import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223 });
const { Runtime, Input, Log } = client;
await Runtime.enable();
await Log.enable().catch(() => {});
let logs = [];
Runtime.consoleAPICalled((e) =>
  logs.push("console." + e.type + ": " + e.args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type)).join(" ").slice(0, 200)),
);
Runtime.exceptionThrown((e) => logs.push("EXC: " + String(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text).slice(0, 300)));
Log.entryAdded((e) => { if (e.entry.level === "error") logs.push("log.error: " + e.entry.text.slice(0, 200)); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expr) {
  const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
}

const DOC_A = "J:/PigeonYang/FreeMarkdown/testdata/验收样例.md";
const DOC_B = "J:\\PigeonYang\\e-books\\让AI帮你学会AI\\第8章_草稿.md";

/** 确保两个文档都打开，且为左右两个分组 */
async function setup() {
  await ev(`(() => { window.__fm.openFile(${JSON.stringify(DOC_A)}); window.__fm.openFile(${JSON.stringify(DOC_B)}); return 1; })()`);
  await sleep(700);
  await ev(`(() => {
    const api = window.__fm.dock;
    const first = api.groups[0];
    for (const g of api.groups.slice(1)) for (const p of [...g.panels]) { try { p.api.moveTo({ group: first, position: "center" }); } catch {} }
    return api.groups.length;
  })()`);
  await sleep(400);
  await ev(`(() => {
    const api = window.__fm.dock;
    const g = api.groups[0];
    const p = g.panels[g.panels.length - 1];
    p.api.moveTo({ group: g, position: "right" });
    return api.groups.length;
  })()`);
  await sleep(450);
}

const snapshot = () =>
  ev(`(() => {
    const api = window.__fm.dock;
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    return {
      panelCount: api.panels.length,
      ids: api.panels.map(p => p.id.split(/[\\\\/]/).pop()),
      groupCount: api.groups.length,
      rects: gvs.map(g => { const r = g.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }),
      content0: (() => { const c = gvs[0]?.querySelector(".dv-content-container")?.getBoundingClientRect(); return c ? { l: Math.round(c.left), r: Math.round(c.right), t: Math.round(c.top), b: Math.round(c.bottom) } : null; })(),
      rightGroupTab: (() => { const t = gvs[1]?.querySelector(".dv-tab")?.getBoundingClientRect(); return t ? { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) } : null; })(),
    };
  })()`);

async function drag(from, to) {
  await Input.dispatchMouseEvent({ type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 12; i++) {
    await Input.dispatchMouseEvent({ type: "mouseMoved", x: Math.round(from.x + ((to.x - from.x) * i) / 12), y: Math.round(from.y + ((to.y - from.y) * i) / 12), button: "left", buttons: 1 });
    await sleep(16);
  }
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(450);
}

const CASES = [
  { name: "A 左组右边缘(跨组分屏)", compute: (s) => ({ x: s.content0.r - 300 - 4, y: Math.round((s.content0.t + s.content0.b) / 2) }) },
  { name: "B 本组右边缘(自身组)", compute: (s) => ({ x: s.content0.r - 4, y: Math.round((s.content0.t + s.content0.b) / 2) }) },
  { name: "C 左组中央(合并)", compute: (s) => ({ x: Math.round((s.content0.l + s.content0.r) / 4), y: Math.round((s.content0.t + s.content0.b) / 2) }) },
  { name: "D 左组底边带(下分屏)", compute: (s) => ({ x: Math.round(s.content0.l + s.content0.w / 2 || (s.content0.l + s.content0.r) / 4), y: s.content0.b - 40 }) },
  { name: "E 窗口右下角", compute: (s) => ({ x: s.content0.r - 2, y: s.content0.b - 2 }) },
  { name: "F 左组左上角", compute: (s) => ({ x: s.content0.l + 3, y: s.content0.t + 3 }) },
];

let allPass = true;
for (const c of CASES) {
  await setup();
  let s = await snapshot();
  if (!s.rightGroupTab || s.groupCount !== 2) {
    console.log(`${c.name}: 前置状态不满足（分组 ${s.groupCount}）——跳过`);
    continue;
  }
  const to = c.compute(s);
  logs = [];
  await drag(s.rightGroupTab, to);
  const after = await snapshot();
  const ok = after.panelCount === 2 && after.ids.length === 2;
  if (!ok) allPass = false;
  console.log(`\n${c.name}  落点(${to.x},${to.y})`);
  console.log(`  面板数 ${s.panelCount} -> ${after.panelCount}  ${ok ? "PASS" : "FAIL ★ 面板丢失"}  分组 ${s.groupCount} -> ${after.groupCount}`);
  console.log(`  现有面板: ${JSON.stringify(after.ids)}`);
  if (logs.length) console.log("  页面日志:", JSON.stringify(logs.slice(0, 6)));
  await sleep(200);
}
console.log(`\n结论: ${allPass ? "未复现面板丢失" : "复现到面板丢失（见上）"}`);
await client.close();
