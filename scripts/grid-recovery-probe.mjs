// 验证「网格损坏 → 自愈重建」与「拖拽丢面板兜底」
// 损坏复现方式：把分组视图从 .dv-view-container 里摘掉（与实测得到的损坏态等价）
import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223 });
const { Runtime, Page } = client;
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

const state = () =>
  ev(`(() => {
    const api = window.__fm.dock;
    const gvs = [...document.querySelectorAll(".dv-groupview")];
    return {
      groups: api ? api.groups.length : -1,
      panels: api ? api.panels.map(p => p.id.split(/[\\\\/]/).pop()) : [],
      broken: api ? api.groups.some(g => { const el = g.element; return !!el && !el.isConnected; }) : null,
      domGroups: gvs.length,
      epoch: window.__fm.appStore.get().gridEpoch,
      rendered: document.querySelectorAll(".doc-content").length,
    };
  })()`);

await Page.reload({ ignoreCache: true });
await sleep(6500);
console.log("刷新后:", JSON.stringify(await state()));

// 打开一个文档
await ev(`window.__fm.openFile(${JSON.stringify(DOC_A)}), 1`);
await sleep(900);
console.log("打开 A 后:", JSON.stringify(await state()));

// 人为制造损坏：把分组视图从 DOM 摘掉
const broken = await ev(`(() => {
  const vc = document.querySelector(".dv-view-container");
  if (!vc || !vc.children.length) return { ok: false };
  const removed = vc.children.length;
  [...vc.children].forEach(c => c.remove());
  const api = window.__fm.dock;
  return { ok: true, removed, groups: api.groups.length, connected: api.groups.map(g => g.element.isConnected) };
})()`);
console.log("制造损坏:", JSON.stringify(broken));
console.log("损坏后:", JSON.stringify(await state()));

// 现在打开第二个文档 —— 期望自动重建并恢复两个文档
logs = [];
await ev(`window.__fm.openFile(${JSON.stringify(DOC_B)}), 1`);
await sleep(1500);
const after = await state();
console.log("openFile(B) 之后:", JSON.stringify(after));
console.log("  → 期望: broken=false, panels=[A,B], domGroups>=1, epoch 增加");
console.log("  日志:", JSON.stringify(logs.slice(0, 6)));

// 再验证：损坏态下「点什么都打不开」是否已不可能
const broken2 = await ev(`(() => {
  const vc = document.querySelector(".dv-view-container");
  const api = window.__fm.dock;
  [...vc.children].forEach(c => c.remove());
  return { groups: api.groups.length, connected: api.groups.map(g => g.element.isConnected) };
})()`);
console.log("\n二次制造损坏:", JSON.stringify(broken2));
await ev(`window.__fm.openFile(${JSON.stringify(DOC_A)}), 1`);
await sleep(1500);
console.log("再次 openFile 后:", JSON.stringify(await state()));
await client.close();
