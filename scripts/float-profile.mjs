import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223, wait: true });
const { Runtime } = client;
const evalJs = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }).then(r => {
  if (r.exceptionDetails) throw new Error("eval fail");
  return r.result.value;
});
// 确保侧边栏关闭，然后打开并采样
await evalJs("(() => { const b=[...document.querySelectorAll('header .icon-btn')].find(x=>x.title==='侧边栏'); const s=[...document.querySelectorAll('aside')].find(a=>a.textContent.startsWith('资源')); if(s) b.click(); return 'ok'; })()");
await new Promise(r => setTimeout(r, 600));
const res = await evalJs(`(async () => {
  const btn=[...document.querySelectorAll('header .icon-btn')].find(x=>x.title==='侧边栏');
  const main = document.querySelector('main');
  const mainW0 = Math.round(main.getBoundingClientRect().width);
  btn.click();
  const t0 = performance.now();
  let frames = 0, maxGap = 0, last = t0, mainMoved = 0;
  await new Promise(done => {
    const loop = () => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last); last = now; frames++;
      if (Math.abs(main.getBoundingClientRect().width - mainW0) > 2) mainMoved++;
      if (now - t0 < 500) requestAnimationFrame(loop); else done();
    };
    requestAnimationFrame(loop);
  });
  return { fps: Math.round(frames/((performance.now()-t0)/1000)), maxGapMs: Math.round(maxGap), mainMovedFrames: mainMoved, mainW0 };
})()`);
console.log(JSON.stringify(res));
client.close();
