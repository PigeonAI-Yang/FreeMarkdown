// 无歧义落点测试：① 拖到另一分组中央（应合并为 1 组 2 标签）② 拖到另一分组左边缘（应左右换位）
import CDP from "chrome-remote-interface";
const port = process.env.CDP_PORT || 9223;
const client = await CDP({ port });
const { Runtime, Input } = client;
await Runtime.enable();
const logs = [];
Runtime.consoleAPICalled((e) => {
  logs.push(e.args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type)).join(" "));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expr) {
  const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
}

const snap = () =>
  ev(`(() => {
    const api = window.__fm.dock;
    return {
      groups: api.groups.map(g => ({ id: g.id, panels: g.panels.map(p => p.id.split(/[\\\\/]/).pop().slice(0, 14)) })),
      tabs: [...document.querySelectorAll(".dv-tab")].map(t => {
        const r = t.getBoundingClientRect();
        return { text: t.textContent.trim().slice(0, 14), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), gi: [...document.querySelectorAll(".dv-groupview")].findIndex(g => g.contains(t)) };
      }),
      rects: [...document.querySelectorAll(".dv-groupview")].map(g => { const r = g.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) }; }),
    };
  })()`);

async function drag(from, to, label) {
  logs.length = 0;
  await Input.dispatchMouseEvent({ type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 12; i++) {
    await Input.dispatchMouseEvent({ type: "mouseMoved", x: Math.round(from.x + ((to.x - from.x) * i) / 12), y: Math.round(from.y + ((to.y - from.y) * i) / 12), button: "left", buttons: 1 });
    await sleep(16);
  }
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(400);
  console.log(`\n### ${label}`);
  console.log("target:", JSON.stringify(to));
  for (const l of logs) console.log("  log>", l);
  console.log("after:", JSON.stringify(await snap()));
}

let s = await snap();
console.log("initial:", JSON.stringify(s, null, 1));
if (s.groups.length < 2) {
  console.log("需要 2 个分组（每组的标签分开）才能做无歧义测试");
}

// ① 把第 2 组的标签拖到第 1 组内容区中央 → 期望合并成 1 组（2 个标签）
if (s.groups.length === 2 && s.tabs.length === 2) {
  const tab1 = s.tabs.find((t) => t.gi === 1);
  const g0 = s.rects[0];
  await drag({ x: tab1.x, y: tab1.y }, { x: Math.round((g0.l + g0.r) / 2), y: Math.round((g0.t + g0.b) / 2) }, "① 拖到另一分组中央（期望合并为 1 组 2 标签）");
}

s = await snap();
console.log("\nmid:", JSON.stringify(s, null, 1));

// ② 若已回到同组，先手动拆开，再测左边缘换位
if (s.groups.length === 1 && s.tabs.length === 2) {
  await ev(`(() => { const api = window.__fm.dock; const p = api.panels[api.panels.length - 1]; p.api.moveTo({ group: p.group, position: "right" }); return api.groups.length; })()`);
  await sleep(400);
  s = await snap();
  console.log("\n拆开后:", JSON.stringify(s, null, 1));
}
if (s.groups.length === 2) {
  const tab1 = s.tabs.find((t) => t.gi === 1);
  const g0 = s.rects[0];
  await drag({ x: tab1.x, y: tab1.y }, { x: g0.l + 3, y: Math.round((g0.t + g0.b) / 2) }, "② 拖到另一分组左边缘（期望左右换位）");
}

await client.close();
