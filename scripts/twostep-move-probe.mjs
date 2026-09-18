// 验证「借道两步移动」能否安全实现"同组边缘分屏"
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

// 两个面板同组 → 借道临时分组 → 跨组插到原分组右边缘
await ev(`(() => { const api = window.__fm.dock; for (const p of [...api.panels]) { try { api.removePanel(p); } catch(e) {} } return 1; })()`);
await sleep(400);
await ev(`(() => { window.__fm.openFile(${JSON.stringify(DOC_A)}); window.__fm.openFile(${JSON.stringify(DOC_B)}); return 1; })()`);
await sleep(900);
console.log("起点:", JSON.stringify(await health()));

const step = await ev(`(() => {
  const api = window.__fm.dock;
  const g = api.groups[0];
  const p = api.panels.find(pp => pp.group.id === g.id && pp.id.includes("验收样例")) || g.panels[0];
  const log = [];
  let tmp = null;
  try { tmp = api.addGroup({ direction: "right" }); log.push("addGroup ok id=" + tmp.id); } catch (e) { log.push("addGroup THROW " + String(e && e.message || e)); return { log }; }
  try { p.api.moveTo({ group: tmp, position: "center" }); log.push("step1 moveTo(tmp) ok"); } catch (e) { log.push("step1 THROW " + String(e && e.message || e)); }
  try { p.api.moveTo({ group: g, position: "right" }); log.push("step2 moveTo(own,right) ok"); } catch (e) { log.push("step2 THROW " + String(e && e.message || e)); }
  return { log, panelGroup: p.group.id };
})()`);
console.log("两步执行:", JSON.stringify(step));
await sleep(700);
console.log("结果:", JSON.stringify(await health()));
await client.close();
