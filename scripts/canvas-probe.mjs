// 画布交互验证：拖动平移 / Ctrl+滚轮以光标为中心缩放 / 双击复位 / 控制条按钮
import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223 });
const { Runtime, Input } = client;
await Runtime.enable();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expr) {
  const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
}

/** 读取画布状态：平移量与缩放（从计算样式的 transform 矩阵解析） */
const view = () =>
  ev(`(() => {
    const stage = document.querySelector(".card-stage");
    const box = document.querySelector(".card-scale");
    if (!stage || !box) return { err: "no stage/box" };
    const m = new DOMMatrixReadOnly(getComputedStyle(box).transform);
    const sr = stage.getBoundingClientRect();
    const root = box.querySelector(".card-root");
    const fitScale = root ? box.offsetWidth / parseFloat(getComputedStyle(root).width) : null;
    return {
      x: +m.e.toFixed(2), y: +m.f.toFixed(2), scale: +m.a.toFixed(4), fitScale,
      offsetLeft: box.offsetLeft, offsetTop: box.offsetTop,
      boxW: box.offsetWidth, boxH: box.offsetHeight,
      stage: { l: Math.round(sr.left), t: Math.round(sr.top), w: Math.round(sr.width), h: Math.round(sr.height) },
      chip: document.querySelector(".card-zoom-value")?.textContent?.trim() ?? null,
    };
  })()`);

/** 光标处的「元素局部坐标」——缩放锚定是否正确，就看它前后是否一致 */
async function localAt(px, py) {
  const v = await view();
  const O = { x: v.offsetLeft + v.boxW / 2, y: v.offsetTop };
  return { u: (px - O.x - v.x) / v.scale, v: (py - O.y - v.y) / v.scale, view: v };
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  | " + detail : ""}`);
};

const v0 = await view();
if (v0.err) { console.log("无法测量：", JSON.stringify(v0)); await client.close(); process.exit(1); }
console.log("初始:", JSON.stringify({ x: v0.x, y: v0.y, scale: v0.scale, chip: v0.chip }));

/* ① 拖动平移：在舞台空白处按下 → 移动 → 抬起（断言基于拖动前的状态） */
const from = { x: v0.stage.l + 120, y: v0.stage.t + v0.stage.h - 120 };
await Input.dispatchMouseEvent({ type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
for (let i = 1; i <= 6; i++) {
  await Input.dispatchMouseEvent({ type: "mouseMoved", x: from.x + i * 15, y: from.y + i * 9, button: "left", buttons: 1 });
  await sleep(16);
}
await Input.dispatchMouseEvent({ type: "mouseReleased", x: from.x + 90, y: from.y + 54, button: "left", buttons: 0, clickCount: 1 });
await sleep(200);
let v1 = await view();
check(
  "拖动平移生效（位移 = 拖动距离）",
  Math.abs(v1.x - (v0.x + 90)) < 2 && Math.abs(v1.y - (v0.y + 54)) < 2,
  `x ${v0.x}→${v1.x} y ${v0.y}→${v1.y}（期望 +90 / +54）`,
);

/* ② Ctrl+滚轮：以光标为中心缩放，光标下的内容点不应漂移 */
const zoomAt = { x: v1.stage.l + 420, y: v1.stage.t + 300 };
const before = await localAt(zoomAt.x - v1.stage.l, zoomAt.y - v1.stage.t);
for (let i = 0; i < 4; i++) {
  await Input.dispatchMouseEvent({ type: "mouseWheel", x: zoomAt.x, y: zoomAt.y, deltaX: 0, deltaY: -120, modifiers: 2 });
  await sleep(60);
}
await sleep(200);
const after = await localAt(zoomAt.x - v1.stage.l, zoomAt.y - v1.stage.t);
const v2 = after.view;
check("Ctrl+滚轮放大", v2.scale > v1.scale * 1.2, `scale ${v1.scale} → ${v2.scale}`);
const drift = Math.hypot(after.u - before.u, after.v - before.v) * v2.scale;
check("缩放锚定在光标（漂移 < 2px）", drift < 2, `漂移 ${drift.toFixed(2)}px`);
check("控制条百分比跟随", /%$/.test(v2.chip ?? ""), `chip=${v2.chip}`);

/* ③ 控制条：点击 + / − */
const click = async (sel) => {
  const p = await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
  if (!p) return false;
  await Input.dispatchMouseEvent({ type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 });
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(250);
  return true;
};
await click(".card-zoom-btn");
const v3 = await view();
check("点击「−」缩小", v3.scale < v2.scale, `scale ${v2.scale} → ${v3.scale}`);

/* ④ 双击复位 */
const dz = { x: v3.stage.l + 200, y: v3.stage.t + v3.stage.h - 200 };
await Input.dispatchMouseEvent({ type: "mousePressed", x: dz.x, y: dz.y, button: "left", buttons: 1, clickCount: 1 });
await Input.dispatchMouseEvent({ type: "mouseReleased", x: dz.x, y: dz.y, button: "left", buttons: 0, clickCount: 1 });
await Input.dispatchMouseEvent({ type: "mousePressed", x: dz.x, y: dz.y, button: "left", buttons: 1, clickCount: 2 });
await Input.dispatchMouseEvent({ type: "mouseReleased", x: dz.x, y: dz.y, button: "left", buttons: 0, clickCount: 2 });
await sleep(300);
const v4 = await view();
check("双击复位到适应窗口", v4.x === 0 && v4.y === 0 && Math.abs(v4.scale - v4.fitScale) < 0.001, `x=${v4.x} y=${v4.y} scale=${v4.scale}`);

console.log(`\n==== 画布交互: ${results.filter(Boolean).length}/${results.length} PASS ====`);
await client.close();
