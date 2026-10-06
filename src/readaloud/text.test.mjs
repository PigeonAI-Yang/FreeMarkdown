import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paragraphs, sentences } from './text.mjs';
test('all raw chunks, repeated prose, source mapping and no nested duplication', () => {
  const chunks = ['<h1 data-sourcepos="1:1-1:5">标题</h1><p data-sourcepos="3:1-3:9">重复 &amp; <a href="x">链接</a></p>', '<blockquote><p data-sourcepos="5:1-5:8">重复</p></blockquote><ul><li data-sourcepos="7:1-9:5">父项<ul><li data-sourcepos="8:1-8:5">子项</li></ul></li><li data-sourcepos="10:1-11:5"><p data-sourcepos="10:1-10:5">段落项</p></li></ul>'];
  assert.deepEqual([...paragraphs(chunks)].map(p => [p.text,p.line]), [['标题',1],['重复 & 链接',3],['重复',5],['父项',7],['子项',8],['段落项',10]]);
});
test('skip code, math, tables and image descriptions, keep inline text', () => {
  assert.deepEqual([...paragraphs(['<pre><code>错误</code></pre><table><tr><td>错误</td></tr></table><p data-sourcepos="9:1-9:20">你好<img alt="错误"><span class="math">错误</span><code>世界</code></p>'])].map(p=>p.text), ['你好世界']);
});
test('lazy chunk access and bounded sentence length', () => {
  const chunks = ['<p>第一句。</p>'];
  Object.defineProperty(chunks,1,{get(){throw new Error('eager');}});
  assert.equal(paragraphs(chunks).next().value.text,'第一句。');
  assert.deepEqual(sentences('你好。再见！English text?'), ['你好。','再见！','English text?']);
  assert.ok(sentences('长'.repeat(500)).every(s=>s.length<=160));
});
