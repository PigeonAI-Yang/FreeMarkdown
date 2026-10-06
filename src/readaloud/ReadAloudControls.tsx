import './readaloud.css';
import { useApp } from '../lib/store';
import { moveParagraph, pauseReading, readingTitle, resumeReading, startReading, stopReading, useReadAloud } from './service';
const labels:Record<string,string>={idle:'朗读',loading:'准备音频',playing:'正在朗读',paused:'已暂停',finished:'朗读完成',changed:'文档已更改',error:'朗读失败'};
export function ReadAloudControls() {
  const app=useApp(),s=useReadAloud();
  const active=['loading','playing','paused'].includes(s.status);
  const perform=(p:Promise<unknown>)=>{void p.catch(e=>console.error('[readaloud]',e));};
  return <div className="readaloud-controls" onDoubleClick={e=>e.stopPropagation()}>
    <button className="icon-btn text-[12px]" data-readaloud="start" disabled={!app.activePanelPath && !active} title={s.path?`朗读文档：${s.path}`:'朗读当前文档'} onClick={()=>{
      if(s.status==='paused')perform(resumeReading());
      else if(active)perform(pauseReading());
      else if(app.activePanelPath)perform(startReading(app.activePanelPath));
    }}>{s.status==='paused'?'▶ 继续':active?'Ⅱ 暂停':'▷ 朗读'}</button>
    <button className="icon-btn text-[11px]" data-readaloud="from-here" title="从当前可见段落开始" disabled={!app.activePanelPath} onClick={()=>{
      if(app.activePanelPath) perform(startReading(app.activePanelPath,true));
    }}>从这里朗读</button>
    {active && <>
      <button className="icon-btn" title="上一段" onClick={()=>perform(moveParagraph(-1))}>‹</button>
      <button className="icon-btn" title="下一段" onClick={()=>perform(moveParagraph(1))}>›</button>
      <button className="icon-btn" data-readaloud="stop" title="停止朗读" onClick={()=>perform(stopReading())}>□</button>
    </>}
    {(active||s.error||s.status==='finished') && <span className="readaloud-status" title={s.error||s.path}>{s.error||`${labels[s.status]} · ${readingTitle(s.path)}${s.line?` · 第 ${s.line} 行`:''}`}</span>}
  </div>;
}
