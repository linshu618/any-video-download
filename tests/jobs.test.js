import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const mod=fs.existsSync(new URL('../background/downloads.js',import.meta.url)) ? await import('../background/downloads.js') : {};
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);},emit(msg){for(const fn of this.listeners) fn(msg);}});
function api(data={}) {
  const ports=[]; const items=new Map();
  return {ports,items,storage:{local:{get:async k=>structuredClone({[k]:data[k]}),set:async v=>Object.assign(data,structuredClone(v))}},
    runtime:{connectNative(){const port={onMessage:event(),onDisconnect:event(),postMessage(){},disconnect(){this.onDisconnect.emit();}};ports.push(port);return port;},sendMessage:async()=>{}},
    downloads:{onChanged:event(),download:async()=>10,search:async({id})=>items.has(id)?[items.get(id)]:[],cancel:async()=>{}}};
}
test('Native progress persists and completed records survive manager recreation',async()=>{
  assert.equal(typeof mod.DownloadManager,'function');
  const data={},chrome=api(data), manager=new mod.DownloadManager(chrome);
  const job=await manager.start({url:'https://cdn.test/a.m3u8',kind:'hls',duration:100,title:'Example',mediaId:'a'});
  chrome.ports[0].onMessage.emit({type:'progress',seconds:40,bytes:2048,speed:2});
  let rows=await manager.list();assert.equal(rows[0].percent,40);assert.equal(rows[0].bytes,2048);
  chrome.ports[0].onMessage.emit({type:'done',path:'C:/Downloads/a.mp4',bytes:4096});
  rows=await manager.list();assert.equal(rows[0].status,'complete');assert.equal(rows[0].percent,100);
  const restored=await new mod.DownloadManager(api(data)).list();
  assert.equal(restored[0].id,job.id);assert.equal(restored[0].path,'C:/Downloads/a.mp4');
});
test('Unknown duration is indeterminate; output reaching duration is not premature success',async()=>{
  assert.equal(typeof mod.DownloadManager,'function');
  const chrome=api(),manager=new mod.DownloadManager(chrome);
  await manager.start({url:'https://cdn.test/a',kind:'hls',title:'Unknown'});
  chrome.ports[0].onMessage.emit({type:'progress',seconds:100});
  assert.equal((await manager.list())[0].percent,null);
  await manager.start({url:'https://cdn.test/b',kind:'hls',duration:100,title:'Known'});
  chrome.ports[1].onMessage.emit({type:'progress',seconds:101});
  const row=(await manager.list())[0];assert.equal(row.percent,99);assert.equal(row.status,'finalizing');
});
test('Worker restart labels unfinished native jobs interrupted, retaining history',async()=>{
  assert.equal(typeof mod.DownloadManager,'function');
  const data={},manager=new mod.DownloadManager(api(data));
  await manager.start({url:'https://cdn.test/a',kind:'hls',title:'Old'});
  const rows=await new mod.DownloadManager(api(data)).list();
  assert.equal(rows[0].status,'interrupted');
});
test('Direct browser downloads are tracked by bytes and browser completion',async()=>{
  assert.equal(typeof mod.DownloadManager,'function');
  const chrome=api(),manager=new mod.DownloadManager(chrome);
  await manager.start({url:'https://cdn.test/a.mp4',kind:'file',title:'File',filename:'a.mp4'});
  chrome.items.set(10,{id:10,state:'in_progress',bytesReceived:25,totalBytes:100});
  assert.equal((await manager.list())[0].percent,25);
  chrome.items.set(10,{id:10,state:'complete',bytesReceived:100,totalBytes:100,filename:'C:/Downloads/a.mp4'});
  chrome.downloads.onChanged.emit({id:10,state:{current:'complete'}});
  assert.equal((await manager.list())[0].status,'complete');
});
test('Cancel retains a cancelled record and late progress cannot reactivate it',async()=>{
  const chrome=api(),manager=new mod.DownloadManager(chrome);
  const job=await manager.start({url:'https://cdn.test/a',kind:'hls',title:'Cancel'});
  await manager.cancel(job.id);
  chrome.ports[0].onMessage.emit({type:'error',error:'stopped'});
  chrome.ports[0].onMessage.emit({type:'progress',seconds:40});
  assert.equal((await manager.list())[0].status,'cancelled');
});
test('Connection failure persists a useful record without saving signed URLs',async()=>{
  const data={},chrome=api(data),manager=new mod.DownloadManager(chrome);
  await manager.start({url:'https://cdn.test/a?token=private',kind:'hls',title:'Failure'});
  chrome.runtime.lastError={message:'host not found'};chrome.ports[0].onDisconnect.emit();
  assert.equal((await manager.list())[0].status,'interrupted');
  assert.equal(JSON.stringify(data).includes('token=private'),false);
});

test('Separate video/audio files use the native helper and persist no source URLs',async()=>{
  const data={},chrome=api(data),manager=new mod.DownloadManager(chrome);
  const row=await manager.start({kind:'paired',url:'https://cdn.test/video',audioUrl:'https://cdn.test/audio',duration:333});
  assert.equal(chrome.ports.length,1);assert.equal(row.browserId,undefined);
  assert.equal(JSON.stringify(data).includes('cdn.test'),false);
  await assert.rejects(()=>manager.start({kind:'paired',url:'https://cdn.test/video'}));
});

test('File action resolves the recorded path and rejects unknown or incomplete jobs',async()=>{
  const chrome=api({download_history_v1:[{id:'native',kind:'paired',status:'complete',path:'C:/Downloads/a.mp4'},{id:'pending',kind:'file',status:'downloading'}]});
  const calls=[];chrome.runtime.sendNativeMessage=async(host,msg)=>{calls.push(msg);return {ok:true};};
  const manager=new mod.DownloadManager(chrome);
  assert.equal(typeof manager.fileAction,'function');
  assert.deepEqual(await manager.fileAction('native','reveal'),{ok:true});
  assert.equal(calls[0].path,'C:/Downloads/a.mp4');
  await assert.rejects(()=>manager.fileAction('unknown','reveal'));
  await assert.rejects(()=>manager.fileAction('pending','open'));
  await assert.rejects(()=>manager.fileAction('native','execute'));
});

test('Clearing history persists removal of ended jobs while keeping an active download usable',async()=>{
  const data={download_history_v1:['complete','failed','cancelled','interrupted'].map(status=>({id:status,kind:'paired',status,path:'C:/Downloads/keep.mp4'}))};
  const chrome=api(data),manager=new mod.DownloadManager(chrome);
  const running=await manager.start({kind:'hls',url:'https://cdn.test/current',duration:100});
  assert.equal(typeof manager.clearHistory,'function');
  assert.deepEqual(await manager.clearHistory(),{removed:4});
  assert.deepEqual(data.download_history_v1.map(r=>r.id),[running.id]);
  chrome.ports[0].onMessage.emit({type:'progress',seconds:25});
  assert.equal((await manager.list())[0].percent,25);
  chrome.ports[0].onMessage.emit({type:'done',path:'C:/Downloads/new.mp4'});
  await manager.list();
  const restored=await new mod.DownloadManager(api(data)).list();
  assert.deepEqual(restored.map(r=>r.id),[running.id]);
});
