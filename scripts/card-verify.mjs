import CDP from "chrome-remote-interface";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

/* 卡片导出端到端验证：真实用户路径（工具栏按钮打开卡片面板）+ cardStore 状态层驱动模板切换。
   产物：testdata/out/tpl-<id>.png（8 模板截图）、page-0N.png（拆卡 @2x）、
   direct-write.png（Rust 写盘链路）、clipboard-check.png（剪贴板读回）。
   说明：原生「另存为/选文件夹」对话框属 OS UI，无法自动化驱动，
   保存链路以同一 Rust 命令 card_write_file 直写验证。 */

const OUT = "J:/PigeonYang/FreeMarkdown/testdata/out";
fs.mkdirSync(OUT, { recursive: true });

const CORE = "/node_modules/.pnpm/@tauri-apps+api@2.11.1/node_modules/@tauri-apps/api/dist/core.js";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  | " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pngSize = (file) => {
  const b = fs.readFileSync(file);
  const sigOk = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (!sigOk) throw new Error(`${file} 不是 PNG（头字节 ${b.slice(0, 4).toString("hex")}）`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

const client = await CDP({ port: 9223, wait: true });
const { Runtime, Log } = client;
await Log.enable();
await Runtime.enable();
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
    throw new Error("EXC:" + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};

/** 页内捕获 .card-root → base64（一次性带回，避免大对象序列化） */
const captureB64 = (scale, bg) => `
  (async () => {
    const { captureElement } = await import("/src/card/engine/rasterize.ts");
    const root = document.querySelector(".card-root");
    if (!root) throw new Error("no .card-root");
    const t0 = performance.now();
    const res = await captureElement(root, { scale: ${scale}, format: "png", backgroundColor: ${JSON.stringify(bg ?? null)} });
    const ms = Math.round(performance.now() - t0);
    let b64 = "";
    const b = res.bytes;
    for (let i = 0; i < b.length; i += 0x8000)
      b64 += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    b64 = btoa(b64);
    return { w: res.width, h: res.height, len: b.length, ms, b64 };
  })()`;

/** 页内捕获 → api.cardWriteFile 直写（验证 Rust 落盘链路） */
const captureWrite = (scale, bg, filePath) => `
  (async () => {
    const { captureElement } = await import("/src/card/engine/rasterize.ts");
    const { api } = await import("/src/lib/ipc.ts");
    const root = document.querySelector(".card-root");
    const res = await captureElement(root, { scale: ${scale}, format: "png", backgroundColor: ${JSON.stringify(bg ?? null)} });
    let b64 = "";
    const b = res.bytes;
    for (let i = 0; i < b.length; i += 0x8000)
      b64 += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    b64 = btoa(b64);
    const t0 = performance.now();
    const written = await api.cardWriteFile(${JSON.stringify(filePath)}, b64);
    return { w: res.width, h: res.height, len: b.length, written, ms: Math.round(performance.now() - t0) };
  })()`;

/** 真实用户路径：驱动面板 UI 控件（原生 setter + change 事件）。
    不 import cardStore —— vite HMR 查询参数会让脚本拿到独立的模块实例，
    写进幽灵副本对 app 无效（此前模板/模式切换静默失效的根因）。 */
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
const waitReady = async () =>
  evalJs(`(async () => {
    for (let i = 0; i < 120; i++) {
      const el = document.querySelector(".card-root");
      if (el && getComputedStyle(el).visibility !== "hidden" && document.querySelector(".card-viewport"))
        return "ready";
      await new Promise((r) => setTimeout(r, 250));
    }
    return "timeout";
  })()`);

try {
  /* 1. 真实路径打开文档 */
  await evalJs(
    `window.__fm.openFile("J:\\\\PigeonYang\\\\FreeMarkdown\\\\testdata\\\\card-sample.md")`,
  );
  await sleep(2000);
  const opened = await evalJs(
    `!!document.querySelector('.doc-content[data-path*="card-sample"]')`,
  );
  check("打开样例文档", opened);

  /* 2. 工具栏按钮打开卡片面板（真实入口） */
  await evalJs(
    `[...document.querySelectorAll("button")].find(b => b.title?.includes("卡片导出"))?.click(); "clicked"`,
  );
  await sleep(600);
  check("卡片面板已挂载", await evalJs(`!!document.querySelector(".card-panel")`));
  const ready1 = await waitReady();
  check("卡片面板渲染就绪", ready1 === "ready", ready1);

  /* 3. 字体服务 */
  const fonts = await evalJs(
    `(async () => (await import("/src/card/engine/fonts.ts")).listSystemFonts())()`,
  );
  check(
    "系统字体枚举 ≥ 300 且含微软雅黑",
    Array.isArray(fonts) &&
      fonts.length >= 300 &&
      fonts.some((f) => /微软雅黑|Microsoft YaHei/i.test(f)),
    `count=${fonts?.length}`,
  );

  /* 4. 八个模板逐个渲染 + 捕获截图 */
  const TPLS = [
    ["apple-notes", "苹果备忘录"],
    ["xhs-knowledge", "小红书知识卡"],
    ["wechat-article", "公众号文章"],
    ["terminal", "终端"],
    ["minimal-paper", "极简纸"],
    ["gradient-poster", "靛紫海报"],
    ["vintage-paper", "复古纸张"],
    ["notion-clean", "Notion 简约"],
  ];
  const perf = [];
  for (const [id, name] of TPLS) {
    const ui = await evalJs(uiSelect(id));
    const st = await waitReady();
    await sleep(250);
    const cap = await evalJs(captureB64(1, null));
    const file = path.join(OUT, `tpl-${id}.png`);
    fs.writeFileSync(file, Buffer.from(cap.b64, "base64"));
    const { w, h } = pngSize(file);
    perf.push(`${name}:${cap.ms}ms`);
    check(`模板 ${name}`, st === "ready" && w > 200 && h > 200, `${w}x${h} capture=${cap.ms}ms`);
  }
  console.log("capture-perf:", perf.join("  "));

  /* 5. 拆卡模式：预算 900px，读分页数，翻 3 张 @2x 落盘 */
  await evalJs(uiSelect("apple-notes"));
  await sleep(300);
  await evalJs(uiSelect("paged"));
  await evalJs(uiNumber("拆卡内容高度", "900"));
  await waitReady();
  await sleep(400);
  const vpH = await evalJs(
    `JSON.stringify({ vp: document.querySelector(".card-viewport")?.style.height, root: document.querySelector(".card-root")?.offsetHeight })`,
  );
  console.log("paged-geometry:", vpH);
  const pagerRaw = await evalJs(
    `(() => { const pg = document.querySelector(".card-pager"); const t = pg?.innerText ?? ""; const m = t.match(/(\\d+)\\s*\\/\\s*(\\d+)/); return JSON.stringify({ raw: t.slice(0, 60).replace(/\\n/g, "|"), n: m ? m[2] : "" }); })()`,
  );
  const pagerParsed = JSON.parse(pagerRaw || "{}");
  const nCards = parseInt(pagerParsed.n || "0", 10);
  check("拆卡分页数 ≥ 3", nCards >= 3, `N=${nCards} pager=[${pagerParsed.raw}]`);
  const dims = [];
  for (let i = 0; i < Math.min(3, nCards); i++) {
    const cap = await evalJs(captureB64(2, "#ffffff"));
    const file = path.join(OUT, `page-0${i + 1}.png`);
    fs.writeFileSync(file, Buffer.from(cap.b64, "base64"));
    const { w, h } = pngSize(file);
    dims.push(`${w}x${h}`);
    check(`拆卡第 ${i + 1} 张 @2x 尺寸`, w > 1000 && h > 1200, `${w}x${h}`);
    if (i < Math.min(3, nCards) - 1) {
      await evalJs(
        `[...document.querySelectorAll(".card-panel button")].find(b => /下一张|›/.test((b.title ?? "") + (b.textContent ?? "")))?.click(); "next"`,
      );
      await sleep(400);
    }
  }
  console.log("paged-dims:", dims.join("  "));

  /* 6. Rust 写盘链路：api.cardWriteFile 字节数读回比对 */
  const wres = await evalJs(
    captureWrite(2, "#ffffff", "J:\\\\PigeonYang\\\\FreeMarkdown\\\\testdata\\\\out\\\\direct-write.png"),
  );
  const dwFile = path.join(OUT, "direct-write.png");
  const dwSize = fs.existsSync(dwFile) ? fs.statSync(dwFile).size : -1;
  check(
    "card_write_file 落盘字节一致",
    dwSize === wres.len && wres.written === wres.len,
    `捕获=${wres.len} 返回=${wres.written} 磁盘=${dwSize} ipc+write=${wres.ms}ms`,
  );

  /* 7. 剪贴板链路：capture → api.cardClipboardWritePng → PowerShell 读回 */
  const clip = await evalJs(`(async () => {
    const { captureElement } = await import("/src/card/engine/rasterize.ts");
    const { api } = await import("/src/lib/ipc.ts");
    const root = document.querySelector(".card-root");
    const res = await captureElement(root, { scale: 1, format: "png", backgroundColor: "#ffffff" });
    let b64 = "";
    const b = res.bytes;
    for (let i = 0; i < b.length; i += 0x8000)
      b64 += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    b64 = btoa(b64);
    const dim = await api.cardClipboardWritePng(b64);
    return { dim, w: res.width, h: res.height };
  })()`);
  const clipFile = path.join(OUT, "clipboard-check.png");
  try {
    fs.rmSync(clipFile, { force: true });
    execSync(
      `powershell -STA -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $img=[Windows.Forms.Clipboard]::GetImage(); if ($img) { $img.Save('${OUT.replace(/\//g, "\\")}\\clipboard-check.png') }"`,
      { timeout: 30000 },
    );
  } catch (e) {
    console.log("clipboard powershell err:", String(e).slice(0, 120));
  }
  const clipOk = fs.existsSync(clipFile);
  const cs = clipOk ? pngSize(clipFile) : { w: 0, h: 0 };
  check(
    "剪贴板写图 + 读回尺寸一致",
    clipOk && cs.w === clip.w && cs.h === clip.h,
    `Rust返回=${clip.dim} 捕获=${clip.w}x${clip.h} 读回=${cs.w}x${cs.h}`,
  );

  /* 8. console 错误 */
  check("无 console error", errors.length === 0, errors.slice(0, 5).join(" || "));
} catch (e) {
  check("脚本异常终止", false, String(e).slice(0, 400));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== 结果: ${results.length - failed.length}/${results.length} PASS ====`);
fs.writeFileSync(path.join(OUT, "verify-result.json"), JSON.stringify(results, null, 2));
client.close();
process.exit(failed.length > 0 ? 1 : 0);
