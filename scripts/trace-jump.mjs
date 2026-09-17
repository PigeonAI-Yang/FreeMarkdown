import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223, wait: true });
const { Runtime } = client;
// 在 flashAndCenter 语义上插桩：监听 search-flash 类变化 + scroll 事件
const r = await Runtime.evaluate({
  expression: `(() => {
    window.__trace = [];
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes' && m.attributeName === 'class') {
          const el = m.target;
          if (el.classList && el.classList.contains('search-flash')) {
            const doc = el.closest('.doc-content');
            window.__trace.push('FLASH on path=' + (doc && doc.getAttribute('data-path')) + ' tag=' + el.tagName);
          }
        }
      }
    });
    obs.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
    document.querySelectorAll('.doc-scroll').forEach(sc => {
      sc.addEventListener('scroll', () => {
        window.__trace.push('SCROLL top=' + Math.round(sc.scrollTop) + ' in ' + (sc.querySelector('.doc-content')?.getAttribute('data-path') || '?'));
      }, { passive: true });
    });
    return 'tracing';
  })()`,
  returnByValue: true,
});
console.log(r.result?.value ?? 'ERR');
// 触发一次真实点击
const r2 = await Runtime.evaluate({
  expression: `(() => {
    const a = [...document.querySelectorAll('aside')].find(x => x.querySelector('input'));
    const heads = [...a.querySelectorAll('div')].filter(d => d.title && d.title.includes('note-'));
    for (const h of heads.slice(20, 60)) {
      const row = h.nextElementSibling;
      if (row && row.title && row.title.includes('行')) { row.click(); return h.textContent.slice(0,16) + '|' + row.title; }
    }
    return 'none';
  })()`,
  returnByValue: true,
});
console.log('clicked:', r2.result?.value ?? 'ERR');
await new Promise(rr => setTimeout(rr, 3000));
const r3 = await Runtime.evaluate({ expression: `JSON.stringify(window.__trace.slice(0, 12))`, returnByValue: true });
console.log('trace:', r3.result?.value ?? 'ERR');
client.close();
