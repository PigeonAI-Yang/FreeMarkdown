import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSyncExternalStore } from 'react';
import { api, basename, type DocPayload } from '../lib/ipc';
import { appStore, jumpRegistry, onDocSaved } from '../lib/store';
import { paragraphs, sentences } from './text.mjs';
import { PlaybackOwner, type Unit } from './owner.mjs';

const owner = new PlaybackOwner();
const listeners = new Set<()=>void>();
const saved = (()=>{try{return JSON.parse(localStorage.getItem('readaloud-preferences')??'{}')}catch{return {}}})();
let preferences={voice: 0, speed: saved.speed>=0.6&&saved.speed<=1.6?saved.speed:1, modelDir: typeof saved.modelDir==='string'?saved.modelDir:''};
let follow=false;
let snapshot={status:'idle',path:'',line:0,paragraph:0,text:'',error:'',...preferences,follow};
let documentSnapshot:DocPayload|null=null;
let ready:Promise<()=>void>|null=null;
let request=0;
let watchedPath:string|null=null;
let defaultModelReady:Promise<void>|null=null;
function ensureDefaultModel() {
  if(!defaultModelReady) defaultModelReady=(async()=>{
    if(preferences.modelDir) return;
    try {
      const modelDir=await invoke<string>('readaloud_default_model_dir');
      if(!preferences.modelDir) {preferences={...preferences,modelDir};update();}
    } catch(e) {update(String(e));}
  })();
  return defaultModelReady;
}
const update=(error='')=>{
  snapshot={status:owner.status,path:owner.path??'',line:owner.current?.line??0,paragraph:owner.current?.paragraph??0,text:owner.current?.text??'',error,...preferences,follow};
  for(const l of listeners) l();
  highlightReading();
};
export function useReadAloud() {return useSyncExternalStore(l=>{listeners.add(l);return()=>{listeners.delete(l)}},()=>snapshot);}
export function highlightReading() {
  document.querySelectorAll('.readaloud-current').forEach(el=>el.classList.remove('readaloud-current'));
  if(!owner.current || !['playing','paused'].includes(owner.status)) return;
  document.querySelectorAll(`.doc-scroll[data-reading-path="${CSS.escape(owner.path??'')}"] [data-sourcepos]`).forEach(el=>{
    if(/^(P|LI|H[1-6])$/.test(el.tagName) && +(el.getAttribute('data-sourcepos')?.split(':')[0]??0)===owner.current!.line) el.classList.add('readaloud-current');
  });
}
function* units(doc:DocPayload,startParagraph=0,startLine=0):Generator<Unit> {
  let paragraph=0,id=0;
  for(const p of paragraphs(doc.chunks)) {
    const index=paragraph++;
    if(index<startParagraph || p.line<startLine) continue;
    for(const text of sentences(p.text)) yield {text,line:p.line,chunk:p.chunk,paragraph:index,id:id++};
  }
}
async function pump() {
  const token=owner.token;
  for(const unit of owner.take()) {
    try {await invoke('readaloud_enqueue',{job:{...unit,token,modelDir:preferences.modelDir,voice:preferences.voice,speed:preferences.speed}});}
    catch(e) {if(token===owner.token) {await stopReading(); owner.status='error';update(String(e));}return;}
  }
  update();
}
function ensureEvents() {
  if(!ready) ready=listen<{token:number;kind:string;unit:Unit;error?:string}>('readaloud:event',e=>{
    const {token,kind,unit,error}=e.payload;
    if(token!==owner.token) return;
    if(kind==='error') {void stopReading().then(()=>{owner.status='error';update(error??'朗读失败')});return;}
    if(owner.event(token,kind,unit)) {
      if(kind==='playing' && follow && owner.path) jumpRegistry.get(owner.path)?.({line:unit.line});
      update();
      if(kind==='done') void pump();
    }
  });
  return ready;
}
export function initializeReadAloud() {
  void ensureDefaultModel();
  void ensureEvents();
  const unSaved=onDocSaved(path=>{if(path===owner.path) invalidate(path,NaN)});
  let gone=false;
  let unChanged:(()=>void)|undefined;
  void listen<{path:string;mtimeMs:number}>('app:file-changed',e=>invalidate(e.payload.path,e.payload.mtimeMs)).then(fn=>{if(gone)fn();else unChanged=fn});
  const unsubscribe=appStore.subscribe(()=>{if(appStore.get().settingsOpen)void pauseReading()});
  return ()=>{gone=true;unChanged?.();unSaved();unsubscribe()};
}
function invalidate(path:string,mtime:number) {
  if(path!==owner.path || mtime===owner.mtime || ['idle','finished','changed'].includes(owner.status)) return;
  request++; owner.refresh(path,mtime); documentSnapshot=null;
  void invoke('readaloud_reset',{token:owner.token});update('文档已更改，请重新开始朗读。');
}
export function sourceClosed(path:string) {if(path===owner.path) void stopReading();}
export async function stopReading() {
  request++;owner.stop();
  const watched=watchedPath;watchedPath=null;
  await invoke('readaloud_reset',{token:owner.token});
  if(watched) await api.unwatchFile(watched).catch(()=>{});
  update();
}
export async function pauseReading() {owner.pause();await invoke('readaloud_pause',{paused:true});update();}
export async function resumeReading() {owner.resume();await invoke('readaloud_pause',{paused:false});await pump();}
export async function startReading(path:string,fromHere=false) {
  await ensureDefaultModel();
  await ensureEvents(); await stopReading();
  const serial=++request;
  owner.path=path;owner.status='loading';update();
  try {
    const doc=await api.readMarkdown(path);
    if(serial!==request) return;
    documentSnapshot=doc;
    let line=0;
    if(fromHere) {
      const surface=document.querySelector(`.doc-scroll[data-reading-path="${CSS.escape(path)}"]`);
      const top=surface?.getBoundingClientRect().top??0;
      const visible=Array.from(surface?.querySelectorAll('[data-sourcepos]')??[]).find(el=>el.getBoundingClientRect().bottom>top);
      line=+(visible?.getAttribute('data-sourcepos')?.split(':')[0]??0);
    }
    owner.start(path,doc.mtimeMs,units(doc,0,line));
    await api.watchFile(path);watchedPath=path;
    await invoke('readaloud_reset',{token:owner.token}); await pump();
  } catch(e) {if(serial===request){owner.status='error';update(String(e));}}
}
export async function moveParagraph(delta:number) {
  if(!documentSnapshot || !owner.path) return;
  const path=owner.path,doc=documentSnapshot,next=Math.max(0,(owner.current?.paragraph??0)+delta);
  await stopReading(); owner.start(path,doc.mtimeMs,units(doc,next));
  await api.watchFile(path);watchedPath=path;
  await invoke('readaloud_reset',{token:owner.token});await pump();
}
export async function setReadingPreference(patch:Partial<typeof preferences>) {
  if(owner.status==='playing'||owner.status==='loading'||owner.status==='paused') await stopReading();
  preferences={...preferences,...patch,voice:0};localStorage.setItem('readaloud-preferences',JSON.stringify(preferences));update();
}
export function setFollow(value:boolean) {follow=value;update();}
export function readingTitle(path:string) {return basename(path);}
