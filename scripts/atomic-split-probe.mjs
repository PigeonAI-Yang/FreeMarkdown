// 原子版安全分屏：addGroup(参考组, 方向) + moveTo(新组, center) 同一同步块内完成
import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223 });
const { Runtime } = client;
await Runtime.enable();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expr) {
  const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
}
const DOC_A = "J:\PigeonYang\FreeMarkdown\testdata\验收样例.md";
const DOC_B = "J:\PigeonYang\e-books\让AI帮你学会AI\第8章_草稿.md";
const H = () =>
  ev(`(() => { const api = window.__fm.dock; const gvs=[...document.querySelectorAll('.dv-groupview')]; return { panels: api.panels.length, groups: api.groups.map(g=>g.id+':'+g.panels.length), domGroups: gvs.length, broken: api.groups.some(g => !g.element.isConnected), rects: gvs.map(g => { const r = g.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), tabs: [...g.querySelectorAll('.dv-tab')].map(t => t.textContent.trim().slice(0,8)) }; }) }; })()`);

for (const dir of ["right", "below", "left", "above"]) {
  await ev(`(() => { const api = window.__fm.dock; const f = api.groups[0]; for (const g of api.groups.slice(1)) for (const p of [...g.panels]) { try { p.api.moveTo({ group: f, position: "center" }); } catch(e) {} } return 1; })()`);
  await sleep(600);
  const res = await ev(`(() => {
    const api = window.__fm.dock;
    const g = api.groups[0];
    const p = g.panels[g.panels.length - 1];
    const log = [];
    let ng = null;
    try { ng = api.addGroup({ referenceGroup: g, direction: ${JSON.stringify(dir)} }); } catch (e) { return { log: ["addGroup THROW " + String(e && e.message || e)] }; }
    try { p.api.moveTo({ group: ng, position: "center" }); } catch (e) { return { log: ["moveTo THROW " + String(e && e.message || e)] }; }
    return { log: ["ok"], groups: api.groups.map(x=>x.id+':'+x.panels.length) };
  })()`);
  await sleep(800);
  const h = await H();
  const ok = !h.broken && h.panels === 2 && h.groups.length === 2 && h.domGroups === 2;
  console.log(`方向 ${dir}: ${JSON.stringify(res)}`);
  console.log(`   后 → ${JSON.stringify(h)}  ${ok ? "PASS" : "★ 检查"}`);
}
await client.close();
