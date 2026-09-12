const KEY = 'download_history_v1';
export const active = job => ['starting','downloading','finalizing','cancelling'].includes(job.status);
const positive = value => Number.isFinite(Number(value)) && Number(value)>0 ? Number(value) : null;
export class DownloadManager {
  constructor(api) {
    this.api=api; this.ports=new Map(); this.rows=[];
    this.queue=(async()=>{
      this.rows=(await api.storage.local.get(KEY))[KEY] || [];
      for(const row of this.rows) if(active(row) && row.kind!=='file') Object.assign(row,{status:'interrupted',error:'浏览器关闭或扩展重新加载，下载已中断',updatedAt:Date.now()});
      await this.save();
    })();
    api.downloads.onChanged.addListener(()=>{this.list().catch(console.error);});
  }
  run(fn) {const next=this.queue.catch(()=>{}).then(fn);this.queue=next;return next;}
  async save() {
    // Persist metadata only: no signed URLs or browser credentials in download history.
    await this.api.storage.local.set({[KEY]:this.rows});
    this.api.runtime.sendMessage({type:'DOWNLOADS_CHANGED'}).catch(()=>{});
  }
  async refreshFiles() {
    let changed=false;
    for(const row of this.rows) if(row.kind==='file' && active(row) && row.browserId!=null) {
      const [item]=await this.api.downloads.search({id:row.browserId});
      const before=JSON.stringify(row);
      if(!item) Object.assign(row,{status:'interrupted',error:'浏览器下载记录已不存在'});
      else {
        row.bytes=item.bytesReceived || 0;row.totalBytes=positive(item.totalBytes);row.path=item.filename || row.path;
        row.percent=row.totalBytes ? Math.min(99,Math.floor(row.bytes/row.totalBytes*100)) : null;
        if(item.state==='complete') Object.assign(row,{status:'complete',percent:100});
        else if(item.state==='interrupted') Object.assign(row,{status:row.status==='cancelling'?'cancelled':'failed',error:item.error || '下载中断'});
        else if(row.status!=='cancelling') row.status='downloading';
      }
      if(before!==JSON.stringify(row)){row.updatedAt=Date.now();changed=true;}
    }
    if(changed) await this.save();
  }
  list() {return this.run(async()=>{await this.refreshFiles();return structuredClone(this.rows);});}
  start(input) {
    return this.run(async()=>{
      if(!['file','hls','dash'].includes(input.kind) || !/^https?:$/.test(new URL(input.url).protocol)) throw new Error('无效的媒体地址');
      const existing=this.rows.find(r=>input.mediaId && r.mediaId===input.mediaId && active(r));
      if(existing) return structuredClone(existing);
      const row={id:crypto.randomUUID(),mediaId:input.mediaId,title:String(input.title || '视频').slice(0,300),kind:input.kind,
        quality:input.height ? `${input.height}p` : '',status:'starting',seconds:0,bytes:0,duration:positive(input.duration),
        percent:null,speed:null,createdAt:Date.now(),updatedAt:Date.now()};
      this.rows.unshift(row);await this.save();
      try {
        if(input.kind==='file') {
          row.browserId=await this.api.downloads.download({url:input.url,filename:input.filename,saveAs:true});
          row.status='downloading';await this.save();
        } else {
          const port=this.api.runtime.connectNative('com.any_video_download.helper');this.ports.set(row.id,port);
          port.onMessage.addListener(msg=>{this.update(row.id,msg).catch(console.error);});
          port.onDisconnect.addListener(()=>{
            const error=this.api.runtime.lastError;
            this.ports.delete(row.id);
            this.update(row.id,{type:'disconnected',error:error ? '下载助手连接失败，请检查本地助手注册。' : '下载助手连接中断'}).catch(console.error);
          });
          port.postMessage({...input,type:'download'});
        }
      } catch(error) {row.status='failed';row.error=error.message;await this.save();}
      return structuredClone(row);
    });
  }
  update(id,msg) {
    return this.run(async()=>{
      const row=this.rows.find(r=>r.id===id);if(!row || !active(row))return;
      if(msg.type==='started' && row.status!=='cancelling') row.status='downloading';
      if(msg.type==='progress' && row.status!=='cancelling') {
        row.seconds=Math.max(row.seconds,positive(msg.seconds) || 0);row.bytes=Math.max(row.bytes,positive(msg.bytes) || 0);
        row.speed=positive(msg.speed);row.percent=row.duration ? Math.min(99,Math.floor(row.seconds/row.duration*100)) : null;
        row.status=row.duration && row.seconds>=row.duration ? 'finalizing' : 'downloading';
      }
      if(msg.type==='done') Object.assign(row,{status:'complete',percent:100,path:msg.path,bytes:positive(msg.bytes) || row.bytes});
      if(['error','disconnected'].includes(msg.type)) Object.assign(row,{status:row.status==='cancelling'?'cancelled':msg.type==='disconnected'?'interrupted':'failed',error:row.status==='cancelling'?'已取消下载':msg.error});
      row.updatedAt=Date.now();await this.save();
      if(!active(row)){const port=this.ports.get(id);this.ports.delete(id);port?.disconnect();}
    });
  }
  cancel(id) {
    return this.run(async()=>{
      const row=this.rows.find(r=>r.id===id);if(!row || !active(row))return;
      row.status='cancelling';await this.save();
      if(row.kind==='file' && row.browserId!=null) await this.api.downloads.cancel(row.browserId);
      else if(this.ports.has(id)) this.ports.get(id).postMessage({type:'cancel'});
      else {row.status='interrupted';await this.save();}
    });
  }
}
