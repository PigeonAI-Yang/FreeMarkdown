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
await ev(`(() => { window.__pm = []; window.addEventListener('pointermove', e => { if (window.__pm.length < 40) window.__pm.push({ b: e.buttons, t: e.type, x: e.clientX, y: e.clientY, pid: e.pointerId }); }, true); return 1; })()`);
const p = await ev(`(() => { const t = document.querySelector('.dv-tab').getBoundingClientRect(); return { x: Math.round(t.x + t.width/2), y: Math.round(t.y + t.height/2) }; })()`);
await Input.dispatchMouseEvent({ type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 });
for (let i = 1; i <= 3; i++) { await Input.dispatchMouseEvent({ type: "mouseMoved", x: p.x + i*20, y: p.y + i*10, button: "left", buttons: 1 }); await sleep(20); }
await Input.dispatchMouseEvent({ type: "mouseMoved", x: p.x + 200, y: p.y + 120, button: "left", buttons: 0 });
await sleep(200);
console.log("pointermove 序列:", JSON.stringify(await ev(`window.__pm`)));
console.log("覆盖层:", JSON.stringify(await ev(`({ ghost: [...document.querySelectorAll('body > div')].filter(d=>d.style.zIndex==='9999').length, ind: [...document.querySelectorAll('body > div')].filter(d=>d.style.zIndex==='9998').length })`)));
await Input.dispatchMouseEvent({ type: "mouseReleased", x: p.x + 200, y: p.y + 120, button: "left", buttons: 0, clickCount: 1 });
await client.close();
