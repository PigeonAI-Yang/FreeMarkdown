import CDP from "chrome-remote-interface";
import fs from "node:fs";
import path from "node:path";

/* 大文档拆卡压力测试 + 设备外壳截图。
   预算：20 卡批量（capture @2x + 落盘）< 15s。 */

const OUT = "J:/PigeonYang/FreeMarkdown/testdata/out";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/* 捕获当前卡 @2x → api.cardWriteFile 落盘，返回 {w,h,len,ms} */
const captureWrite = (i) => `
  (async () => {
    const { captureElement } = await import("/src/card/engine/rasterize.ts");
    const { api } = await import("/src/lib/ipc.ts");
    const root = document.querySelector(".card-root");
    const t0 = performance.now();
    const res = await captureElement(root, { scale: 2, format: "png", backgroundColor: "#ffffff" });
    let b64 = "";
    const b = res.bytes;
    for (let k = 0; k < b.length; k += 0x8000)
      b64 += String.fromCharCode.apply(null, b.subarray(k, k + 0x8000));
    b64 = btoa(b64);
    await api.cardWriteFile("J:\\\\PigeonYang\\\\FreeMarkdown\\\\testdata\\\\out\\\\big-${i}.png", b64);
    return { w: res.width, h: res.height, len: b.length, ms: Math.round(performance.now() - t0) };
  })()`;

/* 1. 打开大文档 + 卡片面板 */
await evalJs(
  `window.__fm.openFile("J:\\\\PigeonYang\\\\FreeMarkdown\\\\testdata\\\\big\\\\big2.md")`,
);
await sleep(2500);
await evalJs(
  `[...document.querySelectorAll("button")].find((b) => b.title?.includes("卡片导出"))?.click(); "clicked"`,
);
await sleep(1000);
const ready = await waitReady();
console.log("ready:", ready);

/* 2. 拆卡模式，预算 900 */
await evalJs(uiSelect("apple-notes"));
await sleep(300);
await evalJs(uiSelect("paged"));
await sleep(2500);
const pager = await evalJs(
  `(() => { const pg = document.querySelector(".card-pager"); const m = (pg?.innerText ?? "").match(/(\\d+)\\s*\\/\\s*(\\d+)/); return m ? m[2] : "0"; })()`,
);
const n = parseInt(pager, 10);
console.log("大文档拆卡张数:", n);

/* 3. 批量：逐张翻页 + capture @2x + 落盘，总耗时 */
const t0 = Date.now();
let done = 0;
const dims = [];
const count = Math.min(n || 1, 20);
for (let i = 0; i < count; i++) {
  const res = await evalJs(captureWrite(i + 1));
  dims.push(`${res.w}x${res.h}:${res.ms}ms`);
  done++;
  if (i < count - 1) {
    await evalJs(
      `[...document.querySelectorAll(".card-panel button")].find((b) => b.title === "下一张")?.click(); "next"`,
    );
    await sleep(300);
  }
}
const totalMs = Date.now() - t0;
console.log(`批量 ${done} 张总耗时: ${totalMs}ms（预算 15000ms）→ ${totalMs < 15000 ? "PASS" : "FAIL"}`);
console.log("per-card:", dims.join("  "));

/* 4. 外壳截图（供视觉审查） */
for (const shell of ["iphone", "macos"]) {
  await evalJs(uiSelect(shell));
  await sleep(1200);
  const r = await evalJs(`(async () => {
    const { captureElement } = await import("/src/card/engine/rasterize.ts");
    const root = document.querySelector(".card-root");
    const res = await captureElement(root, { scale: 1, format: "png", backgroundColor: "#e8e8ed" });
    let b64 = "";
    const b = res.bytes;
    for (let k = 0; k < b.length; k += 0x8000)
      b64 += String.fromCharCode.apply(null, b.subarray(k, k + 0x8000));
    return { w: res.width, h: res.height, b64: btoa(b64) };
  })()`);
  fs.writeFileSync(path.join(OUT, `shell-${shell}.png`), Buffer.from(r.b64, "base64"));
  console.log(`shell-${shell}: ${r.w}x${r.h}`);
}
/* 恢复无壳 */
await evalJs(uiSelect("none"));

console.log("console-errors:", errors.length, errors.slice(0, 3).join(" || "));
client.close();
