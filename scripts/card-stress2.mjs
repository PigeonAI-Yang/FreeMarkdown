import CDP from "chrome-remote-interface";
import fs from "node:fs";
import path from "node:path";

/* 拆卡重构压力复测：big2.md（约 2MB）拆卡（预算 900）连续 20 张
   「翻页 → capture @2x → api.cardWriteFile 落盘」，产物 big2-card-N.png。
   通过标准：总耗时 < 15000ms 且单卡 < 700ms；PNG 1440 宽、高 800~2000；无 console error。
   驱动方式与 card-verify 一致：UI 控件（原生 select/number setter + 事件），
   禁止 import cardStore —— vite HMR 查询参数会产生双模块实例，写进幽灵副本无效。 */

const OUT = "J:/PigeonYang/FreeMarkdown/testdata/out";
fs.mkdirSync(OUT, { recursive: true });
const COUNT = 20;
const BUDGET = 900;

const client = await CDP({ port: 9223 });
const { Runtime, Log } = client;
await Runtime.enable();
await Log.enable();
const errors = [];
Log.entryAdded((e) => {
  if (e.entry.level === "error") errors.push(e.entry.text);
});
const evalJs = async (expr) => {
  const r = await Runtime.evaluate({
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails)
    throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitReady = async () =>
  evalJs(`(async () => {
    for (let i = 0; i < 200; i++) {
      const el = document.querySelector(".card-root");
      if (el && getComputedStyle(el).visibility !== "hidden" && document.querySelector(".card-viewport"))
        return "ready";
      await new Promise((r) => setTimeout(r, 250));
    }
    return "timeout";
  })()`);
/* UI 控件驱动：原生 select setter + change 事件（真实用户路径） */
const uiSelect = (value) => `
  (() => {
    const sel = [...document.querySelectorAll(".card-panel select")].find((s) =>
      [...s.options].some((o) => o.value === "${value}"),
    );
    if (!sel) return "no-select:" + "${value}";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    setter.call(sel, "${value}");
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return "ok";
  })()`;
const uiNumber = (label, value) => `
  (() => {
    const field = [...document.querySelectorAll(".card-panel label.card-field")].find((f) =>
      f.querySelector(".card-field-label")?.textContent?.includes("${label}"),
    );
    const input = field?.querySelector("input[type=number]");
    if (!input) return "no-input:" + "${label}";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "${value}");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return "ok";
  })()`;

/* capture @2x → api.cardWriteFile 落盘；分项计时 capture / write */
const captureWrite = (i) => `
  (async () => {
    const { captureElement } = await import("/src/card/engine/rasterize.ts");
    const { api } = await import("/src/lib/ipc.ts");
    const root = document.querySelector(".card-root");
    const c0 = performance.now();
    const res = await captureElement(root, { scale: 2, format: "png", backgroundColor: "#ffffff" });
    const capMs = Math.round(performance.now() - c0);
    let b64 = "";
    const b = res.bytes;
    for (let k = 0; k < b.length; k += 0x8000)
      b64 += String.fromCharCode.apply(null, b.subarray(k, k + 0x8000));
    b64 = btoa(b64);
    const w0 = performance.now();
    await api.cardWriteFile("J:\\\\PigeonYang\\\\FreeMarkdown\\\\testdata\\\\out\\\\big2-card-${i}.png", b64);
    return {
      w: res.width,
      h: res.height,
      capMs,
      writeMs: Math.round(performance.now() - w0),
    };
  })()`;

/* 1. 打开大文档 + 卡片面板（真实用户入口） */
await evalJs(
  `window.__fm.openFile("J:\\\\PigeonYang\\\\FreeMarkdown\\\\testdata\\\\big\\\\big2.md")`,
);
await sleep(2500);
await evalJs(
  `[...document.querySelectorAll("button")].find((b) => b.title?.includes("卡片导出"))?.click(); "clicked"`,
);
await sleep(1000);
const ready1 = await waitReady();
console.log("ready(面板首载):", ready1);

/* 2. 拆卡模式，预算 900（模板 select + 模式 select + 高度 number，全走 UI）。
      高度先 850 再 900：若控件已是目标值，change 不触发管线重跑，
      HMR 后可能残留旧 cuts 结构，两次真实变更保证管线以新代码全量重跑 */
await evalJs(uiSelect("apple-notes"));
await sleep(300);
await evalJs(uiSelect("paged"));
await sleep(500);
await evalJs(uiNumber("拆卡内容高度", "850"));
await sleep(800);
await evalJs(uiNumber("拆卡内容高度", String(BUDGET)));
const ready2 = await waitReady();
await sleep(600);
console.log("ready(拆卡就绪):", ready2);

const pager = await evalJs(
  `(() => { const pg = document.querySelector(".card-pager"); const m = (pg?.innerText ?? "").match(/(\\d+)\\s*\\/\\s*(\\d+)/); return m ? m[2] : "0"; })()`,
);
const n = parseInt(pager, 10);
console.log("大文档拆卡张数:", n);
if (!n) {
  console.log("FAIL 未读到分页数");
  client.close();
  process.exit(1);
}

/* 3. 连续 20 张：翻页 → capture @2x → 落盘 */
const t0 = Date.now();
const rows = [];
const count = Math.min(n, COUNT);
for (let i = 1; i <= count; i++) {
  const iterStart = Date.now();
  if (i > 1) {
    await evalJs(
      `[...document.querySelectorAll(".card-panel button")].find((b) => b.title === "下一张")?.click(); "next"`,
    );
    await sleep(250);
  }
  const res = await evalJs(captureWrite(i));
  rows.push({ i, ...res, iterMs: Date.now() - iterStart });
}
const totalMs = Date.now() - t0;

/* 4. 判定：总耗时 / 单卡 / 尺寸 / console */
let ok = true;
console.log("\nper-card（capture @2x，预算单卡 <700ms）:");
for (const r of rows) {
  const dimOk = r.w === 1440 && r.h >= 800 && r.h <= 2000;
  const capOk = r.capMs < 700;
  if (!dimOk || !capOk) ok = false;
  console.log(
    `  #${String(r.i).padStart(2)} ${r.w}x${r.h} capture=${r.capMs}ms write=${r.writeMs}ms iter=${r.iterMs}ms` +
      `${dimOk ? "" : " [尺寸异常]"}${capOk ? "" : " [超时]"}`,
  );
}
const totalOk = totalMs < 15000;
if (!totalOk) ok = false;
const errOk = errors.length === 0;
console.log(`\n批量 ${rows.length} 张总耗时: ${totalMs}ms（预算 15000ms）→ ${totalOk ? "PASS" : "FAIL"}`);
console.log("console-errors:", errors.length, errors.slice(0, 3).join(" || "), "→", errOk ? "PASS" : "FAIL");
console.log("产物目录:", path.join(OUT, "big2-card-N.png"));
console.log(ok && errOk ? "\nSTRESS PASS" : "\nSTRESS FAIL");
client.close();
process.exit(ok && errOk ? 0 : 1);
