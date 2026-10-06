export interface Unit { text: string; line: number; paragraph: number; id: number; chunk: number }
export class PlaybackOwner {
  token: number; status: string; path?: string; mtime?: number; pending: Unit[]; current: Unit|null;
  start(path:string,mtime:number,units:Generator<Unit>):void;
  take():Unit[];
  event(token:number,kind:string,unit:Unit):boolean;
  pause():void; resume():void; stop():void; refresh(path:string,mtime:number):void;
}
