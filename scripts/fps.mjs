// 滚动帧率测量：在指定窗格上做连续滚动，统计 rAF 帧间隔。
//   node scripts/fps.mjs <滚动像素> [时长秒]
const px = Number(process.argv[2] || 200000);
const seconds = Number(process.argv[3] || 4);

import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223, wait: true });
const { Runtime } = client;

const r = await Runtime.evaluate({
  expression: `(async () => {
    const groups = [...document.querySelectorAll('.dv-groupview')];
    const scrollers = groups.map(g => g.querySelector('.doc-scroll')).filter(Boolean);
    if (scrollers.length === 0) return { error: 'no scroller' };
    const sc = scrollers[${0}];
    const t0 = performance.now();
    let frames = 0;
    let longFrames = 0;
    let last = t0;
    let maxGap = 0;
    const loop = () => {
      const now = performance.now();
      const gap = now - last;
      frames++;
      if (gap > 32) longFrames++;   // 超过 2 帧时间算长帧
      maxGap = Math.max(maxGap, gap);
      last = now;
      if (now - t0 < ${seconds * 1000}) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    const target = sc.scrollTop + ${px};
    const step = () => {
      sc.scrollTop = Math.min(sc.scrollTop + 60, target);
      if (sc.scrollTop < target && performance.now() - t0 < ${seconds * 1000}) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    await new Promise(r => setTimeout(r, ${seconds * 1000 + 300}));
    const elapsed = (performance.now() - t0) / 1000;
    return {
      fps: Math.round(frames / elapsed),
      longFrames,
      maxGapMs: Math.round(maxGap),
      scrolledTo: Math.round(sc.scrollTop),
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
console.log(JSON.stringify(r.result.value));
client.close();
