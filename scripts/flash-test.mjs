import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223, wait: true });
const { Runtime } = client;
const r = await Runtime.evaluate({
  expression: `(() => {
    const contents = [...document.querySelectorAll('.doc-content')];
    const target = contents.find(c => (c.getAttribute('data-path') || '').includes('note-0020'));
    if (!target) return 'no-target:' + contents.map(c => c.getAttribute('data-path')).join('|');
    const p = target.querySelector('p[data-sourcepos]');
    p.classList.add('search-flash');
    const cs = getComputedStyle(p);
    return 'flashed anim=' + cs.animationName;
  })()`,
  returnByValue: true,
});
console.log(r.exceptionDetails ? 'EVAL-ERR' : r.result.value);
client.close();
