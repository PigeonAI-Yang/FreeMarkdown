// 干净页面上逐步验证 addGroup / moveTo 的可靠性
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
  ev(`(() => { const api = window.__fm.dock; const gvs=[...document.querySelectorAll('.dv-groupview')]; return { panels: api.panels.length, groups: api.groups.map(g=>g.id+':'+g.panels.length), domGroups: gvs.length, broken: api.groups.some(g => !g.element.isConnected) }; })()`);

console.log("1 刷新后:", JSON.stringify(await H()));
await ev(`(() => { const api = window.__fm.dock; for (const p of [...api.panels]) { try { api.removePanel(p); } catch(e) {} } return 1; })()`);
await sleep(600);
console.log("2 清空后:", JSON.stringify(await H()));
await ev(`(() => { window.__fm.openFile(${JSON.stringify(DOC_A)}); window.__fm.openFile(${JSON.stringify(DOC_B)}); return 1; })()`);
await sleep(900);
console.log("3 打开两个文档:", JSON.stringify(await H()));

console.log("4 addGroup(referenceGroup, right):", JSON.stringify(await ev(`(() => {
  const api = window.__fm.dock;
  const g = api.groups[0];
  try { const ng = api.addGroup({ referenceGroup: g, direction: "right" }); return { ok: true, id: ng.id, g: api.groups.map(x=>x.id+':'+x.panels.length) }; }
  catch (e) { return { ok: false, err: String(e && e.message || e) }; }
})()`)));
await sleep(500);
console.log("   健康:", JSON.stringify(await H()));

console.log("5 moveTo(新分组, center):", JSON.stringify(await ev(`(() => {
  const api = window.__fm.dock;
  const empty = api.groups.find(g => g.panels.length === 0);
  if (!empty) return { skipped: true };
  const src = api.groups.find(g => g.panels.length > 0);
  const p = src.panels[src.panels.length - 1];
  try { p.api.moveTo({ group: empty, position: "center" }); return { ok: true, groups: api.groups.map(x=>x.id+':'+x.panels.length) }; }
  catch (e) { return { ok: false, err: String(e && e.message || e) }; }
})()`)));
await sleep(600);
console.log("   健康:", JSON.stringify(await H()));
await client.close();
