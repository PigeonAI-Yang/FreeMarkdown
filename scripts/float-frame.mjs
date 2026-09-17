import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223, wait: true });
const { Runtime } = client;
const evalJs = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }).then(r => {
  if (r.exceptionDetails) throw new Error("eval fail: " + JSON.stringify(r.exceptionDetails).slice(0,200));
  return r.result.value;
});
await evalJs("(() => { const b=[...document.querySelectorAll('header .icon-btn')].find(x=>x.title==='侧边栏'); const s=[...document.querySelectorAll('aside')].find(a=>a.textContent.startsWith('资源')); if(s) b.click(); return 'ok'; })()");
await new Promise(r => setTimeout(r, 600));
// 打开：逐帧记录 transform/opacity/width
const res = await evalJs(`(async () => {
  const btn=[...document.querySelectorAll('header .icon-btn')].find(x=>x.title==='侧边栏');
  btn.click();
  const seq = [];
  const t0 = performance.now();
  await new Promise(done => {
    const loop = () => {
      const now = performance.now();
      const a=[...document.querySelectorAll('aside')].find(x=>x.textContent.startsWith('资源'));
      if (a) {
        const cs = getComputedStyle(a);
        seq.push(Math.round(now-t0) + 'ms x=' + Math.round(a.getBoundingClientRect().x) + ' tf=' + cs.transform.slice(0,28) + ' op=' + cs.opacity);
      } else seq.push(Math.round(now-t0) + 'ms NO-ASIDE');
      if (now - t0 < 450) requestAnimationFrame(loop); else done();
    };
    requestAnimationFrame(loop);
  });
  return seq.filter((_,i)=>i%2===0);
})()`);
console.log(JSON.stringify(res, null, 0));
client.close();
