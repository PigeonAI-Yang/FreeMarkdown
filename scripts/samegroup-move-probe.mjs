// 验证 moveTo(自身分组, 边缘) 在不同面板数下的安全性
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
  ev(`(() => { const api = window.__fm.dock; return { panels: api.panels.length, groups: api.groups.length, domGroups: document.querySelectorAll('.dv-groupview').length, broken: api.groups.some(g => !g.element.isConnected) }; })()`);

async function reset(n) {
  await ev(`(() => { const api = window.__fm.dock; for (const p of [...api.panels]) { try { api.removePanel(p); } catch(e) {} } return 1; })()`);
  await sleep(400);
  await ev(`(() => { window.__fm.openFile(${JSON.stringify(DOC_A)}); ${n > 1 ? `window.__fm.openFile(${JSON.stringify(DOC_B)});` : ""} return 1; })()`);
  await sleep(900);
}

for (const n of [1, 2]) {
  for (const pos of ["right", "bottom"]) {
    await reset(n);
    const before = await health();
    const res = await ev(`(() => {
      const api = window.__fm.dock;
      const g = api.groups[0];
      const p = g.panels[g.panels.length - 1];   // 该分组最后一个面板
      try { p.api.moveTo({ group: g, position: ${JSON.stringify(pos)} }); return "ok"; } catch (e) { return "THROW " + String(e && e.message || e); }
    })()`);
    await sleep(500);
    const after = await health();
    console.log(`${n} 个面板同组 moveTo(${pos}): moveTo=${res}  前 ${JSON.stringify(before)} → 后 ${JSON.stringify(after)}  ${after.broken ? "★ 损坏" : after.groups === after.domGroups ? "一致" : "★ 脱节"}`);
  }
}
await client.close();
