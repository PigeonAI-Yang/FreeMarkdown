const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (all, key) => {
    if (key[0] !== '#') return entities[key] ?? all;
    const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2),16) : +key.slice(1);
    return n>0 && n<=0x10ffff ? String.fromCodePoint(n) : '';
  });
}
export function* paragraphs(chunks) {
  for (let chunk = 0; chunk < chunks.length; chunk++) {
    const stack = [];
    let current = null;
    const flush = () => {
      if (!current) return null;
      const value = { ...current, text: decode(current.text).replace(/\s+/g,' ').trim() };
      current.text = '';
      return value.text ? value : null;
    };
    for (const match of chunks[chunk].matchAll(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g)) {
      const token = match[0];
      if (token.startsWith('<!--')) continue;
      if (token[0] !== '<') {
        if (current && !stack.some(x=>x.skip)) current.text += token;
        continue;
      }
      const tag = /^<\/?([\w-]+)/.exec(token)?.[1]?.toLowerCase();
      if (!tag) continue;
      if (token[1] === '/') {
        if (current?.tag === tag) { const p=flush(); if(p) yield p; current=null; }
        const i=stack.map(x=>x.tag).lastIndexOf(tag);
        if(i>=0) stack.splice(i);
        const parent=[...stack].reverse().find(x=>x.block);
        if(!current && parent) current={tag:parent.tag,line:parent.line,chunk,text:''};
        continue;
      }
      const skip = ['pre','table','script','style','svg'].includes(tag) || /class=["'][^"']*(?:math|mermaid|katex)/i.test(token);
      const block = /^(p|h[1-6]|li)$/.test(tag) && !skip && !stack.some(x=>x.skip);
      const line=+( /data-sourcepos=["'](\d+):/.exec(token)?.[1] ?? 0 );
      if(block) { const p=flush(); if(p) yield p; current={tag,line,chunk,text:''}; }
      if(tag==='br' && current) current.text+=' ';
      if(!['img','br','hr','input','wbr'].includes(tag) && !token.endsWith('/>')) stack.push({tag,skip,block,line});
    }
    const p=flush(); if(p) yield p;
  }
}
export function sentences(text) {
  const result=[];
  for(const s of text.match(/[^。！？.!?]+[。！？.!?]*|[。！？.!?]+/g) ?? []) {
    for(let i=0;i<s.length;i+=160) { const value=s.slice(i,i+160).trim(); if(value) result.push(value); }
  }
  return result;
}
