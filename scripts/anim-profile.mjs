import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223, wait: true });
const { Runtime } = client;
const evalJs = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }).then(r => {
  if (r.exceptionDetails) throw new Error("eval fail");
  return r.result.value;
});
await evalJs("(() => { const b=[...document.querySelectorAll('header .icon-btn')].find(x=>x.title==='侧边栏'); const s=[...document.querySelectorAll('aside')].find(a=>a.textContent.startsWith('资源')); if(!s) b.click(); return 'ok'; })()");
await new Promise(r => setTimeout(r, 800));
const res = await evalJs(`(async () => {
  const btn=[...document.querySelectorAll('header .icon-btn')].find(x=>x.title==='侧边栏');
  // 记录每次 setWidth 渲染：劫持 requestAnimationFrame 计数 + 长任务
  const frames = [];
  const t0 = performance.now();
  let last = t0;
  btn.click();
  await new Promise(done => {
    const loop = () => {
      const now = performance.now();
      frames.push(Math.round((now-last)*10)/10); last = now;
      if (now - t0 < 600) requestAnimationFrame(loop); else done();
    };
    requestAnimationFrame(loop);
  });
  const over16 = frames.filter(g=>g>16.7);
  const over50 = frames.filter(g=>g>50);
  return { n: frames.length, avg: Math.round(frames.reduce((a,b)=>a+b,0)/frames.length*10)/10,
    over16: over16.length, over50: over50.length, max: Math.round(Math.max(...frames)),
    gaps: frames.slice(0, 20).join(',') };
})()`);
console.log(JSON.stringify(res));
client.close();
