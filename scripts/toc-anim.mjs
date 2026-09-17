import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223, wait: true });
const { Runtime } = client;
const evalJs = (expr) => Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true }).then(r => {
  if (r.exceptionDetails) throw new Error("eval fail");
  return r.result.value;
});
// 确保目录可见
await evalJs("([...document.querySelectorAll('header .icon-btn')].find(b => b.title === '目录').click(), 'x')");
await new Promise(r => setTimeout(r, 600));
const present1 = await evalJs("!![...document.querySelectorAll('aside')].find(a => a.textContent.includes('目录'))");
// 测关闭动画帧率：点关闭后 250ms 内采样 transform 变化 + 长帧
const fps = await evalJs(`(async () => {
  const aside = [...document.querySelectorAll('aside')].find(a => a.textContent.includes('目录'));
  if (!aside) return 'no-aside';
  const t0 = performance.now();
  let frames = 0, maxGap = 0, last = t0;
  await new Promise(done => {
    const loop = () => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last); last = now; frames++;
      if (now - t0 < 300) requestAnimationFrame(loop); else done();
    };
    requestAnimationFrame(loop);
  });
  return { frames, fps: Math.round(frames / ((performance.now() - t0) / 1000)), maxGapMs: Math.round(maxGap) };
})()`);
console.log("close-anim:", JSON.stringify(fps));
await new Promise(r => setTimeout(r, 500));
console.log("aside-after-close:", await evalJs("!![...document.querySelectorAll('aside')].find(a => a.textContent.includes('目录'))"));
// 重新打开，验证滑入
await evalJs("([...document.querySelectorAll('header .icon-btn')].find(b => b.title === '目录').click(), 'x')");
await new Promise(r => setTimeout(r, 500));
console.log("aside-after-open:", await evalJs("!![...document.querySelectorAll('aside')].find(a => a.textContent.includes('目录'))"));
client.close();
