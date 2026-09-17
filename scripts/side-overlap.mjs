import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223, wait: true });
const { Runtime } = client;
const evalJs = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }).then(r => {
  if (r.exceptionDetails) throw new Error("eval fail");
  return r.result.value;
});
// 确保两侧面板都打开
await evalJs("(() => { for (const t of ['侧边栏','目录']) { const b=[...document.querySelectorAll('header .icon-btn')].find(x=>x.title===t); const open = t==='侧边栏' ? [...document.querySelectorAll('aside')].some(a=>a.textContent.startsWith('资源')) : [...document.querySelectorAll('aside')].some(a=>a.textContent.includes('目录联动')||a.textContent.startsWith('目录')); if(!open) b.click(); } return 'ok'; })()");
await new Promise(r => setTimeout(r, 800));
// 关闭侧边栏，采样中栏左边缘 + 右目录面板位置
const res = await evalJs(`(async () => {
  const btn=[...document.querySelectorAll('header .icon-btn')].find(x=>x.title==='侧边栏');
  btn.click();
  const samples = [];
  const t0 = performance.now();
  await new Promise(done => {
    const loop = () => {
      const now = performance.now();
      const main = document.querySelector('main');
      const asides = [...document.querySelectorAll('aside')];
      const toc = asides.find(a=>!a.querySelector('input')&&!a.textContent.startsWith('资源'));
      const mr = main.getBoundingClientRect();
      samples.push({ t: Math.round(now-t0), mainX: Math.round(mr.x), mainW: Math.round(mr.width), tocX: toc?Math.round(toc.getBoundingClientRect().x):-1, tocW: toc?Math.round(toc.getBoundingClientRect().width):-1 });
      if (now - t0 < 500) requestAnimationFrame(loop); else done();
    };
    requestAnimationFrame(loop);
  });
  return samples.filter((_,i)=>i%4===0);
})()`);
console.log(JSON.stringify(res, null, 0));
client.close();
