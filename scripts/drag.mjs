// 模拟 HTML5 拖拽（dockview 使用原生 DnD）：
//   node scripts/drag.mjs <x1> <y1> <x2> <y2>
import CDP from "chrome-remote-interface";

const [x1, y1, x2, y2] = process.argv.slice(2).map(Number);
const client = await CDP({ port: 9223, wait: true });
const { Input, Runtime } = client;

let dragData = null;
Input.dragIntercepted((e) => {
  dragData = e.data;
});

await Input.setInterceptDrags({ enabled: true });
await Input.dispatchMouseEvent({ type: "mouseMoved", x: x1, y: y1 });
await Input.dispatchMouseEvent({
  type: "mousePressed",
  x: x1,
  y: y1,
  button: "left",
  clickCount: 1,
});
await new Promise((r) => setTimeout(r, 120));

const steps = 12;
for (let i = 1; i <= steps; i++) {
  await Input.dispatchMouseEvent({
    type: "mouseMoved",
    x: x1 + ((x2 - x1) * i) / steps,
    y: y1 + ((y2 - y1) * i) / steps,
    button: "left",
    buttons: 1,
  });
  await new Promise((r) => setTimeout(r, 50));
}
await new Promise((r) => setTimeout(r, 300));

if (dragData) {
  // 完整的 enter → over → drop 序列
  await Input.dispatchDragEvent({ type: "dragEnter", x: x2, y: y2, data: dragData });
  await Input.dispatchDragEvent({ type: "dragOver", x: x2, y: y2, data: dragData });
  await new Promise((r) => setTimeout(r, 250));
  await Input.dispatchDragEvent({ type: "dragOver", x: x2, y: y2, data: dragData });
  await new Promise((r) => setTimeout(r, 150));
  await Input.dispatchDragEvent({ type: "drop", x: x2, y: y2, data: dragData });
  await new Promise((r) => setTimeout(r, 100));
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: x2, y: y2, button: "left", clickCount: 1 });
  console.log("drop dispatched with data (enter/over/drop)");
} else {
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: x2, y: y2, button: "left", clickCount: 1 });
  console.log("no dragIntercepted event — element not draggable");
}

await new Promise((r) => setTimeout(r, 700));
const r = await Runtime.evaluate({
  expression: `({ groups: document.querySelectorAll('.dv-groupview').length,
     tabs: [...document.querySelectorAll('.dv-tab')].map(t=>t.textContent.trim().slice(0,16)) })`,
  returnByValue: true,
});
console.log(JSON.stringify(r.result.value));
await Input.setInterceptDrags({ enabled: false });
client.close();
