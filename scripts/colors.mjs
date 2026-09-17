import CDP from "chrome-remote-interface";
const client = await CDP({ port: 9223, wait: true });
const { Runtime } = client;
const expr = `(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return sel + ': MISSING';
    const cs = getComputedStyle(el);
    return sel + ' | color=' + cs.color + ' bg=' + cs.backgroundColor;
  };
  return [
    pick('.doc-content p'),
    pick('.doc-content pre'),
    pick('.doc-content pre code .hljs-string'),
    pick('.doc-content pre code .hljs-number'),
    pick('.doc-content pre code .hljs-comment'),
    pick('.doc-content pre code .hljs-keyword'),
    pick('.doc-content a'),
    pick('.doc-content h1'),
    pick('aside'),
    pick('header'),
  ].join(String.fromCharCode(10));
})()`;
const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
console.log(r.result?.value ?? JSON.stringify(r.exceptionDetails).slice(0,300));
client.close();
