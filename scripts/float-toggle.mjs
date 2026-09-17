import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223, wait: true });
const { Runtime } = client;
const evalJs = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }).then(r => {
  if (r.exceptionDetails) throw new Error("eval fail");
  return r.result.value;
});
// 连续开关 3 次，每次间隔 600ms，记录最终态
const res = await evalJs(`(async () => {
  const btn=[...document.querySelectorAll('header .icon-btn')].find(x=>x.title==='侧边栏');
  const state = () => {
    const a=[...document.querySelectorAll('aside')].find(x=>x.textContent.startsWith('资源'));
    return (a ? 'mounted-x' + Math.round(a.getBoundingClientRect().x) : 'unmounted') + ' vis=' + window.__fm.appStore.get().sidebarVisible;
  };
  const log = ['start:' + state()];
  for (let i = 0; i < 3; i++) {
    btn.click();
    await new Promise(r => setTimeout(r, 600));
    log.push('after-click' + (i+1) + ':' + state());
  }
  return log;
})()`);
console.log(JSON.stringify(res, null, 0));
client.close();
