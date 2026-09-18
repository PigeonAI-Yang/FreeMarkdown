// 覆盖层兜底清理验证（两条路径）：
//   A. 守卫：拖拽中收到「按钮已松开」的 pointermove（用 JS 合成事件，CDP 合成输入无法表达 buttons=0）
//   B. 指针捕获：在视口外松手，pointerup 仍应送达 → 正常收尾
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
const overlays = () =>
  ev(`({ ghost: [...document.querySelectorAll("body > div")].filter(d => d.style.zIndex === "9999").length, ind: [...document.querySelectorAll("body > div")].filter(d => d.style.zIndex === "9998").length })`);

const tabPoint = () =>
  ev(`(() => { const t = document.querySelector(".dv-tab").getBoundingClientRect(); return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) }; })()`);

async function startDrag(p, moves = 4) {
  await Input.dispatchMouseEvent({ type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= moves; i++) {
    await Input.dispatchMouseEvent({ type: "mouseMoved", x: p.x + i * 18, y: p.y + i * 12, button: "left", buttons: 1 });
    await sleep(18);
  }
}

// --- A. 守卫：JS 合成「按钮已松开」的 pointermove ---
let p = await tabPoint();
await startDrag(p);
console.log("A 拖拽中:", JSON.stringify(await overlays()));
await ev(`(() => {
  const e = new PointerEvent("pointermove", { pointerId: 1, pointerType: "mouse", buttons: 0, clientX: ${p.x + 150}, clientY: ${p.y + 120}, bubbles: true });
  window.dispatchEvent(e);
  return 1;
})()`);
await sleep(150);
console.log("A 收到 buttons=0 的 move 后:", JSON.stringify(await overlays()), "(期望 0/0)");
await Input.dispatchMouseEvent({ type: "mouseReleased", x: p.x + 72, y: p.y + 48, button: "left", buttons: 0, clickCount: 1 });
await sleep(200);

// --- B. 指针捕获：视口外松手 ---
p = await tabPoint();
await startDrag(p, 5);
console.log("B 拖拽中:", JSON.stringify(await overlays()));
const before = await ev(`window.__fm.dock.groups.length`);
await Input.dispatchMouseEvent({ type: "mouseReleased", x: -40, y: -40, button: "left", buttons: 0, clickCount: 1 });
await sleep(250);
console.log("B 视口外松手后:", JSON.stringify(await overlays()), "(期望 0/0)");
console.log("B 分组数未变:", before, "->", await ev(`window.__fm.dock.groups.length`));
await client.close();
