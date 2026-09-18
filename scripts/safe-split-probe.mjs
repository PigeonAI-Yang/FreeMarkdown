// 验证安全分屏路径：addGroup({referenceGroup, direction}) + moveTo(新分组, center)
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
const health = () =>
  ev(`(() => { const api = window.__fm.dock; const gvs=[...document.querySelectorAll('.dv-groupview')]; return { panels: api.panels.length, groups: api.groups.length, domGroups: gvs.length, broken: api.groups.some(g => !g.element.isConnected), rects: gvs.map(g => { const r = g.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), tabs: [...g.querySelectorAll('.dv-tab')].map(t => t.textContent.trim().slice(0,8)) }; }) }; })()`);

async function reset2() {
  await ev(`(() => { const api = window.__fm.dock; for (const p of [...api.panels]) { try { api.removePanel(p); } catch(e) {} } return 1; })()`);
  await sleep(400);
  await ev(`(() => { window.__fm.openFile(${JSON.stringify(DOC_A)}); window.__fm.openFile(${JSON.stringify(DOC_B)}); return 1; })()`);
  await sleep(900);
}

for (const dir of ["right", "below"]) {
  await reset2();
  const res = await ev(`(() => {
    const api = window.__fm.dock;
    const g = api.groups[0];
    const p = g.panels[g.panels.length - 1];
    const log = [];
    let ng = null;
    try { ng = api.addGroup({ referenceGroup: g, direction: ${JSON.stringify(dir)} }); log.push("addGroup ok " + ng.id); }
    catch (e) { log.push("addGroup THROW " + String(e && e.message || e)); return { log }; }
    try { p.api.moveTo({ group: ng, position: "center" }); log.push("moveTo(center) ok"); }
    catch (e) { log.push("moveTo THROW " + String(e && e.message || e)); }
    return { log };
  })()`);
  await sleep(700);
  const h = await health();
  console.log(`方向 ${dir}: ${JSON.stringify(res)}`);
  console.log(`   → ${JSON.stringify(h)}  ${h.broken ? "★ 损坏" : h.groups === h.domGroups && h.panels === 2 ? "PASS" : "检查"}`);
}
await client.close();
