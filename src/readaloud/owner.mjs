export class PlaybackOwner {
  constructor() { this.token=0; this.status='idle'; this.pending=[]; this.current=null; }
  start(path,mtime,units) {
    this.stop(); this.path=path; this.mtime=mtime; this.units=units;
    this.status='loading'; this.exhausted=false;
  }
  take() {
    if(!['loading','playing'].includes(this.status)) return [];
    const jobs=[];
    while(this.pending.length<2 && !this.exhausted) {
      const next=this.units.next();
      if(next.done) { this.exhausted=true; break; }
      this.pending.push(next.value); jobs.push(next.value);
    }
    if(this.exhausted && !this.pending.length) this.status='finished';
    return jobs;
  }
  event(token,kind,unit) {
    if(token!==this.token || !['loading','playing','paused'].includes(this.status) || (this.status==='paused' && kind==='playing')) return false;
    if(kind==='playing') { this.current=unit; this.status='playing'; }
    if(kind==='done') this.pending=this.pending.filter(x=>unit.id===undefined ? x!==unit : x.id!==unit.id);
    return true;
  }
  pause() { if(['loading','playing'].includes(this.status)) this.status='paused'; }
  resume() { if(this.status==='paused') this.status=this.current?'playing':'loading'; }
  stop() { this.token++; this.status='idle'; this.pending=[]; this.current=null; }
  refresh(path,mtime) { if(path===this.path && mtime!==this.mtime) { this.stop(); this.status='changed'; } }
}
