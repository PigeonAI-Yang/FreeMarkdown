import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackOwner } from './owner.mjs';
const units = function* () { for(let i=0;i<20;i++) yield {text:'句'+i,line:i+1,paragraph:i}; };
test('no auto start, bounded two units, playback-derived progress and pause',()=>{
  const o=new PlaybackOwner(); assert.deepEqual(o.take(),[]);
  o.start('a',1,units()); const t=o.token;
  const jobs=o.take(); assert.equal(jobs.length,2); assert.equal(o.current,null); assert.deepEqual(o.take(),[]);
  o.pause(); assert.equal(o.event(t,'playing',jobs[0]),false); o.resume();
  assert.equal(o.event(t,'playing',jobs[0]),true); assert.equal(o.current.line,1);
  o.event(t,'done',jobs[0]); assert.equal(o.take().length,1);
});
test('stop and new owner discard stale completion; source refresh stops old snapshot',()=>{
  const o=new PlaybackOwner(); o.start('a',1,units()); const t=o.token,j=o.take()[0];
  o.stop(); assert.equal(o.event(t,'playing',j),false); assert.deepEqual(o.take(),[]);
  o.start('b',2,units()); assert.equal(o.event(t,'done',j),false); assert.equal(o.path,'b');
  o.refresh('a',3); assert.equal(o.status,'loading');
  o.refresh('b',3); assert.equal(o.status,'changed'); assert.deepEqual(o.take(),[]);
});
test('completion racing pause releases one slot without advancing until resume',()=>{
  const o=new PlaybackOwner();o.start('a',1,units());const t=o.token,j=o.take()[0];
  o.pause();assert.equal(o.event(t,'done',j),true);assert.deepEqual(o.take(),[]);
  o.resume();assert.equal(o.take().length,1);
});
