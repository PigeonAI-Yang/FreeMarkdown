import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223, wait: true });
const { Runtime } = client;
const evalJs = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }).then(r => {
  if (r.exceptionDetails) throw new Error("eval fail");
  return r.result.value;
});
// 确保关闭再打开，采样：面板top/工具栏bottom/transform序列
await evalJs("(() => { const b=[...document.querySelectorAll('header .icon-btn')].find(x=>x.title==='侧边栏'); const s=[...document.querySelectorAll('aside')].find(a=>a.textContent.startsWith('资源')); if(s) b.click(); return 'ok'; })()");
await new Promise(r => setTimeout(r, 600));
const res = await evalJs(`(async () => {
  const btn=[...document.querySelectorAll('header .icon-btn')].find(x=>x.title==='侧边栏');
  const header = document.querySelector('header').getBoundingClientRect();
  btn.click();
  const t0 = performance.now();
  let frames = 0, maxGap = 0, last = t0;
  const tf = [];
  await new Promise(done => {
    const loop = () => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last); last = now; frames++;
      const a=[...document.querySelectorAll('aside')].find(x=>x.textContent.startsWith('资源'));
      if (a) {
        const rc = a.getBoundingClientRect();
        if (tf.length < 8) tf.push(Math.round(rc.x) + ':' + Math.round(rc.top));
      }
      if (now - t0 < 500) requestAnimationFrame(loop); else done();
    };
    requestAnimationFrame(loop);
  });
  const a=[...document.querySelectorAll('aside')].find(x=>x.textContent.startsWith('资源'));
  const rc = a ? a.getBoundingClientRect() : null;
  return { headerBottom: Math.round(header.bottom), panelTop: rc ? Math.round(rc.top) : -1,
    fps: Math.round(frames/((performance.now()-t0)/1000)), maxGapMs: Math.round(maxGap), path: tf.join(' ') };
})()`);
console.log(JSON.stringify(res));
client.close();
