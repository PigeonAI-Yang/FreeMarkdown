import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223, wait: true });
const { Runtime } = client;
const evalJs = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }).then(r => {
  if (r.exceptionDetails) throw new Error("eval fail");
  return r.result.value;
});
// 确保打开
await evalJs("(() => { const b=[...document.querySelectorAll('header .icon-btn')].find(x=>x.title==='目录'); const asides=[...document.querySelectorAll('aside')].filter(a=>!a.querySelector('input')&&!a.textContent.startsWith('资源')); if(asides.length===0) b.click(); return 'ok'; })()");
await new Promise(r => setTimeout(r, 700));
// 关闭并采样宽度序列 + 帧率
const res = await evalJs(`(async () => {
  const btn=[...document.querySelectorAll('header .icon-btn')].find(x=>x.title==='目录');
  btn.click();
  const widths = [];
  const t0 = performance.now();
  let frames = 0, maxGap = 0, last = t0;
  await new Promise(done => {
    const loop = () => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last); last = now; frames++;
      const a=[...document.querySelectorAll('aside')].find(x=>!x.querySelector('input')&&!x.textContent.startsWith('资源'));
      widths.push(a ? Math.round(a.getBoundingClientRect().width) : -1);
      if (now - t0 < 450) requestAnimationFrame(loop); else done();
    };
    requestAnimationFrame(loop);
  });
  return { widths: widths.filter((_,i)=>i%3===0), fps: Math.round(frames/((performance.now()-t0)/1000)), maxGapMs: Math.round(maxGap) };
})()`);
console.log(JSON.stringify(res));
// 重新打开截图
await evalJs("([...document.querySelectorAll('header .icon-btn')].find(x=>x.title==='目录').click(), 'x')");
await new Promise(r => setTimeout(r, 600));
client.close();
